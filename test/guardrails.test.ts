import { describe, it, expect } from "vitest";
import { validateAddEntities } from "../src/tools/addTasks.js";
import { validateUpdateEntities } from "../src/tools/updateTasks.js";
import { validateDeleteRecords } from "../src/tools/deleteTasks.js";
import { parsePssError, dvPssErrorMessage } from "../src/dataverse.js";

const TASK = "Microsoft.Dynamics.CRM.msdyn_projecttask";
const DEP = "Microsoft.Dynamics.CRM.msdyn_projecttaskdependency";

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

function guid(n: number): string {
  const h = n.toString(16).padStart(2, "0");
  return `${h}aaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`;
}

describe("validateAddEntities", () => {
  it("accepts a minimal valid task batch", () => {
    expect(() => validateAddEntities([task()])).not.toThrow();
  });

  it("rejects an empty batch", () => {
    expect(() => validateAddEntities([])).toThrow(/non-empty/);
  });

  it("rejects more than 200 entities", () => {
    const many = Array.from({ length: 201 }, (_, i) =>
      task({ msdyn_projecttaskid: guid(i + 1).replace(/^../, ((i % 99) + 1).toString(16).padStart(2, "0")) }),
    );
    expect(() => validateAddEntities(many)).toThrow(/Max 200/);
  });

  it("rejects a disallowed @odata.type", () => {
    expect(() =>
      validateAddEntities([{ "@odata.type": "Microsoft.Dynamics.CRM.account" }]),
    ).toThrow(/disallowed @odata.type/);
  });

  it("rejects a blocked-on-create field (msdyn_ismilestone)", () => {
    expect(() => validateAddEntities([task({ msdyn_ismilestone: true })])).toThrow(
      /not allowed on PSS create/,
    );
  });

  it("rejects msdyn_outlinelevel with a parent-bind pointer", () => {
    expect(() => validateAddEntities([task({ msdyn_outlinelevel: 1 })])).toThrow(
      /msdyn_parenttask@odata.bind/,
    );
  });

  it("rejects a wrong bind alias and teaches the right key", () => {
    const t = task();
    delete (t as any)["msdyn_projectbucket@odata.bind"];
    (t as any)["msdyn_bucket@odata.bind"] = "/msdyn_projectbuckets(" + guid(8) + ")";
    expect(() => validateAddEntities([t])).toThrow(
      /Use 'msdyn_projectbucket@odata.bind' instead/,
    );
  });

  it("rejects a missing required task field", () => {
    const t = task();
    delete (t as any).msdyn_subject;
    expect(() => validateAddEntities([t])).toThrow(/missing required field/);
  });

  it("rejects a duplicate client GUID", () => {
    const a = task({ msdyn_projecttaskid: guid(5) });
    const b = task({ msdyn_projecttaskid: guid(5) });
    expect(() => validateAddEntities([a, b])).toThrow(/duplicate GUID/);
  });

  it("rejects a child whose parent appears after it", () => {
    const parentId = guid(20);
    const child = task({
      msdyn_projecttaskid: guid(21),
      "msdyn_parenttask@odata.bind": "/msdyn_projecttasks(" + parentId + ")",
    });
    const parent = task({ msdyn_projecttaskid: parentId });
    expect(() => validateAddEntities([child, parent])).toThrow(
      /Parents must appear BEFORE their children/,
    );
  });

  it("accepts a child whose parent appears before it", () => {
    const parentId = guid(20);
    const parent = task({ msdyn_projecttaskid: parentId });
    const child = task({
      msdyn_projecttaskid: guid(21),
      "msdyn_parenttask@odata.bind": "/msdyn_projecttasks(" + parentId + ")",
    });
    expect(() => validateAddEntities([parent, child])).not.toThrow();
  });

  it("rejects a dependency missing predecessor/successor", () => {
    expect(() => validateAddEntities([{ "@odata.type": DEP }])).toThrow(
      /PredecessorTask@odata.bind and msdyn_SuccessorTask@odata.bind are required/,
    );
  });

  it("teaches the PascalCase nav-property for lowercase dependency task binds", () => {
    expect(() =>
      validateAddEntities([
        {
          "@odata.type": DEP,
          "msdyn_predecessortask@odata.bind": "/msdyn_projecttasks(" + guid(1) + ")",
          "msdyn_successortask@odata.bind": "/msdyn_projecttasks(" + guid(2) + ")",
        },
      ]),
    ).toThrow(/is not a valid navigation property. Use 'msdyn_PredecessorTask@odata.bind'/);
  });

  it("teaches msdyn_Project (capital P) for lowercase project bind on dependency", () => {
    // msdyn_project@odata.bind (lowercase) is correct on msdyn_projecttask but
    // is undeclared on msdyn_projecttaskdependency — it must be msdyn_Project.
    expect(() =>
      validateAddEntities([
        {
          "@odata.type": DEP,
          "msdyn_project@odata.bind": "/msdyn_projects(" + guid(3) + ")",
          "msdyn_PredecessorTask@odata.bind": "/msdyn_projecttasks(" + guid(1) + ")",
          "msdyn_SuccessorTask@odata.bind": "/msdyn_projecttasks(" + guid(2) + ")",
        },
      ]),
    ).toThrow(/msdyn_Project@odata.bind.*capital P/);
  });

  it("rejects an invalid dependency link type", () => {
    expect(() =>
      validateAddEntities([
        {
          "@odata.type": DEP,
          "msdyn_PredecessorTask@odata.bind": "/msdyn_projecttasks(" + guid(1) + ")",
          "msdyn_SuccessorTask@odata.bind": "/msdyn_projecttasks(" + guid(2) + ")",
          msdyn_projecttaskdependencylinktype: 999,
        },
      ]),
    ).toThrow(/is invalid. Allowed option values/);
  });

  it("accepts EU/CRM4 small-integer link type values (0-3)", () => {
    // EU tenants expose link types as 0=FF, 1=FS, 2=SF, 3=SS in metadata.
    // The guardrail must not reject them when a raw caller sends them.
    for (const v of [0, 1, 2, 3]) {
      expect(() =>
        validateAddEntities([
          {
            "@odata.type": DEP,
            "msdyn_PredecessorTask@odata.bind": "/msdyn_projecttasks(" + guid(1) + ")",
            "msdyn_SuccessorTask@odata.bind": "/msdyn_projecttasks(" + guid(2) + ")",
            msdyn_projecttaskdependencylinktype: v,
          },
        ]),
      ).not.toThrow();
    }
  });
});

