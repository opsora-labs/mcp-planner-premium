import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getApiBase, getCustomColumnsMode } from "../config.js";
import {
  dvReq,
  dvHeaders,
  dvErrorMessage,
  asArray,
  assertGuid,
  throwIfPssCreateError,
} from "../dataverse.js";
import { validateUpdateEntities } from "./updateTasks.js";
import { validateAddEntities } from "./addTasks.js";
import { validateDeleteRecords, buildDeleteEntities } from "./deleteTasks.js";
import { hasStrippableTagContent } from "./readHelpers.js";
import { getEntityMetadata } from "../dataverse/metadata.js";
import { spliceCustomFields, type ResolveCustomColumn } from "./addTasksSimple.js";
import {
  checklistCreateEntity,
  checklistUpdateEntity,
  planChecklistOps,
  isExistingItemOp,
  hasRemoval,
  CHECKLIST_ENTITY_SET,
  CHECKLIST_LOGICAL_NAME,
  CHECKLIST_TASK_LOOKUP_VALUE,
  type ChecklistOpInput,
  type ExistingChecklistItem,
} from "./checklist.js";
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
  /** Reparent (move under another task): an EXISTING task GUID. update has no
   * in-batch refs, so a name or ref is not accepted here. */
  parent?: string;
  /** Move this task into a sprint: sprint NAME (resolved against the plan) or a
   * sprintId GUID. Requires projectId at the top level for name resolution.
   * Removing a task from a sprint (null sprint) is not supported — PSS rejects
   * null lookup binds; pass null to get a warning and no change. */
  sprint?: string;
  /** Custom (non-msdyn_) column values, keyed by logical name. Requires
   * CUSTOM_COLUMNS_MODE!=off on the server. See addTasksSimple.ts's SimpleTask
   * for the exact resolution/codec behaviour (shared via spliceCustomFields). */
  customFields?: Record<string, unknown>;
  /** Checklist add / adjust / remove ops for this existing task. Add = string or
   * {title, completed}; adjust = {id|match, title?, completed?}; remove =
   * {id|match, remove:true}. Resolved + built by the checklist pipeline in the
   * handler; NOT emitted into the task-update entity. See docs/plans/50. */
  checklist?: ChecklistOpInput[];
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
  resolvedSprintIds?: Map<number, string>,
  resolveCustomColumn?: ResolveCustomColumn,
): BuiltUpdate {
  if (!Array.isArray(tasks) || tasks.length === 0)
    throw new Error("tasks must be a non-empty array.");

  const warnings: string[] = [];
  const entities: any[] = [];
  tasks.forEach((t, i) => {
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
      // Dataverse strips tag-like <...> content from descriptions on save.
      if (hasStrippableTagContent(t.description)) {
        warnings.push(
          "tasks[" +
            i +
            "] (" +
            id +
            "): description contains angle-bracket content (e.g. \"<...>\") that Dataverse strips on save — that text will not be stored. Remove or rephrase the angle brackets if it must be kept.",
        );
      }
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
    if (t.parent !== undefined) {
      // Reparent: move the task under another EXISTING task. Unlike add_tasks,
      // update has no in-batch refs, so parent must be a persisted task GUID.
      // The new parent becomes a summary task — validateUpdateEntities already
      // scans msdyn_parenttask@odata.bind targets into its summary set, so any
      // rolled-up-field write on that parent in the same batch stays blocked.
      if (t.parent === null) {
        // Un-parenting (move to top level) is not supported: PSS rejects a null
        // parent bind. Drop with a warning rather than failing the whole batch.
        warnings.push(
          "tasks[" +
            i +
            "] (" +
            id +
            "): parent=null skipped — moving a task to the top level (un-parenting) is not supported via the API (PSS rejects null parent binds). Reparent under another task, or restructure in the Planner UI.",
        );
      } else {
        const p = String(t.parent).trim();
        if (!GUID_RE.test(p))
          throw new Error(
            "tasks[" +
              i +
              "]: parent must be an existing task GUID (update_tasks has no in-batch refs like add_tasks). Got '" +
              p +
              "'.",
          );
        ent["msdyn_parenttask@odata.bind"] = "/msdyn_projecttasks(" + p + ")";
        changed++;
      }
    }
    if (t.sprint !== undefined) {
      if (t.sprint === null) {
        // PSS rejects null lookup binds — drop with a warning, matching parent=null behaviour.
        warnings.push(
          "tasks[" +
            i +
            "] (" +
            id +
            "): sprint=null skipped — removing a task from a sprint (un-sprinting) is not supported via the API (PSS rejects null lookup binds). Omit the field instead.",
        );
      } else {
        const sprintId = resolvedSprintIds?.get(i);
        if (!sprintId)
          throw new Error(
            "tasks[" +
              i +
              "]: sprint '" +
              t.sprint +
              "' could not be resolved — pass projectId to enable sprint-name resolution, or pass a sprintId GUID directly. Create the sprint first with add_sprint if it does not exist yet.",
          );
        ent["msdyn_projectsprint@odata.bind"] = "/msdyn_projectsprints(" + sprintId + ")";
        changed++;
      }
    }
    if (t.customFields && Object.keys(t.customFields).length > 0) changed++;
    const hasChecklistOps = Array.isArray(t.checklist) && t.checklist.length > 0;
    if (changed === 0) {
      // A checklist-only change is valid: it produces NO task-update entity here
      // (the handler's checklist pipeline applies it via separate PSS calls).
      if (hasChecklistOps) return;
      throw new Error(
        "tasks[" +
          i +
          "]: nothing to change - provide at least one field besides taskId" +
          (t.milestone !== undefined
            ? " (milestone cannot be changed via the API - set it in the Planner UI)"
            : "") +
          ".",
      );
    }

    // Custom (non-msdyn_) columns — resolved via metadata + the columnTypes.ts
    // codec, spliced in as extra keys on the same task entity. Fails closed
    // with a specific error (never a silent drop) on an msdyn_* key, an
    // unresolved column, or a bad value.
    spliceCustomFields(ent, t.customFields, "update", resolveCustomColumn, "tasks[" + i + "]");

    entities.push(ent);
  });

  return { entities, warnings };
}

