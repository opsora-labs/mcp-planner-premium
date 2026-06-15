import { z } from "zod";
import { getApiBase } from "../config.js";
import { dvReq, dvHeaders, dvErrorMessage, assertGuid } from "../dataverse.js";
import { pageAll, readHeaders, linkTypeLabel } from "./readHelpers.js";
import type { ToolDef } from "./types.js";

// All predecessor->successor links for a plan. msdyn_projecttaskdependency has a
// direct project lookup (verified in the schedule-API sample), so this is one
// query; task subjects are enriched from a second task scan.
export const listDependencies: ToolDef = {
  name: "list_dependencies",
  title: "List Dependencies",
  description:
    "Lists all task dependencies (predecessor -> successor) in a plan, with link type (FS/SS/FF/SF) and lag (minutes), enriched with task names. Dependencies cannot be edited via the writer - delete and recreate to change them.",
  inputSchema: {
    projectId: z.string().describe("GUID of the plan (msdyn_projectid)."),
  },
  handler: async (input: { projectId: string }) => {
    const BASE = getApiBase();
    const projectId = assertGuid(input.projectId, "projectId");
    const warnings: string[] = [];

    const depRes = await dvReq(
      {
        url:
          BASE +
          "/msdyn_projecttaskdependency?$select=_msdyn_predecessortask_value," +
          "_msdyn_successortask_value,msdyn_projecttaskdependencylinktype,msdyn_linklagduration" +
          "&$filter=_msdyn_project_value eq " +
          projectId +
          "&$top=2000",
        method: "GET",
        headers: dvHeaders(),
      },
      { retry: true },
    );
    // Some environments do not expose the msdyn_projecttaskdependency entity set
    // (the segment 404s). Degrade gracefully - the same pattern get_task uses -
    // rather than failing the whole call.
    if (depRes.status === 404)
      return {
        ok: true,
        projectId,
        count: 0,
        dependencies: [],
        warnings: ["Dependency links unavailable on this environment."],
      };
    if (depRes.status >= 400)
      throw new Error(
        "list_dependencies failed (" + depRes.status + "): " + dvErrorMessage(depRes),
      );

    // Enrich with task subjects (best-effort).
    const subjectById = new Map<string, string>();
    try {
      const paged = await pageAll(
        BASE +
          "/msdyn_projecttasks?$select=msdyn_projecttaskid,msdyn_subject&$filter=_msdyn_project_value eq " +
          projectId,
        readHeaders(),
      );
      for (const t of paged.rows)
        subjectById.set(String(t.msdyn_projecttaskid).toLowerCase(), t.msdyn_subject);
    } catch {
      warnings.push("Could not resolve task names - ids only.");
    }

    const name = (id: unknown) =>
      id ? subjectById.get(String(id).toLowerCase()) ?? null : null;

    const dependencies = (depRes.json?.value || []).map((d: any) => ({
      predecessorTaskId: d._msdyn_predecessortask_value,
      predecessorSubject: name(d._msdyn_predecessortask_value),
      successorTaskId: d._msdyn_successortask_value,
      successorSubject: name(d._msdyn_successortask_value),
      type: linkTypeLabel(d.msdyn_projecttaskdependencylinktype),
      lagMinutes: d.msdyn_linklagduration ?? null,
    }));

    return { ok: true, projectId, count: dependencies.length, dependencies, warnings };
  },
};
