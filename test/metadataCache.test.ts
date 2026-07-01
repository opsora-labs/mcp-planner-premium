import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock the dataverse transport seam so metadata.ts's dvReq calls never hit the
// network. Each test configures `dvReqMock` to return canned responses keyed
// off the request URL, mirroring the shapes proven live in the schema-scout spec.
const dvReqMock = vi.fn();
vi.mock("../src/dataverse.js", async () => {
  const actual = await vi.importActual<typeof import("../src/dataverse.js")>(
    "../src/dataverse.js",
  );
  return {
    ...actual,
    dvReq: (...args: unknown[]) => dvReqMock(...args),
    // Real dvHeaders() pulls the bearer from AsyncLocalStorage request context,
    // which isn't set up in a unit test. dvReq is already mocked (no real HTTP
    // call is made), so the header contents are irrelevant here — stub it out.
    dvHeaders: () => ({ Authorization: "Bearer test-token" }),
  };
});

// Import AFTER the mock is registered.
import {
  getEntityMetadata,
  resolveColumn,
  resolveLookupTargetSet,
  resetMetadataCache,
  isCustomColumnName,
} from "../src/dataverse/metadata.js";
import { resetEnvCache } from "../src/config.js";

const BASE_ENV: Record<string, string> = {
  DATAVERSE_ORG_URL: "https://org12345.crm4.dynamics.com",
  AUTH_MODE: "insecure-passthrough",
  DATAVERSE_LINK_TYPE_STYLE: "global",
};

function setEnv(extra: Record<string, string | undefined> = {}) {
  delete process.env.CUSTOM_COLUMNS_METADATA_TTL_MS;
  Object.assign(process.env, BASE_ENV);
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetEnvCache();
}

beforeEach(() => {
  setEnv();
  resetMetadataCache();
  dvReqMock.mockReset();
});
afterEach(() => {
  resetMetadataCache();
  resetEnvCache();
});

// ---------------------------------------------------------------------------
// Fixture data — matches the proven spec's exact response shapes.
// ---------------------------------------------------------------------------

const ATTRIBUTES_URL_RE = /\/Attributes\?\$select=/;
const PICKLIST_CAST_RE = /PicklistAttributeMetadata\?\$expand=OptionSet/;
const MULTISELECT_CAST_RE = /MultiSelectPicklistAttributeMetadata\?\$expand=OptionSet/;
const DATETIME_CAST_RE = /DateTimeAttributeMetadata\?\$select=DateTimeBehavior,Format/;
const M2O_RE = /ManyToOneRelationships\?\$select=/;
const ENTITY_SET_RE = /EntityDefinitions\(LogicalName='([^']+)'\)\?\$select=EntitySetName/;

function jsonOk(json: unknown) {
  return Promise.resolve({ status: 200, json });
}

function attrRow(overrides: Record<string, unknown>) {
  return {
    LogicalName: "new_x",
    SchemaName: "new_x",
    AttributeType: "String",
    AttributeTypeName: { Value: "StringType" },
    IsCustomAttribute: true,
    IsValidForCreate: true,
    IsValidForUpdate: true,
    IsValidForRead: true,
    AttributeOf: null,
    SourceType: 0,
    ...overrides,
  };
}

describe("isCustomColumnName (prefix discipline)", () => {
  it("rejects msdyn_ prefixed names regardless of casing", () => {
    expect(isCustomColumnName("msdyn_subject")).toBe(false);
    expect(isCustomColumnName("MSDYN_Subject")).toBe(false);
  });
  it("accepts non-msdyn_ names", () => {
    expect(isCustomColumnName("new_riskscore")).toBe(true);
    expect(isCustomColumnName("contoso_field")).toBe(true);
  });
});

