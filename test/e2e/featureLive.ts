/**
 * Live feature self-test for the PM feature suite added on feat/pm-feature-suite.
 *
 * Proves the NEW tools work end-to-end against the real tenant via the real MCP
 * protocol, asserting against independent OData reads (verify.ts) — never the
 * tool's own output as its own oracle.
 *
 * Tiers:
 *   1. Read analytics (always): get_critical_path / get_schedule_health /
 *      get_resource_workload / list_plan_tasks extended fields, against an
 *      existing plan picked from list_plans. Read-only, fast, safe.
 *   2. READ_ONLY_MODE (always): a second server booted with READ_ONLY_MODE=true
 *      must advertise only the read-only tools and reject a write tool.
 *   3. Writes (only when E2E_ALLOW_WRITES=true): create a tiny plan, then exercise
 *      assign_task (assign+unassign+confirmed gate), sprint-on-update_tasks,
 *      checklist add/adjust/remove-on-update_tasks (+confirmed gate), and
 *      delete_tasks_batch dependency cascade — each verified via OData. The plan
 *      is kept on failure (PSS blocks whole-plan delete); tasks are cleaned up.
 *
 * Usage (airplane + NordVPN needs the NODE_OPTIONS prefix or fetch times out):
 *   export E2E_ACCESS_TOKEN=$(NODE_OPTIONS='--no-network-family-autoselection --dns-result-order=ipv4first' \
 *     npx tsx --env-file .env scripts/get-dataverse-token.ts)
 *   NODE_OPTIONS='--no-network-family-autoselection --dns-result-order=ipv4first' \
 *     DATAVERSE_ORG_URL=<org> [E2E_ALLOW_WRITES=true] npx tsx --env-file .env test/e2e/featureLive.ts
 */

import { createServer, type Server } from "node:http";
import { getConfig, redact } from "./config.js";
import { mcpCall, mcpInitialize, mcpToolNames } from "./mcpClient.js";
import {
  verifyAssignmentCount,
  verifyChecklist,
  verifyDependencyCount,
  verifyTaskDeleted,
  verifyTaskField,
} from "./verify.js";

let pass = 0;
let fail = 0;
const fails: string[] = [];

/** Masks a UPN/email for log output (PII): "marcin.b@opsora.io" → "ma***@opsora.io". */
function maskUpn(v: unknown): string {
  if (!v || typeof v !== "string") return "null";
  if (!v.includes("@")) return v.slice(0, 2) + "***";
  const [local, domain] = v.split("@");
  return local.slice(0, 2) + "***@" + domain;
}

function ok(cond: boolean, label: string, evidence = ""): boolean {
  if (cond) {
    pass++;
    console.log(`  ✅ ${label}${evidence ? ` — ${evidence}` : ""}`);
  } else {
    fail++;
    fails.push(label);
    console.log(`  ❌ ${label}${evidence ? ` — ${evidence}` : ""}`);
  }
  return cond;
}

async function bootServer(port: number, readOnly: boolean): Promise<Server> {
  process.env.AUTH_MODE = "insecure-passthrough";
  if (readOnly) process.env.READ_ONLY_MODE = "true";
  else delete process.env.READ_ONLY_MODE;
  const { resetEnvCache } = await import("../../src/config.js");
  resetEnvCache();
  const { buildApp } = await import("../../src/app.js");
  const app = buildApp();
  return new Promise((resolve, reject) => {
    const srv = createServer(app);
    srv.listen(port, () => resolve(srv));
    srv.once("error", reject);
  });
}

async function call(url: string, tool: string, args: Record<string, unknown>, bearer: string) {
  const r = await mcpCall(url, tool, args, bearer);
  if (r.isError) throw new Error(`${tool} returned isError: ${JSON.stringify(r.content).slice(0, 200)}`);
  return r.content as any;
}

