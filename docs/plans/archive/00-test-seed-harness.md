# 00 — Seed-Once / Reuse-Many E2E Self-Test Harness

Status: PROPOSED (architecture / planning only)
Branch context: `feat/pm-feature-suite`
Author role: Architect (test infrastructure)
Scope of this doc: design only. The only file this plan itself writes is this
markdown. Implementation lands in later, separately-reviewed changes.

---

## 1. Context

### What exists today

The repo has **two** live-tenant e2e drivers, both continue-on-failure and both
emitting a markdown report:

- `test/e2e/runner.ts` (`npm run e2e`) — a 4-phase fast run (preflight → read
  sweep → optional write lifecycle → guardrails → optional agentic). Reuses
  `steps.ts` (`step`/`guardStep`/`assert` + a module-level `stepLog`), `verify.ts`
  (independent OData oracle), `mcpClient.ts` (`mcpCall`/`mcpInitialize`/
  `mcpToolNames`), `report.ts` (`renderReport`), `config.ts` (Zod env), and
  `scenarios/*.ts` (`preflight`, `readSweep`, `lifecycle`, `guardrails`).
- `test/e2e/pm-acceptance.ts` (run directly with `tsx`) — an 871-line, 6-phase
  comprehensive run (A build-at-scale … F cleanup) that **rebuilds the entire
  642-task `it-planner-board.json` board on every run (~4 min)**, verifies it, runs
  PM operations, exercises guardrails, then deletes (or keeps on failure) a
  disposable `ZZ-MCP-PMTEST-*` plan. It has its **own** local `step`/`expectReject`/
  `rec` recorder (not `steps.ts`) and its own report renderer.

Reusable building blocks already proven in `pm-acceptance.ts` we will lift, **not
re-invent**:

- **Level-by-level task creation** (breadth-first by outline depth) — required
  because PSS auto-nests a parentless task under an existing task when the plan is
  non-empty (`pm-acceptance.ts` lines ~318-364).
- **Bisect-on-failure** dependency creation (`createDepBatch`, lines ~394-417):
  on a failed PSS operation set, split the batch in half and recurse to isolate
  the bad link(s) in O(failures·log n) applies. This is the seed of our resume logic.
- **Leaf/summary partitioning** and **summary-linked-dependency skipping**
  (PSS rejects links touching a summary task).
- **Keep-plan-on-failure** convention (lines ~762-777): a failing run keeps the
  plan so it can be inspected/re-tested without a 4-minute rebuild; `KEEP_PLAN=1`
  also forces keep.

Independent oracle helpers in `test/e2e/verify.ts`: `verifyTaskCount(projectId,
bearer)`, `verifyTaskField(taskId, field, bearer)`, `verifyTaskDeleted(taskId,
bearer)` — all do **direct Dataverse OData GETs with the delegated bearer**, so a
bug in the MCP server can't mask a failed write. These are the correctness oracle
and every scenario asserts through them.

The MCP tool surface (exact registered names, from `src/tools/index.ts`):

- **Read-only (RO):** `find_plan_by_name`, `find_team_member`,
  `get_plan_tasks_and_buckets`, `check_change_session_status`, `whoami`,
  `list_plans`, `list_my_tasks`, `get_plan_summary`, `get_task`, `list_plan_tasks`,
  `get_bucket_breakdown`, `list_dependencies`, `list_team_members`,
  `describe_option_set`.
- **Additive writes (ADD):** `create_plan`, `add_bucket`, `add_sprint`,
  `add_tasks`, `add_tasks_batch`, `start_change_session`.
- **Updates (UPDATE, overwrite):** `update_tasks`, `update_tasks_batch`.
- **Destructive:** `apply_changes`, `cancel_change_session`, `delete_tasks_batch`
  (requires `confirmed:true`; whole-plan delete hard-blocked).

`pageAll` lives in `src/tools/readHelpers.ts` but pages via `dvReq` (server config
+ standing token) — it is a **server-side** helper used *inside* the MCP tools. The
e2e oracle cannot call it with the delegated bearer; the oracle paginates through
its own `dvGet` in `verify.ts`. The plan respects that boundary (we extend
`verify.ts`, we do not import `pageAll` into e2e).

### The problem

