// Single source of truth for the msdyn_projectchecklist entity: its schema
// constants, the create/update entity builders, and the PURE op planner that
// turns the ergonomic `checklist` op list into create/update/remove sets.
//
// Checklist items are child rows of a task. On WRITE the parent-task lookup is
// the PascalCase nav-property `msdyn_ProjectTaskId@odata.bind` (verified — see
// docs/PSS-IMPLEMENTATION-LESSONS.md). create → PssCreateV2, delete → PssDeleteV2
// are both proven; update via PssUpdateV2 is the analogous op (see docs/plans/50).

export const CHECKLIST_ODATA_TYPE =
  "Microsoft.Dynamics.CRM.msdyn_projectchecklist";
export const CHECKLIST_LOGICAL_NAME = "msdyn_projectchecklist";
export const CHECKLIST_ENTITY_SET = "msdyn_projectchecklists";
export const CHECKLIST_ID_FIELD = "msdyn_projectchecklistid";
export const CHECKLIST_NAME_FIELD = "msdyn_name";
export const CHECKLIST_COMPLETED_FIELD = "msdyn_projectchecklistcompleted";
export const CHECKLIST_TASK_BIND = "msdyn_ProjectTaskId@odata.bind";
// Value-side lookup field used to READ a task's checklist rows
// (`$filter=<this> eq <taskId>`). From the `_<lookup-logical-name>_value` Dataverse
// convention + the PascalCase write nav-property `msdyn_ProjectTaskId` (cf.
// `_msdyn_taskid_value` on msdyn_resourceassignment). Confirmed live 2026-07-01
// (docs/plans/50 §6) — kept here so any future correction is a one-line change.
export const CHECKLIST_TASK_LOOKUP_VALUE = "_msdyn_projecttaskid_value";

/** The msdyn_projectchecklist CREATE entity for a PssCreateV2 batch. */
export function checklistCreateEntity(
  taskId: string,
  checklistId: string,
  title: string,
  completed: boolean,
): Record<string, unknown> {
  return {
    "@odata.type": CHECKLIST_ODATA_TYPE,
    [CHECKLIST_ID_FIELD]: checklistId,
    [CHECKLIST_TASK_BIND]: "/msdyn_projecttasks(" + taskId + ")",
    [CHECKLIST_NAME_FIELD]: title,
    [CHECKLIST_COMPLETED_FIELD]: completed,
  };
}

/** The msdyn_projectchecklist partial UPDATE entity for a PssUpdateV2 batch. */
export function checklistUpdateEntity(
  id: string,
  changes: { title?: string; completed?: boolean },
): Record<string, unknown> {
  const ent: Record<string, unknown> = {
    "@odata.type": CHECKLIST_ODATA_TYPE,
    [CHECKLIST_ID_FIELD]: id,
  };
  if (changes.title !== undefined) ent[CHECKLIST_NAME_FIELD] = changes.title;
  if (changes.completed !== undefined)
    ent[CHECKLIST_COMPLETED_FIELD] = changes.completed;
  return ent;
}

const GUID_RE = /^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$/;
const isGuid = (s: string): boolean => GUID_RE.test(s);

/** One ergonomic checklist operation (string shorthand = add-by-title). */
export type ChecklistOpInput =
  | string
  | {
      /** Target an existing item by GUID (takes precedence over `match`). */
      id?: string;
      /** Target an existing item by its current title. */
      match?: string;
      /** ADD: the item title. ADJUST: the new title (rename). */
      title?: string;
      /** ADD/ADJUST: completion state. */
      completed?: boolean;
      /** REMOVE this existing item. */
      remove?: boolean;
    };

/** An existing checklist row as read back from Dataverse. */
export interface ExistingChecklistItem {
  id: string;
  title: string;
  completed: boolean;
}

export interface ChecklistCreatePlanned {
  taskId: string;
  checklistId: string;
  title: string;
  completed: boolean;
}
export interface ChecklistUpdatePlanned {
  taskId: string;
  id: string;
  title?: string;
  completed?: boolean;
}
export interface ChecklistRemovePlanned {
  taskId: string;
  id: string;
}
export interface PlannedChecklist {
  creates: ChecklistCreatePlanned[];
  updates: ChecklistUpdatePlanned[];
  removes: ChecklistRemovePlanned[];
  warnings: string[];
}

/** True for any op that targets an EXISTING item (needs a current-checklist read). */
export function isExistingItemOp(op: ChecklistOpInput): boolean {
  if (typeof op === "string") return false;
  return op.remove === true || !!op.id || !!op.match;
}

