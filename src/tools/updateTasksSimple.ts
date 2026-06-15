import { z } from "zod";
import { getApiBase } from "../config.js";
import { dvReq, dvHeaders, dvErrorMessage, asArray, assertGuid } from "../dataverse.js";
import { validateUpdateEntities } from "./updateTasks.js";
import type { ToolDef } from "./types.js";

const GUID_RE = /^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$/;
const isGuid = (s: string): boolean => GUID_RE.test(s);

export interface SimpleTaskUpdate {
  taskId: string;
  subject?: string;
  description?: string;
  start?: string;
  finish?: string;
  effortHours?: number;
  progressPercent?: number; // 0-100, converted to msdyn_progress 0-1
  milestone?: boolean;
  priority?: number;
  /** Bucket name (resolved against the plan) or a bucketId GUID. Requires projectId. */
  bucket?: string;
}

export interface BuiltUpdate {
  entities: any[];
  /** User-visible notes about fields that were dropped (e.g. milestone). */
  warnings: string[];
}

/**
 * Translates the ergonomic update list into PSS update entities. Only the fields
 * the caller provides are emitted; `progressPercent` (0-100) is converted to
 * `msdyn_progress` (0-1). Pure and unit-testable. Summary-task rolled-up-field
 * protection is enforced separately by validateUpdateEntities (which the handler
 * runs on the result).
 *
 * `milestone` is intentionally NEVER emitted: PSS rejects msdyn_ismilestone on
 * update (ScheduleAPI-AV-0002) just as it does on create - the scheduling engine
 * manages that flag itself (it even auto-sets it on summary tasks). When a caller
 * passes `milestone`, it is dropped and a warning is returned instead of failing
 * the whole batch.
 */
export function buildUpdateEntities(
  tasks: SimpleTaskUpdate[],
  resolvedBucketIds?: Map<number, string>,
): BuiltUpdate {
  if (!Array.isArray(tasks) || tasks.length === 0)
    throw new Error("tasks must be a non-empty array.");

  const warnings: string[] = [];
  const entities = tasks.map((t, i) => {
    const id = (t.taskId || "").trim();
    if (!id) throw new Error("tasks[" + i + "]: taskId is required.");
    if (!GUID_RE.test(id))
      throw new Error("tasks[" + i + "]: taskId must be a GUID.");

    const ent: Record<string, unknown> = {
      "@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
      msdyn_projecttaskid: id,
    };
    let changed = 0;
    if (t.subject !== undefined) {
      ent.msdyn_subject = t.subject;
      changed++;
    }
    if (t.description !== undefined) {
      ent.msdyn_description = t.description;
      changed++;
    }
    if (t.start !== undefined && t.start !== null) {
      ent.msdyn_start = t.start;
      changed++;
    } else if (t.start === null) {
      warnings.push("tasks[" + i + "] (" + id + "): start=null skipped — PSS rejects null dates (returns 'Null object cannot be converted to a value type'). Omit the field instead.");
    }
    if (t.finish !== undefined && t.finish !== null) {
      ent.msdyn_finish = t.finish;
      changed++;
    } else if (t.finish === null) {
      warnings.push("tasks[" + i + "] (" + id + "): finish=null skipped — PSS rejects null dates (returns 'Null object cannot be converted to a value type'). Omit the field instead.");
    }
    if (t.effortHours !== undefined) {
      ent.msdyn_effort = t.effortHours;
      changed++;
    }
    if (t.progressPercent !== undefined) {
      if (typeof t.progressPercent !== "number" || t.progressPercent < 0 || t.progressPercent > 100)
        throw new Error(
          "tasks[" + i + "]: progressPercent must be a number between 0 and 100.",
        );
      ent.msdyn_progress = t.progressPercent / 100;
      changed++;
    }
    if (t.milestone !== undefined) {
      // Dropped on purpose - see the function doc. Never put msdyn_ismilestone
      // in a PSS update payload.
      warnings.push(
        "tasks[" +
          i +
          "] (" +
          id +
          "): 'milestone' was ignored - Planner Premium's scheduling engine does " +
          "not allow setting msdyn_ismilestone via the API (it manages the flag " +
          "itself). Set the milestone manually in the Planner UI if you need it.",
      );
    }
    if (t.priority !== undefined) {
      ent.msdyn_priority = t.priority;
      changed++;
    }
    if (t.bucket !== undefined) {
      const bucketId = resolvedBucketIds?.get(i);
      if (!bucketId)
        throw new Error(
          "tasks[" + i + "]: bucket '" + t.bucket + "' could not be resolved — pass projectId to enable bucket-name resolution, or use a bucketId GUID directly.",
        );
      ent["msdyn_projectbucket@odata.bind"] = "/msdyn_projectbuckets(" + bucketId + ")";
      changed++;
    }
    if (changed === 0)
      throw new Error(
        "tasks[" +
          i +
          "]: nothing to change - provide at least one field besides taskId" +
          (t.milestone !== undefined
            ? " (milestone cannot be changed via the API - set it in the Planner UI)"
            : "") +
          ".",
      );
    return ent;
  });

  return { entities, warnings };
}

