/**
 * Metadata retrieval + process-lifetime cache for custom Dataverse columns.
 *
 * Mirrors src/tools/capabilities.ts: module-scoped, single-tenant-per-process
 * (DATAVERSE_ORG_URL is env-fixed), cached for the process lifetime by default
 * with an optional TTL for tenants iterating on schema.
 *
 * Endpoints (all delegated-user GETs, `dvReq(..., { retry: true })`):
 *   - Attributes:      EntityDefinitions(LogicalName='<entity>')/Attributes?$select=...
 *   - Picklist cast:   .../Attributes(LogicalName='<a>')/Microsoft.Dynamics.CRM.PicklistAttributeMetadata?$expand=OptionSet($select=Options)
 *   - MultiSelect cast: .../Microsoft.Dynamics.CRM.MultiSelectPicklistAttributeMetadata?$expand=OptionSet($select=Options)
 *   - DateTime cast:   .../Microsoft.Dynamics.CRM.DateTimeAttributeMetadata?$select=DateTimeBehavior,Format
 *   - Lookups:         EntityDefinitions(LogicalName='<entity>')/ManyToOneRelationships?$select=ReferencingAttribute,ReferencingEntityNavigationPropertyName,ReferencedEntity
 *   - Entity sets:     EntityDefinitions(LogicalName='<target>')?$select=EntitySetName
 *
 * CUSTOM-COLUMN GATE (corrected per the proven schema-scout spec): a column is
 * eligible for the custom-column codec path ONLY if its logical name does NOT
 * start with "msdyn_" (prefix discipline). On this class of entity, nearly
 * every standard msdyn_ field reports IsCustomAttribute:true, so that flag is
 * NOT usable as the gate — it is carried on ColumnMeta only as a weak hint.
 *
 * Graceful degradation:
 *   - Attribute-list 403/error -> throws (caller decides read-degrade vs.
 *     write-fail-closed; see resolveColumn's `required` parameter).
 *   - Type-specific casts (picklist options, date format, multiselect) 403/error
 *     -> the column still resolves, just without options/dateFormat (best-effort).
 *   - Lookup nav-property / entity-set resolution failure -> the lookup column
 *     resolves without navigationProperty/targetEntitySets; toWrite() then
 *     throws its own clear "no navigation property resolved" error at write time.
 */

import { getApiBase, getCustomColumnsMetadataTtlMs } from "../config.js";
import { dvReq, dvHeaders, dvErrorMessage } from "../dataverse.js";
import {
  classifyAttribute,
  type ColumnMeta,
  type RawAttributeMetadata,
} from "./columnTypes.js";

/** Prefix discipline: the custom-column gate. Standard msdyn_ fields are excluded. */
export function isCustomColumnName(logicalName: string): boolean {
  return !/^msdyn_/i.test(logicalName);
}

const ATTRIBUTE_SELECT =
  "LogicalName,SchemaName,AttributeType,AttributeTypeName,IsCustomAttribute," +
  "IsValidForCreate,IsValidForUpdate,IsValidForRead,AttributeOf,SourceType,RequiredLevel";

interface ManyToOneRel {
  ReferencingAttribute: string;
  ReferencingEntityNavigationPropertyName: string;
  ReferencedEntity: string;
}

export interface EntityMetadata {
  entity: string;
  /** Custom (non-msdyn_) columns only, keyed by logical name. */
  columns: Map<string, ColumnMeta>;
  fetchedAt: number;
}

// Module-scoped caches — mirror capabilities.ts's single-tenant-per-process model.
const entityCache = new Map<string, EntityMetadata>();
const entitySetNameCache = new Map<string, string>();
// In-flight promises so concurrent first-calls for the same entity share one
// network round-trip instead of racing duplicate fetches (benign either way,
// but avoids wasted calls under concurrency).
const inflight = new Map<string, Promise<EntityMetadata>>();

function isExpired(m: EntityMetadata): boolean {
  const ttl = getCustomColumnsMetadataTtlMs();
  if (!ttl) return false;
  return Date.now() - m.fetchedAt > ttl;
}

