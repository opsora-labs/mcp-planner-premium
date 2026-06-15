import { describe, it, expect } from "vitest";
import { buildUpdateEntities } from "../src/tools/updateTasksSimple.js";
import { validateUpdateEntities } from "../src/tools/updateTasks.js";

const ID = "11111111-2222-3333-4444-555555555555";
const TASK = "Microsoft.Dynamics.CRM.msdyn_projecttask";

describe("buildUpdateEntities", () => {
  it("emits only the provided fields with the right Dataverse keys", () => {
    const { entities, warnings } = buildUpdateEntities([
      { taskId: ID, subject: "Renamed", finish: "2026-08-01", effortHours: 8 },
    ]);
    expect(entities).toHaveLength(1);
    expect(warnings).toEqual([]);
    const e = entities[0];
    expect(e["@odata.type"]).toBe(TASK);
    expect(e.msdyn_projecttaskid).toBe(ID);
    expect(e.msdyn_subject).toBe("Renamed");
    expect(e.msdyn_finish).toBe("2026-08-01");
    expect(e.msdyn_effort).toBe(8);
    expect("msdyn_start" in e).toBe(false);
  });

  it("converts progressPercent (0-100) to msdyn_progress (0-1)", () => {
    expect(buildUpdateEntities([{ taskId: ID, progressPercent: 50 }]).entities[0].msdyn_progress).toBe(0.5);
    expect(buildUpdateEntities([{ taskId: ID, progressPercent: 100 }]).entities[0].msdyn_progress).toBe(1);
    expect(buildUpdateEntities([{ taskId: ID, progressPercent: 0 }]).entities[0].msdyn_progress).toBe(0);
  });

  it("rejects out-of-range progress", () => {
    expect(() => buildUpdateEntities([{ taskId: ID, progressPercent: 150 }])).toThrow(
      /between 0 and 100/,
    );
  });

  it("never emits msdyn_ismilestone and warns when milestone is passed", () => {
    // milestone alongside another change: the other field is applied, milestone
    // is dropped, and a warning is returned. PSS rejects msdyn_ismilestone on
    // update (ScheduleAPI-AV-0002), so it must never reach the payload.
    const { entities, warnings } = buildUpdateEntities([
      { taskId: ID, subject: "Keep", milestone: true },
    ]);
    expect("msdyn_ismilestone" in entities[0]).toBe(false);
    expect(entities[0].msdyn_subject).toBe("Keep");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/milestone.*ignored/i);
  });

  it("throws a clear error when milestone is the only field provided", () => {
    expect(() => buildUpdateEntities([{ taskId: ID, milestone: true }])).toThrow(
      /milestone cannot be changed via the API/,
    );
  });

  it("emits msdyn_projectbucket@odata.bind when a resolved bucketId is supplied", () => {
    const BUCKET = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";
    const resolved = new Map([[0, BUCKET]]);
    const { entities, warnings } = buildUpdateEntities(
      [{ taskId: ID, subject: "Move me", bucket: "Sprint 2" }],
      resolved,
    );
    expect(entities[0]["msdyn_projectbucket@odata.bind"]).toBe(
      "/msdyn_projectbuckets(" + BUCKET + ")",
    );
    expect(warnings).toHaveLength(0);
  });

  it("throws when bucket is provided but no resolved id is in the map", () => {
    expect(() =>
      buildUpdateEntities([{ taskId: ID, bucket: "Missing Bucket" }], new Map()),
    ).toThrow(/could not be resolved/);
  });

  it("requires a GUID taskId and at least one change", () => {
    expect(() => buildUpdateEntities([{ taskId: "nope", subject: "x" }])).toThrow(
      /taskId must be a GUID/,
    );
    expect(() => buildUpdateEntities([{ taskId: ID }])).toThrow(/nothing to change/);
  });

  it("output is rejected by the summary-task guard when targeting a summary task", () => {
    const { entities } = buildUpdateEntities([{ taskId: ID, finish: "2026-08-01" }]);
    expect(() => validateUpdateEntities(entities, [ID])).toThrow(/roll up from its children/);
    // ...but a rename on the same summary task is fine.
    const rename = buildUpdateEntities([{ taskId: ID, subject: "ok" }]);
    expect(() => validateUpdateEntities(rename.entities, [ID])).not.toThrow();
  });

  it("skips null start with a warning instead of emitting null to PSS", () => {
    const { entities, warnings } = buildUpdateEntities([
      { taskId: ID, subject: "Keep", start: null as any },
    ]);
    expect("msdyn_start" in entities[0]).toBe(false);
    expect(entities[0].msdyn_subject).toBe("Keep");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/start=null skipped/);
  });

  it("skips null finish with a warning instead of emitting null to PSS", () => {
    const { entities, warnings } = buildUpdateEntities([
      { taskId: ID, subject: "Keep", finish: null as any },
    ]);
    expect("msdyn_finish" in entities[0]).toBe(false);
    expect(entities[0].msdyn_subject).toBe("Keep");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/finish=null skipped/);
  });

  it("emits date strings that are non-null normally", () => {
    const { entities, warnings } = buildUpdateEntities([
      { taskId: ID, start: "2026-07-01", finish: "2026-07-05" },
    ]);
    expect(entities[0].msdyn_start).toBe("2026-07-01");
    expect(entities[0].msdyn_finish).toBe("2026-07-05");
    expect(warnings).toHaveLength(0);
  });
});