describe("validateUpdateEntities", () => {
  it("rejects a dependency update", () => {
    expect(() =>
      validateUpdateEntities([{ "@odata.type": DEP, msdyn_projecttaskdependencyid: guid(1) }]),
    ).toThrow(/dependencies cannot be updated/);
  });

  it("rejects a rolled-up field write on a summary task (via summaryTaskIds)", () => {
    const id = guid(7);
    expect(() =>
      validateUpdateEntities(
        [{ "@odata.type": TASK, msdyn_projecttaskid: id, msdyn_finish: "2026-07-01" }],
        [id],
      ),
    ).toThrow(/roll up from its children/);
  });

  it("accepts a non-rolled-up field write on a summary task", () => {
    const id = guid(7);
    expect(() =>
      validateUpdateEntities(
        [{ "@odata.type": TASK, msdyn_projecttaskid: id, msdyn_subject: "Renamed" }],
        [id],
      ),
    ).not.toThrow();
  });

  it("treats an in-batch parent bind as a summary task", () => {
    const parentId = guid(7);
    expect(() =>
      validateUpdateEntities([
        {
          "@odata.type": TASK,
          msdyn_projecttaskid: guid(8),
          "msdyn_parenttask@odata.bind": "/msdyn_projecttasks(" + parentId + ")",
        },
        { "@odata.type": TASK, msdyn_projecttaskid: parentId, msdyn_effort: 40 },
      ]),
    ).toThrow(/roll up from its children/);
  });

  it("requires a primary key on a task update", () => {
    expect(() =>
      validateUpdateEntities([{ "@odata.type": TASK, msdyn_subject: "x" }]),
    ).toThrow(/msdyn_projecttaskid required/);
  });

  it("accepts JSON-string summaryTaskIds", () => {
    const id = guid(7);
    expect(() =>
      validateUpdateEntities(
        [{ "@odata.type": TASK, msdyn_projecttaskid: id, msdyn_progress: 50 }],
        JSON.stringify([id]),
      ),
    ).toThrow(/roll up from its children/);
  });
});

