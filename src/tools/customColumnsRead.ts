/**
 * Shared read-path plumbing for `includeCustomColumns` on get_task,
 * list_plan_tasks, and get_plan_summary. Additive only: when the caller omits
 * `includeCustomColumns` (or CUSTOM_COLUMNS_MODE=off), behaviour is byte-for-byte
 * identical to today — this module is never touched.
 *
 * Degrade philosophy (per the design doc §4 and §7): a read never hard-fails
 * because of custom columns. If metadata can't be read, or a specific column
 * was renamed/removed since the caller last discovered it, the read degrades to
 * core-only (or drops just that column) with a warning — the model always gets
 * the core task/plan payload back.
 */

import { z } from "zod";
import {
  getCustomColumnsMode,
  getCustomColumnsAllowlist,
} from "../config.js";
import { getEntityMetadata, isCustomColumnName } from "../dataverse/metadata.js";
import { fromRead, type ColumnMeta } from "../dataverse/columnTypes.js";
import { isMissingPropertyError } from "./capabilities.js";
import { dvErrorMessage, type DvResponse } from "../dataverse.js";

/** Zod schema for the includeCustomColumns input, shared across read tools. */
export const includeCustomColumnsSchema = z
  .union([z.boolean(), z.array(z.string())])
  .optional()
  .describe(
    "Optional. true = include ALL readable custom (non-msdyn_) columns; or pass an array of " +
      "specific logical names. Requires CUSTOM_COLUMNS_MODE!=off on the server (default off — " +
      "ignored otherwise). Use list_custom_columns first to discover what's available.",
  );

export interface CustomColumnsSelection {
  /** Columns eligible to read, keyed by logical name. Empty when disabled/unavailable. */
  columns: Map<string, ColumnMeta>;
  /** Extra $select tokens to append (scalar -> logical name, lookup -> _logicalname_value). */
  selectTokens: string[];
  /** True if the Prefer header should be widened for lookuplogicalname. */
  needsWidenedPrefer: boolean;
  warnings: string[];
}

const EMPTY_SELECTION: CustomColumnsSelection = {
  columns: new Map(),
  selectTokens: [],
  needsWidenedPrefer: false,
  warnings: [],
};

function applyAllowlist(columns: Map<string, ColumnMeta>): Map<string, ColumnMeta> {
  const mode = getCustomColumnsMode();
  if (mode !== "metadata+allowlist") return columns;
  const allow = new Set(getCustomColumnsAllowlist() ?? []);
  const filtered = new Map<string, ColumnMeta>();
  for (const [name, col] of columns) if (allow.has(name)) filtered.set(name, col);
  return filtered;
}

/**
 * Resolves which custom columns are eligible for this read, given the caller's
 * `includeCustomColumns` input. Returns an empty selection (no-op) when the
 * feature is off, the input is falsy, or metadata cannot be read (degrades
 * with a warning rather than throwing — reads never hard-fail for this).
 */
export async function resolveCustomColumnsForRead(
  entity: string,
  include: boolean | string[] | undefined,
): Promise<CustomColumnsSelection> {
  if (!include) return EMPTY_SELECTION;
  const mode = getCustomColumnsMode();
  if (mode === "off") {
    return {
      ...EMPTY_SELECTION,
      warnings: [
        "includeCustomColumns was requested but CUSTOM_COLUMNS_MODE=off on this server — ignored.",
      ],
    };
  }

  let entityMeta;
  try {
    entityMeta = await getEntityMetadata(entity);
  } catch (e) {
    return {
      ...EMPTY_SELECTION,
      warnings: [
        "Could not read custom-column metadata for " +
          entity +
          " — falling back to core fields only. " +
          (e instanceof Error ? e.message : String(e)),
      ],
    };
  }

  let selected: Map<string, ColumnMeta>;
  if (include === true) {
    selected = applyAllowlist(entityMeta.columns);
  } else {
    selected = new Map();
    const warnings: string[] = [];
    const allowlisted = applyAllowlist(entityMeta.columns);
    for (const name of include) {
      if (!isCustomColumnName(name)) {
        warnings.push(`'${name}' is a standard field (msdyn_ prefix) — use the tool's normal output, not includeCustomColumns.`);
        continue;
      }
      const col = allowlisted.get(name);
      if (!col) {
        warnings.push(`Custom column '${name}' was not found on ${entity} (or is blocked by CUSTOM_COLUMNS_ALLOWLIST).`);
        continue;
      }
      selected.set(name, col);
    }
    if (warnings.length) {
      return buildSelection(selected, warnings);
    }
  }

  return buildSelection(selected, []);
}

function buildSelection(columns: Map<string, ColumnMeta>, warnings: string[]): CustomColumnsSelection {
  const selectTokens: string[] = [];
  let needsWidenedPrefer = false;
  for (const col of columns.values()) {
    if (col.type === "lookup" || col.type === "customer" || col.type === "owner") {
      selectTokens.push("_" + col.logicalName + "_value");
      needsWidenedPrefer = true;
    } else if (col.type === "file") {
      // File columns surface name/size shadow attributes, not the logical name itself.
      selectTokens.push(col.logicalName + "_name", col.logicalName + "_size");
    } else {
      selectTokens.push(col.logicalName);
    }
  }
  return { columns, selectTokens, needsWidenedPrefer, warnings };
}

/**
 * Deserializes a raw Dataverse row's custom-column values into a friendly
 * `customFields` object via each column's codec. A column present in the
 * selection but absent from the row (renamed/removed since discovery) is
 * silently skipped — isMissingPropertyError on the OUTER request is what
 * triggers the core-only retry; this function only shapes what came back.
 */
export function deserializeCustomFields(
  selection: CustomColumnsSelection,
  row: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const col of selection.columns.values()) {
    const value = fromRead(col, row);
    if (value !== undefined) out[col.logicalName] = value;
  }
  return out;
}

/**
 * True when a failed request looks like it was caused by a since-removed
 * custom column in the $select — reuses the same detection capabilities.ts
 * already uses for the extended-field probe.
 *
 * IMPORTANT: `isMissingPropertyError` alone only detects the GENERIC "could
 * not find a property named 'x'" 400 shape — it doesn't know WHICH property.
 * When a $select mixes extended task fields AND custom columns, a missing
 * extended field would satisfy this check too. Callers that combine both
 * probes (get_task, list_plan_tasks) MUST also pass the specific custom
 * column names being requested so this only fires for an actual custom-column
 * miss, never misattributing a missing standard field to the custom-column
 * path (which would wrongly clear customSelection while leaving the real
 * cause — a missing standard field — unhandled).
 */
export function isCustomColumnMissingError(
  res: DvResponse,
  requestedCustomLogicalNames: readonly string[],
): boolean {
  if (!isMissingPropertyError(res.status, dvErrorMessage(res))) return false;
  const message = dvErrorMessage(res);
  const match = message.match(/could not find a property named '([^']+)'/i);
  const missingProperty = match?.[1];
  if (!missingProperty) return false;
  // The $select token for a lookup custom column is `_<logical>_value`, not
  // the logical name itself — check both forms.
  return requestedCustomLogicalNames.some(
    (name) => name === missingProperty || "_" + name + "_value" === missingProperty,
  );
}