describe("getEntityMetadata — attribute parse", () => {
  it("filters out msdyn_ standard fields even when IsCustomAttribute=true (the proven-spec trap)", async () => {
    dvReqMock.mockImplementation((req: { url: string }) => {
      if (ATTRIBUTES_URL_RE.test(req.url)) {
        return jsonOk({
          value: [
            attrRow({ LogicalName: "msdyn_subject", IsCustomAttribute: true }), // standard, must be excluded
            attrRow({ LogicalName: "new_riskscore", AttributeType: "Integer", AttributeTypeName: { Value: "IntegerType" } }),
          ],
        });
      }
      throw new Error("unexpected request: " + req.url);
    });

    const meta = await getEntityMetadata("msdyn_projecttask");
    expect(meta.columns.has("msdyn_subject")).toBe(false);
    expect(meta.columns.has("new_riskscore")).toBe(true);
    expect(meta.columns.get("new_riskscore")!.type).toBe("int");
  });

  it("parses IsValidForCreate/Update, SourceType/AttributeOf into isComputed", async () => {
    dvReqMock.mockImplementation((req: { url: string }) => {
      if (ATTRIBUTES_URL_RE.test(req.url)) {
        return jsonOk({
          value: [
            attrRow({
              LogicalName: "new_rollup",
              AttributeType: "Integer",
              AttributeTypeName: { Value: "IntegerType" },
              SourceType: 1,
              IsValidForCreate: false,
              IsValidForUpdate: false,
            }),
          ],
        });
      }
      throw new Error("unexpected request: " + req.url);
    });

    const meta = await getEntityMetadata("msdyn_project");
    const col = meta.columns.get("new_rollup")!;
    expect(col.isComputed).toBe(true);
    expect(col.isValidForCreate).toBe(false);
    expect(col.isValidForUpdate).toBe(false);
  });
});

describe("getEntityMetadata — type-specific cast fan-out", () => {
  it("fetches the Picklist OptionSet cast for Picklist columns", async () => {
    dvReqMock.mockImplementation((req: { url: string }) => {
      if (ATTRIBUTES_URL_RE.test(req.url)) {
        return jsonOk({
          value: [
            attrRow({
              LogicalName: "new_category",
              AttributeType: "Picklist",
              AttributeTypeName: { Value: "PicklistType" },
            }),
          ],
        });
      }
      if (PICKLIST_CAST_RE.test(req.url)) {
        return jsonOk({
          OptionSet: {
            Options: [
              { Value: 192350000, Label: { UserLocalizedLabel: { Label: "Fixed effort" } } },
            ],
          },
        });
      }
      throw new Error("unexpected request: " + req.url);
    });

    const meta = await getEntityMetadata("msdyn_project");
    const col = meta.columns.get("new_category")!;
    expect(col.options).toEqual([{ value: 192350000, label: "Fixed effort" }]);
  });

  it("fetches the DateTime cast and uses Format (not DateTimeBehavior) for dateonly", async () => {
    dvReqMock.mockImplementation((req: { url: string }) => {
      if (ATTRIBUTES_URL_RE.test(req.url)) {
        return jsonOk({
          value: [
            attrRow({
              LogicalName: "new_reviewdate",
              AttributeType: "DateTime",
              AttributeTypeName: { Value: "DateTimeType" },
            }),
          ],
        });
      }
      if (DATETIME_CAST_RE.test(req.url)) {
        return jsonOk({ Format: "DateOnly", DateTimeBehavior: { Value: "UserLocal" } });
      }
      throw new Error("unexpected request: " + req.url);
    });

    const meta = await getEntityMetadata("msdyn_projecttask");
    const col = meta.columns.get("new_reviewdate")!;
    expect(col.type).toBe("dateonly");
  });

  it("fetches the MultiSelectPicklist cast for multiselect columns", async () => {
    dvReqMock.mockImplementation((req: { url: string }) => {
      if (ATTRIBUTES_URL_RE.test(req.url)) {
        return jsonOk({
          value: [
            attrRow({
              LogicalName: "new_tags",
              AttributeType: "MultiSelectPicklist",
              AttributeTypeName: { Value: "MultiSelectPicklistType" },
            }),
          ],
        });
      }
      if (MULTISELECT_CAST_RE.test(req.url)) {
        return jsonOk({
          OptionSet: { Options: [{ Value: 1, Label: { UserLocalizedLabel: { Label: "Red" } } }] },
        });
      }
      throw new Error("unexpected request: " + req.url);
    });

    const meta = await getEntityMetadata("msdyn_projecttask");
    const col = meta.columns.get("new_tags")!;
    expect(col.type).toBe("multipicklist");
    expect(col.options).toEqual([{ value: 1, label: "Red" }]);
  });
});

