/**
 * Normalized type registry for custom Dataverse columns.
 *
 * Pure module — no network calls. Maps raw Dataverse attribute metadata into a
 * normalized internal type, and provides a per-type codec (`toWrite`/`fromRead`)
 * that serializes a caller value into the correct OData write-payload fragment
 * and deserializes a read row back into a friendly JSON shape.
 *
 * IMPORTANT — three corrections vs. the original design doc, proven live against
 * a real tenant by the schema-scout probe (see docs/plans/40-custom-columns.md
 * and the scout spec). This module implements the PROVEN shapes:
 *
 * 1. "Custom" is NOT determined by `IsCustomAttribute` — on this tenant nearly
 *    every standard `msdyn_` field reports `IsCustomAttribute:true`. The custom
 *    gate lives OUTSIDE this module (prefix discipline: logical name does not
 *    start with `msdyn_`), applied by the metadata layer / calling tools.
 *    `isCustom` is carried on ColumnMeta only as a weak hint, never load-bearing.
 * 2. DateOnly vs. DateTime is decided by the top-level `Format` field
 *    ("DateOnly" vs "DateAndTime"), NOT `DateTimeBehavior` (which is only ever
 *    "UserLocal" or "TimeZoneIndependent" — it never signals date-only).
 * 3. Lookup target logical name on read comes from the
 *    `...@Microsoft.Dynamics.CRM.lookuplogicalname` annotation, which requires a
 *    widened `Prefer` header (see readHelpers.ts). fromRead() accepts that
 *    annotation as an explicit input rather than guessing it from FormattedValue.
 */

import { assertGuid, isGuid } from "../dataverse.js";

export type NormalizedType =
  | "string"
  | "memo"
  | "int"
  | "bigint"
  | "decimal"
  | "double"
  | "money"
  | "boolean"
  | "dateonly"
  | "datetime"
  | "picklist"
  | "multipicklist"
  | "lookup"
  | "customer"
  | "owner"
  | "uniqueidentifier"
  | "state"
  | "status"
  | "image"
  | "file"
  | "unsupported";

export interface PicklistOption {
  value: number;
  label: string | null;
}

export interface ColumnMeta {
  /** e.g. "new_riskscore" */
  logicalName: string;
  /** e.g. "new_RiskScore" — casing hint only, never used as a write key. */
  schemaName: string;
  type: NormalizedType;
  /** IsCustomAttribute — weak hint only. NOT the custom-column gate. */
  isCustom: boolean;
  isValidForCreate: boolean;
  isValidForUpdate: boolean;
  /** (SourceType > 0) || (AttributeOf != null). Calculated/rollup/derived shadow. */
  isComputed: boolean;

  // Lookup / Customer / Owner only.
  /** The @odata.bind key, e.g. "new_OwnerTeam" (nav name, NOT the logical name). */
  navigationProperty?: string;
  /** Target entity logical names. >1 means polymorphic (Customer / owner-like). */
  targets?: string[];
  /** logicalName -> EntitySetName, e.g. { team: "teams", systemuser: "systemusers" } */
  targetEntitySets?: Record<string, string>;

  // Picklist / MultiSelectPicklist only.
  options?: PicklistOption[];

  // DateTime only: "DateOnly" | "DateAndTime" (top-level Format field — NOT
  // DateTimeBehavior). Informational; `type` already encodes dateonly vs datetime.
  dateFormat?: "DateOnly" | "DateAndTime";
}

export interface TypeCodec {
  /**
   * Builds the OData write payload fragment(s) for this column: an array of
   * [key, value] pairs to splice into the entity object being sent to
   * msdyn_PssCreateV2 / msdyn_PssUpdateV2 (or msdyn_CreateProjectV1's Project
   * body). Lookups return a DIFFERENT key (navProp + "@odata.bind") than the
   * logical name; scalars return the logical name unchanged. Throws a clear,
   * actionable error on an invalid/unsupported input.
   */
  toWrite(col: ColumnMeta, input: unknown): Array<[string, unknown]>;
  /**
   * Shapes a read value (+ its FormattedValue / lookuplogicalname annotations,
   * present as sibling keys on `row`) into the surfaced JSON value.
   */
  fromRead(col: ColumnMeta, row: Record<string, unknown>): unknown;
}

