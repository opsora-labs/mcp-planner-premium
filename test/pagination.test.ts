/**
 * Tests for cursor/offset pagination on the big read tools.
 * - clampLimit / encodePageToken / decodePageToken: pure.
 * - pageOnce: SSRF-safe skiptoken cursor (mocked fetch).
 * - get_plan_tasks_and_buckets: single page vs paginated (two-pass summary scan).
 * - list_plan_tasks: offset cursor caps the returned rows.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetEnvCache } from "../src/config.js";
import { requestContext } from "../src/context.js";
import {
  clampLimit,
  encodePageToken,
  decodePageToken,
  pageOnce,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
} from "../src/tools/readHelpers.js";
import { getPlanContents } from "../src/tools/getPlanContents.js";
import { listPlanTasks } from "../src/tools/listPlanTasks.js";
import { resetCapabilities } from "../src/tools/capabilities.js";

const ORG = "https://org12345.crm4.dynamics.com";
const BASE = ORG + "/api/data/v9.2";
const PROJECT = "11111111-2222-3333-4444-555555555555";

function withBearer<T>(fn: () => Promise<T>): Promise<T> {
  return requestContext.run({ bearer: "test-token" }, fn);
}
function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}
const b64url = (s: string) => Buffer.from(s, "utf8").toString("base64url");

beforeEach(() => {
  process.env.DATAVERSE_ORG_URL = ORG;
  process.env.LOG_LEVEL = "silent";
  process.env.AUTH_MODE = "insecure-passthrough";
  process.env.DATAVERSE_LINK_TYPE_STYLE = "global";
  delete process.env.TENANT_ID;
  resetEnvCache();
  resetCapabilities();
});
afterEach(() => {
  vi.restoreAllMocks();
  resetEnvCache();
  resetCapabilities();
});

describe("clampLimit", () => {
  it("defaults when undefined/non-finite", () => {
    expect(clampLimit(undefined)).toBe(DEFAULT_PAGE_SIZE);
    expect(clampLimit("abc")).toBe(DEFAULT_PAGE_SIZE);
    expect(clampLimit(null)).toBe(DEFAULT_PAGE_SIZE);
  });
  it("clamps into [1, MAX_PAGE_SIZE]", () => {
    expect(clampLimit(50)).toBe(50);
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit(-5)).toBe(1);
    expect(clampLimit(999999)).toBe(MAX_PAGE_SIZE);
    expect(clampLimit(200.9)).toBe(200);
  });
});

describe("page token encode/decode", () => {
  const cookie = '<cookie pagenumber="2" pagingcookie="abc" />';
  it("round-trips a $skiptoken from a nextLink", () => {
    const link = BASE + "/msdyn_projecttasks?$select=x&$skiptoken=" + encodeURIComponent(cookie);
    const tok = encodePageToken(link);
    expect(tok).toBeDefined();
    expect(decodePageToken(tok!)).toBe(cookie);
  });
  it("returns undefined when there is no nextLink / no skiptoken", () => {
    expect(encodePageToken(undefined)).toBeUndefined();
    expect(encodePageToken(null)).toBeUndefined();
    expect(encodePageToken(BASE + "/msdyn_projecttasks?$select=x")).toBeUndefined();
  });
  it("rejects empty, url-like, and oversized tokens (injection defense)", () => {
    expect(() => decodePageToken("")).toThrow(/Invalid pageToken/);
    expect(() => decodePageToken(b64url("https://evil.example/steal"))).toThrow(/Invalid pageToken/);
    expect(() => decodePageToken(b64url("x".repeat(5000)))).toThrow(/Invalid pageToken/);
  });
});

describe("pageOnce — SSRF-safe skiptoken cursor", () => {
  it("returns a page + nextPageToken, then re-attaches the cursor on the SAME host/path", async () => {
    const firstUrl =
      BASE + "/msdyn_projecttasks?$select=msdyn_projecttaskid&$filter=_msdyn_project_value eq " + PROJECT;
    const cookie = '<cookie pagenumber="2" />';
    const urls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("$skiptoken=")) return jsonRes({ value: [{ msdyn_projecttaskid: "b" }] });
      return jsonRes({
        value: [{ msdyn_projecttaskid: "a" }],
        "@odata.nextLink": firstUrl + "&$skiptoken=" + encodeURIComponent(cookie),
      });
    });

    const r1 = await withBearer(() => pageOnce(firstUrl, 200));
    expect(r1.rows).toHaveLength(1);
    expect(r1.nextPageToken).toBeDefined();

    const r2 = await withBearer(() => pageOnce(firstUrl, 200, r1.nextPageToken));
    expect(r2.rows).toHaveLength(1);
    expect(r2.nextPageToken).toBeUndefined();

    // The second request must keep the env-fixed origin + path and carry the cursor.
    const second = urls[1];
    expect(second).toContain("$skiptoken=");
    expect(new URL(second).origin).toBe(new URL(ORG).origin);
    expect(new URL(second).pathname).toBe("/api/data/v9.2/msdyn_projecttasks");
  });
});

describe("get_plan_tasks_and_buckets pagination", () => {
  const A = "aaaaaaaa-0000-0000-0000-000000000001"; // parent (summary)
  const B = "bbbbbbbb-0000-0000-0000-000000000002"; // child of A
  const taskRow = (id: string, parent: string | null) => ({
    msdyn_projecttaskid: id,
    msdyn_subject: "T-" + id.slice(0, 4),
    _msdyn_parenttask_value: parent,
    msdyn_ismilestone: false,
  });

  it("single page (fits in one): no token, summary computed from the page", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
      const url = String(input);
      if (url.includes("/msdyn_projectbuckets"))
        return jsonRes({ value: [{ msdyn_projectbucketid: "bk", msdyn_name: "B1" }] });
      return jsonRes({ value: [taskRow(A, null), taskRow(B, A)] }); // no nextLink
    });

    const r = await withBearer(() => (getPlanContents.handler as any)({ projectId: PROJECT }));
    expect(r.ok).toBe(true);
    expect(r.nextPageToken).toBeUndefined();
    expect(r.taskCount).toBe(2);
    expect(r.summaryTaskIds.map((s: string) => s.toLowerCase())).toContain(A);
    expect(r.tasks.find((t: any) => t.taskId === A).isSummary).toBe(true);
    expect(r.tasks.find((t: any) => t.taskId === B).isSummary).toBe(false);
  });

  it("paginated: page of full rows + a separate id+parent scan builds the complete summary set", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
      const url = String(input);
      if (url.includes("/msdyn_projectbuckets"))
        return jsonRes({ value: [{ msdyn_projectbucketid: "bk", msdyn_name: "B1" }] });
      // The lightweight summary scan selects only id+parent (no subject).
      if (!url.includes("msdyn_subject"))
        return jsonRes({ value: [taskRow(A, null), taskRow(B, A)] });
      // The full-row page returns A only, with a continuation cursor.
      return jsonRes({
        value: [taskRow(A, null)],
        "@odata.nextLink": BASE + "/msdyn_projecttasks?$skiptoken=" + encodeURIComponent("<c p=2/>"),
      });
    });

    const r = await withBearer(() => (getPlanContents.handler as any)({ projectId: PROJECT, limit: 1 }));
    expect(r.ok).toBe(true);
    expect(r.nextPageToken).toBeDefined();
    expect(r.taskCount).toBe(1);
    // Summary set is complete from the scan even though the page had only A.
    expect(r.summaryTaskIds.map((s: string) => s.toLowerCase())).toContain(A);
    expect(r.pageLimit).toBe(1);
  });
});

describe("list_plan_tasks offset cursor", () => {
  const tasks = Array.from({ length: 5 }, (_, i) => ({
    msdyn_projecttaskid: `task${i}-0000-0000-0000-00000000000${i}`,
    msdyn_subject: "Task " + i,
    msdyn_finish: "2026-07-01T00:00:00Z",
    msdyn_progress: 0,
    _msdyn_parenttask_value: null,
    msdyn_ismilestone: false,
  }));

  function mockAll() {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => jsonRes({ value: tasks }));
  }

  it("caps to limit, exposes totalMatched + a nextPageToken, and pages through", async () => {
    mockAll();
    const p1 = await withBearer(() =>
      (listPlanTasks.handler as any)({ projectId: PROJECT, filter: "all", limit: 2 }),
    );
    expect(p1.count).toBe(2);
    expect(p1.totalMatched).toBe(5);
    expect(p1.nextPageToken).toBeDefined();

    const p2 = await withBearer(() =>
      (listPlanTasks.handler as any)({ projectId: PROJECT, filter: "all", limit: 2, pageToken: p1.nextPageToken }),
    );
    expect(p2.count).toBe(2);
    expect(p2.tasks[0].taskId).toBe(tasks[2].msdyn_projecttaskid);
    expect(p2.nextPageToken).toBeDefined();

    const p3 = await withBearer(() =>
      (listPlanTasks.handler as any)({ projectId: PROJECT, filter: "all", limit: 2, pageToken: p2.nextPageToken }),
    );
    expect(p3.count).toBe(1);
    expect(p3.nextPageToken).toBeUndefined();
  });

  it("rejects a malformed pageToken", async () => {
    mockAll();
    await expect(
      withBearer(() => (listPlanTasks.handler as any)({ projectId: PROJECT, pageToken: "!!!not-base64!!!" })),
    ).rejects.toThrow(/Invalid pageToken/);
  });
});