async function main(): Promise<void> {
  const cfg = getConfig();
  const bearer = cfg.E2E_ACCESS_TOKEN;
  const port = cfg.PORT;
  console.log(`\n${"=".repeat(70)}\n  PM Feature Suite — Live Self-Test\n${"=".repeat(70)}`);
  console.log(`  Org    : ${cfg.DATAVERSE_ORG_URL}`);
  console.log(`  Token  : ${redact(bearer)}`);
  console.log(`  Writes : ${cfg.E2E_ALLOW_WRITES}\n`);

  const mainServer = await bootServer(port, false);
  const url = `http://localhost:${port}/mcp`;
  await mcpInitialize(url, bearer);

  try {
    // ── Tier 1: read analytics against an existing plan ───────────────────
    console.log("Tier 1 — read analytics (existing plan):");
    const plans = await call(url, "list_plans", { limit: 25 }, bearer);
    const list: any[] = plans.plans ?? plans.value ?? [];
    ok(Array.isArray(list) && list.length > 0, "list_plans returns at least one plan", `${list.length} plans`);

    // Find a plan that actually has tasks (so analytics are meaningful), probing
    // via get_schedule_health's totalTasks count. The recently-built board is near
    // the top (most-recently-modified first).
    let projectId = "";
    let totalTasks = 0;
    for (const p of list.slice(0, 12)) {
      const pid: string = p.projectId ?? p.planId ?? p.msdyn_projectid;
      if (!pid) continue;
      const probe = await call(url, "get_schedule_health", { projectId: pid }, bearer);
      if (probe?.ok === true && (probe.counts?.totalTasks ?? 0) > 0) {
        projectId = pid; totalTasks = probe.counts.totalTasks; break;
      }
    }
    if (!ok(projectId !== "", "found a non-empty plan to analyse", `${totalTasks} tasks`)) {
      console.log("  (no non-empty plan found in the first 12 — analytics shape checks skipped)");
    } else {
      const cp = await call(url, "get_critical_path", { projectId }, bearer);
      ok(cp?.ok === true && Array.isArray(cp.criticalPath),
        "get_critical_path → ok + criticalPath[]",
        `critical=${cp.criticalPath?.length ?? "?"}, finish=${cp.projectFinish ?? "null"}, total=${cp.totalDurationDays ?? "?"}d`);

      const sh = await call(url, "get_schedule_health", { projectId }, bearer);
      ok(sh?.ok === true && typeof sh.counts?.totalTasks === "number",
        "get_schedule_health → ok + counts",
        sh?.counts ? `total=${sh.counts.totalTasks}, overdue=${sh.counts.overdueLeafCount}, atRisk=${sh.counts.atRiskCount}, blocked=${sh.counts.blockedCount}` : "");

      const rw = await call(url, "get_resource_workload", { projectId }, bearer);
      ok(rw?.ok === true && Array.isArray(rw.members), "get_resource_workload → ok + members[]",
        `members=${rw.members?.length ?? "?"}`);

      const lpt = await call(url, "list_plan_tasks", { projectId }, bearer);
      // Extended fields (remainingEffortHours/durationHours/actualStart/Finish) are
      // present only on Project-Operations tenants; on a basic tenant they are
      // gracefully omitted with a warning. Either is correct — assert the tool
      // returns tasks and report which path the tenant took.
      const t0 = lpt.tasks?.[0];
      const extPresent = !!t0 && "remainingEffortHours" in t0;
      ok(lpt?.ok === true && Array.isArray(lpt.tasks) && lpt.tasks.length > 0,
        "list_plan_tasks → ok + tasks (extended fields when available)",
        `tasks=${lpt.tasks?.length ?? "?"}, extendedFields=${extPresent ? "present" : "absent (basic tenant, graceful)"}`);

      // ── Tier 1.5: project member info (UPN/email) + per-user tasks ──────────
      // Proves the flow "which tasks does <name> have?": list/find members with
      // UPN, search a name across plans, then read that person's tasks.
      console.log("\nTier 1.5 — project member info (UPN/email) + list_user_tasks:");
      const ltm = await call(url, "list_team_members", { projectId }, bearer);
      const members: any[] = ltm.members ?? [];
      const resolved = members.filter((m) => m.upn || m.email);
      ok(ltm?.ok === true && members.length > 0, "list_team_members → ok + members[]", `members=${members.length}`);
      // The headline check you asked for: member identity (UPN/email) is findable.
      ok(resolved.length > 0, "list_team_members resolves UPN/email for ≥1 member",
        `${resolved.length}/${members.length} resolved (e.g. ${maskUpn(resolved[0]?.upn ?? resolved[0]?.email)})`);

      const probe = resolved[0] ?? members[0];
      if (probe?.name) {
        const ftm = await call(url, "find_team_member", { projectId, name: probe.name }, bearer);
        const hit = (ftm.members ?? [])[0];
        ok(ftm?.ok === true && !!hit, "find_team_member resolves a name → member", `name="${probe.name}"`);
        ok(!!hit && "upn" in hit, "find_team_member result carries upn/email field",
          `upn=${maskUpn(hit?.upn ?? hit?.email)}`);

        const xplan = await call(url, "find_team_member_across_plans", { name: probe.name }, bearer);
        const person = (xplan.people ?? [])[0];
        ok(xplan?.ok === true && (xplan.people?.length ?? 0) > 0,
          "find_team_member_across_plans finds the person across plans",
          `people=${xplan.people?.length ?? 0}, plans=${person?.planCount ?? "?"}, upn=${maskUpn(person?.upn ?? person?.email)}`);
      }

      if (probe?.bookableResourceId) {
        const lut = await call(url, "list_user_tasks", { bookableResourceId: probe.bookableResourceId, filter: "active" }, bearer);
        ok(lut?.ok === true && Array.isArray(lut.tasks),
          "list_user_tasks → ok + tasks[] for that person",
          `count=${lut.count ?? "?"}${lut.note ? ` (note: ${lut.note})` : ""}`);
      }
    }
  } finally {
    await new Promise<void>((r) => mainServer.close(() => r()));
  }

  // ── Tier 2: READ_ONLY_MODE ──────────────────────────────────────────────
  console.log("\nTier 2 — READ_ONLY_MODE:");
  const roPort = port + 1;
  const roServer = await bootServer(roPort, true);
  const roUrl = `http://localhost:${roPort}/mcp`;
  try {
    await mcpInitialize(roUrl, bearer);
    const names = await mcpToolNames(roUrl, bearer);
    ok(names.length > 0 && !names.includes("add_tasks") && !names.includes("create_plan"),
      "read-only server hides write tools", `${names.length} tools advertised`);
    ok(names.includes("get_critical_path") && names.includes("list_plans"),
      "read-only server keeps read tools");
    ok(names.includes("list_user_tasks") && names.includes("find_team_member_across_plans"),
      "read-only server advertises the new member-info/user-task read tools");
    const blocked = await mcpCall(roUrl, "create_plan", { subject: "ZZ-should-be-blocked" }, bearer);
    ok(blocked.isError === true, "create_plan rejected under READ_ONLY_MODE",
      JSON.stringify(blocked.content).slice(0, 80));
  } finally {
    await new Promise<void>((r) => roServer.close(() => r()));
  }

  // ── Tier 3: write features (gated) ──────────────────────────────────────
  if (cfg.E2E_ALLOW_WRITES) {
    await runWriteTier(bearer, port);
  } else {
    console.log("\nTier 3 — write features: SKIPPED (set E2E_ALLOW_WRITES=true)");
  }

  console.log(`\n${"=".repeat(70)}`);
  console.log(`  Result: ${fail === 0 ? "✅ ALL PASS" : `❌ ${fail} FAILURE(S)`}  (${pass} pass / ${fail} fail)`);
  if (fail > 0) console.log(`  Failed: ${fails.join("; ")}`);
  console.log(`${"=".repeat(70)}\n`);
  process.exit(fail > 0 ? 1 : 0);
}