const FORMATTED_SUFFIX = "@OData.Community.Display.V1.FormattedValue";
const LOOKUP_LOGICAL_NAME_SUFFIX = "@Microsoft.Dynamics.CRM.lookuplogicalname";

function formattedValue(row: Record<string, unknown>, key: string): string | null {
  const v = row[key + FORMATTED_SUFFIX];
  return typeof v === "string" ? v : null;
}

function rejectBoundary(col: ColumnMeta, reason: string): never {
  throw new Error(`Column '${col.logicalName}' cannot be written: ${reason}`);
}

function assertWritable(col: ColumnMeta, mode: "create" | "update"): void {
  if (col.isComputed)
    rejectBoundary(col, "it is a calculated/rollup/derived column (read-only).");
  if (mode === "create" && !col.isValidForCreate)
    rejectBoundary(col, "it is not valid for create on this entity (IsValidForCreate=false).");
  if (mode === "update" && !col.isValidForUpdate)
    rejectBoundary(col, "it is not valid for update on this entity (IsValidForUpdate=false).");
}

// ---------------------------------------------------------------------------
// Scalar codecs (string/memo/int/bigint/decimal/double/money/boolean/guid)
// ---------------------------------------------------------------------------

function scalarCodec(
  validate: (col: ColumnMeta, v: unknown) => unknown,
  readShape?: (col: ColumnMeta, raw: unknown, formatted: string | null) => unknown,
): TypeCodec {
  return {
    toWrite(col, input) {
      return [[col.logicalName, validate(col, input)]];
    },
    fromRead(col, row) {
      const raw = row[col.logicalName];
      if (raw === undefined) return undefined;
      const formatted = formattedValue(row, col.logicalName);
      return readShape ? readShape(col, raw, formatted) : (raw as unknown);
    },
  };
}

function requireDefined(col: ColumnMeta, v: unknown): unknown {
  if (v === undefined || v === null)
    rejectBoundary(col, "value is required (received null/undefined).");
  return v;
}

const stringCodec: TypeCodec = scalarCodec((col, v) => {
  requireDefined(col, v);
  if (typeof v !== "string") rejectBoundary(col, `expected a string, got ${typeof v}.`);
  return v;
});

const memoCodec: TypeCodec = scalarCodec((col, v) => {
  requireDefined(col, v);
  if (typeof v !== "string") rejectBoundary(col, `expected a string, got ${typeof v}.`);
  return v;
});

const intCodec: TypeCodec = scalarCodec((col, v) => {
  requireDefined(col, v);
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n) || !Number.isInteger(n))
    rejectBoundary(col, `expected an integer, got ${JSON.stringify(v)}.`);
  return n;
});

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

const bigintCodec: TypeCodec = scalarCodec((col, v) => {
  requireDefined(col, v);
  if (typeof v === "bigint") {
    return v > MAX_SAFE || v < -MAX_SAFE ? v.toString() : Number(v);
  }
  if (typeof v === "number") {
    if (!Number.isInteger(v)) rejectBoundary(col, `expected an integer, got ${v}.`);
    return v;
  }
  if (typeof v === "string" && /^-?\d+$/.test(v)) {
    // Numeric-string safety past 2^53 — send as string when it exceeds the safe range.
    const n = Number(v);
    return Math.abs(n) > MAX_SAFE ? v : n;
  }
  rejectBoundary(col, `expected an integer or numeric string, got ${JSON.stringify(v)}.`);
});

const decimalCodec: TypeCodec = scalarCodec((col, v) => {
  requireDefined(col, v);
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n))
    rejectBoundary(col, `expected a number, got ${JSON.stringify(v)}.`);
  return n;
});

const doubleCodec: TypeCodec = decimalCodec;

