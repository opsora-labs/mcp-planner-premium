import { getBearer } from "./context.js";
import { getEnv } from "./config.js";

/**
 * Normalised Dataverse response: `{ status, json }`. A missing/HTTP-error body
 * still yields a parsed object when possible, so the ported guardrail checks
 * (`status >= 400`, `body.error.message`) stay faithful.
 */
export interface DvResponse {
  status: number;
  json: any;
}

export interface DvRequest {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface DvRequestOptions {
  /** Retry transient 429/5xx (only safe for idempotent reads). Default false. */
  retry?: boolean;
}

/** Extracts a human message from an unknown thrown value. */
export function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object" && "message" in e)
    return String((e as { message: unknown }).message);
  return String(e);
}

const GUID_RE = /^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$/;

export const isGuid = (s: string): boolean => GUID_RE.test(s);

/** Throws a clean validation error if `value` is not a canonical GUID. */
export function assertGuid(value: string | undefined, label: string): string {
  const v = (value || "").trim();
  if (!v) throw new Error(`${label} is required.`);
  if (!GUID_RE.test(v)) throw new Error(`${label} must be a GUID.`);
  return v;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

async function readBody(res: Response): Promise<any> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

/**
 * Replacement for Langdock's `ld.request`. Adds an outbound timeout and (for
 * reads) bounded, Retry-After-aware retry on 429/5xx. Never throws on an HTTP
 * error STATUS - it returns `{ status, json }`. Transport failures and timeouts
 * DO throw, with a clear message.
 */
export async function dvReq(
  req: DvRequest,
  opts: DvRequestOptions = {},
): Promise<DvResponse> {
  const timeoutMs = getEnv().REQUEST_TIMEOUT_MS;
  const maxAttempts = opts.retry ? 4 : 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res: Response;
    try {
      res = await fetch(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.body === undefined ? undefined : JSON.stringify(req.body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e: unknown) {
      if (e instanceof Error && e.name === "TimeoutError")
        throw new Error(`Dataverse did not respond within ${timeoutMs}ms.`);
      throw new Error("HTTP call failed: " + errMessage(e));
    }

    const json = await readBody(res);
    const retryable = res.status === 429 || res.status >= 500;
    if (opts.retry && retryable && attempt < maxAttempts) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const delaySec =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter
          : Math.pow(2, attempt);
      await sleep(delaySec * 1000);
      continue;
    }
    return { status: res.status, json };
  }
  // Unreachable: the loop always returns on the final attempt.
  throw new Error("dvReq: exhausted retries unexpectedly.");
}

/**
 * Standard Dataverse headers. The delegated bearer is pulled from the current
 * request context. `json: true` adds Content-Type for write bodies; `extra` for
 * one-offs like `Prefer`.
 */
export function dvHeaders(opts?: {
  json?: boolean;
  extra?: Record<string, string>;
}): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: "Bearer " + getBearer(),
    "OData-MaxVersion": "4.0",
    "OData-Version": "4.0",
    Accept: "application/json",
  };
  if (opts?.json) headers["Content-Type"] = "application/json";
  if (opts?.extra) Object.assign(headers, opts.extra);
  return headers;
}

/** Extracts `body.error.message` with the same fallback the actions used. */
export function dvErrorMessage(response: DvResponse): string {
  const body = response.json || {};
  return (body.error && body.error.message) || "HTTP " + response.status;
}

export interface PssErrorDetail {
  outerKey: string | undefined;
  innerKey: string | undefined;
  failedBatchRequestIndex: number | undefined;
  message: string;
}

/**
 * Extracts structured PSS error information from a Dataverse response body.
 * PSS errors arrive in two shapes:
 *   (a) OData wrapper: { error: { message: "<json-or-text>" } }
 *   (b) Raw PSS top-level: { errorKey, ErrorMessage, failedBatchRequestError: { errorKey, ErrorMessage } }
 * Returns undefined when the response body doesn't look like a PSS error.
 */
