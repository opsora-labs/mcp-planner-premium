import { z } from "zod";
import { getApiBase } from "../config.js";
import { assertGuid, isGuid } from "../dataverse.js";
import { pageAll, readHeaders, pageByOffset, clampLimit, SAFE_PAGE_SIZE } from "./readHelpers.js";
import type { ToolDef } from "./types.js";

/** A task is a summary if some other task names it as its parent. */
function parentIdSet(rows: any[]): Set<string> {
  const s = new Set<string>();
  for (const r of rows) {
    const p = r._msdyn_parenttask_value;
    if (p) s.add(String(p).toLowerCase());
  }
  return s;
}

// Get Plan Contents - narrow read: buckets + tasks of ONE plan (cursor-paginated)
// for verification. Returns parentTaskId / isMilestone / isSummary plus a
// summaryTaskIds array so callers can protect rolled-up fields. Summary (parent)
// task dates/effort/progress roll up from children and MUST NOT be written to.
export const getPlanContents: ToolDef = {
  name: "get_plan_tasks_and_buckets",
  title: "Get Plan Tasks & Buckets",
  description:
    "Returns a plan's buckets and a PAGE of its tasks (ordered as displayed): id, name, dates, progress, effort, outline level, bucket, plus parentTaskId, isMilestone and isSummary flags, and summaryTaskIds (the ids of all summary/parent tasks, complete even across pages). Size-capped for large plans: returns at most " +
    SAFE_PAGE_SIZE +
    " tasks per page (each response is kept under hosts' ~200k-char limit so it is NEVER silently truncated) and sets hasMore:true + a `nextPageToken` when more remain — pass the token back as `pageToken` and KEEP PAGING until hasMore is false before treating the plan as complete. A plan with ≤ " +
    SAFE_PAGE_SIZE +
    " tasks returns everything in one page (no token). Use `bucketId` to narrow to one bucket, or get_plan_summary / get_bucket_breakdown for counts only. Summary task dates, effort and progress are ROLLED UP from children and MUST NOT be written to - pass summaryTaskIds to update_tasks / update_tasks_batch (or just pass projectId to update_tasks, which auto-protects them). The returned task/plan 'progress' is a 0-1 fraction (0.5 = 50%). If truncated=true an internal scan hit the 10,000-row cap and summaryTaskIds may be incomplete. To find tasks whose title or notes CONTAIN a given word, name or phrase, use search_plan_tasks instead of paging all tasks and grepping.",
  inputSchema: {
    projectId: z.string().describe("GUID of the plan (msdyn_projectid)."),
    bucketId: z
      .string()
      .optional()
      .describe(
        "Optional bucketId GUID. If given, only that bucket's tasks are returned - use it to narrow large plans and keep the response within the model's context budget.",
      ),
    limit: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Max tasks to return in this page (default and max " +
          SAFE_PAGE_SIZE +
          "; larger values are capped to keep the response under the host size limit). Page through with pageToken until hasMore is false.",
      ),
    pageToken: z
      .string()
      .optional()
      .describe(
        "Opaque continuation token from a previous call's nextPageToken. Omit for the first page. It is a cursor only - it never changes which plan or fields are read.",
      ),
  },
  handler: async (input: {
    projectId: string;
    bucketId?: string;
    limit?: number;
    pageToken?: string;
  }) => {
    const BASE = getApiBase();

    const projectId = assertGuid(input.projectId, "projectId");
    const bucketFilter = (input.bucketId || "").trim();
    if (bucketFilter && !isGuid(bucketFilter)) throw new Error("bucketId must be a GUID.");
    // Cap by a size-safe row count so the response stays under a host's ~200k
    // char limit even if the caller asks for more; page through with pageToken.
    const limit = Math.min(clampLimit(input.limit), SAFE_PAGE_SIZE);
    const pageToken = input.pageToken;

    // Buckets rarely paginate (one small internal scan).
    const bucketsUrl =
      BASE +
      "/msdyn_projectbuckets?$select=msdyn_projectbucketid,msdyn_name" +
      "&$filter=_msdyn_project_value eq " +
      projectId +
      "&$top=200";
    const bucketsPaged = await pageAll(bucketsUrl, readHeaders());

    const taskFilter =
      "_msdyn_project_value eq " +
      projectId +
      (bucketFilter ? " and _msdyn_projectbucket_value eq " + bucketFilter : "");
    const SELECT =
      "msdyn_projecttaskid,msdyn_subject,msdyn_start,msdyn_finish,msdyn_progress,msdyn_effort," +
      "msdyn_outlinelevel,msdyn_displaysequence,_msdyn_projectbucket_value,_msdyn_parenttask_value,msdyn_ismilestone";
    const tasksUrl =
      BASE +
      "/msdyn_projecttasks?$select=" +
      SELECT +
      "&$filter=" +
      taskFilter +
      "&$orderby=msdyn_displaysequence asc";

    // Read EVERY matching task row once (server-side paged, hard-capped at 10k).
    // This single scan yields BOTH the page we return AND the complete summary
    // set, so isSummary/summaryTaskIds stay correct across pages — and it lets us
    // hand the model a SHORT numeric-offset cursor instead of a long Dataverse
    // $skiptoken, which MCP hosts truncate/corrupt when the model echoes it back.
    const paged = await pageAll(tasksUrl, readHeaders());
    const allRows = paged.rows;
    const summarySet = parentIdSet(allRows);

    const allTasks = allRows.map((t: any) => {
      const id = t.msdyn_projecttaskid;
      return {
        taskId: id,
        subject: t.msdyn_subject,
        start: t.msdyn_start,
        finish: t.msdyn_finish,
        progress: t.msdyn_progress,
        effortHours: t.msdyn_effort,
        outlineLevel: t.msdyn_outlinelevel,
        bucketId: t._msdyn_projectbucket_value,
        parentTaskId: t._msdyn_parenttask_value || null,
        isMilestone: t.msdyn_ismilestone === true,
        isSummary: summarySet.has(String(id).toLowerCase()),
      };
    });

    // A parent-value id is, by definition, a summary task's id. This list is
    // complete across pages (built from the full scan above).
    const summaryTaskIds = [...summarySet];

    // Return ONE host-safe page via a short, model-friendly offset cursor.
    const page = pageByOffset(allTasks, limit, pageToken);
    const tasks = page.items;
    const hasMore = page.hasMore;
    return {
      ok: true,
      projectId: projectId,
      truncated: bucketsPaged.truncated || paged.truncated,
      pageLimit: limit,
      hasMore: hasMore,
      nextPageToken: page.nextPageToken,
      ...(hasMore
        ? {
            note:
              "Incomplete: returned " +
              tasks.length +
              " of " +
              allTasks.length +
              " tasks. Call get_plan_tasks_and_buckets again with this pageToken and keep paging until hasMore is false before treating the task list as complete.",
          }
        : {}),
      buckets: bucketsPaged.rows.map((b: any) => ({
        bucketId: b.msdyn_projectbucketid,
        name: b.msdyn_name,
      })),
      taskCount: tasks.length,
      totalTaskCount: allTasks.length,
      summaryTaskIds: summaryTaskIds,
      tasks: tasks,
    };
  },
};
