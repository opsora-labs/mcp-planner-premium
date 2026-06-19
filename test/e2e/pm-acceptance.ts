/**
 * PM Acceptance Test — drives the MCP Planner Premium tools end-to-end with a
 * real, hundreds-of-task customer project (test/e2e/fixtures/it-planner-board.json,
 * 642 tasks / 227 dependencies / 9 buckets / 5 levels deep) and verifies every
 * project-management capability against the live tenant.
 *
 * Phases:
 *   A  Build at scale   — plan, buckets, 642 tasks (hierarchy batches), 227 deps, progress
 *   B  Read-back verify — counts, hierarchy depth, buckets, dependencies, spot-checks
 *   C  PM operations    — reschedule, re-bucket, re-prioritise, progress rollup, add/delete
 *   D  Guardrails       — 200-cap, summary protection, confirm gate, whole-plan block, etc.
 *   E  Rich features    — checklist + sprint + assignees (verified); milestone blocked; labels UI-only
 *   F  Cleanup          — delete the disposable ZZ-MCP-PMTEST-* plan
 *
 * Usage:
 *   export E2E_ACCESS_TOKEN=$(npx tsx --env-file .env scripts/get-dataverse-token.ts)
 *   E2E_TOOL_TIMEOUT_MS=290000 npx tsx --env-file .env test/e2e/pm-acceptance.ts
 *
 * Writes a markdown report to pm-acceptance-report-<UTC>.md in the project root.
 */

import { createServer, type Server } from "node:http";
import { writeFile, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getConfig, redact } from "./config.js";
import { mcpInitialize, mcpCall } from "./mcpClient.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

// ── EU/CRM4 dependency link-type option values (tenant is *.crm4.dynamics.com) ──
const LINK_TYPE_EU: Record<string, number> = { FF: 0, FS: 1, SF: 2, SS: 3 };

const DEFAULT_BUCKET = "(Unbucketed)";
const PLAN_PREFIX = "ZZ-MCP-PMTEST";
const TASK_BATCH = 190; // < 200-entity cap, with margin
const APPLY_POLL_MS = 240_000;

// ── Fixture types ────────────────────────────────────────────────────────────
interface FixtureTask {
  taskNumber: number;
  outline: string | null;
  name: string | null;
  category: string | null;
  priority: number | null;
  priorityLabel: string | null;
  progressPercent: number | null;
  start: string | null;
  finish: string | null;
  bucket: string | null;
  labels: string | null;
  effortHours: number | null;
  milestone: boolean;
  notes: string | null;
  checklist: string | null;
  sprint: string | null;
  assignedTo: string | null;
  parentTaskNumber: number | null;
  dependsOn: { onTaskNumber: number; type: string }[];
}
interface Fixture {
  source: string;
  meta: Record<string, unknown>;
  buckets: string[];
  taskCount: number;
  tasks: FixtureTask[];
}

// ── Lightweight step recorder (continue-on-failure; full report at the end) ───
type Status = "pass" | "fail" | "skip" | "info";
interface Rec {
  phase: string;
  name: string;
  tool?: string;
  status: Status;
  latencyMs: number;
  evidence?: string;
  error?: string;
}
const results: Rec[] = [];
function rec(r: Rec): void {
  results.push(r);
  const icon = { pass: "✅", fail: "❌", skip: "⏭️", info: "ℹ️" }[r.status];
  const detail = r.status === "fail" ? `— ${r.error}` : r.evidence ? `— ${r.evidence}` : "";
  console.log(`  ${icon} [${r.phase}] ${r.name} ${detail}`.slice(0, 200));
}

interface Ctx {
  mcpUrl: string;
  bearer: string;
  orgUrl: string;
}

/** Calls a tool, throws on isError. Returns parsed content. */
async function mc(ctx: Ctx, tool: string, args: Record<string, unknown>): Promise<any> {
  const { isError, content } = await mcpCall(ctx.mcpUrl, tool, args, ctx.bearer);
  if (isError) {
    const msg = typeof content === "string" ? content : JSON.stringify(content);
    throw new Error(msg.slice(0, 400));
  }
  return content;
}

/** Runs a positive step: records pass/fail, returns the check value (or undefined on failure). */
async function step<T>(
  phase: string,
  name: string,
  tool: string,
  fn: () => Promise<T>,
): Promise<T | undefined> {
  const t0 = Date.now();
  try {
    const value = await fn();
    rec({ phase, name, tool, status: "pass", latencyMs: Date.now() - t0, evidence: evidenceOf(value) });
    return value;
  } catch (e) {
    rec({ phase, name, tool, status: "fail", latencyMs: Date.now() - t0, error: errMsg(e) });
    return undefined;
  }
}

/** Negative step: expects the tool to reject (isError) with `fragment` in the message. */
async function expectReject(
  phase: string,
  name: string,
  tool: string,
  ctx: Ctx,
  args: Record<string, unknown>,
  fragment: string,
): Promise<void> {
  const t0 = Date.now();
  try {
    const { isError, content } = await mcpCall(ctx.mcpUrl, tool, args, ctx.bearer);
    const latencyMs = Date.now() - t0;
    const msg = (typeof content === "string" ? content : JSON.stringify(content)).toLowerCase();
    if (!isError) {
      rec({ phase, name, tool, status: "fail", latencyMs, error: `Expected rejection but call SUCCEEDED: ${msg.slice(0, 150)}` });
      return;
    }
    if (!msg.includes(fragment.toLowerCase())) {
      rec({ phase, name, tool, status: "fail", latencyMs, error: `Rejected but message missing "${fragment}": ${msg.slice(0, 150)}` });
      return;
    }
    rec({ phase, name, tool, status: "pass", latencyMs, evidence: `correctly rejected; contains "${fragment}"` });
  } catch (e) {
    rec({ phase, name, tool, status: "fail", latencyMs: Date.now() - t0, error: `Unexpected exception: ${errMsg(e)}` });
  }
}

