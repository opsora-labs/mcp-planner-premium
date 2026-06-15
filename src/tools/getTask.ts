import { z } from "zod";
import { getApiBase } from "../config.js";
import { dvReq, dvHeaders, dvErrorMessage, assertGuid } from "../dataverse.js";
import { linkTypeLabel } from "./readHelpers.js";
import type { ToolDef } from "./types.js";

// One task in full, including its dependency links and resource assignments.
// The dependency/assignment read-column names are DERIVED from the verified
// write binds (no public entity-reference page exists), so those sub-reads
// degrade to a warning on 400 rather than failing the whole tool.
export const getTask: ToolDef = {
  name: "get_task",
  title: "Get Task",
  description:
    "Returns full detail for one task by GUID: dates (scheduled + actual), effort, remaining effort, duration, % complete, milestone flag, outline level, display sequence, bucket (id + name), parent (id + subject), sprint id, priority, description, plus predecessor/successor dependency links and resource assignments (with member name). Dependency and assignment data may be omitted (with a warning) on environments where those columns differ - the core task fields always return.",
  inputSchema: {
    taskId: z.string().describe("GUID of the task (msdyn_projecttaskid)."),
  },
  handler: async (input: { taskId: string }) => {
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
    // Gracefully absent on basic Planner Premium tenants.
    const EXTENDED_FIELDS = "msdyn_remainingeffort,msdyn_duration,msdyn_actualstart,msdyn_actualfinish";
    const EXPAND =
      "&$expand=msdyn_projectbucket($select=msdyn_name),msdyn_parenttask($select=msdyn_subject)";

    // Try with extended fields first; on any "Could not find a property" 400,
    // drop all extended fields and retry with core only. One retry covers any
    // combination of missing fields without needing per-field probes.
    let hasExtended = true;
    let taskRes = await dvReq(
      {
        url:
          BASE +
          "/msdyn_projecttasks(" +
          taskId +
          ")?$select=" +
          CORE_SELECT +
          "," +
          EXTENDED_FIELDS +
          EXPAND,
        method: "GET",
        headers: dvHeaders(),
      },
      { retry: true },
    );
    if (taskRes.status === 400 && /could not find a property named/i.test(dvErrorMessage(taskRes))) {
      hasExtended = false;
      taskRes = await dvReq(
        {
          url: BASE + "/msdyn_projecttasks(" + taskId + ")?$select=" + CORE_SELECT + EXPAND,
          method: "GET",
          headers: dvHeaders(),
        },
        { retry: true },
      );
    }
    if (taskRes.status >= 400)
      throw new Error("get_task failed (" + taskRes.status + "): " + dvErrorMessage(taskRes));
    const t = taskRes.json || {};

    // Dependencies in both directions (derived read-column names; degrade on 400).
    const predecessors: any[] = [];
    const successors: any[] = [];
    try {
      const depRes = await dvReq(
        {
          url:
            BASE +
            "/msdyn_projecttaskdependency?$select=_msdyn_predecessortask_value," +
            "_msdyn_successortask_value,msdyn_projecttaskdependencylinktype,msdyn_linklagduration" +
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
            lagMinutes: d.msdyn_linklagduration ?? null,
          };
          if (String(d._msdyn_successortask_value).toLowerCase() === taskId.toLowerCase())
            predecessors.push(link);
          else successors.push(link);
        }
      }
    } catch (e) {
      warnings.push("Dependency read failed: " + (e instanceof Error ? e.message : String(e)));
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

    return {
      ok: true,
      task: {
        taskId: t.msdyn_projecttaskid,
        subject: t.msdyn_subject,
        description: t.msdyn_description ?? null,
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
        priority: t.msdyn_priority ?? null,
        bucketId: t._msdyn_projectbucket_value ?? null,
        bucketName: t.msdyn_projectbucket?.msdyn_name ?? null,
        parentTaskId: t._msdyn_parenttask_value ?? null,
        parentTaskSubject: t.msdyn_parenttask?.msdyn_subject ?? null,
        sprintId: t._msdyn_projectsprint_value ?? null,
      },
      predecessors,
      successors,
      assignments,
      warnings,
    };
  },
};
