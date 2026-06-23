import { z } from "zod";
import { getApiBase } from "../config.js";
import { dvReq, dvHeaders, dvErrorMessage, isGuid } from "../dataverse.js";
import { tasksForResourceIds, paginateAssignedTasks } from "./taskAssignments.js";
import { SAFE_PAGE_SIZE } from "./readHelpers.js";
import type { ToolDef } from "./types.js";

// The current user's task assignments across ALL their plans (or one plan).
// Identity chain: WhoAmI -> bookable resource (links the user) -> project-team
// memberships -> resource assignments -> tasks. 'overdue'/'active' exclude
// summary (parent) tasks, whose dates roll up from their children.
export const listMyTasks: ToolDef = {
  name: "list_my_tasks",
  title: "List My Tasks",
  description:
    "Returns the SIGNED-IN user's assigned tasks across all their plans (or one plan via projectId). filter: 'all', 'overdue' (past finish and under 100%), or 'active' (not yet complete). Pass bucketId to get only my tasks in one bucket in a single call. Resolves 'me' automatically via WhoAmI → the user's Project bookable resource → project-team memberships → resource assignments, so you do NOT pass a user id. Summary (parent) tasks are excluded from 'overdue'/'active' (their dates roll up from children). Each task includes its plan name, bucketId, bucket name, finish date and % complete. Size-capped: returns at most " + SAFE_PAGE_SIZE + " tasks per page and sets hasMore:true + a nextPageToken when more remain (totalCount is the full match count) — page with pageToken until hasMore is false before counting or summarising. Returns count 0 with a note if the user is not a Project resource or has no assignments.",
  inputSchema: {
    filter: z
      .enum(["all", "overdue", "active"])
      .optional()
      .describe("Which of my tasks: 'all', 'overdue' (past finish, <100%), or 'active' (<100%). Default 'overdue'."),
    projectId: z
      .string()
      .optional()
      .describe("Optional plan GUID to scope to a single plan. Omit to span all my plans."),
    bucketId: z
      .string()
      .optional()
      .describe(
        "Optional bucketId GUID — return only my tasks in that one bucket. Resolve a bucket NAME to its id with get_plan_tasks_and_buckets or get_bucket_breakdown first.",
      ),
    limit: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Max tasks to return in this page (default and max " +
          SAFE_PAGE_SIZE +
          "). Page with pageToken until hasMore is false.",
      ),
    pageToken: z
      .string()
      .optional()
      .describe("Opaque cursor from a previous call's nextPageToken; omit for the first page."),
  },
  handler: async (input: {
    filter?: "all" | "overdue" | "active";
    projectId?: string;
    bucketId?: string;
    limit?: number;
    pageToken?: string;
  }) => {
    const BASE = getApiBase();
    const filter = input.filter ?? "overdue";
    const scopeProject = (input.projectId || "").trim();
    if (scopeProject && !isGuid(scopeProject)) throw new Error("projectId must be a GUID.");
    const bucketId = (input.bucketId || "").trim();
    if (bucketId && !isGuid(bucketId)) throw new Error("bucketId must be a GUID.");

    // 1. Who am I.
    const who = await dvReq(
      { url: BASE + "/WhoAmI", method: "GET", headers: dvHeaders() },
      { retry: true },
    );
    if (who.status >= 400)
      throw new Error("list_my_tasks: WhoAmI failed (" + who.status + "): " + dvErrorMessage(who));
    const userId: string | undefined = who.json?.UserId;
    if (!userId) throw new Error("list_my_tasks: WhoAmI returned no UserId.");

    const empty = (note: string) => ({ ok: true, userId, filter, count: 0, tasks: [], note });

    // 2. The user's bookable resource(s).
    const brRes = await dvReq(
      {
        url:
          BASE +
          "/bookableresources?$select=bookableresourceid&$filter=_userid_value eq " +
          userId +
          "&$top=50",
        method: "GET",
        headers: dvHeaders(),
      },
      { retry: true },
    );
    if (brRes.status >= 400)
      throw new Error("list_my_tasks: bookable-resource lookup failed (" + brRes.status + "): " + dvErrorMessage(brRes));
    const resourceIds = (brRes.json?.value || []).map((r: any) => r.bookableresourceid).filter(Boolean);
    if (resourceIds.length === 0)
      return empty("You are not a Project bookable resource, so you have no task assignments.");

    // 3-6. Shared chain: team memberships → assignments → tasks → summary-aware filter.
    const result = await tasksForResourceIds(BASE, resourceIds, filter, scopeProject, bucketId);
    if (result.note) return empty(result.note);
    const page = paginateAssignedTasks(result, input.limit, input.pageToken);
    return {
      ok: true,
      userId,
      filter,
      ...(bucketId ? { bucketId } : {}),
      pageLimit: page.pageLimit,
      count: page.count,
      totalCount: page.totalCount,
      hasMore: page.hasMore,
      ...(page.nextPageToken ? { nextPageToken: page.nextPageToken } : {}),
      ...(page.note ? { note: page.note } : {}),
      ...(page.warnings ? { warnings: page.warnings } : {}),
      tasks: page.tasks,
    };
  },
};