describe("parsePssError / dvPssErrorMessage", () => {
  it("returns undefined for a plain OData error without PSS structure", () => {
    expect(parsePssError({ error: { message: "Something went wrong" } })).toBeUndefined();
  });

  it("parses a raw top-level PSS error body (shape b)", () => {
    const body = {
      errorId: -1945829329,
      errorKey: "E_BATCHFAILED",
      ErrorMessage: "One of the batch requests failed",
      failedBatchRequestIndex: 3,
      failedBatchRequestError: {
        errorId: -1945829343,
        errorKey: "E_LIMITEXCEEDED_TASKLEVEL",
        ErrorMessage: "Limit on level of task exceeded",
      },
    };
    const result = parsePssError(body);
    expect(result).toBeDefined();
    expect(result!.outerKey).toBe("E_BATCHFAILED");
    expect(result!.innerKey).toBe("E_LIMITEXCEEDED_TASKLEVEL");
    expect(result!.failedBatchRequestIndex).toBe(3);
    expect(result!.message).toContain("E_LIMITEXCEEDED_TASKLEVEL");
  });

  it("parses a PSS error embedded as JSON inside an OData error message (shape a)", () => {
    const pssPayload = {
      errorKey: "E_BATCHFAILED",
      ErrorMessage: "One of the batch requests failed",
      failedBatchRequestIndex: 2,
      failedBatchRequestError: {
        errorKey: "E_LIMITEXCEEDED_TASKLEVEL",
        ErrorMessage: "Limit on level of task exceeded",
      },
    };
    const body = { error: { message: JSON.stringify(pssPayload) } };
    const result = parsePssError(body);
    expect(result).toBeDefined();
    expect(result!.innerKey).toBe("E_LIMITEXCEEDED_TASKLEVEL");
    expect(result!.failedBatchRequestIndex).toBe(2);
  });

  it("dvPssErrorMessage falls back to dvErrorMessage for plain OData errors", () => {
    const response = { status: 400, json: { error: { message: "Bad field" } } };
    expect(dvPssErrorMessage(response)).toBe("Bad field");
  });

  it("dvPssErrorMessage extracts the PSS error message for PSS-shaped responses", () => {
    const response = {
      status: 400,
      json: {
        errorKey: "E_BATCHFAILED",
        ErrorMessage: "One of the batch requests failed",
        failedBatchRequestError: {
          errorKey: "E_LIMITEXCEEDED_TASKLEVEL",
          ErrorMessage: "Limit on level of task exceeded",
        },
      },
    };
    const msg = dvPssErrorMessage(response);
    expect(msg).toContain("E_LIMITEXCEEDED_TASKLEVEL");
    expect(msg).not.toBe("HTTP 400");
  });
});

describe("validateUpdateEntities — null date guard", () => {
  it("rejects null msdyn_start", () => {
    expect(() =>
      validateUpdateEntities([
        { "@odata.type": TASK, msdyn_projecttaskid: guid(1), msdyn_start: null },
      ]),
    ).toThrow(/msdyn_start must not be null/);
  });

  it("rejects null msdyn_finish", () => {
    expect(() =>
      validateUpdateEntities([
        { "@odata.type": TASK, msdyn_projecttaskid: guid(1), msdyn_finish: null },
      ]),
    ).toThrow(/msdyn_finish must not be null/);
  });

  it("accepts valid ISO date strings", () => {
    expect(() =>
      validateUpdateEntities([
        { "@odata.type": TASK, msdyn_projecttaskid: guid(1), msdyn_start: "2026-07-01T00:00:00Z", msdyn_finish: "2026-07-05T00:00:00Z" },
      ]),
    ).not.toThrow();
  });
});

describe("validateDeleteRecords", () => {
  it("accepts a deletable record", () => {
    expect(() =>
      validateDeleteRecords([{ entityLogicalName: "msdyn_projecttask", recordId: guid(1) }]),
    ).not.toThrow();
  });

  it("hard-blocks whole-plan deletes", () => {
    expect(() =>
      validateDeleteRecords([{ entityLogicalName: "msdyn_project", recordId: guid(1) }]),
    ).toThrow(/deleting whole plans via API is blocked by policy/);
  });

  it("rejects a non-deletable entity", () => {
    expect(() =>
      validateDeleteRecords([{ entityLogicalName: "account", recordId: guid(1) }]),
    ).toThrow(/invalid entityLogicalName/);
  });

  it("rejects a record missing recordId", () => {
    expect(() =>
      validateDeleteRecords([{ entityLogicalName: "msdyn_projecttask" } as any]),
    ).toThrow(/invalid entityLogicalName or missing recordId/);
  });

  it("rejects more than 200 deletes", () => {
    const many = Array.from({ length: 201 }, () => ({
      entityLogicalName: "msdyn_projecttask",
      recordId: guid(1),
    }));
    expect(() => validateDeleteRecords(many)).toThrow(/Max 200 deletes/);
  });
});
