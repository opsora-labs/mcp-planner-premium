import { z } from "zod";
import { getApiBase } from "../config.js";
import { dvReq, dvHeaders, dvErrorMessage, assertGuid } from "../dataverse.js";
import { pageAll, readHeaders, summariseTasks, nowIso, type RawTask } from "./readHelpers.js";
import type { ToolDef } from "./types.js";

// Plan-level reporting rollup. Reads the plan's server-computed rollups plus a
// summary-aware pass over its tasks (counts + overdue on LEAF tasks only).
export const getPlanSummary: ToolDef = {
  name: "get_plan_summary",
  title: "Get Plan Summary",
  description:
    "Returns a reporting rollup for one plan: name, dates, % complete, effort (total/completed/remaining), and task counts (total, leaf, summary, milestones, overdue-leaf). Overdue counts LEAF tasks only (summary tasks roll up from children). progressPercent is 0-100. On environments without msdyn_effortremaining, effortRemainingHours is returned null with a note in warnings[]. NOTE: for verifying a write you just made, prefer an independent read path - this is for reporting/exploration. If truncated=true the task scan was incomplete.",
  inputSchema: {
    projectId: z.string().describe("GUID of the plan (msdyn_projectid)."),
  },
  handler: async (input: { projectId: string }) => {
    const BASE = getApiBase();
    const projectId = assertGuid(input.projectId, "projectId");
    const warnings: string[] = [];

    // Plan rollup row. msdyn_effortremaining is environment-dependent: try it,
    // degrade to the proven field set on 400.
    const fullSelect =
      "msdyn_subject,msdyn_description,msdyn_scheduledstart,msdyn_finish,msdyn_progress," +
      "msdyn_effort,msdyn_effortcompleted,msdyn_effortremaining,modifiedon";
    const baseSelect =
      "msdyn_subject,msdyn_description,msdyn_scheduledstart,msdyn_finish,msdyn_progress," +
      "msdyn_effort,msdyn_effortcompleted,modifiedon";
    let planRes = await dvReq(
      {
        url: BASE + "/msdyn_projects(" + projectId + ")?$select=" + fullSelect,
        method: "GET",
        headers: dvHeaders(),
      },
      { retry: true },
    );
    if (planRes.status >= 400) {
      warnings.push("msdyn_effortremaining not available on this environment - omitted.");
      planRes = await dvReq(
        {
          url: BASE + "/msdyn_projects(" + projectId + ")?$select=" + baseSelect,
          method: "GET",
          headers: dvHeaders(),
        },
        { retry: true },
      );
    }
    if (planRes.status >= 400)
      throw new Error(
        "get_plan_summary failed (" + planRes.status + "): " + dvErrorMessage(planRes),
      );
    const p = planRes.json || {};

    // Summary-aware task counts (one paginated scan). msdyn_outlinelevel is included
    // so we can surface the plan's current max nesting depth alongside the counts.
    const tasksUrl =
      BASE +
      "/msdyn_projecttasks?$select=msdyn_projecttaskid,msdyn_ismilestone,msdyn_finish," +
      "msdyn_progress,_msdyn_parenttask_value,msdyn_outlinelevel&$filter=_msdyn_project_value eq " +
      projectId;
    const paged = await pageAll(tasksUrl, readHeaders());
    if (paged.truncated)
      warnings.push("Task scan hit the page cap - counts are a lower bound.");
    const rollup = summariseTasks(paged.rows as RawTask[], nowIso());
    const currentMaxOutlineLevel = paged.rows.reduce(
      (max: number, r: any) => Math.max(max, typeof r.msdyn_outlinelevel === "number" ? r.msdyn_outlinelevel : 0),
      0,
    );

    return {
      ok: true,
      projectId,
      name: p.msdyn_subject,
      description: p.msdyn_description ?? null,
      start: p.msdyn_scheduledstart ?? null,
      finish: p.msdyn_finish ?? null,
      progressPercent:
        typeof p.msdyn_progress === "number" ? Math.round(p.msdyn_progress * 100) : null,
      effortHours: p.msdyn_effort ?? null,
      effortCompletedHours: p.msdyn_effortcompleted ?? null,
      effortRemainingHours: p.msdyn_effortremaining ?? null,
      totalTasks: rollup.totalTasks,
      leafTaskCount: rollup.leafTaskCount,
      summaryTaskCount: rollup.summaryTaskCount,
      milestoneCount: rollup.milestoneCount,
      overdueLeafTaskCount: rollup.overdueLeafTaskCount,
      planLimits: {
        currentMaxOutlineLevel,
        totalTasks: rollup.totalTasks,
        note: "PSS enforces a plan-wide task nesting limit (exact value unconfirmed, ~10). If apply_changes fails with TASK_LEVEL_LIMIT_EXCEEDED, reduce hierarchy depth or create a new plan.",
      },
      modifiedOn: p.modifiedon,
      truncated: paged.truncated,
      warnings,
    };
  },
};
