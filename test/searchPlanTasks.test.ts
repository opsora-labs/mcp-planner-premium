/**
 * Tests for search_plan_tasks — server-side text search over task title/notes.
 * - buildSearchFilter: pure (escaping, predicate shape, multi-term OR, limits).
 * - handler: happy path, capability-absent probe, graceful 400 → client-side
 *   note grep fallback, pagination, milestone/overdue narrowing, injection safety.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetEnvCache } from "../src/config.js";
import { requestContext } from "../src/context.js";
import { resetCapabilities } from "../src/tools/capabilities.js";
import { searchPlanTasks, buildSearchFilter } from "../src/tools/searchPlanTasks.js";

const ORG = "https://org12345.crm4.dynamics.com";
const BASE = ORG + "/api/data/v9.2";
const PROJECT = "11111111-2222-3333-4444-555555555555";

function withBearer<T>(fn: () => Promise<T>): Promise<T> {
  return requestContext.run({ bearer: "test-token" }, fn);
}
function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}
const call = (args: any) => withBearer(() => (searchPlanTasks.handler as any)(args));

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

// ---------------------------------------------------------------------------
// buildSearchFilter — pure
// ---------------------------------------------------------------------------
describe("buildSearchFilter", () => {
  it("scopes to the plan and searches both title and notes by default", () => {
    const { filter, terms } = buildSearchFilter(PROJECT, "Hilmar");
    expect(filter).toContain("_msdyn_project_value eq " + PROJECT + " and ");
    expect(filter).toContain("contains(msdyn_subject,'Hilmar')");
    expect(filter).toContain("or contains(msdyn_description,'Hilmar')");
    expect(terms).toEqual(["Hilmar"]);
  });

  it("escapes single quotes by doubling (no literal breakout)", () => {
    const { filter } = buildSearchFilter(PROJECT, "O'Brien");
    expect(filter).toContain("contains(msdyn_subject,'O''Brien')");
  });

  it("fields:'subject' searches the title only", () => {
    const { filter } = buildSearchFilter(PROJECT, "Hilmar", "subject");
    expect(filter).toContain("contains(msdyn_subject,'Hilmar')");
    expect(filter).not.toContain("msdyn_description");
  });

  it("fields:'description' searches the notes only", () => {
    const { filter } = buildSearchFilter(PROJECT, "Hilmar", "description");
    expect(filter).toContain("contains(msdyn_description,'Hilmar')");
    expect(filter).not.toContain("msdyn_subject,'");
  });

  it("an array matches ANY term (OR) in one filter", () => {
    const { filter, terms } = buildSearchFilter(PROJECT, ["Madrid", "2026-06-19"]);
    expect(terms).toEqual(["Madrid", "2026-06-19"]);
    expect(filter).toContain("contains(msdyn_subject,'Madrid')");
    expect(filter).toContain("contains(msdyn_description,'2026-06-19')");
    // Two per-term groups joined by OR.
    expect(filter.match(/ or /g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("trims and drops empty terms", () => {
    const { terms } = buildSearchFilter(PROJECT, ["  Madrid  ", "", "   "]);
    expect(terms).toEqual(["Madrid"]);
  });

  it("throws on an empty query", () => {
    expect(() => buildSearchFilter(PROJECT, "   ")).toThrow(/query is required/);
    expect(() => buildSearchFilter(PROJECT, [])).toThrow(/query is required/);
  });

  it("throws on an over-long term and too many terms", () => {
    expect(() => buildSearchFilter(PROJECT, "x".repeat(513))).toThrow(/too long/);
    expect(() => buildSearchFilter(PROJECT, Array.from({ length: 26 }, (_, i) => "t" + i))).toThrow(
      /too many query terms/,
    );
  });

  it("warns when a term contains an entity-encoded character", () => {
    expect(buildSearchFilter(PROJECT, 'say "hi"').warnings.length).toBeGreaterThan(0);
    expect(buildSearchFilter(PROJECT, "a & b").warnings.length).toBeGreaterThan(0);
    expect(buildSearchFilter(PROJECT, "Hilmar").warnings).toHaveLength(0);
  });

  it("keeps an injection attempt inside the contains() literal", () => {
    const { filter } = buildSearchFilter(PROJECT, "') or (1 eq 1");
    // The lone quote is doubled and the spaces are percent-encoded, so the whole
    // payload stays inside one literal — the leading '' proves the escape.
    expect(filter).toContain("contains(msdyn_subject,'''");
    expect(filter).toContain("%20or%20"); // the injected " or " is encoded, not an operator
  });
});

// ---------------------------------------------------------------------------
// handler — mocked Dataverse
// ---------------------------------------------------------------------------
const row = (over: Record<string, unknown> = {}) => ({
  msdyn_projecttaskid: "task0-0000-0000-0000-000000000000",
  msdyn_subject: "Onboard Hilmar",
  msdyn_description: "Notes about Hilmar",
  msdyn_finish: "2026-07-01T00:00:00Z",
  msdyn_progress: 0,
  _msdyn_parenttask_value: null,
  msdyn_ismilestone: false,
  msdyn_projectbucket: { msdyn_name: "Bucket A" },
  ...over,
});

describe("search_plan_tasks handler", () => {
  it("pushes the contains() filter server-side and returns matches", async () => {
    const urls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
      urls.push(String(input));
      return jsonRes({ value: [row()] });
    });

    const r = await call({ projectId: PROJECT, query: "Hilmar" });
    expect(r.ok).toBe(true);
    expect(r.count).toBe(1);
    expect(r.totalMatched).toBe(1);
    expect(r.searchedNotesServerSide).toBe(true);
    expect(r.terms).toEqual(["Hilmar"]);
    expect(r.tasks[0].bucketName).toBe("Bucket A");
    // The outgoing request carried the OR-of-fields contains predicate.
    expect(urls.some((u) => u.includes("contains(msdyn_subject,'Hilmar')"))).toBe(true);
    expect(urls.some((u) => u.includes("or contains(msdyn_description,'Hilmar')"))).toBe(true);
  });

  it("decodes entity-encoded notes in the returned preview", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      jsonRes({ value: [row({ msdyn_description: "A &amp; B &lt;tag&gt;" })] }),
    );
    const r = await call({ projectId: PROJECT, query: "Hilmar" });
    expect(r.tasks[0].description).toBe("A & B <tag>");
  });

  it("probes once, caches 'absent' when extended fields are missing, retries core", async () => {
    let probed = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
      const url = String(input);
      if (url.includes("msdyn_duration")) {
        probed = true;
        return jsonRes({ error: { message: "Could not find a property named 'msdyn_duration'." } }, 400);
      }
      return jsonRes({ value: [row()] });
    });
    const r = await call({ projectId: PROJECT, query: "Hilmar" });
    expect(probed).toBe(true);
    expect(r.tasks[0]).not.toHaveProperty("durationHours");
    expect(r.warnings.some((w: string) => /Extended scheduling fields/.test(w))).toBe(true);
  });

  it("falls back to a client-side note grep when the server rejects contains() on notes", async () => {
    const subjectHit = row({
      msdyn_projecttaskid: "aaaa0000-0000-0000-0000-000000000001",
      msdyn_subject: "Hilmar kickoff",
      msdyn_description: "nothing here",
    });
    const notesOnlyHit = row({
      msdyn_projecttaskid: "bbbb0000-0000-0000-0000-000000000002",
      msdyn_subject: "Weekly sync",
      msdyn_description: "remember to ping Hilmar",
    });
    const noHit = row({
      msdyn_projecttaskid: "cccc0000-0000-0000-0000-000000000003",
      msdyn_subject: "Unrelated",
      msdyn_description: "nothing relevant",
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
      const url = String(input);
      // Server rejects the description contains() with a generic 400…
      if (url.includes("contains(msdyn_description")) {
        return jsonRes({ error: { message: "Invalid filter clause." } }, 400);
      }
      // …scope-only fallback scan returns the whole plan.
      return jsonRes({ value: [subjectHit, notesOnlyHit, noHit] });
    });

    const r = await call({ projectId: PROJECT, query: "Hilmar" });
    expect(r.searchedNotesServerSide).toBe(false);
    expect(r.warnings.some((w: string) => /matched notes client-side/.test(w))).toBe(true);
    const ids = r.tasks.map((t: any) => t.taskId);
    expect(ids).toContain(subjectHit.msdyn_projecttaskid);
    expect(ids).toContain(notesOnlyHit.msdyn_projecttaskid); // notes-only match kept
    expect(ids).not.toContain(noHit.msdyn_projecttaskid); // non-match dropped
    expect(r.totalMatched).toBe(2);
  });

  it("pages results with an offset cursor and stops when exhausted", async () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      row({ msdyn_projecttaskid: `task${i}-0000-0000-0000-00000000000${i}`, msdyn_subject: "Hilmar " + i }),
    );
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => jsonRes({ value: rows }));

    const p1 = await call({ projectId: PROJECT, query: "Hilmar", limit: 2 });
    expect(p1.count).toBe(2);
    expect(p1.totalMatched).toBe(5);
    expect(p1.hasMore).toBe(true);
    expect(p1.nextPageToken).toBeDefined();

    const p2 = await call({ projectId: PROJECT, query: "Hilmar", limit: 2, pageToken: p1.nextPageToken });
    expect(p2.count).toBe(2);
    const p3 = await call({ projectId: PROJECT, query: "Hilmar", limit: 2, pageToken: p2.nextPageToken });
    expect(p3.count).toBe(1);
    expect(p3.hasMore).toBe(false);
    expect(p3.nextPageToken).toBeUndefined();
  });

  it("filter:'milestones' narrows the matched set", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      jsonRes({
        value: [
          row({ msdyn_projecttaskid: "m0000000-0000-0000-0000-000000000001", msdyn_ismilestone: true }),
          row({ msdyn_projecttaskid: "n0000000-0000-0000-0000-000000000002", msdyn_ismilestone: false }),
        ],
      }),
    );
    const r = await call({ projectId: PROJECT, query: "Hilmar", filter: "milestones" });
    expect(r.totalMatched).toBe(1);
    expect(r.tasks[0].isMilestone).toBe(true);
  });

  it("rejects a non-GUID projectId before any request", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(call({ projectId: "not-a-guid", query: "Hilmar" })).rejects.toThrow(/projectId/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects a malformed pageToken", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => jsonRes({ value: [row()] }));
    await expect(call({ projectId: PROJECT, query: "Hilmar", pageToken: "!!!nope!!!" })).rejects.toThrow(
      /Invalid pageToken/,
    );
  });

  it("does not let an injection term break out of the literal", async () => {
    const urls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
      urls.push(String(input));
      return jsonRes({ value: [] });
    });
    await call({ projectId: PROJECT, query: "') or (1 eq 1", fields: "subject" });
    // The doubled quote keeps the payload inside one contains() literal; the
    // injected operators are percent-encoded, never bare OData.
    expect(urls[0]).toContain("contains(msdyn_subject,'''");
    expect(urls[0]).not.toContain("') or (1 eq 1'"); // no un-encoded breakout
  });
});
