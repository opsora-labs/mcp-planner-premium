import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock the dataverse transport seam so metadata.ts's dvReq calls never hit the
// network — mirrors test/metadataCache.test.ts exactly.
const dvReqMock = vi.fn();
vi.mock("../src/dataverse.js", async () => {
  const actual = await vi.importActual<typeof import("../src/dataverse.js")>(
    "../src/dataverse.js",
  );
  return {
    ...actual,
    dvReq: (...args: unknown[]) => dvReqMock(...args),
    dvHeaders: () => ({ Authorization: "Bearer test-token" }),
  };
});

// Import AFTER the mock is registered.
import { validateAddEntities } from "../src/tools/addTasks.js";
import { validateUpdateEntities } from "../src/tools/updateTasks.js";
import { validateCustomColumnKeys } from "../src/tools/customColumnsGuard.js";
import { resetMetadataCache } from "../src/dataverse/metadata.js";
import { resetEnvCache } from "../src/config.js";

const TASK = "Microsoft.Dynamics.CRM.msdyn_projecttask";
const DEP = "Microsoft.Dynamics.CRM.msdyn_projecttaskdependency";

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
  resetMetadataCache();
  dvReqMock.mockReset();
});
afterEach(() => {
  resetMetadataCache();
  resetEnvCache();
});

function guid(n: number): string {
  const h = n.toString(16).padStart(2, "0");
  return `${h}aaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`;
}

function task(overrides: Record<string, unknown> = {}) {
  return {
    "@odata.type": TASK,
    msdyn_projecttaskid: overrides.msdyn_projecttaskid ?? guid(1),
    msdyn_subject: "T",
    "msdyn_project@odata.bind": "/msdyn_projects(" + guid(9) + ")",
    "msdyn_projectbucket@odata.bind": "/msdyn_projectbuckets(" + guid(8) + ")",
    ...overrides,
  };
}

function jsonOk(json: unknown) {
  return Promise.resolve({ status: 200, json });
}

const ATTRIBUTES_URL_RE = /\/Attributes\?\$select=/;
const M2O_RE = /ManyToOneRelationships\?\$select=/;
const ENTITY_SET_RE = /EntityDefinitions\(LogicalName='([^']+)'\)\?\$select=EntitySetName/;

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

describe("validateCustomColumnKeys — off by default (no-op, no network)", () => {
  it("does nothing when CUSTOM_COLUMNS_MODE=off (default)", async () => {
    await expect(
      validateCustomColumnKeys([task({ new_riskscore: 7 })], "create"),
    ).resolves.toBeUndefined();
    expect(dvReqMock).not.toHaveBeenCalled();
  });
});

describe("validateCustomColumnKeys — accepts a valid custom scalar", () => {
  it("accepts a valid, writable custom int column", async () => {
    setEnv({ CUSTOM_COLUMNS_MODE: "metadata" });
    dvReqMock.mockImplementation((req: { url: string }) => {
      if (ATTRIBUTES_URL_RE.test(req.url)) {
        return jsonOk({
          value: [
            attrRow({
              LogicalName: "new_riskscore",
              AttributeType: "Integer",
              AttributeTypeName: { Value: "IntegerType" },
            }),
          ],
        });
      }
      throw new Error("unexpected request: " + req.url);
    });

    await expect(
      validateCustomColumnKeys([task({ new_riskscore: 7 })], "create"),
    ).resolves.toBeUndefined();
  });
});

describe("validateCustomColumnKeys — rejects a computed/read-only custom key", () => {
  it("rejects a calculated/rollup custom column", async () => {
    setEnv({ CUSTOM_COLUMNS_MODE: "metadata" });
    dvReqMock.mockImplementation((req: { url: string }) => {
      if (ATTRIBUTES_URL_RE.test(req.url)) {
        return jsonOk({
          value: [
            attrRow({
              LogicalName: "new_rollup",
              AttributeType: "Integer",
              AttributeTypeName: { Value: "IntegerType" },
              SourceType: 1, // computed
            }),
          ],
        });
      }
      throw new Error("unexpected request: " + req.url);
    });

    await expect(
      validateCustomColumnKeys([task({ new_rollup: 5 })], "create"),
    ).rejects.toThrow(/calculated\/rollup\/derived column/);
  });

  it("rejects a column not valid for create", async () => {
    setEnv({ CUSTOM_COLUMNS_MODE: "metadata" });
    dvReqMock.mockImplementation((req: { url: string }) => {
      if (ATTRIBUTES_URL_RE.test(req.url)) {
        return jsonOk({
          value: [
            attrRow({
              LogicalName: "new_readonly",
              AttributeType: "Integer",
              AttributeTypeName: { Value: "IntegerType" },
              IsValidForCreate: false,
            }),
          ],
        });
      }
      throw new Error("unexpected request: " + req.url);
    });

    await expect(
      validateCustomColumnKeys([task({ new_readonly: 1 })], "create"),
    ).rejects.toThrow(/not valid for create/);
  });
});

