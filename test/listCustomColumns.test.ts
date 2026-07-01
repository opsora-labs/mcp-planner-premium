import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const getEntityMetadataMock = vi.fn();
vi.mock("../src/dataverse/metadata.js", async () => {
  const actual = await vi.importActual<typeof import("../src/dataverse/metadata.js")>(
    "../src/dataverse/metadata.js",
  );
  return {
    ...actual,
    getEntityMetadata: (...args: unknown[]) => getEntityMetadataMock(...args),
  };
});

import { listCustomColumns } from "../src/tools/listCustomColumns.js";
import { resetEnvCache } from "../src/config.js";
import type { ColumnMeta } from "../src/dataverse/columnTypes.js";

const BASE_ENV: Record<string, string> = {
  DATAVERSE_ORG_URL: "https://org12345.crm4.dynamics.com",
  AUTH_MODE: "insecure-passthrough",
  DATAVERSE_LINK_TYPE_STYLE: "global",
};

function setEnv(extra: Record<string, string | undefined> = {}) {
  delete process.env.CUSTOM_COLUMNS_MODE;
  Object.assign(process.env, BASE_ENV);
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetEnvCache();
}

beforeEach(() => {
  setEnv();
  getEntityMetadataMock.mockReset();
});
afterEach(() => resetEnvCache());

function col(overrides: Partial<ColumnMeta>): ColumnMeta {
  const base: ColumnMeta = {
    logicalName: "new_x",
    schemaName: "new_x",
    type: "string",
    isCustom: true,
    isValidForCreate: true,
    isValidForUpdate: true,
    isComputed: false,
  };
  const merged = { ...base, ...overrides };
  if (!overrides.schemaName && overrides.logicalName) merged.schemaName = overrides.logicalName;
  return merged;
}

describe("list_custom_columns", () => {
  it("returns ok:false with a note when CUSTOM_COLUMNS_MODE=off (default)", async () => {
    setEnv({ CUSTOM_COLUMNS_MODE: "off" });
    const result: any = await listCustomColumns.handler({ entity: "task" });
    expect(result.ok).toBe(false);
    expect(result.note).toMatch(/CUSTOM_COLUMNS_MODE/);
    expect(result.columns).toEqual([]);
    expect(getEntityMetadataMock).not.toHaveBeenCalled();
  });

  it("maps entity alias 'task' -> msdyn_projecttask and 'project' -> msdyn_project", async () => {
    setEnv({ CUSTOM_COLUMNS_MODE: "metadata" });
    getEntityMetadataMock.mockResolvedValue({ entity: "x", columns: new Map(), fetchedAt: Date.now() });
    await listCustomColumns.handler({ entity: "task" });
    expect(getEntityMetadataMock).toHaveBeenCalledWith("msdyn_projecttask");
    await listCustomColumns.handler({ entity: "project" });
    expect(getEntityMetadataMock).toHaveBeenCalledWith("msdyn_project");
  });

  it("marks a writable scalar column writable:true with no readOnlyReason", async () => {
    setEnv({ CUSTOM_COLUMNS_MODE: "metadata" });
    getEntityMetadataMock.mockResolvedValue({
      entity: "msdyn_projecttask",
      columns: new Map([["new_riskscore", col({ logicalName: "new_riskscore", type: "int" })]]),
      fetchedAt: Date.now(),
    });
    const result: any = await listCustomColumns.handler({ entity: "task" });
    expect(result.ok).toBe(true);
    expect(result.columns).toEqual([
      { logicalName: "new_riskscore", schemaName: "new_riskscore", type: "int", writable: true },
    ]);
  });

  it("marks a computed column writable:false with a reason", async () => {
    setEnv({ CUSTOM_COLUMNS_MODE: "metadata" });
    getEntityMetadataMock.mockResolvedValue({
      entity: "msdyn_projecttask",
      columns: new Map([
        ["new_rollup", col({ logicalName: "new_rollup", type: "int", isComputed: true })],
      ]),
      fetchedAt: Date.now(),
    });
    const result: any = await listCustomColumns.handler({ entity: "task" });
    expect(result.columns[0].writable).toBe(false);
    expect(result.columns[0].readOnlyReason).toMatch(/calculated\/rollup/);
  });

  it("marks state/status/image/file/unsupported types writable:false", async () => {
    setEnv({ CUSTOM_COLUMNS_MODE: "metadata" });
    getEntityMetadataMock.mockResolvedValue({
      entity: "msdyn_project",
      columns: new Map([
        ["a_state", col({ logicalName: "a_state", type: "state" })],
        ["b_status", col({ logicalName: "b_status", type: "status" })],
        ["c_image", col({ logicalName: "c_image", type: "image" })],
        ["d_file", col({ logicalName: "d_file", type: "file" })],
        ["e_unsupported", col({ logicalName: "e_unsupported", type: "unsupported" })],
      ]),
      fetchedAt: Date.now(),
    });
    const result: any = await listCustomColumns.handler({ entity: "project" });
    for (const c of result.columns) {
      expect(c.writable).toBe(false);
      expect(c.readOnlyReason).toBeTruthy();
    }
  });

  it("includes options for picklist columns and lookupTargets for lookup columns", async () => {
    setEnv({ CUSTOM_COLUMNS_MODE: "metadata" });
    getEntityMetadataMock.mockResolvedValue({
      entity: "msdyn_project",
      columns: new Map([
        [
          "new_category",
          col({ logicalName: "new_category", type: "picklist", options: [{ value: 1, label: "High" }] }),
        ],
        [
          "new_owningteam",
          col({
            logicalName: "new_owningteam",
            type: "lookup",
            navigationProperty: "new_OwningTeam",
            targets: ["team"],
            targetEntitySets: { team: "teams" },
          }),
        ],
      ]),
      fetchedAt: Date.now(),
    });
    const result: any = await listCustomColumns.handler({ entity: "project" });
    const category = result.columns.find((c: any) => c.logicalName === "new_category");
    const team = result.columns.find((c: any) => c.logicalName === "new_owningteam");
    expect(category.options).toEqual([{ value: 1, label: "High" }]);
    expect(team.lookupTargets).toEqual(["team"]);
  });

  it("sorts columns by logical name and reports an accurate count", async () => {
    setEnv({ CUSTOM_COLUMNS_MODE: "metadata" });
    getEntityMetadataMock.mockResolvedValue({
      entity: "msdyn_project",
      columns: new Map([
        ["new_zeta", col({ logicalName: "new_zeta" })],
        ["new_alpha", col({ logicalName: "new_alpha" })],
      ]),
      fetchedAt: Date.now(),
    });
    const result: any = await listCustomColumns.handler({ entity: "project" });
    expect(result.count).toBe(2);
    expect(result.columns.map((c: any) => c.logicalName)).toEqual(["new_alpha", "new_zeta"]);
  });
});
