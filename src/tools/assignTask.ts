import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getApiBase } from "../config.js";
import {
  dvReq,
  dvHeaders,
  dvErrorMessage,
  asArray,
  assertGuid,
} from "../dataverse.js";
import { validateAddEntities } from "./addTasks.js";
import { buildDeleteEntities, validateDeleteRecords } from "./deleteTasks.js";
import type { ToolDef } from "./types.js";

const GUID_RE = /^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$/;
const isGuid = (s: string): boolean => GUID_RE.test(s);

export interface ResolvedMember {
  name: string;
  teamMemberId: string;
  bookableResourceId: string;
}

/**
 * Pure builder: translates a list of already-resolved team members into the
 * msdyn_resourceassignment PSS create entities. Produces one entity per member,
 * using the EXACT proven bind names and casing from §5 of PSS-IMPLEMENTATION-LESSONS.md
 * and addTasksSimple.ts:356-365.
 *
 * Guardrails:
 * - start/finish are NEVER emitted (blocked on create — PSS derives them).
 * - Members whose teamMemberId is in alreadyAssignedTeamIds are skipped (idempotence guard).
 * - validateAddEntities is run on the result by the caller as defense-in-depth.
 *
 * @param projectId  GUID of the plan (msdyn_projectid).
 * @param taskId     GUID of the task (msdyn_projecttaskid).
 * @param members    Already-resolved team members (network resolution stays in the handler).
 * @param alreadyAssignedTeamIds  Optional: lowercased teamMemberIds already assigned
 *   to this task (for the idempotence / duplicate-assignment guard).
 */
export function buildAssignmentEntities(
  projectId: string,
  taskId: string,
  members: ResolvedMember[],
  alreadyAssignedTeamIds: Set<string> = new Set(),
): {
  entities: any[];
  assigned: { name: string; teamMemberId: string; assignmentId: string }[];
  skipped: string[];
  warnings: string[];
} {
  if (!Array.isArray(members) || members.length === 0) {
    throw new Error("members must be a non-empty array of resolved team members.");
  }

  const entities: any[] = [];
  const assigned: { name: string; teamMemberId: string; assignmentId: string }[] = [];
  const skipped: string[] = [];
  const warnings: string[] = [];

  for (const member of members) {
    const teamIdLo = String(member.teamMemberId || "").toLowerCase();
    if (alreadyAssignedTeamIds.has(teamIdLo)) {
      const msg = "'" + member.name + "' (" + member.teamMemberId + ") is already assigned to this task — skipped (idempotence guard).";
      warnings.push(msg);
      skipped.push(member.name);
      continue;
    }

    const assignmentId = randomUUID();
    // Resource assignment entity — proven payload from §5 / addTasksSimple.ts:356-365.
    // Bind casing: ALL LOWERCASE (msdyn_taskid, msdyn_projectid, msdyn_projectteamid,
    // msdyn_bookableresourceid). msdyn_start/msdyn_finish NEVER emitted (blocked on create).
    const ent: Record<string, unknown> = {
      "@odata.type": "Microsoft.Dynamics.CRM.msdyn_resourceassignment",
      msdyn_resourceassignmentid: assignmentId,
      msdyn_name: member.name,
      "msdyn_taskid@odata.bind": "/msdyn_projecttasks(" + taskId + ")",
      "msdyn_projectid@odata.bind": "/msdyn_projects(" + projectId + ")",
      "msdyn_projectteamid@odata.bind": "/msdyn_projectteams(" + member.teamMemberId + ")",
    };
    if (member.bookableResourceId) {
      ent["msdyn_bookableresourceid@odata.bind"] =
        "/bookableresources(" + member.bookableResourceId + ")";
    }
    entities.push(ent);
    assigned.push({ name: member.name, teamMemberId: member.teamMemberId, assignmentId });
  }

  return { entities, assigned, skipped, warnings };
}