Every comprehensive run recreates ~642 tasks (~4 min) and never reuses the board.
We are about to add a large suite of new features (read analytics, write actions,
production-ops) that each need self-testing **at scale** against a realistic board
(hundreds of tasks, deep hierarchy, real dependencies). Rebuilding the board per
feature per run is unaffordable and, worse, a mid-build failure currently throws
away all prior work.

### Product-owner intent (verbatim)

- "tests should be efficient, and not all the time create again 500 tasks if
  something goes wrong, but continue and optimize adhoc"
- "self test for all newly implemented features, that consider everything a project
  manager might do when using the MCP with Planner Premium, considering a place with
  hundreds of tasks and levels like it-planner-board.json"
- results "checked by QA agent and security".

---

## 2. Goals / Acceptance criteria

**G1 — Seed once, reuse many.** A stable, named seed plan
(`ZZ-MCP-SEED-itboard`) is built from the fixture **at most once**. Subsequent runs
detect it (by name) + validate a cache and **skip the rebuild** entirely. A warm
run reaches "board ready" in seconds, not minutes.

**G2 — Resumable / ad-hoc build.** If a cold build fails partway (network blip, one
bad batch), the next run **continues from the last good checkpoint** (per-level,
per-batch, plus a dependency phase + progress phase) rather than recreating the
whole board. A single failure never forces a full 642-task rebuild.

**G3 — Feature self-test registry.** Each new feature ships one scenario module
`test/e2e/scenarios/<feature>.ts` exporting a uniform signature. A registry lists
them. Read-only scenarios run with **zero writes**. Write scenarios run against a
**scratch sandbox** and never corrupt the shared seed. Each scenario asserts via
**both** the MCP tool **and** the independent OData oracle.

**G4 — Continue-on-failure + report.** The orchestrator keeps going past failures,
aggregates results in the existing `stepLog`, and emits a markdown report in the
`pm-acceptance` style. New env flags (`REUSE_SEED`, `REBUILD_SEED`, `FEATURE=`,
`KEEP_PLAN`, `SEED_PLAN_NAME`) are honoured.

**G5 — Pure, unit-tested core.** Cache validation, checkpoint/resume planning, and
fixture→batch planning are **pure functions** in `test/e2e/seed/` with **vitest
unit tests in `test/`** that run under `npm test` with **no network**.

**G6 — Reuse, don't duplicate.** Reuse `step`/`guardStep`/`assert`/`stepLog`,
`verify*`, `mcpCall`/`mcpInitialize`, `renderReport`, `getConfig`, and the proven
level-by-level + bisect patterns. `pm-acceptance.ts` is refactored to **delegate**
the build to the shared seed builder (its build logic moves into the builder),
not copied.

**G7 — Security/QA gates.** `npm run typecheck`, `npm run typecheck:e2e`, and
`npm test` stay green (Stop hook enforces). No guardrail weakened. No secret read,
logged, or committed. New cache file is gitignored (it carries customer task names
+ GUIDs). A QA/security agent reviews the report and the diff.

**Done when:** cold run builds the seed and caches it; a second run skips the build
(verified by a "seed reused (cache hit)" report line); killing a cold build
mid-level and re-running resumes from the checkpoint; `FEATURE=<x>` runs only that
scenario against the warm seed; `npm test` covers the pure functions; all
green-gates pass.

---

## 3. Seed cache design

### 3.1 The seed plan

- **Name:** `ZZ-MCP-SEED-itboard` (override via `SEED_PLAN_NAME`). Distinct prefix
  from the disposable `ZZ-MCP-E2E-*` / `ZZ-MCP-PMTEST-*` plans so
  `scripts/cleanup-e2e-plans.ts` does **not** sweep it away. (See §9 — cleanup must
  learn to leave `ZZ-MCP-SEED-*` alone unless explicitly asked.)
- **Content:** built from `test/e2e/fixtures/it-planner-board.json` using the exact
  level-by-level + bisect logic already in `pm-acceptance.ts`, moved into the shared
  builder.
- **Lifecycle:** long-lived. Never auto-deleted. Rebuilt only on `REBUILD_SEED=1`
  or when the cache's content hash no longer matches the fixture.

### 3.2 The cache file