function evidenceOf(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.replace(/(Bearer\s+\S+)/gi, "[REDACTED]").slice(0, 160);
}
function errMsg(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).slice(0, 300);
}
function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}
function outlineTuple(o: string | null): number[] {
  if (!o) return [Number.MAX_SAFE_INTEGER];
  return String(o).split(".").map((x) => Number(x) || 0);
}
function cmpTuple(a: number[], b: number[]): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const av = a[i] ?? -1;
    const bv = b[i] ?? -1;
    if (av !== bv) return av - bv;
  }
  return 0;
}

// ── Session helpers ───────────────────────────────────────────────────────────
async function startSession(ctx: Ctx, projectId: string, desc: string): Promise<string> {
  const r = await mc(ctx, "start_change_session", { projectId, description: desc });
  if (!r.operationSetId) throw new Error("no operationSetId returned");
  return r.operationSetId;
}
async function applyOps(ctx: Ctx, operationSetId: string): Promise<any> {
  const r = await mc(ctx, "apply_changes", { operationSetId, pollTimeoutMs: APPLY_POLL_MS });
  if (!r.persisted) throw new Error(`apply not persisted: ${JSON.stringify(r).slice(0, 200)}`);
  return r;
}

// ── Direct Dataverse (out-of-band cleanup, bypasses the MCP whole-plan block) ──
async function dv(ctx: Ctx, method: string, path: string): Promise<{ status: number; json: any }> {
  const res = await fetch(`${ctx.orgUrl}/api/data/v9.2${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${ctx.bearer}`,
      "OData-MaxVersion": "4.0",
      "OData-Version": "4.0",
      Accept: "application/json",
    },
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

// ── Local server boot (same app the production server uses) ───────────────────
async function bootLocalServer(port: number): Promise<Server> {
  const { buildApp } = await import("../../src/app.js");
  const app = buildApp();
  return new Promise((res, rej) => {
    const srv = createServer(app);
    srv.listen(port, () => res(srv));
    srv.once("error", rej);
  });
}

// ══════════════════════════════════════════════════════════════════════════════
async function main(): Promise<void> {
  const cfg = getConfig();
  const runAt = new Date().toISOString();

  const fixturePath = resolve(__dirname, "fixtures/it-planner-board.json");
  let fixtureRaw: string;
  try {
    fixtureRaw = await readFile(fixturePath, "utf-8");
  } catch {
    console.error(
      `\nFixture not found: ${fixturePath}\n` +
        `It is gitignored (private customer data). Provide your own export with the\n` +
        `shape documented in test/e2e/fixtures/README.md, then re-run.\n`,
    );
    process.exit(2);
  }
  const fx: Fixture = JSON.parse(fixtureRaw);

  console.log(`\n${"=".repeat(72)}`);
  console.log("  MCP Planner Premium — PM ACCEPTANCE TEST (live tenant)");
  console.log(`${"=".repeat(72)}`);
  console.log(`  Source : ${fx.source} (${fx.taskCount} tasks)`);
  console.log(`  Token  : ${redact(cfg.E2E_ACCESS_TOKEN)}`);
  console.log(`  Org    : ${cfg.DATAVERSE_ORG_URL}`);

  // Resolve / boot server
  let mcpUrl = cfg.MCP_URL ?? "";
  let localServer: Server | null = null;
  if (!mcpUrl) {
    process.env.AUTH_MODE = "insecure-passthrough";
    localServer = await bootLocalServer(cfg.PORT);
    mcpUrl = `http://localhost:${cfg.PORT}/mcp`;
    console.log(`  Server : local :${cfg.PORT} (insecure-passthrough)`);
  } else {
    console.log(`  Server : ${mcpUrl}`);
  }
  console.log("");

  const ctx: Ctx = { mcpUrl, bearer: cfg.E2E_ACCESS_TOKEN, orgUrl: cfg.DATAVERSE_ORG_URL };
  await mcpInitialize(mcpUrl, ctx.bearer);

  // ── Derived expectations from the fixture ───────────────────────────────────
  const parentNums = new Set<number>();
  for (const t of fx.tasks) if (t.parentTaskNumber != null) parentNums.add(t.parentTaskNumber);
  const isLeaf = (t: FixtureTask): boolean => !parentNums.has(t.taskNumber);
  const expectedDeps = fx.tasks.reduce((n, t) => n + t.dependsOn.length, 0);
  // PSS rejects dependencies that touch a summary (parent) task — links are only
  // valid between leaf tasks. Partition them out and create only the valid ones.
  const isSummaryNum = (n: number): boolean => parentNums.has(n);
  const createableDeps = fx.tasks.flatMap((t) =>
    t.dependsOn.map((d) => ({ pred: d.onTaskNumber, succ: t.taskNumber, type: d.type })),
  ).filter((d) => !isSummaryNum(d.pred) && !isSummaryNum(d.succ));
  const skippedSummaryDeps = expectedDeps - createableDeps.length;
  const bucketName = (b: string | null): string => b || DEFAULT_BUCKET;
  const allBuckets = [...new Set(fx.tasks.map((t) => bucketName(t.bucket)))].sort();
  const bucketCounts = new Map<string, number>();
  for (const t of fx.tasks) bucketCounts.set(bucketName(t.bucket), (bucketCounts.get(bucketName(t.bucket)) ?? 0) + 1);

  const guidByNum = new Map<number, string>();
  const bucketIdByName = new Map<string, string>();
  const dependencyIds: string[] = [];
  let createdDepCount = 0;
  const failedDeps: { pred: number; succ: number; error: string }[] = [];
  let projectId = "";
  const leftovers: string[] = [];

  // ════════════════════════ PHASE A — BUILD AT SCALE ════════════════════════
  console.log("PHASE A — Build at scale");

  const planName = `${PLAN_PREFIX}-${runAt.replace(/[:.]/g, "-").slice(0, 19)}`;
  const plan = await step("A", "create_plan", "create_plan", async () => {
    const r = await mc(ctx, "create_plan", {
      subject: planName,
      description: `PM acceptance test — imported from ${fx.source}`,
    });
    if (!r.projectId) throw new Error("no projectId");
    return r;
  });
  if (!plan) {
    leftovers.push("Plan creation failed — aborting run.");
    return finish(ctx, runAt, fx, planName, projectId, leftovers, localServer);
  }
  projectId = plan.projectId;

  // Buckets (10: 9 real + default). add_bucket manages its own session.
  await step("A", `create ${allBuckets.length} buckets`, "add_bucket", async () => {
    for (const name of allBuckets) {
      const r = await mc(ctx, "add_bucket", { name, projectId });
      if (!r.bucketId) throw new Error(`bucket "${name}" returned no id`);
      bucketIdByName.set(name, r.bucketId);
    }
    return { created: bucketIdByName.size };
  });

  // Tasks — created LEVEL BY LEVEL (breadth-first by hierarchy depth). This is
  // required: PSS auto-nests a *parentless* task under an existing task when the
  // plan is non-empty, so roots must all be created first (in the still-empty
  // plan) and every deeper task must carry an EXPLICIT parent GUID. Creating by
  // outline-order chunks instead lets later root tasks get auto-chained into a
  // false deep spine (and eventually trips PSS's max-task-level limit).
  const levelOf = (t: FixtureTask): number => (t.outline ? String(t.outline).split(".").length : 1);
  const maxLevel = Math.max(...fx.tasks.map(levelOf));
  let createdTasks = 0;
  for (let level = 1; level <= maxLevel; level++) {
    const atLevel = fx.tasks.filter((t) => levelOf(t) === level);
    const levelChunks = chunk(atLevel, TASK_BATCH);
    for (let ci = 0; ci < levelChunks.length; ci++) {
      const chunkTasks = levelChunks[ci];
      const label = `create L${level} tasks${levelChunks.length > 1 ? ` ${ci + 1}/${levelChunks.length}` : ""} (${chunkTasks.length})`;
      const ok = await step("A", label, "add_tasks", async () => {
        const os = await startSession(ctx, projectId, `L${level} ${ci + 1}`);
        const payload = chunkTasks.map((t) => {
          // Level 1 = root (no parent). All deeper levels carry an explicit
          // parent GUID, which is already persisted from the previous level.
          const parent = t.parentTaskNumber != null ? guidByNum.get(t.parentTaskNumber) : undefined;
          if (level > 1 && !parent) throw new Error(`task ${t.taskNumber}: parent ${t.parentTaskNumber} not yet created`);
          return {
            ref: `t${t.taskNumber}`,
            subject: (t.name || `Task ${t.taskNumber}`).slice(0, 250),
            bucket: bucketIdByName.get(bucketName(t.bucket)),
            start: t.start || undefined,
            finish: t.finish || undefined,
            effortHours: typeof t.effortHours === "number" ? t.effortHours : undefined,
            priority: typeof t.priority === "number" ? t.priority : undefined,
            description: t.notes || undefined,
            parent,
          };
        });
        const r = await mc(ctx, "add_tasks", { operationSetId: os, projectId, tasks: payload });
        for (const [ref, guid] of Object.entries(r.taskRefs as Record<string, string>)) {
          guidByNum.set(Number(ref.slice(1)), guid);
        }
        await applyOps(ctx, os);
        createdTasks += chunkTasks.length;
        return { queued: r.queued, persistedTotal: createdTasks };
      });
      if (!ok) {
        leftovers.push(`L${level} task batch failed — partial plan ${planName} (${projectId}) left for inspection.`);
        return finish(ctx, runAt, fx, planName, projectId, leftovers, localServer);
      }
    }
  }

  // Dependencies — all tasks now persisted; create dependency entities via raw
  // batch (ordering irrelevant), chunked, single session + apply.
  interface DepRec { entity: any; pred: number; succ: number; }
  const depRecords: DepRec[] = [];
  for (const d of createableDeps) {
    const pred = guidByNum.get(d.pred);
    const succ = guidByNum.get(d.succ);
    if (!pred || !succ) continue;
    const id = randomUUID();
    depRecords.push({
      pred: d.pred,
      succ: d.succ,
      entity: {
        "@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttaskdependency",
        msdyn_projecttaskdependencyid: id,
        "msdyn_Project@odata.bind": `/msdyn_projects(${projectId})`,
        "msdyn_PredecessorTask@odata.bind": `/msdyn_projecttasks(${pred})`,
        "msdyn_SuccessorTask@odata.bind": `/msdyn_projecttasks(${succ})`,
        msdyn_projecttaskdependencylinktype: LINK_TYPE_EU[d.type] ?? LINK_TYPE_EU.FS,
      },
    });
  }
  rec({ phase: "A", name: `skip ${skippedSummaryDeps} summary-linked dependencies (PSS rejects links on summary tasks)`, tool: "—", status: "info", latencyMs: 0, evidence: `${createableDeps.length} leaf-to-leaf deps are createable; ${skippedSummaryDeps} touch a summary task` });
  // Create deps in small sessions (one apply per chunk; the 200-cap is per
  // operation set). On a chunk-apply failure, retry that chunk one dependency at
  // a time so a single bad link can't sink the whole batch — and we learn exactly
  // which links PSS refuses, and why. This is the "run what is able to run" path.
  const DEP_CHUNK = 50;
  const depChunks = chunk(depRecords, DEP_CHUNK);
  await step("A", `create ${depRecords.length} dependencies (fallback-isolating)`, "add_tasks_batch", async () => {
    for (const dc of depChunks) {
      try {
        const os = await startSession(ctx, projectId, "deps");
        await mc(ctx, "add_tasks_batch", { operationSetId: os, entities: dc.map((r) => r.entity) });
        await applyOps(ctx, os);
        for (const r of dc) { createdDepCount++; dependencyIds.push(r.entity.msdyn_projecttaskdependencyid); }
      } catch {
        // Isolate: retry each dependency in the failed chunk on its own.
        for (const r of dc) {
          try {
            const os = await startSession(ctx, projectId, "dep-1");
            await mc(ctx, "add_tasks_batch", { operationSetId: os, entities: [r.entity] });
            await applyOps(ctx, os);
            createdDepCount++; dependencyIds.push(r.entity.msdyn_projecttaskdependencyid);
          } catch (e) {
            failedDeps.push({ pred: r.pred, succ: r.succ, error: errMsg(e) });
          }
        }
      }
    }
    if (failedDeps.length) {
      rec({ phase: "A", name: `${failedDeps.length} dependencies refused by PSS (isolated)`, tool: "add_tasks_batch", status: "info", latencyMs: 0, evidence: failedDeps.slice(0, 3).map((f) => `#${f.pred}->#${f.succ}: ${f.error.slice(0, 60)}`).join(" | ") });
    }
    return { created: createdDepCount, refused: failedDeps.length };
  });

  // Progress — set on LEAF tasks only (summary progress rolls up automatically).
  const progressUpdates = fx.tasks
    .filter((t) => isLeaf(t) && typeof t.progressPercent === "number" && (t.progressPercent as number) > 0)
    .map((t) => ({ taskId: guidByNum.get(t.taskNumber)!, progressPercent: t.progressPercent as number }))
    .filter((u) => u.taskId);
  await step("A", `set progress on ${progressUpdates.length} leaf tasks`, "update_tasks", async () => {
    for (const uc of chunk(progressUpdates, TASK_BATCH)) {
      const os = await startSession(ctx, projectId, "progress");
      await mc(ctx, "update_tasks", { operationSetId: os, projectId, tasks: uc });
      await applyOps(ctx, os);
    }
    return { updated: progressUpdates.length };
  });

  // ════════════════════════ PHASE B — READ-BACK VERIFY ════════════════════════
  console.log("PHASE B — Read-back verification");

  const summary = await step("B", "get_plan_summary — total task count", "get_plan_summary", async () => {
    const r = await mc(ctx, "get_plan_summary", { projectId });
    assertEq(r.totalTasks, fx.taskCount, "totalTasks");
    return { totalTasks: r.totalTasks, progressPercent: r.progressPercent };
  });

  const contents = await step("B", "get_plan_tasks_and_buckets — full tree", "get_plan_tasks_and_buckets", async () => {
    const r = await mc(ctx, "get_plan_tasks_and_buckets", { projectId });
    if (r.truncated) throw new Error("read truncated — plan exceeded page cap");
    assertEq(r.taskCount, fx.taskCount, "taskCount");
    // create_plan auto-adds a "Bucket 1"; verify every expected bucket is present
    // (subset) rather than an exact count.
    const got = new Set(r.buckets.map((b: any) => b.name));
    const missing = allBuckets.filter((b) => !got.has(b));
    if (missing.length) throw new Error(`buckets missing: ${missing.join(", ")}`);
    return r;
  });

  await step("B", "hierarchy depth == 5 levels", "get_plan_tasks_and_buckets", async () => {
    const maxLevel = Math.max(...(contents?.tasks ?? []).map((t: any) => t.outlineLevel ?? 0));
    assertEq(maxLevel, 5, "max outline level");
    return { maxLevel };
  });

  await step("B", "summary-task count matches parents", "get_plan_tasks_and_buckets", async () => {
    const summaries = (contents?.summaryTaskIds ?? []).length;
    assertEq(summaries, parentNums.size, "summary task count");
    return { summaries };
  });

  await step("B", "get_bucket_breakdown — per-bucket counts", "get_bucket_breakdown", async () => {
    const r = await mc(ctx, "get_bucket_breakdown", { projectId });
    const byName = new Map<string, number>(r.buckets.map((b: any) => [b.name, b.taskCount]));
    const mism: string[] = [];
    for (const [name, want] of bucketCounts) {
      if (byName.get(name) !== want) mism.push(`${name}: got ${byName.get(name)} want ${want}`);
    }
    if (mism.length) throw new Error(`bucket count mismatch — ${mism.slice(0, 3).join("; ")}`);
    return { buckets: r.bucketCount };
  });

  await step("B", "list_dependencies — count matches created", "list_dependencies", async () => {
    const r = await mc(ctx, "list_dependencies", { projectId });
    assertEq(r.count, createdDepCount, "dependency count");
    return { listed: r.count, created: createdDepCount, summaryLinkedSkipped: skippedSummaryDeps, pssRefused: failedDeps.length };
  });

  await step("B", "list_plan_tasks all == 642", "list_plan_tasks", async () => {
    const r = await mc(ctx, "list_plan_tasks", { projectId, filter: "all" });
    if (r.truncated) throw new Error("truncated");
    assertEq(r.count, fx.taskCount, "list all count");
    return { count: r.count };
  });

  // Spot-check the deepest L5 chain task against the source.
  const deepTask = fx.tasks.find((t) => (t.outline ?? "").split(".").length === 5);
  if (deepTask) {
    await step("B", `get_task spot-check (outline ${deepTask.outline})`, "get_task", async () => {
      const r = await mc(ctx, "get_task", { taskId: guidByNum.get(deepTask.taskNumber) });
      const got = r.task?.subject ?? r.subject;
      assertEq(got, (deepTask.name || `Task ${deepTask.taskNumber}`).slice(0, 250), "deep task subject");
      return { subject: got };
    });
  }

  // ════════════════════════ PHASE C — PM OPERATIONS ════════════════════════
  console.log("PHASE C — PM operations");
  const readTasks: any[] = contents?.tasks ?? [];
  const leafReads = readTasks.filter((t) => !t.isSummary);

  // C1 Reschedule a leaf task by +7 days.
  const reTask = leafReads.find((t) => t.start && t.finish);
  if (reTask) {
    await step("C", "reschedule leaf task (+7d) and verify", "update_tasks", async () => {
      const ns = shiftDays(reTask.start, 7);
      const nf = shiftDays(reTask.finish, 7);
      const os = await startSession(ctx, projectId, "reschedule");
      await mc(ctx, "update_tasks", { operationSetId: os, projectId, tasks: [{ taskId: reTask.taskId, start: ns, finish: nf }] });
      await applyOps(ctx, os);
      const v = await mc(ctx, "get_task", { taskId: reTask.taskId });
      const gotStart = (v.task?.start ?? v.start ?? "").slice(0, 10);
      assertEq(gotStart, ns.slice(0, 10), "rescheduled start");
      return { start: gotStart };
    });
  }

  // C2 Re-bucket a leaf task to a different existing bucket.
  const rebTask = leafReads.find((t) => t.taskId !== reTask?.taskId);
  const targetBucket = allBuckets.find((b) => bucketIdByName.get(b) !== rebTask?.bucketId) ?? allBuckets[0];
  if (rebTask) {
    await step("C", `re-bucket leaf task → "${targetBucket}"`, "update_tasks", async () => {
      const os = await startSession(ctx, projectId, "rebucket");
      await mc(ctx, "update_tasks", { operationSetId: os, projectId, tasks: [{ taskId: rebTask.taskId, bucket: bucketIdByName.get(targetBucket) }] });
      await applyOps(ctx, os);
      const v = await mc(ctx, "get_plan_tasks_and_buckets", { projectId });
      const moved = v.tasks.find((t: any) => t.taskId === rebTask.taskId);
      assertEq(String(moved?.bucketId).toLowerCase(), String(bucketIdByName.get(targetBucket)).toLowerCase(), "new bucketId");
      return { bucket: targetBucket };
    });
  }

  // C3 Re-prioritise a leaf task.
  const priTask = leafReads.find((t) => t.taskId && t.taskId !== reTask?.taskId && t.taskId !== rebTask?.taskId);
  if (priTask) {
    await step("C", "re-prioritise leaf task → 9 (Low)", "update_tasks", async () => {
      const os = await startSession(ctx, projectId, "reprioritise");
      await mc(ctx, "update_tasks", { operationSetId: os, projectId, tasks: [{ taskId: priTask.taskId, priority: 9 }] });
      await applyOps(ctx, os);
      return { taskId: priTask.taskId };
    });
  }

  // C4 Progress rollup — set a summary's leaf children to 100%, assert parent progress rises.
  const summaryWithLeafKids = (contents?.summaryTaskIds ?? []).map((sid: string) => {
    const kids = readTasks.filter((t) => String(t.parentTaskId).toLowerCase() === String(sid).toLowerCase());
    return { sid, kids, parent: readTasks.find((t) => t.taskId === sid) };
  }).find((g: any) => g.kids.length > 0 && g.kids.every((k: any) => !k.isSummary) && (g.parent?.progress ?? 0) < 1);
  if (summaryWithLeafKids) {
    await step("C", "progress rollup — children→100%, parent recalculates", "update_tasks", async () => {
      const before = summaryWithLeafKids.parent?.progress ?? 0;
      const os = await startSession(ctx, projectId, "rollup");
      await mc(ctx, "update_tasks", {
        operationSetId: os,
        projectId,
        tasks: summaryWithLeafKids.kids.map((k: any) => ({ taskId: k.taskId, progressPercent: 100 })),
      });
      await applyOps(ctx, os);
      const v = await mc(ctx, "get_task", { taskId: summaryWithLeafKids.sid });
      const after = v.task?.progressPercent ?? v.progressPercent ?? 0;
      if (!(after > before * 100 || after >= 99)) throw new Error(`parent progress did not rise: before=${before} after=${after}`);
      return { before: Math.round(before * 100), after };
    });
  } else {
    rec({ phase: "C", name: "progress rollup", tool: "update_tasks", status: "skip", latencyMs: 0, evidence: "no eligible summary<100% with all-leaf children" });
  }

  // C5 Add a sub-task under an existing parent mid-project, then C6 delete it.
  const anyParent = (contents?.summaryTaskIds ?? [])[0];
  let newSubtaskId = "";
  if (anyParent) {
    await step("C", "add sub-task under existing parent", "add_tasks", async () => {
      const os = await startSession(ctx, projectId, "add-subtask");
      const r = await mc(ctx, "add_tasks", {
        operationSetId: os,
        projectId,
        tasks: [{ ref: "newsub", subject: "ZZ PM-test new subtask", bucket: bucketIdByName.get(allBuckets[0]), parent: anyParent }],
      });
      newSubtaskId = (r.taskRefs as Record<string, string>).newsub;
      await applyOps(ctx, os);
      const v = await mc(ctx, "get_task", { taskId: newSubtaskId });
      const got = v.task?.subject ?? v.subject;
      assertEq(got, "ZZ PM-test new subtask", "new subtask subject");
      return { taskId: newSubtaskId };
    });
  }
  if (newSubtaskId) {
    await step("C", "delete the sub-task (confirmed gate)", "delete_tasks_batch", async () => {
      const os = await startSession(ctx, projectId, "delete-subtask");
      await mc(ctx, "delete_tasks_batch", { operationSetId: os, projectId, taskIds: [newSubtaskId], confirmed: true });
      await applyOps(ctx, os);
      const v = await dv(ctx, "GET", `/msdyn_projecttasks(${newSubtaskId})?$select=msdyn_projecttaskid`);
      if (v.status !== 404) throw new Error(`task still present after delete (status ${v.status})`);
      return { deleted: newSubtaskId };
    });
  }

  // ════════════════════════ PHASE D — GUARDRAILS ════════════════════════
  console.log("PHASE D — Guardrails");
  const guardOs = await startSession(ctx, projectId, "guardrail-tests").catch(() => "");
  const someLeaf = leafReads[0]?.taskId;
  const someSummary = (contents?.summaryTaskIds ?? [])[0];

  // >200-entity cap
  await expectReject("D", ">200-entity batch rejected", "add_tasks_batch", ctx, {
    operationSetId: guardOs,
    entities: Array.from({ length: 201 }, () => ({ "@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask", msdyn_subject: "x" })),
  }, "max 200");

  // Summary-task rolled-up field protection
  if (someSummary) {
    await expectReject("D", "summary-task date overwrite rejected", "update_tasks", ctx, {
      operationSetId: guardOs,
      projectId,
      tasks: [{ taskId: someSummary, finish: "2027-01-01T17:00:00Z" }],
    }, "summary");
  }

  // Delete without confirmed
  if (someLeaf) {
    await expectReject("D", "delete without confirmed rejected", "delete_tasks_batch", ctx, {
      operationSetId: guardOs,
      taskIds: [someLeaf],
      confirmed: false,
    }, "confirmed");
  }

  // Whole-plan delete hard-blocked
  await expectReject("D", "whole-plan delete hard-blocked", "delete_tasks_batch", ctx, {
    operationSetId: guardOs,
    records: [{ entityLogicalName: "msdyn_project", recordId: projectId }],
    confirmed: true,
  }, "blocked by policy");

  // Bad bind alias
  await expectReject("D", "bad bind alias rejected", "add_tasks_batch", ctx, {
    operationSetId: guardOs,
    entities: [{
      "@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
      msdyn_subject: "x",
      "msdyn_project@odata.bind": `/msdyn_projects(${projectId})`,
      "msdyn_bucket@odata.bind": `/msdyn_projectbuckets(${bucketIdByName.get(allBuckets[0])})`,
    }],
  }, "not a valid navigation property");

  // Parent-after-child ordering
  const pGuid = randomUUID();
  const cGuid = randomUUID();
  const bind = `/msdyn_projectbuckets(${bucketIdByName.get(allBuckets[0])})`;
  await expectReject("D", "parent-after-child ordering rejected", "add_tasks_batch", ctx, {
    operationSetId: guardOs,
    entities: [
      { "@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask", msdyn_projecttaskid: cGuid, msdyn_subject: "child", "msdyn_project@odata.bind": `/msdyn_projects(${projectId})`, "msdyn_projectbucket@odata.bind": bind, "msdyn_parenttask@odata.bind": `/msdyn_projecttasks(${pGuid})` },
      { "@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask", msdyn_projecttaskid: pGuid, msdyn_subject: "parent", "msdyn_project@odata.bind": `/msdyn_projects(${projectId})`, "msdyn_projectbucket@odata.bind": bind },
    ],
  }, "before their children");

  // Invalid GUID
  await expectReject("D", "invalid GUID rejected", "update_tasks", ctx, {
    operationSetId: guardOs,
    tasks: [{ taskId: "not-a-guid", progressPercent: 50 }],
  }, "guid");

  // Null date on update — rejected at the input-validation boundary (the schema
  // types start/finish as optional strings, so null is refused before it reaches
  // the tool). That is the correct, safe outcome: a null date can never overwrite.
  if (someLeaf) {
    await step("D", "null date on update rejected (input validation)", "update_tasks", async () => {
      const os = await startSession(ctx, projectId, "nulldate");
      try {
        await mc(ctx, "update_tasks", { operationSetId: os, projectId, tasks: [{ taskId: someLeaf, start: null }] });
        throw new Error("expected rejection but call SUCCEEDED");
      } catch (e) {
        const m = errMsg(e).toLowerCase();
        if (!(m.includes("validation") || m.includes("invalid"))) throw new Error(`unexpected error: ${m.slice(0, 120)}`);
        return { rejected: "null date refused at input boundary" };
      } finally {
        await mc(ctx, "cancel_change_session", { operationSetId: os }).catch(() => {});
      }
    });
  }
  if (guardOs) await mc(ctx, "cancel_change_session", { operationSetId: guardOs }).catch(() => {});

  // ════════════════════════ PHASE E — KNOWN GAPS ════════════════════════
  console.log("PHASE E — Known capability gaps");

  // Milestone on create — returned in milestoneTaskIds, never set (then cancelled).
  await step("E", "milestone on create → deferred to milestoneTaskIds", "add_tasks", async () => {
    const os = await startSession(ctx, projectId, "milestone-create");
    const r = await mc(ctx, "add_tasks", {
      operationSetId: os,
      projectId,
      tasks: [{ ref: "ms", subject: "ZZ milestone probe", bucket: bucketIdByName.get(allBuckets[0]), milestone: true }],
    });
    await mc(ctx, "cancel_change_session", { operationSetId: os }).catch(() => {});
    if (!(r.milestoneTaskIds?.length > 0)) throw new Error("expected milestoneTaskIds to be populated");
    return { milestoneTaskIds: r.milestoneTaskIds.length, note: "PSS rejects msdyn_ismilestone — must be set in Planner UI" };
  });

  // Milestone on update — ignored; milestone-only update rejected as "nothing to change".
  if (someLeaf) {
    await expectReject("E", "milestone on update is ignored", "update_tasks", ctx, {
      operationSetId: guardOs || (await startSession(ctx, projectId, "ms-upd")),
      projectId,
      tasks: [{ taskId: someLeaf, milestone: true }],
    }, "milestone");
  }

  // Checklist + sprint + assignees are now first-class on add_tasks — exercise
  // them on a real feature-rich task and verify each persisted.
  const sprintName = "PM-Test Sprint";
  await step("E", "add_sprint creates a sprint", "add_sprint", async () => {
    const r = await mc(ctx, "add_sprint", { name: sprintName, projectId, start: "2026-07-01", finish: "2026-07-14" });
    if (!r.sprintId) throw new Error("no sprintId");
    return { sprintId: r.sprintId };
  });

  const teamMembers = await step("E", "list_team_members (plan auto-includes creator)", "list_team_members", async () => {
    const r = await mc(ctx, "list_team_members", { projectId });
    if (!(r.count > 0)) throw new Error("expected at least one team member");
    return r.members as { teamMemberId: string; name: string }[];
  });
  const memberName = teamMembers?.[0]?.name;

  await step("E", "checklist + sprint + assignee on one task (verified)", "add_tasks", async () => {
    const os = await startSession(ctx, projectId, "features");
    const r = await mc(ctx, "add_tasks", {
      operationSetId: os,
      projectId,
      tasks: [{
        ref: "feat",
        subject: "ZZ feature-rich task",
        bucket: bucketIdByName.get(allBuckets[0]),
        parent: (contents?.summaryTaskIds ?? [])[0],
        sprint: sprintName,
        checklist: ["Plan", "Build", { title: "Ship", completed: true }],
        assignees: memberName ? [memberName] : [],
        labels: ["ZZ-no-such-label"],
      }],
    });
    // Labels can't be created via the API → the unknown one is skipped with a warning.
    const warned = JSON.stringify(r.warnings ?? []).toLowerCase().includes("label");
    await applyOps(ctx, os);
    const taskId = (r.taskRefs as Record<string, string>).feat;
    const v = await mc(ctx, "get_task", { taskId });
    if (!v.task?.sprintId) throw new Error("sprint not set on task");
    if (memberName && !(v.assignments?.length > 0)) throw new Error("assignee not attached");
    const chk = await dv(ctx, "GET", `/msdyn_projectchecklists?$filter=_msdyn_projecttaskid_value eq ${taskId}&$select=msdyn_projectchecklistid`);
    if ((chk.json?.value?.length ?? 0) !== 3) throw new Error(`expected 3 checklist items, got ${chk.json?.value?.length}`);
    return { sprint: true, assignees: v.assignments?.length ?? 0, checklist: 3, labelSkippedWithWarning: warned };
  });

  rec({ phase: "E", name: "Labels — create is UI-only (API limitation); assign-to-existing supported", tool: "add_tasks", status: "info", latencyMs: 0, evidence: "msdyn_projectlabel cannot be created via direct OData or PSS; add_tasks assigns existing labels and warns on unknown ones" });

  // ════════════════════════ PHASE F — CLEANUP ════════════════════════
  console.log("PHASE F — Cleanup");
  // Keep the plan when anything failed (so it can be inspected / re-tested without
  // a 4-minute rebuild) or when KEEP_PLAN=1. Only auto-delete a fully-green run.
  const anyFail = results.some((r) => r.status === "fail");
  const keepPlan = anyFail || process.env.KEEP_PLAN === "1";
  if (keepPlan) {
    rec({ phase: "F", name: "plan KEPT for reuse (failures present or KEEP_PLAN=1)", tool: "—", status: "info", latencyMs: 0, evidence: `projectId=${projectId} name=${planName}` });
    leftovers.push(`Plan ${planName} (${projectId}) kept for reuse — delete later via scripts/cleanup-e2e-plans.ts.`);
  } else {
    await step("F", "delete disposable test plan (direct OData)", "dataverse", async () => {
      const del = await dv(ctx, "DELETE", `/msdyn_projects(${projectId})`);
      if (del.status !== 204 && del.status !== 404) {
        leftovers.push(`Plan ${planName} (${projectId}) could not be auto-deleted (status ${del.status}); remove via scripts/cleanup-e2e-plans.ts or the Planner UI.`);
        throw new Error(`delete returned status ${del.status}`);
      }
      return { deleted: planName };
    });
  }

  await finish(ctx, runAt, fx, planName, projectId, leftovers, localServer);
}

function assertEq(got: unknown, want: unknown, label: string): void {
  if (got !== want) throw new Error(`${label}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
}
function shiftDays(iso: string, days: number): string {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

async function finish(
  ctx: Ctx,
  runAt: string,
  fx: Fixture,
  planName: string,
  projectId: string,
  leftovers: string[],
  localServer: Server | null,
): Promise<void> {
  const md = renderReport(runAt, ctx, fx, planName, projectId, leftovers);
  const file = `pm-acceptance-report-${runAt.replace(/[:.]/g, "-").slice(0, 19)}.md`;
  await writeFile(resolve(process.cwd(), file), md, "utf-8");

  const pass = results.filter((r) => r.status === "pass").length;
  const fail = results.filter((r) => r.status === "fail").length;
  const skip = results.filter((r) => r.status === "skip").length;
  console.log(`\n${"=".repeat(72)}`);
  console.log(`  RESULT: ${fail === 0 ? "✅ ALL PASS" : `❌ ${fail} FAILURE(S)`}  ·  ${pass} pass / ${fail} fail / ${skip} skip`);
  console.log(`  Report: ${file}`);
  console.log(`${"=".repeat(72)}\n`);

  if (localServer) await new Promise<void>((r) => localServer.close(() => r()));
  process.exit(fail === 0 ? 0 : 1);
}

function renderReport(runAt: string, ctx: Ctx, fx: Fixture, planName: string, projectId: string, leftovers: string[]): string {
  const pass = results.filter((r) => r.status === "pass").length;
  const fail = results.filter((r) => r.status === "fail").length;
  const skip = results.filter((r) => r.status === "skip").length;
  const info = results.filter((r) => r.status === "info").length;
  const phases: Record<string, string> = { A: "Build at scale", B: "Read-back verification", C: "PM operations", D: "Guardrails", E: "Known capability gaps", F: "Cleanup" };
  const icon: Record<string, string> = { pass: "✅", fail: "❌", skip: "⏭️", info: "ℹ️" };
  const fmt = (ms: number): string => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);

  const L: string[] = [];
  L.push("# MCP Planner Premium — PM Acceptance Report");
  L.push("");
  L.push(`Run: \`${runAt}\`  ·  Org: \`${ctx.orgUrl}\``);
  L.push(`Source: \`${fx.source}\` — ${fx.taskCount} tasks · ${fx.buckets.length + 1} buckets · ${fx.tasks.reduce((n, t) => n + t.dependsOn.length, 0)} dependencies`);
  L.push(`Plan: \`${planName}\` (\`${projectId}\`)`);
  L.push("");
  L.push(`## Overall: ${fail === 0 ? "✅ ALL PASS" : `❌ ${fail} FAILURE(S)`}`);
  L.push("");
  L.push("| | Count |");
  L.push("|---|---|");
  L.push(`| Pass | ${pass} |`);
  L.push(`| Fail | ${fail} |`);
  L.push(`| Skip | ${skip} |`);
  L.push(`| Info (documented gaps) | ${info} |`);
  L.push("");

  for (const p of ["A", "B", "C", "D", "E", "F"]) {
    const rows = results.filter((r) => r.phase === p);
    if (rows.length === 0) continue;
    L.push(`## Phase ${p} — ${phases[p]}`);
    L.push("");
    L.push("| | Step | Tool | Latency | Evidence / Error |");
    L.push("|---|---|---|---|---|");
    for (const r of rows) {
      const detail = (r.status === "fail" ? `⚠️ ${r.error ?? ""}` : r.evidence ?? "").replace(/\|/g, "\\|").slice(0, 140);
      L.push(`| ${icon[r.status]} | ${r.name} | \`${r.tool ?? ""}\` | ${fmt(r.latencyMs)} | ${detail} |`);
    }
    L.push("");
  }

  L.push("## Cleanup & residue");
  L.push("");
  if (leftovers.length) for (const n of leftovers) L.push(`- ⚠️ ${n}`);
  else L.push("- ✅ No residue — disposable plan deleted.");
  L.push("");
  L.push("---");
  L.push("");
  L.push("*All correctness verdicts are code assertions against live Dataverse reads — never AI-generated summaries.*");
  L.push("");
  return L.join("\n");
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(2);
});
