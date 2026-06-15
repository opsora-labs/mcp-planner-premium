import { dvReq, dvHeaders, dvErrorMessage } from "../dataverse.js";

/**
 * Dependency link-type option values -> short labels.
 *
 * Two value ranges exist across tenants:
 *   Standard (global):  192350000=FS, 192350001=SS, 192350002=FF, 192350003=SF
 *   EU/CRM4 (small-int): 0=FF, 1=FS, 2=SF, 3=SS
 *
 * Both are mapped here so read tools display correctly on either tenant.
 * The write path (addTasksSimple.ts LINK_TYPE_VALUES) still sends the
 * 192350000-range; whether PSS on EU tenants also accepts those is unconfirmed.
 */
export const LINK_TYPE_LABELS: Record<number, string> = {
  192350000: "FS",
  192350001: "SS",
  192350002: "FF",
  192350003: "SF",
  // EU/CRM4 small-integer range (confirmed via describe_option_set on CRM4 env)
  0: "FF",
  1: "FS",
  2: "SF",
  3: "SS",
};

export function linkTypeLabel(v: unknown): string | undefined {
  if (typeof v !== "number") return undefined;
  return LINK_TYPE_LABELS[v] ?? "Unknown(" + v + ")";
}

/** Current time as an ISO-8601 UTC string (Dataverse $filter has no now()). */
export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Decodes the standard HTML entities Dataverse stores in free-text fields like
 * msdyn_description. Dataverse HTML-encodes those characters on write and the
 * Planner UI decodes them for display, so we mirror the UI — callers get the
 * real characters back (`"`, `&`, `'`, `<`, `>`) instead of `&quot;`/`&amp;`/…
 *
 * `&amp;` is decoded LAST on purpose: a stored `&amp;lt;` represents the literal
 * text `&lt;`, so decoding `&amp;` first would wrongly collapse it to `<`. Doing
 * `&amp;` last yields the correct literal `&lt;`.
 *
 * NOTE: this only reverses entity-encoding. Tag-like `<...>` *content* is
 * stripped by Dataverse before storage and cannot be recovered on read.
 */
export function decodeDataverseText(v: string | null | undefined): string | null {
  if (typeof v !== "string") return null;
  return v
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/**
 * Detects tag-like `<...>` spans in a description/note. Dataverse's HTML
 * sanitiser STRIPS such content on write (a confirmed example: "follow-up
 * <2 weeks>" is stored as "follow-up "), so the write tools warn the caller
 * before the text is silently lost. A lone `<` or `>` is safe — it is
 * entity-encoded and round-trips — so only a `<...>` pair is flagged. The match
 * is deliberately broad (e.g. "5 < 10 > 2" matches): anything the sanitiser
 * could treat as a tag is worth warning about.
 */
export function hasStrippableTagContent(v: string | null | undefined): boolean {
  return typeof v === "string" && /<[^>]*>/.test(v);
}

export interface RawTask {
  msdyn_projecttaskid: string;
  msdyn_subject?: string;
  msdyn_ismilestone?: boolean;
  msdyn_finish?: string | null;
  msdyn_progress?: number | null;
  _msdyn_parenttask_value?: string | null;
}

export interface TaskRollup {
  totalTasks: number;
  summaryTaskCount: number;
  leafTaskCount: number;
  milestoneCount: number;
  /** Overdue counts LEAF tasks only (summary rollups would double-count). */
  overdueLeafTaskCount: number;
  summaryTaskIds: string[];
}

/**
 * Pure, summary-aware rollup over a plan's tasks. A task is a "summary" if some
 * other task names it as parent (`_msdyn_parenttask_value`). Overdue is computed
 * on leaf tasks only. `now` is injected (the caller passes nowIso()).
 */
export function summariseTasks(tasks: RawTask[], now: string): TaskRollup {
  const summaryIds = new Set<string>();
  for (const t of tasks) {
    const p = t._msdyn_parenttask_value;
    if (p) summaryIds.add(String(p).toLowerCase());
  }
  const nowMs = new Date(now).getTime();
  let milestones = 0;
  let overdue = 0;
  for (const t of tasks) {
    const isSummary = summaryIds.has(String(t.msdyn_projecttaskid).toLowerCase());
    if (t.msdyn_ismilestone === true) milestones++;
    if (
      !isSummary &&
      t.msdyn_finish &&
      new Date(t.msdyn_finish).getTime() < nowMs &&
      typeof t.msdyn_progress === "number" &&
      t.msdyn_progress < 1
    ) {
      overdue++;
    }
  }
  return {
    totalTasks: tasks.length,
    summaryTaskCount: summaryIds.size,
    leafTaskCount: tasks.length - summaryIds.size,
    milestoneCount: milestones,
    overdueLeafTaskCount: overdue,
    summaryTaskIds: [...summaryIds],
  };
}

export interface PagedResult {
  rows: any[];
  pages: number;
  truncated: boolean;
}

/**
 * Pages an OData collection following @odata.nextLink, with a hard page cap.
 * `truncated` is true if the cap was hit (caller must not present the result as
 * complete - the same backpressure pattern the writer's reads use).
 */
export async function pageAll(
  firstUrl: string,
  headers: Record<string, string>,
  maxPages = 10,
): Promise<PagedResult> {
  const rows: any[] = [];
  let url: string | null = firstUrl;
  let pages = 0;
  let truncated = false;
  while (url) {
    if (pages >= maxPages) {
      truncated = true;
      break;
    }
    const res = await dvReq({ url, method: "GET", headers }, { retry: true });
    if (res.status >= 400)
      throw new Error("read failed (" + res.status + "): " + dvErrorMessage(res));
    pages++;
    const page = res.json?.value || [];
    for (const r of page) rows.push(r);
    url = res.json?.["@odata.nextLink"] || null;
  }
  return { rows, pages, truncated };
}

/** Read-only Dataverse headers with large page size + formatted-value annotations. */
export function readHeaders(): Record<string, string> {
  return dvHeaders({
    extra: {
      Prefer:
        'odata.maxpagesize=1000,odata.include-annotations="OData.Community.Display.V1.FormattedValue"',
    },
  });
}
