import { z } from "zod";
import { getApiBase } from "../config.js";
import { dvReq, dvErrorMessage, assertGuid, isGuid } from "../dataverse.js";
import {
  pageAll,
  readHeaders,
  nowIso,
  decodeDataverseText,
  clampLimit,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  type RawTask,
} from "./readHelpers.js";
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
    "Lists a plan's tasks filtered by 'all', 'overdue' or 'milestones', optionally scoped to one bucket. 'overdue' = leaf tasks past their finish date and under 100% (summary/parent tasks are excluded - their dates roll up from children). Returns up to `limit` tasks (default " +
    DEFAULT_PAGE_SIZE +
    ", max " +
    MAX_PAGE_SIZE +
    ") with a `nextPageToken` when more match - page through with pageToken to read them all without overloading context (totalMatched is the full match count). For efficient bulk paging of every task prefer get_plan_tasks_and_buckets. If truncated=true the underlying scan hit the 10,000-row cap and the list is incomplete.",
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
        "Max tasks to return in this page (default " +
          DEFAULT_PAGE_SIZE +
          ", max " +
          MAX_PAGE_SIZE +
          "). Page with pageToken.",
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
      // Extended fields (Project Operations-only; absent on basic tenants)
      ...(hasExtended && {
        remainingEffortHours: t.msdyn_remainingeffort ?? null,
        durationHours: t.msdyn_duration ?? null,
        actualStart: t.msdyn_actualstart ?? null,
        actualFinish: t.msdyn_actualfinish ?? null,
      }),
    }));

    // Bound the response to `limit` rows with an offset cursor. The internal scan
    // already read every matching row (needed for the overdue/summary logic); this
    // only caps what is RETURNED so the payload stays within the model's context
    // budget. pageToken is a private numeric offset, never a URL — SSRF-irrelevant.
    const limit = clampLimit(input.limit);
    let offset = 0;
    if (input.pageToken) {
      const raw = Buffer.from(input.pageToken, "base64url").toString("utf8");
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0 || n > 10_000_000)
        throw new Error("Invalid pageToken.");
      offset = n;
    }
    const pageTasks = tasks.slice(offset, offset + limit);
    const nextOffset = offset + limit;
    const nextPageToken =
      nextOffset < tasks.length
        ? Buffer.from(String(nextOffset), "utf8").toString("base64url")
        : undefined;

    return {
      ok: true,
      projectId,
      filter,
      count: pageTasks.length,
      totalMatched: tasks.length,
      pageLimit: limit,
      nextPageToken,
      truncated: paged.truncated,
      warnings: toolWarnings,
      tasks: pageTasks,
    };
  },
};
