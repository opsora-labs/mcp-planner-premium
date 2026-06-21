import { z } from "zod";
import { getApiBase } from "../config.js";
import { assertGuid, isGuid } from "../dataverse.js";
import {
  pageAll,
  readHeaders,
  pageOnce,
  clampLimit,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
} from "./readHelpers.js";
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
    "Returns a plan's buckets and a PAGE of its tasks (ordered as displayed): id, name, dates, progress, effort, outline level, bucket, plus parentTaskId, isMilestone and isSummary flags, and summaryTaskIds (the ids of all summary/parent tasks, complete even across pages). Bounded for large plans: returns up to `limit` tasks (default " +
    DEFAULT_PAGE_SIZE +
    ", max " +
    MAX_PAGE_SIZE +
    ") and a `nextPageToken` when more remain — pass it back as `pageToken` to get the next page. A plan with ≤ limit tasks returns everything in one page (no token). On very large plans use a smaller `limit` (e.g. 100-200) and/or `bucketId` to keep the response within the model's context budget; or use get_plan_summary / get_bucket_breakdown for counts only. Summary task dates, effort and progress are ROLLED UP from children and MUST NOT be written to - pass summaryTaskIds to update_tasks / update_tasks_batch (or just pass projectId to update_tasks, which auto-protects them). The returned task/plan 'progress' is a 0-1 fraction (0.5 = 50%). If truncated=true an internal scan hit the 10,000-row cap and summaryTaskIds may be incomplete.",
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
        "Max tasks to return in this page (default " +
          DEFAULT_PAGE_SIZE +
          ", max " +
          MAX_PAGE_SIZE +
          "). Use a smaller value (e.g. 100-200) on large plans to bound the response size; page through with pageToken.",
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
    const limit = clampLimit(input.limit);
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

    // One bounded page of full task rows.
    const page = await pageOnce(tasksUrl, limit, pageToken);
    const pageRows = page.rows;

    // Summary set. When the whole plan fits in this single page (no token in,
    // no token out) compute it from the page — one query, same as before. When
    // paginating, run a lightweight id+parent scan of the WHOLE plan so isSummary
    // and summaryTaskIds are complete even though we return only one page.
    let summarySet: Set<string>;
    let summaryScanTruncated = false;
    if (!pageToken && !page.nextPageToken) {
      summarySet = parentIdSet(pageRows);
    } else {
      const scanUrl =
        BASE +
        "/msdyn_projecttasks?$select=msdyn_projecttaskid,_msdyn_parenttask_value&$filter=" +
        taskFilter;
      const scan = await pageAll(scanUrl, readHeaders());
      summaryScanTruncated = scan.truncated;
      summarySet = parentIdSet(scan.rows);
    }

    const tasks = pageRows.map((t: any) => {
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
    // complete across pages (built from the page or the full id+parent scan).
    const summaryTaskIds = [...summarySet];

    return {
      ok: true,
      projectId: projectId,
      truncated: bucketsPaged.truncated || summaryScanTruncated,
      pageLimit: limit,
      nextPageToken: page.nextPageToken,
      buckets: bucketsPaged.rows.map((b: any) => ({
        bucketId: b.msdyn_projectbucketid,
        name: b.msdyn_name,
      })),
      taskCount: tasks.length,
      summaryTaskIds: summaryTaskIds,
      tasks: tasks,
    };
  },
};
