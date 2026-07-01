import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getApiBase, getEnv, getCustomColumnsMode } from "../config.js";
import {
  dvReq,
  dvHeaders,
  dvErrorMessage,
  asArray,
  assertGuid,
  throwIfPssCreateError,
} from "../dataverse.js";
import { validateAddEntities } from "./addTasks.js";
import { hasStrippableTagContent } from "./readHelpers.js";
import { getEntityMetadata } from "../dataverse/metadata.js";
import { toWrite as columnToWrite, type ColumnMeta } from "../dataverse/columnTypes.js";
import type { ToolDef } from "./types.js";

const GUID_RE = /^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$/;
const isGuid = (s: string): boolean => GUID_RE.test(s);

// FS/SS/FF/SF -> option-set integers sent to PSS. Two value ranges exist;
// the correct one is selected at runtime from DATAVERSE_LINK_TYPE_STYLE.
export const LINK_TYPE_VALUES_GLOBAL: Record<string, number> = {
  FS: 192350000,
  SS: 192350001,
  FF: 192350002,
  SF: 192350003,
};

// EU/CRM4 tenants (confirmed via describe_option_set + live ScheduleAPI-AV-0043
// rejection of 192350000): FinishToStart=1, StartToStart=3, FinishToFinish=0, StartToFinish=2.
export const LINK_TYPE_VALUES_EU: Record<string, number> = {
  FS: 1,
  SS: 3,
  FF: 0,
  SF: 2,
};

export interface SimpleDependency {
  on: string; // predecessor: a ref in this batch, or an existing task GUID
  type?: "FS" | "SS" | "FF" | "SF";
  lagMinutes?: number;
}

export interface ChecklistItem {
  title: string;
  completed?: boolean;
}

export interface SimpleTask {
  ref: string;
  subject: string;
  bucket?: string;   // bucket name or bucketId GUID (use this OR bucketId)
  bucketId?: string; // alias for bucket when passing a GUID directly
  start?: string;
  finish?: string;
  effortHours?: number;
  description?: string;
  priority?: number;
  parent?: string; // a ref in this batch, or an existing task GUID
  milestone?: boolean;
  dependsOn?: SimpleDependency[];
  /** Checklist items: plain strings (titles) or {title, completed}. */
  checklist?: (string | ChecklistItem)[];
  /** Sprint to place this task in: sprint name (resolved against the plan) or a sprintId GUID. */
  sprint?: string;
  /** Labels to tag this task with: label TEXT (resolved against the plan's existing
   * labels) or a labelId GUID. Labels themselves cannot be created via the API
   * (Project UI only) — an unknown label is skipped with a warning. */
  labels?: string[];
  /** Assign team members to this task: member name (resolved against the plan's
   * project team) or a teamMemberId GUID. The person must already be on the
   * project team — an unknown assignee is skipped with a warning. */
  assignees?: string[];
  /** Custom (non-msdyn_) column values, keyed by logical name. Requires
   * CUSTOM_COLUMNS_MODE!=off on the server. Resolved via metadata + the
   * columnTypes.ts codec — label-friendly (picklist label or value; lookup
   * {target,id} or a bare guid when single-target). Rejects any msdyn_* key. */
  customFields?: Record<string, unknown>;
}

/** Resolves a team-member reference to the ids a resource assignment needs. */
export type ResolveAssignee = (assignee: string) => { teamMemberId: string; bookableResourceId: string } | null;

/** Resolves a custom (non-msdyn_) column's metadata by logical name, or
 * undefined if it doesn't exist / isn't a custom column on this entity.
 * Injected into buildTaskEntities/buildUpdateEntities so those builders stay
 * pure and unit-testable with a fake resolver (no network in tests) — the
 * async handler fetches metadata via dataverse/metadata.ts and closes over it. */
export type ResolveCustomColumn = (logicalName: string) => ColumnMeta | undefined;

/**
 * Splices customFields into `ent` via the column codec. Throws a clear,
 * specific error (never a silent drop) when a key is msdyn_* (prefix
 * discipline — the custom channel must never bypass the standard allow-list),
 * or when the column can't be resolved/serialized. `contextLabel` is a short
 * prefix identifying which task/ref the error belongs to.
 */
