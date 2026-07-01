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

/**
 * Annotation set requested via the `Prefer: odata.include-annotations=` header.
 * FormattedValue alone (the long-standing default) does NOT surface
 * `@Microsoft.Dynamics.CRM.lookuplogicalname` — proven live against a real
 * tenant by the schema-scout probe. Widen to WITH_LOOKUP_LOGICAL_NAME only on
 * the custom-column read path (includeCustomColumns), which needs the target
 * entity logical name for polymorphic lookups; degrade gracefully if the
 * annotation is still absent (fromRead() treats it as optional).
 */
const FORMATTED_VALUE_ANNOTATION = "OData.Community.Display.V1.FormattedValue";
const LOOKUP_LOGICAL_NAME_ANNOTATION = "Microsoft.Dynamics.CRM.lookuplogicalname";

/**
 * Read-only Dataverse headers with large page size + formatted-value
 * annotations. Pass `includeCustomColumns: true` to also request
 * `lookuplogicalname` (needed to surface a custom lookup's target entity) —
 * default false preserves today's exact header for every existing caller.
 */
export function readHeaders(opts?: { includeCustomColumns?: boolean }): Record<string, string> {
  const annotations = opts?.includeCustomColumns
    ? `${FORMATTED_VALUE_ANNOTATION},${LOOKUP_LOGICAL_NAME_ANNOTATION}`
    : FORMATTED_VALUE_ANNOTATION;
  return dvHeaders({
    extra: {
      Prefer: `odata.maxpagesize=1000,odata.include-annotations="${annotations}"`,
    },
  });
}

// ---------------------------------------------------------------------------
// Cursor-based pagination — bounded reads that keep large plans within the
// model's context budget. The pageToken is an OPAQUE base64url wrapper around
// the Dataverse $skiptoken cursor — NEVER a caller-supplied URL — and is
// re-attached as an ENCODED query value on the same env-fixed URL, so tool
// input can never select a host or path (SSRF stays closed).
// ---------------------------------------------------------------------------

/** Default / maximum page size for bounded reads. */
export const MAX_PAGE_SIZE = 1000;
export const DEFAULT_PAGE_SIZE = 1000;

/**
 * Size-safe page cap for the big list reads. A host (e.g. Langdock) truncates a
 * tool response at ~200k characters; even lean task rows reach that around a few
 * hundred rows, and the cut is SILENT and mid-JSON — the model is then left with
 * corrupt/partial data it can't tell is incomplete. Capping each page well below
 * the limit and paging via nextPageToken guarantees every response arrives whole.
 */
export const SAFE_PAGE_SIZE = 200;

/**
 * Char budget for the rows portion of one read response, leaving headroom under
 * a ~200k host cap for the wrapper fields. Used by fitToBudget to shrink a page
 * whose rows carry variable-length free text (e.g. task notes) so it still fits.
 */
export const RESPONSE_CHAR_BUDGET = 150_000;

/**
 * Returns the largest leading slice of `items` whose JSON serialization stays
 * within `maxChars`, plus whether everything fit. Always returns at least one
 * item (callers bound per-item size separately, so a single item can't blow the
 * budget). Lets an OFFSET-paged tool keep a page under a host's response-size cap
 * when item sizes vary, without losing rows — the caller advances its cursor by
 * the returned items.length, so the dropped rows come back on the next page.
 */
export function fitToBudget<T>(
  items: T[],
  maxChars = RESPONSE_CHAR_BUDGET,
): { items: T[]; fits: boolean } {
  if (items.length === 0 || JSON.stringify(items).length <= maxChars)
    return { items, fits: true };
  // Largest prefix that fits (binary search on length; always keeps ≥ 1).
  let lo = 1;
  let hi = items.length;
  let best = 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (JSON.stringify(items.slice(0, mid)).length <= maxChars) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return { items: items.slice(0, best), fits: false };
}

export interface OffsetPage<T> {
  items: T[];
  nextPageToken?: string;
  hasMore: boolean;
  /** false when fitToBudget had to drop trailing rows to stay under the char cap. */
  fits: boolean;
}

