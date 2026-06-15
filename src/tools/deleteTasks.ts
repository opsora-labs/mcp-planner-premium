import { z } from "zod";
import { getApiBase } from "../config.js";
import { dvReq, dvHeaders, dvErrorMessage, asArray, assertGuid } from "../dataverse.js";
import type { ToolDef } from "./types.js";

const DELETABLE = [
  "msdyn_projecttask",
  "msdyn_projecttaskdependency",
  "msdyn_resourceassignment",
  "msdyn_projectbucket",
  "msdyn_projectsprint",
  "msdyn_projectchecklist",
  "msdyn_projecttasktolabel",
];

/**
 * Converts the internal record list to the OData entity objects msdyn_PssDeleteV2
 * expects in EntityCollection. The API uses the same OData entity format as
 * msdyn_PssCreateV2 — NOT { EntityLogicalName, RecordId } descriptors (those
 * cause "Invalid property 'EntityLogicalName' was found in entity crmbaseentity").
 * Primary key field name follows the consistent Dataverse pattern: <logicalname>id.
 */
export function buildDeleteEntities(
  records: { entityLogicalName: string; recordId: string }[],
): any[] {
  return records.map((r) => ({
    "@odata.type": "Microsoft.Dynamics.CRM." + r.entityLogicalName,
    [r.entityLogicalName + "id"]: r.recordId,
  }));
}

/**
 * Sorts task IDs so children are deleted before their parents (leaves first).
 * PSS processes the batch sequentially: if a parent is deleted first, its
 * children's IDs become invalid mid-batch (E_INVALIDENTITYUID).
 *
 * parentMap: task id (lowercase) -> parent task id (lowercase) or null/undefined.
 * Tasks whose parent is not in the delete set are treated as roots.
 * Pure and unit-testable — the caller supplies the parent map from a Dataverse read.
 */
export function sortTaskIdsLeavesFirst(
  taskIds: string[],
  parentMap: Map<string, string | null | undefined>,
): string[] {
  if (taskIds.length <= 1) return taskIds;

  const deleteSet = new Set(taskIds.map((id) => id.toLowerCase()));

  // Build a children-of map restricted to the delete set.
  const childrenOf = new Map<string, string[]>();
  for (const id of taskIds) {
    const lo = id.toLowerCase();
    const parentId = parentMap.get(lo);
    if (parentId && deleteSet.has(parentId)) {
      if (!childrenOf.has(parentId)) childrenOf.set(parentId, []);
      childrenOf.get(parentId)!.push(lo);
    }
  }

  // Post-order DFS: visit all children before the node itself → leaves first.
  const result: string[] = [];
  const visited = new Set<string>();

  const visit = (id: string): void => {
    const lo = id.toLowerCase();
    if (visited.has(lo)) return;
    visited.add(lo);
    for (const child of childrenOf.get(lo) ?? []) visit(child);
    result.push(id);
  };

  // Start from roots (no parent inside the delete set).
  for (const id of taskIds) {
    const lo = id.toLowerCase();
    const parentId = parentMap.get(lo);
    if (!parentId || !deleteSet.has(parentId)) visit(id);
  }
  // Catch anything not yet reached (disconnected / missing from parentMap).
  for (const id of taskIds) {
    if (!visited.has(id.toLowerCase())) result.push(id);
  }

  return result;
}

/**
 * Validates the delete record list for msdyn_PssDeleteV2. Whole-plan deletes
 * are hard-blocked by policy. Pure (no network); unit-testable.
 */
export function validateDeleteRecords(records: any[]): void {
  if (!Array.isArray(records) || records.length === 0)
    throw new Error(
      "records must be a non-empty JSON array of { entityLogicalName, recordId }.",
    );
  if (records.length > 200)
    throw new Error("Max 200 deletes per OperationSet.");

  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (r.entityLogicalName === "msdyn_project") {
      throw new Error(
        "records[" +
          i +
          "]: deleting whole plans via API is blocked by policy (and unsupported by PSS).",
      );
    }
    if (!DELETABLE.includes(r.entityLogicalName) || !r.recordId) {
      throw new Error(
        "records[" +
          i +
          "]: invalid entityLogicalName or missing recordId. Deletable: " +
          DELETABLE.join(", "),
      );
    }
  }
}

