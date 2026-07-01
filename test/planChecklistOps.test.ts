import { describe, it, expect } from "vitest";
import {
  planChecklistOps,
  checklistCreateEntity,
  checklistUpdateEntity,
  isExistingItemOp,
  hasRemoval,
  type ExistingChecklistItem,
  type ChecklistOpInput,
} from "../src/tools/checklist.js";

const TASK = "11111111-2222-3333-4444-555555555555";
const TASK2 = "22222222-3333-4444-5555-666666666666";
const ITEM_A = "aaaaaaaa-1111-2222-3333-444444444444";
const ITEM_B = "bbbbbbbb-1111-2222-3333-444444444444";
const ITEM_DUP1 = "cccccccc-1111-2222-3333-444444444444";
const ITEM_DUP2 = "dddddddd-1111-2222-3333-444444444444";

// Deterministic id generator so create GUIDs are predictable in assertions.
function seqIds(): () => string {
  let n = 0;
  return () => "new-" + ++n;
}

const existing = (): Map<string, ExistingChecklistItem[]> =>
  new Map([
    [
      TASK.toLowerCase(),
      [
        { id: ITEM_A, title: "Draft spec", completed: false },
        { id: ITEM_B, title: "Review", completed: false },
        { id: ITEM_DUP1, title: "Dupe", completed: false },
        { id: ITEM_DUP2, title: "Dupe", completed: true },
      ],
    ],
  ]);

const plan = (
  ops: ChecklistOpInput[],
  taskId = TASK,
  ex = existing(),
  ids = seqIds(),
) => planChecklistOps([{ taskId, ops }], ex, ids);

describe("checklist entity builders", () => {
  it("checklistCreateEntity builds the proven PssCreate shape (PascalCase task bind)", () => {
    expect(checklistCreateEntity(TASK, "chk-1", "Do it", true)).toEqual({
      "@odata.type": "Microsoft.Dynamics.CRM.msdyn_projectchecklist",
      msdyn_projectchecklistid: "chk-1",
      "msdyn_ProjectTaskId@odata.bind": "/msdyn_projecttasks(" + TASK + ")",
      msdyn_name: "Do it",
      msdyn_projectchecklistcompleted: true,
    });
  });

  it("checklistUpdateEntity emits only the fields being changed", () => {
    expect(checklistUpdateEntity(ITEM_A, { completed: true })).toEqual({
      "@odata.type": "Microsoft.Dynamics.CRM.msdyn_projectchecklist",
      msdyn_projectchecklistid: ITEM_A,
      msdyn_projectchecklistcompleted: true,
    });
    const renamed = checklistUpdateEntity(ITEM_A, { title: "New name" });
    expect(renamed.msdyn_name).toBe("New name");
    expect("msdyn_projectchecklistcompleted" in renamed).toBe(false);
  });
});

describe("op classification helpers", () => {
  it("isExistingItemOp: strings and bare adds are NOT existing-item ops", () => {
    expect(isExistingItemOp("Buy milk")).toBe(false);
    expect(isExistingItemOp({ title: "Buy milk" })).toBe(false);
    expect(isExistingItemOp({ id: ITEM_A, completed: true })).toBe(true);
    expect(isExistingItemOp({ match: "Draft spec", remove: true })).toBe(true);
  });

  it("hasRemoval detects any remove op", () => {
    expect(hasRemoval(["a", { title: "b" }])).toBe(false);
    expect(hasRemoval([{ id: ITEM_A, remove: true }])).toBe(true);
  });
});

describe("planChecklistOps — ADD", () => {
  it("string shorthand → create (incomplete by default)", () => {
    const { creates, updates, removes } = plan(["Buy milk"]);
    expect(updates).toHaveLength(0);
    expect(removes).toHaveLength(0);
    expect(creates).toEqual([
      { taskId: TASK, checklistId: "new-1", title: "Buy milk", completed: false },
    ]);
  });

  it("object with completed → create with that flag; title is trimmed", () => {
    const { creates } = plan([{ title: "  Ship it  ", completed: true }]);
    expect(creates[0]).toMatchObject({ title: "Ship it", completed: true });
  });

  it("empty add title throws", () => {
    expect(() => plan(["   "])).toThrow(/title must not be empty/i);
    expect(() => plan([{ title: "" }])).toThrow(/title must not be empty/i);
  });
});

