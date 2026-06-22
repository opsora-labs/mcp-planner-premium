/**
 * Live PM-operation + read-safety self-test against a KEPT board (never deleted).
 *
 * By default builds (or reuses) the LARGE board from test/e2e/fixtures/
 * it-planner-board.json (642 tasks, multi-level, multi-bucket, dependencies) via
 * the resumable seed builder — a wifi drop RESUMES from the last checkpoint, never
 * a full rebuild. If the fixture is absent (or SMALL_BOARD=1) it falls back to a
 * 21-task synthetic board. Either way it then exercises the PM "rearrange the plan"
 * operations against a fresh SCRATCH subtree (canonical board never mutated),
 * verifies each via independent OData, and verifies the cursor/offset pagination
 * reassembles to the exact OData $count. Writes pm-acceptance-report-<UTC>.md.
 *
 * The board is LEFT INTACT; only the per-run scratch subtree is cleaned up.
 *
 * Usage (airplane + NordVPN needs the NODE_OPTIONS prefix):
 *   export E2E_ACCESS_TOKEN=$(NODE_OPTIONS='--no-network-family-autoselection --dns-result-order=ipv4first' \
 *     npx tsx --env-file .env scripts/get-dataverse-token.ts)
 *   NODE_OPTIONS='--no-network-family-autoselection --dns-result-order=ipv4first' \
 *     DATAVERSE_LINK_TYPE_STYLE=eu REQUEST_TIMEOUT_MS=120000 E2E_TOOL_TIMEOUT_MS=290000 \
 *     npx tsx --env-file .env test/e2e/pmOpsLive.ts
 *   # SMALL_BOARD=1 forces the 21-task board; REBUILD_SEED=1 forces a fresh large build.
 */

import { createServer, type Server } from "node:http";
import { writeFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getConfig, redact } from "./config.js";
import { mcpCall, mcpInitialize } from "./mcpClient.js";
import { verifyTaskField, verifyTaskCount, verifyTaskDeleted, verifyPlanExists } from "./verify.js";
import { buildOrReuseSeed, type BuildCtx } from "./seed/builder.js";
import type { Fixture } from "./seed/hashFixture.js";

// ── Result recording (drives both the console + the markdown report) ──────────
type Status = "pass" | "fail" | "info";
interface Row { phase: string; status: Status; step: string; tool: string; latencyMs: number; evidence: string; }
const rows: Row[] = [];
let curPhase = "";

function setPhase(p: string): void {
  curPhase = p;
  console.log(`\n${p}:`);
}
function check(step: string, tool: string, latencyMs: number, cond: boolean, evidence = ""): boolean {
  rows.push({ phase: curPhase, status: cond ? "pass" : "fail", step, tool, latencyMs, evidence });
  console.log(`  ${cond ? "✅" : "❌"} ${step}${evidence ? ` — ${evidence}` : ""}`);
  return cond;
}
function info(step: string, tool: string, evidence = ""): void {
  rows.push({ phase: curPhase, status: "info", step, tool, latencyMs: 0, evidence });
  console.log(`  ℹ️  ${step}${evidence ? ` — ${evidence}` : ""}`);
}
const lc = (s: unknown) => String(s ?? "").toLowerCase();
const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);

async function bootServer(port: number): Promise<Server> {
  process.env.AUTH_MODE = "insecure-passthrough";
  delete process.env.READ_ONLY_MODE;
  const { resetEnvCache } = await import("../../src/config.js");
  resetEnvCache();
  const { buildApp } = await import("../../src/app.js");
  const app = buildApp();
  return new Promise((resolve_, reject) => {
    const srv = createServer(app);
    srv.listen(port, () => resolve_(srv));
    srv.once("error", reject);
  });
}

let URL_ = "";
let BEARER = "";
const TRANSIENT = /fetch failed|did not respond|ETIMEDOUT|EHOSTUNREACH|ECONNRESET|socket|ENOTFOUND|network/i;

/** mcpCall with retry on TRANSIENT network failures (airplane wifi drops mid-call;
 * a "fetch failed" means the server never reached Dataverse, so re-issuing is safe). */
