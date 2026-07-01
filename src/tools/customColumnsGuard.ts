/**
 * Phase 6 — raw-batch guardrail STRENGTHENING (not weakening).
 *
 * add_tasks_batch / update_tasks_batch (addTasks.ts / updateTasks.ts) already
 * validate entities synchronously via validateAddEntities/validateUpdateEntities
 * (allow-list, blocked-on-create, bind aliases, summary-task protection, the
 * 200-cap). This module adds a SEPARATE, ADDITIONAL, metadata-backed check for
 * any entity key that is a custom (non-msdyn_) column: it must resolve against
 * live metadata and be writable (not computed, valid-for-create/update,
 * supported type), and for a lookup-shaped key (ends in "@odata.bind") the
 * navigation-property name must match what metadata resolved — otherwise
 * REJECT with a precise, teachable error instead of letting PSS fail silently
 * or cryptically later.
 *
 * This turns a silent/cryptic PSS failure into a clear one — a net guardrail
 * strengthening per CLAUDE.md golden rule #1. It is gated behind
 * CUSTOM_COLUMNS_MODE (default "off") so it is entirely opt-in: with the
 * feature off, this module is never invoked and raw-batch behaviour is
 * byte-for-byte unchanged from before this pass.
 *
 * IMPORTANT: this check runs AFTER (in addition to, never instead of) the
 * existing synchronous validateAddEntities/validateUpdateEntities — so the
 * allow-list, blocked-on-create fields, bind-alias teaching, summary-task
 * protection and the 200-entity cap all still fire exactly as before, even
 * when custom keys are present in the same batch.
 */

import { getCustomColumnsMode } from "../config.js";
import { getEntityMetadata, isCustomColumnName } from "../dataverse/metadata.js";
import { toWrite as columnToWrite, type ColumnMeta } from "../dataverse/columnTypes.js";

/** @odata.type suffix -> the Dataverse entity logical name custom-column
 * metadata is looked up against. Only entities that carry genuine custom
 * columns in this design (task, project) are covered; everything else
 * (dependencies, checklist items, label/assignment junction rows, buckets,
 * sprints) has no custom-column story here and is left untouched by this guard. */
const CUSTOM_COLUMN_ENTITIES: Record<string, string> = {
  "Microsoft.Dynamics.CRM.msdyn_projecttask": "msdyn_projecttask",
  "Microsoft.Dynamics.CRM.msdyn_project": "msdyn_project",
};

// Keys that are structural, not column data, and must never be treated as a
// custom-column write target even though they don't start with msdyn_ (there
// are none in this schema today, but @odata.type/@odata.bind suffix handling
// below already excludes the only real cases: the OData envelope key itself).
const NON_COLUMN_KEYS = new Set(["@odata.type"]);

/**
 * Returns the custom (non-msdyn_) keys on `ent` that need metadata validation:
 * scalar keys and "@odata.bind"-suffixed lookup keys whose BASE name (nav
 * property, stripped of the @odata.bind suffix) doesn't start with msdyn_.
 * Standard msdyn_* keys (scalar or bind) are left entirely to the existing
 * synchronous guardrails — this function only ever looks at the custom-prefix
 * subset.
 */
function customKeysOf(ent: Record<string, unknown>): Array<{ key: string; isBind: boolean; base: string }> {
  const out: Array<{ key: string; isBind: boolean; base: string }> = [];
  for (const key of Object.keys(ent)) {
    if (NON_COLUMN_KEYS.has(key)) continue;
    const isBind = key.endsWith("@odata.bind");
    const base = isBind ? key.slice(0, -"@odata.bind".length) : key;
    if (isCustomColumnName(base)) out.push({ key, isBind, base });
  }
  return out;
}

/**
 * Validates every custom-column key across `entities` against live metadata.
 * No-op (returns immediately) when CUSTOM_COLUMNS_MODE=off, so this never runs
 * unless the operator opted in. Fails CLOSED with a specific, actionable error
 * on the first problem found — never a silent drop.
 *
 * `mode` is "create" for add_tasks_batch, "update" for update_tasks_batch.
 */