/** Test-only: clears every metadata cache. Mirrors resetCapabilities(). */
export function resetMetadataCache(): void {
  entityCache.clear();
  entitySetNameCache.clear();
  inflight.clear();
}

/** Resolves the plural EntitySetName for an entity logical name (e.g. team -> teams). */
export async function resolveEntitySetName(entityLogicalName: string): Promise<string> {
  const cached = entitySetNameCache.get(entityLogicalName);
  if (cached) return cached;
  const BASE = getApiBase();
  const res = await dvReq(
    {
      url:
        BASE +
        "/EntityDefinitions(LogicalName='" +
        entityLogicalName +
        "')?$select=EntitySetName",
      method: "GET",
      headers: dvHeaders(),
    },
    { retry: true },
  );
  if (res.status >= 400 || !res.json?.EntitySetName) {
    throw new Error(
      "Could not resolve entity-set name for '" +
        entityLogicalName +
        "' (HTTP " +
        res.status +
        "): " +
        dvErrorMessage(res),
    );
  }
  const setName = res.json.EntitySetName as string;
  entitySetNameCache.set(entityLogicalName, setName);
  return setName;
}

async function fetchOptionSet(
  entity: string,
  attribute: string,
  cast: "PicklistAttributeMetadata" | "MultiSelectPicklistAttributeMetadata",
): Promise<Array<{ Value: number; Label?: { UserLocalizedLabel?: { Label?: string } } }> | undefined> {
  const BASE = getApiBase();
  const res = await dvReq(
    {
      url:
        BASE +
        "/EntityDefinitions(LogicalName='" +
        entity +
        "')/Attributes(LogicalName='" +
        attribute +
        "')/Microsoft.Dynamics.CRM." +
        cast +
        "?$expand=OptionSet($select=Options)",
      method: "GET",
      headers: dvHeaders(),
    },
    { retry: true },
  );
  if (res.status >= 400) return undefined; // best-effort — column still usable, just no options
  return res.json?.OptionSet?.Options;
}

async function fetchDateTimeFormat(
  entity: string,
  attribute: string,
): Promise<{ Format?: string; DateTimeBehavior?: { Value?: string } } | undefined> {
  const BASE = getApiBase();
  const res = await dvReq(
    {
      url:
        BASE +
        "/EntityDefinitions(LogicalName='" +
        entity +
        "')/Attributes(LogicalName='" +
        attribute +
        "')/Microsoft.Dynamics.CRM.DateTimeAttributeMetadata?$select=DateTimeBehavior,Format",
      method: "GET",
      headers: dvHeaders(),
    },
    { retry: true },
  );
  if (res.status >= 400) return undefined;
  return res.json;
}

async function fetchManyToOneRelationships(entity: string): Promise<ManyToOneRel[]> {
  const BASE = getApiBase();
  const res = await dvReq(
    {
      url:
        BASE +
        "/EntityDefinitions(LogicalName='" +
        entity +
        "')/ManyToOneRelationships?$select=ReferencingAttribute,ReferencingEntityNavigationPropertyName,ReferencedEntity",
      method: "GET",
      headers: dvHeaders(),
    },
    { retry: true },
  );
  if (res.status >= 400) return []; // best-effort — lookups resolve without nav info
  return res.json?.value ?? [];
}

/**
 * Fetches + classifies every CUSTOM (non-msdyn_) column on `entity`, lazily
 * fanning out to type-specific casts (picklist options, date format,
 * multiselect options) and lookup nav-property/entity-set resolution only for
 * the columns that need them. Fails closed (throws) if the base attribute list
 * itself cannot be read — callers decide whether that means "fail the write"
 * or "degrade the read to raw passthrough".
 */
