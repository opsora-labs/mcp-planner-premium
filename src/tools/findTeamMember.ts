import { z } from "zod";
import { getApiBase } from "../config.js";
import { assertGuid } from "../dataverse.js";
import { fetchPlanMembers, memberMatch, type EnrichedMember } from "./teamMemberSearch.js";
import type { ToolDef } from "./types.js";

// Find Team Member - resolve project team member(s) for ONE plan by display name
// and/or email/UPN. Matches against BOTH the team-row label AND the person's real
// identity (fullName/email/upn via bookable resource -> systemuser), so a member
// is found even when the raw team-row name is blank or stale.
export const findTeamMember: ToolDef = {
  name: "find_team_member",
  title: "Find Team Member",
  description:
    "Resolves project team members for ONE plan by display name and/or email/UPN. Matches against BOTH the team-row name AND the person's real identity (fullName, email, upn resolved via the bookable resource's systemuser), so a member is found even when the raw team-row name is blank or stale. Matching is exact → substring → order-independent tokens (so 'Baluta Marcin' still finds 'Marcin Baluta'); each result carries matchType ('exact'|'partial'). When nothing matches, the response includes a `candidates` list (all members of the plan) so YOU can resolve the harder cases (typos, nicknames, transliteration) and confirm the pick with the user. Returns projectteamid AND bookableresourceid (needed for msdyn_resourceassignment), plus upn/email/fullName so you can disambiguate two people with the same display name. Provide name and/or email (at least one). Use BEFORE adding assignments. Never guess GUIDs - if nobody fits, add the person to the plan in the Planner UI first. To search ALL plans at once, use find_team_member_across_plans.",
  inputSchema: {
    projectId: z.string().describe("GUID of the plan (msdyn_projectid)."),
    name: z
      .string()
      .optional()
      .describe("Full or partial display name, e.g. 'Marcin Baluta'. Provide name and/or email."),
    email: z
      .string()
      .optional()
      .describe(
        "Email or UPN to match (exact or partial), e.g. 'marcin.baluta@utimaco.com'. Use when name search fails or to disambiguate.",
      ),
  },
  handler: async (input: { projectId: string; name?: string; email?: string }) => {
    const BASE = getApiBase();

    const projectId = assertGuid(input.projectId, "projectId");
    const name = (input.name || "").trim();
    const email = (input.email || "").trim();
    if (!name && !email)
      throw new Error("Provide a name and/or email to search for the team member.");

    // Fetch the FULL plan team (same query as list_team_members) and match
    // client-side. This guarantees any member visible in list_team_members is
    // findable here, regardless of what the team-row's msdyn_name holds.
    const all = await fetchPlanMembers(BASE, projectId);

    const matched = all
      .map((m) => ({ member: m, ...memberMatch(m, { name, email }) }))
      .filter((r) => r.match)
      .map((r) => ({ ...r.member, exactMatch: r.exact, matchType: r.matchType }));

    matched.sort((a, b) => (a.exactMatch === b.exactMatch ? 0 : a.exactMatch ? -1 : 1));
    const exactCount = matched.filter((m) => m.exactMatch).length;

    let hint: string;
    let candidates: EnrichedMember[] | undefined;
    if (matched.length === 0) {
      // No deterministic match — hand the AI the full roster so it can resolve
      // the harder cases our matcher won't (typos, nicknames, reordered names,
      // a partial email) and confirm the pick with the user.
      hint =
        "No exact/partial match by name or email. The `candidates` field lists every member of this plan - inspect it yourself and pick the most likely person (allow for typos, nicknames, reordered or transliterated names, or a partial email), then CONFIRM with the user before acting. If nobody fits, the person may not be on the plan team yet - add them in the Planner UI first. You can also retry with an email/UPN.";
      candidates = all.slice(0, 25);
    } else if (exactCount === 1) {
      hint = "Exact match found - use this bookableResourceId for the assignment or list_user_tasks.";
    } else if (exactCount > 1) {
      hint = "Multiple team members share this exact name - disambiguate via upn/email; never pick silently.";
    } else if (matched.length > 1) {
      hint = "Multiple partial matches (no exact one) - compare upn/email and confirm the intended person with the user.";
    } else {
      hint = "Single partial match (matchType='partial', not exact) - sanity-check the upn/email/fullName before using it.";
    }

    return {
      ok: true,
      count: matched.length,
      exactMatchCount: exactCount,
      members: matched,
      ...(candidates ? { candidates, confidence: "low" as const } : {}),
      hint,
    };
  },
};
