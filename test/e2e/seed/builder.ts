/**
 * builder.ts — RESUMABLE live build of the seed board from a fixture.
 *
 * Uses the pure planners (planBuild.ts) + the cache decision (cache.ts) to build
 * a large board (e.g. the 642-task it-planner-board.json) via the real MCP tools,
 * writing `.e2e-seed-cache.json` after every applied batch so an interrupted build
 * RESUMES from the last checkpoint instead of recreating everything. Roots-first,
 * level-by-level with explicit parent GUIDs; leaf-only deps with bisect-on-failure;
 * leaf progress last. The plan is KEPT.
 *
 * A `CallFn` (with the caller's transient-retry) is injected so this module does
 * not depend on a particular client.
 */

import { readFile, writeFile, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { Fixture } from "./hashFixture.js";
import { hashFixture } from "./hashFixture.js";
import {
  CACHE_VERSION,
  blankCheckpoint,
  computeSummaryTaskNumbers,
  validateSeedCache,
  type SeedCache,
} from "./cache.js";
import {
  planTaskBatches,
  planDependencyBatches,
  planProgressItems,
  DEFAULT_BATCH_SIZE,
  type DepItem,
} from "./planBuild.js";

const LINK_TYPE: Record<"eu" | "global", Record<string, number>> = {
  global: { FS: 192350000, SS: 192350001, FF: 192350002, SF: 192350003 },
  eu: { FS: 1, SS: 3, FF: 0, SF: 2 },
};
const NULL_BUCKET = "(General)";
// A transient network failure must NOT be mistaken for a permanent PSS dep
// rejection — it aborts the build (so it resumes) instead of marking deps failed.
const TRANSIENT = /fetch failed|did not respond|ETIMEDOUT|EHOSTUNREACH|ECONNRESET|socket|ENOTFOUND|network/i;

export type CallFn = (tool: string, args: Record<string, unknown>) => Promise<any>;

export interface BuildCtx {
  call: CallFn;
  orgUrl: string;
  planName: string;
  linkStyle: "eu" | "global";
  probePlanExists: (projectId: string) => Promise<boolean>;
  probeTaskCount: (projectId: string) => Promise<number | null>;
  forceRebuild?: boolean;
  log?: (m: string) => void;
  /** Reports each build sub-step so the caller can record it in the report. */
  onStep?: (step: string, tool: string, ms: number, evidence: string) => void;
}

const cachePath = () => resolve(process.cwd(), ".e2e-seed-cache.json");

export async function readCache(): Promise<SeedCache | null> {
  try {
    return JSON.parse(await readFile(cachePath(), "utf8")) as SeedCache;
  } catch {
    return null;
  }
}
async function writeCache(c: SeedCache): Promise<void> {
  const tmp = cachePath() + ".tmp";
  await writeFile(tmp, JSON.stringify(c, null, 2), "utf8");
  await rename(tmp, cachePath());
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function freshCache(ctx: BuildCtx, fixture: Fixture): SeedCache {
  return {
    version: CACHE_VERSION,
    seedPlanName: ctx.planName,
    projectId: null,
    orgUrl: ctx.orgUrl,
    fixtureHash: hashFixture(fixture),
    fixtureTaskCount: fixture.taskCount,
    linkTypeStyle: ctx.linkStyle,
    builtAtUtc: new Date().toISOString(),
    buckets: {},
    taskGuidByNumber: {},
    dependencyIds: [],
    dependencyPairs: [],
    summaryTaskNumbers: computeSummaryTaskNumbers(fixture),
    checkpoint: blankCheckpoint(),
    scratch: { bucketId: null, subtreeRootTaskId: null, createdTaskIds: [] },
  };
}

/** Open a session, mutate, apply; cancel the session if apply fails (no leaked open sets). */
async function applySession(ctx: BuildCtx, projectId: string, mutate: (opSet: string) => Promise<void>): Promise<void> {
  const s = await ctx.call("start_change_session", { projectId });
  try {
    await mutate(s.operationSetId);
    await ctx.call("apply_changes", { operationSetId: s.operationSetId });
  } catch (e) {
    try {
      await ctx.call("cancel_change_session", { operationSetId: s.operationSetId });
    } catch {
      /* best effort */
    }
    throw e;
  }
}

export async function buildOrReuseSeed(ctx: BuildCtx, fixture: Fixture): Promise<SeedCache> {
  const log = ctx.log ?? (() => {});
  let cache = await readCache();

  let probe = { planExists: false, liveTaskCount: null as number | null };
  if (cache?.projectId) {
    probe = { planExists: await ctx.probePlanExists(cache.projectId), liveTaskCount: await ctx.probeTaskCount(cache.projectId) };
  }
  const decision = validateSeedCache(cache, fixture, probe, ctx.orgUrl, ctx.forceRebuild).decision;
  log(`seed decision: ${decision}`);
  if (decision === "reuse" && cache) {
    ctx.onStep?.("reuse kept board (cache hit — not rebuilt)", "list_plans", 0, `${probe.liveTaskCount ?? cache.fixtureTaskCount} tasks`);
    return cache;
  }
  if (decision === "rebuild" || !cache) cache = freshCache(ctx, fixture);

  // ── Plan ──
  if (!cache.projectId) {
    const t0 = Date.now();
    const r = await ctx.call("create_plan", { subject: cache.seedPlanName, description: "PM-ops seed board (kept)" });
    cache.projectId = r.projectId;
    cache.checkpoint.phase = "plan";
    await writeCache(cache);
    log(`created plan ${cache.projectId}`);
    ctx.onStep?.("create_plan — kept seed plan", "create_plan", Date.now() - t0, String(cache.projectId));
  }
  const projectId = cache.projectId;

  // ── Buckets (incl. a default for unbucketed fixture tasks) ──
  const bucketNames = new Set<string>();
  for (const t of fixture.tasks) bucketNames.add(t.bucket && t.bucket.trim() ? t.bucket.trim() : NULL_BUCKET);
  const tB = Date.now();
  let bucketsCreated = 0;
  for (const name of bucketNames) {
    if (!cache.buckets[name]) {
      cache.buckets[name] = (await ctx.call("add_bucket", { projectId, name })).bucketId;
      bucketsCreated++;
      await writeCache(cache);
    }
  }
  cache.checkpoint.phase = "buckets";
  await writeCache(cache);
  log(`buckets ready (${Object.keys(cache.buckets).length})`);
  if (bucketsCreated > 0) ctx.onStep?.(`create ${bucketsCreated} buckets`, "add_bucket", Date.now() - tB, `${Object.keys(cache.buckets).length} total`);

  // ── Tasks, roots-first, level-by-level with explicit parent GUIDs ──
  const parentOf = new Map<number, number | null>();
  for (const t of fixture.tasks) parentOf.set(t.taskNumber, t.parentTaskNumber ?? null);
  const guidMap = new Map<number, string>(Object.entries(cache.taskGuidByNumber).map(([k, v]) => [Number(k), v]));

  const batches = planTaskBatches(fixture, new Map(), DEFAULT_BATCH_SIZE); // structure only; parents resolved live below
  for (const batch of batches) {
    if (batch.items.every((it) => guidMap.has(it.taskNumber))) continue; // already built (resume)
    const tasks = batch.items
      .filter((it) => !guidMap.has(it.taskNumber))
      .map((it) => {
        const pn = parentOf.get(it.taskNumber);
        const parentGuid = pn != null ? guidMap.get(pn) : undefined;
        const t: any = {
          ref: String(it.taskNumber),
          subject: it.name,
          bucket: it.bucket && it.bucket.trim() ? it.bucket.trim() : NULL_BUCKET,
        };
        if (parentGuid) t.parent = parentGuid;
        if (it.start) t.start = it.start;
        if (it.finish) t.finish = it.finish;
        if (typeof it.effortHours === "number") t.effortHours = it.effortHours;
        if (typeof it.priority === "number") t.priority = it.priority;
        return t;
      });
    const tT = Date.now();
    await applySession(ctx, projectId, async (opSet) => {
      const r = await ctx.call("add_tasks", { operationSetId: opSet, projectId, tasks });
      for (const [ref, guid] of Object.entries(r.taskRefs as Record<string, string>)) {
        const num = Number(ref);
        cache!.taskGuidByNumber[num] = guid;
        guidMap.set(num, guid);
      }
    });
    cache.checkpoint.phase = `tasksL${batch.level}` as SeedCache["checkpoint"]["phase"];
    cache.checkpoint.lastLevelDone = batch.level;
    cache.checkpoint.tasksPersisted = Object.keys(cache.taskGuidByNumber).length;
    await writeCache(cache);
    log(`tasks L${batch.level}.${batch.batchIndex}: +${tasks.length} (${cache.checkpoint.tasksPersisted} total)`);
    ctx.onStep?.(`create L${batch.level} tasks (${tasks.length})`, "add_tasks", Date.now() - tT, `${cache.checkpoint.tasksPersisted} total`);
  }

  // ── Dependencies (leaf-only) with bisect-on-failure ──
  // Resumable: skip pairs already created (cache.dependencyPairs) and pairs PSS
  // permanently refused (failedDeps). A transient drop aborts and resumes.
  if (!cache.checkpoint.depsPhaseDone) {
    const tD = Date.now();
    const { deps, skippedSummaryDeps } = planDependencyBatches(fixture, DEFAULT_BATCH_SIZE);
    const createdPairs = new Set(cache.dependencyPairs ?? []);
    const failedPairs = new Set(cache.checkpoint.failedDeps.map((f) => `${f.pred}:${f.succ}`));
    const remaining = deps.filter(
      (d) => !createdPairs.has(`${d.pred}:${d.succ}`) && !failedPairs.has(`${d.pred}:${d.succ}`),
    );
    log(`deps: ${remaining.length} remaining (${createdPairs.size} done, ${failedPairs.size} refused)`);
    for (const c of chunk(remaining, DEFAULT_BATCH_SIZE)) {
      await createDepsBisect(ctx, projectId, c, guidMap, LINK_TYPE[ctx.linkStyle], cache);
    }
    cache.checkpoint.depsPhaseDone = true;
    cache.checkpoint.phase = "deps";
    await writeCache(cache);
    log(`deps complete: ${cache.dependencyIds.length} created, ${cache.checkpoint.failedDeps.length} PSS-refused`);
    ctx.onStep?.("create leaf-to-leaf dependencies (bisect-isolating)", "add_tasks_batch", Date.now() - tD, `${cache.dependencyIds.length} created, ${cache.checkpoint.failedDeps.length} PSS-refused, ${skippedSummaryDeps} summary-linked skipped`);
  }

  // ── Leaf progress ──
  if (!cache.checkpoint.progressPhaseDone) {
    const tP = Date.now();
    const items = planProgressItems(fixture);
    let done = 0;
    for (const c of chunk(items, DEFAULT_BATCH_SIZE)) {
      const usable = c.filter((it) => guidMap.has(it.taskNumber));
      if (!usable.length) continue;
      await applySession(ctx, projectId, async (opSet) => {
        await ctx.call("update_tasks", {
          operationSetId: opSet,
          projectId,
          tasks: usable.map((it) => ({ taskId: guidMap.get(it.taskNumber), progressPercent: it.progressPercent })),
        });
      });
      done += usable.length;
    }
    cache.checkpoint.progressPhaseDone = true;
    cache.checkpoint.phase = "progress";
    await writeCache(cache);
    log(`progress set on ${done} leaf tasks`);
    ctx.onStep?.(`set progress on ${done} leaf tasks`, "update_tasks", Date.now() - tP, `${done} leaf tasks updated`);
  }

  cache.checkpoint.phase = "complete";
  await writeCache(cache);
  return cache;
}

/** Create a dependency chunk; on apply failure, split in half and recurse to
 * isolate the deps PSS refuses (recorded in failedDeps, not retried). */
async function createDepsBisect(
  ctx: BuildCtx,
  projectId: string,
  deps: DepItem[],
  guidMap: Map<number, string>,
  linkVals: Record<string, number>,
  cache: SeedCache,
): Promise<void> {
  const failedPairs = new Set(cache.checkpoint.failedDeps.map((f) => `${f.pred}:${f.succ}`));
  const usable = deps.filter(
    (d) => guidMap.has(d.pred) && guidMap.has(d.succ) && !failedPairs.has(`${d.pred}:${d.succ}`),
  );
  if (usable.length === 0) return;

  const ids = usable.map(() => randomUUID());
  const entities = usable.map((d, i) => ({
    "@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttaskdependency",
    msdyn_projecttaskdependencyid: ids[i],
    "msdyn_Project@odata.bind": `/msdyn_projects(${projectId})`,
    "msdyn_PredecessorTask@odata.bind": `/msdyn_projecttasks(${guidMap.get(d.pred)})`,
    "msdyn_SuccessorTask@odata.bind": `/msdyn_projecttasks(${guidMap.get(d.succ)})`,
    msdyn_projecttaskdependencylinktype: linkVals[d.type] ?? linkVals.FS,
  }));

  try {
    await applySession(ctx, projectId, async (opSet) => {
      await ctx.call("add_tasks_batch", { operationSetId: opSet, entities });
    });
    cache.dependencyIds.push(...ids);
    (cache.dependencyPairs ??= []).push(...usable.map((d) => `${d.pred}:${d.succ}`));
    await writeCache(cache);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Transient network failure → abort the build so it resumes; do NOT mark deps
    // as permanently refused (that was the over-aggressive bug).
    if (TRANSIENT.test(msg)) throw err;
    if (usable.length === 1) {
      cache.checkpoint.failedDeps.push({ pred: usable[0].pred, succ: usable[0].succ, error: msg.slice(0, 120) });
      await writeCache(cache);
      return;
    }
    const mid = Math.floor(usable.length / 2);
    await createDepsBisect(ctx, projectId, usable.slice(0, mid), guidMap, linkVals, cache);
    await createDepsBisect(ctx, projectId, usable.slice(mid), guidMap, linkVals, cache);
  }
}