describe("getEntityMetadata — lookup nav resolution", () => {
  it("resolves navigationProperty/targets/targetEntitySets via ManyToOneRelationships + EntitySetName", async () => {
    dvReqMock.mockImplementation((req: { url: string }) => {
      if (ATTRIBUTES_URL_RE.test(req.url)) {
        return jsonOk({
          value: [
            attrRow({
              LogicalName: "new_owningteam",
              AttributeType: "Lookup",
              AttributeTypeName: { Value: "LookupType" },
              SourceType: null,
            }),
          ],
        });
      }
      if (M2O_RE.test(req.url)) {
        return jsonOk({
          value: [
            {
              ReferencingAttribute: "new_owningteam",
              ReferencingEntityNavigationPropertyName: "new_OwningTeam",
              ReferencedEntity: "team",
            },
          ],
        });
      }
      const setMatch = req.url.match(ENTITY_SET_RE);
      if (setMatch) {
        expect(setMatch[1]).toBe("team");
        return jsonOk({ EntitySetName: "teams" });
      }
      throw new Error("unexpected request: " + req.url);
    });

    const meta = await getEntityMetadata("msdyn_projecttask");
    const col = meta.columns.get("new_owningteam")!;
    expect(col.type).toBe("lookup");
    expect(col.navigationProperty).toBe("new_OwningTeam");
    expect(col.targets).toEqual(["team"]);
    expect(col.targetEntitySets).toEqual({ team: "teams" });
  });

  it("uses the compound-alias nav name verbatim (not just a casing change)", async () => {
    dvReqMock.mockImplementation((req: { url: string }) => {
      if (ATTRIBUTES_URL_RE.test(req.url)) {
        return jsonOk({
          value: [
            attrRow({
              LogicalName: "new_projectimportstagingid",
              AttributeType: "Lookup",
              AttributeTypeName: { Value: "LookupType" },
              SourceType: null,
            }),
          ],
        });
      }
      if (M2O_RE.test(req.url)) {
        return jsonOk({
          value: [
            {
              ReferencingAttribute: "new_projectimportstagingid",
              ReferencingEntityNavigationPropertyName:
                "new_projectimportstagingid_msdyn_projectimportstaging",
              ReferencedEntity: "msdyn_projectimportstaging",
            },
          ],
        });
      }
      if (ENTITY_SET_RE.test(req.url)) return jsonOk({ EntitySetName: "msdyn_projectimportstagings" });
      throw new Error("unexpected request: " + req.url);
    });

    const meta = await getEntityMetadata("msdyn_projecttask");
    const col = meta.columns.get("new_projectimportstagingid")!;
    expect(col.navigationProperty).toBe("new_projectimportstagingid_msdyn_projectimportstaging");
  });
});

describe("resolveEntitySetName / resolveLookupTargetSet", () => {
  it("resolves and caches an entity-set name", async () => {
    let calls = 0;
    dvReqMock.mockImplementation((req: { url: string }) => {
      if (ENTITY_SET_RE.test(req.url)) {
        calls++;
        return jsonOk({ EntitySetName: "teams" });
      }
      throw new Error("unexpected request: " + req.url);
    });
    expect(await resolveLookupTargetSet("team")).toBe("teams");
    expect(await resolveLookupTargetSet("team")).toBe("teams");
    expect(calls).toBe(1); // cache hit on the second call
  });
});

