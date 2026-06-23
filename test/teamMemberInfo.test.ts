import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetEnvCache } from "../src/config.js";
import { requestContext } from "../src/context.js";
import { findTeamMember } from "../src/tools/findTeamMember.js";
import { listTeamMembers } from "../src/tools/listTeamMembers.js";
import { findTeamMemberAcrossPlans } from "../src/tools/findTeamMemberAcrossPlans.js";

const ORG = "https://org12345.crm4.dynamics.com";
const PLAN = "00000000-0000-0000-0000-0000000000c1";
const RES_A = "00000000-0000-0000-0000-0000000000a1";
const RES_B = "00000000-0000-0000-0000-0000000000b2";
const USER_A = "00000000-0000-0000-0000-0000000000d1";
const USER_B = "00000000-0000-0000-0000-0000000000d2";

function withBearer<T>(fn: () => Promise<T>): Promise<T> {
  return requestContext.run({ bearer: "test-token" }, fn);
}
function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

// Shared identity-resolution mock: two people, each with a UPN/email.
function mockIdentity(url: string): Response | null {
  if (url.includes("/bookableresources"))
    return jsonRes({ value: [
      { bookableresourceid: RES_A, _userid_value: USER_A },
      { bookableresourceid: RES_B, _userid_value: USER_B },
    ] });
  if (url.includes("/systemusers"))
    return jsonRes({ value: [
      { systemuserid: USER_A, domainname: "marcin.b@opsora.io", internalemailaddress: "marcin.b@opsora.io", fullname: "Marcin Baluta" },
      { systemuserid: USER_B, domainname: "marcin.k@opsora.io", internalemailaddress: "marcin.k@opsora.io", fullname: "Marcin Kowalski" },
    ] });
  return null;
}

describe("find_team_member — UPN/email enrichment", () => {
  beforeEach(() => {
    process.env.DATAVERSE_ORG_URL = ORG;
    process.env.LOG_LEVEL = "silent";
    process.env.AUTH_MODE = "insecure-passthrough";
    process.env.DATAVERSE_LINK_TYPE_STYLE = "eu";
    delete process.env.TENANT_ID;
    resetEnvCache();
  });
  afterEach(() => { vi.restoreAllMocks(); resetEnvCache(); });

  it("returns upn / email / fullName per matched member", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
      const url = String(input);
      if (url.includes("/msdyn_projectteams"))
        return jsonRes({ value: [{ msdyn_projectteamid: "team-a", msdyn_name: "Marcin Baluta", _msdyn_bookableresourceid_value: RES_A }] });
      return mockIdentity(url) ?? jsonRes({ value: [] });
    });
    const res: any = await withBearer(() => (findTeamMember.handler as any)({ projectId: PLAN, name: "Marcin Baluta" }));
    expect(res.count).toBe(1);
    expect(res.members[0].upn).toBe("marcin.b@opsora.io");
    expect(res.members[0].email).toBe("marcin.b@opsora.io");
    expect(res.members[0].fullName).toBe("Marcin Baluta");
    expect(res.members[0].exactMatch).toBe(true);
  });

  it("degrades to null upn/email when identity resolution fails (no throw)", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
      const url = String(input);
      if (url.includes("/msdyn_projectteams"))
        return jsonRes({ value: [{ msdyn_projectteamid: "team-a", msdyn_name: "Marcin Baluta", _msdyn_bookableresourceid_value: RES_A }] });
      if (url.includes("/bookableresources")) return jsonRes({ error: "x" }, 403);
      return jsonRes({ value: [] });
    });
    const res: any = await withBearer(() => (findTeamMember.handler as any)({ projectId: PLAN, name: "Marcin" }));
    expect(res.count).toBe(1);
    expect(res.members[0].upn).toBeNull();
    expect(res.members[0].bookableResourceId).toBe(RES_A);
  });
});

describe("list_team_members — UPN/email enrichment", () => {
  beforeEach(() => {
    process.env.DATAVERSE_ORG_URL = ORG;
    process.env.LOG_LEVEL = "silent";
    process.env.AUTH_MODE = "insecure-passthrough";
    process.env.DATAVERSE_LINK_TYPE_STYLE = "eu";
    delete process.env.TENANT_ID;
    resetEnvCache();
  });
  afterEach(() => { vi.restoreAllMocks(); resetEnvCache(); });

  it("attaches upn/email/fullName to every member", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
      const url = String(input);
      if (url.includes("/msdyn_projectteams"))
        return jsonRes({ value: [
          { msdyn_projectteamid: "team-a", msdyn_name: "Marcin Baluta", _msdyn_bookableresourceid_value: RES_A },
          { msdyn_projectteamid: "team-b", msdyn_name: "Marcin Kowalski", _msdyn_bookableresourceid_value: RES_B },
        ] });
      return mockIdentity(url) ?? jsonRes({ value: [] });
    });
    const res: any = await withBearer(() => (listTeamMembers.handler as any)({ projectId: PLAN }));
    expect(res.count).toBe(2);
    const byName = Object.fromEntries(res.members.map((m: any) => [m.name, m]));
    expect(byName["Marcin Baluta"].upn).toBe("marcin.b@opsora.io");
    expect(byName["Marcin Kowalski"].email).toBe("marcin.k@opsora.io");
  });
});

