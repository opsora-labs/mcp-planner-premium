import { z } from "zod";
import { getCustomColumnsMode } from "../config.js";
import { getEntityMetadata } from "../dataverse/metadata.js";
import type { ColumnMeta } from "../dataverse/columnTypes.js";
import type { ToolDef } from "./types.js";

/** Ergonomic entity alias -> Dataverse logical name. */
const ENTITY_MAP: Record<string, string> = {
  project: "msdyn_project",
  task: "msdyn_projecttask",
};

function summarizeColumn(col: ColumnMeta) {
  const readOnlyReasons: string[] = [];
  if (col.isComputed) readOnlyReasons.push("calculated/rollup column");
  if (col.type === "state") readOnlyReasons.push("engine/lifecycle-managed (state)");
  if (col.type === "status") readOnlyReasons.push("transition-guarded (status)");
  if (col.type === "image") readOnlyReasons.push("image columns use a dedicated upload endpoint");
  if (col.type === "file") readOnlyReasons.push("file columns use a dedicated upload endpoint");
  if (col.type === "unsupported") readOnlyReasons.push("type not supported by this server");
  if (!col.isValidForCreate && !col.isValidForUpdate) readOnlyReasons.push("not valid for create or update");

  const writable =
    !col.isComputed &&
    (col.isValidForCreate || col.isValidForUpdate) &&
    !["state", "status", "image", "file", "unsupported"].includes(col.type);

  return {
    logicalName: col.logicalName,
    schemaName: col.schemaName,
    type: col.type,
    writable,
    ...(writable ? {} : { readOnlyReason: readOnlyReasons.join("; ") || "not writable" }),
    ...(col.options ? { options: col.options } : {}),
    ...(col.targets ? { lookupTargets: col.targets } : {}),
  };
}

export const listCustomColumns: ToolDef = {
  name: "list_custom_columns",
  title: "List Custom Columns",
  description:
    "Discovers customer-added Dataverse columns (logical name does NOT start with msdyn_) on the plan (project) or task entity, via live metadata - so you learn the real schema instead of guessing field names. Returns { logicalName, schemaName, type, writable, readOnlyReason?, options?, lookupTargets? } per column. Read-only. Requires CUSTOM_COLUMNS_MODE!=off on the server (returns ok:false with an explanatory note when off). Use before passing includeCustomColumns to get_task/list_plan_tasks/get_plan_summary, or before writing custom fields.",
  inputSchema: {
    entity: z.enum(["project", "task"]).describe("Which entity to inspect: 'project' (a plan) or 'task'."),
  },
  handler: async (input: { entity: "project" | "task" }) => {
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
    const columns = [...meta.columns.values()]
      .map(summarizeColumn)
      .sort((a, b) => a.logicalName.localeCompare(b.logicalName));

    return {
      ok: true,
      entity: input.entity,
      entityLogicalName,
      count: columns.length,
      columns,
    };
  },
};