export function spliceCustomFields(
  ent: Record<string, unknown>,
  customFields: Record<string, unknown> | undefined,
  mode: "create" | "update",
  resolveCustomColumn: ResolveCustomColumn | undefined,
  contextLabel: string,
): void {
  if (!customFields) return;
  const keys = Object.keys(customFields);
  if (keys.length === 0) return;
  if (!resolveCustomColumn)
    throw new Error(
      contextLabel +
        ": customFields were provided but custom-column resolution is unavailable (CUSTOM_COLUMNS_MODE is 'off', or the server could not be reached). Set CUSTOM_COLUMNS_MODE=metadata, or remove customFields.",
    );
  for (const key of keys) {
    if (/^msdyn_/i.test(key))
      throw new Error(
        contextLabel +
          ": customFields key '" +
          key +
          "' starts with 'msdyn_' — that is a standard field, not a custom column. Use the tool's named parameter for it instead (customFields is only for customer-added, non-msdyn_ columns).",
      );
    const col = resolveCustomColumn(key);
    if (!col)
      throw new Error(
        contextLabel +
          ": customFields key '" +
          key +
          "' is not a known custom column on this entity. Use list_custom_columns to discover valid names.",
      );
    const fragments = columnToWrite(col, customFields[key], mode);
    for (const [k, v] of fragments) ent[k] = v;
  }
}

export interface BuiltBatch {
  entities: any[];
  /** ref -> generated msdyn_projecttaskid */
  refToId: Record<string, string>;
  /** GUIDs of tasks flagged milestone (NOT set here - for a follow-up update). */
  milestoneTaskIds: string[];
  /** GUIDs of dependency entities created (msdyn_projecttaskdependencyid).
   * PSS requires these to be deleted BEFORE their referenced tasks — include
   * them in delete_tasks_batch records when cleaning up. */
  dependencyIds: string[];
  /** GUIDs of checklist items created (msdyn_projectchecklistid). */
  checklistIds: string[];
  /** Non-fatal warnings about caller-supplied values that PSS will silently
   * ignore or override (e.g. effortHours on a summary task). */
  warnings: string[];
}

/**
 * Orders tasks so any task whose `parent` is an in-batch ref appears AFTER that
 * parent. Throws on an unknown in-batch parent ref or a hierarchy cycle. Tasks
 * whose parent is an existing task GUID (or absent) impose no ordering.
 */
function orderParentsFirst(tasks: SimpleTask[]): SimpleTask[] {
  const byRef = new Map(tasks.map((t) => [t.ref, t]));
  const result: SimpleTask[] = [];
  const done = new Set<string>();
  const stack = new Set<string>();

  const visit = (t: SimpleTask): void => {
    if (done.has(t.ref)) return;
    if (stack.has(t.ref))
      throw new Error("Cycle in parent hierarchy at task ref '" + t.ref + "'.");
    stack.add(t.ref);
    if (t.parent && !isGuid(t.parent)) {
      const p = byRef.get(t.parent);
      if (!p)
        throw new Error(
          "Task '" +
            t.ref +
            "': parent '" +
            t.parent +
            "' is neither a ref in this batch nor a GUID.",
        );
      visit(p);
    }
    stack.delete(t.ref);
    done.add(t.ref);
    result.push(t);
  };

  for (const t of tasks) visit(t);
  return result;
}

/**
 * Translates the ergonomic task list into the Dataverse PSS entity array the
 * raw msdyn_PssCreateV2 call expects: generates client GUIDs, builds every
 * @odata.type / @odata.bind, maps FS/SS/FF/SF link types, and orders tasks
 * parents-first. `resolveBucketId` turns a bucket name (or GUID) into a bucket
 * GUID; injected so this function stays pure and unit-testable.
 *
 * All dependency entities are appended AFTER all task entities so both endpoints
 * of every link are already present in the collection regardless of order.
 */
