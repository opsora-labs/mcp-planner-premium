import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock dataverse.js's dvHeaders (request-context-free) so this stays a pure
// unit test; dvReq is not exercised directly here (metadata.js is mocked
// wholesale instead — see below).
vi.mock("../src/dataverse.js", async () => {
  const actual = await vi.importActual<typeof import("../src/dataverse.js")>(
    "../src/dataverse.js",
  );
  return {
    ...actual,
    dvHeaders: (opts?: { json?: boolean; extra?: Record<string, string> }) => ({
      Authorization: "Bearer test-token",
      ...(opts?.extra ?? {}),
    }),
  };
});

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

import {
  resolveCustomColumnsForRead,
  deserializeCustomFields,
  isCustomColumnMissingError,
} from "../src/tools/customColumnsRead.js";
import { readHeaders } from "../src/tools/readHelpers.js";
import { resetEnvCache } from "../src/config.js";
import type { ColumnMeta } from "../src/dataverse/columnTypes.js";

const BASE_ENV: Record<string, string> = {
  DATAVERSE_ORG_URL: "https://org12345.crm4.dynamics.com",
  AUTH_MODE: "insecure-passthrough",
  DATAVERSE_LINK_TYPE_STYLE: "global",
};

function setEnv(extra: Record<string, string | undefined> = {}) {
  delete process.env.CUSTOM_COLUMNS_MODE;
  delete process.env.CUSTOM_COLUMNS_ALLOWLIST;
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

function scalarCol(logicalName: string, type: ColumnMeta["type"] = "string"): ColumnMeta {
  return {
    logicalName,
    schemaName: logicalName,
    type,
    isCustom: true,
    isValidForCreate: true,
    isValidForUpdate: true,
    isComputed: false,
  };
}

function lookupCol(logicalName: string): ColumnMeta {
  return {
    logicalName,
    schemaName: logicalName,
    type: "lookup",
    isCustom: true,
    isValidForCreate: true,
    isValidForUpdate: true,
    isComputed: false,
    navigationProperty: "new_OwningTeam",
    targets: ["team"],
    targetEntitySets: { team: "teams" },
  };
}

function picklistCol(logicalName: string): ColumnMeta {
  return {
    logicalName,
    schemaName: logicalName,
    type: "picklist",
    isCustom: true,
    isValidForCreate: true,
    isValidForUpdate: true,
    isComputed: false,
    options: [{ value: 1, label: "High" }],
  };
}

describe("resolveCustomColumnsForRead — default-off behaviour", () => {
  it("returns an empty, no-op selection when include is undefined (zero behaviour change)", async () => {
    setEnv({ CUSTOM_COLUMNS_MODE: "metadata" });
    const sel = await resolveCustomColumnsForRead("msdyn_projecttask", undefined);
    expect(sel.columns.size).toBe(0);
    expect(sel.selectTokens).toEqual([]);
    expect(sel.needsWidenedPrefer).toBe(false);
    expect(sel.warnings).toEqual([]);
    expect(getEntityMetadataMock).not.toHaveBeenCalled();
  });

  it("returns an empty selection with a warning when CUSTOM_COLUMNS_MODE=off but include was requested", async () => {
    setEnv({ CUSTOM_COLUMNS_MODE: "off" });
    const sel = await resolveCustomColumnsForRead("msdyn_projecttask", true);
    expect(sel.columns.size).toBe(0);
    expect(sel.warnings[0]).toMatch(/CUSTOM_COLUMNS_MODE=off/);
    expect(getEntityMetadataMock).not.toHaveBeenCalled();
  });
});

describe("resolveCustomColumnsForRead — include:true", () => {
  it("selects all discovered custom columns and builds $select tokens", async () => {
    setEnv({ CUSTOM_COLUMNS_MODE: "metadata" });
    getEntityMetadataMock.mockResolvedValue({
      entity: "msdyn_projecttask",
      columns: new Map([
        ["new_riskscore", scalarCol("new_riskscore", "int")],
        ["new_owningteam", lookupCol("new_owningteam")],
      ]),
      fetchedAt: Date.now(),
    });

    const sel = await resolveCustomColumnsForRead("msdyn_projecttask", true);
    expect(sel.columns.size).toBe(2);
    expect(sel.selectTokens.sort()).toEqual(["_new_owningteam_value", "new_riskscore"].sort());
    expect(sel.needsWidenedPrefer).toBe(true); // a lookup is present
  });

  it("does not widen Prefer when only scalar columns are selected", async () => {
    setEnv({ CUSTOM_COLUMNS_MODE: "metadata" });
    getEntityMetadataMock.mockResolvedValue({
      entity: "msdyn_projecttask",
      columns: new Map([["new_riskscore", scalarCol("new_riskscore", "int")]]),
      fetchedAt: Date.now(),
    });
    const sel = await resolveCustomColumnsForRead("msdyn_projecttask", true);
    expect(sel.needsWidenedPrefer).toBe(false);
  });
});

describe("resolveCustomColumnsForRead — include: string[]", () => {
  it("selects only the named columns", async () => {
    setEnv({ CUSTOM_COLUMNS_MODE: "metadata" });
    getEntityMetadataMock.mockResolvedValue({
      entity: "msdyn_projecttask",
      columns: new Map([
        ["new_riskscore", scalarCol("new_riskscore", "int")],
        ["new_category", picklistCol("new_category")],
      ]),
      fetchedAt: Date.now(),
    });
    const sel = await resolveCustomColumnsForRead("msdyn_projecttask", ["new_category"]);
    expect(sel.columns.size).toBe(1);
    expect(sel.columns.has("new_category")).toBe(true);
  });

  it("warns (does not throw) for an unknown column name", async () => {
    setEnv({ CUSTOM_COLUMNS_MODE: "metadata" });
    getEntityMetadataMock.mockResolvedValue({
      entity: "msdyn_projecttask",
      columns: new Map(),
      fetchedAt: Date.now(),
    });
    const sel = await resolveCustomColumnsForRead("msdyn_projecttask", ["new_doesnotexist"]);
    expect(sel.columns.size).toBe(0);
    expect(sel.warnings[0]).toMatch(/not found/);
  });

  it("warns for a standard msdyn_ field named in the array", async () => {
    setEnv({ CUSTOM_COLUMNS_MODE: "metadata" });
    getEntityMetadataMock.mockResolvedValue({
      entity: "msdyn_projecttask",
      columns: new Map(),
      fetchedAt: Date.now(),
    });
    const sel = await resolveCustomColumnsForRead("msdyn_projecttask", ["msdyn_subject"]);
    expect(sel.warnings[0]).toMatch(/standard field/);
  });
});

describe("resolveCustomColumnsForRead — metadata+allowlist", () => {
  it("filters include:true down to the allowlist", async () => {
    setEnv({ CUSTOM_COLUMNS_MODE: "metadata+allowlist", CUSTOM_COLUMNS_ALLOWLIST: "new_riskscore" });
    getEntityMetadataMock.mockResolvedValue({
      entity: "msdyn_projecttask",
      columns: new Map([
        ["new_riskscore", scalarCol("new_riskscore", "int")],
        ["new_category", picklistCol("new_category")],
      ]),
      fetchedAt: Date.now(),
    });
    const sel = await resolveCustomColumnsForRead("msdyn_projecttask", true);
    expect([...sel.columns.keys()]).toEqual(["new_riskscore"]);
  });

  it("rejects a named column not on the allowlist with a warning, not a throw", async () => {
    setEnv({ CUSTOM_COLUMNS_MODE: "metadata+allowlist", CUSTOM_COLUMNS_ALLOWLIST: "new_riskscore" });
    getEntityMetadataMock.mockResolvedValue({
      entity: "msdyn_projecttask",
      columns: new Map([["new_category", picklistCol("new_category")]]),
      fetchedAt: Date.now(),
    });
    const sel = await resolveCustomColumnsForRead("msdyn_projecttask", ["new_category"]);
    expect(sel.columns.size).toBe(0);
    expect(sel.warnings[0]).toMatch(/not found|blocked/);
  });
});

describe("resolveCustomColumnsForRead — metadata read failure degrades gracefully", () => {
  it("returns an empty selection with a warning instead of throwing", async () => {
    setEnv({ CUSTOM_COLUMNS_MODE: "metadata" });
    getEntityMetadataMock.mockRejectedValue(new Error("403 forbidden"));
    const sel = await resolveCustomColumnsForRead("msdyn_projecttask", true);
    expect(sel.columns.size).toBe(0);
    expect(sel.warnings[0]).toMatch(/Could not read custom-column metadata/);
  });
});

describe("deserializeCustomFields — recorded row fixtures from the proven spec", () => {
  it("deserializes a scalar int column", () => {
    const sel = {
      columns: new Map([["new_riskscore", scalarCol("new_riskscore", "int")]]),
      selectTokens: ["new_riskscore"],
      needsWidenedPrefer: false,
      warnings: [],
    };
    const row = { new_riskscore: 7 };
    expect(deserializeCustomFields(sel, row)).toEqual({ new_riskscore: 7 });
  });

  it("deserializes a picklist column via FormattedValue", () => {
    const sel = {
      columns: new Map([["new_category", picklistCol("new_category")]]),
      selectTokens: ["new_category"],
      needsWidenedPrefer: false,
      warnings: [],
    };
    const row = {
      new_category: 1,
      "new_category@OData.Community.Display.V1.FormattedValue": "High",
    };
    expect(deserializeCustomFields(sel, row)).toEqual({
      new_category: { value: 1, label: "High" },
    });
  });

  it("deserializes a lookup column via _value + FormattedValue + lookuplogicalname", () => {
    const sel = {
      columns: new Map([["new_owningteam", lookupCol("new_owningteam")]]),
      selectTokens: ["_new_owningteam_value"],
      needsWidenedPrefer: true,
      warnings: [],
    };
    const guid = "11111111-2222-3333-4444-555555555555";
    const row = {
      _new_owningteam_value: guid,
      "_new_owningteam_value@OData.Community.Display.V1.FormattedValue": "Alpha Team",
      "_new_owningteam_value@Microsoft.Dynamics.CRM.lookuplogicalname": "team",
    };
    expect(deserializeCustomFields(sel, row)).toEqual({
      new_owningteam: { id: guid, logicalName: "team", name: "Alpha Team" },
    });
  });

  it("omits a column entirely absent from the row (not present -> not in output)", () => {
    const sel = {
      columns: new Map([["new_riskscore", scalarCol("new_riskscore", "int")]]),
      selectTokens: ["new_riskscore"],
      needsWidenedPrefer: false,
      warnings: [],
    };
    expect(deserializeCustomFields(sel, {})).toEqual({});
  });
});

describe("isCustomColumnMissingError", () => {
  it("detects the 'could not find a property named' 400 when the name matches a requested custom column", () => {
    expect(
      isCustomColumnMissingError(
        {
          status: 400,
          json: { error: { message: "Could not find a property named 'new_removed'." } },
        },
        ["new_removed"],
      ),
    ).toBe(true);
  });

  it("matches a lookup custom column via its _value $select token", () => {
    expect(
      isCustomColumnMissingError(
        {
          status: 400,
          json: { error: { message: "Could not find a property named '_new_owningteam_value'." } },
        },
        ["new_owningteam"],
      ),
    ).toBe(true);
  });

  it("does NOT misattribute a missing STANDARD field to the custom-column path (the mis-attribution bug this guards against)", () => {
    // A $select mixing extended task fields + custom columns can 400 because an
    // extended field (e.g. msdyn_duration) is absent — that must NOT match here,
    // otherwise callers would wrongly treat a standard-field-absence as a
    // custom-column removal and silently drop customSelection.
    expect(
      isCustomColumnMissingError(
        {
          status: 400,
          json: { error: { message: "Could not find a property named 'msdyn_duration'." } },
        },
        ["new_riskscore"],
      ),
    ).toBe(false);
  });

  it("returns false when no custom columns were requested at all", () => {
    expect(
      isCustomColumnMissingError(
        {
          status: 400,
          json: { error: { message: "Could not find a property named 'new_removed'." } },
        },
        [],
      ),
    ).toBe(false);
  });

  it("returns false for other errors", () => {
    expect(isCustomColumnMissingError({ status: 403, json: {} }, ["new_x"])).toBe(false);
    expect(
      isCustomColumnMissingError({ status: 400, json: { error: { message: "other" } } }, ["new_x"]),
    ).toBe(false);
  });
});

describe("readHeaders({ includeCustomColumns: true }) widens the Prefer annotation set", () => {
  it("default readHeaders() keeps the original single-annotation Prefer (no behaviour change)", () => {
    const h = readHeaders();
    expect(h.Prefer).toBe(
      'odata.maxpagesize=1000,odata.include-annotations="OData.Community.Display.V1.FormattedValue"',
    );
  });

  it("includeCustomColumns:true adds Microsoft.Dynamics.CRM.lookuplogicalname", () => {
    const h = readHeaders({ includeCustomColumns: true });
    expect(h.Prefer).toContain("OData.Community.Display.V1.FormattedValue");
    expect(h.Prefer).toContain("Microsoft.Dynamics.CRM.lookuplogicalname");
  });
});
