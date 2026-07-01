import { describe, it, expect } from "vitest";
import {
  buildTaskEntities,
  spliceCustomFields,
  type ResolveCustomColumn,
} from "../src/tools/addTasksSimple.js";
import { buildUpdateEntities } from "../src/tools/updateTasksSimple.js";
import type { ColumnMeta } from "../src/dataverse/columnTypes.js";

/**
 * Phase 5 tests: customFields splicing in the pure builders, via an INJECTED
 * FAKE resolver (no network — mirrors how buildTaskEntities is already tested
 * with a fake resolveBucketId in test/buildTasks.test.ts).
 */

const PROJECT = "11111111-1111-1111-1111-111111111111";
const BUCKET = "22222222-2222-2222-2222-222222222222";
const TASK_ID = "33333333-3333-3333-3333-333333333333";
const TEAM_GUID = "44444444-4444-4444-4444-444444444444";

const resolveBucketId = () => BUCKET;

function col(overrides: Partial<ColumnMeta>): ColumnMeta {
  return {
    logicalName: "new_x",
    schemaName: "new_x",
    type: "string",
    isCustom: true,
    isValidForCreate: true,
    isValidForUpdate: true,
    isComputed: false,
    ...overrides,
  };
}

// Fixture columns, keyed by logical name — a small custom schema shared across tests.
const FIXTURE_COLUMNS: Record<string, ColumnMeta> = {
  new_riskscore: col({ logicalName: "new_riskscore", type: "int" }),
  new_category: col({
    logicalName: "new_category",
    type: "picklist",
    options: [
      { value: 1, label: "Low" },
      { value: 2, label: "High" },
    ],
  }),
  new_reviewdate: col({ logicalName: "new_reviewdate", type: "dateonly" }),
  new_owningteam: col({
    logicalName: "new_owningteam",
    type: "lookup",
    navigationProperty: "new_OwningTeam",
    targets: ["team"],
    targetEntitySets: { team: "teams" },
  }),
  new_computed: col({ logicalName: "new_computed", type: "int", isComputed: true }),
  new_readonly: col({ logicalName: "new_readonly", type: "int", isValidForCreate: false, isValidForUpdate: false }),
};

const fakeResolver: ResolveCustomColumn = (name) => FIXTURE_COLUMNS[name];

describe("spliceCustomFields (unit)", () => {
  it("splices a scalar (int) fragment under the logical name", () => {
    const ent: Record<string, unknown> = {};
    spliceCustomFields(ent, { new_riskscore: 7 }, "create", fakeResolver, "ctx");
    expect(ent).toEqual({ new_riskscore: 7 });
  });

  it("splices a picklist label -> integer value", () => {
    const ent: Record<string, unknown> = {};
    spliceCustomFields(ent, { new_category: "High" }, "create", fakeResolver, "ctx");
    expect(ent).toEqual({ new_category: 2 });
  });

  it("splices a picklist integer value through unchanged", () => {
    const ent: Record<string, unknown> = {};
    spliceCustomFields(ent, { new_category: 1 }, "create", fakeResolver, "ctx");
    expect(ent).toEqual({ new_category: 1 });
  });

  it("splices a dateonly value as YYYY-MM-DD", () => {
    const ent: Record<string, unknown> = {};
    spliceCustomFields(ent, { new_reviewdate: "2026-08-01" }, "create", fakeResolver, "ctx");
    expect(ent).toEqual({ new_reviewdate: "2026-08-01" });
  });

  it("splices a lookup bare-guid input into <nav>@odata.bind -> /set(guid) (single target)", () => {
    const ent: Record<string, unknown> = {};
    spliceCustomFields(ent, { new_owningteam: TEAM_GUID }, "create", fakeResolver, "ctx");
    expect(ent).toEqual({ "new_OwningTeam@odata.bind": "/teams(" + TEAM_GUID + ")" });
  });

  it("splices a lookup {target,id} input the same way", () => {
    const ent: Record<string, unknown> = {};
    spliceCustomFields(
      ent,
      { new_owningteam: { target: "team", id: TEAM_GUID } },
      "create",
      fakeResolver,
      "ctx",
    );
    expect(ent).toEqual({ "new_OwningTeam@odata.bind": "/teams(" + TEAM_GUID + ")" });
  });

  it("rejects an msdyn_* key with a message pointing to the named parameter", () => {
    const ent: Record<string, unknown> = {};
    expect(() =>
      spliceCustomFields(ent, { msdyn_subject: "nope" }, "create", fakeResolver, "ctx"),
    ).toThrow(/starts with 'msdyn_'.*named parameter/s);
  });

  it("rejects an unknown picklist label", () => {
    const ent: Record<string, unknown> = {};
    expect(() =>
      spliceCustomFields(ent, { new_category: "Nonexistent" }, "create", fakeResolver, "ctx"),
    ).toThrow(/no option labeled 'Nonexistent'/);
  });

  it("rejects a computed/read-only column on write", () => {
    const ent: Record<string, unknown> = {};
    expect(() =>
      spliceCustomFields(ent, { new_computed: 1 }, "create", fakeResolver, "ctx"),
    ).toThrow(/calculated\/rollup\/derived column/);
  });

  it("rejects a column not valid for the given mode", () => {
    const ent: Record<string, unknown> = {};
    expect(() =>
      spliceCustomFields(ent, { new_readonly: 1 }, "create", fakeResolver, "ctx"),
    ).toThrow(/not valid for create/);
  });

  it("rejects an unknown custom column with a pointer to list_custom_columns", () => {
    const ent: Record<string, unknown> = {};
    expect(() =>
      spliceCustomFields(ent, { new_doesnotexist: 1 }, "create", fakeResolver, "ctx"),
    ).toThrow(/not a known custom column.*list_custom_columns/s);
  });

  it("throws when customFields are provided but no resolver is injected (feature unavailable)", () => {
    const ent: Record<string, unknown> = {};
    expect(() =>
      spliceCustomFields(ent, { new_riskscore: 1 }, "create", undefined, "ctx"),
    ).toThrow(/CUSTOM_COLUMNS_MODE/);
  });

  it("is a no-op when customFields is undefined or empty", () => {
    const ent: Record<string, unknown> = { msdyn_subject: "x" };
    spliceCustomFields(ent, undefined, "create", fakeResolver, "ctx");
    spliceCustomFields(ent, {}, "create", fakeResolver, "ctx");
    expect(ent).toEqual({ msdyn_subject: "x" });
  });
});