export function buildTaskEntities(
  projectId: string,
  tasks: SimpleTask[],
  resolveBucketId: (bucket: string) => string,
  linkTypeValues: Record<string, number> = LINK_TYPE_VALUES_GLOBAL,
  resolveSprintId?: (sprint: string) => string,
  resolveLabelId?: (label: string) => string,
  resolveAssignee?: ResolveAssignee,
  resolveCustomColumn?: ResolveCustomColumn,
): BuiltBatch {
  if (!Array.isArray(tasks) || tasks.length === 0)
    throw new Error("tasks must be a non-empty array.");

  // Unique, present refs.
  const seen = new Set<string>();
  for (const t of tasks) {
    if (!t.ref || typeof t.ref !== "string")
      throw new Error("Every task needs a unique string 'ref'.");
    if (seen.has(t.ref)) throw new Error("Duplicate task ref '" + t.ref + "'.");
    seen.add(t.ref);
    if (!t.subject || !t.subject.trim())
      throw new Error("Task '" + t.ref + "': subject is required.");
    // Accept either 'bucket' (name or GUID) or 'bucketId' (GUID alias).
    if (!(t.bucket || t.bucketId || "").trim())
      throw new Error(
        "Task '" + t.ref + "': 'bucket' is required — pass the bucket name (e.g. \"Sprint 1\") or a bucketId GUID via the 'bucket' field.",
      );
  }

  const refToId: Record<string, string> = {};
  for (const t of tasks) refToId[t.ref] = randomUUID();

  const resolvePredecessorId = (on: string, ownerRef: string): string => {
    if (isGuid(on)) return on;
    const id = refToId[on];
    if (!id)
      throw new Error(
        "Task '" +
          ownerRef +
          "': dependsOn.on '" +
          on +
          "' is neither a ref in this batch nor a GUID.",
      );
    return id;
  };

  const ordered = orderParentsFirst(tasks);

  // Identify which refs appear as a parent of another task in this batch.
  const parentRefs = new Set(tasks.map((t) => t.parent).filter(Boolean) as string[]);

  const taskEntities: any[] = [];
  const depEntities: any[] = [];
  const checklistEntities: any[] = [];
  const labelEntities: any[] = [];
  const assignmentEntities: any[] = [];
  const milestoneTaskIds: string[] = [];
  const dependencyIds: string[] = [];
  const checklistIds: string[] = [];
  const warnings: string[] = [];

  for (const t of ordered) {
    const id = refToId[t.ref];
    const ent: Record<string, unknown> = {
      "@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
      msdyn_projecttaskid: id,
      msdyn_subject: t.subject,
      "msdyn_project@odata.bind": "/msdyn_projects(" + projectId + ")",
      "msdyn_projectbucket@odata.bind":
        "/msdyn_projectbuckets(" + resolveBucketId(t.bucket || t.bucketId || "") + ")",
    };
    if (t.start) ent.msdyn_start = t.start;
    if (t.finish) ent.msdyn_finish = t.finish;
    if (typeof t.effortHours === "number") ent.msdyn_effort = t.effortHours;
    if (t.description) ent.msdyn_description = t.description;
    if (typeof t.priority === "number") ent.msdyn_priority = t.priority;
    if (t.parent) {
      const parentId = isGuid(t.parent) ? t.parent : refToId[t.parent];
      ent["msdyn_parenttask@odata.bind"] = "/msdyn_projecttasks(" + parentId + ")";
    }
    if (t.sprint) {
      const raw = t.sprint.trim();
      const sprintId = resolveSprintId ? resolveSprintId(raw) : isGuid(raw) ? raw : "";
      if (!sprintId)
        throw new Error(
          "Task '" + t.ref + "': sprint '" + raw + "' could not be resolved. Pass a sprintId GUID, or a sprint name that exists in the plan (create it first with add_sprint).",
        );
      ent["msdyn_projectsprint@odata.bind"] = "/msdyn_projectsprints(" + sprintId + ")";
    }
    // milestone is BLOCKED on create - never put it in the payload; surface it
    // instead so the caller can set it via a follow-up update_tasks_batch.
    if (t.milestone === true) milestoneTaskIds.push(id);

    // PSS ignores effortHours on summary tasks (parent tasks) — it rolls up
    // effort from leaf children automatically. Warn so the caller is not surprised.
    if (typeof t.effortHours === "number" && parentRefs.has(t.ref)) {
      warnings.push(
        "tasks[" +
          t.ref +
          "] (taskId: " +
          id +
          "): 'effortHours' was ignored on summary task — PSS computes effort from leaf children automatically.",
      );
    }

    // Dataverse strips tag-like <...> content from descriptions on save. Warn so
    // the caller knows that text will not be stored (a lone < or > is fine).
    if (hasStrippableTagContent(t.description)) {
      warnings.push(
        "tasks[" +
          t.ref +
          "] (taskId: " +
          id +
          "): description contains angle-bracket content (e.g. \"<...>\") that Dataverse strips on save — that text will not be stored. Remove or rephrase the angle brackets if it must be kept.",
      );
    }

    // Custom (non-msdyn_) columns — resolved via metadata + the columnTypes.ts
    // codec, spliced in as extra keys on the same task entity. Fails closed with
    // a specific error (never a silent drop) on an msdyn_* key, an unresolved
    // column, or a bad value.
    spliceCustomFields(ent, t.customFields, "create", resolveCustomColumn, "tasks[" + t.ref + "]");

    taskEntities.push(ent);

    for (const dep of t.dependsOn || []) {
      const predId = resolvePredecessorId(dep.on, t.ref);
      // The lookup navigation properties are the PascalCase schema names
      // (msdyn_PredecessorTask / msdyn_SuccessorTask), NOT the lowercase logical
      // names. Lowercase keys make Dataverse OData reject the payload with
      // "undeclared property ... which only has property annotations ... but no
      // property value was found". The read side still uses the lowercase
      // _value alias (that is a different, value-side name).
      // PSS requires the project bind on the dependency entity too. Without it
      // the API defaults to the zero GUID (00000000-…) which it then rejects as
      // not matching the operation set's project (ScheduleAPI-OV-0001).
      // On msdyn_projecttaskdependency ALL lookup nav-properties use the PascalCase
      // schema name, not the lowercase logical name. msdyn_project@odata.bind causes
      // "undeclared property 'msdyn_project' which only has property annotations"
      // because the schema nav-property is msdyn_Project (capital P).
      const depId = randomUUID();
      dependencyIds.push(depId);
      const depEnt: Record<string, unknown> = {
        "@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttaskdependency",
        msdyn_projecttaskdependencyid: depId,
        "msdyn_Project@odata.bind": "/msdyn_projects(" + projectId + ")",
        "msdyn_PredecessorTask@odata.bind": "/msdyn_projecttasks(" + predId + ")",
        "msdyn_SuccessorTask@odata.bind": "/msdyn_projecttasks(" + id + ")",
      };
      if (dep.type) {
        const v = linkTypeValues[dep.type];
        if (v === undefined)
          throw new Error(
            "Task '" + t.ref + "': dependency type must be FS, SS, FF or SF.",
          );
        depEnt.msdyn_projecttaskdependencylinktype = v;
      }
      if (dep.lagMinutes !== undefined && dep.lagMinutes !== null) {
        if (typeof dep.lagMinutes !== "number")
          throw new Error(
            "Task '" + t.ref + "': dependsOn.lagMinutes must be a number (minutes).",
          );
        depEnt.msdyn_projecttaskdependencylinklag = dep.lagMinutes;
      }
      depEntities.push(depEnt);
    }

    // Checklist items — child rows of the task. msdyn_name is the item title;
    // msdyn_ProjectTaskId is the PascalCase nav-property for the parent task.
    for (const raw of t.checklist || []) {
      const item: ChecklistItem = typeof raw === "string" ? { title: raw } : raw;
      const title = (item.title || "").trim();
      if (!title)
        throw new Error("Task '" + t.ref + "': checklist item title must not be empty.");
      const chkId = randomUUID();
      checklistIds.push(chkId);
      checklistEntities.push({
        "@odata.type": "Microsoft.Dynamics.CRM.msdyn_projectchecklist",
        msdyn_projectchecklistid: chkId,
        "msdyn_ProjectTaskId@odata.bind": "/msdyn_projecttasks(" + id + ")",
        msdyn_name: title,
        msdyn_projectchecklistcompleted: item.completed === true,
      });
    }

    // Labels — junction rows (msdyn_projecttasktolabel) linking the task to an
    // EXISTING plan label. Labels can't be created via the API; an unresolved
    // label is skipped with a warning rather than failing the batch.
    for (const rawLabel of t.labels || []) {
      const label = (rawLabel || "").trim();
      if (!label) continue;
      const labelId = resolveLabelId ? resolveLabelId(label) : isGuid(label) ? label : "";
      if (!labelId) {
        warnings.push(
          "tasks[" + t.ref + "]: label '" + label + "' was skipped — no such label in this plan. " +
            "Labels cannot be created via the API (Project UI only); create it in the Planner/Project UI first, then re-run.",
        );
        continue;
      }
      labelEntities.push({
        "@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttasktolabel",
        msdyn_projecttasktolabelid: randomUUID(),
        "msdyn_ProjectLabelId@odata.bind": "/msdyn_projectlabels(" + labelId + ")",
        "msdyn_ProjectTaskId@odata.bind": "/msdyn_projecttasks(" + id + ")",
      });
    }

    // Assignees — msdyn_resourceassignment links the task to a project team member.
    // start/finish are blocked on create (PSS derives them from the task); name +
    // the four lookup binds are what's needed. Unknown assignees are skipped.
    for (const rawAssignee of t.assignees || []) {
      const assignee = (rawAssignee || "").trim();
      if (!assignee) continue;
      const member = resolveAssignee ? resolveAssignee(assignee) : null;
      if (!member) {
        warnings.push(
          "tasks[" + t.ref + "]: assignee '" + assignee + "' was skipped — not a member of this plan's project team. " +
            "Add the person to the project team first (they must be a bookable Project resource).",
        );
        continue;
      }
      const asgEnt: Record<string, unknown> = {
        "@odata.type": "Microsoft.Dynamics.CRM.msdyn_resourceassignment",
        msdyn_resourceassignmentid: randomUUID(),
        msdyn_name: assignee,
        "msdyn_taskid@odata.bind": "/msdyn_projecttasks(" + id + ")",
        "msdyn_projectid@odata.bind": "/msdyn_projects(" + projectId + ")",
        "msdyn_projectteamid@odata.bind": "/msdyn_projectteams(" + member.teamMemberId + ")",
      };
      if (member.bookableResourceId)
        asgEnt["msdyn_bookableresourceid@odata.bind"] = "/bookableresources(" + member.bookableResourceId + ")";
      assignmentEntities.push(asgEnt);
    }
  }

  return {
    entities: [...taskEntities, ...depEntities, ...checklistEntities, ...labelEntities, ...assignmentEntities],
    refToId,
    milestoneTaskIds,
    dependencyIds,
    checklistIds,
    warnings,
  };
}