`.e2e-seed-cache.json` in the project root (gitignored). It records what was built,
the GUID maps needed to reuse it without re-reading the whole board, and the
checkpoint state for resume. JSON shape:

```jsonc
{
  "version": 1,                       // bump to invalidate on schema change
  "seedPlanName": "ZZ-MCP-SEED-itboard",
  "projectId": "<guid>",              // null until create_plan succeeds
  "orgUrl": "https://contoso.crm4.dynamics.com",  // guard against cross-org reuse
  "fixtureHash": "sha256:…",          // hash of canonicalized fixture content (see 3.3)
  "fixtureTaskCount": 642,            // expected total (fast invalidation check)
  "linkTypeStyle": "eu",              // EU/CRM4 vs global option values — must match tenant
  "builtAtUtc": "2026-06-21T12:00:00Z",
  "buckets": { "SAP": "<bucketGuid>", "(Unbucketed)": "<bucketGuid>", "...": "..." },
  "taskGuidByNumber": { "1": "<guid>", "2": "<guid>", "...": "..." },  // fixture taskNumber → Dataverse GUID
  "dependencyIds": ["<guid>", "..."], // created msdyn_projecttaskdependency ids
  "summaryTaskNumbers": [140, 9, 3],  // parents (have children) — for safe-write targeting
  "checkpoint": {
    "phase": "complete",              // see 3.4 for the phase enum
    "lastLevelDone": 5,               // highest hierarchy level fully persisted
    "tasksPersisted": 642,
    "depsPhaseDone": true,
    "progressPhaseDone": true,
    "failedDeps": [ { "pred": 12, "succ": 141, "error": "…" } ]  // PSS-refused, recorded not retried
  },
  "scratch": {                        // safe-write sandbox (see 5.3), recreated per run if absent
    "bucketId": "<guid>|null",
    "subtreeRootTaskId": "<guid>|null",
    "createdTaskIds": []              // tracked so a run can clean up its own scratch
  }
}
```

### 3.3 Fixture hash (content identity)

`fixtureHash` is a SHA-256 over a **canonicalized projection** of the fixture — only
the fields the seed actually materializes (`taskNumber`, `outline`, `name`,
`bucket`, `start`, `finish`, `effortHours`, `priority`, `parentTaskNumber`,
`dependsOn`, leaf `progressPercent`), sorted by `taskNumber`, `JSON.stringify`'d
deterministically. This means **cosmetic fixture edits that don't change the
built board don't force a rebuild**, but a structural change does. Computed by a
pure function (`hashFixture`, §7) so it's unit-testable offline.

### 3.4 Cache validation (cold vs warm decision)

On run start, `validateSeedCache(cache, fixture, liveProbe)` (pure given the probe
result) returns one of:

- **`reuse`** — cache exists, `version` matches, `orgUrl` matches current,
  `fixtureHash` matches, `checkpoint.phase === "complete"`, **and** the live probe
  (`verifyTaskCount(projectId)` + plan-exists GET) reports `count === fixtureTaskCount`.
  → skip build entirely; load GUID maps from cache. Emits report line
  `seed reused (cache hit) — projectId=… 642 tasks`.
- **`resume`** — cache exists and `projectId` is set, but `checkpoint.phase !==
  "complete"` or the live count is `< fixtureTaskCount`. → run the builder in
  resume mode from `checkpoint` (§4).
- **`rebuild`** — no cache, `version`/`orgUrl`/`fixtureHash` mismatch, the named
  plan doesn't exist live, or `REBUILD_SEED=1`. → build cold (and, if a stale seed
  plan with the same name exists from a different fixture, the run **stops and asks**
  rather than mutating someone else's seed; `REBUILD_SEED=1` is the explicit override
  that deletes-then-rebuilds via direct OData).

`liveProbe` is the only impure input; `validateSeedCache` itself is pure (cache +
fixture + probe-result in → decision out) and unit-tested.

`REUSE_SEED=1` (default behaviour) prefers reuse/resume; `REUSE_SEED=0` forces a
fresh disposable plan per run (the legacy `pm-acceptance` behaviour, kept as an
escape hatch).

---

## 4. Resume / checkpoint design