/**
 * Slices an already-materialised array into ONE host-safe page using a SHORT,
 * model-friendly cursor: an opaque base64url-wrapped numeric offset (e.g. "MjAw"
 * = 200), NOT a long Dataverse $skiptoken. A short integer is the only kind of
 * cursor an MCP host's model reliably echoes back to fetch the next page — long
 * opaque cursors get truncated/corrupted in transit, stalling pagination. The
 * slice is byte-budgeted with fitToBudget so variable-length rows can't push a
 * page past a host's ~200k-char cap, and the cursor advances by exactly what is
 * returned, so no row is ever dropped. A stale offset past the end yields an
 * empty page with no token (paging simply stops).
 */
export function pageByOffset<T>(
  all: T[],
  limit: number,
  pageToken?: string,
  maxChars = RESPONSE_CHAR_BUDGET,
): OffsetPage<T> {
  let offset = 0;
  if (pageToken) {
    const raw = Buffer.from(pageToken, "base64url").toString("utf8");
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0 || n > 10_000_000) throw new Error("Invalid pageToken.");
    offset = n;
  }
  const fit = fitToBudget(all.slice(offset, offset + limit), maxChars);
  const items = fit.items;
  const nextOffset = offset + items.length;
  const nextPageToken =
    nextOffset < all.length
      ? Buffer.from(String(nextOffset), "utf8").toString("base64url")
      : undefined;
  return { items, nextPageToken, hasMore: !!nextPageToken, fits: fit.fits };
}

/** Clamp a caller-supplied limit into [1, MAX_PAGE_SIZE]; undefined -> default. */
export function clampLimit(limit: unknown): number {
  if (limit === undefined || limit === null) return DEFAULT_PAGE_SIZE;
  const n = Number(limit);
  if (!Number.isFinite(n)) return DEFAULT_PAGE_SIZE;
  return Math.max(1, Math.min(MAX_PAGE_SIZE, Math.floor(n)));
}

/** Wrap a Dataverse @odata.nextLink's $skiptoken into an opaque page token. */
export function encodePageToken(nextLink: string | null | undefined): string | undefined {
  if (!nextLink) return undefined;
  try {
    const sk = new URL(nextLink).searchParams.get("$skiptoken");
    if (!sk) return undefined;
    return Buffer.from(sk, "utf8").toString("base64url");
  } catch {
    return undefined;
  }
}

/** Decode an opaque page token back to its $skiptoken value. Throws on bad input. */
export function decodePageToken(token: string): string {
  if (typeof token !== "string" || token.length === 0 || token.length > 8192)
    throw new Error("Invalid pageToken.");
  const raw = Buffer.from(token, "base64url").toString("utf8");
  // A real skiptoken is a short paging cookie. Reject anything URL-like or
  // implausibly large — defense in depth against query/host injection.
  if (!raw || raw.length > 4096 || /^https?:\/\//i.test(raw))
    throw new Error("Invalid pageToken.");
  return raw;
}

/** Read-only headers that clamp the server page size to `limit` rows. */
export function pageHeaders(limit: number): Record<string, string> {
  const n = Math.max(1, Math.min(MAX_PAGE_SIZE, Math.floor(limit)));
  return dvHeaders({
    extra: {
      Prefer: `odata.maxpagesize=${n},odata.include-annotations="OData.Community.Display.V1.FormattedValue"`,
    },
  });
}

export interface PageResult {
  rows: any[];
  nextPageToken?: string;
}

/**
 * Fetches ONE page (up to `limit` rows) of an OData collection. SSRF-safe: the
 * skiptoken cursor is re-attached as an ENCODED query value on the env-fixed
 * `firstUrl`; a caller's pageToken never selects host or path.
 */
export async function pageOnce(
  firstUrl: string,
  limit: number,
  pageToken?: string,
): Promise<PageResult> {
  let url = firstUrl;
  if (pageToken) {
    const sk = decodePageToken(pageToken);
    url += (url.includes("?") ? "&" : "?") + "$skiptoken=" + encodeURIComponent(sk);
  }
  const res = await dvReq({ url, method: "GET", headers: pageHeaders(limit) }, { retry: true });
  if (res.status >= 400)
    throw new Error("read failed (" + res.status + "): " + dvErrorMessage(res));
  const rows = res.json?.value || [];
  const nextPageToken = encodePageToken(res.json?.["@odata.nextLink"]);
  return { rows, nextPageToken };
}