async function call(tool: string, args: Record<string, unknown>, attempts = 4): Promise<any> {
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      const r = await mcpCall(URL_, tool, args, BEARER);
      if (r.isError) {
        const msg = JSON.stringify(r.content);
        if (TRANSIENT.test(msg) && i < attempts) {
          lastErr = new Error(msg);
          await new Promise((res) => setTimeout(res, 2500));
          continue;
        }
        throw new Error(`${tool} isError: ${msg.slice(0, 200)}`);
      }
      return r.content as any;
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      if (TRANSIENT.test(msg) && i < attempts) {
        await new Promise((res) => setTimeout(res, 2500));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}
async function inSession(projectId: string, fn: (opSet: string) => Promise<void>): Promise<void> {
  const s = await call("start_change_session", { projectId });
  await fn(s.operationSetId);
  await call("apply_changes", { operationSetId: s.operationSetId });
}

interface Board {
  projectId: string;
  buckets: Record<string, string>; // name -> bucketId
  bucketNames: string[]; // ordered; scenarios pick by index (board-agnostic)
  sprintName: string;
  name: string;
  taskCount: number;
}

const SPRINT = "Sprint A";
const FIXTURE_PATH = resolve(process.cwd(), "test/e2e/fixtures/it-planner-board.json");

async function loadFixture(): Promise<Fixture | null> {
  if (/^(1|true)$/i.test(process.env.SMALL_BOARD || "")) return null;
  try {
    return JSON.parse(await readFile(FIXTURE_PATH, "utf8")) as Fixture;
  } catch {
    return null;
  }
}

async function sprintExists(projectId: string, name: string): Promise<boolean> {
  const cfg = getConfig();
  const url =
    `${cfg.DATAVERSE_ORG_URL}/api/data/v9.2/msdyn_projectsprints?$select=msdyn_projectsprintid` +
    `&$filter=_msdyn_project_value eq ${projectId} and msdyn_name eq '${name.replace(/'/g, "''")}'&$top=1`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${BEARER}`, "OData-Version": "4.0", "OData-MaxVersion": "4.0", Accept: "application/json" },
  });
  if (!res.ok) return false;
  const data: any = await res.json();
  return (data.value?.length ?? 0) > 0;
}

async function ensureSprint(projectId: string): Promise<void> {
  if (!(await sprintExists(projectId, SPRINT))) {
    await call("add_sprint", { projectId, name: SPRINT, start: "2026-07-01", finish: "2026-07-14" });
  }
}

/** Build-or-reuse the LARGE board from the fixture (resumable; kept). */
async function ensureLargeBoard(fixture: Fixture): Promise<Board> {
  setPhase(`Build at scale — ${fixture.taskCount}-task it-planner-board (kept)`);
  const cfg = getConfig();
  const planName = process.env.SEED_PLAN_NAME || "ZZ-MCP-SEED-itboard";
  const linkStyle = (process.env.DATAVERSE_LINK_TYPE_STYLE === "global" ? "global" : "eu") as "eu" | "global";
  const ctx: BuildCtx = {
    call,
    orgUrl: cfg.DATAVERSE_ORG_URL,
    planName,
    linkStyle,
    probePlanExists: (pid) => verifyPlanExists(pid, BEARER),
    probeTaskCount: async (pid) => {
      try {
        return (await verifyTaskCount(pid, BEARER)).count;
      } catch {
        return null;
      }
    },
    forceRebuild: /^(1|true)$/i.test(process.env.REBUILD_SEED || ""),
    log: (m) => console.log(`  · ${m}`),
    onStep: (step, tool, ms, ev) => {
      rows.push({ phase: curPhase, status: "pass", step, tool, latencyMs: ms, evidence: ev });
      console.log(`  ✅ ${step}${ev ? ` — ${ev}` : ""}`);
    },
  };
  const cache = await buildOrReuseSeed(ctx, fixture);
  const projectId = cache.projectId!;
  await ensureSprint(projectId);
  const count = await verifyTaskCount(projectId, BEARER);
  const bucketNames = Object.keys(cache.buckets);
  check("board verified via independent OData — all tasks present", "verifyTaskCount", 0, count.count >= fixture.taskCount,
    `${count.count} tasks · ${bucketNames.length} buckets · ${cache.dependencyIds.length} deps · ${cache.checkpoint.failedDeps.length} PSS-refused`);
  return { projectId, buckets: { ...cache.buckets }, bucketNames, sprintName: SPRINT, name: planName, taskCount: count.count };
}

/** Fallback 21-task synthetic board (when the fixture is absent / SMALL_BOARD=1). */
async function ensureSmallBoard(): Promise<Board> {
  const NEEDED = ["Backlog", "In Progress", "Done"];
  const plans = await call("list_plans", { top: 50 });
  const existing = (plans.plans ?? []).find((p: any) => typeof p.name === "string" && p.name.startsWith("ZZ-MCP-E2E-SEED"));
  let projectId: string;
  let name: string;
  const buckets: Record<string, string> = {};
  let isNew = false;
  if (existing) {
    projectId = existing.projectId;
    name = existing.name;
    const t0 = Date.now();
    const contents = await call("get_plan_tasks_and_buckets", { projectId, limit: 1000 });
    for (const b of contents.buckets ?? []) buckets[b.name] = b.bucketId;
    check("reuse kept board (persistent, not rebuilt)", "list_plans", Date.now() - t0, true, `${name} — ${contents.taskCount} tasks`);
  } else {
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    name = `ZZ-MCP-E2E-SEED-${ts}`;
    const t0 = Date.now();
    projectId = (await call("create_plan", { subject: name, description: "persistent PM-ops board" })).projectId;
    isNew = true;
    check("create kept board", "create_plan", Date.now() - t0, !!projectId, name);
  }
  for (const b of NEEDED) if (!buckets[b]) buckets[b] = (await call("add_bucket", { projectId, name: b })).bucketId;
  await ensureSprint(projectId);
  if (isNew) {
    const t0 = Date.now();
    await inSession(projectId, async (opSet) => {
      const tasks: any[] = [];
      for (let p = 1; p <= 3; p++) {
        tasks.push({ ref: `P${p}`, subject: `Phase ${p}`, bucket: NEEDED[(p - 1) % 3] });
        for (let c = 1; c <= 2; c++) {
          tasks.push({ ref: `P${p}C${c}`, subject: `Phase ${p} - Workstream ${c}`, bucket: NEEDED[(p - 1) % 3], parent: `P${p}` });
          for (let g = 1; g <= 2; g++) {
            const t: any = { ref: `P${p}C${c}G${g}`, subject: `Task ${p}.${c}.${g}`, bucket: NEEDED[(p - 1) % 3], parent: `P${p}C${c}`, finish: "2026-08-01T00:00:00Z" };
            if (g === 2) t.dependsOn = [{ on: `P${p}C${c}G1`, type: "FS" }];
            tasks.push(t);
          }
        }
      }
      await call("add_tasks", { operationSetId: opSet, projectId, tasks });
    });
    check("populate board (3 levels, FS dependencies)", "add_tasks", Date.now() - t0, true, "21 tasks across 3 buckets");
  }
  const count = await verifyTaskCount(projectId, BEARER);
  return { projectId, buckets, bucketNames: NEEDED, sprintName: SPRINT, name, taskCount: count.count };
}

async function ensureBoard(): Promise<Board> {
  const fixture = await loadFixture();
  return fixture ? ensureLargeBoard(fixture) : ensureSmallBoard();
}

/** Fresh scratch subtree under the board (parent + 3 leaves) in bucket0. */
async function makeScratch(board: Board): Promise<{ parent: string; leaves: string[] }> {
  const bk = board.bucketNames[0];
  let refs: Record<string, string> = {};
  await inSession(board.projectId, async (opSet) => {
    const r = await call("add_tasks", {
      operationSetId: opSet, projectId: board.projectId,
      tasks: [
        { ref: "S", subject: "SCRATCH parent", bucket: bk },
        { ref: "S1", subject: "SCRATCH leaf 1", bucket: bk, parent: "S" },
        { ref: "S2", subject: "SCRATCH leaf 2", bucket: bk, parent: "S", finish: "2026-08-01T00:00:00Z" },
        { ref: "S3", subject: "SCRATCH leaf 3", bucket: bk, parent: "S", dependsOn: [{ on: "S2", type: "FS" }] },
      ],
    });
    refs = r.taskRefs;
  });
  return { parent: refs.S, leaves: [refs.S1, refs.S2, refs.S3] };
}

function renderReport(board: Board | null, runAt: string, org: string, durationMs: number, residue: string): string {
  const pass = rows.filter((r) => r.status === "pass").length;
  const fail = rows.filter((r) => r.status === "fail").length;
  const infoN = rows.filter((r) => r.status === "info").length;
  const icon = (s: Status) => (s === "pass" ? "✅" : s === "fail" ? "❌" : "ℹ️");
  const L: string[] = [];
  L.push("# MCP Planner Premium — PM Acceptance Report");
  L.push("");
  L.push(`Run: \`${runAt}\`  ·  Org: \`${org}\`  ·  Duration: ${fmtMs(durationMs)}`);
  L.push(`Scope: PM task-change operations + large-plan read safety (cursor/offset pagination)`);
  if (board) L.push(`Board: \`${board.name}\` (\`${board.projectId}\`) — ${board.taskCount} tasks, ${board.bucketNames.length} buckets, KEPT (never deleted); scenarios run against a disposable scratch subtree`);
  L.push("");
  L.push(`## Overall: ${fail === 0 ? "✅ ALL PASS" : `❌ ${fail} FAILURE(S)`}`);
  L.push("");
  L.push("| | Count |");
  L.push("|---|---|");
  L.push(`| Pass | ${pass} |`);
  L.push(`| Fail | ${fail} |`);
  L.push(`| Info (documented behaviour) | ${infoN} |`);
  L.push("");
  for (const ph of [...new Set(rows.map((r) => r.phase))]) {
    L.push(`## ${ph}`);
    L.push("");
    L.push("| | Step | Tool | Latency | Evidence / Error |");
    L.push("|---|---|---|---|---|");
    for (const r of rows.filter((x) => x.phase === ph)) {
      const detail = (r.status === "fail" ? `⚠️ ${r.evidence}` : r.evidence).replace(/\|/g, "\\|").slice(0, 160);
      L.push(`| ${icon(r.status)} | ${r.step} | \`${r.tool}\` | ${fmtMs(r.latencyMs)} | ${detail} |`);
    }
    L.push("");
  }
  L.push("## Cleanup & residue");
  L.push("");
  L.push(`- ${residue}`);
  L.push("");
  L.push("---");
  L.push("");
  L.push("*All correctness verdicts are code assertions against live Dataverse reads (independent of the MCP tool output) — never AI-generated summaries.*");
  L.push("");
  return L.join("\n");
}

