import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetEnvCache } from "../src/config.js";
import { requestContext } from "../src/context.js";
import { listUserTasks } from "../src/tools/listUserTasks.js";

const ORG = "https://org12345.crm4.dynamics.com";
const RES = "00000000-0000-0000-0000-0000000000bb";
const BUCKET = "00000000-0000-0000-0000-0000000000c1";
const OTHER_BUCKET = "00000000-0000-0000-0000-0000000000c2";

function withBearer<T>(fn: () => Promise<T>): Promise<T> {
  return requestContext.run({ bearer: "test-token" }, fn);
}
function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

// Chain for a GIVEN bookable resource id (no WhoAmI / no bookableresource lookup).
function mockChain() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
    const url = String(input);
    if (url.includes("/msdyn_projectteams"))
      return jsonRes({ value: [{ msdyn_projectteamid: "team1", _msdyn_project_value: "proj1" }] });
    if (url.includes("/msdyn_resourceassignments"))
      return jsonRes({ value: [{ _msdyn_taskid_value: "taskOverdue" }, { _msdyn_taskid_value: "taskFuture" }] });
    if (url.includes("/msdyn_projecttasks")) {
      if (url.includes("_msdyn_parenttask_value eq")) return jsonRes({ value: [] });
      return jsonRes({
        value: [
          { msdyn_projecttaskid: "taskOverdue", msdyn_subject: "Past task", msdyn_finish: "2020-01-01T00:00:00Z", msdyn_progress: 0, _msdyn_project_value: "proj1", msdyn_project: { msdyn_subject: "Plan A" } },
          { msdyn_projecttaskid: "taskFuture", msdyn_subject: "Future task", msdyn_finish: "2099-01-01T00:00:00Z", msdyn_progress: 0, _msdyn_project_value: "proj1", msdyn_project: { msdyn_subject: "Plan A" } },
        ],
      });
    }
    return jsonRes({ value: [] });
  });
}

// Two assigned tasks in different buckets, both future/incomplete.
function mockChainWithBuckets() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
    const url = String(input);
    if (url.includes("/msdyn_projectteams"))
      return jsonRes({ value: [{ msdyn_projectteamid: "team1", _msdyn_project_value: "proj1" }] });
    if (url.includes("/msdyn_resourceassignments"))
      return jsonRes({ value: [{ _msdyn_taskid_value: "taskInBucket" }, { _msdyn_taskid_value: "taskOther" }] });
    if (url.includes("/msdyn_projecttasks")) {
      if (url.includes("_msdyn_parenttask_value eq")) return jsonRes({ value: [] });
      return jsonRes({
        value: [
          { msdyn_projecttaskid: "taskInBucket", msdyn_subject: "In bucket", msdyn_finish: "2099-01-01T00:00:00Z", msdyn_progress: 0, _msdyn_project_value: "proj1", msdyn_project: { msdyn_subject: "Plan A" }, _msdyn_projectbucket_value: BUCKET, msdyn_projectbucket: { msdyn_name: "Client Management" } },
          { msdyn_projecttaskid: "taskOther", msdyn_subject: "Other bucket", msdyn_finish: "2099-01-01T00:00:00Z", msdyn_progress: 0, _msdyn_project_value: "proj1", msdyn_project: { msdyn_subject: "Plan A" }, _msdyn_projectbucket_value: OTHER_BUCKET, msdyn_projectbucket: { msdyn_name: "Other" } },
        ],
      });
    }
    return jsonRes({ value: [] });
  });
}

// N assigned tasks, all future/incomplete, distinct finish dates for stable order.
function mockChainN(n: number) {
  const ids = Array.from({ length: n }, (_, i) => "task" + i);
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
    const url = String(input);
    if (url.includes("/msdyn_projectteams"))
      return jsonRes({ value: [{ msdyn_projectteamid: "team1", _msdyn_project_value: "proj1" }] });
    if (url.includes("/msdyn_resourceassignments"))
      return jsonRes({ value: ids.map((id) => ({ _msdyn_taskid_value: id })) });
    if (url.includes("/msdyn_projecttasks")) {
      if (url.includes("_msdyn_parenttask_value eq")) return jsonRes({ value: [] });
      return jsonRes({
        value: ids.map((id, i) => ({
          msdyn_projecttaskid: id,
          msdyn_subject: "T" + i,
          msdyn_finish: "2099-" + String((i % 12) + 1).padStart(2, "0") + "-01T00:00:00Z",
          msdyn_progress: 0,
          _msdyn_project_value: "proj1",
          msdyn_project: { msdyn_subject: "Plan A" },
        })),
      });
    }
    return jsonRes({ value: [] });
  });
}