export async function validateCustomColumnKeys(
  entities: any[],
  mode: "create" | "update",
): Promise<void> {
  if (getCustomColumnsMode() === "off") return;
  if (!Array.isArray(entities)) return;

  // Cache metadata per entity logical name across the batch (avoid refetching
  // per row — getEntityMetadata is itself process-lifetime cached too, but
  // this keeps the loop below simple and avoids repeat cache-map lookups).
  const metaByEntity = new Map<string, Awaited<ReturnType<typeof getEntityMetadata>>>();
  const navIndexByEntity = new Map<string, Map<string, ColumnMeta>>();

  for (let i = 0; i < entities.length; i++) {
    const ent = entities[i];
    if (!ent || typeof ent !== "object") continue;
    const odataType = ent["@odata.type"];
    const entityLogicalName = typeof odataType === "string" ? CUSTOM_COLUMN_ENTITIES[odataType] : undefined;

    const custom = customKeysOf(ent);
    if (custom.length === 0) continue;

    if (!entityLogicalName) {
      // A custom-prefixed key on an entity type this design doesn't model
      // custom columns for (dependency, checklist, label, assignment, bucket,
      // sprint). Reject rather than silently letting it ride to PSS unchecked.
      throw new Error(
        "entities[" +
          i +
          "]: key(s) " +
          custom.map((c) => c.key).join(", ") +
          " look like custom (non-msdyn_) columns, but " +
          (typeof odataType === "string" ? odataType : "this entity type") +
          " does not support custom columns in this server. Only msdyn_projecttask and msdyn_project do.",
      );
    }

    let meta = metaByEntity.get(entityLogicalName);
    if (!meta) {
      meta = await getEntityMetadata(entityLogicalName);
      metaByEntity.set(entityLogicalName, meta);
    }
    // Index lookup/customer/owner columns by their resolved navigation-property
    // name (case-sensitive — that casing IS the trap this guard exists to
    // catch), so a "@odata.bind" key can be matched even though ColumnMeta is
    // keyed by logical name, not nav name.
    let navIndex = navIndexByEntity.get(entityLogicalName);
    if (!navIndex) {
      navIndex = new Map();
      for (const c of meta.columns.values()) {
        if (c.navigationProperty) navIndex.set(c.navigationProperty, c);
      }
      navIndexByEntity.set(entityLogicalName, navIndex);
    }

    for (const { key, isBind, base } of custom) {
      if (isBind) {
        // A lookup/customer/owner column MUST be written via its resolved
        // navigation-property @odata.bind key, never the logical name — try
        // the nav-property index first (the correct form), then fall back to
        // treating `base` as a logical name (the common mistake) so the error
        // can teach the right key.
        const byNav = navIndex.get(base);
        if (byNav) continue; // correct nav key — nothing further to check here.

        const byLogicalName = meta.columns.get(base);
        if (!byLogicalName) {
          throw new Error(
            "entities[" +
              i +
              "]: '" +
              key +
              "' is not a known custom column on " +
              entityLogicalName +
              ". Use list_custom_columns to discover valid names.",
          );
        }
        if (!["lookup", "customer", "owner"].includes(byLogicalName.type)) {
          throw new Error(
            "entities[" +
              i +
              "]: '" +
              key +
              "' uses @odata.bind, but '" +
              base +
              "' is a " +
              byLogicalName.type +
              " column, not a lookup. Write it as a plain '" +
              base +
              "' key with the scalar/option value, not an @odata.bind.",
          );
        }
        if (!byLogicalName.navigationProperty) {
          throw new Error(
            "entities[" +
              i +
              "]: '" +
              key +
              "': no navigation property could be resolved from metadata for '" +
              base +
              "'. describe_columns can show what metadata found (if anything).",
          );
        }
        throw new Error(
          "entities[" +
            i +
            "]: '" +
            key +
            "' is not the correct navigation-property key for lookup column '" +
            base +
            "'. Use '" +
            byLogicalName.navigationProperty +
            "@odata.bind' instead (resolved from metadata) — value unchanged.",
        );
      }

      // Non-bind key: scalar / option-set / date / guid column. Run it through
      // the SAME codec the ergonomic path uses (columnTypes.toWrite), which
      // enforces isComputed / isValidForCreate/Update / supported-type / value
      // shape. We only care that it throws on a bad column; the returned
      // fragment is discarded (the raw caller's own value is sent as-is to PSS).
      const col = meta.columns.get(base);
      if (!col) {
        throw new Error(
          "entities[" +
            i +
            "]: '" +
            key +
            "' is not a known custom column on " +
            entityLogicalName +
            ". Use list_custom_columns to discover valid names.",
        );
      }
      columnToWrite(col, ent[key], mode);
    }
  }
}