// PSS Batch Delete - msdyn_PssDeleteV2 (guarded; whole-plan deletes blocked by policy)
export const deleteTasks: ToolDef = {
  name: "delete_tasks_batch",
  title: "Delete Tasks from Plan (Batch)",
  description:
    "Deletes up to 200 items (tasks, dependencies, assignments, buckets, checklists) in ONE call via msdyn_PssDeleteV2, inside an open change session. REQUIRES confirmed=true after an explicit per-record user confirmation. Provide at least one of taskIds (task GUIDs) or records. When projectId is given with taskIds, the server fetches the plan hierarchy and automatically sorts the delete batch leaves-first (children before parents) — PSS requires this order or it returns E_INVALIDENTITYUID mid-batch. Deleting whole plans is hard-blocked by policy. Deletions are saved only after 'Apply Changes to Plan'.",
  inputSchema: {
    operationSetId: z
      .string()
      .describe("GUID of the open OperationSet (from 'Start Change Session')."),
    projectId: z
      .string()
      .optional()
      .describe(
        "GUID of the plan the tasks belong to. When provided alongside taskIds, the server fetches the task hierarchy and auto-sorts the batch leaves-first so PSS does not reject children whose parent was already deleted mid-batch (E_INVALIDENTITYUID). Strongly recommended when deleting a hierarchy of tasks.",
      ),
    taskIds: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .describe(
        "Convenience for the common case: a JSON array of task GUIDs to delete. Expanded to msdyn_projecttask records. Use 'records' instead for dependencies, buckets, assignments etc.",
      ),
    records: z
      .union([z.string(), z.array(z.record(z.any()))])
      .optional()
      .describe(
        'For non-task deletes (or mixed): JSON array [{"entityLogicalName":"msdyn_projecttaskdependency","recordId":"<guid>"}]. Combined with taskIds if both are given. Max 200 total.',
      ),
    confirmed: z
      .boolean()
      .describe(
        "Set true ONLY after the user explicitly confirmed each listed record.",
      ),
  },
  handler: async (input: {
    operationSetId: string;
    projectId?: unknown;
    taskIds?: unknown;
    records?: unknown;
    confirmed: boolean;
  }) => {
    const BASE = getApiBase();

    const operationSetId = (input.operationSetId || "").trim();
    if (!operationSetId) throw new Error("operationSetId is required.");
    if (input.confirmed !== true && (input.confirmed as unknown) !== "true") {
      throw new Error(
        "Refused: 'confirmed' must be true. Obtain an explicit per-record user confirmation BEFORE calling this action.",
      );
    }

    // Collect task IDs from the convenience parameter before expanding to records,
    // so we can sort them leaves-first if projectId is provided.
    let taskIdList: string[] = [];
    if (input.taskIds !== undefined && input.taskIds !== null) {
      taskIdList = asArray<string>(input.taskIds, "taskIds");
    }

    // Auto-sort task IDs leaves-first when projectId is provided.
    if (taskIdList.length > 1 && input.projectId) {
      const projectId = assertGuid(String(input.projectId), "projectId");
      const res = await dvReq(
        {
          url:
            BASE +
            "/msdyn_projecttasks?$select=msdyn_projecttaskid,_msdyn_parenttask_value" +
            "&$filter=_msdyn_project_value eq " +
            projectId +
            "&$top=1000",
          method: "GET",
          headers: dvHeaders(),
        },
        { retry: true },
      );
      if (res.status < 400) {
        const parentMap = new Map<string, string | null>();
        for (const t of res.json?.value ?? []) {
          parentMap.set(
            String(t.msdyn_projecttaskid).toLowerCase(),
            t._msdyn_parenttask_value
              ? String(t._msdyn_parenttask_value).toLowerCase()
              : null,
          );
        }
        taskIdList = sortTaskIdsLeavesFirst(taskIdList, parentMap);
      }
      // If the fetch fails, proceed with caller order (best-effort).
    }

    const records: { entityLogicalName: string; recordId: string }[] = [];
    for (const id of taskIdList)
      records.push({ entityLogicalName: "msdyn_projecttask", recordId: id });
    if (input.records !== undefined && input.records !== null) {
      const raw = asArray<{ entityLogicalName: string; recordId: string }>(
        input.records,
        "records",
      );
      for (const r of raw) records.push(r);
    }
    if (records.length === 0)
      throw new Error("Provide taskIds (task GUIDs) and/or records to delete.");
    validateDeleteRecords(records);

    const response = await dvReq({
      url: BASE + "/msdyn_PssDeleteV2",
      method: "POST",
      headers: dvHeaders({ json: true }),
      body: {
        EntityCollection: buildDeleteEntities(records),
        OperationSetId: operationSetId,
      },
    });

    const body = response.json || {};
    if (response.status >= 400) {
      const msg = dvErrorMessage(response);
      if (response.status === 403)
        throw new Error("403 - missing license or privileges: " + msg);
      throw new Error("pss_delete_batch failed (" + response.status + "): " + msg);
    }
    return {
      ok: true,
      queued: records.length,
      response: body,
      note: "Deletes queued. Saved only after 'Apply Changes to Plan'.",
    };
  },
};
