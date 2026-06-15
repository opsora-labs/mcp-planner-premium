import { describe, it, expect } from "vitest";
import {
  buildTaskEntities,
  LINK_TYPE_VALUES_GLOBAL,
  LINK_TYPE_VALUES_EU,
  type SimpleTask,
} from "../src/tools/addTasksSimple.js";
import { validateAddEntities } from "../src/tools/addTasks.js";

const PROJECT = "11111111-2222-3333-4444-555555555555";
const BUCKET = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const GUID_RE = /^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$/;

// Stub resolver: every bucket name maps to the same bucket GUID.
const resolve = (b: string) => (GUID_RE.test(b) ? b : BUCKET);

const TASK = "Microsoft.Dynamics.CRM.msdyn_projecttask";
const DEP = "Microsoft.Dynamics.CRM.msdyn_projecttaskdependency";

describe("buildTaskEntities", () => {
  it("builds a minimal task with generated GUID and correct binds", () => {
    const built = buildTaskEntities(
      PROJECT,
      [{ ref: "t1", subject: "Design", bucket: "Sprint 1" }],
      resolve,
    );
    expect(built.entities).toHaveLength(1);
    const e = built.entities[0];
    expect(e["@odata.type"]).toBe(TASK);
    expect(GUID_RE.test(e.msdyn_projecttaskid)).toBe(true);
    expect(e["msdyn_project@odata.bind"]).toBe("/msdyn_projects(" + PROJECT + ")");
    expect(e["msdyn_projectbucket@odata.bind"]).toBe(
      "/msdyn_projectbuckets(" + BUCKET + ")",
    );
    expect(built.refToId.t1).toBe(e.msdyn_projecttaskid);
    // The built collection must satisfy the raw guardrails.
    expect(() => validateAddEntities(built.entities)).not.toThrow();
  });

  it("maps start/finish/effort to the right Dataverse fields", () => {
    const built = buildTaskEntities(
      PROJECT,
      [
        {
          ref: "t1",
          subject: "X",
          bucket: BUCKET,
          start: "2026-07-01",
          finish: "2026-07-05",
          effortHours: 16,
        },
      ],
      resolve,
    );
    const e = built.entities[0];
    expect(e.msdyn_start).toBe("2026-07-01");
    expect(e.msdyn_finish).toBe("2026-07-05");
    expect(e.msdyn_effort).toBe(16);
  });

  it("orders parents before children regardless of input order", () => {
    const tasks: SimpleTask[] = [
      { ref: "child", subject: "C", bucket: BUCKET, parent: "parent" },
      { ref: "parent", subject: "P", bucket: BUCKET },
    ];
    const built = buildTaskEntities(PROJECT, tasks, resolve);
    const ids = built.entities.map((e) => e.msdyn_projecttaskid);
    expect(ids.indexOf(built.refToId.parent)).toBeLessThan(
      ids.indexOf(built.refToId.child),
    );
    const childEnt = built.entities.find(
      (e) => e.msdyn_projecttaskid === built.refToId.child,
    );
    expect(childEnt["msdyn_parenttask@odata.bind"]).toBe(
      "/msdyn_projecttasks(" + built.refToId.parent + ")",
    );
    expect(() => validateAddEntities(built.entities)).not.toThrow();
  });

  it("accepts an existing task GUID as parent", () => {
    const existing = "99999999-8888-7777-6666-555555555555";
    const built = buildTaskEntities(
      PROJECT,
      [{ ref: "t1", subject: "X", bucket: BUCKET, parent: existing }],
      resolve,
    );
    expect(built.entities[0]["msdyn_parenttask@odata.bind"]).toBe(
      "/msdyn_projecttasks(" + existing + ")",
    );
  });

  it("detects a hierarchy cycle", () => {
    const tasks: SimpleTask[] = [
      { ref: "a", subject: "A", bucket: BUCKET, parent: "b" },
      { ref: "b", subject: "B", bucket: BUCKET, parent: "a" },
    ];
    expect(() => buildTaskEntities(PROJECT, tasks, resolve)).toThrow(/Cycle/);
  });

  it("rejects an unknown in-batch parent ref", () => {
    expect(() =>
      buildTaskEntities(
        PROJECT,
        [{ ref: "t1", subject: "X", bucket: BUCKET, parent: "ghost" }],
        resolve,
      ),
    ).toThrow(/neither a ref in this batch nor a GUID/);
  });

  it("builds a dependency with FS->option value and lag, appended after tasks", () => {
    const tasks: SimpleTask[] = [
      { ref: "a", subject: "A", bucket: BUCKET },
      {
        ref: "b",
        subject: "B",
        bucket: BUCKET,
        dependsOn: [{ on: "a", type: "SS", lagMinutes: 120 }],
      },
    ];
    const built = buildTaskEntities(PROJECT, tasks, resolve);
    const deps = built.entities.filter((e) => e["@odata.type"] === TASK ? false : true);
    expect(deps).toHaveLength(1);
    const dep = built.entities.find((e) => e["@odata.type"] === DEP)!;
    expect(dep.msdyn_projecttaskdependencylinktype).toBe(192350001); // SS
    expect(dep.msdyn_linklagduration).toBe(120);
    // PSS requires the project bind on the dependency entity. On
    // msdyn_projecttaskdependency, all lookup nav-properties use the PascalCase
    // schema name — msdyn_Project (capital P), not msdyn_project (lowercase).
    // Lowercase causes "undeclared property 'msdyn_project' which only has
    // property annotations" (ODataException).
    expect(dep["msdyn_Project@odata.bind"]).toBe("/msdyn_projects(" + PROJECT + ")");
    expect("msdyn_project@odata.bind" in dep).toBe(false);
    // Lookup binds use the PascalCase schema nav-property names. The lowercase
    // logical names make Dataverse reject the payload as annotation-only.
    expect(dep["msdyn_PredecessorTask@odata.bind"]).toBe(
      "/msdyn_projecttasks(" + built.refToId.a + ")",
    );
    expect(dep["msdyn_SuccessorTask@odata.bind"]).toBe(
      "/msdyn_projecttasks(" + built.refToId.b + ")",
    );
    // Regression guard for the annotation-only-property bug: the lowercase
    // logical-name keys must NOT be present.
    expect("msdyn_predecessortask@odata.bind" in dep).toBe(false);
    expect("msdyn_successortask@odata.bind" in dep).toBe(false);
    // Every `<x>@odata.bind` annotation on the dependency must carry a value
    // (an annotation with no property value is exactly what Dataverse rejects).
    for (const k of Object.keys(dep)) {
      if (k.endsWith("@odata.bind")) {
        expect(typeof dep[k]).toBe("string");
        expect((dep[k] as string).length).toBeGreaterThan(0);
      }
    }
    // All task entities precede all dependency entities.
    const lastTask = Math.max(
      ...built.entities
        .map((e, i) => (e["@odata.type"] === TASK ? i : -1))
        .filter((i) => i >= 0),
    );
    const firstDep = built.entities.findIndex((e) => e["@odata.type"] === DEP);
    expect(lastTask).toBeLessThan(firstDep);
    expect(() => validateAddEntities(built.entities)).not.toThrow();
  });

  it("does not put milestone in the payload but returns its taskId", () => {
    const built = buildTaskEntities(
      PROJECT,
      [{ ref: "m", subject: "Launch", bucket: BUCKET, milestone: true }],
      resolve,
    );
    expect(built.entities[0].msdyn_ismilestone).toBeUndefined();
    expect(built.milestoneTaskIds).toEqual([built.refToId.m]);
    expect(() => validateAddEntities(built.entities)).not.toThrow();
  });

  it("uses EU link type values (0-3) when the EU map is passed", () => {
    const tasks: SimpleTask[] = [
      { ref: "a", subject: "A", bucket: BUCKET },
      { ref: "b", subject: "B", bucket: BUCKET, dependsOn: [{ on: "a", type: "FS" }] },
    ];
    const builtGlobal = buildTaskEntities(PROJECT, tasks, resolve, LINK_TYPE_VALUES_GLOBAL);
    const builtEu = buildTaskEntities(PROJECT, tasks, resolve, LINK_TYPE_VALUES_EU);
    const depGlobal = builtGlobal.entities.find((e) => e["@odata.type"] === DEP)!;
    const depEu = builtEu.entities.find((e) => e["@odata.type"] === DEP)!;
    expect(depGlobal.msdyn_projecttaskdependencylinktype).toBe(192350000); // FS global
    expect(depEu.msdyn_projecttaskdependencylinktype).toBe(1);             // FS eu
  });

  it("rejects duplicate refs and missing required fields", () => {
    expect(() =>
      buildTaskEntities(
        PROJECT,
        [
          { ref: "t1", subject: "A", bucket: BUCKET },
          { ref: "t1", subject: "B", bucket: BUCKET },
        ],
        resolve,
      ),
    ).toThrow(/Duplicate task ref/);
    expect(() =>
      buildTaskEntities(PROJECT, [{ ref: "t1", subject: "", bucket: BUCKET }], resolve),
    ).toThrow(/subject is required/);
    expect(() =>
      buildTaskEntities(PROJECT, [{ ref: "t1", subject: "A", bucket: "" }], resolve),
    ).toThrow(/bucket is required/);
  });
});