// assign_task — assign or unassign a team member on an EXISTING task.
export const assignTask: ToolDef = {
  name: "assign_task",
  title: "Assign / Unassign Task",
  description:
    "Assigns or unassigns project-team members on an EXISTING task inside an open change session. " +
    "mode='assign' (default): queues a msdyn_resourceassignment create for each resolved member. " +
    "mode='unassign': reads existing assignments for the task and queues deletes — requires confirmed=true. " +
    "Pass assignees as member display names or teamMemberId GUIDs (from list_team_members). " +
    "Members not on this plan's project team are skipped with a warning. " +
    "Duplicate assignments are detected and skipped automatically. " +
    "Auto-cascade dependencies are NOT managed here; for task deletion use delete_tasks_batch with projectId. " +
    "Changes are NOT saved until 'Apply Changes to Plan'.",
  inputSchema: {
    operationSetId: z
      .string()
      .describe("GUID of the open OperationSet (from 'Start Change Session')."),
    projectId: z
      .string()
      .describe("GUID of the plan (msdyn_projectid). Used to scope team member resolution."),
    taskId: z
      .string()
      .describe("GUID of the task to (un)assign (msdyn_projecttaskid)."),
    assignees: z
      .union([z.string(), z.array(z.string())])
      .describe(
        "Member display name(s) or teamMemberId GUID(s) to assign/unassign, as a real JSON array, e.g. [\"Alice\"]. " +
          "A single bare name or a JSON-encoded string is also accepted, but prefer a native array. " +
          "Members must already be on the plan's project team — unknown members are skipped with a warning.",
      ),
    mode: z
      .enum(["assign", "unassign"])
      .optional()
      .describe("'assign' (default) adds assignments; 'unassign' removes them (requires confirmed=true)."),
    confirmed: z
      .boolean()
      .optional()
      .describe(
        "Required to be true when mode='unassign'. Obtain explicit user confirmation before unassigning.",
      ),
  },
  handler: async (input: {
    operationSetId: string;
    projectId: string;
    taskId: string;
    assignees: unknown;
    mode?: unknown;
    confirmed?: unknown;
  }) => {
    const BASE = getApiBase();

    const operationSetId = assertGuid(input.operationSetId, "operationSetId");
    const projectId = assertGuid(input.projectId, "projectId");
    const taskId = assertGuid(input.taskId, "taskId");

    const mode = ((input.mode as string) || "assign") === "unassign" ? "unassign" : "assign";

    if (mode === "unassign") {
      if (input.confirmed !== true && (input.confirmed as unknown) !== "true") {
        throw new Error(
          "Refused: 'confirmed' must be true for mode='unassign'. " +
            "Obtain explicit per-record user confirmation BEFORE calling this action.",
        );
      }
    }

    const rawAssignees = asArray<string>(input.assignees, "assignees", {
      coerceScalar: true,
      example: '["Alice", "bob@contoso.com"]',
    });
    if (rawAssignees.length === 0) throw new Error("assignees must be a non-empty array.");

    // Resolve team members: one read per call, scoped to this plan's project team.
    // By-id keyed on msdyn_projectteamid (lowercased); by-name keyed on msdyn_name.
    // This is the EXACT resolver pattern from addTasksSimple.ts:615-649.
    const teamById: Record<string, { teamMemberId: string; name: string; bookableResourceId: string }> = {};
    const teamByName: Record<string, { teamMemberId: string; name: string; bookableResourceId: string }> = {};

    const teamRes = await dvReq(
      {
        url:
          BASE +
          "/msdyn_projectteams?$select=msdyn_projectteamid,msdyn_name,_msdyn_bookableresourceid_value" +
          "&$filter=_msdyn_project_value eq " +
          projectId +
          "&$top=200",
        method: "GET",
        headers: dvHeaders(),
      },
      { retry: true },
    );
    if (teamRes.status >= 400) {
      throw new Error(
        "team lookup failed (" + teamRes.status + "): " + dvErrorMessage(teamRes),
      );
    }
    for (const m of teamRes.json?.value || []) {
      const entry = {
        teamMemberId: m.msdyn_projectteamid,
        name: String(m.msdyn_name || ""),
        bookableResourceId: m._msdyn_bookableresourceid_value || "",
      };
      teamById[String(m.msdyn_projectteamid).toLowerCase()] = entry;
      const nm = String(m.msdyn_name || "").trim().toLowerCase();
      if (nm) teamByName[nm] = entry;
    }

    // Resolve each requested assignee; unknown members are skipped with a warning.
    const resolvedMembers: ResolvedMember[] = [];
    const unresolvedWarnings: string[] = [];

    for (const raw of rawAssignees) {
      const a = (raw || "").trim();
      if (!a) continue;
      const entry = isGuid(a) ? teamById[a.toLowerCase()] : teamByName[a.toLowerCase()];
      if (!entry) {
        unresolvedWarnings.push(
          "'" + a + "' was skipped — not a member of this plan's project team. " +
            "Add the person to the project team first (they must be a bookable Project resource).",
        );
        continue;
      }
      resolvedMembers.push({
        name: entry.name,
        teamMemberId: entry.teamMemberId,
        bookableResourceId: entry.bookableResourceId,
      });
    }

    // --- ASSIGN mode ---
    if (mode === "assign") {
      if (resolvedMembers.length === 0) {
        return {
          ok: false,
          mode,
          taskId,
          queued: 0,
          assigned: [],
          skipped: rawAssignees,
          warnings: unresolvedWarnings,
          note: "No members could be resolved — nothing was queued.",
        };
      }

      // Idempotence: read existing assignments for this task to avoid duplicate rows.
      const alreadyAssignedTeamIds = new Set<string>();
      const existingRes = await dvReq(
        {
          url:
            BASE +
            "/msdyn_resourceassignments?$select=msdyn_resourceassignmentid,_msdyn_projectteamid_value" +
            "&$filter=_msdyn_taskid_value eq " +
            taskId,
          method: "GET",
          headers: dvHeaders(),
        },
        { retry: true },
      );
      if (existingRes.status < 400) {
        for (const a of existingRes.json?.value || []) {
          const tid = String(a._msdyn_projectteamid_value || "").toLowerCase();
          if (tid) alreadyAssignedTeamIds.add(tid);
        }
      }
      // Non-fatal if the read fails — proceed without the idempotence guard and let
      // PSS reject a true duplicate if one occurs.

      const built = buildAssignmentEntities(projectId, taskId, resolvedMembers, alreadyAssignedTeamIds);
      const allWarnings = [...unresolvedWarnings, ...built.warnings];

      if (built.entities.length === 0) {
        return {
          ok: true,
          mode,
          taskId,
          queued: 0,
          assigned: built.assigned,
          skipped: [...built.skipped, ...rawAssignees.filter((r) => unresolvedWarnings.some((w) => w.includes("'" + r + "'"))),],
          warnings: allWarnings.length > 0 ? allWarnings : undefined,
          note: "All resolved members were already assigned — nothing queued.",
        };
      }

      // Defense in depth: run the add guardrails on the built batch.
      validateAddEntities(built.entities);

      const response = await dvReq({
        url: BASE + "/msdyn_PssCreateV2",
        method: "POST",
        headers: dvHeaders({ json: true }),
        body: { EntityCollection: built.entities, OperationSetId: operationSetId },
      });

      const body = response.json || {};
      if (response.status >= 400) {
        const msg = dvErrorMessage(response);
        if (response.status === 403)
          throw new Error("403 - missing license or privileges: " + msg);
        throw new Error("msdyn_PssCreateV2 failed (" + response.status + "): " + msg);
      }

      return {
        ok: true,
        mode,
        taskId,
        queued: built.entities.length,
        assigned: built.assigned,
        skipped: built.skipped,
        warnings: allWarnings.length > 0 ? allWarnings : undefined,
        response: body,
        note: "Assignment(s) queued. NOT saved until 'Apply Changes to Plan'.",
      };
    }

    // --- UNASSIGN mode ---
    // Read current assignments for this task.
    const asgRes = await dvReq(
      {
        url:
          BASE +
          "/msdyn_resourceassignments?$select=msdyn_resourceassignmentid,_msdyn_projectteamid_value" +
          "&$expand=msdyn_projectteamid($select=msdyn_name)" +
          "&$filter=_msdyn_taskid_value eq " +
          taskId,
        method: "GET",
        headers: dvHeaders(),
      },
      { retry: true },
    );
    if (asgRes.status >= 400) {
      throw new Error(
        "assignment lookup failed (" + asgRes.status + "): " + dvErrorMessage(asgRes),
      );
    }

    // Map teamMemberId (lowercased) -> { assignmentId, name }
    const liveAssignments = new Map<
      string,
      { assignmentId: string; name: string }
    >();
    for (const a of asgRes.json?.value || []) {
      const tid = String(a._msdyn_projectteamid_value || "").toLowerCase();
      const name =
        a.msdyn_projectteamid?.msdyn_name || tid;
      if (tid) {
        liveAssignments.set(tid, {
          assignmentId: String(a.msdyn_resourceassignmentid),
          name: String(name),
        });
      }
    }

    // Match requested assignees to live assignment records.
    const toRemove: { entityLogicalName: "msdyn_resourceassignment"; recordId: string }[] = [];
    const removed: { assignmentId: string; teamMemberId: string; name: string }[] = [];
    const unassignWarnings: string[] = [...unresolvedWarnings];

    for (const member of resolvedMembers) {
      const tidLo = member.teamMemberId.toLowerCase();
      const live = liveAssignments.get(tidLo);
      if (!live) {
        unassignWarnings.push(
          "'" + member.name + "' is not currently assigned to this task — skipped.",
        );
        continue;
      }
      toRemove.push({
        entityLogicalName: "msdyn_resourceassignment",
        recordId: live.assignmentId,
      });
      removed.push({
        assignmentId: live.assignmentId,
        teamMemberId: member.teamMemberId,
        name: live.name,
      });
    }

    if (toRemove.length === 0) {
      return {
        ok: true,
        mode,
        taskId,
        queued: 0,
        removed: [],
        warnings: unassignWarnings.length > 0 ? unassignWarnings : undefined,
        note: "No matching live assignments found — nothing queued.",
      };
    }

    // Reuse validateDeleteRecords (it checks the 200 cap, whole-plan block, allow-list).
    validateDeleteRecords(toRemove);

    const delResponse = await dvReq({
      url: BASE + "/msdyn_PssDeleteV2",
      method: "POST",
      headers: dvHeaders({ json: true }),
      body: {
        EntityCollection: buildDeleteEntities(toRemove),
        OperationSetId: operationSetId,
      },
    });

    const delBody = delResponse.json || {};
    if (delResponse.status >= 400) {
      const msg = dvErrorMessage(delResponse);
      if (delResponse.status === 403)
        throw new Error("403 - missing license or privileges: " + msg);
      throw new Error("msdyn_PssDeleteV2 failed (" + delResponse.status + "): " + msg);
    }

    return {
      ok: true,
      mode,
      taskId,
      queued: toRemove.length,
      removed,
      warnings: unassignWarnings.length > 0 ? unassignWarnings : undefined,
      response: delBody,
      note: "Unassignment(s) queued. NOT saved until 'Apply Changes to Plan'.",
    };
  },
};
