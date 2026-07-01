import { z } from "zod";
import { getApiBase } from "../config.js";
import { dvReq, dvHeaders, dvErrorMessage, assertGuid } from "../dataverse.js";
import { linkTypeLabel, decodeDataverseText, readHeaders } from "./readHelpers.js";
import {
  getExtendedTaskFieldsCapability,
  setExtendedTaskFieldsCapability,
  isMissingPropertyError,
  EXTENDED_TASK_FIELDS,
} from "./capabilities.js";
import {
  includeCustomColumnsSchema,
  resolveCustomColumnsForRead,
  deserializeCustomFields,
  isCustomColumnMissingError,
} from "./customColumnsRead.js";
import {
  CHECKLIST_ENTITY_SET,
  CHECKLIST_TASK_LOOKUP_VALUE,
} from "./checklist.js";
import type { ToolDef } from "./types.js";

// One task in full, including its dependency links and resource assignments.
// The dependency/assignment read-column names are DERIVED from the verified
// write binds (no public entity-reference page exists), so those sub-reads
// degrade to a warning on 400 rather than failing the whole tool.
export const getTask: ToolDef = {
  name: "get_task",
  title: "Get Task",
  description:
    "Returns full detail for one task by GUID: dates (scheduled + actual), effort, remaining effort, duration, % complete, milestone flag, isSummary flag, outline level, display sequence, bucket (id + name), parent (id + subject), sprint id, priority, description, plus predecessor/successor dependency links, resource assignments (with member name), and checklist items (id + title + completed - use these ids to adjust/remove items via update_tasks). Dependency, assignment and checklist data may be omitted (with a warning) on environments where those columns differ - the core task fields always return. Optional includeCustomColumns (true, or an array of logical names) adds customer-added Dataverse columns as task.customFields - discover them first with list_custom_columns; requires CUSTOM_COLUMNS_MODE!=off on the server.",
  inputSchema: {
    taskId: z.string().describe("GUID of the task (msdyn_projecttaskid)."),
    includeCustomColumns: includeCustomColumnsSchema,
  },
  handler: async (input: { taskId: string; includeCustomColumns?: boolean | string[] }) => {
    const BASE = getApiBase();
    const taskId = assertGuid(input.taskId, "taskId");
    const warnings: string[] = [];

    // Fields available on all Planner Premium tenants.
    const CORE_SELECT =
      "msdyn_projecttaskid,msdyn_subject,msdyn_description," +
      "msdyn_start,msdyn_finish,msdyn_progress,msdyn_effort," +
      "msdyn_outlinelevel,msdyn_displaysequence,msdyn_ismilestone,msdyn_priority," +
      "_msdyn_projectbucket_value,_msdyn_parenttask_value,_msdyn_projectsprint_value";
    // Fields that exist only on Project Operations / certain tenant versions.
    // Gracefully absent on basic Planner Premium tenants. Shared literal from
    // capabilities.ts so the probe URL and cache stay in sync with list_plan_tasks.
    const EXPAND =
      "&$expand=msdyn_projectbucket($select=msdyn_name),msdyn_parenttask($select=msdyn_subject)";

    // Custom-column selection (additive; no-op unless CUSTOM_COLUMNS_MODE!=off
    // AND includeCustomColumns was passed). Resolved once up-front so its
    // warnings/select tokens/header can be reused across the retry paths below.
    const customSelection = await resolveCustomColumnsForRead(
      "msdyn_projecttask",
      input.includeCustomColumns,
    );
    warnings.push(...customSelection.warnings);
    const customSelectSuffix = customSelection.selectTokens.length
      ? "," + customSelection.selectTokens.join(",")
      : "";
    const taskHeaders = customSelection.needsWidenedPrefer
      ? readHeaders({ includeCustomColumns: true })
      : dvHeaders();

    // Check the process-lifetime capability cache first.
    // "unknown" → do the existing try-then-fallback (same behaviour as before,
    //   but the outcome is recorded so subsequent calls skip the probe).
    // "present" → skip to the extended select immediately.
    // "absent"  → skip to core-only select immediately (saves the wasted 400).
    const cap = getExtendedTaskFieldsCapability();
    let hasExtended = cap !== "absent";
    let taskRes;

    if (cap === "absent") {
      // Capability already known absent — go straight to core select.
      taskRes = await dvReq(
        {
          url:
            BASE +
            "/msdyn_projecttasks(" +
            taskId +
            ")?$select=" +
            CORE_SELECT +
            customSelectSuffix +
            EXPAND,
          method: "GET",
          headers: taskHeaders,
        },
        { retry: true },
      );
    } else {
      // "present" or "unknown": try with extended fields first.
      taskRes = await dvReq(
        {
          url:
            BASE +
            "/msdyn_projecttasks(" +
            taskId +
            ")?$select=" +
            CORE_SELECT +
            "," +
            EXTENDED_TASK_FIELDS +
            customSelectSuffix +
            EXPAND,
          method: "GET",
          headers: taskHeaders,
        },
        { retry: true },
      );
      // Distinguish "extended field missing" from "custom column missing" —
      // both produce the identical generic 400 shape, so the message's named
      // property decides which branch actually applies (see
      // isCustomColumnMissingError's doc comment for why this matters).
      const requestedCustomNames = [...customSelection.columns.keys()];
      const missingIsCustomColumn =
        customSelectSuffix && isCustomColumnMissingError(taskRes, requestedCustomNames);
      if (!missingIsCustomColumn && isMissingPropertyError(taskRes.status, dvErrorMessage(taskRes))) {
        // Extended fields absent on this tenant — record in the cache so
        // future calls (in this process) skip the probe entirely.
        setExtendedTaskFieldsCapability("absent");
        hasExtended = false;
        taskRes = await dvReq(
          {
            url:
              BASE +
              "/msdyn_projecttasks(" +
              taskId +
              ")?$select=" +
              CORE_SELECT +
              customSelectSuffix +
              EXPAND,
            method: "GET",
            headers: taskHeaders,
          },
          { retry: true },
        );
      } else if (taskRes.status < 400 && cap === "unknown") {
        // First successful extended read — record as present.
        setExtendedTaskFieldsCapability("present");
      }
    }
    // A custom column that was renamed/removed since discovery degrades to
    // core-only (reuses the same missing-property probe as the extended-field
    // capability check) rather than failing the whole read.
    if (customSelectSuffix && isCustomColumnMissingError(taskRes, [...customSelection.columns.keys()])) {
      warnings.push(
        "One or more requested custom columns are no longer present on this entity — falling back to core fields only.",
      );
      const coreOnlySelect =
        CORE_SELECT + (hasExtended ? "," + EXTENDED_TASK_FIELDS : "") + EXPAND;
      taskRes = await dvReq(
        {
          url: BASE + "/msdyn_projecttasks(" + taskId + ")?$select=" + coreOnlySelect,
          method: "GET",
          headers: dvHeaders(),
        },
        { retry: true },
      );
      customSelection.columns.clear();
    }
    if (taskRes.status >= 400)
      throw new Error("get_task failed (" + taskRes.status + "): " + dvErrorMessage(taskRes));
    const t = taskRes.json || {};
    const customFields = customSelection.columns.size
      ? deserializeCustomFields(customSelection, t)
      : undefined;

    // Dependencies in both directions (derived read-column names; degrade on 400).
    const predecessors: any[] = [];
    const successors: any[] = [];
    try {
      const depRes = await dvReq(
        {
          url:
            BASE +
            "/msdyn_projecttaskdependencies?$select=_msdyn_predecessortask_value," +
            "_msdyn_successortask_value,msdyn_projecttaskdependencylinktype,msdyn_projecttaskdependencylinklag" +
            "&$filter=_msdyn_predecessortask_value eq " +
            taskId +
            " or _msdyn_successortask_value eq " +
            taskId,
          method: "GET",
          headers: dvHeaders(),
        },
        { retry: true },
      );
      if (depRes.status >= 400) {
        warnings.push("Dependency links unavailable on this environment.");
      } else {
        for (const d of depRes.json?.value || []) {
          const link = {
            predecessorTaskId: d._msdyn_predecessortask_value,
            successorTaskId: d._msdyn_successortask_value,
            type: linkTypeLabel(d.msdyn_projecttaskdependencylinktype),
            lagMinutes: d.msdyn_projecttaskdependencylinklag ?? null,
          };
          if (String(d._msdyn_successortask_value).toLowerCase() === taskId.toLowerCase())
            predecessors.push(link);
          else successors.push(link);
        }
      }
    } catch (e) {
      warnings.push("Dependency read failed: " + (e instanceof Error ? e.message : String(e)));
    }

    // isSummary: a task is a summary (parent) if at least one other task names it as
    // its parent. A $top=1 child-check is the cheapest way to determine this for a
    // single task without fetching the whole plan.
    let isSummary = false;
    try {
      const childRes = await dvReq(
        {
          url:
            BASE +
            "/msdyn_projecttasks?$select=msdyn_projecttaskid" +
            "&$filter=_msdyn_parenttask_value eq " +
            taskId +
            "&$top=1",
          method: "GET",
          headers: dvHeaders(),
        },
        { retry: true },
      );
      if (childRes.status < 400) {
        isSummary = (childRes.json?.value?.length ?? 0) > 0;
      }
    } catch {
      // Non-fatal — isSummary stays false
    }

    // Resource assignments — expand the team member record for the display name.
    let assignments: any[] = [];
    try {
      const asgRes = await dvReq(
        {
          url:
            BASE +
            "/msdyn_resourceassignments?$select=msdyn_resourceassignmentid," +
            "_msdyn_taskid_value,_msdyn_projectteamid_value,_msdyn_projectid_value" +
            "&$expand=msdyn_projectteamid($select=msdyn_name)" +
            "&$filter=_msdyn_taskid_value eq " +
            taskId,
          method: "GET",
          headers: dvHeaders(),
        },
        { retry: true },
      );
      if (asgRes.status >= 400) {
        warnings.push("Resource assignments unavailable on this environment.");
      } else {
        assignments = (asgRes.json?.value || []).map((a: any) => ({
          assignmentId: a.msdyn_resourceassignmentid,
          teamMemberId: a._msdyn_projectteamid_value,
          name: a.msdyn_projectteamid?.msdyn_name ?? null,
        }));
      }
    } catch (e) {
      warnings.push("Assignment read failed: " + (e instanceof Error ? e.message : String(e)));
    }

    // Checklist items — child rows (degrade on 400 like dependencies/assignments).
    // Their ids/titles let update_tasks adjust or remove specific items later.
    let checklist: { id: string; title: string; completed: boolean }[] = [];
    try {
      const chkRes = await dvReq(
        {
          url:
            BASE +
            "/" +
            CHECKLIST_ENTITY_SET +
            "?$select=msdyn_projectchecklistid,msdyn_name,msdyn_projectchecklistcompleted" +
            "&$filter=" +
            CHECKLIST_TASK_LOOKUP_VALUE +
            " eq " +
            taskId +
            "&$top=200",
          method: "GET",
          headers: dvHeaders(),
        },
        { retry: true },
      );
      if (chkRes.status >= 400) {
        warnings.push("Checklist items unavailable on this environment.");
      } else {
        checklist = (chkRes.json?.value || []).map((c: any) => ({
          id: c.msdyn_projectchecklistid,
          title: c.msdyn_name ?? "",
          completed: c.msdyn_projectchecklistcompleted === true,
        }));
      }
    } catch (e) {
      warnings.push(
        "Checklist read failed: " + (e instanceof Error ? e.message : String(e)),
      );
    }

    return {
      ok: true,
      task: {
        taskId: t.msdyn_projecttaskid,
        subject: t.msdyn_subject,
        description: decodeDataverseText(t.msdyn_description),
        start: t.msdyn_start ?? null,
        finish: t.msdyn_finish ?? null,
        ...(hasExtended && {
          actualStart: t.msdyn_actualstart ?? null,
          actualFinish: t.msdyn_actualfinish ?? null,
          remainingEffortHours: t.msdyn_remainingeffort ?? null,
          durationHours: t.msdyn_duration ?? null,
        }),
        progressPercent:
          typeof t.msdyn_progress === "number" ? Math.round(t.msdyn_progress * 100) : null,
        effortHours: t.msdyn_effort ?? null,
        outlineLevel: t.msdyn_outlinelevel ?? null,
        displaySequence: t.msdyn_displaysequence ?? null,
        isMilestone: t.msdyn_ismilestone === true,
        isSummary,
        priority: t.msdyn_priority ?? null,
        bucketId: t._msdyn_projectbucket_value ?? null,
        bucketName: t.msdyn_projectbucket?.msdyn_name ?? null,
        parentTaskId: t._msdyn_parenttask_value ?? null,
        parentTaskSubject: t.msdyn_parenttask?.msdyn_subject ?? null,
        sprintId: t._msdyn_projectsprint_value ?? null,
        ...(customFields && { customFields }),
      },
      predecessors,
      successors,
      assignments,
      checklist,
      warnings,
    };
  },
};