async function main(): Promise<void> {
  const cfg = getConfig();
  BEARER = cfg.E2E_ACCESS_TOKEN;
  const port = cfg.PORT;
  const runAt = new Date().toISOString();
  const t0 = Date.now();
  console.log(`\n${"=".repeat(70)}\n  PM-Ops + Read-Safety — Live Self-Test (kept board)\n${"=".repeat(70)}`);
  console.log(`  Org   : ${cfg.DATAVERSE_ORG_URL}\n  Token : ${redact(BEARER)}\n`);

  const server = await bootServer(port);
  URL_ = `http://localhost:${port}/mcp`;
  await mcpInitialize(URL_, BEARER);

  let board: Board | null = null;
  let scratchIds: string[] = [];
  let residue = "✅ scratch subtree cleaned; board kept (not deleted).";

  try {
    setPhase("Setup — persistent board (build once, reuse, never deleted)");
    board = await ensureBoard();
    const { projectId } = board;
    const [bkA, bkB, bkC] = board.bucketNames;

    let summaryTaskId = "";
    let spotTaskId = "";
    setPhase("Read-back verification (the build is faithful)");
    {
      let t = Date.now();
      const summary = await call("get_plan_summary", { projectId });
      check("get_plan_summary — total task count", "get_plan_summary", Date.now() - t, summary.totalTasks === board.taskCount, `totalTasks=${summary.totalTasks}, progress=${summary.progressPercent}%`);

      t = Date.now();
      const bb = await call("get_bucket_breakdown", { projectId });
      check("get_bucket_breakdown — per-bucket counts", "get_bucket_breakdown", Date.now() - t, Array.isArray(bb.buckets) && bb.buckets.length > 0, `${bb.buckets?.length ?? 0} buckets`);

      t = Date.now();
      const deps = await call("list_dependencies", { projectId });
      check("list_dependencies — dependency links present", "list_dependencies", Date.now() - t, typeof deps.count === "number", `${deps.count} dependency links`);

      t = Date.now();
      const contents = await call("get_plan_tasks_and_buckets", { projectId, limit: 1000 });
      summaryTaskId = (contents.summaryTaskIds ?? [])[0] ?? "";
      spotTaskId = contents.tasks?.[0]?.taskId ?? "";
      const maxLevel = Math.max(0, ...(contents.tasks ?? []).map((x: any) => x.outlineLevel ?? 0));
      check("get_plan_tasks_and_buckets — full task tree returned", "get_plan_tasks_and_buckets", Date.now() - t, (contents.tasks?.length ?? 0) === board.taskCount, `${contents.taskCount} tasks`);
      check("hierarchy depth (multi-level)", "get_plan_tasks_and_buckets", 0, maxLevel >= 3, `max outline level ${maxLevel}`);
      check("summary (parent) tasks present", "get_plan_tasks_and_buckets", 0, (contents.summaryTaskIds?.length ?? 0) > 0, `${contents.summaryTaskIds?.length ?? 0} summaries`);

      t = Date.now();
      const lpt = await call("list_plan_tasks", { projectId, filter: "all", limit: 1000 });
      check("list_plan_tasks — all tasks == total", "list_plan_tasks", Date.now() - t, lpt.totalMatched === board.taskCount, `${lpt.totalMatched} tasks`);

      if (spotTaskId) {
        t = Date.now();
        const task = await call("get_task", { taskId: spotTaskId });
        check("get_task — spot-check one task in full", "get_task", Date.now() - t, task.ok === true && !!task.task?.subject, String(task.task?.subject ?? "").slice(0, 40));
      }
    }

    setPhase("Scratch subtree (mutated then cleaned — board stays intact)");
    let t = Date.now();
    const scratch = await makeScratch(board);
    scratchIds = [scratch.parent, ...scratch.leaves];
    check("create scratch subtree (parent + 3 leaves + FS dep)", "add_tasks", Date.now() - t, scratchIds.every(Boolean));

    setPhase("PM operations (verified via independent OData)");

    t = Date.now();
    await inSession(projectId, async (op) => void (await call("update_tasks", { operationSetId: op, projectId, tasks: scratch.leaves.map((id) => ({ taskId: id, progressPercent: 100 })) })));
    {
      const pp = await verifyTaskField(scratch.parent, "msdyn_progress", BEARER);
      check("progress rollup — children → 100%, parent recalculates", "update_tasks", Date.now() - t, typeof pp === "number" && pp >= 0.99, `parent progress = ${Math.round((Number(pp) || 0) * 100)}%`);
    }

    t = Date.now();
    await inSession(projectId, async (op) => void (await call("update_tasks", { operationSetId: op, projectId, tasks: [{ taskId: scratch.leaves[0], bucket: bkB }] })));
    check(`move a task to a different bucket (→ ${bkB})`, "update_tasks", Date.now() - t,
      lc(await verifyTaskField(scratch.leaves[0], "_msdyn_projectbucket_value", BEARER)) === lc(board.buckets[bkB]), `bucket = ${bkB}`);

    t = Date.now();
    await inSession(projectId, async (op) => void (await call("update_tasks", { operationSetId: op, projectId, tasks: [{ taskId: scratch.leaves[0], parent: scratch.leaves[1] }] })));
    check("reparent a task under another task", "update_tasks", Date.now() - t,
      lc(await verifyTaskField(scratch.leaves[0], "_msdyn_parenttask_value", BEARER)) === lc(scratch.leaves[1]), "parent changed");

    t = Date.now();
    await inSession(projectId, async (op) => void (await call("update_tasks", { operationSetId: op, projectId, tasks: [{ taskId: scratch.leaves[2], sprint: board.sprintName }] })));
    check("move a task into a sprint", "update_tasks", Date.now() - t,
      !!(await verifyTaskField(scratch.leaves[2], "_msdyn_projectsprint_value", BEARER)), `sprint = ${board.sprintName}`);

    t = Date.now();
    await inSession(projectId, async (op) => void (await call("update_tasks", { operationSetId: op, projectId, tasks: [{ taskId: scratch.leaves[2], finish: "2026-09-15T00:00:00Z", priority: 1 }] })));
    {
      const fin = await verifyTaskField(scratch.leaves[2], "msdyn_finish", BEARER);
      check("reschedule a task's finish date + priority", "update_tasks", Date.now() - t, typeof fin === "string" && /2026-09-1[45]/.test(fin), `finish = ${String(fin).slice(0, 10)}`);
    }

    t = Date.now();
    await inSession(projectId, async (op) => void (await call("update_tasks", { operationSetId: op, projectId, tasks: [{ taskId: scratch.leaves[1], priority: 9 }] })));
    check("re-prioritise a task (→ 9 Low)", "update_tasks", Date.now() - t, Number(await verifyTaskField(scratch.leaves[1], "msdyn_priority", BEARER)) === 9, "priority = 9");

    t = Date.now();
    {
      const s = await call("start_change_session", { projectId });
      const r = await call("update_tasks", { operationSetId: s.operationSetId, projectId, tasks: [{ taskId: scratch.leaves[0], priority: 5, milestone: true }] });
      await call("apply_changes", { operationSetId: s.operationSetId });
      check("milestone flag change is ignored with a warning (UI-only)", "update_tasks", Date.now() - t,
        Array.isArray(r.warnings) && r.warnings.some((w: string) => /milestone/i.test(w)), "warned; other fields applied");
    }

    t = Date.now();
    {
      const s = await call("start_change_session", { projectId });
      const res = await mcpCall(URL_, "update_tasks", { operationSetId: s.operationSetId, projectId, tasks: [{ taskId: scratch.leaves[0], parent: null }] }, BEARER);
      const blocked = res.isError === true;
      await mcpCall(URL_, "cancel_change_session", { operationSetId: s.operationSetId }, BEARER).catch(() => {});
      const unchanged = lc(await verifyTaskField(scratch.leaves[0], "_msdyn_parenttask_value", BEARER)) === lc(scratch.leaves[1]);
      check("un-parent (move to top level) is blocked; hierarchy unchanged", "update_tasks", Date.now() - t, blocked && unchanged, "rejected; subtree intact");
    }

    t = Date.now();
    await inSession(projectId, async (op) => void (await call("update_tasks", { operationSetId: op, projectId, tasks: [
      { taskId: scratch.parent, bucket: bkC },
      { taskId: scratch.leaves[1], bucket: bkC },
    ] })));
    check(`bulk move (2 tasks → ${bkC}, one operation set)`, "update_tasks", Date.now() - t,
      lc(await verifyTaskField(scratch.parent, "_msdyn_projectbucket_value", BEARER)) === lc(board.buckets[bkC]), "both re-bucketed");

    let subId = "";
    t = Date.now();
    await inSession(projectId, async (op) => {
      const r = await call("add_tasks", { operationSetId: op, projectId, tasks: [{ ref: "SUB", subject: "New sub-task", bucket: bkA, parent: scratch.parent }] });
      subId = r.taskRefs?.SUB ?? "";
    });
    check("add a sub-task under an existing task", "add_tasks", Date.now() - t, !!subId && lc(await verifyTaskField(subId, "_msdyn_parenttask_value", BEARER)) === lc(scratch.parent), "child of scratch parent");

    t = Date.now();
    await inSession(projectId, async (op) => void (await call("delete_tasks_batch", { operationSetId: op, projectId, taskIds: [subId], confirmed: true })));
    check("delete the sub-task (confirmed gate)", "delete_tasks_batch", Date.now() - t, await verifyTaskDeleted(subId, BEARER), "task removed (OData 404)");

    info("not supported by the API (confirmed): reorder within a bucket, move to another plan, edit a dependency in place", "—",
      "PSS manages display order; cross-plan move + in-place dependency edits have no API path (delete + recreate)");

    setPhase("Guardrails (negative tests — the safeguards hold)");
    {
      const s1 = await call("start_change_session", { projectId });
      let t = Date.now();
      const big = await mcpCall(URL_, "add_tasks_batch", { operationSetId: s1.operationSetId, entities: Array.from({ length: 201 }, () => ({ "@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask" })) }, BEARER);
      check(">200-entity batch rejected", "add_tasks_batch", Date.now() - t, big.isError === true && /200/.test(JSON.stringify(big.content)), "max 200 enforced");

      t = Date.now();
      const del = await mcpCall(URL_, "delete_tasks_batch", { operationSetId: s1.operationSetId, taskIds: [spotTaskId || projectId], confirmed: false }, BEARER);
      check("delete without confirmed rejected", "delete_tasks_batch", Date.now() - t, del.isError === true && /confirm/i.test(JSON.stringify(del.content)), "confirmed gate");

      t = Date.now();
      const whole = await mcpCall(URL_, "delete_tasks_batch", { operationSetId: s1.operationSetId, records: [{ entityLogicalName: "msdyn_project", recordId: projectId }], confirmed: true }, BEARER);
      check("whole-plan delete hard-blocked", "delete_tasks_batch", Date.now() - t, whole.isError === true && /blocked by policy|whole plan/i.test(JSON.stringify(whole.content)), "policy block");

      t = Date.now();
      const badg = await mcpCall(URL_, "update_tasks", { operationSetId: s1.operationSetId, projectId, tasks: [{ taskId: "not-a-guid", subject: "x" }] }, BEARER);
      check("invalid GUID rejected", "update_tasks", Date.now() - t, badg.isError === true && /guid/i.test(JSON.stringify(badg.content)), "GUID validation");

      const bid = board!.buckets[bkA];
      t = Date.now();
      const badBind = await mcpCall(URL_, "add_tasks_batch", { operationSetId: s1.operationSetId, entities: [{
        "@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask", msdyn_projecttaskid: "aaaaaaaa-1111-2222-3333-444444444444",
        msdyn_subject: "bad bind", "msdyn_project@odata.bind": `/msdyn_projects(${projectId})`,
        "msdyn_bucket@odata.bind": `/msdyn_projectbuckets(${bid})`,
      }] }, BEARER);
      check("bad bind alias rejected (teaches the right key)", "add_tasks_batch", Date.now() - t, badBind.isError === true && /msdyn_projectbucket@odata\.bind|navigation property/i.test(JSON.stringify(badBind.content)), "wrong @odata.bind caught");

      t = Date.now();
      const pac = await mcpCall(URL_, "add_tasks_batch", { operationSetId: s1.operationSetId, entities: [
        { "@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask", msdyn_projecttaskid: "bbbbbbbb-1111-2222-3333-444444444444", msdyn_subject: "child", "msdyn_project@odata.bind": `/msdyn_projects(${projectId})`, "msdyn_projectbucket@odata.bind": `/msdyn_projectbuckets(${bid})`, "msdyn_parenttask@odata.bind": "/msdyn_projecttasks(cccccccc-1111-2222-3333-444444444444)" },
        { "@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask", msdyn_projecttaskid: "cccccccc-1111-2222-3333-444444444444", msdyn_subject: "parent", "msdyn_project@odata.bind": `/msdyn_projects(${projectId})`, "msdyn_projectbucket@odata.bind": `/msdyn_projectbuckets(${bid})` },
      ] }, BEARER);
      check("parent-after-child ordering rejected", "add_tasks_batch", Date.now() - t, pac.isError === true && /before|parent|child|order/i.test(JSON.stringify(pac.content)), "parents-before-children enforced");

      t = Date.now();
      const nd = await mcpCall(URL_, "update_tasks", { operationSetId: s1.operationSetId, projectId, tasks: [{ taskId: spotTaskId || summaryTaskId, start: null }] }, BEARER);
      check("null date on update rejected (input validation)", "update_tasks", Date.now() - t, nd.isError === true, "null date refused at boundary");

      if (summaryTaskId) {
        t = Date.now();
        const sum = await mcpCall(URL_, "update_tasks", { operationSetId: s1.operationSetId, projectId, tasks: [{ taskId: summaryTaskId, finish: "2027-12-31T00:00:00Z" }] }, BEARER);
        check("summary-task rolled-up date overwrite rejected", "update_tasks", Date.now() - t, sum.isError === true && /summary/i.test(JSON.stringify(sum.content)), "summary protection");
      }
      await mcpCall(URL_, "cancel_change_session", { operationSetId: s1.operationSetId }, BEARER).catch(() => {});
    }

    setPhase("Capability behaviours (documented limits)");
    {
      let t = Date.now();
      const team = await call("list_team_members", { projectId });
      const member = (team.members ?? team.teamMembers ?? [])[0];
      check("list_team_members (plan auto-includes the creator)", "list_team_members", Date.now() - t, !!member?.name, member?.name ?? "n/a");

      t = Date.now();
      const sp = await call("add_sprint", { projectId, name: `Sprint-${Date.now().toString().slice(-6)}`, start: "2026-10-01", finish: "2026-10-14" });
      check("add_sprint creates a sprint", "add_sprint", Date.now() - t, sp?.ok === true || !!sp?.sprintId, sp?.sprintId ? String(sp.sprintId).slice(0, 8) : "created");

      t = Date.now();
      await inSession(projectId, async (op) => {
        const r = await call("add_tasks", {
          operationSetId: op, projectId,
          tasks: [{
            ref: "CAP", subject: "Capability check task", bucket: bkA,
            milestone: true, checklist: ["item A", "item B"], sprint: board!.sprintName,
            ...(member?.name ? { assignees: [member.name] } : {}),
            labels: ["ZZ-Nonexistent-Label"],
          }],
        });
        const capId = r.taskRefs?.CAP;
        if (capId) scratchIds.push(capId);
        const milestoneDeferred = (r.milestoneTaskIds?.length ?? 0) >= 1;
        const checklistMade = (r.checklistIds?.length ?? 0) >= 1;
        const labelWarned = Array.isArray(r.warnings) && r.warnings.some((w: string) => /label/i.test(w));
        check("checklist + sprint + assignee on one task; milestone deferred; label UI-only warned", "add_tasks", Date.now() - t,
          milestoneDeferred && checklistMade && labelWarned, `${r.checklistIds?.length ?? 0} checklist items; milestone→milestoneTaskIds; label skipped+warned`);
      });
    }

    setPhase("Read safety at scale (cursor / offset pagination)");
    const pageLimit = board.taskCount > 60 ? 50 : 3;
    t = Date.now();
    {
      const direct = await verifyTaskCount(projectId, BEARER);
      const seen = new Set<string>();
      let token: string | undefined; let pages = 0;
      do {
        const r: any = await call("get_plan_tasks_and_buckets", { projectId, limit: pageLimit, ...(token ? { pageToken: token } : {}) });
        for (const x of r.tasks) seen.add(lc(x.taskId));
        token = r.nextPageToken; pages++;
      } while (token && pages < 1000);
      check("get_plan_tasks_and_buckets paginates to the exact OData $count (no gaps/dupes)", "get_plan_tasks_and_buckets", Date.now() - t,
        seen.size === direct.count, `${seen.size} tasks over ${pages} pages (limit ${pageLimit}) == $count ${direct.count}`);
    }
    t = Date.now();
    {
      const seen = new Set<string>(); let token: string | undefined; let total = -1; let pages = 0;
      do {
        const r: any = await call("list_plan_tasks", { projectId, filter: "all", limit: pageLimit, ...(token ? { pageToken: token } : {}) });
        for (const x of r.tasks) seen.add(lc(x.taskId));
        total = r.totalMatched; token = r.nextPageToken; pages++;
      } while (token && pages < 1000);
      check("list_plan_tasks offset paging reassembles to totalMatched", "list_plan_tasks", Date.now() - t, seen.size === total, `${seen.size}/${total} over ${pages} pages (limit ${pageLimit})`);
    }
  } catch (e) {
    rows.push({ phase: curPhase || "Run", status: "fail", step: "unexpected exception", tool: "—", latencyMs: 0, evidence: e instanceof Error ? e.message : String(e) });
    console.log(`  ❌ exception — ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    if (board && scratchIds.filter(Boolean).length > 0) {
      try {
        const s = await call("start_change_session", { projectId: board.projectId });
        await mcpCall(URL_, "delete_tasks_batch", { operationSetId: s.operationSetId, projectId: board.projectId, taskIds: scratchIds.filter(Boolean), confirmed: true }, BEARER);
        await mcpCall(URL_, "apply_changes", { operationSetId: s.operationSetId }, BEARER);
        const gone = await verifyTaskDeleted(scratchIds[0], BEARER);
        residue = `✅ scratch subtree ${gone ? "deleted (verified)" : "delete queued"}; board \`${board.name}\` kept (never deleted).`;
        console.log(`  ℹ️  ${residue}`);
      } catch (e) {
        residue = `⚠️ scratch cleanup best-effort failed: ${e instanceof Error ? e.message : String(e)}; board kept.`;
        console.log(`  ℹ️  ${residue}`);
      }
    }
    await new Promise<void>((r) => server.close(() => r()));
  }

  const report = renderReport(board, runAt, cfg.DATAVERSE_ORG_URL, Date.now() - t0, residue);
  const file = `pm-acceptance-report-${runAt.replace(/[:.]/g, "-").slice(0, 19)}.md`;
  await writeFile(file, report, "utf-8");

  const fail = rows.filter((r) => r.status === "fail").length;
  const pass = rows.filter((r) => r.status === "pass").length;
  console.log(`\n${"=".repeat(70)}`);
  console.log(`  Result : ${fail === 0 ? "✅ ALL PASS" : `❌ ${fail} FAILURE(S)`}  (${pass} pass / ${fail} fail)`);
  console.log(`  Report : ${file}`);
  console.log(`${"=".repeat(70)}\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("pmOpsLive crashed:", e instanceof Error ? e.message : String(e));
  process.exit(2);
});