const dependencySchema = z.object({
  on: z
    .string()
    .describe("Predecessor task: a ref in this batch, or an existing task GUID."),
  type: z
    .enum(["FS", "SS", "FF", "SF"])
    .optional()
    .describe("Link type. Default FS (Finish-to-Start)."),
  lagMinutes: z.number().optional().describe("Optional lag in minutes."),
});

const taskSchema = z.object({
  ref: z
    .string()
    .describe("Your own short label for this task, unique within the batch. Used to wire parents and dependencies. Not stored."),
  subject: z.string().describe("Task name."),
  bucket: z
    .string()
    .optional()
    .describe("Bucket NAME (resolved against the plan) or a bucketId GUID. Use this OR 'bucketId', not both."),
  bucketId: z
    .string()
    .optional()
    .describe("Alias for 'bucket' when passing a GUID directly — avoids bucket-name lookup. Use the GUID returned by add_bucket here."),
  start: z.string().optional().describe("ISO start date, e.g. 2026-07-01."),
  finish: z.string().optional().describe("ISO finish date, e.g. 2026-07-05."),
  effortHours: z.number().optional().describe("Effort in hours."),
  description: z.string().optional().describe("Task note / description."),
  priority: z.number().optional().describe("Priority (integer option-set value)."),
  parent: z
    .string()
    .optional()
    .describe(
      "Parent task to nest under: a ref in this batch (any nesting depth) or an existing task GUID. The server orders parents before children; do not set outline level. Omit for a top-level task.",
    ),
  milestone: z
    .boolean()
    .optional()
    .describe("Request a milestone. Cannot be set via the API (PSS rejects msdyn_ismilestone on create and update). The taskId is returned in milestoneTaskIds so you can tell the user which tasks to flag manually in the Planner UI."),
  dependsOn: z
    .array(dependencySchema)
    .optional()
    .describe("Predecessor dependencies for this task."),
  checklist: z
    .array(
      z.union([
        z.string(),
        z.object({ title: z.string(), completed: z.boolean().optional() }),
      ]),
    )
    .optional()
    .describe(
      "Checklist items for this task: plain strings (titles) or {title, completed}. Each counts toward the 200-entity batch cap.",
    ),
  sprint: z
    .string()
    .optional()
    .describe(
      "Place this task in a sprint: sprint NAME (resolved against the plan) or a sprintId GUID. Create the sprint first with add_sprint.",
    ),
  labels: z
    .array(z.string())
    .optional()
    .describe(
      "Tag this task with EXISTING plan labels: label text (resolved against the plan) or labelId GUIDs. Labels themselves cannot be created via the API (Project UI only) — unknown labels are skipped with a warning.",
    ),
  assignees: z
    .array(z.string())
    .optional()
    .describe(
      "Assign project-team members to this task: member name (resolved against the plan's project team) or teamMemberId GUIDs (from list_team_members). The person must already be on the project team — unknown assignees are skipped with a warning.",
    ),
  customFields: z
    .record(z.unknown())
    .optional()
    .describe(
      "Custom (non-msdyn_) Dataverse column values, keyed by logical name, e.g. {\"new_riskscore\": 7, \"new_category\": \"High\"}. Requires CUSTOM_COLUMNS_MODE!=off on the server. Picklist accepts a label or an integer value; lookups accept a bare GUID (when the column has a single target) or {target,id}. Use list_custom_columns / describe_columns to discover valid names and types first. Standard msdyn_ fields are rejected here — use this tool's named parameters for those.",
    ),
});