The builder is a **phase machine**; each phase advances the cache checkpoint and
the cache is **written after every successful batch** (atomic write: temp file +
rename) so a crash leaves a valid, resumable cache.

Phase enum (stored in `checkpoint.phase`):

```
plan → buckets → tasksL1 → tasksL2 → … → tasksLmax → deps → progress → complete
```

`planResumeBuild(fixture, cache)` (pure) computes, from the cache checkpoint + the
fixture, the **remaining work**: which levels still need tasks, which task numbers
already have GUIDs (skip them), whether deps/progress phases are pending. Returns an
ordered list of batch descriptors. Unit-tested with synthetic caches.

Per-phase resume rules:

- **plan / buckets:** idempotent re-check. If `projectId` set and a live GET
  confirms the plan, skip create. For buckets, reuse `cache.buckets`; create only
  names missing from the live `get_plan_tasks_and_buckets` read.
- **tasks (per level, per batch ≤190):** before creating a level, reconcile against
  the cache: any `taskNumber` already in `taskGuidByNumber` is skipped. A level is
  marked done (`lastLevelDone`) only when **all** its tasks have GUIDs in the cache
  and have been confirmed persisted (`verifyTaskCount` rises as expected). The
  proven invariant — roots first in an empty plan, deeper levels carry an explicit
  parent GUID — is preserved; on resume, parent GUIDs come from the cache, so a
  resumed deeper level still passes its explicit parent.
- **deps:** uses the existing **bisect-on-failure** `createDepBatch`. Already-created
  dependency ids (in `cache.dependencyIds`) are skipped by id-set diff; PSS-refused
  links go to `failedDeps` (recorded, **not** retried — they are structurally
  invalid). Resume re-attempts only deps whose id is not yet in the cache.
- **progress:** leaf-only progress updates, batched; on resume, re-applying is
  idempotent (setting a leaf to the same percent is a no-op outcome), so the whole
  phase can simply re-run if not marked done — cheap and safe.

A mid-level kill → re-run reconciles the cache against a live read, fills only the
gaps, and continues. The "run what is able to run, fast even when failures are
dense" philosophy from the dependency bisect is generalized to the whole build.

**Self-healing drift:** if the warm-path live probe finds `count <
fixtureTaskCount` (someone deleted tasks out-of-band), the decision degrades from
`reuse` to `resume` and the gaps are refilled — the seed is **self-repairing**.

---

## 5. Self-test registry & safe-write pattern

### 5.1 Scenario contract

Each feature ships `test/e2e/scenarios/<feature>.ts` exporting:

```ts
export interface SeedScenarioCtx extends StepContext {  // {mcpUrl, bearer}
  projectId: string;                 // the warm seed plan
  bearer: string;
  orgUrl: string;
  taskGuidByNumber: Map<number, string>;
  buckets: Map<string, string>;
  summaryTaskNumbers: number[];
  scratch: ScratchSandbox;           // see 5.3 — write scenarios use this
}

export interface SeedScenario {
  name: string;                      // e.g. "critical-path"
  feature: string;                   // FEATURE= filter value
  mode: "read" | "write";           // read = zero writes; write = scratch only
  tools: string[];                   // exact MCP tool names this exercises (for the report)
  run(ctx: SeedScenarioCtx): Promise<void>;  // uses step()/guardStep()/assert + verify*
}
```

A registry array `test/e2e/scenarios/registry.ts` lists every `SeedScenario`. The
orchestrator filters by `FEATURE=` (default: all) and runs each in registration
order, recording into the shared `stepLog`.

### 5.2 Read-only scenarios

`mode: "read"` scenarios call only RO tools (`get_plan_summary`,
`get_bucket_breakdown`, `list_dependencies`, `get_plan_tasks_and_buckets`,
`list_plan_tasks`, `get_task`, `list_my_tasks`, `find_plan_by_name`, …) against the
seed, and cross-check every claim against `verify.ts` (e.g. an analytics tool's task
count vs `verifyTaskCount`; an overdue-filter vs a direct OData `$filter` on
`msdyn_scheduledend`). A read scenario that issues any write is a **bug** — a
lightweight guard in the orchestrator wraps read scenarios and fails them if the
live `verifyTaskCount` changes across the scenario.

