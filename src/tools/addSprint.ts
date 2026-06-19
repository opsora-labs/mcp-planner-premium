import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getApiBase } from "../config.js";
import {
  dvReq,
  dvHeaders,
  dvErrorMessage,
  assertGuid,
  throwIfPssCreateError,
} from "../dataverse.js";
import type { ToolDef } from "./types.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Create Sprint - via PSS (msdyn_PssCreateV2 inside a dedicated OperationSet),
// mirroring add_bucket. Sprints are top-level plan entities (name + start +
// finish are all required); a task is then placed in a sprint via the task's
// `sprint` field in add_tasks. The tool manages its own change session and polls
// to completion so callers get a confirmed sprintId back in a single call.
export const addSprint: ToolDef = {
  name: "add_sprint",
  title: "Add Sprint to Plan",
  description:
    "Adds a sprint (a time-boxed iteration) to an existing plan via PSS (msdyn_PssCreateV2). Requires name, start and finish (all mandatory on a sprint). Returns the sprintId once PSS has persisted it. Sprints must exist before tasks reference them — add_tasks can then place a task in a sprint by name or sprintId. No separate change session is needed; the tool manages its own session internally.",
  inputSchema: {
    name: z.string().describe("Sprint name (e.g. 'Sprint 1')."),
    projectId: z.string().describe("GUID of the plan (msdyn_projectid)."),
    start: z.string().describe("ISO start date of the sprint, e.g. 2026-07-01."),
    finish: z.string().describe("ISO finish date of the sprint, e.g. 2026-07-14."),
  },
  handler: async (input: { name: string; projectId: string; start: string; finish: string }) => {
    const BASE = getApiBase();

    const name = (input.name || "").trim();
    if (!name) throw new Error("name is required (sprint name).");
    const start = (input.start || "").trim();
    const finish = (input.finish || "").trim();
    if (!start || !finish)
      throw new Error("start and finish are required for a sprint (both are mandatory in PSS).");
    const projectId = assertGuid(input.projectId, "projectId");
    const sprintId = randomUUID();

    // 1. Open a dedicated OperationSet.
    const sessionRes = await dvReq({
      url: BASE + "/msdyn_CreateOperationSetV1",
      method: "POST",
      headers: dvHeaders({ json: true }),
      body: { ProjectId: projectId, Description: "Add sprint: " + name },
    });
    if (sessionRes.status >= 400)
      throw new Error(
        "create_operation_set failed (" + sessionRes.status + "): " + dvErrorMessage(sessionRes),
      );
    const operationSetId: string = sessionRes.json?.OperationSetId;
    if (!operationSetId) throw new Error("create_operation_set did not return an OperationSetId.");

    // 2. Queue the sprint entity.
    const createRes = await dvReq({
      url: BASE + "/msdyn_PssCreateV2",
      method: "POST",
      headers: dvHeaders({ json: true }),
      body: {
        EntityCollection: [
          {
            "@odata.type": "Microsoft.Dynamics.CRM.msdyn_projectsprint",
            msdyn_projectsprintid: sprintId,
            msdyn_name: name,
            msdyn_start: start,
            msdyn_finish: finish,
            "msdyn_project@odata.bind": "/msdyn_projects(" + projectId + ")",
          },
        ],
        OperationSetId: operationSetId,
      },
    });
    throwIfPssCreateError(createRes);

    // 3. Apply (async commit).
    const applyRes = await dvReq({
      url: BASE + "/msdyn_ExecuteOperationSetV1",
      method: "POST",
      headers: dvHeaders({ json: true }),
      body: { OperationSetId: operationSetId },
    });
    if (applyRes.status >= 400)
      throw new Error(
        "execute_operation_set failed (" + applyRes.status + "): " + dvErrorMessage(applyRes),
      );

    // 4. Poll operationset status (up to 15 × 3 s = 45 s).
    let completed = false;
    for (let i = 0; i < 15; i++) {
      await sleep(3000);
      const statusRes = await dvReq(
        {
          url: BASE + "/msdyn_operationsets(" + operationSetId + ")?$select=msdyn_status",
          method: "GET",
          headers: dvHeaders(),
        },
        { retry: true },
      );
      if (statusRes.status === 404) { completed = true; break; }
      if (statusRes.status >= 400) break;
      const code: number = statusRes.json?.msdyn_status;
      if (code === 192350003) { completed = true; break; }
      if (code === 192350002)
        throw new Error(
          "add_sprint PSS operation failed. Check msdyn_psserrorlogs (operationSetId: " + operationSetId + ").",
        );
      if (code === 192350004)
        throw new Error("add_sprint PSS operation was abandoned (operationSetId: " + operationSetId + ").");
    }

    // 5. Ground-truth verification if the poll was inconclusive.
    if (!completed) {
      try {
        const verifyRes = await dvReq(
          {
            url: BASE + "/msdyn_projectsprints(" + sprintId + ")?$select=msdyn_projectsprintid",
            method: "GET",
            headers: dvHeaders(),
          },
          { retry: true },
        );
        if (verifyRes.status < 400) completed = true;
      } catch {
        // Non-fatal.
      }
    }

    return {
      ok: true,
      sprintId,
      name,
      note: completed
        ? "Sprint persisted — ready to reference in add_tasks by name or sprintId."
        : "Sprint queued but PSS has not confirmed completion yet (operationSetId: " +
          operationSetId +
          "). Poll check_change_session_status until Completed before referencing this sprint.",
    };
  },
};