describe("planChecklistOps — ADJUST", () => {
  it("by id, set completed → update", () => {
    const { updates } = plan([{ id: ITEM_A, completed: true }]);
    expect(updates).toEqual([{ taskId: TASK, id: ITEM_A, completed: true }]);
  });

  it("by match (current title) → resolves to id", () => {
    const { updates } = plan([{ match: "Draft spec", completed: true }]);
    expect(updates).toEqual([{ taskId: TASK, id: ITEM_A, completed: true }]);
  });

  it("rename via match + new title", () => {
    const { updates } = plan([{ match: "Draft spec", title: "Draft specification" }]);
    expect(updates).toEqual([
      { taskId: TASK, id: ITEM_A, title: "Draft specification" },
    ]);
  });

  it("adjust with neither title nor completed throws", () => {
    expect(() => plan([{ id: ITEM_A }])).toThrow(/provide a new 'title' and\/or 'completed'/i);
  });

  it("unknown id throws", () => {
    expect(() => plan([{ id: ITEM_A.replace(/a/g, "9"), completed: true }])).toThrow(
      /no checklist item with id/i,
    );
  });

  it("unmatched title throws", () => {
    expect(() => plan([{ match: "Nope", completed: true }])).toThrow(
      /no checklist item titled 'Nope'/i,
    );
  });

  it("ambiguous title throws and asks for id", () => {
    expect(() => plan([{ match: "Dupe", completed: true }])).toThrow(
      /2 checklist items are titled 'Dupe' — pass 'id'/i,
    );
  });

  it("non-GUID id throws", () => {
    expect(() => plan([{ id: "not-a-guid", completed: true }])).toThrow(/is not a GUID/i);
  });
});

describe("planChecklistOps — REMOVE", () => {
  it("by id → remove", () => {
    const { removes } = plan([{ id: ITEM_B, remove: true }]);
    expect(removes).toEqual([{ taskId: TASK, id: ITEM_B }]);
  });

  it("by match → resolves to id", () => {
    const { removes } = plan([{ match: "Review", remove: true }]);
    expect(removes).toEqual([{ taskId: TASK, id: ITEM_B }]);
  });

  it("remove without id or match throws", () => {
    expect(() => plan([{ remove: true } as ChecklistOpInput])).toThrow(
      /adjust\/remove needs 'id' or 'match'/i,
    );
  });
});

describe("planChecklistOps — resolution + mixing", () => {
  it("throws when an adjust/remove targets a task whose current checklist was not read", () => {
    // existing map has no entry for TASK → existing === undefined for edits.
    expect(() =>
      planChecklistOps(
        [{ taskId: TASK, ops: [{ id: ITEM_A, completed: true }] }],
        new Map(),
        seqIds(),
      ),
    ).toThrow(/current checklist could not be read/i);
  });

  it("adds need no existing read (map can be empty)", () => {
    const { creates } = planChecklistOps(
      [{ taskId: TASK, ops: ["A", "B"] }],
      new Map(),
      seqIds(),
    );
    expect(creates.map((c) => c.title)).toEqual(["A", "B"]);
  });

  it("mixes add + adjust + remove in one task, preserving order/counts", () => {
    const { creates, updates, removes } = plan([
      "New item",
      { match: "Draft spec", completed: true },
      { id: ITEM_B, remove: true },
    ]);
    expect(creates).toHaveLength(1);
    expect(updates).toHaveLength(1);
    expect(removes).toHaveLength(1);
    expect(creates[0].checklistId).toBe("new-1");
  });

  it("handles ops across multiple tasks independently", () => {
    const ex = new Map<string, ExistingChecklistItem[]>([
      [TASK.toLowerCase(), [{ id: ITEM_A, title: "Draft spec", completed: false }]],
      [TASK2.toLowerCase(), [{ id: ITEM_B, title: "Other", completed: false }]],
    ]);
    const out = planChecklistOps(
      [
        { taskId: TASK, ops: [{ match: "Draft spec", completed: true }] },
        { taskId: TASK2, ops: [{ id: ITEM_B, remove: true }, "Fresh"] },
      ],
      ex,
      seqIds(),
    );
    expect(out.updates).toEqual([{ taskId: TASK, id: ITEM_A, completed: true }]);
    expect(out.removes).toEqual([{ taskId: TASK2, id: ITEM_B }]);
    expect(out.creates).toEqual([
      { taskId: TASK2, checklistId: "new-1", title: "Fresh", completed: false },
    ]);
  });
});
