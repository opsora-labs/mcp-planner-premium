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

// Create Bucket - via PSS (msdyn_PssCreateV2 inside a dedicated OperationSet).
// Direct Dataverse inserts into msdyn_projectbucket are blocked once PSS has
// "owned" the plan (error: "You cannot directly do 'Create' operation to
// 'msdyn_projectbucket'"). PSS works reliably for both fresh and existing plans.
// The handler opens its own session, applies, and polls to completion so callers
// get a confirmed bucketId back with a single tool call.
export const addBucket: ToolDef = {
  name: "add_bucket",
  title: "Add Bucket to Plan",
  description:
    "Adds a bucket (column/grouping) to an existing plan via PSS (msdyn_PssCreateV2). Returns the bucketId once PSS has persisted the bucket. Buckets MUST exist before tasks reference them in add_tasks / add_tasks_batch (add_tasks can reference a bucket by name or by bucketId). No separate change session is needed — the tool manages its own session internally.",
  inputSchema: {
    name: z.string().describe("Bucket name."),
    projectId: z.string().describe("GUID of the plan (msdyn_projectid)."),
  },
  handler: async (input: { name: string; projectId: string }) => {
    const BASE = getApiBase();

    const name = (input.name || "").trim();
    if (!name) throw new Error("name is required (bucket name).");
    const projectId = assertGuid(input.projectId, "projectId");
    const bucketId = randomUUID();

    // 1. Open a dedicated OperationSet for this bucket.
    const sessionRes = await dvReq({
      url: BASE + "/msdyn_CreateOperationSetV1",
      method: "POST",
      headers: dvHeaders({ json: true }),
      body: { ProjectId: projectId, Description: "Add bucket: " + name },
    });
    if (sessionRes.status >= 400) {
      throw new Error(
        "create_operation_set failed (" + sessionRes.status + "): " + dvErrorMessage(sessionRes),
      );
    }
    const operationSetId: string = sessionRes.json?.OperationSetId;
    if (!operationSetId) throw new Error("create_operation_set did not return an OperationSetId.");

    // 2. Queue the bucket entity.
    const createRes = await dvReq({
      url: BASE + "/msdyn_PssCreateV2",
      method: "POST",
      headers: dvHeaders({ json: true }),
      body: {
        EntityCollection: [
          {
            "@odata.type": "Microsoft.Dynamics.CRM.msdyn_projectbucket",
            msdyn_projectbucketid: bucketId,
            msdyn_name: name,
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
    if (applyRes.status >= 400) {
      throw new Error(
        "execute_operation_set failed (" + applyRes.status + "): " + dvErrorMessage(applyRes),
      );
    }

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
      // 404 means the record was cleaned up after completion — treat as done.
      if (statusRes.status === 404) { completed = true; break; }
      if (statusRes.status >= 400) break;
      const code: number = statusRes.json?.msdyn_status;
      if (code === 192350003) { completed = true; break; }
      if (code === 192350002)
        throw new Error(
          "add_bucket PSS operation failed. Check msdyn_psserrorlogs for details (operationSetId: " +
            operationSetId +
            ").",
        );
      if (code === 192350004)
        throw new Error("add_bucket PSS operation was abandoned (operationSetId: " + operationSetId + ").");
    }

    // 5. Ground-truth verification: if the poll timed out or the operationset status
    // was inconclusive, check whether the bucket is directly queryable in Dataverse.
    // PSS persistence and queryability can lag slightly behind operationset completion,
    // but this catches the case where the poll window expired before the status flipped.
    if (!completed) {
      try {
        const verifyRes = await dvReq(
          {
            url: BASE + "/msdyn_projectbuckets(" + bucketId + ")?$select=msdyn_projectbucketid",
            method: "GET",
            headers: dvHeaders(),
          },
          { retry: true },
        );
        if (verifyRes.status < 400) completed = true;
      } catch {
        // Non-fatal — leave completed as false and return the operationSetId.
      }
    }

    return {
      ok: true,
      bucketId,
      name,
      note: completed
        ? "Bucket persisted — ready to reference in add_tasks by name or bucketId."
        : "Bucket queued but PSS has not confirmed completion yet (operationSetId: " +
          operationSetId +
          "). Poll check_change_session_status until Completed before referencing this bucket.",
    };
  },
};
