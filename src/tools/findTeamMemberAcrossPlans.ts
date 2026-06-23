import { z } from "zod";
import { getApiBase } from "../config.js";
import { pageAll, readHeaders } from "./readHelpers.js";
import { queryByIds } from "./taskAssignments.js";
import { enrichTeamRows, memberMatch, type EnrichedMember } from "./teamMemberSearch.js";
import type { ToolDef } from "./types.js";

/**
 * find_team_member_across_plans — resolve a person by display name and/or
 * email/UPN across EVERY plan in one call, instead of looping find_team_member
 * per plan.
 *
 * How it works (all reads, schema verified live on the CRM4 tenant):
 *   1. Page the full msdyn_projectteams collection (NO name filter) so every
 *      team row across all plans is in hand (truncated flag if the scan caps out).
 *   2. Resolve each row's UPN / email / full name via the bookable resource ->
 *      systemuser chain, then match client-side against BOTH the team-row name
 *      AND fullName/email/upn. (The old server-side contains(msdyn_name,...)
 *      filter missed members whose team-row name is blank or stale even though
 *      they are plainly on a plan — this is the bug being fixed.)
 *   3. Group the matching rows by bookableResourceId so the SAME person on N
 *      plans collapses to ONE entry carrying the list of plans they're on (each
 *      with its teamMemberId/projectteamid for that plan, needed to assign).
 *   4. Resolve plan display names via a batched msdyn_projects lookup.
 *   5. Flag exact matches and emit a disambiguation hint — never pick silently
 *      when several distinct people match.
 */
