import { z } from "zod";
import { getApiBase } from "../config.js";
import { dvReq, dvHeaders, dvErrorMessage, asArray } from "../dataverse.js";
import { validateCustomColumnKeys } from "./customColumnsGuard.js";
import type { ToolDef } from "./types.js";

const BLOCKED_PROJECT_FIELDS = [
  "statecode",
  "msdyn_bulkgenerationstatus",
  "msdyn_globalrevisiontoken",
  "msdyn_calendarid",
  "msdyn_effort",
  "msdyn_effortcompleted",
  "msdyn_effortremaining",
  "msdyn_progress",
  "msdyn_finish",
  "msdyn_taskearlieststart",
  "msdyn_duration",
];

// ROLLED-UP FIELDS - on summary (parent) tasks these are computed from the children by the
// scheduling engine. NEVER update them on a summary task; writing them is invalid.
const ROLLED_UP_FIELDS = [
  "msdyn_start",
  "msdyn_finish",
  "msdyn_effort",
  "msdyn_progress",
  "msdyn_duration",
];

// Wrong navigation-property names observed (or likely) in agent-generated payloads.
const BIND_ALIASES: Record<string, string> = {
  "msdyn_bucket@odata.bind": "msdyn_projectbucket@odata.bind",
  "msdyn_projectbucketid@odata.bind": "msdyn_projectbucket@odata.bind",
  "msdyn_projectid@odata.bind": "msdyn_project@odata.bind",
  "msdyn_parent@odata.bind": "msdyn_parenttask@odata.bind",
  "msdyn_parenttaskid@odata.bind": "msdyn_parenttask@odata.bind",
};

/**
 * Validates the entity batch for msdyn_PssUpdateV2 and enforces summary-task
 * protection. `summaryTaskIds` may be a JSON string, an array, or undefined.
 * Pure (no network) so it is unit-testable.
 */
export function validateUpdateEntities(
  entities: any[],
  summaryTaskIdsInput?: unknown,
): void {
  if (!Array.isArray(entities) || entities.length === 0)
    throw new Error("entities must be a non-empty JSON array.");
  if (entities.length > 200)
    throw new Error("Max 200 entities per OperationSet.");

  // Build the summary-task set: explicit GUIDs from the optional summaryTaskIds input plus any
  // task referenced as a parent via msdyn_parenttask@odata.bind in this same batch.
  const summarySet: Record<string, boolean> = {};
  if (summaryTaskIdsInput !== undefined && summaryTaskIdsInput !== null) {
    let ids: unknown = summaryTaskIdsInput;
    if (typeof ids === "string") {
      const trimmed = ids.trim();
      if (trimmed) {
        try {
          ids = JSON.parse(trimmed);
        } catch (e: any) {
          throw new Error(
            "summaryTaskIds must be a JSON array of GUIDs: " + e.message,
          );
        }
      } else {
        ids = [];
      }
    }
    if (!Array.isArray(ids))
      throw new Error("summaryTaskIds must be a JSON array of GUIDs.");
    for (let i = 0; i < ids.length; i++) {
      if (ids[i]) summarySet[String(ids[i]).toLowerCase()] = true;
    }
  }
  for (let i = 0; i < entities.length; i++) {
    const bind = entities[i]["msdyn_parenttask@odata.bind"];
    if (typeof bind === "string") {
      const m = bind.match(/msdyn_projecttasks\(([0-9a-fA-F-]{36})\)/);
      if (m) summarySet[m[1].toLowerCase()] = true;
    }
  }

  for (let i = 0; i < entities.length; i++) {
    const ent = entities[i];
    const t = ent["@odata.type"] || "";
    // Reject known wrong @odata.bind navigation-property names (teaches the correct key).
    for (const wrong in BIND_ALIASES) {
      if (Object.prototype.hasOwnProperty.call(ent, wrong)) {
        throw new Error(
          "entities[" +
            i +
            "]: '" +
            wrong +
            "' is not a valid navigation property. Use '" +
            BIND_ALIASES[wrong] +
            "' instead (value unchanged).",
        );
      }
    }
    if (t.endsWith("msdyn_projecttaskdependency")) {
      throw new Error(
        "entities[" +
          i +
          "]: dependencies cannot be updated via PSS - delete and recreate instead.",
      );
    }
    if (t.endsWith("msdyn_project")) {
      const bad = Object.keys(ent).filter((k) =>
        BLOCKED_PROJECT_FIELDS.includes(k.toLowerCase()),
      );
      if (bad.length)
        throw new Error(
          "entities[" +
            i +
            "] (project): fields not supported by PSS update: " +
            bad.join(", "),
        );
      if (!ent.msdyn_projectid)
        throw new Error("entities[" + i + "] (project): msdyn_projectid required.");
    }
    if (t.endsWith("msdyn_projecttask")) {
      if (!ent.msdyn_projecttaskid)
        throw new Error("entities[" + i + "] (task): msdyn_projecttaskid required.");
      // PSS rejects null date values with "Null object cannot be converted to a value type."
      for (const dateField of ["msdyn_start", "msdyn_finish"]) {
        if (Object.prototype.hasOwnProperty.call(ent, dateField) && ent[dateField] === null) {
          throw new Error(
            "entities[" + i + "] (task): " + dateField + " must not be null — PSS rejects null dates. Omit the field to leave it unchanged.",
          );
        }
      }
      // Reject rolled-up field writes on summary (parent) tasks.
      if (summarySet[String(ent.msdyn_projecttaskid).toLowerCase()]) {
        const offending = ROLLED_UP_FIELDS.filter((f) =>
          Object.prototype.hasOwnProperty.call(ent, f),
        );
        if (offending.length) {
          throw new Error(
            "entities[" +
              i +
              "]: task " +
              ent.msdyn_projecttaskid +
              " is a summary (parent) task; field(s) " +
              offending.join(", ") +
              " roll up from its children and cannot be set. Remove them - update the child tasks instead.",
          );
        }
      }
    }
  }
}