/** Does this task's op list contain any removal? (drives the confirm gate) */
export function hasRemoval(ops: ChecklistOpInput[]): boolean {
  return ops.some((op) => typeof op !== "string" && op.remove === true);
}

/**
 * Resolves an ADJUST/REMOVE op to the target checklist item's GUID against the
 * task's current items. Throws a specific error on an unknown id, an unmatched
 * title, or an ambiguous title (multiple items share it).
 */
function resolveTargetId(
  op: { id?: string; match?: string },
  existing: ExistingChecklistItem[],
  taskId: string,
): string {
  if (op.id) {
    const id = op.id.trim();
    if (!isGuid(id))
      throw new Error(
        "checklist op for task " + taskId + ": id '" + op.id + "' is not a GUID.",
      );
    const hit = existing.find((e) => e.id.toLowerCase() === id.toLowerCase());
    if (!hit)
      throw new Error(
        "checklist op for task " +
          taskId +
          ": no checklist item with id " +
          id +
          " on this task.",
      );
    return hit.id;
  }
  const match = (op.match || "").trim();
  if (!match)
    throw new Error(
      "checklist op for task " +
        taskId +
        ": adjust/remove needs 'id' or 'match' (the item's current title).",
    );
  const hits = existing.filter(
    (e) => e.title.trim().toLowerCase() === match.toLowerCase(),
  );
  if (hits.length === 0)
    throw new Error(
      "checklist op for task " +
        taskId +
        ": no checklist item titled '" +
        match +
        "' on this task. Read the task's checklist (get_task) to see current items.",
    );
  if (hits.length > 1)
    throw new Error(
      "checklist op for task " +
        taskId +
        ": " +
        hits.length +
        " checklist items are titled '" +
        match +
        "' — pass 'id' to disambiguate.",
    );
  return hits[0].id;
}

/**
 * Pure: turns each task's ergonomic checklist ops into create/update/remove sets.
 * `existingByTask` maps a lowercased taskId to that task's current items (only
 * required for tasks that have an adjust/remove op). `newId` mints client GUIDs
 * for adds (injected so it is deterministic in tests). Throws on any invalid op.
 */
export function planChecklistOps(
  tasks: { taskId: string; ops: ChecklistOpInput[] }[],
  existingByTask: Map<string, ExistingChecklistItem[]>,
  newId: () => string,
): PlannedChecklist {
  const creates: ChecklistCreatePlanned[] = [];
  const updates: ChecklistUpdatePlanned[] = [];
  const removes: ChecklistRemovePlanned[] = [];
  const warnings: string[] = [];

  for (const { taskId, ops } of tasks) {
    const existing = existingByTask.get(taskId.toLowerCase());

    for (const raw of ops) {
      // ADD — string shorthand or a bare {title, completed}.
      if (typeof raw === "string" || !isExistingItemOp(raw)) {
        const obj = typeof raw === "string" ? { title: raw } : raw;
        const title = (obj.title || "").trim();
        if (!title)
          throw new Error(
            "checklist add for task " + taskId + ": title must not be empty.",
          );
        creates.push({
          taskId,
          checklistId: newId(),
          title,
          completed: (obj as { completed?: boolean }).completed === true,
        });
        continue;
      }

      // Existing-item op — requires a successful current-checklist read.
      if (existing === undefined)
        throw new Error(
          "checklist op for task " +
            taskId +
            ": the task's current checklist could not be read, so adjust/remove " +
            "cannot be resolved. Retry, or pass adds only.",
        );

      // REMOVE.
      if (raw.remove === true) {
        removes.push({ taskId, id: resolveTargetId(raw, existing, taskId) });
        continue;
      }

      // ADJUST — must change at least one of title / completed.
      const hasTitle = typeof raw.title === "string" && raw.title.trim() !== "";
      const hasCompleted = typeof raw.completed === "boolean";
      if (!hasTitle && !hasCompleted)
        throw new Error(
          "checklist adjust for task " +
            taskId +
            ": provide a new 'title' and/or 'completed' to change.",
        );
      updates.push({
        taskId,
        id: resolveTargetId(raw, existing, taskId),
        ...(hasTitle ? { title: raw.title!.trim() } : {}),
        ...(hasCompleted ? { completed: raw.completed } : {}),
      });
    }
  }

  return { creates, updates, removes, warnings };
}