describe("resolveColumn", () => {
  it("returns undefined for an msdyn_ prefixed name without hitting the network", async () => {
    const col = await resolveColumn("msdyn_projecttask", "msdyn_subject");
    expect(col).toBeUndefined();
    expect(dvReqMock).not.toHaveBeenCalled();
  });

  it("returns the resolved ColumnMeta for a custom column", async () => {
    dvReqMock.mockImplementation((req: { url: string }) => {
      if (ATTRIBUTES_URL_RE.test(req.url)) {
        return jsonOk({ value: [attrRow({ LogicalName: "new_riskscore", AttributeType: "Integer", AttributeTypeName: { Value: "IntegerType" } })] });
      }
      throw new Error("unexpected request: " + req.url);
    });
    const col = await resolveColumn("msdyn_projecttask", "new_riskscore");
    expect(col?.type).toBe("int");
  });

  it("returns undefined when the column is not present on the entity", async () => {
    dvReqMock.mockImplementation((req: { url: string }) => {
      if (ATTRIBUTES_URL_RE.test(req.url)) return jsonOk({ value: [] });
      throw new Error("unexpected request: " + req.url);
    });
    const col = await resolveColumn("msdyn_projecttask", "new_doesnotexist");
    expect(col).toBeUndefined();
  });
});

describe("cache hit/miss (fetch-once)", () => {
  it("fetches attributes once per entity across repeated getEntityMetadata calls", async () => {
    let attrCalls = 0;
    dvReqMock.mockImplementation((req: { url: string }) => {
      if (ATTRIBUTES_URL_RE.test(req.url)) {
        attrCalls++;
        return jsonOk({ value: [attrRow({ LogicalName: "new_x" })] });
      }
      throw new Error("unexpected request: " + req.url);
    });

    await getEntityMetadata("msdyn_projecttask");
    await getEntityMetadata("msdyn_projecttask");
    await getEntityMetadata("msdyn_projecttask");
    expect(attrCalls).toBe(1);
  });

  it("caches independently per entity", async () => {
    const seen: string[] = [];
    dvReqMock.mockImplementation((req: { url: string }) => {
      if (ATTRIBUTES_URL_RE.test(req.url)) {
        seen.push(req.url);
        return jsonOk({ value: [] });
      }
      throw new Error("unexpected request: " + req.url);
    });
    await getEntityMetadata("msdyn_projecttask");
    await getEntityMetadata("msdyn_project");
    expect(seen).toHaveLength(2);
  });

  it("resetMetadataCache() forces a re-fetch", async () => {
    let attrCalls = 0;
    dvReqMock.mockImplementation((req: { url: string }) => {
      if (ATTRIBUTES_URL_RE.test(req.url)) {
        attrCalls++;
        return jsonOk({ value: [] });
      }
      throw new Error("unexpected request: " + req.url);
    });
    await getEntityMetadata("msdyn_projecttask");
    resetMetadataCache();
    await getEntityMetadata("msdyn_projecttask");
    expect(attrCalls).toBe(2);
  });

  it("respects CUSTOM_COLUMNS_METADATA_TTL_MS expiry", async () => {
    setEnv({ CUSTOM_COLUMNS_METADATA_TTL_MS: "10" });
    let attrCalls = 0;
    dvReqMock.mockImplementation((req: { url: string }) => {
      if (ATTRIBUTES_URL_RE.test(req.url)) {
        attrCalls++;
        return jsonOk({ value: [] });
      }
      throw new Error("unexpected request: " + req.url);
    });
    await getEntityMetadata("msdyn_projecttask");
    expect(attrCalls).toBe(1);
    // Still within TTL — cache hit.
    await getEntityMetadata("msdyn_projecttask");
    expect(attrCalls).toBe(1);
    // Simulate TTL expiry.
    await new Promise((r) => setTimeout(r, 20));
    await getEntityMetadata("msdyn_projecttask");
    expect(attrCalls).toBe(2);
  });

  it("dedupes concurrent in-flight fetches for the same entity", async () => {
    let attrCalls = 0;
    let resolveFn: (() => void) | undefined;
    const gate = new Promise<void>((r) => (resolveFn = r));
    dvReqMock.mockImplementation(async (req: { url: string }) => {
      if (ATTRIBUTES_URL_RE.test(req.url)) {
        attrCalls++;
        await gate;
        return { status: 200, json: { value: [] } };
      }
      throw new Error("unexpected request: " + req.url);
    });

    const p1 = getEntityMetadata("msdyn_projecttask");
    const p2 = getEntityMetadata("msdyn_projecttask");
    resolveFn!();
    await Promise.all([p1, p2]);
    expect(attrCalls).toBe(1);
  });
});