describe("find_team_member_across_plans", () => {
  beforeEach(() => {
    process.env.DATAVERSE_ORG_URL = ORG;
    process.env.LOG_LEVEL = "silent";
    process.env.AUTH_MODE = "insecure-passthrough";
    process.env.DATAVERSE_LINK_TYPE_STYLE = "eu";
    delete process.env.TENANT_ID;
    resetEnvCache();
  });
  afterEach(() => { vi.restoreAllMocks(); resetEnvCache(); });

  it("groups one person across multiple plans and resolves UPN + plan names", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
      const url = String(input);
      // same person (RES_A) on two plans, plus a second distinct Marcin (RES_B)
      if (url.includes("/msdyn_projectteams"))
        return jsonRes({ value: [
          { msdyn_projectteamid: "t1", msdyn_name: "Marcin Baluta", _msdyn_bookableresourceid_value: RES_A, _msdyn_project_value: "plan1" },
          { msdyn_projectteamid: "t2", msdyn_name: "Marcin Baluta", _msdyn_bookableresourceid_value: RES_A, _msdyn_project_value: "plan2" },
          { msdyn_projectteamid: "t3", msdyn_name: "Marcin Kowalski", _msdyn_bookableresourceid_value: RES_B, _msdyn_project_value: "plan1" },
        ] });
      if (url.includes("/msdyn_projects"))
        return jsonRes({ value: [
          { msdyn_projectid: "plan1", msdyn_subject: "Website Revamp" },
          { msdyn_projectid: "plan2", msdyn_subject: "Mobile App" },
        ] });
      return mockIdentity(url) ?? jsonRes({ value: [] });
    });
    const res: any = await withBearer(() => (findTeamMemberAcrossPlans.handler as any)({ name: "Marcin" }));
    expect(res.count).toBe(2); // two distinct people, not three rows
    const baluta = res.people.find((p: any) => p.bookableResourceId === RES_A);
    expect(baluta.upn).toBe("marcin.b@opsora.io");
    expect(baluta.planCount).toBe(2);
    expect(baluta.plans.map((p: any) => p.planName).sort()).toEqual(["Mobile App", "Website Revamp"]);
    expect(res.hint).toMatch(/multiple distinct people/i);
  });

  it("rejects an empty query (no name and no email)", async () => {
    await expect(
      withBearer(() => (findTeamMemberAcrossPlans.handler as any)({ name: "   " })),
    ).rejects.toThrow(/provide a name/i);
  });

  it("returns count 0 with a clear hint when nobody matches", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => jsonRes({ value: [] }));
    const res: any = await withBearer(() => (findTeamMemberAcrossPlans.handler as any)({ name: "Nobody" }));
    expect(res.count).toBe(0);
    expect(res.hint).toMatch(/no exact\/partial match|candidates/i);
  });
});