const updateSchema = z.object({
  taskId: z.string().describe("GUID of the task to update (msdyn_projecttaskid)."),
  subject: z.string().optional().describe("Rename the task."),
  description: z.string().optional().describe("Set the task note / description."),
  start: z.string().optional().describe("New ISO start date."),
  finish: z.string().optional().describe("New ISO finish date."),
  effortHours: z.number().optional().describe("New effort in hours."),
  progressPercent: z
    .number()
    .optional()
    .describe("Percent complete, 0-100 (server converts to the 0-1 the API expects)."),
  milestone: z
    .boolean()
    .optional()
    .describe(
      "IGNORED - milestone cannot be set via the API (PSS rejects msdyn_ismilestone on update and the engine manages it). Passing it returns a warning; set milestones in the Planner UI.",
    ),
  priority: z.number().optional().describe("Priority (integer option-set value)."),
  bucket: z
    .string()
    .optional()
    .describe(
      "Move task to a different bucket: bucket NAME (resolved against the plan) or a bucketId GUID. Requires projectId at the top level.",
    ),
});

// Ergonomic update - the model sends a plain list keyed by taskId; the server
// builds the PSS update payload and converts percent -> 0-1.
export const updateTasksSimple: ToolDef = {
  name: "update_tasks",
  title: "Update Tasks in Plan",
  description:
    "Updates existing tasks from a SIMPLE list - you pass taskId plus only the fields to change (subject, description, start, finish, effortHours, progressPercent 0-100, priority, bucket); the server builds the Dataverse payload. Pass projectId to enable two automatic behaviours: (1) bucket names are resolved to IDs, and (2) the plan's task hierarchy is fetched so summary (parent) tasks are protected automatically — you do NOT need a separate get_plan_tasks_and_buckets call when projectId is provided. Without projectId the summary-task guard only fires if you pass explicit summaryTaskIds. Dependencies cannot be updated (delete and recreate). The milestone flag CANNOT be set via this API - passing milestone returns a warning and is ignored. Get explicit user approval before queuing schedule changes. Saved only after 'Apply Changes to Plan'. For raw OData field control use the advanced update_tasks_batch.",
  inputSchema: {
    operationSetId: z
      .string()
      .describe("GUID of the open OperationSet (from 'Start Change Session')."),
    tasks: z
      .union([z.string(), z.array(updateSchema)])
      .describe("The task updates. A JSON array (or JSON string) of update objects."),
    projectId: z
      .string()
      .optional()
      .describe(
        "GUID of the plan. When provided, the server auto-fetches the task hierarchy and automatically protects summary (parent) tasks from invalid schedule-field writes — no separate get_plan_tasks_and_buckets call needed. Also required when any task update includes a 'bucket' name. Strongly recommended whenever updating start/finish/effort/progress.",
      ),
    summaryTaskIds: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .describe(
        "Optional JSON array of summary-task GUIDs from get_plan_tasks_and_buckets. Merged with auto-detected summary tasks when projectId is provided. If both are omitted, the summary-task guard does not fire.",
      ),
  },
  handler: async (input: {
    operationSetId: string;
    projectId?: unknown;
    tasks: unknown;
    summaryTaskIds?: unknown;
  }) => {
    const BASE = getApiBase();

    const operationSetId = (input.operationSetId || "").trim();
    if (!operationSetId) throw new Error("operationSetId is required.");

    const tasks = asArray<SimpleTaskUpdate>(input.tasks, "tasks");

    // Resolve bucket names -> GUIDs for tasks that request a bucket move.
    const resolvedBucketIds = new Map<number, string>();
    const wantedNames = new Set<string>();
    for (const t of tasks) {
      const b = (t.bucket || "").trim();
      if (b && !isGuid(b)) wantedNames.add(b.toLowerCase());
    }
    if (wantedNames.size > 0) {
      const projectId = assertGuid(String(input.projectId || ""), "projectId");
      const res = await dvReq(
        {
          url:
            BASE +
            "/msdyn_projectbuckets?$select=msdyn_projectbucketid,msdyn_name&$filter=_msdyn_project_value eq " +
            projectId +
            "&$top=200",
          method: "GET",
          headers: dvHeaders(),
        },
        { retry: true },
      );
      if (res.status >= 400)
        throw new Error("bucket lookup failed (" + res.status + "): " + dvErrorMessage(res));
      const nameToId: Record<string, string> = {};
      const counts: Record<string, number> = {};
      for (const b of res.json?.value || []) {
        const key = String(b.msdyn_name || "").trim().toLowerCase();
        counts[key] = (counts[key] || 0) + 1;
        nameToId[key] = b.msdyn_projectbucketid;
      }
      for (const name of wantedNames) {
        if (!nameToId[name])
          throw new Error(
            "No bucket named '" + name + "' in this plan. Create it first with add_bucket, or pass a bucketId GUID.",
          );
        if (counts[name] > 1)
          throw new Error(
            "Multiple buckets named '" + name + "' — pass the bucketId GUID instead of the name.",
          );
      }
      tasks.forEach((t, i) => {
        const b = (t.bucket || "").trim();
        if (!b) return;
        resolvedBucketIds.set(i, isGuid(b) ? b : nameToId[b.toLowerCase()]);
      });
    } else {
      // Handle tasks that pass a bucketId GUID directly (no name lookup needed).
      tasks.forEach((t, i) => {
        const b = (t.bucket || "").trim();
        if (b && isGuid(b)) resolvedBucketIds.set(i, b);
      });
    }

    const { entities, warnings } = buildUpdateEntities(tasks, resolvedBucketIds);

    // Auto-detect summary tasks from the plan hierarchy when projectId is provided.
    // This lets the guard fire without requiring a prior get_plan_tasks_and_buckets
    // call — the same projectId used for bucket resolution doubles here.
    let effectiveSummaryIds: unknown = input.summaryTaskIds;
    if (input.projectId) {
      const projId = assertGuid(String(input.projectId), "projectId");
      const hierRes = await dvReq(
        {
          url:
            BASE +
            "/msdyn_projecttasks?$select=msdyn_projecttaskid,_msdyn_parenttask_value" +
            "&$filter=_msdyn_project_value eq " +
            projId +
            "&$top=1500",
          method: "GET",
          headers: dvHeaders(),
        },
        { retry: true },
      );
      if (hierRes.status < 400) {
        const autoIds = new Set<string>();
        for (const t of hierRes.json?.value ?? []) {
          const p = t._msdyn_parenttask_value;
          if (p) autoIds.add(String(p).toLowerCase());
        }
        // Merge auto-detected with any explicitly provided ids.
        const explicit = asArray<string>(input.summaryTaskIds ?? [], "summaryTaskIds");
        for (const id of explicit) autoIds.add(id.toLowerCase());
        effectiveSummaryIds = [...autoIds];
      }
      // If the hierarchy fetch fails, fall back to whatever the caller provided.
    }

    // Defense in depth + summary-task protection (same checks as the raw tool).
    validateUpdateEntities(entities, effectiveSummaryIds);

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
      warnings,
      response: body,
      note: "Queued. Saved only after 'Apply Changes to Plan'.",
    };
  },
};