describe("403 / error degrade on the base attribute read", () => {
  it("throws a clear, actionable error naming the privilege and the allowlist escape hatch", async () => {
    dvReqMock.mockImplementation((req: { url: string }) => {
      if (ATTRIBUTES_URL_RE.test(req.url)) {
        return Promise.resolve({
          status: 403,
          json: { error: { message: "Insufficient privileges" } },
        });
      }
      throw new Error("unexpected request: " + req.url);
    });

    await expect(getEntityMetadata("msdyn_projecttask")).rejects.toThrow(
      /prvReadEntity|prvReadAttribute/,
    );
    await expect(getEntityMetadata("msdyn_projecttask")).rejects.toThrow(
      /CUSTOM_COLUMNS_ALLOWLIST/,
    );
  });

  it("does not cache a failed fetch (retries on next call)", async () => {
    let attrCalls = 0;
    dvReqMock.mockImplementation((req: { url: string }) => {
      if (ATTRIBUTES_URL_RE.test(req.url)) {
        attrCalls++;
        if (attrCalls === 1) return Promise.resolve({ status: 403, json: {} });
        return jsonOk({ value: [] });
      }
      throw new Error("unexpected request: " + req.url);
    });

    await expect(getEntityMetadata("msdyn_projecttask")).rejects.toThrow();
    const meta = await getEntityMetadata("msdyn_projecttask");
    expect(meta.columns.size).toBe(0);
    expect(attrCalls).toBe(2);
  });
});

describe("best-effort degrade on type-specific casts (column still resolves)", () => {
  it("a picklist column resolves without options when the OptionSet cast 400s", async () => {
    dvReqMock.mockImplementation((req: { url: string }) => {
      if (ATTRIBUTES_URL_RE.test(req.url)) {
        return jsonOk({
          value: [
            attrRow({
              LogicalName: "new_category",
              AttributeType: "Picklist",
              AttributeTypeName: { Value: "PicklistType" },
            }),
          ],
        });
      }
      if (PICKLIST_CAST_RE.test(req.url)) {
        return Promise.resolve({ status: 400, json: {} });
      }
      throw new Error("unexpected request: " + req.url);
    });

    const meta = await getEntityMetadata("msdyn_project");
    const col = meta.columns.get("new_category")!;
    expect(col.type).toBe("picklist");
    expect(col.options).toEqual([]);
  });

  it("a lookup column resolves without navigationProperty when ManyToOneRelationships errors", async () => {
    dvReqMock.mockImplementation((req: { url: string }) => {
      if (ATTRIBUTES_URL_RE.test(req.url)) {
        return jsonOk({
          value: [
            attrRow({
              LogicalName: "new_owningteam",
              AttributeType: "Lookup",
              AttributeTypeName: { Value: "LookupType" },
              SourceType: null,
            }),
          ],
        });
      }
      if (M2O_RE.test(req.url)) return Promise.resolve({ status: 500, json: {} });
      throw new Error("unexpected request: " + req.url);
    });

    const meta = await getEntityMetadata("msdyn_projecttask");
    const col = meta.columns.get("new_owningteam")!;
    expect(col.type).toBe("lookup");
    expect(col.navigationProperty).toBeUndefined();
  });
});
