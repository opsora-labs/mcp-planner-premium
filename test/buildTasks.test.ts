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
const CHK = "Microsoft.Dynamics.CRM.msdyn_projectchecklist";

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

  it("accepts bucketId as an alias for bucket (GUID bypass)", () => {
    const built = buildTaskEntities(
      PROJECT,
      [{ ref: "t1", subject: "X", bucketId: BUCKET }],
      resolve,
    );
    expect(built.entities[0]["msdyn_projectbucket@odata.bind"]).toBe(
      "/msdyn_projectbuckets(" + BUCKET + ")",
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
    // dependencyIds must contain the dep's primary key so callers can delete it later.
    expect(built.dependencyIds).toHaveLength(1);
    expect(built.dependencyIds[0]).toBe(dep.msdyn_projecttaskdependencyid);;
    expect(dep.msdyn_projecttaskdependencylinktype).toBe(192350001); // SS
    expect(dep.msdyn_projecttaskdependencylinklag).toBe(120);
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

  it("builds checklist items (string + object form) as child entities", () => {
    const built = buildTaskEntities(
      PROJECT,
      [
        {
          ref: "t1",
          subject: "Prepare",
          bucket: BUCKET,
          checklist: ["Draft outline", { title: "Review", completed: true }],
        },
      ],
      resolve,
    );
    const chks = built.entities.filter((e) => e["@odata.type"] === CHK);
    expect(chks).toHaveLength(2);
    expect(built.checklistIds).toHaveLength(2);
    const taskId = built.refToId.t1;
    for (const c of chks) {
      expect(c["msdyn_ProjectTaskId@odata.bind"]).toBe("/msdyn_projecttasks(" + taskId + ")");
      expect(typeof c.msdyn_name).toBe("string");
      expect(GUID_RE.test(c.msdyn_projectchecklistid)).toBe(true);
    }
    const byName = Object.fromEntries(chks.map((c) => [c.msdyn_name, c]));
    expect(byName["Draft outline"].msdyn_projectchecklistcompleted).toBe(false);
    expect(byName["Review"].msdyn_projectchecklistcompleted).toBe(true);
    // Checklist entities come after task entities and pass the raw guardrails.
    expect(() => validateAddEntities(built.entities)).not.toThrow();
  });

  it("rejects an empty checklist item title", () => {
    expect(() =>
      buildTaskEntities(
        PROJECT,
        [{ ref: "t1", subject: "X", bucket: BUCKET, checklist: ["  "] }],
        resolve,
      ),
    ).toThrow(/checklist item title/i);
  });

  it("binds a sprint via the resolver", () => {
    const SPRINT = "cccccccc-1111-2222-3333-444444444444";
    const built = buildTaskEntities(
      PROJECT,
      [{ ref: "t1", subject: "X", bucket: BUCKET, sprint: "Sprint 1" }],
      resolve,
      LINK_TYPE_VALUES_GLOBAL,
      () => SPRINT,
    );
    const task = built.entities.find((e) => e["@odata.type"] === TASK)!;
    expect(task["msdyn_projectsprint@odata.bind"]).toBe("/msdyn_projectsprints(" + SPRINT + ")");
  });

  it("throws when a sprint cannot be resolved", () => {
    expect(() =>
      buildTaskEntities(
        PROJECT,
        [{ ref: "t1", subject: "X", bucket: BUCKET, sprint: "Ghost" }],
        resolve,
        LINK_TYPE_VALUES_GLOBAL,
        () => "",
      ),
    ).toThrow(/sprint 'Ghost' could not be resolved/i);
  });

  it("builds a label junction for a resolved label and warns + skips an unknown one", () => {
    const LBL = "Microsoft.Dynamics.CRM.msdyn_projecttasktolabel";
    const LABEL = "dddddddd-1111-2222-3333-555555555555";
    const built = buildTaskEntities(
      PROJECT,
      [{ ref: "t1", subject: "X", bucket: BUCKET, labels: ["Issue / Risk", "Unknown"] }],
      resolve,
      LINK_TYPE_VALUES_GLOBAL,
      undefined,
      (l) => (l === "Issue / Risk" ? LABEL : ""),
    );
    const junctions = built.entities.filter((e) => e["@odata.type"] === LBL);
    expect(junctions).toHaveLength(1);
    expect(junctions[0]["msdyn_ProjectLabelId@odata.bind"]).toBe("/msdyn_projectlabels(" + LABEL + ")");
    expect(built.warnings.some((w) => /label 'Unknown' was skipped/i.test(w))).toBe(true);
  });

  it("builds a resource assignment for a resolved team member (no start/finish)", () => {
    const ASG = "Microsoft.Dynamics.CRM.msdyn_resourceassignment";
    const TEAM = "eeeeeeee-1111-2222-3333-666666666666";
    const RES = "ffffffff-1111-2222-3333-777777777777";
    const built = buildTaskEntities(
      PROJECT,
      [{ ref: "t1", subject: "X", bucket: BUCKET, assignees: ["Jane", "Ghost"] }],
      resolve,
      LINK_TYPE_VALUES_GLOBAL,
      undefined,
      undefined,
      (a) => (a === "Jane" ? { teamMemberId: TEAM, bookableResourceId: RES } : null),
    );
    const asg = built.entities.filter((e) => e["@odata.type"] === ASG);
    expect(asg).toHaveLength(1);
    expect(asg[0]["msdyn_taskid@odata.bind"]).toBe("/msdyn_projecttasks(" + built.refToId.t1 + ")");
    expect(asg[0]["msdyn_projectid@odata.bind"]).toBe("/msdyn_projects(" + PROJECT + ")");
    expect(asg[0]["msdyn_projectteamid@odata.bind"]).toBe("/msdyn_projectteams(" + TEAM + ")");
    expect(asg[0]["msdyn_bookableresourceid@odata.bind"]).toBe("/bookableresources(" + RES + ")");
    // start/finish are blocked on create for assignments — must not be present.
    expect("msdyn_start" in asg[0]).toBe(false);
    expect("msdyn_finish" in asg[0]).toBe(false);
    expect(built.warnings.some((w) => /assignee 'Ghost' was skipped/i.test(w))).toBe(true);
    // The assignment's lowercase project bind must pass the (now entity-aware) guard.
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

  it("warns when effortHours is set on a summary (parent) task", () => {
    const tasks: SimpleTask[] = [
      { ref: "parent", subject: "P", bucket: BUCKET, effortHours: 40 },
      { ref: "child", subject: "C", bucket: BUCKET, parent: "parent", effortHours: 8 },
    ];
    const built = buildTaskEntities(PROJECT, tasks, resolve);
    // Parent has effortHours — PSS ignores it and rolls up from children.
    expect(built.warnings).toHaveLength(1);
    expect(built.warnings[0]).toMatch(/parent/);
    expect(built.warnings[0]).toMatch(/effortHours.*ignored.*summary/i);
    // Leaf child has effortHours — no warning about it by its ref name.
    expect(built.warnings.every((w) => !w.includes("tasks[child]"))).toBe(true);
  });

  it("emits no warnings when effortHours is only on leaf tasks", () => {
    const tasks: SimpleTask[] = [
      { ref: "a", subject: "A", bucket: BUCKET, effortHours: 8 },
      { ref: "b", subject: "B", bucket: BUCKET, effortHours: 16 },
    ];
    const built = buildTaskEntities(PROJECT, tasks, resolve);
    expect(built.warnings).toHaveLength(0);
  });

  it("warns when a description contains tag-like <...> content (stripped by Dataverse)", () => {
    const built = buildTaskEntities(
      PROJECT,
      [{ ref: "t1", subject: "X", bucket: BUCKET, description: "due <2 weeks> out" }],
      resolve,
    );
    expect(built.warnings).toHaveLength(1);
    expect(built.warnings[0]).toMatch(/angle-bracket/i);
    expect(built.warnings[0]).toMatch(/tasks\[t1\]/);
    // The description is still queued as-is (the warning does not block it).
    expect(built.entities[0].msdyn_description).toBe("due <2 weeks> out");
  });

  it("does not warn for a description with only a lone < (no closing >)", () => {
    const built = buildTaskEntities(
      PROJECT,
      [{ ref: "t1", subject: "X", bucket: BUCKET, description: "budget < 10k this quarter" }],
      resolve,
    );
    expect(built.warnings).toHaveLength(0);
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
    ).toThrow(/'bucket' is required/);
  });
});
