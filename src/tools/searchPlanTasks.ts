import { z } from "zod";
import { getApiBase } from "../config.js";
import { dvReq, dvErrorMessage, assertGuid } from "../dataverse.js";
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
import {
  getExtendedTaskFieldsCapability,
  setExtendedTaskFieldsCapability,
  isMissingPropertyError,
  EXTENDED_TASK_FIELDS,
} from "./capabilities.js";
import type { ToolDef } from "./types.js";

/** Per-row clip for a task's description in this search view (mirrors list_plan_tasks). */
const DESCRIPTION_PREVIEW_CHARS = 20_000;

/** Bounds on the query so the OData filter URL stays well within Dataverse limits. */
const MAX_QUERY_CHARS = 512;
const MAX_QUERY_TERMS = 25;

export type SearchFields = "both" | "subject" | "description";

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

/**
 * Pure builder for the Dataverse $filter that scopes a search to ONE plan and a
 * case-insensitive substring over the task title and/or notes.
 *
 * `query` may be a single string OR an array of terms — an array matches tasks
 * containing ANY of the terms (OR), so a "find tasks mentioning A or B" search is
 * one server call. This deliberately replaces client-side grep ALTERNATION,
 * which is unreliable on some MCP hosts (e.g. Langdock treats a `\|` OR pattern
 * as a literal, so a multi-term grep silently matches nothing).
 *
 * Single quotes in each term are doubled (the OData literal escape) and the value
 * is then percent-encoded, exactly as list_plans / find_plan_by_name do — so a
 * term can never break out of the contains('...') literal. Throws on an empty
 * query or limit breaches. Returns the ready-to-embed $filter, the normalised
 * terms actually searched, and any caveat warnings.
 */