// One checklist op: a string (add-by-title) or an object. See classification in
// checklist.ts / docs/plans/50 — add = no id/match/remove; adjust = id|match (+
// title/completed); remove = {id|match, remove:true}.
const checklistOpSchema = z.union([
  z.string(),
  z.object({
    id: z.string().optional().describe("Target an existing item by its msdyn_projectchecklistid (from get_task). Takes precedence over match."),
    match: z.string().optional().describe("Target an existing item by its CURRENT title."),
    title: z.string().optional().describe("ADD: the item title. ADJUST: the NEW title (rename)."),
    completed: z.boolean().optional().describe("ADD/ADJUST: completion state (ticked)."),
    remove: z.boolean().optional().describe("REMOVE this existing item (needs id or match). Requires the top-level confirmed:true."),
  }),
]);

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
  parent: z
    .string()
    .optional()
    .describe(
      "Reparent the task: move it under another EXISTING task by its GUID (msdyn_projecttaskid). Unlike add_tasks, no in-batch refs or names — pass a persisted task GUID. Moving a task to the top level (un-parenting) is NOT supported and is ignored with a warning. Invalid moves (e.g. a cycle) are rejected by the scheduling engine on apply.",
    ),
  sprint: z
    .string()
    .optional()
    .describe(
      "Move the task into a sprint: sprint NAME (resolved against the plan) or a sprintId GUID. Requires projectId at the top level for name resolution; pass a sprintId GUID to skip the lookup. Create the sprint first with add_sprint. Removing a task from a sprint (sprint=null) is NOT supported and is ignored with a warning.",
    ),
  customFields: z
    .record(z.unknown())
    .optional()
    .describe(
      "Custom (non-msdyn_) Dataverse column values, keyed by logical name, e.g. {\"new_riskscore\": 9}. Requires CUSTOM_COLUMNS_MODE!=off on the server. Picklist accepts a label or an integer value; lookups accept a bare GUID (when the column has a single target) or {target,id}. Use list_custom_columns / describe_columns to discover valid names and types first. Standard msdyn_ fields are rejected here — use this tool's named parameters for those.",
    ),
  checklist: z
    .array(checklistOpSchema)
    .optional()
    .describe(
      "Checklist add / adjust / remove ops for this task. ADD: a string title, or {title, completed}. ADJUST an existing item: {id | match, title?, completed?} (match = the item's current title; title = the new title to rename). REMOVE an existing item: {id | match, remove:true} — requires the top-level confirmed:true. Discover current items and their ids with get_task. A task may carry checklist ops alone or alongside other field changes.",
    ),
});