describe("validateCustomColumnKeys — rejects a lookup written with the wrong key", () => {
  it("rejects the logical-name form instead of the resolved nav @odata.bind", async () => {
    setEnv({ CUSTOM_COLUMNS_MODE: "metadata" });
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
      if (ENTITY_SET_RE.test(req.url)) return jsonOk({ EntitySetName: "teams" });
      throw new Error("unexpected request: " + req.url);
    });

    // Wrong: using the lowercase logical name as the bind key instead of the
    // resolved nav property 'new_OwningTeam'.
    await expect(
      validateCustomColumnKeys(
        [task({ "new_owningteam@odata.bind": "/teams(" + guid(3) + ")" })],
        "create",
      ),
    ).rejects.toThrow(/Use 'new_OwningTeam@odata.bind' instead/);
  });

  it("accepts the correct resolved nav @odata.bind key", async () => {
    setEnv({ CUSTOM_COLUMNS_MODE: "metadata" });
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
      if (ENTITY_SET_RE.test(req.url)) return jsonOk({ EntitySetName: "teams" });
      throw new Error("unexpected request: " + req.url);
    });

    await expect(
      validateCustomColumnKeys(
        [task({ "new_OwningTeam@odata.bind": "/teams(" + guid(3) + ")" })],
        "create",
      ),
    ).resolves.toBeUndefined();
  });

  it("rejects @odata.bind on a non-lookup custom column", async () => {
    setEnv({ CUSTOM_COLUMNS_MODE: "metadata" });
    dvReqMock.mockImplementation((req: { url: string }) => {
      if (ATTRIBUTES_URL_RE.test(req.url)) {
        return jsonOk({
          value: [
            attrRow({
              LogicalName: "new_riskscore",
              AttributeType: "Integer",
              AttributeTypeName: { Value: "IntegerType" },
            }),
          ],
        });
      }
      throw new Error("unexpected request: " + req.url);
    });

    await expect(
      validateCustomColumnKeys([task({ "new_riskscore@odata.bind": "/foo(1)" })], "create"),
    ).rejects.toThrow(/not a lookup/);
  });
});

describe("validateCustomColumnKeys — unknown custom column / unsupported entity", () => {
  it("rejects an unknown custom column name", async () => {
    setEnv({ CUSTOM_COLUMNS_MODE: "metadata" });
    dvReqMock.mockImplementation((req: { url: string }) => {
      if (ATTRIBUTES_URL_RE.test(req.url)) return jsonOk({ value: [] });
      throw new Error("unexpected request: " + req.url);
    });

    await expect(
      validateCustomColumnKeys([task({ new_doesnotexist: 1 })], "create"),
    ).rejects.toThrow(/not a known custom column/);
  });

  it("rejects a custom key on an entity type without a custom-column story (dependency)", async () => {
    setEnv({ CUSTOM_COLUMNS_MODE: "metadata" });
    await expect(
      validateCustomColumnKeys(
        [
          {
            "@odata.type": DEP,
            "msdyn_PredecessorTask@odata.bind": "/msdyn_projecttasks(" + guid(1) + ")",
            "msdyn_SuccessorTask@odata.bind": "/msdyn_projecttasks(" + guid(2) + ")",
            new_customfield: 1,
          },
        ],
        "create",
      ),
    ).rejects.toThrow(/does not support custom columns/);
    // No metadata fetch needed to reject this — it's an entity-type check.
    expect(dvReqMock).not.toHaveBeenCalled();
  });
});

describe("Defense-in-depth: existing guardrails still fire with custom keys present", () => {
  it("summary-task protection still rejects a rolled-up field write even with a custom key alongside it", () => {
    const id = guid(7);
    // validateUpdateEntities is synchronous and runs BEFORE the async custom-key
    // check in the real handler — prove it still throws on its own, unaffected
    // by the presence of a custom key in the same entity.
    expect(() =>
      validateUpdateEntities(
        [
          {
            "@odata.type": TASK,
            msdyn_projecttaskid: id,
            msdyn_finish: "2026-07-01",
            new_riskscore: 7,
          },
        ],
        [id],
      ),
    ).toThrow(/roll up from its children/);
  });

  it("the 200-entity cap still rejects an oversized create batch even when custom keys are present", () => {
    const many = Array.from({ length: 201 }, (_, i) =>
      task({
        msdyn_projecttaskid: guid(i + 1).replace(/^../, ((i % 99) + 1).toString(16).padStart(2, "0")),
        new_riskscore: i,
      }),
    );
    expect(() => validateAddEntities(many)).toThrow(/Max 200/);
  });

  it("the 200-entity cap still rejects an oversized update batch even when custom keys are present", () => {
    const many = Array.from({ length: 201 }, (_, i) => ({
      "@odata.type": TASK,
      msdyn_projecttaskid: guid(i + 1).replace(/^../, ((i % 99) + 1).toString(16).padStart(2, "0")),
      new_riskscore: i,
    }));
    expect(() => validateUpdateEntities(many)).toThrow(/Max 200/);
  });

  it("blocked-on-create fields are still rejected on create even when a custom key is present", () => {
    expect(() =>
      validateAddEntities([task({ msdyn_ismilestone: true, new_riskscore: 7 })]),
    ).toThrow(/not allowed on PSS create/);
  });
});
