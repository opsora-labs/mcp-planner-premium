import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetEnvCache } from "../src/config.js";
import { requestContext } from "../src/context.js";
import { listMyTasks } from "../src/tools/listMyTasks.js";
import { whoami } from "../src/tools/whoami.js";

const ORG = "https://org12345.crm4.dynamics.com";
const USER = "00000000-0000-0000-0000-0000000000aa";
const RES = "00000000-0000-0000-0000-0000000000bb";

function withBearer<T>(fn: () => Promise<T>): Promise<T> {
  return requestContext.run({ bearer: "test-token" }, fn);
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

// Mock the whole identity chain by URL.
function mockChain() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
    const url = String(input);
    if (url.includes("/WhoAmI")) return jsonRes({ UserId: USER, BusinessUnitId: "bu", OrganizationId: "org" });
    if (url.includes("/bookableresources")) return jsonRes({ value: [{ bookableresourceid: RES, name: "Tobias Schüle" }] });
    if (url.includes("/msdyn_projectteams")) return jsonRes({ value: [{ msdyn_projectteamid: "team1", _msdyn_project_value: "proj1" }] });
    if (url.includes("/msdyn_resourceassignments"))
      return jsonRes({ value: [{ _msdyn_taskid_value: "taskOverdue" }, { _msdyn_taskid_value: "taskFuture" }] });
    if (url.includes("/msdyn_projecttasks")) {
      // The summary-detection query FILTERS on _msdyn_parenttask_value → no parents
      // here. (The task fetch only mentions that column in its $select, not filter.)
      if (url.includes("_msdyn_parenttask_value eq")) return jsonRes({ value: [] });
      // The task fetch → one overdue (past, 0%) and one future (future, 0%).
      return jsonRes({
        value: [
          {
            msdyn_projecttaskid: "taskOverdue",
            msdyn_subject: "Past task",
            msdyn_finish: "2020-01-01T00:00:00Z",
            msdyn_progress: 0,
            _msdyn_project_value: "proj1",
            msdyn_project: { msdyn_subject: "Plan A" },
          },
          {
            msdyn_projecttaskid: "taskFuture",
            msdyn_subject: "Future task",
            msdyn_finish: "2099-01-01T00:00:00Z",
            msdyn_progress: 0,
            _msdyn_project_value: "proj1",
            msdyn_project: { msdyn_subject: "Plan A" },
          },
        ],
      });
    }
    return jsonRes({ value: [] });
  });
}

describe("whoami enrichment", () => {
  beforeEach(() => {
    process.env.DATAVERSE_ORG_URL = ORG;
    process.env.LOG_LEVEL = "silent";
    process.env.AUTH_MODE = "insecure-passthrough";
    process.env.DATAVERSE_LINK_TYPE_STYLE = "eu";
    delete process.env.TENANT_ID;
    resetEnvCache();
  });
  afterEach(() => { vi.restoreAllMocks(); resetEnvCache(); });

  it("resolves the caller's bookable resource id + name", async () => {
    mockChain();
    const res = await withBearer(() => (whoami.handler as any)({}));
    expect(res.userId).toBe(USER);
    expect(res.bookableResourceId).toBe(RES);
    expect(res.resourceName).toBe("Tobias Schüle");
  });

  it("degrades to null resource fields when the user is not a Project resource", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
      const url = String(input);
      if (url.includes("/WhoAmI")) return jsonRes({ UserId: USER });
      if (url.includes("/bookableresources")) return jsonRes({ value: [] });
      return jsonRes({ value: [] });
    });
    const res = await withBearer(() => (whoami.handler as any)({}));
    expect(res.bookableResourceId).toBeNull();
    expect(res.resourceName).toBeNull();
  });
});

