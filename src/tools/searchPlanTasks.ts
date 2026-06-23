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
 * Structured, server-side property filters AND-composed onto a search. Every value
 * is TYPED and validated in buildSearchFilter (GUID / ISO-date / number / bool) —
 * there is deliberately NO raw OData passthrough, so a caller can never inject
 * filter syntax. The GUID-valued filters (bucket / sprint / parent) reference OTHER
 * records: the caller must pass a real GUID it obtained from a read tool (e.g.
 * get_plan_tasks_and_buckets for a bucketId, list_plan_tasks/get_task for a parent
 * taskId), never a guessed value or a human-readable name.
 */
export interface SearchTaskFilters {
  bucketId?: string;
  sprintId?: string;
  parentTaskId?: string;
  isMilestone?: boolean;
  priorityMin?: number;
  priorityMax?: number;
  progressMin?: number;
  progressMax?: number;
  effortMin?: number;
  effortMax?: number;
  startAfter?: string;
  startBefore?: string;
  finishAfter?: string;
  finishBefore?: string;
  // Project-Operations-only "actual" fields — absent on basic tenants.
  actualStartAfter?: string;
  actualStartBefore?: string;
  actualFinishAfter?: string;
  actualFinishBefore?: string;
}

/** True when any actuals-based filter (Project-Operations-only fields) is set. */
export function usesActualsFilters(f: SearchTaskFilters): boolean {
  return (
    f.actualStartAfter != null ||
    f.actualStartBefore != null ||
    f.actualFinishAfter != null ||
    f.actualFinishBefore != null
  );
}

/**
 * Canonicalises a caller-supplied date to an ISO-8601 UTC instant, or throws. The
 * round-trip through Date rejects anything that is not a real date, and an ISO
 * datetime embeds unquoted-and-safe in a Dataverse $filter — so a date filter
 * cannot carry injection.
 */
function odataDate(value: string, label: string): string {
  const ms = Date.parse(value);
  if (Number.isNaN(ms))
    throw new Error(label + " must be an ISO-8601 date/time (e.g. 2026-07-01 or 2026-07-01T09:00:00Z).");
  return new Date(ms).toISOString();
}

/**
 * Pure builder for the Dataverse $filter that scopes a search to ONE plan and an
 * optional case-insensitive substring over the task title and/or notes, AND any
 * number of structured property filters (bucket, sprint, parent, milestone,
 * priority, progress, effort, date windows).
 *
 * `query` may be a single string, an array of terms (an array matches ANY term —
 * OR — so "find tasks mentioning A or B" is one server call), or undefined when
 * only property filters are given. The text OR-alternation deliberately replaces
 * client-side grep alternation, which is unreliable on some MCP hosts (e.g.
 * Langdock treats a `\|` OR pattern as a literal, so a multi-term grep silently
 * matches nothing). Single quotes in each term are doubled (the OData literal
 * escape) then percent-encoded, so a term can never break out of the contains()
 * literal.
 *
 * Throws if NEITHER a text query NOR any property filter is supplied (that is just
 * "list every task" — use list_plan_tasks), on limit breaches, on a malformed GUID
 * filter, or on an unparseable date filter. Returns:
 *   - `filter`      plan scope + structured predicates + text (the primary scan)
 *   - `scopeFilter` plan scope + structured predicates, WITHOUT the text predicate
 *                   (the memo-field fallback re-scans with this so bucket/date/etc.
 *                   stay enforced server-side while text is matched client-side)
 *   - `terms`       the normalised text terms actually searched
 *   - `warnings`    any caveat warnings
 */