describe("list_user_tasks", () => {
  beforeEach(() => {
    process.env.DATAVERSE_ORG_URL = ORG;
    process.env.LOG_LEVEL = "silent";
    process.env.AUTH_MODE = "insecure-passthrough";
    process.env.DATAVERSE_LINK_TYPE_STYLE = "eu";
    delete process.env.TENANT_ID;
    resetEnvCache();
  });
  afterEach(() => { vi.restoreAllMocks(); resetEnvCache(); });

  it("defaults to 'active' → returns all incomplete tasks for the resource", async () => {
    mockChain();
    const res: any = await withBearer(() => (listUserTasks.handler as any)({ bookableResourceId: RES }));
    expect(res.ok).toBe(true);
    expect(res.bookableResourceId).toBe(RES);
    expect(res.filter).toBe("active");
    expect(res.count).toBe(2);
  });

  it("filter=overdue → only the past-due task", async () => {
    mockChain();
    const res: any = await withBearer(() => (listUserTasks.handler as any)({ bookableResourceId: RES, filter: "overdue" }));
    expect(res.count).toBe(1);
    expect(res.tasks[0].subject).toBe("Past task");
    expect(res.tasks[0].overdue).toBe(true);
    expect(res.tasks[0].planName).toBe("Plan A");
  });

  it("rejects a non-GUID bookableResourceId", async () => {
    await expect(
      withBearer(() => (listUserTasks.handler as any)({ bookableResourceId: "not-a-guid" })),
    ).rejects.toThrow(/bookableResourceId must be a GUID/);
  });

  it("rejects a non-GUID projectId", async () => {
    await expect(
      withBearer(() => (listUserTasks.handler as any)({ bookableResourceId: RES, projectId: "nope" })),
    ).rejects.toThrow(/projectId must be a GUID/);
  });

  it("count 0 with a note when the resource is on no project team", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
      const url = String(input);
      if (url.includes("/msdyn_projectteams")) return jsonRes({ value: [] });
      return jsonRes({ value: [] });
    });
    const res: any = await withBearer(() => (listUserTasks.handler as any)({ bookableResourceId: RES }));
    expect(res.count).toBe(0);
    expect(res.note).toMatch(/not on any project team/i);
  });

  it("bucketId scopes to one bucket in a single call and echoes it back", async () => {
    mockChainWithBuckets();
    const res: any = await withBearer(() =>
      (listUserTasks.handler as any)({ bookableResourceId: RES, filter: "all", bucketId: BUCKET }),
    );
    expect(res.bucketId).toBe(BUCKET);
    expect(res.count).toBe(1);
    expect(res.tasks[0].subject).toBe("In bucket");
    expect(res.tasks[0].bucketId).toBe(BUCKET);
    expect(res.tasks[0].bucketName).toBe("Client Management");
  });

  it("rejects a non-GUID bucketId", async () => {
    await expect(
      withBearer(() => (listUserTasks.handler as any)({ bookableResourceId: RES, bucketId: "nope" })),
    ).rejects.toThrow(/bucketId must be a GUID/);
  });

  it("count 0 with a note when the person has no tasks in that bucket", async () => {
    mockChainWithBuckets();
    const EMPTY_BUCKET = "00000000-0000-0000-0000-0000000000c9";
    const res: any = await withBearer(() =>
      (listUserTasks.handler as any)({ bookableResourceId: RES, filter: "all", bucketId: EMPTY_BUCKET }),
    );
    expect(res.count).toBe(0);
    expect(res.note).toMatch(/no assigned tasks in that bucket/i);
  });

  it("returns everything on one page with hasMore false when under the cap", async () => {
    mockChainN(3);
    const res: any = await withBearer(() =>
      (listUserTasks.handler as any)({ bookableResourceId: RES, filter: "all" }),
    );
    expect(res.count).toBe(3);
    expect(res.totalCount).toBe(3);
    expect(res.hasMore).toBe(false);
    expect(res.nextPageToken).toBeUndefined();
  });

  it("pages a heavy assignee with a short cursor instead of one oversized response", async () => {
    mockChainN(3);
    const p1: any = await withBearer(() =>
      (listUserTasks.handler as any)({ bookableResourceId: RES, filter: "all", limit: 2 }),
    );
    expect(p1.count).toBe(2);
    expect(p1.totalCount).toBe(3);
    expect(p1.pageLimit).toBe(2);
    expect(p1.hasMore).toBe(true);
    expect(p1.nextPageToken).toBeDefined();
    expect(p1.note).toMatch(/incomplete/i);
    // Cursor is a short numeric offset ("2"), not a long opaque blob.
    expect(Buffer.from(p1.nextPageToken, "base64url").toString("utf8")).toBe("2");

    const p2: any = await withBearer(() =>
      (listUserTasks.handler as any)({ bookableResourceId: RES, filter: "all", limit: 2, pageToken: p1.nextPageToken }),
    );
    expect(p2.count).toBe(1);
    expect(p2.totalCount).toBe(3);
    expect(p2.hasMore).toBe(false);
    expect(p2.nextPageToken).toBeUndefined();
  });
});