// ── The lookup bug this fix targets ────────────────────────────────────────
// A member whose team-row msdyn_name is blank/null/stale is plainly on the plan
// (list_team_members shows them via the resolved systemuser identity) but the old
// server-side contains(msdyn_name,...) filter returned count:0. Matching must use
// the resolved fullName/email/upn, not just the team-row label.
describe("team member lookup by identity (regression: blank msdyn_name + email search)", () => {
  beforeEach(() => {
    process.env.DATAVERSE_ORG_URL = ORG;
    process.env.LOG_LEVEL = "silent";
    process.env.AUTH_MODE = "insecure-passthrough";
    process.env.DATAVERSE_LINK_TYPE_STYLE = "eu";
    delete process.env.TENANT_ID;
    resetEnvCache();
  });
  afterEach(() => { vi.restoreAllMocks(); resetEnvCache(); });

  // Team rows whose msdyn_name is null — identity is the ONLY source of the name.
  function mockBlankNameTeam(extra: Record<string, unknown> = {}) {
    return vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
      const url = String(input);
      if (url.includes("/msdyn_projectteams"))
        return jsonRes({ value: [
          { msdyn_projectteamid: "team-a", msdyn_name: null, _msdyn_bookableresourceid_value: RES_A, ...extra },
        ] });
      return mockIdentity(url) ?? jsonRes({ value: [] });
    });
  }

  it("find_team_member finds a member by name even when msdyn_name is blank", async () => {
    mockBlankNameTeam();
    const res: any = await withBearer(() =>
      (findTeamMember.handler as any)({ projectId: PLAN, name: "Marcin Baluta" }));
    expect(res.count).toBe(1);
    expect(res.members[0].bookableResourceId).toBe(RES_A);
    expect(res.members[0].fullName).toBe("Marcin Baluta");
    expect(res.members[0].exactMatch).toBe(true);
  });

  it("find_team_member finds a member by email/UPN", async () => {
    mockBlankNameTeam();
    const res: any = await withBearer(() =>
      (findTeamMember.handler as any)({ projectId: PLAN, email: "marcin.b@opsora.io" }));
    expect(res.count).toBe(1);
    expect(res.members[0].bookableResourceId).toBe(RES_A);
    expect(res.members[0].exactMatch).toBe(true);
  });

  it("find_team_member requires a name or email", async () => {
    await expect(
      withBearer(() => (findTeamMember.handler as any)({ projectId: PLAN })),
    ).rejects.toThrow(/provide a name/i);
  });

  it("find_team_member returns candidates + a helpful hint when nothing matches", async () => {
    mockBlankNameTeam();
    const res: any = await withBearer(() =>
      (findTeamMember.handler as any)({ projectId: PLAN, name: "Nobody Here" }));
    expect(res.count).toBe(0);
    expect(res.candidates).toHaveLength(1);
    expect(res.candidates[0].bookableResourceId).toBe(RES_A);
    expect(res.hint).toMatch(/candidates|list_team_members|email/i);
  });

  it("find_team_member_across_plans finds a member by name when msdyn_name is blank", async () => {
    mockBlankNameTeam({ _msdyn_project_value: "plan1" });
    const res: any = await withBearer(() =>
      (findTeamMemberAcrossPlans.handler as any)({ name: "Marcin Baluta" }));
    expect(res.count).toBe(1);
    expect(res.people[0].bookableResourceId).toBe(RES_A);
    expect(res.people[0].fullName).toBe("Marcin Baluta");
    expect(res.people[0].exactMatch).toBe(true);
  });

  it("find_team_member matches a reordered name via order-independent tokens", async () => {
    mockBlankNameTeam();
    const res: any = await withBearer(() =>
      (findTeamMember.handler as any)({ projectId: PLAN, name: "Baluta Marcin" }));
    expect(res.count).toBe(1);
    expect(res.members[0].bookableResourceId).toBe(RES_A);
    expect(res.members[0].exactMatch).toBe(false);
    expect(res.members[0].matchType).toBe("partial");
  });

  it("find_team_member_across_plans returns candidates across plans on a miss", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
      const url = String(input);
      if (url.includes("/msdyn_projectteams"))
        return jsonRes({ value: [
          { msdyn_projectteamid: "t1", msdyn_name: null, _msdyn_bookableresourceid_value: RES_A, _msdyn_project_value: "plan1" },
          { msdyn_projectteamid: "t2", msdyn_name: null, _msdyn_bookableresourceid_value: RES_B, _msdyn_project_value: "plan2" },
        ] });
      return mockIdentity(url) ?? jsonRes({ value: [] });
    });
    const res: any = await withBearer(() =>
      (findTeamMemberAcrossPlans.handler as any)({ name: "Nonexistent Person" }));
    expect(res.count).toBe(0);
    expect(res.candidates).toHaveLength(2); // two distinct people surfaced for AI to pick from
    expect(res.candidates.map((c: any) => c.fullName).sort()).toEqual(["Marcin Baluta", "Marcin Kowalski"]);
    expect(res.hint).toMatch(/candidates/i);
  });

  it("find_team_member_across_plans finds a member by email", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
      const url = String(input);
      if (url.includes("/msdyn_projectteams"))
        return jsonRes({ value: [
          { msdyn_projectteamid: "t1", msdyn_name: null, _msdyn_bookableresourceid_value: RES_A, _msdyn_project_value: "plan1" },
          { msdyn_projectteamid: "t2", msdyn_name: null, _msdyn_bookableresourceid_value: RES_B, _msdyn_project_value: "plan1" },
        ] });
      return mockIdentity(url) ?? jsonRes({ value: [] });
    });
    const res: any = await withBearer(() =>
      (findTeamMemberAcrossPlans.handler as any)({ email: "marcin.k@opsora.io" }));
    expect(res.count).toBe(1);
    expect(res.people[0].bookableResourceId).toBe(RES_B);
    expect(res.people[0].exactMatch).toBe(true);
  });
});
