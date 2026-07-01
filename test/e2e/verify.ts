/**
 * Independent verification via direct Dataverse OData GETs.
 * Uses the delegated bearer directly — bypasses the MCP server so a bug
 * there can't mask a failed write.
 */

import { getConfig } from "./config.js";
import { redact } from "./config.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function dvGet(path: string, bearer: string): Promise<any> {
  const cfg = getConfig();
  const base = cfg.DATAVERSE_ORG_URL + "/api/data/v9.2";
  const res = await fetch(base + path, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${bearer}`,
      "OData-MaxVersion": "4.0",
      "OData-Version": "4.0",
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 401) {
    throw new Error(
      `Independent verification: 401 Unauthorized (token ${redact(bearer)} may be expired or wrong audience)`,
    );
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Independent verification HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

/** Count tasks in a plan directly from Dataverse (bypasses MCP). */
export async function verifyTaskCount(
  projectId: string,
  bearer: string,
): Promise<{ count: number; truncated: boolean }> {
  const data = await dvGet(
    `/msdyn_projecttasks?$filter=_msdyn_project_value eq ${projectId}&$count=true`,
    bearer,
  );
  return { count: data["@odata.count"] ?? 0, truncated: false };
}

/** Check a specific task exists and has the expected field value. */
export async function verifyTaskField(
  taskId: string,
  field: string,
  bearer: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const data = await dvGet(
    `/msdyn_projecttasks(${taskId})?$select=${field}`,
    bearer,
  );
  return data[field];
}

/**
 * Read a task's checklist items directly from Dataverse (bypasses MCP).
 * NOTE: uses the same `_msdyn_projecttaskid_value` filter the tool relies on — a
 * 400 here is itself the signal that the inferred filter field is wrong
 * (docs/plans/50 §6).
 */
export async function verifyChecklist(
  taskId: string,
  bearer: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<{ id: string; title: string; completed: boolean }[]> {
  const data = await dvGet(
    `/msdyn_projectchecklists?$select=msdyn_projectchecklistid,msdyn_name,msdyn_projectchecklistcompleted&$filter=_msdyn_projecttaskid_value eq ${taskId}`,
    bearer,
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (data.value ?? []).map((c: any) => ({
    id: c.msdyn_projectchecklistid,
    title: c.msdyn_name ?? "",
    completed: c.msdyn_projectchecklistcompleted === true,
  }));
}

/** Confirm a task no longer exists (returns true if deleted). */
export async function verifyTaskDeleted(taskId: string, bearer: string): Promise<boolean> {
  const base = getConfig().DATAVERSE_ORG_URL + "/api/data/v9.2";
  const res = await fetch(
    `${base}/msdyn_projecttasks(${taskId})?$select=msdyn_projecttaskid`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${bearer}`,
        "OData-MaxVersion": "4.0",
        "OData-Version": "4.0",
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(30_000),
    },
  );
  return res.status === 404;
}

/**
 * Verify that a project plan exists in Dataverse.
 * Returns true if the plan is reachable (200), false if 404, throws on other errors.
 */
export async function verifyPlanExists(projectId: string, bearer: string): Promise<boolean> {
  const base = getConfig().DATAVERSE_ORG_URL + "/api/data/v9.2";
  const res = await fetch(
    `${base}/msdyn_projects(${projectId})?$select=msdyn_projectid`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${bearer}`,
        "OData-MaxVersion": "4.0",
        "OData-Version": "4.0",
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (res.status === 404) return false;
  if (res.status === 401) {
    throw new Error(
      `verifyPlanExists: 401 Unauthorized (token ${redact(bearer)} may be expired)`,
    );
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`verifyPlanExists HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  return true;
}

/**
 * Return tasks in a plan matching an OData $filter expression.
 * Paginates automatically (follows @odata.nextLink) — uses the same dvGet pattern
 * as the rest of this file. Does NOT import server-side pageAll.
 *
 * @param projectId   Dataverse project GUID (added to the filter automatically).
 * @param odataFilter Additional OData $filter fragment, e.g.
 *                    "msdyn_scheduledend lt 2026-06-01T00:00:00Z".
 *                    Combined with the project filter via " and ".
 * @param bearer      Delegated access token.
 */
export async function verifyTasksByFilter(
  projectId: string,
  odataFilter: string,
  bearer: string,
): Promise<{ count: number; taskIds: string[] }> {
  const cfg = getConfig();
  const base = cfg.DATAVERSE_ORG_URL + "/api/data/v9.2";
  const headers = {
    Authorization: `Bearer ${bearer}`,
    "OData-MaxVersion": "4.0",
    "OData-Version": "4.0",
    Accept: "application/json",
    Prefer: "odata.maxpagesize=1000",
  };

  const projectFilter = `_msdyn_project_value eq ${projectId}`;
  const combined = odataFilter
    ? `${projectFilter} and ${odataFilter}`
    : projectFilter;

  const taskIds: string[] = [];
  let url: string | null =
    `${base}/msdyn_projecttasks?$filter=${encodeURIComponent(combined)}&$select=msdyn_projecttaskid`;

  while (url) {
    const res = await fetch(url, { method: "GET", headers, signal: AbortSignal.timeout(30_000) });
    if (res.status === 401) throw new Error(`verifyTasksByFilter: 401 Unauthorized`);
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`verifyTasksByFilter HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = await res.json() as { value: { msdyn_projecttaskid: string }[]; "@odata.nextLink"?: string };
    for (const t of data.value ?? []) {
      taskIds.push(t.msdyn_projecttaskid);
    }
    url = data["@odata.nextLink"] ?? null;
  }

  return { count: taskIds.length, taskIds };
}

/**
 * Return the count of resource assignments on a specific task.
 * Used by write scenarios to verify assign/unassign operations.
 */
export async function verifyAssignmentCount(taskId: string, bearer: string): Promise<number> {
  const data = await dvGet(
    `/msdyn_resourceassignments?$filter=_msdyn_taskid_value eq ${taskId}&$count=true`,
    bearer,
  );
  return data["@odata.count"] ?? 0;
}

/**
 * Return the count of task dependencies for a project.
 * Used by write scenarios to verify dependency add/delete operations.
 */
export async function verifyDependencyCount(projectId: string, bearer: string): Promise<number> {
  const data = await dvGet(
    `/msdyn_projecttaskdependencies?$filter=_msdyn_project_value eq ${projectId}&$count=true`,
    bearer,
  );
  return data["@odata.count"] ?? 0;
}