// PSS Batch Update - msdyn_PssUpdateV2 (dates, effort, renames - engine-validated, user context)
export const updateTasks: ToolDef = {
  name: "update_tasks_batch",
  title: "Update Tasks in Plan (Batch)",
  description:
    "ADVANCED / raw path. For ordinary task edits prefer update_tasks (taskId + the fields to change; the server builds this payload and converts percent). Use this raw tool only for fields update_tasks does not model. " +
    "Updates up to 200 existing items in ONE call via msdyn_PssUpdateV2, inside an open change session: task dates (msdyn_start/msdyn_finish), effort, renames, percent complete, milestone flag - validated by the scheduling engine in the user's context. NEVER update msdyn_start, msdyn_finish, msdyn_effort, msdyn_progress or msdyn_duration on summary (parent) tasks - these roll up from children. Resolve parentage via 'Get Plan Tasks & Buckets' (summaryTaskIds) FIRST and pass that list into the optional summaryTaskIds input so such updates are rejected. Dependencies cannot be updated (delete and recreate them). PSS-unsupported project fields are rejected in code. Get explicit user approval before queuing schedule changes. Saved only after 'Apply Changes to Plan'.",
  inputSchema: {
    operationSetId: z
      .string()
      .describe("GUID of the open OperationSet (from 'Start Change Session')."),
    entities: z
      .union([z.string(), z.array(z.record(z.any()))])
      .describe(
        "JSON array of partial entities. Each item needs '@odata.type', its primary key field (e.g. msdyn_projecttaskid) and ONLY the fields to change (dates, effort, name). IMPORTANT: msdyn_progress here is a 0-1 fraction (0.5 = 50%), NOT 0-100 - this raw tool does no conversion (the ergonomic update_tasks takes progressPercent 0-100). Dependencies cannot be updated. Max 200.",
      ),
    summaryTaskIds: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .describe(
        "Optional JSON array of summary-task GUIDs from 'Get Plan Tasks & Buckets'. If provided, updates touching rolled-up fields (msdyn_start, msdyn_finish, msdyn_effort, msdyn_progress, msdyn_duration) on these tasks are rejected.",
      ),
  },
  handler: async (input: {
    operationSetId: string;
    entities: unknown;
    summaryTaskIds?: unknown;
  }) => {
    const BASE = getApiBase();

    const operationSetId = (input.operationSetId || "").trim();
    if (!operationSetId) throw new Error("operationSetId is required.");

    const entities = asArray(input.entities, "entities");
    validateUpdateEntities(entities, input.summaryTaskIds);
    // Additional, opt-in (CUSTOM_COLUMNS_MODE!=off) metadata-backed check for
    // any custom (non-msdyn_) key — see customColumnsGuard.ts. Runs AFTER the
    // synchronous guardrails above, so the dependency-block / summary-task /
    // 200-cap checks always fire first, unchanged.
    await validateCustomColumnKeys(entities, "update");

    const response = await dvReq({
      url: BASE + "/msdyn_PssUpdateV2",
      method: "POST",
      headers: dvHeaders({ json: true }),
      body: { EntityCollection: entities, OperationSetId: operationSetId },
    });

    const body = response.json || {};
    if (response.status >= 400) {
      const msg = dvErrorMessage(response);
      if (response.status === 403)
        throw new Error("403 - missing license or privileges: " + msg);
      throw new Error("pss_update_batch failed (" + response.status + "): " + msg);
    }
    return {
      ok: true,
      queued: entities.length,
      response: body,
      note: "Queued. Saved only after 'Apply Changes to Plan'.",
    };
  },
};