export function buildSearchFilter(
  projectId: string,
  query: string | string[],
  fields: SearchFields = "both",
): { filter: string; warnings: string[]; terms: string[] } {
  const terms = (Array.isArray(query) ? query : [query])
    .map((t) => (t ?? "").trim())
    .filter((t) => t.length > 0);
  if (terms.length === 0) throw new Error("query is required (text to search for).");
  if (terms.length > MAX_QUERY_TERMS)
    throw new Error("too many query terms (max " + MAX_QUERY_TERMS + "); narrow your search.");
  for (const t of terms)
    if (t.length > MAX_QUERY_CHARS)
      throw new Error("a query term is too long (max " + MAX_QUERY_CHARS + " characters).");

  const warnings: string[] = [];
  // Notes are stored HTML-entity-encoded (& " ' < > → &amp; &quot; …) and the
  // server-side contains() runs against that stored form, so a term containing one
  // of those characters may miss the human-readable text the user sees.
  if (terms.some((t) => /["&'<>]/.test(t)))
    warnings.push(
      "A query term contains a character Dataverse stores HTML-entity-encoded (\" & ' < >); server-side matches against task notes may miss occurrences - try a plain-text fragment.",
    );

  const predFor = (t: string): string => {
    const q = encodeURIComponent(t.replace(/'/g, "''"));
    const subjPred = "contains(msdyn_subject,'" + q + "')";
    const descPred = "contains(msdyn_description,'" + q + "')";
    return fields === "subject"
      ? subjPred
      : fields === "description"
        ? descPred
        : "(" + subjPred + " or " + descPred + ")";
  };
  const textPred =
    terms.length === 1 ? predFor(terms[0]) : "(" + terms.map(predFor).join(" or ") + ")";
  const filter = "_msdyn_project_value eq " + projectId + " and " + textPred;
  return { filter, warnings, terms };
}

/**
 * Search a plan's tasks by free text, server-side. Pushes an OData contains()
 * filter to Dataverse so only matching rows return — turning a "find tasks that
 * mention X" question from a full-plan scan + client-side grep into one (or a few
 * paged) calls. Result shape mirrors list_plan_tasks so callers can reuse it.
 */
export const searchPlanTasks: ToolDef = {
  name: "search_plan_tasks",
  title: "Search Plan Tasks (text)",
  description:
    "Server-side TEXT SEARCH within ONE plan: returns only the tasks whose title (msdyn_subject) and/or notes (msdyn_description) CONTAIN the query, by pushing an OData contains() filter to Dataverse. Use THIS to find tasks that mention a word, name, date or phrase (e.g. a person's name in the notes) - do NOT page through get_plan_tasks_and_buckets or list_plan_tasks and grep client-side. Matching is case-insensitive substring. Pass `query` as a single string, OR as an ARRAY of terms to match ANY of them in one call (OR) - prefer this over client-side grep alternation, which is unreliable on some hosts. Searches both title and notes by default; set `fields` to 'subject' or 'description' to narrow. Optional `filter` 'all'|'overdue'|'milestones' (as in list_plan_tasks). Returns the same task shape as list_plan_tasks (taskId, subject, description preview, bucket, dates, progress, …). Size-capped and paged: at most " +
    SAFE_PAGE_SIZE +
    " tasks per page (shrinks further when notes are large) - KEEP PAGING with pageToken until hasMore is false (totalMatched is the full match count). LIMITATION: notes are stored HTML-entity-encoded, so a term containing quotes, ampersands or angle-brackets (\" & ' < >) may not match the human-readable text - search a plain-text fragment instead; the response warns when a term contains such characters. A long note is clipped to a preview (descriptionTruncated:true) - fetch full text via get_task. If truncated=true the underlying 10,000-row scan was incomplete.",
  inputSchema: {
    projectId: z.string().describe("GUID of the plan (msdyn_projectid) to search within."),
    query: z
      .union([z.string(), z.array(z.string())])
      .describe(
        "Text to find (case-insensitive substring) in task titles and/or notes. A single string, or an array of terms to match ANY of them (OR) in one call. Plain words/names/dates work best - see the entity-encoding note in the tool description.",
      ),
    fields: z
      .enum(["both", "subject", "description"])
      .optional()
      .describe("Where to search: 'both' (default), 'subject' (title only), or 'description' (notes only)."),
    filter: z
      .enum(["all", "overdue", "milestones"])
      .optional()
      .describe(
        "Which matching tasks to return: 'all' (default), 'overdue' (leaf tasks past finish and under 100%, excludes summary tasks), or 'milestones'.",
      ),
    limit: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Max tasks to return in this page (default and max " +
          SAFE_PAGE_SIZE +
          "; the page may shrink further if notes are large). Page with pageToken until hasMore is false.",
      ),
    pageToken: z
      .string()
      .optional()
      .describe("Opaque cursor from a previous call's nextPageToken; omit for the first page."),
  },
  handler: async (input: {
    projectId: string;
    query: string | string[];
    fields?: SearchFields;
    filter?: "all" | "overdue" | "milestones";
    limit?: number;
    pageToken?: string;
  }) => {
    const BASE = getApiBase();
    const projectId = assertGuid(input.projectId, "projectId");
    const fields: SearchFields = input.fields ?? "both";
    const filterMode = input.filter ?? "all";
    const toolWarnings: string[] = [];

    const built = buildSearchFilter(projectId, input.query, fields);
    toolWarnings.push(...built.warnings);

    const CORE_SELECT =
      "msdyn_projecttaskid,msdyn_subject,msdyn_description," +
      "msdyn_start,msdyn_finish,msdyn_progress,msdyn_effort,msdyn_outlinelevel," +
      "msdyn_ismilestone,msdyn_priority,msdyn_displaysequence," +
      "_msdyn_projectbucket_value,_msdyn_parenttask_value,_msdyn_projectsprint_value";
    const EXPAND =
      "&$expand=msdyn_projectbucket($select=msdyn_name),msdyn_parenttask($select=msdyn_subject)";

    // Capability-aware full scan for a complete $filter string. Mirrors
    // list_plan_tasks: probe the Project-Operations-only extended fields once
    // (process-cached), then page everything. pageAll throws "read failed (4xx)".
    let hasExtended = getExtendedTaskFieldsCapability() !== "absent";
    const runScan = async (odataFilter: string) => {
      const filterAndOrder = "&$filter=" + odataFilter + "&$orderby=msdyn_displaysequence asc";
      const coreUrl = BASE + "/msdyn_projecttasks?$select=" + CORE_SELECT + EXPAND + filterAndOrder;
      const extUrl =
        BASE +
        "/msdyn_projecttasks?$select=" +
        CORE_SELECT +
        "," +
        EXTENDED_TASK_FIELDS +
        EXPAND +
        filterAndOrder;
      const cap = getExtendedTaskFieldsCapability();
      if (cap === "absent") {
        hasExtended = false;
        return pageAll(coreUrl, readHeaders());
      }
      if (cap === "present") {
        hasExtended = true;
        return pageAll(extUrl, readHeaders());
      }
      // Unknown — probe with a first-page request including extended fields.
      const probeRes = await dvReq({ url: extUrl, method: "GET", headers: readHeaders() }, { retry: true });
      if (isMissingPropertyError(probeRes.status, dvErrorMessage(probeRes))) {
        setExtendedTaskFieldsCapability("absent");
        hasExtended = false;
        if (!toolWarnings.some((w) => /Extended scheduling fields/.test(w)))
          toolWarnings.push(
            "Extended scheduling fields (remaining effort, duration, actuals) are not available on this environment.",
          );
        return pageAll(coreUrl, readHeaders());
      }
      if (probeRes.status >= 400)
        throw new Error("search_plan_tasks failed (" + probeRes.status + "): " + dvErrorMessage(probeRes));
      setExtendedTaskFieldsCapability("present");
      hasExtended = true;
      return pageAll(extUrl, readHeaders());
    };

    // Primary: push the text filter to Dataverse. If it searches notes and the
    // server rejects contains() on the msdyn_description memo field (a 400 that is
    // NOT the extended-fields probe error), fall back to scanning the whole plan
    // and matching notes client-side over the bounded scan. (Grepping the DECODED
    // text is actually MORE accurate for special characters than the server path.)
    let notesSearchedClientSide = false;
    let paged;
    try {
      paged = await runScan(built.filter);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (fields !== "subject" && /\b400\b/.test(msg)) {
        notesSearchedClientSide = true;
        toolWarnings.push(
          "Server-side note search was rejected by Dataverse; scanned the plan and matched notes client-side over the scanned rows - if truncated=true this note search is incomplete.",
        );
        paged = await runScan("_msdyn_project_value eq " + projectId);
      } else {
        throw e;
      }
    }

    let rows = paged.rows as FullTask[];

    // Client-side match when we fell back to a scope-only scan: keep a row if ANY
    // term appears in the decoded subject/notes (per `fields`).
    if (notesSearchedClientSide) {
      const needles = built.terms.map((t) => t.toLowerCase());
      rows = rows.filter((t) => {
        const subj = (t.msdyn_subject ?? "").toLowerCase();
        const desc = (decodeDataverseText(t.msdyn_description) ?? "").toLowerCase();
        return needles.some((n) =>
          fields === "description" ? desc.includes(n) : subj.includes(n) || desc.includes(n),
        );
      });
    }

    // Summary set for isSummary / overdue exclusion. NOTE: computed over the
    // MATCHED rows only — a matched parent whose children didn't match the query
    // won't be flagged as a summary. Acceptable for a search view (the alternative
    // is a second full-plan read just to classify parents).
    const summaryIds = new Set<string>();
    for (const t of rows) {
      const p = t._msdyn_parenttask_value;
      if (p) summaryIds.add(String(p).toLowerCase());
    }
    const nowMs = new Date(nowIso()).getTime();

    let filtered = rows;
    if (filterMode === "milestones") {
      filtered = rows.filter((t) => t.msdyn_ismilestone === true);
    } else if (filterMode === "overdue") {
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

    // Bound the response to `limit` rows with a short offset cursor (the scan read
    // every matching row; this only caps what is RETURNED). Byte-budgeted so large
    // notes can't push a page past a host's ~200k-char limit; the cursor advances
    // by exactly what we return, so nothing is dropped.
    const limit = Math.min(clampLimit(input.limit), SAFE_PAGE_SIZE);
    const page = pageByOffset(tasks, limit, input.pageToken);
    const pageTasks = page.items;
    const nextPageToken = page.nextPageToken;
    const hasMore = page.hasMore;
    if (hasMore && !page.fits)
      toolWarnings.push(
        "This page was reduced to stay within the host response-size limit (large task notes); more matches remain - page with pageToken.",
      );

    return {
      ok: true,
      projectId,
      terms: built.terms,
      fields,
      filter: filterMode,
      searchedNotesServerSide: fields === "subject" ? false : !notesSearchedClientSide,
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
              " matching tasks. Call search_plan_tasks again with this pageToken (same projectId/query/fields/filter) and keep paging until hasMore is false before claiming you have them all.",
          }
        : {}),
      truncated: paged.truncated,
      warnings: toolWarnings,
      tasks: pageTasks,
    };
  },
};
