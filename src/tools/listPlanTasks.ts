import { z } from "zod";
import { getApiBase } from "../config.js";
import { assertGuid, isGuid } from "../dataverse.js";
import { pageAll, readHeaders, nowIso, decodeDataverseText, type RawTask } from "./readHelpers.js";
import type { ToolDef } from "./types.js";

interface FullTask extends RawTask {
  msdyn_start?: string | null;
  msdyn_description?: string | null;
  msdyn_outlinelevel?: number | null;
  msdyn_displaysequence?: number | null;
  msdyn_priority?: number | null;
  msdyn_effort?: number | null;
  _msdyn_projectbucket_value?: string | null;
  _msdyn_projectsprint_value?: string | null;
  msdyn_projectbucket?: { msdyn_name?: string } | null;
  msdyn_parenttask?: { msdyn_subject?: string } | null;
}

// Filtered task list for a plan. One scan, filtered client-side so 'overdue'
// can exclude summary (parent) tasks (whose rolled-up dates would create phantom
// overdues). Server-side OData has no isSummary flag, hence the client filter.
export const listPlanTasks: ToolDef = {
  name: "list_plan_tasks",
  title: "List Plan Tasks (filtered)",
  description:
    "Lists a plan's tasks filtered by 'all', 'overdue' or 'milestones', optionally scoped to one bucket. 'overdue' = leaf tasks past their finish date and under 100% (summary/parent tasks are excluded - their dates roll up from children). For the full task+bucket dump use get_plan_tasks_and_buckets. If truncated=true the list is incomplete.",
  inputSchema: {
    projectId: z.string().describe("GUID of the plan (msdyn_projectid)."),
    filter: z
      .enum(["all", "overdue", "milestones"])
      .optional()
      .describe(
        "Which tasks to return: 'all', 'overdue' (leaf tasks past finish and under 100%, excludes summary tasks), or 'milestones'. Default 'all'.",
      ),
    bucketId: z.string().optional().describe("Optional bucketId GUID to scope to one bucket."),
  },
  handler: async (input: {
    projectId: string;
    filter?: "all" | "overdue" | "milestones";
    bucketId?: string;
  }) => {
    const BASE = getApiBase();
    const projectId = assertGuid(input.projectId, "projectId");
    const filter = input.filter ?? "all";
    const bucketFilter = (input.bucketId || "").trim();
    if (bucketFilter && !isGuid(bucketFilter)) throw new Error("bucketId must be a GUID.");

    let odata = "_msdyn_project_value eq " + projectId;
    if (bucketFilter) odata += " and _msdyn_projectbucket_value eq " + bucketFilter;

    const url =
      BASE +
      "/msdyn_projecttasks?$select=msdyn_projecttaskid,msdyn_subject,msdyn_description," +
      "msdyn_start,msdyn_finish,msdyn_progress,msdyn_effort,msdyn_outlinelevel," +
      "msdyn_ismilestone,msdyn_priority,msdyn_displaysequence," +
      "_msdyn_projectbucket_value,_msdyn_parenttask_value,_msdyn_projectsprint_value" +
      "&$expand=msdyn_projectbucket($select=msdyn_name),msdyn_parenttask($select=msdyn_subject)" +
      "&$filter=" +
      odata +
      "&$orderby=msdyn_displaysequence asc";
    const paged = await pageAll(url, readHeaders());
    const rows = paged.rows as FullTask[];

    // Summary set for the overdue exclusion.
    const summaryIds = new Set<string>();
    for (const t of rows) {
      const p = t._msdyn_parenttask_value;
      if (p) summaryIds.add(String(p).toLowerCase());
    }
    const nowMs = new Date(nowIso()).getTime();

    let filtered = rows;
    if (filter === "milestones") {
      filtered = rows.filter((t) => t.msdyn_ismilestone === true);
    } else if (filter === "overdue") {
      filtered = rows.filter(
        (t) =>
          !summaryIds.has(String(t.msdyn_projecttaskid).toLowerCase()) &&
          t.msdyn_finish &&
          new Date(t.msdyn_finish).getTime() < nowMs &&
          typeof t.msdyn_progress === "number" &&
          t.msdyn_progress < 1,
      );
    }

    const tasks = filtered.map((t) => ({
      taskId: t.msdyn_projecttaskid,
      subject: t.msdyn_subject,
      description: decodeDataverseText(t.msdyn_description),
      start: t.msdyn_start ?? null,
      finish: t.msdyn_finish ?? null,
      progressPercent:
        typeof t.msdyn_progress === "number" ? Math.round(t.msdyn_progress * 100) : null,
      effortHours: t.msdyn_effort ?? null,
      outlineLevel: t.msdyn_outlinelevel ?? null,
      displaySequence: t.msdyn_displaysequence ?? null,
      priority: t.msdyn_priority ?? null,
      isMilestone: t.msdyn_ismilestone === true,
      isSummary: summaryIds.has(String(t.msdyn_projecttaskid).toLowerCase()),
      bucketId: t._msdyn_projectbucket_value ?? null,
      bucketName: t.msdyn_projectbucket?.msdyn_name ?? null,
      parentTaskId: t._msdyn_parenttask_value ?? null,
      parentTaskSubject: t.msdyn_parenttask?.msdyn_subject ?? null,
      sprintId: t._msdyn_projectsprint_value ?? null,
    }));

    return {
      ok: true,
      projectId,
      filter,
      count: tasks.length,
      truncated: paged.truncated,
      tasks,
    };
  },
};