const moneyCodec: TypeCodec = scalarCodec(
  (col, v) => {
    requireDefined(col, v);
    const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
    if (typeof n !== "number" || !Number.isFinite(n))
      rejectBoundary(col, `expected a numeric amount, got ${JSON.stringify(v)}.`);
    return n;
  },
  (_col, raw, formatted) => ({ value: raw, formatted: formatted ?? null }),
);

const booleanCodec: TypeCodec = scalarCodec(
  (col, v) => {
    requireDefined(col, v);
    if (typeof v !== "boolean") rejectBoundary(col, `expected a boolean, got ${typeof v}.`);
    return v;
  },
  (_col, raw, formatted) => ({ value: raw, label: formatted ?? null }),
);

const uniqueidentifierCodec: TypeCodec = scalarCodec((col, v) => {
  if (typeof v !== "string") rejectBoundary(col, `expected a GUID string, got ${typeof v}.`);
  return assertGuid(v, col.logicalName);
});

// ---------------------------------------------------------------------------
// Date codecs — dateonly decided by top-level Format (corrected per spec).
// ---------------------------------------------------------------------------

const DATEONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

const dateonlyCodec: TypeCodec = {
  toWrite(col, input) {
    requireDefined(col, input);
    if (typeof input !== "string" || !DATEONLY_RE.test(input))
      rejectBoundary(col, `expected "YYYY-MM-DD", got ${JSON.stringify(input)}.`);
    return [[col.logicalName, input]];
  },
  fromRead(col, row) {
    const raw = row[col.logicalName];
    return raw === undefined ? undefined : (raw as unknown);
  },
};

const datetimeCodec: TypeCodec = {
  toWrite(col, input) {
    requireDefined(col, input);
    if (typeof input !== "string") rejectBoundary(col, `expected an ISO-8601 string.`);
    const d = new Date(input);
    if (Number.isNaN(d.getTime()))
      rejectBoundary(col, `expected a valid ISO-8601 datetime, got ${JSON.stringify(input)}.`);
    return [[col.logicalName, d.toISOString()]];
  },
  fromRead(col, row) {
    const raw = row[col.logicalName];
    return raw === undefined ? undefined : (raw as unknown);
  },
};

// ---------------------------------------------------------------------------
// Picklist / MultiSelectPicklist — label-or-value input, {value,label} output.
// ---------------------------------------------------------------------------

function resolveOptionValue(col: ColumnMeta, input: unknown): number {
  const options = col.options ?? [];
  if (typeof input === "number") {
    if (!options.some((o) => o.value === input) && options.length > 0) {
      rejectBoundary(
        col,
        `${input} is not a valid option value. Valid: ${options
          .map((o) => `${o.value}${o.label ? ` (${o.label})` : ""}`)
          .join(", ")}`,
      );
    }
    return input;
  }
  if (typeof input === "string") {
    const match = options.find((o) => (o.label ?? "").toLowerCase() === input.toLowerCase());
    if (!match) {
      rejectBoundary(
        col,
        `no option labeled '${input}'. Valid labels: ${options
          .map((o) => o.label ?? `(unlabeled ${o.value})`)
          .join(", ")}`,
      );
    }
    return match.value;
  }
  rejectBoundary(col, `expected an option label (string) or value (number), got ${typeof input}.`);
}

const picklistCodec: TypeCodec = {
  toWrite(col, input) {
    requireDefined(col, input);
    return [[col.logicalName, resolveOptionValue(col, input)]];
  },
  fromRead(col, row) {
    const raw = row[col.logicalName];
    if (raw === undefined) return undefined;
    const formatted = formattedValue(row, col.logicalName);
    return { value: raw, label: formatted ?? null };
  },
};

const multipicklistCodec: TypeCodec = {
  toWrite(col, input) {
    requireDefined(col, input);
    const items: unknown[] = Array.isArray(input) ? input : [input];
    if (items.length === 0) rejectBoundary(col, "expected at least one option value/label.");
    const values = items.map((i) => resolveOptionValue(col, i));
    return [[col.logicalName, values.join(",")]];
  },
  fromRead(col, row) {
    const raw = row[col.logicalName];
    if (raw === undefined) return undefined;
    const formatted = formattedValue(row, col.logicalName);
    const values =
      typeof raw === "string"
        ? raw
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
            .map(Number)
        : Array.isArray(raw)
          ? (raw as unknown[]).map(Number)
          : [];
    const labels = formatted
      ? formatted
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
    return { values, labels };
  },
};

