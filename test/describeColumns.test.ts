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

import { describeColumns } from "../src/tools/describeColumns.js";
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

describe("describe_columns", () => {
  it("returns ok:false with a note when CUSTOM_COLUMNS_MODE=off (default)", async () => {
    setEnv({ CUSTOM_COLUMNS_MODE: "off" });
    const result: any = await describeColumns.handler({ entity: "task", columns: ["new_x"] });
    expect(result.ok).toBe(false);
    expect(result.note).toMatch(/CUSTOM_COLUMNS_MODE/);
    expect(getEntityMetadataMock).not.toHaveBeenCalled();
  });

  it("returns deep detail for a picklist column: options + create/update validity", async () => {
    setEnv({ CUSTOM_COLUMNS_MODE: "metadata" });
    getEntityMetadataMock.mockResolvedValue({
      entity: "msdyn_project",
      columns: new Map([
        [
          "new_category",
          col({
            logicalName: "new_category",
            type: "picklist",
            options: [{ value: 192350000, label: "Fixed effort" }],
          }),
        ],
      ]),
      fetchedAt: Date.now(),
    });
    const result: any = await describeColumns.handler({ entity: "project", columns: ["new_category"] });
    expect(result.ok).toBe(true);
    expect(result.columns).toEqual([
      {
        logicalName: "new_category",
        schemaName: "new_category",
        type: "picklist",
        isValidForCreate: true,
        isValidForUpdate: true,
        isComputed: false,
        options: [{ value: 192350000, label: "Fixed effort" }],
      },
    ]);
  });

  it("returns dateFormat for a dateonly column", async () => {
    setEnv({ CUSTOM_COLUMNS_MODE: "metadata" });
    getEntityMetadataMock.mockResolvedValue({
      entity: "msdyn_projecttask",
      columns: new Map([
        ["new_reviewdate", col({ logicalName: "new_reviewdate", type: "dateonly", dateFormat: "DateOnly" })],
      ]),
      fetchedAt: Date.now(),
    });
    const result: any = await describeColumns.handler({ entity: "task", columns: ["new_reviewdate"] });
    expect(result.columns[0].dateFormat).toBe("DateOnly");
  });

  it("returns navigationProperty/lookupTargets/lookupTargetEntitySets for a lookup column", async () => {
    setEnv({ CUSTOM_COLUMNS_MODE: "metadata" });
    getEntityMetadataMock.mockResolvedValue({
      entity: "msdyn_projecttask",
      columns: new Map([
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
    const result: any = await describeColumns.handler({ entity: "task", columns: ["new_owningteam"] });
    expect(result.columns[0].navigationProperty).toBe("new_OwningTeam");
    expect(result.columns[0].lookupTargets).toEqual(["team"]);
    expect(result.columns[0].lookupTargetEntitySets).toEqual({ team: "teams" });
  });

  it("reports notFound for a column absent from the entity", async () => {
    setEnv({ CUSTOM_COLUMNS_MODE: "metadata" });
    getEntityMetadataMock.mockResolvedValue({
      entity: "msdyn_projecttask",
      columns: new Map(),
      fetchedAt: Date.now(),
    });
    const result: any = await describeColumns.handler({ entity: "task", columns: ["new_doesnotexist"] });
    expect(result.columns).toEqual([]);
    expect(result.notFound).toEqual(["new_doesnotexist"]);
  });

  it("reports notFound (with a reason) for a standard msdyn_ field", async () => {
    setEnv({ CUSTOM_COLUMNS_MODE: "metadata" });
    getEntityMetadataMock.mockResolvedValue({
      entity: "msdyn_projecttask",
      columns: new Map(),
      fetchedAt: Date.now(),
    });
    const result: any = await describeColumns.handler({ entity: "task", columns: ["msdyn_subject"] });
    expect(result.notFound[0]).toMatch(/msdyn_subject.*standard/);
  });

  it("mixes found and notFound in one call", async () => {
    setEnv({ CUSTOM_COLUMNS_MODE: "metadata" });
    getEntityMetadataMock.mockResolvedValue({
      entity: "msdyn_project",
      columns: new Map([["new_riskscore", col({ logicalName: "new_riskscore", type: "int" })]]),
      fetchedAt: Date.now(),
    });
    const result: any = await describeColumns.handler({
      entity: "project",
      columns: ["new_riskscore", "new_ghost"],
    });
    expect(result.columns).toHaveLength(1);
    expect(result.notFound).toEqual(["new_ghost"]);
  });
});
