/**
 * Shared team-member fetch + match used by find_team_member,
 * find_team_member_across_plans and list_team_members so the three tools see the
 * SAME members and resolve identity the SAME way.
 *
 * Why this exists — the lookup bug it fixes:
 *   The find tools used to filter server-side with OData
 *   contains(msdyn_name,'<query>'). But msdyn_projectteams.msdyn_name is only a
 *   team-row LABEL — it is frequently blank or stale, while the authoritative
 *   display name / email live on the joined systemuser (reached via
 *   bookableresource -> systemuser). So a member who is plainly on a plan (and
 *   shows up in list_team_members with a clean fullName/email) returned count:0
 *   from the name-filtered search. The fix is to resolve identity FIRST and match
 *   client-side against BOTH the team-row name AND fullName/email/upn.
 */
import { dvReq, dvHeaders, dvErrorMessage } from "../dataverse.js";
import { resolveResourceIdentities } from "./identity.js";

export interface EnrichedMember {
  teamMemberId: string;
  /** msdyn_projectteams.msdyn_name — a team-row label; may be null/blank/stale. */
  name: string | null;
  bookableResourceId: string | null;
  /** systemuser.domainname (resolved via the bookable resource). */
  upn: string | null;
  /** systemuser.internalemailaddress. */
  email: string | null;
  /** systemuser.fullname — the authoritative display name. */
  fullName: string | null;
}

/**
 * Enriches raw msdyn_projectteams rows with UPN / email / full name via the
 * bookable resource -> systemuser chain (fail-soft: nulls if unresolved).
 * Order-preserving: the returned array lines up index-for-index with `rows`.
 */
export async function enrichTeamRows(base: string, rows: any[]): Promise<EnrichedMember[]> {
  const raw = rows.map((m: any) => ({
    teamMemberId: m.msdyn_projectteamid,
    name: (m.msdyn_name ?? null) as string | null,
    bookableResourceId: (m._msdyn_bookableresourceid_value ?? null) as string | null,
  }));
  const identities = await resolveResourceIdentities(
    base,
    raw.map((m) => m.bookableResourceId).filter((x): x is string => !!x),
  );
  return raw.map((m) => {
    const id = m.bookableResourceId
      ? identities.get(String(m.bookableResourceId).toLowerCase())
      : undefined;
    return {
      ...m,
      upn: id?.upn ?? null,
      email: id?.email ?? null,
      fullName: id?.fullName ?? null,
    };
  });
}

/**
 * Fetches every team member of ONE plan (project-only filter — no name filter)
 * and enriches each with identity. This is exactly what list_team_members
 * returns, so a member visible there is always visible to find_team_member.
 */
export async function fetchPlanMembers(base: string, projectId: string): Promise<EnrichedMember[]> {
  const res = await dvReq(
    {
      url:
        base +
        "/msdyn_projectteams?$select=msdyn_projectteamid,msdyn_name,_msdyn_bookableresourceid_value" +
        "&$filter=_msdyn_project_value eq " +
        projectId +
        "&$top=200",
      method: "GET",
      headers: dvHeaders(),
    },
    { retry: true },
  );
  if (res.status >= 400)
    throw new Error("team member lookup failed (" + res.status + "): " + dvErrorMessage(res));
  return enrichTeamRows(base, res.json?.value || []);
}

export interface MemberMatch {
  match: boolean;
  exact: boolean;
  /**
   * How strong the match is, so the caller (and the AI) can judge confidence:
   *   'exact'   — full-string identity equality (name or email/upn)
   *   'partial' — substring of one identity field, OR an order-independent
   *               token match (every query word appears somewhere in the
   *               identity, so "Baluta Marcin" matches "Marcin Baluta")
   *   null      — no match
   * Anything looser than this (typos, nicknames, transliteration) is left to the
   * AI to resolve from the returned `candidates` — never auto-picked here.
   */
  matchType: "exact" | "partial" | null;
}

/**
 * Client-side match of an enriched member against a name and/or email query.
 *
 * Matches across BOTH the team-row label (name) AND the authoritative systemuser
 * identity (fullName / email / upn), so a member with a blank or stale team-row
 * name is still found by their real name or email. OR semantics across whatever
 * criteria are supplied; case-insensitive.
 *
 * Tiers, strongest first: exact equality → substring → order-independent token
 * subset (handles reordered names like "Baluta, Marcin"). Fuzzier matching
 * (typos/nicknames) is deliberately NOT done here — the tools surface candidates
 * and let the AI reason, so name resolution stays predictable and testable while
 * the hard cases get the model's judgment.
 */
export function memberMatch(
  m: { name: string | null; fullName: string | null; email: string | null; upn: string | null },
  q: { name?: string; email?: string },
): MemberMatch {
  let exact = false;
  let partial = false;

  const norm = (s: string | null) =>
    typeof s === "string" && s.trim().length > 0 ? s.trim().toLowerCase() : null;
  const names = [m.name, m.fullName].map(norm).filter((s): s is string => s !== null);
  const mails = [m.email, m.upn].map(norm).filter((s): s is string => s !== null);
  const haystack = [...names, ...mails].join(" ");

  const name = (q.name || "").trim().toLowerCase();
  if (name) {
    if (names.some((s) => s === name)) exact = true;
    else if (names.some((s) => s.includes(name))) partial = true;
    else {
      // Order-independent: every word of the query appears somewhere in the
      // identity (e.g. "baluta marcin" or "marcin utimaco" → Marcin Baluta).
      const tokens = name.split(/[\s,]+/).filter(Boolean);
      if (tokens.length > 1 && tokens.every((t) => haystack.includes(t))) partial = true;
    }
  }

  const email = (q.email || "").trim().toLowerCase();
  if (email) {
    if (mails.some((s) => s === email)) exact = true;
    else if (mails.some((s) => s.includes(email))) partial = true;
  }

  return {
    match: exact || partial,
    exact,
    matchType: exact ? "exact" : partial ? "partial" : null,
  };
}