async function runWriteTier(bearer: string, port: number): Promise<void> {
  console.log("\nTier 3 — write features (live, E2E_ALLOW_WRITES=true):");
  const server = await bootServer(port, false);
  const url = `http://localhost:${port}/mcp`;
  await mcpInitialize(url, bearer);
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  // ZZ-MCP-E2E- prefix so scripts/cleanup-e2e-plans.ts sweeps it up too.
  const planName = `ZZ-MCP-E2E-FEAT-${ts}`;
  let projectId = "";
  const createdTaskIds: string[] = [];

  try {
    const plan = await call(url, "create_plan", { subject: planName, description: "feature live test" }, bearer);
    projectId = plan.projectId;
    ok(typeof projectId === "string" && projectId.length > 0, "create_plan", planName);

    const bkt = await call(url, "add_bucket", { projectId, name: "Sprint 1" }, bearer);
    ok(bkt?.ok === true && typeof bkt.bucketId === "string", "add_bucket", bkt?.bucketId?.slice(0, 8));

    // Add two leaf tasks with an FS dependency (T1 -> T2) for the cascade test.
    let s = await call(url, "start_change_session", { projectId, description: "add" }, bearer);
    const refs = await call(url, "add_tasks", {
      operationSetId: s.operationSetId, projectId,
      tasks: [
        { ref: "T1", subject: "Feature Task 1", bucket: "Sprint 1" },
        { ref: "T2", subject: "Feature Task 2", bucket: "Sprint 1", dependsOn: [{ on: "T1", type: "FS" }] },
      ],
    }, bearer);
    const t1 = refs.taskRefs?.T1 as string;
    const t2 = refs.taskRefs?.T2 as string;
    createdTaskIds.push(t1, t2);
    await call(url, "apply_changes", { operationSetId: s.operationSetId }, bearer);
    ok(!!t1 && !!t2, "add_tasks (2 tasks + FS dependency)", `T1=${t1?.slice(0, 8)} T2=${t2?.slice(0, 8)}`);

    const depCountBefore = await verifyDependencyCount(projectId, bearer);
    ok(depCountBefore >= 1, "OData: dependency created", `deps=${depCountBefore}`);

    // assign_task: assign the signed-in user (auto-added to the plan team).
    const members = await call(url, "list_team_members", { projectId }, bearer);
    const member = (members.members ?? members.teamMembers ?? [])[0];
    const memberRef: string = member?.name ?? member?.teamMemberId ?? member?.projectTeamId;
    if (ok(!!memberRef, "list_team_members returns a member", String(memberRef))) {
      s = await call(url, "start_change_session", { projectId, description: "assign" }, bearer);
      await call(url, "assign_task", { operationSetId: s.operationSetId, projectId, taskId: t1, assignees: [memberRef], mode: "assign" }, bearer);
      await call(url, "apply_changes", { operationSetId: s.operationSetId }, bearer);
      const asg = await verifyAssignmentCount(t1, bearer);
      ok(asg >= 1, "assign_task assign → OData assignment present", `assignments=${asg}`);

      // unassign requires confirmed=true (guardrail).
      const blocked = await mcpCall(url, "assign_task", { operationSetId: (await call(url, "start_change_session", { projectId }, bearer)).operationSetId, projectId, taskId: t1, assignees: [memberRef], mode: "unassign" }, bearer);
      ok(blocked.isError === true, "assign_task unassign without confirmed → rejected", JSON.stringify(blocked.content).slice(0, 70));

      s = await call(url, "start_change_session", { projectId, description: "unassign" }, bearer);
      await call(url, "assign_task", { operationSetId: s.operationSetId, projectId, taskId: t1, assignees: [memberRef], mode: "unassign", confirmed: true }, bearer);
      await call(url, "apply_changes", { operationSetId: s.operationSetId }, bearer);
      const asg2 = await verifyAssignmentCount(t1, bearer);
      ok(asg2 === 0, "assign_task unassign (confirmed) → OData assignment removed", `assignments=${asg2}`);
    }

    // sprint on update_tasks.
    const sprint = await call(url, "add_sprint", { projectId, name: "Sprint Live", start: "2026-07-01", finish: "2026-07-14" }, bearer);
    if (ok(!!sprint?.sprintId || sprint?.ok === true, "add_sprint")) {
      s = await call(url, "start_change_session", { projectId, description: "sprint" }, bearer);
      await call(url, "update_tasks", { operationSetId: s.operationSetId, projectId, tasks: [{ taskId: t1, sprint: "Sprint Live" }] }, bearer);
      await call(url, "apply_changes", { operationSetId: s.operationSetId }, bearer);
      const sprintVal = await verifyTaskField(t1, "_msdyn_projectsprint_value", bearer);
      ok(!!sprintVal, "update_tasks sprint → OData sprint lookup set", String(sprintVal).slice(0, 8));
    }

    // checklist add / adjust / remove via update_tasks (docs/plans/50).
    // Proves the two live-unproven assumptions: the checklist READ filter field
    // and PssUpdateV2 accepting a checklist edit.
    {
      // ADD two items on t1.
      s = await call(url, "start_change_session", { projectId, description: "checklist add" }, bearer);
      const added = await call(url, "update_tasks", {
        operationSetId: s.operationSetId, projectId,
        tasks: [{ taskId: t1, checklist: ["Chk A", { title: "Chk B", completed: false }] }],
      }, bearer);
      await call(url, "apply_changes", { operationSetId: s.operationSetId }, bearer);
      ok(added?.checklist?.added === 2, "update_tasks checklist add (2 items)", JSON.stringify(added?.checklist));
      let items = await verifyChecklist(t1, bearer);
      ok(items.length === 2, "OData: 2 checklist items present", `n=${items.length}`);

      // get_task surfaces the items with ids + completed state.
      const gt = await call(url, "get_task", { taskId: t1 }, bearer);
      ok(Array.isArray(gt.checklist) && gt.checklist.length === 2, "get_task returns checklist items", `n=${gt.checklist?.length}`);

      // ADJUST: tick "Chk A" complete (by match) and rename "Chk B" → "Chk B2".
      s = await call(url, "start_change_session", { projectId, description: "checklist adjust" }, bearer);
      await call(url, "update_tasks", {
        operationSetId: s.operationSetId, projectId,
        tasks: [{ taskId: t1, checklist: [
          { match: "Chk A", completed: true },
          { match: "Chk B", title: "Chk B2" },
        ] }],
      }, bearer);
      await call(url, "apply_changes", { operationSetId: s.operationSetId }, bearer);
      items = await verifyChecklist(t1, bearer);
      const chkA = items.find((i) => i.title === "Chk A");
      const chkB2 = items.find((i) => i.title === "Chk B2");
      ok(!!chkA?.completed, "PssUpdateV2 checklist adjust → 'Chk A' completed", JSON.stringify(chkA));
      ok(!!chkB2, "PssUpdateV2 checklist adjust → 'Chk B' renamed to 'Chk B2'", JSON.stringify(chkB2));

      // REMOVE requires confirmed:true — the gate must reject without it.
      const rmBlocked = await mcpCall(url, "update_tasks", {
        operationSetId: (await call(url, "start_change_session", { projectId }, bearer)).operationSetId,
        projectId, tasks: [{ taskId: t1, checklist: [{ match: "Chk A", remove: true }] }],
      }, bearer);
      ok(rmBlocked.isError === true, "checklist remove without confirmed → rejected", JSON.stringify(rmBlocked.content).slice(0, 70));

      s = await call(url, "start_change_session", { projectId, description: "checklist remove" }, bearer);
      await call(url, "update_tasks", {
        operationSetId: s.operationSetId, projectId, confirmed: true,
        tasks: [{ taskId: t1, checklist: [{ match: "Chk A", remove: true }] }],
      }, bearer);
      await call(url, "apply_changes", { operationSetId: s.operationSetId }, bearer);
      items = await verifyChecklist(t1, bearer);
      ok(items.length === 1 && items[0].title === "Chk B2", "checklist remove (confirmed) → only 'Chk B2' remains", `n=${items.length}`);
    }

    // dependency cascade-delete: delete T2 (successor) WITHOUT passing the dep id.
    s = await call(url, "start_change_session", { projectId, description: "cascade delete" }, bearer);
    await call(url, "delete_tasks_batch", { operationSetId: s.operationSetId, projectId, taskIds: [t2], confirmed: true }, bearer);
    await call(url, "apply_changes", { operationSetId: s.operationSetId }, bearer);
    const t2gone = await verifyTaskDeleted(t2, bearer);
    const depCountAfter = await verifyDependencyCount(projectId, bearer);
    ok(t2gone, "delete cascade → successor task deleted (OData 404)");
    ok(depCountAfter < depCountBefore, "delete cascade → dependency auto-removed", `deps ${depCountBefore}→${depCountAfter}`);
    createdTaskIds.splice(createdTaskIds.indexOf(t2), 1);
  } catch (e) {
    fail++;
    fails.push(`write tier threw: ${e instanceof Error ? e.message : String(e)}`);
    console.log(`  ❌ write tier exception — ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    // On full success, delete the whole test plan out-of-band — PSS blocks
    // in-tool whole-plan delete by policy, but a direct OData DELETE is allowed
    // for test cleanup (PSS-IMPLEMENTATION-LESSONS §4). On failure, keep it for
    // debugging (it is sweepable by scripts/cleanup-e2e-plans.ts).
    if (projectId && fail === 0) {
      try {
        const cfg = getConfig();
        await fetch(`${cfg.DATAVERSE_ORG_URL}/api/data/v9.2/msdyn_projects(${projectId})`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${bearer}`, "OData-Version": "4.0", "OData-MaxVersion": "4.0" },
        });
        console.log(`  ℹ️  deleted test plan "${planName}" (out-of-band whole-plan delete).`);
      } catch {
        console.log(`  ℹ️  plan "${planName}" left behind (out-of-band delete failed; sweep with cleanup-e2e-plans.ts).`);
      }
    } else if (projectId) {
      console.log(`  ℹ️  plan "${planName}" kept for debugging (failures present).`);
    }
    await new Promise<void>((r) => server.close(() => r()));
  }
}

main().catch((e) => {
  console.error("featureLive crashed:", e instanceof Error ? e.message : String(e));
  process.exit(2);
});