export const findTeamMemberAcrossPlans: ToolDef = {
  name: "find_team_member_across_plans",
  title: "Find Team Member (all plans)",
  description:
    "Searches EVERY plan for project team members matching `name` (partial, case-insensitive) and/or `email`/UPN, in a single call. Matches against BOTH the team-row name AND the person's real identity (fullName/email/upn via bookable resource -> systemuser), so a member is found even when the raw team-row name is blank or stale. Matching is exact → substring → order-independent tokens (so 'Baluta Marcin' finds 'Marcin Baluta'); each person carries matchType ('exact'|'partial'). When nothing matches, the response includes a `candidates` list (distinct people across all plans) so YOU can resolve the harder cases (typos, nicknames, transliteration) and confirm the pick with the user. Groups results by person (bookableResourceId) so someone on several plans appears once, with the list of plans they belong to (each plan carries its own teamMemberId for assignments). Each person includes upn, email and fullName so two people sharing a display name can be told apart. Use this to answer 'which tasks does <name> have?' — take the matched person's bookableResourceId and pass it to list_user_tasks. Provide name and/or email (at least one). If several distinct people match, ask the user which one; never guess. truncated=true means the plan scan hit its cap and the result is incomplete.",
  inputSchema: {
    name: z
      .string()
      .optional()
      .describe("Full or partial display name to search across all plans, e.g. 'Marcin'. Provide name and/or email."),
    email: z
      .string()
      .optional()
      .describe(
        "Email or UPN to match (exact or partial), e.g. 'marcin.baluta@utimaco.com'. Use when name search fails.",
      ),
  },
  handler: async (input: { name?: string; email?: string }) => {
    const BASE = getApiBase();
    const name = (input.name || "").trim();
    const email = (input.email || "").trim();
    if (!name && !email)
      throw new Error("Provide a name and/or email to search for across plans.");

    // 1. One paged scan of ALL plans' team rows (no name filter — the team-row
    //    name is unreliable; we match on resolved identity instead).
    const url =
      BASE +
      "/msdyn_projectteams?$select=msdyn_projectteamid,msdyn_name,_msdyn_bookableresourceid_value,_msdyn_project_value";
    const paged = await pageAll(url, readHeaders());
    const rows = paged.rows;

    // 2. Resolve identity for every row (order-preserving), then match
    //    client-side on name and/or email across name+fullName+email+upn.
    const enriched = await enrichTeamRows(BASE, rows);

    interface PlanRef {
      projectId: string | null;
      teamMemberId: string;
      planName: string | null;
    }
    interface Person {
      name: string | null;
      bookableResourceId: string | null;
      upn: string | null;
      email: string | null;
      fullName: string | null;
      exactMatch: boolean;
      matchType: "exact" | "partial";
      plans: PlanRef[];
    }
    const byPerson = new Map<string, Person>();
    const projectIds = new Set<string>();

    // The distinct-person key for a row (resource id, or team-row id for the rare
    // resource-less generic row).
    const personKey = (e: { bookableResourceId: string | null; teamMemberId: string }) =>
      e.bookableResourceId ? "r:" + String(e.bookableResourceId).toLowerCase() : "t:" + e.teamMemberId;

    for (let i = 0; i < enriched.length; i++) {
      const e = enriched[i];
      const { match, exact } = memberMatch(e, { name, email });
      if (!match) continue;

      const projectId: string | null = rows[i]?._msdyn_project_value ?? null;
      const key = personKey(e);
      if (projectId) projectIds.add(projectId);

      let person = byPerson.get(key);
      if (!person) {
        person = {
          // Prefer the authoritative full name; fall back to the team-row label.
          name: e.fullName ?? e.name,
          bookableResourceId: e.bookableResourceId,
          upn: e.upn,
          email: e.email,
          fullName: e.fullName,
          exactMatch: exact,
          matchType: exact ? "exact" : "partial",
          plans: [],
        };
        byPerson.set(key, person);
      } else if (exact) {
        person.exactMatch = true;
        person.matchType = "exact";
      }
      person.plans.push({ projectId, teamMemberId: e.teamMemberId, planName: null });
    }

    // 3. Resolve plan display names (batched). Fail-soft → names stay null.
    const planNames = new Map<string, string>();
    if (projectIds.size > 0) {
      try {
        const projectRows = await queryByIds(
          BASE,
          "msdyn_projects",
          "msdyn_projectid",
          [...projectIds],
          "$select=msdyn_projectid,msdyn_subject",
          "find_team_member_across_plans",
        );
        for (const p of projectRows)
          planNames.set(String(p.msdyn_projectid).toLowerCase(), p.msdyn_subject);
      } catch {
        // leave plan names null
      }
    }

    // 4. Assemble, attach plan names, sort exact matches first.
    const people = [...byPerson.values()].map((p) => ({
      name: p.name,
      bookableResourceId: p.bookableResourceId,
      upn: p.upn,
      email: p.email,
      fullName: p.fullName,
      exactMatch: p.exactMatch,
      matchType: p.matchType,
      planCount: p.plans.length,
      plans: p.plans.map((pl) => ({
        projectId: pl.projectId,
        planName: pl.projectId ? planNames.get(pl.projectId.toLowerCase()) ?? null : null,
        teamMemberId: pl.teamMemberId,
      })),
    }));
    people.sort((a, b) => (a.exactMatch === b.exactMatch ? 0 : a.exactMatch ? -1 : 1));

    const exactCount = people.filter((p) => p.exactMatch).length;
    let hint: string;
    let candidates: Array<Pick<EnrichedMember, "name" | "bookableResourceId" | "upn" | "email" | "fullName">> | undefined;
    if (people.length === 0) {
      // No deterministic match — hand the AI a deduped roster across all plans so
      // it can resolve the harder cases (typos, nicknames, reordered names) and
      // confirm the pick with the user before acting.
      const seen = new Set<string>();
      candidates = [];
      for (const e of enriched) {
        const key = personKey(e);
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push({
          name: e.fullName ?? e.name,
          bookableResourceId: e.bookableResourceId,
          upn: e.upn,
          email: e.email,
          fullName: e.fullName,
        });
        if (candidates.length >= 50) break;
      }
      hint =
        "No exact/partial match by name or email. The `candidates` field lists distinct people across all plans - inspect it yourself and pick the most likely person (allow for typos, nicknames, reordered or transliterated names, or a partial email), then CONFIRM with the user before acting. Or retry with an email/UPN. If nobody fits, the person may not be on any plan team yet.";
    } else if (people.length === 1) {
      hint = "Unique person - use this bookableResourceId with list_user_tasks.";
    } else if (exactCount === 1) {
      hint = "One exact match - likely the intended person, but confirm via upn/email if unsure.";
    } else {
      hint = "Multiple distinct people match - ask the user which one (compare upn/email); never pick silently.";
    }

    return {
      ok: true,
      query: { name: name || null, email: email || null },
      count: people.length,
      exactMatchCount: exactCount,
      truncated: paged.truncated,
      people,
      ...(candidates ? { candidates, candidatesTruncated: candidates.length >= 50 } : {}),
      hint,
    };
  },
};