// Ergonomic create - the model sends a plain task list; the server builds the
// Dataverse PSS entity collection (GUIDs, binds, ordering, link types).
export const addTasksSimple: ToolDef = {
  name: "add_tasks",
  title: "Add Tasks to Plan",
  description:
    "Adds tasks (with optional hierarchy and dependencies) to a plan from a SIMPLE list - the server builds the Dataverse payload, so you do NOT write @odata.type, @odata.bind, GUIDs or option-set numbers. Requires an open change session (operationSetId) and the projectId. Give each task a short 'ref' (unique in the batch); set 'parent' to another task's ref (or an existing task GUID) to nest it. You may list tasks in ANY order and nest to ANY depth (e.g. 6+ levels) - the server orders parents before children automatically and never sends outline level. Reference a predecessor the same way (ref or existing GUID). Bucket may be a name (resolved against the plan) or a bucketId. Dependencies default to Finish-to-Start. Milestones cannot be set on create - they come back in milestoneTaskIds for a follow-up update_tasks_batch. Each task may also carry checklist items (checklist), a sprint (sprint - create it first with add_sprint), labels (labels - existing plan labels only; labels cannot be created via the API), and assignees (assignees - project-team members by name or id). Max 200 entities (tasks + dependencies + checklist items + label/assignment links combined). Returns taskRefs (your ref -> created taskId) so you can reference tasks later without re-reading. Nothing is saved until 'Apply Changes to Plan'. For custom fields or entity types this tool does not model, use the advanced add_tasks_batch instead.",
  inputSchema: {
    operationSetId: z
      .string()
      .describe("GUID of the open OperationSet (from 'Start Change Session')."),
    projectId: z.string().describe("GUID of the plan all these tasks belong to."),
    tasks: z
      .union([z.string(), z.array(taskSchema)])
      .describe("The tasks to add. A JSON array (or JSON string) of task objects."),
  },
  handler: async (input: {
    operationSetId: string;
    projectId: string;
    tasks: unknown;
  }) => {
    const BASE = getApiBase();

    const operationSetId = assertGuid(input.operationSetId, "operationSetId");
    const projectId = assertGuid(input.projectId, "projectId");

    const tasks = asArray<SimpleTask>(input.tasks, "tasks");
    if (tasks.length === 0) throw new Error("tasks must be a non-empty array.");

    // Normalise: coerce 'bucketId' alias into 'bucket' so the rest of the pipeline
    // only needs to handle one field. A GUID in 'bucketId' bypasses name lookup.
    for (const t of tasks) {
      if (!t.bucket && t.bucketId) t.bucket = t.bucketId;
    }

    // Resolve bucket names -> bucketIds with a single read (skip if all GUIDs).
    const wantedNames = new Set<string>();
    for (const t of tasks) {
      const b = (t.bucket || "").trim();
      if (b && !isGuid(b)) wantedNames.add(b.toLowerCase());
    }
    const nameToId: Record<string, string> = {};
    if (wantedNames.size > 0) {
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
        throw new Error(
          "bucket lookup failed (" + res.status + "): " + dvErrorMessage(res),
        );
      const counts: Record<string, number> = {};
      for (const b of res.json?.value || []) {
        const key = String(b.msdyn_name || "").trim().toLowerCase();
        counts[key] = (counts[key] || 0) + 1;
        nameToId[key] = b.msdyn_projectbucketid;
      }
      for (const name of wantedNames) {
        if (!nameToId[name])
          throw new Error(
            "No bucket named '" +
              name +
              "' in this plan. Create it first with add_bucket, or pass a bucketId.",
          );
        if (counts[name] > 1)
          throw new Error(
            "Multiple buckets named '" +
              name +
              "' in this plan - pass the bucketId GUID instead of the name.",
          );
      }
    }

    const resolveBucketId = (bucket: string): string => {
      const b = (bucket || "").trim();
      return isGuid(b) ? b : nameToId[b.toLowerCase()];
    };

    // Resolve sprint names -> sprintIds with a single read (skip if all GUIDs/none).
    const wantedSprints = new Set<string>();
    for (const t of tasks) {
      const s = (t.sprint || "").trim();
      if (s && !isGuid(s)) wantedSprints.add(s.toLowerCase());
    }
    const sprintNameToId: Record<string, string> = {};
    if (wantedSprints.size > 0) {
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
      const counts: Record<string, number> = {};
      for (const s of res.json?.value || []) {
        const key = String(s.msdyn_name || "").trim().toLowerCase();
        counts[key] = (counts[key] || 0) + 1;
        sprintNameToId[key] = s.msdyn_projectsprintid;
      }
      for (const name of wantedSprints) {
        if (!sprintNameToId[name])
          throw new Error(
            "No sprint named '" + name + "' in this plan. Create it first with add_sprint, or pass a sprintId GUID.",
          );
        if (counts[name] > 1)
          throw new Error(
            "Multiple sprints named '" + name + "' in this plan - pass the sprintId GUID instead of the name.",
          );
      }
    }
    const resolveSprintId = (sprint: string): string => {
      const s = (sprint || "").trim();
      return isGuid(s) ? s : sprintNameToId[s.toLowerCase()] || "";
    };

    // Resolve label text -> labelId against the plan's EXISTING labels (labels
    // cannot be created via the API). Unknown labels resolve to "" and are skipped
    // with a warning inside buildTaskEntities.
    const wantsLabels = tasks.some((t) => (t.labels?.length ?? 0) > 0);
    const labelTextToId: Record<string, string> = {};
    if (wantsLabels) {
      const res = await dvReq(
        {
          url:
            BASE +
            "/msdyn_projectlabels?$select=msdyn_projectlabelid,msdyn_projectlabeltext&$filter=_msdyn_project_value eq " +
            projectId +
            "&$top=200",
          method: "GET",
          headers: dvHeaders(),
        },
        { retry: true },
      );
      if (res.status < 400) {
        for (const l of res.json?.value || []) {
          const key = String(l.msdyn_projectlabeltext || "").trim().toLowerCase();
          if (key) labelTextToId[key] = l.msdyn_projectlabelid;
        }
      }
      // A failed label read is non-fatal: labels just won't resolve (skipped + warned).
    }
    const resolveLabelId = (label: string): string => {
      const l = (label || "").trim();
      return isGuid(l) ? l : labelTextToId[l.toLowerCase()] || "";
    };

    // Resolve assignees against the plan's project team (by name or teamMemberId).
    const wantsAssignees = tasks.some((t) => (t.assignees?.length ?? 0) > 0);
    const teamById: Record<string, { teamMemberId: string; bookableResourceId: string }> = {};
    const teamByName: Record<string, { teamMemberId: string; bookableResourceId: string }> = {};
    if (wantsAssignees) {
      const res = await dvReq(
        {
          url:
            BASE +
            "/msdyn_projectteams?$select=msdyn_projectteamid,msdyn_name,_msdyn_bookableresourceid_value&$filter=_msdyn_project_value eq " +
            projectId +
            "&$top=200",
          method: "GET",
          headers: dvHeaders(),
        },
        { retry: true },
      );
      if (res.status < 400) {
        for (const m of res.json?.value || []) {
          const entry = {
            teamMemberId: m.msdyn_projectteamid,
            bookableResourceId: m._msdyn_bookableresourceid_value,
          };
          teamById[String(m.msdyn_projectteamid).toLowerCase()] = entry;
          const nm = String(m.msdyn_name || "").trim().toLowerCase();
          if (nm) teamByName[nm] = entry;
        }
      }
      // A failed team read is non-fatal: assignees just won't resolve (skipped + warned).
    }
    const resolveAssignee: ResolveAssignee = (assignee: string) => {
      const a = (assignee || "").trim();
      if (isGuid(a)) return teamById[a.toLowerCase()] ?? null;
      return teamByName[a.toLowerCase()] ?? null;
    };

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

    const linkTypeValues =
      getEnv().DATAVERSE_LINK_TYPE_STYLE === "eu"
        ? LINK_TYPE_VALUES_EU
        : LINK_TYPE_VALUES_GLOBAL;
    const built = buildTaskEntities(projectId, tasks, resolveBucketId, linkTypeValues, resolveSprintId, resolveLabelId, resolveAssignee, resolveCustomColumn);

    // Defense in depth: the built collection must still pass the raw guardrails.
    validateAddEntities(built.entities);

    // Root-task auto-nesting trap: Planner's scheduling engine nests a *parentless*
    // task under an existing task when the plan is NOT empty (it has no concept of
    // "append at top level" on create). So top-level tasks added to a plan that
    // already has tasks silently get nested — building a false deep spine and, at
    // scale, tripping the max-task-level limit. We can't prevent it (outline level
    // is blocked on create and un-parenting is blocked on update), so warn loudly.
    const rootTasks = tasks.filter((t) => !t.parent);
    if (rootTasks.length > 0) {
      const probe = await dvReq(
        {
          url:
            BASE +
            "/msdyn_projecttasks?$select=msdyn_projecttaskid&$filter=_msdyn_project_value eq " +
            projectId +
            "&$top=1",
          method: "GET",
          headers: dvHeaders(),
        },
        { retry: true },
      );
      if (probe.status < 400 && (probe.json?.value?.length ?? 0) > 0) {
        built.warnings.push(
          rootTasks.length +
            " task(s) in this batch have no parent, but the plan already contains tasks. " +
            "Planner's scheduling engine will NEST these top-level tasks under an existing task instead of placing them at the top level. " +
            "To add real top-level tasks reliably, create all roots in the FIRST batch of a new plan; otherwise give every task an explicit 'parent'. " +
            "Affected refs: " +
            rootTasks.map((t) => t.ref).slice(0, 20).join(", ") +
            (rootTasks.length > 20 ? ", …" : "") + ".",
        );
      }
    }

    const response = await dvReq({
      url: BASE + "/msdyn_PssCreateV2",
      method: "POST",
      headers: dvHeaders({ json: true }),
      body: { EntityCollection: built.entities, OperationSetId: operationSetId },
    });

    throwIfPssCreateError(response);

    return {
      ok: true,
      queued: built.entities.length,
      taskRefs: built.refToId,
      milestoneTaskIds: built.milestoneTaskIds,
      dependencyIds: built.dependencyIds,
      checklistIds: built.checklistIds.length > 0 ? built.checklistIds : undefined,
      warnings: built.warnings.length > 0 ? built.warnings : undefined,
      response: response.json || {},
      note:
        built.milestoneTaskIds.length > 0
          ? "Queued. Milestones cannot be set via the API (PSS rejects msdyn_ismilestone on create and update) - the milestoneTaskIds list the tasks the user must flag as milestones manually in the Planner UI. New tasks are appended at the end. NOT saved until 'Apply Changes to Plan'."
          : "Queued. New tasks are appended at the end (reorder in the Planner UI if needed). NOT saved until 'Apply Changes to Plan'.",
      deleteNote:
        built.dependencyIds.length > 0
          ? "When cleaning up, include dependencyIds in delete_tasks_batch 'records' (entityLogicalName: msdyn_projecttaskdependency) BEFORE the task IDs — PSS rejects task deletion if dependency entities still reference them."
          : undefined,
    };
  },
};