export function buildSearchFilter(
  projectId: string,
  query: string | string[] | undefined,
  fields: SearchFields = "both",
  filters: SearchTaskFilters = {},
): { filter: string; scopeFilter: string; warnings: string[]; terms: string[] } {
  const terms = (Array.isArray(query) ? query : query == null ? [] : [query])
    .map((t) => (t ?? "").trim())
    .filter((t) => t.length > 0);
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

  // Structured property predicates (AND-composed). GUIDs are validated; dates are
  // canonicalised; numbers/bools are already type-checked at the tool boundary.
  const structured: string[] = [];
  const guidPred = (val: string | undefined, label: string, field: string) => {
    if (val == null) return;
    const v = val.trim();
    if (!isGuid(v))
      throw new Error(label + " must be a GUID - resolve it with a read tool (do not guess or pass a name).");
    structured.push(field + " eq " + v);
  };
  guidPred(filters.bucketId, "bucketId", "_msdyn_projectbucket_value");
  guidPred(filters.sprintId, "sprintId", "_msdyn_projectsprint_value");
  guidPred(filters.parentTaskId, "parentTaskId", "_msdyn_parenttask_value");
  if (filters.isMilestone != null)
    structured.push("msdyn_ismilestone eq " + (filters.isMilestone ? "true" : "false"));
  if (filters.priorityMin != null) structured.push("msdyn_priority ge " + filters.priorityMin);
  if (filters.priorityMax != null) structured.push("msdyn_priority le " + filters.priorityMax);
  if (filters.progressMin != null) structured.push("msdyn_progress ge " + filters.progressMin);
  if (filters.progressMax != null) structured.push("msdyn_progress le " + filters.progressMax);
  if (filters.effortMin != null) structured.push("msdyn_effort ge " + filters.effortMin);
  if (filters.effortMax != null) structured.push("msdyn_effort le " + filters.effortMax);
  if (filters.startAfter != null) structured.push("msdyn_start ge " + odataDate(filters.startAfter, "startAfter"));
  if (filters.startBefore != null) structured.push("msdyn_start lt " + odataDate(filters.startBefore, "startBefore"));
  if (filters.finishAfter != null) structured.push("msdyn_finish ge " + odataDate(filters.finishAfter, "finishAfter"));
  if (filters.finishBefore != null) structured.push("msdyn_finish lt " + odataDate(filters.finishBefore, "finishBefore"));
  if (filters.actualStartAfter != null)
    structured.push("msdyn_actualstart ge " + odataDate(filters.actualStartAfter, "actualStartAfter"));
  if (filters.actualStartBefore != null)
    structured.push("msdyn_actualstart lt " + odataDate(filters.actualStartBefore, "actualStartBefore"));
  if (filters.actualFinishAfter != null)
    structured.push("msdyn_actualfinish ge " + odataDate(filters.actualFinishAfter, "actualFinishAfter"));
  if (filters.actualFinishBefore != null)
    structured.push("msdyn_actualfinish lt " + odataDate(filters.actualFinishBefore, "actualFinishBefore"));

  if (terms.length === 0 && structured.length === 0)
    throw new Error(
      "query is required, OR at least one property filter (bucketId, sprintId, parentTaskId, isMilestone, priority/progress/effort range, or a start/finish date window).",
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

  // scopeFilter = plan scope + structured predicates, WITHOUT the text match.
  const scopeFilter = ["_msdyn_project_value eq " + projectId, ...structured].join(" and ");

  const textPred =
    terms.length === 0
      ? ""
      : terms.length === 1
        ? predFor(terms[0])
        : "(" + terms.map(predFor).join(" or ") + ")";
  const filter = textPred ? scopeFilter + " and " + textPred : scopeFilter;
  return { filter, scopeFilter, warnings, terms };
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
    "Server-side TEXT SEARCH within ONE plan: returns only the tasks whose title (msdyn_subject) and/or notes (msdyn_description) CONTAIN the query, by pushing an OData contains() filter to Dataverse. Use THIS to find tasks that mention a word, name, date or phrase (e.g. a person's name in the notes) - do NOT page through get_plan_tasks_and_buckets or list_plan_tasks and grep client-side. Matching is case-insensitive substring. Pass `query` as a single string, OR as an ARRAY of terms to match ANY of them in one call (OR) - prefer this over client-side grep alternation, which is unreliable on some hosts. Searches both title and notes by default; set `fields` to 'subject' or 'description' to narrow. `query` is OPTIONAL when you supply at least one PROPERTY FILTER - all AND-composed with the text match: `bucketId`, `sprintId`, `parentTaskId` (GUIDs - you MUST resolve these to real GUIDs first via get_plan_tasks_and_buckets / list_plan_tasks / get_task; never guess a GUID or pass a display name), `isMilestone` (bool), `priorityMin`/`priorityMax` (int), `progressMin`/`progressMax` (0-1 fraction, 0.5 = 50%), `effortMin`/`effortMax` (hours), and date windows `startAfter`/`startBefore`/`finishAfter`/`finishBefore` (and actuals `actualStartAfter`/`actualStartBefore`/`actualFinishAfter`/`actualFinishBefore`, which need a Project Operations tenant) as ISO-8601 dates. Example - notes containing 'Marcin' in one bucket: query:'Marcin', fields:'description', bucketId:<that bucket's GUID>. If a needed GUID or date is not given to you, CALL THE RIGHT READ TOOL to obtain it before searching rather than guessing. Optional `filter` 'all'|'overdue'|'milestones' (as in list_plan_tasks) further narrows the matched rows. Returns the same task shape as list_plan_tasks (taskId, subject, description preview, bucket, dates, progress, …). Size-capped and paged: at most " +
    SAFE_PAGE_SIZE +
    " tasks per page (shrinks further when notes are large) - KEEP PAGING with pageToken until hasMore is false (totalMatched is the full match count). LIMITATION: notes are stored HTML-entity-encoded, so a term containing quotes, ampersands or angle-brackets (\" & ' < >) may not match the human-readable text - search a plain-text fragment instead; the response warns when a term contains such characters. A long note is clipped to a preview (descriptionTruncated:true) - fetch full text via get_task. If truncated=true the underlying 10,000-row scan was incomplete.",
  inputSchema: {
    projectId: z.string().describe("GUID of the plan (msdyn_projectid) to search within."),
    query: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .describe(
        "Text to find (case-insensitive substring) in task titles and/or notes. A single string, or an array of terms to match ANY of them (OR) in one call. OPTIONAL when you supply at least one property filter below (e.g. just bucketId, or a date window). Plain words/names/dates work best - see the entity-encoding note in the tool description.",
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
    bucketId: z
      .string()
      .optional()
      .describe(
        "Restrict to ONE bucket. Pass the bucket's GUID (msdyn_projectbucketid) - resolve it from get_plan_tasks_and_buckets (`buckets[].bucketId`); never pass a bucket NAME or a guessed GUID.",
      ),
    sprintId: z
      .string()
      .optional()
      .describe("Restrict to ONE sprint. Pass the sprint's GUID (msdyn_projectsprintid) from a read tool - not a name or a guess."),
    parentTaskId: z
      .string()
      .optional()
      .describe(
        "Restrict to the direct children of ONE summary task. Pass the parent task's GUID (taskId) from list_plan_tasks / get_plan_tasks_and_buckets - not a name or a guess.",
      ),
    isMilestone: z
      .boolean()
      .optional()
      .describe("true = only milestone tasks; false = only non-milestone tasks."),
    priorityMin: z
      .number()
      .int()
      .optional()
      .describe(
        "Minimum msdyn_priority, inclusive (>=). Priority is an integer on a tenant-defined scale - read a task with get_task first if you are unsure which values mean high/low.",
      ),
    priorityMax: z.number().int().optional().describe("Maximum msdyn_priority, inclusive (<=)."),
    progressMin: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe("Minimum progress as a 0-1 FRACTION (0.5 = 50%), inclusive (>=). e.g. progressMin:1 = complete."),
    progressMax: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe("Maximum progress as a 0-1 FRACTION (0.5 = 50%), inclusive (<=). e.g. progressMax:0.999 ≈ not yet complete."),
    effortMin: z.number().min(0).optional().describe("Minimum planned effort in HOURS (msdyn_effort), inclusive (>=)."),
    effortMax: z.number().min(0).optional().describe("Maximum planned effort in HOURS (msdyn_effort), inclusive (<=)."),
    startAfter: z
      .string()
      .optional()
      .describe("Only tasks whose START is on/after this ISO-8601 date or datetime (e.g. 2026-07-01)."),
    startBefore: z
      .string()
      .optional()
      .describe("Only tasks whose START is strictly before this ISO-8601 date or datetime."),
    finishAfter: z
      .string()
      .optional()
      .describe("Only tasks whose FINISH is on/after this ISO-8601 date or datetime."),
    finishBefore: z
      .string()
      .optional()
      .describe("Only tasks whose FINISH is strictly before this ISO-8601 date or datetime (e.g. finishBefore:2026-07-01 = due before July)."),
    actualStartAfter: z
      .string()
      .optional()
      .describe("Project Operations tenants only: actual start on/after this ISO date. Rejected where actual fields are absent."),
    actualStartBefore: z
      .string()
      .optional()
      .describe("Project Operations tenants only: actual start strictly before this ISO date."),
    actualFinishAfter: z
      .string()
      .optional()
      .describe("Project Operations tenants only: actual finish on/after this ISO date."),
    actualFinishBefore: z
      .string()
      .optional()
      .describe("Project Operations tenants only: actual finish strictly before this ISO date."),
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
  handler: async (
    input: {
      projectId: string;
      query?: string | string[];
      fields?: SearchFields;
      filter?: "all" | "overdue" | "milestones";
      limit?: number;
      pageToken?: string;
    } & SearchTaskFilters,
  ) => {
    const BASE = getApiBase();
    const projectId = assertGuid(input.projectId, "projectId");
    const fields: SearchFields = input.fields ?? "both";
    const filterMode = input.filter ?? "all";
    const toolWarnings: string[] = [];

    const filters: SearchTaskFilters = {
      bucketId: input.bucketId,
      sprintId: input.sprintId,
      parentTaskId: input.parentTaskId,
      isMilestone: input.isMilestone,
      priorityMin: input.priorityMin,
      priorityMax: input.priorityMax,
      progressMin: input.progressMin,
      progressMax: input.progressMax,
      effortMin: input.effortMin,
      effortMax: input.effortMax,
      startAfter: input.startAfter,
      startBefore: input.startBefore,
      finishAfter: input.finishAfter,
      finishBefore: input.finishBefore,
      actualStartAfter: input.actualStartAfter,
      actualStartBefore: input.actualStartBefore,
      actualFinishAfter: input.actualFinishAfter,
      actualFinishBefore: input.actualFinishBefore,
    };

    // The "actual" fields are Project-Operations-only. If this tenant is already
    // known to lack the extended fields, reject up front with a clear message
    // rather than emitting a $filter that Dataverse 400s on.
    if (usesActualsFilters(filters) && getExtendedTaskFieldsCapability() === "absent")
      throw new Error(
        "actual start/finish filters (actualStart*/actualFinish*) are not available on this environment (no Project Operations extended fields).",
      );

    const built = buildSearchFilter(projectId, input.query, fields, filters);
    toolWarnings.push(...built.warnings);

    const appliedFilters = Object.fromEntries(
      Object.entries(filters).filter(([, v]) => v !== undefined),
    );

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
      if (fields !== "subject" && built.terms.length > 0 && /\b400\b/.test(msg)) {
        notesSearchedClientSide = true;
        toolWarnings.push(
          "Server-side note search was rejected by Dataverse; scanned the plan (still applying any property filters server-side) and matched notes client-side over the scanned rows - if truncated=true this note search is incomplete.",
        );
        // Re-scan with the property filters intact but WITHOUT the text predicate;
        // the text terms are matched client-side below over the scanned rows.
        paged = await runScan(built.scopeFilter);
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
      ...(Object.keys(appliedFilters).length ? { appliedFilters } : {}),
      searchedNotesServerSide:
        built.terms.length === 0 || fields === "subject" ? false : !notesSearchedClientSide,
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