export function parsePssError(body: any): PssErrorDetail | undefined {
  if (!body || typeof body !== "object") return undefined;

  // Shape (b): raw PSS top-level
  if (typeof body.errorKey === "string" || typeof body.ErrorMessage === "string") {
    const inner = body.failedBatchRequestError;
    return {
      outerKey: body.errorKey,
      innerKey: inner?.errorKey,
      failedBatchRequestIndex:
        typeof body.failedBatchRequestIndex === "number"
          ? body.failedBatchRequestIndex
          : undefined,
      message:
        (inner?.ErrorMessage || body.ErrorMessage || body.errorKey || "") +
        (inner ? " (inner: " + (inner.errorKey || "") + " — " + (inner.ErrorMessage || "") + ")" : ""),
    };
  }

  // Shape (a): OData wrapper — try to JSON-parse the message field for nested PSS JSON
  const odataMsg = body.error?.message;
  if (typeof odataMsg === "string") {
    const trimmed = odataMsg.trim();
    if (trimmed.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (typeof parsed.errorKey === "string" || typeof parsed.ErrorMessage === "string") {
          const inner = parsed.failedBatchRequestError;
          return {
            outerKey: parsed.errorKey,
            innerKey: inner?.errorKey,
            failedBatchRequestIndex:
              typeof parsed.failedBatchRequestIndex === "number"
                ? parsed.failedBatchRequestIndex
                : undefined,
            message:
              (inner?.ErrorMessage || parsed.ErrorMessage || parsed.errorKey || "") +
              (inner ? " (inner: " + (inner.errorKey || "") + " — " + (inner.ErrorMessage || "") + ")" : ""),
          };
        }
      } catch {
        // not JSON — fall through
      }
    }
  }

  return undefined;
}

/**
 * Like dvErrorMessage but also unpacks PSS-specific error structures so callers
 * receive meaningful detail rather than a raw JSON blob or "HTTP 400".
 */
export function dvPssErrorMessage(response: DvResponse): string {
  const body = response.json || {};
  const pss = parsePssError(body);
  if (pss) return pss.message || "HTTP " + response.status;
  return dvErrorMessage(response);
}

/**
 * Shared error handling for the PSS batch-create calls (msdyn_PssCreateV2),
 * used by both the raw and ergonomic add-task tools. Throws on HTTP error.
 */
export function throwIfPssCreateError(response: DvResponse): void {
  if (response.status < 400) return;
  const msg = dvErrorMessage(response);
  if (response.status === 403)
    throw new Error("403 - missing license or privileges: " + msg);
  if (/duplicate entities/i.test(msg))
    throw new Error(
      "pss_create_batch failed: duplicate entities in this change session - the same batch was likely submitted twice. Cancel this change session, start a fresh one, and submit the batch EXACTLY ONCE (never call both in the same parallel block). Detail: " +
        msg,
    );
  throw new Error("pss_create_batch failed (" + response.status + "): " + msg);
}

export interface AsArrayOptions {
  /**
   * Treat a bare, non-JSON string as a single-element array — e.g. "Alice" -> ["Alice"].
   * Enable for string-LIST params (names, ids, labels) where a lone value is an
   * unambiguous one-item list. Do NOT enable for object-array params like
   * `tasks`/`entities`, where a bare string should surface a clear error instead of
   * being wrapped into a bogus one-element array.
   */
  coerceScalar?: boolean;
  /** Example array shown in the error message, e.g. '["Alice", "Bob"]'. */
  example?: string;
}

/**
 * Parses an input that may arrive as a real array or as a JSON-encoded string.
 * Prefer passing a NATIVE array from the MCP client — the string form is only a
 * compatibility fallback for hosts that stringify structured params, and is the
 * usual source of "not valid JSON" / truncated-array errors.
 */
export function asArray<T = any>(
  input: unknown,
  label: string,
  opts: AsArrayOptions = {},
): T[] {
  const example = opts.example ?? '["item1", "item2"]';
  let value: unknown = input;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return [];
    try {
      value = JSON.parse(trimmed);
    } catch (e: unknown) {
      // A bare, non-JSON scalar (e.g. `Alice`) is an unambiguous single-item list.
      // But if it LOOKS like JSON (starts with [ { or ") yet failed to parse, it is a
      // malformed array/object — surface the error rather than wrapping the raw text.
      if (opts.coerceScalar && !/^[[{"]/.test(trimmed)) {
        return [trimmed as unknown as T];
      }
      throw new Error(
        `${label} must be a JSON array (e.g. ${example}). The value received was a ` +
          `string that is not valid JSON — if your MCP client can send structured ` +
          `input, pass a real array rather than a JSON-encoded string. Parse error: ` +
          errMessage(e),
      );
    }
  }
  if (!Array.isArray(value)) {
    // Parsed/passed to a lone scalar (e.g. "Alice" or 5) — wrap it when coercion is on.
    if (opts.coerceScalar && value != null && typeof value !== "object") {
      return [value as T];
    }
    throw new Error(`${label} must be a JSON array (e.g. ${example}).`);
  }
  return value as T[];
}
