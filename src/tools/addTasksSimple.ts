import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getApiBase, getEnv } from "../config.js";
import {
  dvReq,
  dvHeaders,
  dvErrorMessage,
  asArray,
  assertGuid,
  throwIfPssCreateError,
} from "../dataverse.js";
import { validateAddEntities } from "./addTasks.js";
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

export interface SimpleTask {
  ref: string;
  subject: string;
  bucket: string; // bucket name or bucketId GUID
  start?: string;
  finish?: string;
  effortHours?: number;
  description?: string;
  priority?: number;
  parent?: string; // a ref in this batch, or an existing task GUID
  milestone?: boolean;
  dependsOn?: SimpleDependency[];
}

export interface BuiltBatch {
  entities: any[];
  /** ref -> generated msdyn_projecttaskid */
  refToId: Record<string, string>;
  /** GUIDs of tasks flagged milestone (NOT set here - for a follow-up update). */
  milestoneTaskIds: string[];
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
    if (!t.bucket || !t.bucket.trim())
      throw new Error("Task '" + t.ref + "': bucket is required (name or GUID).");
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

  const taskEntities: any[] = [];
  const depEntities: any[] = [];
  const milestoneTaskIds: string[] = [];

  for (const t of ordered) {
    const id = refToId[t.ref];
    const ent: Record<string, unknown> = {
      "@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
      msdyn_projecttaskid: id,
      msdyn_subject: t.subject,
      "msdyn_project@odata.bind": "/msdyn_projects(" + projectId + ")",
      "msdyn_projectbucket@odata.bind":
        "/msdyn_projectbuckets(" + resolveBucketId(t.bucket) + ")",
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
    // milestone is BLOCKED on create - never put it in the payload; surface it
    // instead so the caller can set it via a follow-up update_tasks_batch.
    if (t.milestone === true) milestoneTaskIds.push(id);

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
      const depEnt: Record<string, unknown> = {
        "@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttaskdependency",
        msdyn_projecttaskdependencyid: randomUUID(),
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
        depEnt.msdyn_linklagduration = dep.lagMinutes;
      }
      depEntities.push(depEnt);
    }
  }

  return {
    entities: [...taskEntities, ...depEntities],
    refToId,
    milestoneTaskIds,
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
    .describe("Bucket NAME (resolved against the plan) or a bucketId GUID."),
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
});

// Ergonomic create - the model sends a plain task list; the server builds the
// Dataverse PSS entity collection (GUIDs, binds, ordering, link types).
export const addTasksSimple: ToolDef = {
  name: "add_tasks",
  title: "Add Tasks to Plan",
  description:
    "Adds tasks (with optional hierarchy and dependencies) to a plan from a SIMPLE list - the server builds the Dataverse payload, so you do NOT write @odata.type, @odata.bind, GUIDs or option-set numbers. Requires an open change session (operationSetId) and the projectId. Give each task a short 'ref' (unique in the batch); set 'parent' to another task's ref (or an existing task GUID) to nest it. You may list tasks in ANY order and nest to ANY depth (e.g. 6+ levels) - the server orders parents before children automatically and never sends outline level. Reference a predecessor the same way (ref or existing GUID). Bucket may be a name (resolved against the plan) or a bucketId. Dependencies default to Finish-to-Start. Milestones cannot be set on create - they come back in milestoneTaskIds for a follow-up update_tasks_batch. Max 200 entities (tasks + dependencies combined). Returns taskRefs (your ref -> created taskId) so you can reference tasks later without re-reading. Nothing is saved until 'Apply Changes to Plan'. For checklists, sprints, resource assignments or custom fields, use the advanced add_tasks_batch instead.",
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

    const linkTypeValues =
      getEnv().DATAVERSE_LINK_TYPE_STYLE === "eu"
        ? LINK_TYPE_VALUES_EU
        : LINK_TYPE_VALUES_GLOBAL;
    const built = buildTaskEntities(projectId, tasks, resolveBucketId, linkTypeValues);

    // Defense in depth: the built collection must still pass the raw guardrails.
    validateAddEntities(built.entities);

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
      response: response.json || {},
      note:
        built.milestoneTaskIds.length > 0
          ? "Queued. Milestones cannot be set via the API (PSS rejects msdyn_ismilestone on create and update) - the milestoneTaskIds list the tasks the user must flag as milestones manually in the Planner UI. New tasks are appended at the end. NOT saved until 'Apply Changes to Plan'."
          : "Queued. New tasks are appended at the end (reorder in the Planner UI if needed). NOT saved until 'Apply Changes to Plan'.",
    };
  },
};
