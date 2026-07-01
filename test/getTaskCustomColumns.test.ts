import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock the dataverse transport seam: dvHeaders is request-context-free-ified,
// dvReq is fully mocked so no network call happens.
const dvReqMock = vi.fn();
vi.mock("../src/dataverse.js", async () => {
  const actual = await vi.importActual<typeof import("../src/dataverse.js")>(
    "../src/dataverse.js",
  );
  return {
    ...actual,
    dvReq: (...args: unknown[]) => dvReqMock(...args),
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

import { getTask } from "../src/tools/getTask.js";
import { resetEnvCache } from "../src/config.js";
import { resetCapabilities } from "../src/tools/capabilities.js";
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

const TASK_ID = "11111111-1111-1111-1111-111111111111";

function riskscoreCol(): ColumnMeta {
  return {
    logicalName: "new_riskscore",
    schemaName: "new_riskscore",
    type: "int",
    isCustom: true,
    isValidForCreate: true,
    isValidForUpdate: true,
    isComputed: false,
  };
}

beforeEach(() => {
  setEnv();
  resetCapabilities();
  dvReqMock.mockReset();
  getEntityMetadataMock.mockReset();
});
afterEach(() => {
  resetCapabilities();
  resetEnvCache();
});

function coreTaskBody(extra: Record<string, unknown> = {}) {
  return {
    msdyn_projecttaskid: TASK_ID,
    msdyn_subject: "Test task",
    msdyn_start: "2026-01-01T00:00:00Z",
    msdyn_finish: "2026-01-10T00:00:00Z",
    msdyn_progress: 0.5,
    msdyn_effort: 8,
    msdyn_outlinelevel: 1,
    msdyn_displaysequence: 1,
    msdyn_ismilestone: false,
    msdyn_priority: 1,
    _msdyn_projectbucket_value: null,
    _msdyn_parenttask_value: null,
    _msdyn_projectsprint_value: null,
    ...extra,
  };
}

function mockSubReadsOk() {
  // Dependencies, isSummary child-check, assignments — all return empty/ok so
  // getTask's warnings stay clean and we can assert on customFields alone.
  dvReqMock.mockImplementation((req: { url: string }) => {
    if (req.url.includes("/msdyn_projecttaskdependencies")) return Promise.resolve({ status: 200, json: { value: [] } });
    if (req.url.includes("/msdyn_projecttasks?") && req.url.includes("$top=1"))
      return Promise.resolve({ status: 200, json: { value: [] } });
    if (req.url.includes("/msdyn_resourceassignments")) return Promise.resolve({ status: 200, json: { value: [] } });
    return Promise.resolve({ status: 404, json: {} });
  });
}

describe("get_task — includeCustomColumns default-off (zero behaviour change)", () => {
  it("does not call getEntityMetadata when includeCustomColumns is omitted", async () => {
    setEnv({ CUSTOM_COLUMNS_MODE: "metadata" });
    dvReqMock.mockImplementation((req: { url: string }) => {
      if (req.url.includes("/msdyn_projecttasks(")) return Promise.resolve({ status: 200, json: coreTaskBody() });
      return Promise.resolve({ status: 200, json: { value: [] } });
    });
    const result: any = await getTask.handler({ taskId: TASK_ID });
    expect(result.ok).toBe(true);
    expect(result.task.customFields).toBeUndefined();
    expect(getEntityMetadataMock).not.toHaveBeenCalled();
  });
});

describe("get_task — includeCustomColumns happy path", () => {
  it("extends $select, widens Prefer for lookups, and returns customFields", async () => {
    setEnv({ CUSTOM_COLUMNS_MODE: "metadata" });
    getEntityMetadataMock.mockResolvedValue({
      entity: "msdyn_projecttask",
      columns: new Map([["new_riskscore", riskscoreCol()]]),
      fetchedAt: Date.now(),
    });
    let sawCustomColumnInSelect = false;
    dvReqMock.mockImplementation((req: { url: string }) => {
      if (req.url.includes("/msdyn_projecttasks(")) {
        sawCustomColumnInSelect = req.url.includes("new_riskscore");
        return Promise.resolve({ status: 200, json: coreTaskBody({ new_riskscore: 7 }) });
      }
      if (req.url.includes("/msdyn_projecttaskdependencies")) return Promise.resolve({ status: 200, json: { value: [] } });
      if (req.url.includes("$top=1")) return Promise.resolve({ status: 200, json: { value: [] } });
      if (req.url.includes("/msdyn_resourceassignments")) return Promise.resolve({ status: 200, json: { value: [] } });
      return Promise.resolve({ status: 404, json: {} });
    });

    const result: any = await getTask.handler({ taskId: TASK_ID, includeCustomColumns: true });
    expect(sawCustomColumnInSelect).toBe(true);
    expect(result.task.customFields).toEqual({ new_riskscore: 7 });
  });
});

describe("get_task — custom-column degrade (renamed/removed column)", () => {
  it("falls back to core-only with a warning when the requested custom column is missing", async () => {
    setEnv({ CUSTOM_COLUMNS_MODE: "metadata" });
    getEntityMetadataMock.mockResolvedValue({
      entity: "msdyn_projecttask",
      columns: new Map([["new_riskscore", riskscoreCol()]]),
      fetchedAt: Date.now(),
    });
    let call = 0;
    dvReqMock.mockImplementation((req: { url: string }) => {
      if (req.url.includes("/msdyn_projecttasks(")) {
        call++;
        if (call === 1) {
          return Promise.resolve({
            status: 400,
            json: { error: { message: "Could not find a property named 'new_riskscore'." } },
          });
        }
        return Promise.resolve({ status: 200, json: coreTaskBody() });
      }
      if (req.url.includes("/msdyn_projecttaskdependencies")) return Promise.resolve({ status: 200, json: { value: [] } });
      if (req.url.includes("$top=1")) return Promise.resolve({ status: 200, json: { value: [] } });
      if (req.url.includes("/msdyn_resourceassignments")) return Promise.resolve({ status: 200, json: { value: [] } });
      return Promise.resolve({ status: 404, json: {} });
    });

    const result: any = await getTask.handler({ taskId: TASK_ID, includeCustomColumns: true });
    expect(result.ok).toBe(true);
    expect(result.task.customFields).toBeUndefined();
    expect(result.warnings.some((w: string) => /no longer present/.test(w))).toBe(true);
  });
});

describe("get_task — mis-attribution regression (extended-field-absent vs custom-column-missing)", () => {
  it("a missing STANDARD extended field does not get misread as a custom-column removal, and does not corrupt customFields", async () => {
    setEnv({ CUSTOM_COLUMNS_MODE: "metadata" });
    getEntityMetadataMock.mockResolvedValue({
      entity: "msdyn_projecttask",
      columns: new Map([["new_riskscore", riskscoreCol()]]),
      fetchedAt: Date.now(),
    });
    let call = 0;
    dvReqMock.mockImplementation((req: { url: string }) => {
      if (req.url.includes("/msdyn_projecttasks(")) {
        call++;
        if (call === 1) {
          // First call includes BOTH extended fields and the custom column.
          // The absent property is a STANDARD extended field, not the custom
          // column — this must be treated as "extended absent", not "custom
          // column missing".
          expect(req.url).toContain("msdyn_duration");
          expect(req.url).toContain("new_riskscore");
          return Promise.resolve({
            status: 400,
            json: { error: { message: "Could not find a property named 'msdyn_duration'." } },
          });
        }
        // Second call (core + custom, no extended) should succeed and still
        // include the custom column.
        expect(req.url).not.toContain("msdyn_duration");
        expect(req.url).toContain("new_riskscore");
        return Promise.resolve({ status: 200, json: coreTaskBody({ new_riskscore: 42 }) });
      }
      if (req.url.includes("/msdyn_projecttaskdependencies")) return Promise.resolve({ status: 200, json: { value: [] } });
      if (req.url.includes("$top=1")) return Promise.resolve({ status: 200, json: { value: [] } });
      if (req.url.includes("/msdyn_resourceassignments")) return Promise.resolve({ status: 200, json: { value: [] } });
      return Promise.resolve({ status: 404, json: {} });
    });

    const result: any = await getTask.handler({ taskId: TASK_ID, includeCustomColumns: true });
    expect(result.ok).toBe(true);
    // The custom column survived — it was NOT wrongly cleared by the
    // extended-field-absent branch.
    expect(result.task.customFields).toEqual({ new_riskscore: 42 });
    // No "no longer present" warning — the custom column was never actually missing.
    expect(result.warnings.some((w: string) => /no longer present/.test(w))).toBe(false);
    expect(call).toBe(2);
  });
});