### 5.3 Safe-write pattern (the core safety design)

Write scenarios must **never corrupt the shared seed**. Two complementary,
mandatory mechanisms:

1. **Scratch sandbox (default for create/delete features).** On first write-scenario
   run, the harness creates — once, recorded in `cache.scratch` —
   a dedicated bucket `ZZ-SCRATCH` and a single scratch **subtree** under one root
   task `ZZ-SCRATCH-ROOT` inside the seed plan. Write scenarios that **add** tasks,
   buckets, sprints, dependencies, checklists, assignees, etc. create them under the
   scratch bucket/subtree and track every created GUID in `scratch.createdTaskIds`.
   After the scenario (and again at run end) the harness deletes everything in
   `scratch.createdTaskIds` via `delete_tasks_batch` (confirmed) — leaving the 642
   real tasks untouched. The scratch subtree root itself is long-lived and reused.

2. **Snapshot-then-restore (for update features that must touch a real task).** When
   a feature can only be exercised on an existing seed task (e.g. "reschedule a
   real task and verify rollup"), the scenario:
   - picks a **designated, documented** seed task (a leaf with no dependents,
     chosen deterministically — e.g. the lowest `taskNumber` leaf in a specific
     "sacrificial" bucket reserved in the fixture, or the scratch subtree),
   - **snapshots** the fields it will change via `verifyTaskField` (or
     `get_task`) **before** the write,
   - performs the write + asserts via tool **and** OData oracle,
   - **restores** the snapshotted field values via `update_tasks` in a `finally`,
   - asserts the restore via the oracle.

   Restore is best-effort-then-verified: if restore fails, the scenario records a
   **`fail`** (so the report flags a dirtied seed) and adds a leftover note so the
   operator/QA knows the seed needs a `REBUILD_SEED=1`. Summary-task rolled-up
   fields are **never** chosen as snapshot targets (the guardrail rejects them
   anyway — that's a guardrail scenario, not a safe-write target).

Rule of thumb baked into the contract docs: **prefer the scratch sandbox; use
snapshot-restore only when the feature semantically requires an existing task; never
mutate a summary task's rolled-up fields.**

### 5.4 What "everything a PM might do" covers (initial scenario set)

Read: plan health/summary, bucket breakdown, dependency map / critical-path-ish
reads, overdue/milestone filters, "my tasks", deep-hierarchy navigation, team
roster. Write (scratch/snapshot): add a sub-project under scratch, reschedule +
verify rollup, re-bucket, re-prioritise, progress rollup, add/delete task,
checklist+sprint+assignee on a scratch task, dependency add/remove on scratch leaves.
Guardrails: the full negative battery already in `pm-acceptance.ts` Phase D
(200-cap, summary protection, confirm gate, whole-plan block, bind alias,
parent-after-child, invalid GUID, null-date) — run against the seed read-only.

---

## 6. Files to create / modify

### CREATE

| File | Purpose |
|---|---|
| `test/e2e/seed/hashFixture.ts` | **Pure.** Canonicalize + SHA-256 the fixture projection. |
| `test/e2e/seed/cache.ts` | Cache read/write (atomic temp+rename), `validateSeedCache` (pure decision given live-probe result), types for the cache JSON. |
| `test/e2e/seed/planBuild.ts` | **Pure.** `planResumeBuild(fixture, cache)` + `fixtureToBatches(fixture)` → ordered batch descriptors (level-by-level, ≤190, leaf/summary split, createable-deps filter). |
| `test/e2e/seed/builder.ts` | The phase machine. Consumes batch descriptors; calls MCP via `mcpCall` and the proven level-by-level + bisect logic (moved from `pm-acceptance.ts`); writes cache after each batch; resumes from checkpoint. The only network-touching seed module. |
| `test/e2e/seed/scratch.ts` | Scratch-sandbox lifecycle: ensure scratch bucket+subtree, track created GUIDs, teardown. Snapshot/restore helpers for the update pattern. |
| `test/e2e/scenarios/registry.ts` | Array of `SeedScenario`s + `FEATURE=` filter. |
| `test/e2e/scenarios/seedReadAnalytics.ts` | First read-only scenario (exemplar of the contract). |
| `test/e2e/scenarios/seedWriteScratch.ts` | First write scenario (exemplar of the scratch + snapshot-restore pattern). |
| `test/e2e/seedRun.ts` | **New orchestrator** (`npm run e2e:seed`): boot/resolve server, init MCP, validate cache → reuse/resume/rebuild, run filtered scenarios, render report. Mirrors `pm-acceptance.ts`'s structure but builds via the shared builder. |
| `test/seed-cache.test.ts` | **Unit** (vitest, no network): `validateSeedCache` decision matrix. |
| `test/seed-planBuild.test.ts` | **Unit**: `planResumeBuild` + `fixtureToBatches` resume/partition logic. |
| `test/seed-hashFixture.test.ts` | **Unit**: hash stability + invalidation. |

### MODIFY (shared — see §8 for conflict coordination)

| File | Change |
|---|---|
| `package.json` | Add scripts: `"e2e:seed": "tsx test/e2e/seedRun.ts"`, optionally `"e2e:seed:reset": "REBUILD_SEED=1 tsx test/e2e/seedRun.ts"`. **No dep added.** |
| `test/e2e/config.ts` | Add env to the Zod schema: `REUSE_SEED` (bool, default true), `REBUILD_SEED` (bool, default false), `SEED_PLAN_NAME` (string, default `ZZ-MCP-SEED-itboard`), `FEATURE` (optional string). `KEEP_PLAN` already read ad-hoc in `pm-acceptance.ts`; promote it into the schema too. |
| `test/e2e/verify.ts` | Add oracle helpers the scenarios need but that don't exist yet: `verifyPlanExists(projectId, bearer)`, `verifyTasksByFilter(projectId, odataFilter, bearer)` (paginating via its own `dvGet`), `verifyBucketTaskCounts(projectId, bearer)`. Keep direct-OData-only; **do not** import server `pageAll`. |
| `test/e2e/pm-acceptance.ts` | Refactor Phase A to **delegate** to `seed/builder.ts` in `REUSE_SEED` mode (build-or-reuse the seed) instead of always creating a fresh `ZZ-MCP-PMTEST-*` plan. Keep its Phases B-F. The bisect/level logic it currently owns **moves** into `builder.ts`; `pm-acceptance.ts` imports it. (Behaviour-preserving: `REUSE_SEED=0` restores today's fresh-plan flow.) |
| `scripts/cleanup-e2e-plans.ts` | Teach it to **exclude** `ZZ-MCP-SEED-*` by default (so cleanup doesn't nuke the reusable seed), with an explicit `--include-seed` flag for intentional teardown. |
| `.gitignore` | Add `.e2e-seed-cache.json` (carries customer task names + GUIDs). |
| `test/e2e/fixtures/README.md` | Document the seed plan name, the cache file, the reuse/resume/rebuild flags, and the safe-write rule. |
| `README.md` | Add an "E2E seed harness" section (how to run, flags, NODE_OPTIONS prefix). |

### MUST NOT touch
`src/**` (no server change is needed — this is pure test infra), `.env*`, any
token, `package-lock.json`, `.claude/**`. (This plan doc is the only file the
planning step writes.)

---

## 7. Pure functions + unit tests

All pure functions live under `test/e2e/seed/` and are imported by both the builder
and the vitest unit tests. They take plain data in and return plain data out — **no
fetch, no fs, no `Date.now()` at call sites that matter** (timestamps are passed in).

| Pure function | Signature (intent) | Unit test asserts |
|---|---|---|
| `hashFixture(fixture)` | `Fixture → string` (sha256 of canonical projection) | identical for cosmetically-different fixtures with same built board; different when a task's parent/bucket/outline/deps change; stable across key ordering. |
| `validateSeedCache(cache, fixture, probe)` | `(Cache?, Fixture, {planExists,liveCount}) → "reuse"\|"resume"\|"rebuild"` | full decision matrix: no cache→rebuild; hash mismatch→rebuild; org mismatch→rebuild; complete+count-match→reuse; complete+count-short→resume; incomplete→resume; `REBUILD_SEED`→rebuild. |
| `fixtureToBatches(fixture, batchSize)` | `→ { levels: BatchDesc[][], deps: DepDesc[], progress: ProgDesc[] }` | level partition correct (L1 roots have no parent; deeper levels carry parent number); batches ≤ size; leaf/summary split correct; only leaf-to-leaf deps are createable (summary-linked filtered out). |
| `planResumeBuild(fixture, cache)` | `→ { remainingLevels, remainingDeps, needProgress, skippedTaskNumbers }` | given a cache with L1-L3 done, returns only L4-L5 + deps + progress; given complete cache, returns empty; given partial dep ids, returns only missing dep ids. |
| `diffScratchTeardown(scratch)` | `→ string[]` taskIds to delete | returns exactly the tracked created ids; empty when scratch unused. |

These live in `test/` so `npm test` (`LOG_LEVEL=silent vitest run`, vitest default
glob picks up `test/*.test.ts` — same place the existing `report.unit.test.ts`
lives) runs them with **no network**, satisfying the green-gate Stop hook fast.

---

## 8. How to run

> **NETWORK NOTE (this session — airplane + NordVPN):** every node command that
> hits Microsoft (Dataverse / Entra) **must** be prefixed with
> `NODE_OPTIONS='--no-network-family-autoselection --dns-result-order=ipv4first'`
> or `fetch` times out. Bake this into every live command below. The pure unit
> tests (`npm test`) need no network and no prefix.

### One-time / cold (builds + caches the seed)
```bash
export E2E_ACCESS_TOKEN=$(npx tsx --env-file .env scripts/get-dataverse-token.ts)
NODE_OPTIONS='--no-network-family-autoselection --dns-result-order=ipv4first' \
DATAVERSE_LINK_TYPE_STYLE=eu E2E_TOOL_TIMEOUT_MS=290000 \
  npx tsx --env-file .env test/e2e/seedRun.ts          # or: npm run e2e:seed
```

### Warm (skips the build — seconds)
```bash
export E2E_ACCESS_TOKEN=$(npx tsx --env-file .env scripts/get-dataverse-token.ts)
NODE_OPTIONS='--no-network-family-autoselection --dns-result-order=ipv4first' \
  npm run e2e:seed        # cache hit → "seed reused" → runs scenarios only
```

### One feature only (warm)
```bash
NODE_OPTIONS='--no-network-family-autoselection --dns-result-order=ipv4first' \
  FEATURE=critical-path npm run e2e:seed
```

### Force a clean rebuild of the seed
```bash
NODE_OPTIONS='--no-network-family-autoselection --dns-result-order=ipv4first' \
  REBUILD_SEED=1 npm run e2e:seed     # or npm run e2e:seed:reset
```

### Pure unit tests (no network, fast green-gate)
```bash
npm test            # picks up test/seed-*.test.ts
npm run typecheck && npm run typecheck:e2e
```

### Cleanup (leaves the seed alone)
```bash
NODE_OPTIONS='--no-network-family-autoselection --dns-result-order=ipv4first' \
  npx tsx --env-file .env scripts/cleanup-e2e-plans.ts        # ZZ-MCP-E2E-*/PMTEST-* only
# intentional teardown of the seed:
NODE_OPTIONS='…' npx tsx --env-file .env scripts/cleanup-e2e-plans.ts --include-seed
```

---

## 9. Shared-file touchpoints & conflicts

These files are likely edited by **other** feature architects in parallel — flag
and coordinate:

- **`test/e2e/config.ts`** — additive Zod fields only (`REUSE_SEED`, `REBUILD_SEED`,
  `SEED_PLAN_NAME`, `FEATURE`, `KEEP_PLAN`). Append to the schema; trivially
  mergeable but two PRs touching the same object can textually conflict. **Land this
  harness first** so others extend a known schema.
- **`test/e2e/verify.ts`** — additive oracle helpers. Pure-append; low conflict risk
  but other write features may also want oracle helpers here — agree on names
  (`verifyPlanExists`, `verifyTasksByFilter`, `verifyBucketTaskCounts`).
- **`test/e2e/pm-acceptance.ts`** — **highest-risk shared file.** We move its
  build/bisect/level logic into `seed/builder.ts` and rewire Phase A to delegate.
  Any other PR editing `pm-acceptance.ts` build phase will conflict. Mitigation:
  land the builder extraction as its own small PR **before** new features touch it;
  keep `pm-acceptance.ts` behaviour identical under `REUSE_SEED=0`.
- **`package.json` scripts** — adding `e2e:seed*`. Tiny, but the scripts block is a
  common conflict point; keep the diff to the two new lines.
- **`scripts/cleanup-e2e-plans.ts`** — adding the `ZZ-MCP-SEED-*` exclusion. Anyone
  else editing cleanup must preserve this exclusion or they'll delete the seed and
  re-impose the 4-minute build cost on the whole team.
- **`.gitignore`** — one line (`.e2e-seed-cache.json`). Coordinate so it isn't
  dropped in a merge — committing the cache would leak customer task names + GUIDs.
- **`README.md` / `test/e2e/fixtures/README.md`** — doc sections; low risk.

**No `src/**` change** is proposed, so this harness does not collide with feature
implementation PRs in the server — only with other **test-infra** PRs.

---

## 10. Sequencing

1. **(this) builder extraction + seed cache + pure functions + unit tests** — land
   first; it's foundational and touches the shared `pm-acceptance.ts`/`config.ts`/
   `verify.ts`. Green-gate: `npm test` + both typechecks.
2. Wire `seedRun.ts` orchestrator + the two exemplar scenarios + registry.
3. Each subsequent feature adds **one** `scenarios/<feature>.ts` + registry entry +
   (if it has pure logic) its own unit test. No further shared-file churn.
4. QA/security review reads the generated markdown report (code-asserted verdicts,
   never AI summaries) and the diff; confirms no guardrail weakened, the cache is
   gitignored, no token logged.

---

## 11. Risks & open questions

- **R1 — `pm-acceptance.ts` refactor regression.** Moving its build logic risks
  behaviour drift. *Mitigation:* extract verbatim into `builder.ts`; keep
  `REUSE_SEED=0` path byte-for-byte equivalent; the existing Phase B read-back
  assertions act as the regression check on a fresh build.
- **R2 — Stale/poisoned seed.** A half-broken seed could make every feature scenario
  fail. *Mitigation:* warm-path live probe + self-healing resume; `REBUILD_SEED=1`
  one-liner; report always prints the seed projectId + age.
- **R3 — Cross-org / cross-tenant reuse.** A cache from org A used against org B
  would point at non-existent GUIDs. *Mitigation:* `orgUrl` and `linkTypeStyle` in
  the cache are part of `validateSeedCache`; mismatch → rebuild.
- **R4 — Scratch leak.** A crashed write scenario could leave scratch tasks behind.
  *Mitigation:* `scratch.createdTaskIds` tracked in the cache; run-start and run-end
  teardown both sweep it; scratch lives under one named subtree so a human can spot
  and delete it.
- **R5 — Snapshot-restore failure dirties the seed.** *Mitigation:* restore verified
  via oracle; failure → scenario fails + leftover note → operator rebuilds. Prefer
  scratch over snapshot wherever the feature allows.
- **R6 — Concurrent runs racing on one seed.** Two simultaneous runs could corrupt
  the shared scratch. *Mitigation (open):* a simple cache lock field
  (`lockedByUtc` / pid) or documented "one run at a time". **Open question for the
  owner:** is concurrent e2e expected? If yes, scratch must be per-run-namespaced
  (e.g. `ZZ-SCRATCH-<runid>`), not shared.
- **Open Q1:** Does the fixture contain a deterministically-safe "sacrificial" leaf
  for snapshot-restore, or should the harness reserve a dedicated bucket in the seed
  for that? (Leaning: reserve a scratch subtree and avoid snapshot-restore on real
  tasks except where a feature truly needs a real, dependency-bearing task.)
- **Open Q2:** Should the warm-path live probe be a cheap `verifyTaskCount` only, or
  also spot-check a few GUIDs from the cache still resolve (catch partial deletes
  more precisely) at the cost of a few extra GETs? (Leaning: count + plan-exists by
  default; add `--deep-verify` for the thorough probe.)
- **Open Q3:** `linkTypeStyle` — confirm the EU/CRM4 option values
  (`LINK_TYPE_EU = {FF:0, FS:1, SF:2, SS:3}`) are the only style we target, or
  whether the cache must support a global-tenant style too.
```