// ---------------------------------------------------------------------------
// Lookup / Customer / Owner — resolved nav-property @odata.bind.
// ---------------------------------------------------------------------------

export interface LookupInput {
  id: string;
  /** Required only when the column is polymorphic (col.targets.length > 1). */
  target?: string;
}

function normalizeLookupInput(input: unknown): LookupInput {
  if (typeof input === "string") return { id: input };
  if (input && typeof input === "object") {
    const obj = input as Record<string, unknown>;
    if (typeof obj.id !== "string") throw new Error("Lookup input requires an 'id' GUID.");
    return {
      id: obj.id,
      target: typeof obj.target === "string" ? obj.target : undefined,
    };
  }
  throw new Error("Lookup input must be a GUID string or { target, id }.");
}

function buildLookupWrite(col: ColumnMeta, input: unknown): Array<[string, unknown]> {
  requireDefined(col, input);
  const { id, target } = normalizeLookupInput(input);
  const guid = assertGuid(id, `${col.logicalName}.id`);
  if (!col.navigationProperty)
    rejectBoundary(col, "no navigation property was resolved from metadata for this lookup.");
  const targets = col.targets ?? [];
  let resolvedTarget: string | undefined = target;
  if (!resolvedTarget) {
    if (targets.length === 1) resolvedTarget = targets[0];
    else if (targets.length > 1)
      rejectBoundary(
        col,
        `this is a polymorphic lookup — pass { target, id } with target one of: ${targets.join(", ")}`,
      );
  } else if (targets.length > 0 && !targets.includes(resolvedTarget)) {
    rejectBoundary(
      col,
      `target '${resolvedTarget}' is not valid for this column. Valid targets: ${targets.join(", ")}`,
    );
  }
  if (!resolvedTarget) rejectBoundary(col, "could not resolve a target entity for this lookup.");
  const entitySet = col.targetEntitySets?.[resolvedTarget];
  if (!entitySet)
    rejectBoundary(
      col,
      `no entity-set name resolved for target '${resolvedTarget}' (metadata incomplete).`,
    );
  return [[col.navigationProperty + "@odata.bind", `/${entitySet}(${guid})`]];
}

function buildLookupRead(col: ColumnMeta, row: Record<string, unknown>): unknown {
  const valueKey = "_" + col.logicalName + "_value";
  const raw = row[valueKey];
  if (raw === undefined) return undefined;
  const formatted = formattedValue(row, valueKey);
  const logicalNameAnnotation = row[valueKey + LOOKUP_LOGICAL_NAME_SUFFIX];
  return {
    id: raw ?? null,
    logicalName: typeof logicalNameAnnotation === "string" ? logicalNameAnnotation : null,
    name: formatted,
  };
}

const lookupCodec: TypeCodec = {
  toWrite: buildLookupWrite,
  fromRead: buildLookupRead,
};

const customerCodec: TypeCodec = {
  toWrite: buildLookupWrite,
  fromRead: buildLookupRead,
};

const ownerCodec: TypeCodec = {
  toWrite: buildLookupWrite,
  fromRead: buildLookupRead,
};

// ---------------------------------------------------------------------------
// Boundary types — reject-don't-guess.
// ---------------------------------------------------------------------------

function boundaryCodec(readOnlyLabel: string): TypeCodec {
  return {
    toWrite(col) {
      rejectBoundary(col, readOnlyLabel);
    },
    fromRead(col, row) {
      const raw = row[col.logicalName];
      if (raw === undefined) return undefined;
      const formatted = formattedValue(row, col.logicalName);
      return { value: raw, label: formatted ?? null };
    },
  };
}

