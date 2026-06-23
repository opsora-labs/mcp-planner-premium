import { z } from "zod";
import { getApiBase } from "../config.js";
import { dvReq, dvErrorMessage, assertGuid, isGuid } from "../dataverse.js";
import {
  pageAll,
  readHeaders,
  nowIso,
  decodeDataverseText,
  clampLimit,
  SAFE_PAGE_SIZE,
  pageByOffset,
  type RawTask,
} from "./readHelpers.js";

/**
 * Per-row clip for a task's description in this LIST view: one giant note must
 * not blow the page budget on its own. The full text is always available via
 * get_task; a clipped row carries descriptionTruncated:true.
 */
const DESCRIPTION_PREVIEW_CHARS = 20_000;
import {
  getExtendedTaskFieldsCapability,
  setExtendedTaskFieldsCapability,
  isMissingPropertyError,
  EXTENDED_TASK_FIELDS,
} from "./capabilities.js";
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
  // Extended fields (Project Operations-only; may be absent)
  msdyn_remainingeffort?: number | null;
  msdyn_duration?: number | null;
  msdyn_actualstart?: string | null;
  msdyn_actualfinish?: string | null;
}

// Filtered task list for a plan. One scan, filtered client-side so 'overdue'
// can exclude summary (parent) tasks (whose rolled-up dates would create phantom
// overdues). Server-side OData has no isSummary flag, hence the client filter.
export const listPlanTasks: ToolDef = {
  name: "list_plan_tasks",
  title: "List Plan Tasks (filtered)",
  description:
    "Lists a plan's tasks WITH descriptions, filtered by 'all', 'overdue' or 'milestones', optionally scoped to one bucket. 'overdue' = leaf tasks past their finish date and under 100% (summary/parent tasks are excluded - their dates roll up from children). Size-capped: returns at most " +
    SAFE_PAGE_SIZE +
    " tasks per page AND shrinks the page further when notes are large, so each response stays under hosts' ~200k-char limit and is NEVER silently truncated; sets hasMore:true + a `nextPageToken` when more match — KEEP PAGING with pageToken until hasMore is false (totalMatched is the full match count). A very long description is clipped to a preview with descriptionTruncated:true — fetch the full text via get_task. For lean bulk paging of every task (no descriptions) prefer get_plan_tasks_and_buckets. To find only the tasks whose title or notes CONTAIN a given word, name or phrase, use search_plan_tasks instead of paging this list and grepping. If truncated=true the underlying scan hit the 10,000-row cap and the list is incomplete.",
  inputSchema: {
    projectId: z.string().describe("GUID of the plan (msdyn_projectid)."),
    filter: z
      .enum(["all", "overdue", "milestones"])
      .optional()
      .describe(
        "Which tasks to return: 'all', 'overdue' (leaf tasks past finish and under 100%, excludes summary tasks), or 'milestones'. Default 'all'.",
      ),
    bucketId: z.string().optional().describe("Optional bucketId GUID to scope to one bucket."),
    limit: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Max tasks to return in this page (default and max " +
          SAFE_PAGE_SIZE +
          "; larger values are capped, and the page may shrink further if notes are large). Page with pageToken until hasMore is false.",
      ),
    pageToken: z
      .string()
      .optional()
      .describe("Opaque cursor from a previous call's nextPageToken; omit for the first page."),
  },
  handler: async (input: {
    projectId: string;
    filter?: "all" | "overdue" | "milestones";
    bucketId?: string;
    limit?: number;
    pageToken?: string;
  }) => {
    const BASE = getApiBase();
    const projectId = assertGuid(input.projectId, "projectId");
    const filter = input.filter ?? "all";
    const bucketFilter = (input.bucketId || "").trim();
    if (bucketFilter && !isGuid(bucketFilter)) throw new Error("bucketId must be a GUID.");
    const toolWarnings: string[] = [];

    let odata = "_msdyn_project_value eq " + projectId;
    if (bucketFilter) odata += " and _msdyn_projectbucket_value eq " + bucketFilter;

    const CORE_SELECT =
      "msdyn_projecttaskid,msdyn_subject,msdyn_description," +
      "msdyn_start,msdyn_finish,msdyn_progress,msdyn_effort,msdyn_outlinelevel," +
      "msdyn_ismilestone,msdyn_priority,msdyn_displaysequence," +
      "_msdyn_projectbucket_value,_msdyn_parenttask_value,_msdyn_projectsprint_value";
    const EXPAND =
      "&$expand=msdyn_projectbucket($select=msdyn_name),msdyn_parenttask($select=msdyn_subject)";
    const filterAndOrder = "&$filter=" + odata + "&$orderby=msdyn_displaysequence asc";

    // Check the process-lifetime capability cache for extended fields.
    const cap = getExtendedTaskFieldsCapability();
    let hasExtended = cap !== "absent";
    let paged;

    if (cap === "absent") {
      // Known absent — go straight to core select.
      paged = await pageAll(
        BASE + "/msdyn_projecttasks?$select=" + CORE_SELECT + EXPAND + filterAndOrder,
        readHeaders(),
      );
    } else if (cap === "present") {
      // Known present — use extended select.
      paged = await pageAll(
        BASE +
          "/msdyn_projecttasks?$select=" +
          CORE_SELECT +
          "," +
          EXTENDED_TASK_FIELDS +
          EXPAND +
          filterAndOrder,
        readHeaders(),
      );
    } else {
      // Unknown — probe with a single first-page request including extended fields.
      const extUrl =
        BASE +
        "/msdyn_projecttasks?$select=" +
        CORE_SELECT +
        "," +
        EXTENDED_TASK_FIELDS +
        EXPAND +
        filterAndOrder;
      const probeRes = await dvReq({ url: extUrl, method: "GET", headers: readHeaders() }, { retry: true });

      if (isMissingPropertyError(probeRes.status, dvErrorMessage(probeRes))) {
        // Extended fields absent on this tenant — cache and retry with core only.
        setExtendedTaskFieldsCapability("absent");
        hasExtended = false;
        toolWarnings.push(
          "Extended scheduling fields (remaining effort, duration, actuals) are not available on this environment.",
        );
        paged = await pageAll(
          BASE + "/msdyn_projecttasks?$select=" + CORE_SELECT + EXPAND + filterAndOrder,
          readHeaders(),
        );
      } else if (probeRes.status >= 400) {
        throw new Error(
          "list_plan_tasks failed (" + probeRes.status + "): " + dvErrorMessage(probeRes),
        );
      } else {
        // Extended fields available — record and collect all pages.
        setExtendedTaskFieldsCapability("present");
        hasExtended = true;
        paged = await pageAll(extUrl, readHeaders());
      }
    }

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

    const tasks = filtered.map((t) => {
      const fullDescription = decodeDataverseText(t.msdyn_description);
      const descTruncated =
        typeof fullDescription === "string" && fullDescription.length > DESCRIPTION_PREVIEW_CHARS;
      return {
      taskId: t.msdyn_projecttaskid,
      subject: t.msdyn_subject,
      description: descTruncated
        ? fullDescription.slice(0, DESCRIPTION_PREVIEW_CHARS)
        : fullDescription,
      ...(descTruncated ? { descriptionTruncated: true } : {}),
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
      // Extended fields (Project Operations-only; absent on basic tenants)
      ...(hasExtended && {
        remainingEffortHours: t.msdyn_remainingeffort ?? null,
        durationHours: t.msdyn_duration ?? null,
        actualStart: t.msdyn_actualstart ?? null,
        actualFinish: t.msdyn_actualfinish ?? null,
      }),
      };
    });

    // Bound the response to `limit` rows with an offset cursor. The internal scan
    // already read every matching row (needed for the overdue/summary logic); this
    // only caps what is RETURNED so the payload stays within the model's context
    // budget. pageToken is a private numeric offset, never a URL — SSRF-irrelevant.
    const limit = Math.min(clampLimit(input.limit), SAFE_PAGE_SIZE);
    // Byte-budget the page via a short offset cursor: even within the row cap,
    // large task notes can push a response past a host's ~200k-char limit. The
    // cursor advances by exactly what we return, so nothing is dropped.
    const page = pageByOffset(tasks, limit, input.pageToken);
    const pageTasks = page.items;
    const nextPageToken = page.nextPageToken;
    const hasMore = page.hasMore;
    if (hasMore && !page.fits)
      toolWarnings.push(
        "This page was reduced to stay within the host response-size limit (large task notes); more tasks remain - page with pageToken.",
      );

    return {
      ok: true,
      projectId,
      filter,
      count: pageTasks.length,
      totalMatched: tasks.length,
      pageLimit: limit,
      hasMore,
      nextPageToken,
      ...(hasMore
        ? {
            note:
              "Incomplete: returned " +
              pageTasks.length +
              " of " +
              tasks.length +
              " matching tasks. Call list_plan_tasks again with this pageToken (same projectId/filter) and keep paging until hasMore is false before claiming you have them all.",
          }
        : {}),
      truncated: paged.truncated,
      warnings: toolWarnings,
      tasks: pageTasks,
    };
  },
};
