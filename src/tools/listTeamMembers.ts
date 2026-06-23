import { z } from "zod";
import { getApiBase } from "../config.js";
import { assertGuid } from "../dataverse.js";
import { fetchPlanMembers } from "./teamMemberSearch.js";
import type { ToolDef } from "./types.js";

// All team members of a plan (generalises find_team_member without the name/email
// filter). Shares the exact same fetch + identity enrichment as find_team_member,
// so any member listed here is guaranteed to be findable by find_team_member.
export const listTeamMembers: ToolDef = {
  name: "list_team_members",
  title: "List Team Members",
  description:
    "Lists all team members of a plan with their projectteamid and bookableresourceid (needed for resource assignments), plus each person's upn, email and fullName (resolved via the bookable resource's systemuser). Use find_team_member to resolve a single person by name or email, or find_team_member_across_plans to search every plan.",
  inputSchema: {
    projectId: z.string().describe("GUID of the plan (msdyn_projectid)."),
  },
  handler: async (input: { projectId: string }) => {
    const BASE = getApiBase();
    const projectId = assertGuid(input.projectId, "projectId");
    const members = await fetchPlanMembers(BASE, projectId);
    return { ok: true, projectId, count: members.length, members };
  },
};