const stateCodec: TypeCodec = boundaryCodec(
  "State columns are engine/lifecycle-managed and cannot be written directly here.",
);
const statusCodec: TypeCodec = boundaryCodec(
  "Status columns are transition-guarded and are read-only through this server by default.",
);
const imageCodec: TypeCodec = {
  toWrite(col) {
    rejectBoundary(
      col,
      "Image columns are out of scope for this server — use the dedicated Web API image upload " +
        `endpoint (PATCH .../${col.logicalName} with a binary body), not this JSON write path.`,
    );
  },
  fromRead(col, row) {
    const raw = row[col.logicalName];
    return raw === undefined ? undefined : { hasImage: raw != null };
  },
};
const fileCodec: TypeCodec = {
  toWrite(col) {
    rejectBoundary(
      col,
      "File columns are out of scope for this server — use the Dataverse file-upload session " +
        `endpoints for '${col.logicalName}', not this JSON write path.`,
    );
  },
  fromRead(col, row) {
    const nameKey = col.logicalName + "_name";
    const sizeKey = col.logicalName + "_size";
    const name = row[nameKey];
    const size = row[sizeKey];
    if (name === undefined && size === undefined && row[col.logicalName] === undefined)
      return undefined;
    return { fileName: name ?? null, fileSize: size ?? null };
  },
};
const unsupportedCodec: TypeCodec = {
  toWrite(col) {
    rejectBoundary(col, `type is not supported by this server.`);
  },
  fromRead(col, row) {
    return row[col.logicalName];
  },
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const CODECS: Record<NormalizedType, TypeCodec> = {
  string: stringCodec,
  memo: memoCodec,
  int: intCodec,
  bigint: bigintCodec,
  decimal: decimalCodec,
  double: doubleCodec,
  money: moneyCodec,
  boolean: booleanCodec,
  dateonly: dateonlyCodec,
  datetime: datetimeCodec,
  picklist: picklistCodec,
  multipicklist: multipicklistCodec,
  lookup: lookupCodec,
  customer: customerCodec,
  owner: ownerCodec,
  uniqueidentifier: uniqueidentifierCodec,
  state: stateCodec,
  status: statusCodec,
  image: imageCodec,
  file: fileCodec,
  unsupported: unsupportedCodec,
};

/**
 * Splices a value into the correct write-payload fragment for `col`, after
 * confirming it's writable in `mode` (throws a clear error otherwise — never a
 * silent drop). This is the single entry point tools/builders should call.
 */
export function toWrite(
  col: ColumnMeta,
  input: unknown,
  mode: "create" | "update",
): Array<[string, unknown]> {
  assertWritable(col, mode);
  return CODECS[col.type].toWrite(col, input);
}

/** Deserializes a read row's value for `col` into the surfaced JSON shape. */
export function fromRead(col: ColumnMeta, row: Record<string, unknown>): unknown {
  return CODECS[col.type].fromRead(col, row);
}

// ---------------------------------------------------------------------------
// Raw metadata -> ColumnMeta classification.
// ---------------------------------------------------------------------------

/** Single-key `{ Value }` wrapper shape used by AttributeTypeName / DateTimeBehavior. */
export interface RawValueWrapper {
  Value?: string;
}

export interface RawAttributeMetadata {
  LogicalName: string;
  SchemaName: string;
  AttributeType?: string;
  AttributeTypeName?: RawValueWrapper;
  IsCustomAttribute?: boolean;
  IsValidForCreate?: boolean;
  IsValidForUpdate?: boolean;
  IsValidForRead?: boolean;
  AttributeOf?: string | null;
  SourceType?: number | null;
  RequiredLevel?: { Value?: string; CanBeChanged?: boolean };
  // Populated by lazy type-specific casts (see metadata.ts):
  OptionSet?: { Options?: Array<{ Value: number; Label?: { UserLocalizedLabel?: { Label?: string } } }> };
  Format?: "DateOnly" | "DateAndTime" | string;
  DateTimeBehavior?: RawValueWrapper;
  // Populated by the lookup resolver (metadata.ts), not present on the raw
  // attribute row itself:
  navigationProperty?: string;
  targets?: string[];
  targetEntitySets?: Record<string, string>;
}

const ATTRIBUTE_TYPE_NAME_MAP: Record<string, NormalizedType> = {
  StringType: "string",
  MemoType: "memo",
  IntegerType: "int",
  BigIntType: "bigint",
  DecimalType: "decimal",
  DoubleType: "double",
  MoneyType: "money",
  BooleanType: "boolean",
  PicklistType: "picklist",
  MultiSelectPicklistType: "multipicklist",
  LookupType: "lookup",
  OwnerType: "owner",
  CustomerType: "customer",
  UniqueidentifierType: "uniqueidentifier",
  StateType: "state",
  StatusType: "status",
  ImageType: "image",
  FileType: "file",
  EntityNameType: "unsupported",
  VirtualType: "unsupported",
};

// Fallback map keyed on the coarser `AttributeType` field, used only when
// AttributeTypeName.Value is missing or unrecognized.
const ATTRIBUTE_TYPE_MAP: Record<string, NormalizedType> = {
  String: "string",
  Memo: "memo",
  Integer: "int",
  BigInt: "bigint",
  Decimal: "decimal",
  Double: "double",
  Money: "money",
  Boolean: "boolean",
  Picklist: "picklist",
  MultiSelectPicklist: "multipicklist",
  Lookup: "lookup", // NOTE: Owner shares this @odata.type; AttributeType disambiguates.
  Owner: "owner",
  Customer: "customer",
  Uniqueidentifier: "uniqueidentifier",
  State: "state",
  Status: "status",
  Virtual: "unsupported",
  EntityName: "unsupported",
};

/**
 * Classifies a raw attribute-metadata row into a normalized ColumnMeta.
 * DateTime needs special handling: AttributeType/AttributeTypeName alone are
 * ambiguous between dateonly and datetime — the caller must have already
 * fetched the DateTimeAttributeMetadata cast and merged `Format` onto `raw`
 * (metadata.ts does this lazily). If `Format` is absent for a DateTime
 * attribute, we default to "datetime" (the safer / more common case) but this
 * should not happen once metadata.ts has fetched the cast.
 */
export function classifyAttribute(raw: RawAttributeMetadata): ColumnMeta {
  const logicalName = raw.LogicalName;
  const schemaName = raw.SchemaName ?? raw.LogicalName;
  const isComputed = (typeof raw.SourceType === "number" && raw.SourceType > 0) || raw.AttributeOf != null;

  let type: NormalizedType;
  if (raw.AttributeType === "DateTime") {
    // Corrected per spec: Format decides dateonly, NOT DateTimeBehavior.
    type = raw.Format === "DateOnly" ? "dateonly" : "datetime";
  } else {
    const byTypeName = raw.AttributeTypeName?.Value
      ? ATTRIBUTE_TYPE_NAME_MAP[raw.AttributeTypeName.Value]
      : undefined;
    const byType = raw.AttributeType ? ATTRIBUTE_TYPE_MAP[raw.AttributeType] : undefined;
    type = byTypeName ?? byType ?? "unsupported";
  }

  const col: ColumnMeta = {
    logicalName,
    schemaName,
    type,
    isCustom: raw.IsCustomAttribute === true,
    isValidForCreate: raw.IsValidForCreate === true,
    isValidForUpdate: raw.IsValidForUpdate === true,
    isComputed,
  };

  if (type === "picklist" || type === "multipicklist") {
    col.options = (raw.OptionSet?.Options ?? []).map((o) => ({
      value: o.Value,
      label: o.Label?.UserLocalizedLabel?.Label ?? null,
    }));
  }
  if (type === "dateonly" || type === "datetime") {
    col.dateFormat = raw.Format === "DateOnly" ? "DateOnly" : "DateAndTime";
  }
  if (type === "lookup" || type === "customer" || type === "owner") {
    if (raw.navigationProperty) col.navigationProperty = raw.navigationProperty;
    if (raw.targets) col.targets = raw.targets;
    if (raw.targetEntitySets) col.targetEntitySets = raw.targetEntitySets;
  }

  return col;
}

export { isGuid };