describe("list_my_tasks", () => {
  beforeEach(() => {
    process.env.DATAVERSE_ORG_URL = ORG;
    process.env.LOG_LEVEL = "silent";
    process.env.AUTH_MODE = "insecure-passthrough";
    process.env.DATAVERSE_LINK_TYPE_STYLE = "eu";
    delete process.env.TENANT_ID;
    resetEnvCache();
  });
  afterEach(() => { vi.restoreAllMocks(); resetEnvCache(); });

  it("returns only overdue tasks for filter=overdue", async () => {
    mockChain();
    const res = await withBearer(() => (listMyTasks.handler as any)({ filter: "overdue" }));
    expect(res.count).toBe(1);
    expect(res.tasks[0].subject).toBe("Past task");
    expect(res.tasks[0].overdue).toBe(true);
    expect(res.tasks[0].planName).toBe("Plan A");
  });

  it("returns both incomplete tasks for filter=active", async () => {
    mockChain();
    const res = await withBearer(() => (listMyTasks.handler as any)({ filter: "active" }));
    expect(res.count).toBe(2);
  });

  it("returns all assigned tasks for filter=all", async () => {
    mockChain();
    const res = await withBearer(() => (listMyTasks.handler as any)({ filter: "all" }));
    expect(res.count).toBe(2);
  });

  it("returns count 0 with a note when the user is not a Project resource", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
      const url = String(input);
      if (url.includes("/WhoAmI")) return jsonRes({ UserId: USER });
      if (url.includes("/bookableresources")) return jsonRes({ value: [] });
      return jsonRes({ value: [] });
    });
    const res = await withBearer(() => (listMyTasks.handler as any)({ filter: "overdue" }));
    expect(res.count).toBe(0);
    expect(res.note).toMatch(/not a Project bookable resource/i);
  });

  it("pages my tasks with a short cursor when more than limit remain", async () => {
    mockChain();
    const p1 = await withBearer(() => (listMyTasks.handler as any)({ filter: "all", limit: 1 }));
    expect(p1.count).toBe(1);
    expect(p1.totalCount).toBe(2);
    expect(p1.hasMore).toBe(true);
    expect(p1.nextPageToken).toBeDefined();
    expect(Buffer.from(p1.nextPageToken, "base64url").toString("utf8")).toBe("1");

    const p2 = await withBearer(() =>
      (listMyTasks.handler as any)({ filter: "all", limit: 1, pageToken: p1.nextPageToken }),
    );
    expect(p2.count).toBe(1);
    expect(p2.totalCount).toBe(2);
    expect(p2.hasMore).toBe(false);
    expect(p2.nextPageToken).toBeUndefined();
  });

  it("bucketId scopes my tasks to one bucket in a single call", async () => {
    const BUCKET = "00000000-0000-0000-0000-0000000000c1";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
      const url = String(input);
      if (url.includes("/WhoAmI")) return jsonRes({ UserId: USER });
      if (url.includes("/bookableresources")) return jsonRes({ value: [{ bookableresourceid: RES }] });
      if (url.includes("/msdyn_projectteams"))
        return jsonRes({ value: [{ msdyn_projectteamid: "team1", _msdyn_project_value: "proj1" }] });
      if (url.includes("/msdyn_resourceassignments"))
        return jsonRes({ value: [{ _msdyn_taskid_value: "tA" }, { _msdyn_taskid_value: "tB" }] });
      if (url.includes("/msdyn_projecttasks")) {
        if (url.includes("_msdyn_parenttask_value eq")) return jsonRes({ value: [] });
        return jsonRes({
          value: [
            { msdyn_projecttaskid: "tA", msdyn_subject: "A", msdyn_finish: "2099-01-01T00:00:00Z", msdyn_progress: 0, _msdyn_project_value: "proj1", _msdyn_projectbucket_value: BUCKET, msdyn_projectbucket: { msdyn_name: "Client Management" } },
            { msdyn_projecttaskid: "tB", msdyn_subject: "B", msdyn_finish: "2099-01-01T00:00:00Z", msdyn_progress: 0, _msdyn_project_value: "proj1", _msdyn_projectbucket_value: "00000000-0000-0000-0000-0000000000c2", msdyn_projectbucket: { msdyn_name: "Other" } },
          ],
        });
      }
      return jsonRes({ value: [] });
    });
    const res = await withBearer(() => (listMyTasks.handler as any)({ filter: "all", bucketId: BUCKET }));
    expect(res.bucketId).toBe(BUCKET);
    expect(res.count).toBe(1);
    expect(res.tasks[0].subject).toBe("A");
    expect(res.tasks[0].bucketId).toBe(BUCKET);
  });
});