describe("buildTaskEntities — customFields splicing (add_tasks)", () => {
  it("splices customFields into the created task entity alongside standard fields", () => {
    const built = buildTaskEntities(
      PROJECT,
      [
        {
          ref: "t1",
          subject: "Task with custom fields",
          bucket: BUCKET,
          customFields: { new_riskscore: 7, new_category: "High" },
        },
      ],
      resolveBucketId,
      undefined,
      undefined,
      undefined,
      undefined,
      fakeResolver,
    );
    const ent = built.entities[0];
    expect(ent.msdyn_subject).toBe("Task with custom fields");
    expect(ent.new_riskscore).toBe(7);
    expect(ent.new_category).toBe(2);
  });

  it("throws (fails closed) when customFields references an msdyn_ key — never a silent drop", () => {
    expect(() =>
      buildTaskEntities(
        PROJECT,
        [{ ref: "t1", subject: "T", bucket: BUCKET, customFields: { msdyn_progress: 0.5 } }],
        resolveBucketId,
        undefined,
        undefined,
        undefined,
        undefined,
        fakeResolver,
      ),
    ).toThrow(/starts with 'msdyn_'/);
  });

  it("throws when customFields is provided but no resolver was injected", () => {
    expect(() =>
      buildTaskEntities(
        PROJECT,
        [{ ref: "t1", subject: "T", bucket: BUCKET, customFields: { new_riskscore: 1 } }],
        resolveBucketId,
      ),
    ).toThrow(/CUSTOM_COLUMNS_MODE/);
  });

  it("does not affect tasks without customFields (byte-for-byte unchanged)", () => {
    const built = buildTaskEntities(
      PROJECT,
      [{ ref: "t1", subject: "Plain task", bucket: BUCKET }],
      resolveBucketId,
      undefined,
      undefined,
      undefined,
      undefined,
      fakeResolver,
    );
    const ent = built.entities[0];
    expect(Object.keys(ent).sort()).toEqual(
      [
        "@odata.type",
        "msdyn_project@odata.bind",
        "msdyn_projectbucket@odata.bind",
        "msdyn_projecttaskid",
        "msdyn_subject",
      ].sort(),
    );
  });
});

describe("buildUpdateEntities — customFields splicing (update_tasks)", () => {
  it("splices customFields into the update entity, including a lookup @odata.bind", () => {
    const { entities } = buildUpdateEntities(
      [{ taskId: TASK_ID, customFields: { new_owningteam: TEAM_GUID } }],
      undefined,
      undefined,
      fakeResolver,
    );
    expect(entities[0]["new_OwningTeam@odata.bind"]).toBe("/teams(" + TEAM_GUID + ")");
  });

  it("customFields alone counts as a change (does not trip 'nothing to change')", () => {
    expect(() =>
      buildUpdateEntities(
        [{ taskId: TASK_ID, customFields: { new_riskscore: 3 } }],
        undefined,
        undefined,
        fakeResolver,
      ),
    ).not.toThrow();
  });

  it("throws (fails closed) on an msdyn_ key inside customFields on update", () => {
    expect(() =>
      buildUpdateEntities(
        [{ taskId: TASK_ID, customFields: { msdyn_ismilestone: true } }],
        undefined,
        undefined,
        fakeResolver,
      ),
    ).toThrow(/starts with 'msdyn_'/);
  });

  it("rejects a computed custom column on update", () => {
    expect(() =>
      buildUpdateEntities(
        [{ taskId: TASK_ID, customFields: { new_computed: 1 } }],
        undefined,
        undefined,
        fakeResolver,
      ),
    ).toThrow(/calculated\/rollup\/derived column/);
  });
});