// Ergonomic update - the model sends a plain list keyed by taskId; the server
// builds the PSS update payload and converts percent -> 0-1.
export const updateTasksSimple: ToolDef = {
  name: "update_tasks",
  title: "Update Tasks in Plan",
  description:
    "Updates existing tasks from a SIMPLE list - you pass taskId plus only the fields to change (subject, description, start, finish, effortHours, progressPercent 0-100, priority, bucket, sprint, parent); the server builds the Dataverse payload. Move a task to another bucket with 'bucket', place a task in a sprint with 'sprint' (sprint name resolved against the plan — requires projectId, or pass a sprintId GUID directly), or reparent it under another existing task with 'parent' (an existing task GUID). Pass projectId to enable three automatic behaviours: (1) bucket names are resolved to IDs, (2) sprint names are resolved to IDs, and (3) the plan's task hierarchy is fetched so summary (parent) tasks are protected automatically — you do NOT need a separate get_plan_tasks_and_buckets call when projectId is provided. Without projectId the summary-task guard only fires if you pass explicit summaryTaskIds. Dependencies cannot be updated (delete and recreate). The milestone flag CANNOT be set via this API - passing milestone returns a warning and is ignored. Un-parenting (moving a task to the top level) is not supported and is ignored with a warning. Removing a task from a sprint (sprint=null) is not supported. Each task may also carry checklist ops (checklist): add items (string title or {title, completed}), adjust an existing item ({id|match, title?, completed?}), or remove one ({id|match, remove:true}); removals require confirmed:true. A task may carry checklist ops alone. Get explicit user approval before queuing schedule changes. Saved only after 'Apply Changes to Plan'. For raw OData field control use the advanced update_tasks_batch.",
  inputSchema: {
    operationSetId: z
      .string()
      .describe("GUID of the open OperationSet (from 'Start Change Session')."),
    tasks: z
      .union([z.string(), z.array(updateSchema)])
      .describe("The task updates. A JSON array (or JSON string) of update objects."),
    confirmed: z
      .boolean()
      .optional()
      .describe(
        "Required true ONLY when any checklist entry has remove:true — removing a checklist item deletes it on apply. Obtain explicit user confirmation first. Ignored when there are no removals.",
      ),
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
    confirmed?: unknown;
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

    // Resolve sprint names -> sprintIds with a single read (mirrors addTasksSimple.ts:540-582).
    const resolvedSprintIds = new Map<number, string>();
    const wantedSprintNames = new Set<string>();
    for (const t of tasks) {
      const s = (t.sprint || "").trim();
      if (s && s !== "null" && !isGuid(s)) wantedSprintNames.add(s.toLowerCase());
    }
    if (wantedSprintNames.size > 0) {
      const projectId = assertGuid(String(input.projectId || ""), "projectId");
      const res = await dvReq(
        {
          url:
            BASE +
            "/msdyn_projectsprints?$select=msdyn_projectsprintid,msdyn_name&$filter=_msdyn_project_value eq " +
            projectId +
            "&$top=200",
          method: "GET",
          headers: dvHeaders(),
        },
        { retry: true },
      );
      if (res.status >= 400)
        throw new Error("sprint lookup failed (" + res.status + "): " + dvErrorMessage(res));
      const sprintNameToId: Record<string, string> = {};
      const counts: Record<string, number> = {};
      for (const s of res.json?.value || []) {
        const key = String(s.msdyn_name || "").trim().toLowerCase();
        counts[key] = (counts[key] || 0) + 1;
        sprintNameToId[key] = s.msdyn_projectsprintid;
      }
      for (const name of wantedSprintNames) {
        if (!sprintNameToId[name])
          throw new Error(
            "No sprint named '" + name + "' in this plan. Create it first with add_sprint, or pass a sprintId GUID.",
          );
        if (counts[name] > 1)
          throw new Error(
            "Multiple sprints named '" + name + "' — pass the sprintId GUID instead of the name.",
          );
      }
      tasks.forEach((t, i) => {
        const s = (t.sprint || "").trim();
        if (!s || s === "null") return;
        resolvedSprintIds.set(i, isGuid(s) ? s : sprintNameToId[s.toLowerCase()]);
      });
    } else {
      // Handle tasks that pass a sprintId GUID directly (no name lookup needed).
      tasks.forEach((t, i) => {
        const s = (t.sprint || "").trim();
        if (s && s !== "null" && isGuid(s)) resolvedSprintIds.set(i, s);
      });
    }

    // Custom (non-msdyn_) columns: fetch metadata for msdyn_projecttask ONLY if
    // any task actually uses customFields, and only when the feature is enabled
    // (CUSTOM_COLUMNS_MODE!=off) — keeps the default path byte-for-byte
    // unchanged and avoids an unnecessary metadata round-trip otherwise.
    const wantsCustomFields = tasks.some((t) => t.customFields && Object.keys(t.customFields).length > 0);
    let resolveCustomColumn: ResolveCustomColumn | undefined;
    if (wantsCustomFields) {
      if (getCustomColumnsMode() === "off")
        throw new Error(
          "customFields was provided but CUSTOM_COLUMNS_MODE is 'off' on this server. Ask the server operator to set CUSTOM_COLUMNS_MODE=metadata (or metadata+allowlist), or remove customFields.",
        );
      const entityMeta = await getEntityMetadata("msdyn_projecttask");
      resolveCustomColumn = (logicalName: string) => entityMeta.columns.get(logicalName);
    }

    const { entities, warnings } = buildUpdateEntities(tasks, resolvedBucketIds, resolvedSprintIds, resolveCustomColumn);

    // Auto-detect summary tasks from the plan hierarchy when projectId is provided.
    // This lets the guard fire without requiring a prior get_plan_tasks_and_buckets
    // call — the same projectId used for bucket resolution doubles here.
    let effectiveSummaryIds: unknown = input.summaryTaskIds;
    if (input.projectId && entities.length > 0) {
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

    // ---- Checklist pipeline (add / adjust / remove items on existing tasks) ----
    // taskIds were already GUID-validated by buildUpdateEntities above (it throws
    // on the first invalid one), so every checklist task here has a valid GUID.
    const checklistTasks = tasks
      .filter((t) => Array.isArray(t.checklist) && t.checklist!.length > 0)
      .map((t) => ({ taskId: (t.taskId || "").trim(), ops: t.checklist! }));

    // Removals delete user data — gate them behind confirmed:true (the repo's
    // delete-confirm golden rule), but only when a removal is actually present.
    const anyRemoval = checklistTasks.some((ct) => hasRemoval(ct.ops));
    if (
      anyRemoval &&
      input.confirmed !== true &&
      (input.confirmed as unknown) !== "true"
    )
      throw new Error(
        "Refused: a checklist entry has remove:true, which deletes the item on apply. Set confirmed:true after an explicit user confirmation.",
      );

    // Read current items for any task with an adjust/remove op (adds need no read).
    // Fails closed: a failed read rejects the batch rather than guessing.
    const existingByTask = new Map<string, ExistingChecklistItem[]>();
    for (const ct of checklistTasks) {
      if (!ct.ops.some(isExistingItemOp)) continue;
      const tid = assertGuid(ct.taskId, "taskId");
      const res = await dvReq(
        {
          url:
            BASE +
            "/" +
            CHECKLIST_ENTITY_SET +
            "?$select=msdyn_projectchecklistid,msdyn_name,msdyn_projectchecklistcompleted" +
            "&$filter=" +
            CHECKLIST_TASK_LOOKUP_VALUE +
            " eq " +
            tid +
            "&$top=200",
          method: "GET",
          headers: dvHeaders(),
        },
        { retry: true },
      );
      if (res.status >= 400)
        throw new Error(
          "Could not read the current checklist for task " +
            tid +
            " (" +
            res.status +
            "): " +
            dvErrorMessage(res) +
            ". adjust/remove need the existing items to resolve by id/title.",
        );
      existingByTask.set(
        tid.toLowerCase(),
        (res.json?.value || []).map((c: any) => ({
          id: c.msdyn_projectchecklistid,
          title: String(c.msdyn_name ?? ""),
          completed: c.msdyn_projectchecklistcompleted === true,
        })),
      );
    }

    const planned = planChecklistOps(checklistTasks, existingByTask, randomUUID);
    const checklistCreateEntities = planned.creates.map((c) =>
      checklistCreateEntity(c.taskId, c.checklistId, c.title, c.completed),
    );
    const checklistUpdateEntities = planned.updates.map((u) =>
      checklistUpdateEntity(u.id, { title: u.title, completed: u.completed }),
    );
    const checklistDeleteRecords = planned.removes.map((r) => ({
      entityLogicalName: CHECKLIST_LOGICAL_NAME,
      recordId: r.id,
    }));

    // Combined UPDATE collection: task-field edits + checklist item edits, one call.
    const updateEntities = [...entities, ...checklistUpdateEntities];

    // Defense in depth — reuse the raw tools' validators (no guardrail weakened):
    // summary-task protection + 200-cap on the update collection, allow-list +
    // unique-GUID + 200-cap on the checklist creates, and the delete guardrail on
    // the checklist removes.
    if (updateEntities.length > 0)
      validateUpdateEntities(updateEntities, effectiveSummaryIds);
    if (checklistCreateEntities.length > 0)
      validateAddEntities(checklistCreateEntities);
    if (checklistDeleteRecords.length > 0)
      validateDeleteRecords(checklistDeleteRecords);

    // Fire each PSS call only when it has work, all against the SAME OperationSet
    // (applied together on apply_changes). This mirrors calling update_tasks +
    // add_tasks_batch + delete_tasks_batch in one session.
    const responses: Record<string, unknown> = {};
    if (updateEntities.length > 0) {
      const response = await dvReq({
        url: BASE + "/msdyn_PssUpdateV2",
        method: "POST",
        headers: dvHeaders({ json: true }),
        body: { EntityCollection: updateEntities, OperationSetId: operationSetId },
      });
      if (response.status >= 400) {
        const msg = dvErrorMessage(response);
        if (response.status === 403)
          throw new Error("403 - missing license or privileges: " + msg);
        throw new Error("pss_update_batch failed (" + response.status + "): " + msg);
      }
      responses.update = response.json || {};
    }
    if (checklistCreateEntities.length > 0) {
      const response = await dvReq({
        url: BASE + "/msdyn_PssCreateV2",
        method: "POST",
        headers: dvHeaders({ json: true }),
        body: {
          EntityCollection: checklistCreateEntities,
          OperationSetId: operationSetId,
        },
      });
      throwIfPssCreateError(response);
      responses.create = response.json || {};
    }
    if (checklistDeleteRecords.length > 0) {
      const response = await dvReq({
        url: BASE + "/msdyn_PssDeleteV2",
        method: "POST",
        headers: dvHeaders({ json: true }),
        body: {
          EntityCollection: buildDeleteEntities(checklistDeleteRecords),
          OperationSetId: operationSetId,
        },
      });
      if (response.status >= 400) {
        const msg = dvErrorMessage(response);
        if (response.status === 403)
          throw new Error("403 - missing license or privileges: " + msg);
        throw new Error("pss_delete_batch failed (" + response.status + "): " + msg);
      }
      responses.delete = response.json || {};
    }

    return {
      ok: true,
      queued:
        updateEntities.length +
        checklistCreateEntities.length +
        checklistDeleteRecords.length,
      taskUpdates: entities.length,
      checklist:
        checklistTasks.length > 0
          ? {
              added: planned.creates.length,
              updated: planned.updates.length,
              removed: planned.removes.length,
            }
          : undefined,
      checklistIds:
        planned.creates.length > 0
          ? planned.creates.map((c) => c.checklistId)
          : undefined,
      warnings: [...warnings, ...planned.warnings],
      response: responses,
      note: "Queued. Saved only after 'Apply Changes to Plan'.",
    };
  },
};