async function fetchEntityMetadata(entity: string): Promise<EntityMetadata> {
  const BASE = getApiBase();
  const res = await dvReq(
    {
      url:
        BASE +
        "/EntityDefinitions(LogicalName='" +
        entity +
        "')/Attributes?$select=" +
        ATTRIBUTE_SELECT,
      method: "GET",
      headers: dvHeaders(),
    },
    { retry: true },
  );
  if (res.status >= 400) {
    throw new Error(
      "Could not read attribute metadata for '" +
        entity +
        "' (HTTP " +
        res.status +
        "): " +
        dvErrorMessage(res) +
        ". Ask an admin for read privileges on entity/attribute metadata (prvReadEntity/prvReadAttribute), " +
        "or set CUSTOM_COLUMNS_ALLOWLIST with explicit column names to bypass discovery.",
    );
  }

  const rawRows: RawAttributeMetadata[] = (res.json?.value ?? []).filter((row: RawAttributeMetadata) =>
    isCustomColumnName(row.LogicalName),
  );

  // Lazily fan out to type-specific casts, only for columns that need them.
  let relationships: ManyToOneRel[] | undefined;
  const columns = new Map<string, ColumnMeta>();

  for (const row of rawRows) {
    let enriched: RawAttributeMetadata = row;

    if (row.AttributeType === "DateTime") {
      const dt = await fetchDateTimeFormat(entity, row.LogicalName);
      if (dt) enriched = { ...enriched, Format: dt.Format, DateTimeBehavior: dt.DateTimeBehavior };
    } else if (row.AttributeTypeName?.Value === "PicklistType" || row.AttributeType === "Picklist") {
      const options = await fetchOptionSet(entity, row.LogicalName, "PicklistAttributeMetadata");
      if (options) enriched = { ...enriched, OptionSet: { Options: options } };
    } else if (
      row.AttributeTypeName?.Value === "MultiSelectPicklistType" ||
      row.AttributeType === "MultiSelectPicklist"
    ) {
      const options = await fetchOptionSet(entity, row.LogicalName, "MultiSelectPicklistAttributeMetadata");
      if (options) enriched = { ...enriched, OptionSet: { Options: options } };
    }

    const col = classifyAttribute(enriched);

    if (col.type === "lookup" || col.type === "customer" || col.type === "owner") {
      if (relationships === undefined) relationships = await fetchManyToOneRelationships(entity);
      const matches = relationships.filter((r) => r.ReferencingAttribute === row.LogicalName);
      if (matches.length > 0) {
        col.navigationProperty = matches[0].ReferencingEntityNavigationPropertyName;
        col.targets = [...new Set(matches.map((m) => m.ReferencedEntity))];
        const targetEntitySets: Record<string, string> = {};
        for (const target of col.targets) {
          try {
            targetEntitySets[target] = await resolveEntitySetName(target);
          } catch {
            // best-effort — target stays unresolved; toWrite() will surface a
            // clear error naming the missing entity-set at write time.
          }
        }
        col.targetEntitySets = targetEntitySets;
      }
    }

    columns.set(col.logicalName, col);
  }

  return { entity, columns, fetchedAt: Date.now() };
}

/**
 * Returns the (possibly cached) custom-column metadata for `entity`. Concurrent
 * first-calls for the same entity share one in-flight fetch.
 */
export async function getEntityMetadata(entity: string): Promise<EntityMetadata> {
  const cached = entityCache.get(entity);
  if (cached && !isExpired(cached)) return cached;

  const existing = inflight.get(entity);
  if (existing) return existing;

  const promise = fetchEntityMetadata(entity).finally(() => inflight.delete(entity));
  inflight.set(entity, promise);
  const result = await promise;
  entityCache.set(entity, result);
  return result;
}

/**
 * Resolves a single custom column's metadata by logical name. Returns
 * `undefined` if the column is not a custom column (msdyn_ prefix) or is not
 * present on the entity — callers decide how to react (reject on write,
 * degrade on read).
 */
export async function resolveColumn(
  entity: string,
  logicalName: string,
): Promise<ColumnMeta | undefined> {
  if (!isCustomColumnName(logicalName)) return undefined;
  const meta = await getEntityMetadata(entity);
  return meta.columns.get(logicalName);
}

/** Resolves the entity-set name for a lookup target (e.g. "team" -> "teams"). */
export async function resolveLookupTargetSet(target: string): Promise<string> {
  return resolveEntitySetName(target);
}
