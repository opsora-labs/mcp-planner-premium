import { z } from "zod";
import { getCustomColumnsMode } from "../config.js";
import { getEntityMetadata, isCustomColumnName } from "../dataverse/metadata.js";
import type { ColumnMeta } from "../dataverse/columnTypes.js";
import type { ToolDef } from "./types.js";

/** Ergonomic entity alias -> Dataverse logical name. Shared with list_custom_columns. */
const ENTITY_MAP: Record<string, string> = {
  project: "msdyn_project",
  task: "msdyn_projecttask",
};

function detail(col: ColumnMeta) {
  return {
    logicalName: col.logicalName,
    schemaName: col.schemaName,
    type: col.type,
    isValidForCreate: col.isValidForCreate,
    isValidForUpdate: col.isValidForUpdate,
    isComputed: col.isComputed,
    ...(col.options ? { options: col.options } : {}),
    ...(col.dateFormat ? { dateFormat: col.dateFormat } : {}),
    ...(col.navigationProperty ? { navigationProperty: col.navigationProperty } : {}),
    ...(col.targets ? { lookupTargets: col.targets } : {}),
    ...(col.targetEntitySets ? { lookupTargetEntitySets: col.targetEntitySets } : {}),
  };
}

export const describeColumns: ToolDef = {
  name: "describe_columns",
  title: "Describe Columns",
  description:
    "Returns deep detail for named customer-added Dataverse columns on the plan (project) or task entity: normalized type, create/update validity, computed flag, option-set values+labels (picklist/multiselect), date format, and lookup navigation-property/target-entity/entity-set info. A superset of describe_option_set for the custom-column case (describe_option_set still works for standard fields). Read-only. Requires CUSTOM_COLUMNS_MODE!=off on the server.",
  inputSchema: {
    entity: z.enum(["project", "task"]).describe("Which entity to inspect: 'project' (a plan) or 'task'."),
    columns: z
      .array(z.string())
      .min(1)
      .describe("Logical names of the custom columns to describe, e.g. ['new_riskscore','new_category']."),
  },
  handler: async (input: { entity: "project" | "task"; columns: string[] }) => {
    const mode = getCustomColumnsMode();
    if (mode === "off") {
      return {
        ok: false,
        note: "CUSTOM_COLUMNS_MODE is 'off' on this server - custom-column discovery is disabled. Ask the server operator to set CUSTOM_COLUMNS_MODE=metadata (or metadata+allowlist).",
        columns: [],
      };
    }

    const entityLogicalName = ENTITY_MAP[input.entity];
    const meta = await getEntityMetadata(entityLogicalName);

    const found: ReturnType<typeof detail>[] = [];
    const notFound: string[] = [];
    for (const name of input.columns) {
      if (!isCustomColumnName(name)) {
        notFound.push(name + " (standard msdyn_ field - not a custom column)");
        continue;
      }
      const col = meta.columns.get(name);
      if (!col) {
        notFound.push(name);
        continue;
      }
      found.push(detail(col));
    }

    return {
      ok: true,
      entity: input.entity,
      entityLogicalName,
      columns: found,
      ...(notFound.length ? { notFound } : {}),
    };
  },
};
