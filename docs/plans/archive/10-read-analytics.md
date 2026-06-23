# 10 — Read / Analytics Feature Suite (Critical Path, Schedule Health, Resource Workload, Extended Fields, Capability Cache)

**Status:** PLAN ONLY. This document is the only file the planning step writes.
**Branch context:** `feat/pm-feature-suite`.
**Author role:** Architect for the READ/ANALYTICS surface. No `src/`, `test/`, or
other file is touched by the planning step.

This plan covers six items a PM needs for visibility on a board of hundreds of
tasks:

1. `get_critical_path` — longest dependency chain + per-task total float.
2. `get_schedule_health` — overdue / at-risk / blocked / milestone / slip rollup.
3. `get_resource_workload` — per-team-member effort & overdue rollup.
4. `list_plan_tasks` extended fields (TODO item 1) — `remainingEffortHours`,
   `durationHours`, `actualStart`, `actualFinish` with try-then-fallback.
5. Schema capability cache (TODO Infrastructure item) — cache the extended-field
   probe so `get_task` and `list_plan_tasks` don't pay a fallback round-trip per call.
6. `list_dependencies` 404-fallback (TODO item 2) — **already implemented and
   tested** (see §6); this is a verification + small hardening item, not a new build.

---

## 0. Ground truth established by reading the code

Read before planning (exact field names taken from these, **not** invented):

- **`src/tools/readHelpers.ts`** — `pageAll(url, headers, maxPages=10)` →
  `{rows, pages, truncated}`; `readHeaders()` (maxpagesize=1000 + FormattedValue);
  `summariseTasks(tasks, now)` → `TaskRollup`; `nowIso()`; `linkTypeLabel(v)` +
  `LINK_TYPE_LABELS` (both 192350000-range and EU 0-3 range); `decodeDataverseText`;
  `RawTask` (`msdyn_projecttaskid`, `msdyn_subject?`, `msdyn_ismilestone?`,
  `msdyn_finish?`, `msdyn_progress?`, `_msdyn_parenttask_value?`).
- **`src/tools/listDependencies.ts`** — dependency entity SET is the **plural**
  `msdyn_projecttaskdependencies`. Columns:
  `_msdyn_predecessortask_value`, `_msdyn_successortask_value`,
  `msdyn_projecttaskdependencylinktype`, `msdyn_projecttaskdependencylinklag`.
  Project filter: `_msdyn_project_value eq <guid>`. **404 ⇒ graceful degrade**
  (returns `{ok:true, count:0, dependencies:[], warnings:[…]}`) — lines 40-47.
- **`src/tools/listPlanTasks.ts`** — task fields:
  `msdyn_projecttaskid`, `msdyn_subject`, `msdyn_description`, `msdyn_start`,
  `msdyn_finish`, `msdyn_progress` (0-1 fraction), `msdyn_effort`,
  `msdyn_outlinelevel`, `msdyn_displaysequence`, `msdyn_ismilestone`,
  `msdyn_priority`, `_msdyn_projectbucket_value`, `_msdyn_parenttask_value`,
  `_msdyn_projectsprint_value`; expands `msdyn_projectbucket($select=msdyn_name)`,
  `msdyn_parenttask($select=msdyn_subject)`. **Summary = a task other tasks name as
  parent** (`_msdyn_parenttask_value`). `progressPercent = round(msdyn_progress*100)`.
- **`src/tools/getTask.ts`** — **extended fields**
  `msdyn_remainingeffort, msdyn_duration, msdyn_actualstart, msdyn_actualfinish`
  behind a try-then-fallback: select CORE+EXTENDED; on `status===400` AND
  `/could not find a property named/i` retry CORE only; sets `hasExtended=false`.
  Resource assignments: `msdyn_resourceassignments?$select=msdyn_resourceassignmentid,`
  `_msdyn_taskid_value,_msdyn_projectteamid_value,_msdyn_projectid_value`
  `&$expand=msdyn_projectteamid($select=msdyn_name)&$filter=_msdyn_taskid_value eq <guid>`.
- **`src/tools/getPlanSummary.ts`** — plan row fields `msdyn_scheduledstart`,
  `msdyn_finish`, `msdyn_progress`, `msdyn_effort`, `msdyn_effortcompleted`,
  `msdyn_effortremaining` (env-dependent, degrade on 400). Pattern of one paginated
  task scan + `summariseTasks`.
- **`src/tools/listTeamMembers.ts`** — team set `msdyn_projectteams?$select=`
  `msdyn_projectteamid,msdyn_name,_msdyn_bookableresourceid_value&$filter=_msdyn_project_value eq <guid>`.
- **`src/dataverse.ts`** — `dvReq({url,method,headers,body?},{retry?})` → `{status,json}`
  (never throws on HTTP-error status; throws on transport/timeout); `dvHeaders()`;
  `dvErrorMessage(res)`; `assertGuid(value,label)` (canonical GUID or throw);
  `isGuid(s)`.
- **`src/tools/types.ts`** — `ToolDef { name, title, description, inputSchema:ZodRawShape, handler }`.
- **`src/tools/index.ts`** — `allTools[]` registry + `toolAnnotations`; reads use
  `const RO = { readOnlyHint: true, openWorldHint: true }`.
- **`src/server.ts`** — `SERVER_INSTRUCTIONS` (lines 15-33). Read tools are described
  collectively; the structural-write framing dominates.
- **`README.md`** — tool table at **lines 83-109** (header
  `| Tool (MCP name) | Description |` then `|---|---|`), tool count `25 tools` at
  **line 32** and **line 272**; `## Open TODOs` at **lines 310-342**.

**Engine-scheduled dates.** `msdyn_start` / `msdyn_finish` on a leaf task are
PSS-scheduled (calendars, working days already accounted for). The critical-path
core therefore **trusts those as early start / early finish** and never recomputes
the forward pass from durations + calendars (we have no calendar). This is the key
simplification: the forward pass is read off the engine, only the backward pass
(late dates → float) is computed by us.

**Unit-test conventions observed** (two distinct patterns, both used here):
- *Pure-core test* (e.g. `test/readHelpers.test.ts`, `test/buildTasks.test.ts`):
  import the pure function, feed hand-built data + injected `now`, assert the result.
  No env, no network. This is the primary test surface for the analytics cores.
- *Handler test with fetch mock* (e.g. `test/listDependencies.test.ts`,
  `test/listMyTasks.test.ts`): set `process.env` (`DATAVERSE_ORG_URL`, `LOG_LEVEL=silent`,
  `AUTH_MODE=insecure-passthrough`, `DATAVERSE_LINK_TYPE_STYLE`), `resetEnvCache()`,
  run inside `requestContext.run({bearer:"test-token"}, fn)`, `vi.spyOn(globalThis,"fetch")`
  routed by URL substring. Used here for the thin-handler fallback + capability-cache tests.

---

## 1. `get_critical_path`

### 1.1 Context
A PM on a 600-task board needs to know which chain of tasks drives the plan end
date and which tasks have slack. PSS already schedules `msdyn_start`/`msdyn_finish`;
we layer a **backward pass over the dependency DAG of leaf tasks** to derive late
dates and total float, then surface the zero-float chain. Summary (parent) tasks
are excluded — their dates roll up from children and would double-count.

### 1.2 Tool contract
- **name:** `get_critical_path`
- **title:** `Get Critical Path`
- **description (guardrail/usage prose):** "Returns the critical path of a plan: the
  chain of leaf tasks with ~zero total float that drives the plan finish date, plus
  per-task total float (slack) in working days. Trusts the PSS-scheduled
  start/finish dates; computes late dates by a backward pass over the dependency
  graph (FS links are modelled exactly; SS/FF/SF are modelled where dates allow and
  flagged in warnings). Summary/parent tasks are excluded. If dependency links are
  unavailable on this environment, returns an empty path with a warning. If
  truncated=true the task scan was incomplete and the result is a lower bound."
- **inputSchema:**
  ```ts
  {
    projectId: z.string().describe("GUID of the plan (msdyn_projectid)."),
    floatToleranceDays: z.number().optional()
      .describe("Total-float threshold (working days) at/below which a task is 'critical'. Default 0.5."),
    nearCriticalDays: z.number().optional()
      .describe("Tasks with float <= this (but above the critical tolerance) are counted as near-critical. Default 2."),
  }
  ```
- **output shape:**
  ```ts
  {
    ok: true,
    projectId: string,
    projectStart: string | null,        // min early start over leaf tasks
    projectFinish: string | null,       // max early finish over leaf tasks
    totalDurationDays: number | null,   // calendar-day span projectStart..projectFinish
    criticalPath: Array<{
      taskId: string, subject: string | null,
      start: string | null, finish: string | null,  // engine (early) dates
      floatDays: number | null,         // total float in working days (0 on the path)
      isMilestone: boolean,
    }>,                                 // ordered predecessor → successor
    criticalCount: number,
    nearCriticalCount: number,
    floatToleranceDays: number,         // echoed effective value
    nearCriticalDays: number,
    truncated: boolean,
    warnings: string[],
  }
  ```
- **annotation:** `RO` (`{readOnlyHint:true, openWorldHint:true}`).

### 1.3 Pure-core signature (new module `src/tools/scheduleAnalytics.ts`)
```ts
export interface AnalyticsTask {
  taskId: string;            // lowercased canonical id
  subject: string | null;
  start: string | null;     // msdyn_start  (ISO) — early start
  finish: string | null;    // msdyn_finish (ISO) — early finish
  progress: number | null;  // 0-1
  isMilestone: boolean;
  isSummary: boolean;        // derived from parent set by the handler
  parentTaskId: string | null;
  effort: number | null;          // msdyn_effort (hours)
  remainingEffort: number | null; // msdyn_remainingeffort (hours) — may be null
}
export interface AnalyticsDep {
  predecessorTaskId: string;   // lowercased
  successorTaskId: string;     // lowercased
  type: "FS" | "SS" | "FF" | "SF" | "Unknown" | undefined;  // from linkTypeLabel
  lagMinutes: number | null;
}
export interface CriticalPathOptions {
  floatToleranceDays?: number;  // default 0.5
  nearCriticalDays?: number;    // default 2
  workingHoursPerDay?: number;  // default 8 — lag minutes → working days
}
export interface CriticalPathResult {
  projectStart: string | null;
  projectFinish: string | null;
  totalDurationDays: number | null;
  path: Array<{ taskId: string; subject: string | null; start: string | null;
                finish: string | null; floatDays: number | null; isMilestone: boolean }>;
  criticalCount: number;
  nearCriticalCount: number;
  warnings: string[];
}
export function computeCriticalPath(
  tasks: AnalyticsTask[],
  deps: AnalyticsDep[],
  options?: CriticalPathOptions,
): CriticalPathResult;
```
The core is **fully pure** (no `now`, no fetch): it takes engine dates + deps and
returns the analysis. `now` is *not* needed for critical path (it is for schedule
health). All dates are parsed with `new Date(iso).getTime()`; helper `toMs` returns
`null` for null/invalid.

### 1.4 Algorithm (precise)

**Step A — build the leaf DAG.**
- Drop summary tasks (`isSummary === true`) and any task with a null `start` or
  `finish` (record `warnings.push("N task(s) excluded from critical path: missing scheduled dates.")`).
- Keep deps whose **both** endpoints survive in the leaf set (a dep that points at a
  dropped/summary task is skipped; if any were skipped, warn
  `"M dependency link(s) skipped: endpoint missing, summary, or undated."`).
- Build `predsOf[succ] = [{pred, type, lagMs}]` and `succsOf[pred] = [...]`.
  `lagMs = (lagMinutes ?? 0) * 60_000`. (Lag is stored in **minutes** per
  `msdyn_projecttaskdependencylinklag`.)

**Step B — cycle guard.** Topologically sort the leaf DAG by Kahn's algorithm over
the FS/SS/FF/SF edges treating each edge predecessor→successor. If a cycle remains
(nodes still have in-degree > 0 after the queue drains), **do not throw**: record
`warnings.push("Dependency cycle detected; tasks in the cycle are excluded from float computation.")`,
remove the back-edges that close cycles (the edges whose successor was already
finalised), and proceed with the acyclic remainder. The whole tool must never throw
on bad data — it degrades.

**Step C — forward pass = engine dates (no recompute).**
For each leaf task, `early.start = toMs(start)`, `early.finish = toMs(finish)`.
`projectStart = min(early.start)`, `projectFinish = max(early.finish)` over leaves.

**Step D — backward pass (compute late finish / late start).**
Process nodes in **reverse topological order**. Initialise every node's
`lateFinish = projectFinish`. For each node `n`, for each successor edge to `s` with
type `T` and `lagMs`:
- **FS** (finish-to-start, the primary/most common): successor starts after
  predecessor finishes ⇒ constraint on `n`'s late finish is
  `lateFinish[n] = min(lateFinish[n], lateStart[s] - lagMs)`.
- **SS** (start-to-start): `lateStart[n] = min(lateStart[n], lateStart[s] - lagMs)`,
  then derive `lateFinish[n] = lateStart[n] + duration[n]`.
- **FF** (finish-to-finish): `lateFinish[n] = min(lateFinish[n], lateFinish[s] - lagMs)`.
- **SF** (start-to-finish, rare): `lateFinish[n] = min(lateFinish[n], lateStart[s] - lagMs + duration[n])`
  i.e. constrains start indirectly; modelled but flagged.
where `duration[n] = early.finish[n] - early.start[n]` (engine span, already
calendar-correct), and `lateStart[n] = lateFinish[n] - duration[n]`.
After visiting all successors of `n`, finalise `lateStart[n] = lateFinish[n] - duration[n]`.
A node with **no successors** keeps `lateFinish = projectFinish`.

> **Link-type honesty.** FS is exact. SS/FF/SF are approximated against engine dates
> (we don't re-run the scheduler). If the plan contains any non-FS link, push
> `warnings.push("Plan contains SS/FF/SF links; their float is approximated from scheduled dates, not re-scheduled.")`.
> `linkTypeLabel` may return `"Unknown(N)"` or `undefined` (unmapped option value) —
> treat unknown as **FS** and warn once
> (`"K dependency link(s) had an unrecognised type and were treated as FS."`).

**Step E — total float.**
`totalFloatMs[n] = lateFinish[n] - early.finish[n]` (equivalently `lateStart - earlyStart`).
Convert to **working days**: `floatDays = totalFloatMs / (workingHoursPerDay*3600*1000)`,
rounded to 1 decimal. Rationale: engine spans are in real (calendar) ms but represent
working time at `workingHoursPerDay` (default 8). Using an 8h working day for the
day-conversion keeps "1 working day of slack" meaningful; documented in the field
description and in a `note`. (If the board uses a non-8h calendar this is an
approximation — acceptable and explicit.)

**Step F — critical chain extraction.**
- `critical = tasks with floatDays <= floatToleranceDays` (default 0.5 working day).
- `nearCritical = tasks with floatToleranceDays < floatDays <= nearCriticalDays`.
- Order the critical set into a single chain: start from the critical task(s) with
  the **earliest early.start and no critical predecessor**, then walk successor edges
  preferring the successor that is also critical and has the earliest start; tie-break
  by `displaySequence` then `taskId`. If the critical set is disjoint (parallel
  critical chains), return the **longest** chain by task count and warn
  `"Multiple critical chains exist; showing the longest. N other critical tasks omitted from the ordered path (still counted in criticalCount)."`.
- `criticalCount = |critical|`, `nearCriticalCount = |nearCritical|`.

`totalDurationDays = (projectFinish - projectStart) / (24*3600*1000)` rounded to 1
decimal (calendar days, for headline reporting), or `null` if either bound is null.

### 1.5 Thin handler
1. `assertGuid(input.projectId, "projectId")`.
2. One paginated task scan (`pageAll`, `readHeaders()`):
   `msdyn_projecttasks?$select=msdyn_projecttaskid,msdyn_subject,msdyn_start,msdyn_finish,`
   `msdyn_progress,msdyn_ismilestone,msdyn_effort,_msdyn_parenttask_value`
   `&$filter=_msdyn_project_value eq <projectId>`. (No extended fields needed here —
   float uses engine dates; `msdyn_effort` is carried for reuse by schedule-health’s
   shared scan but is optional for critical path.) Capture `truncated`.
3. Derive `summaryIds` from `_msdyn_parenttask_value` (same one-pass set as
   `listPlanTasks`); set `isSummary` per task.
4. Dependency fetch — **reuse the proven query + 404-degrade** from
   `listDependencies`:
   `msdyn_projecttaskdependencies?$select=_msdyn_predecessortask_value,`
   `_msdyn_successortask_value,msdyn_projecttaskdependencylinktype,`
   `msdyn_projecttaskdependencylinklag&$filter=_msdyn_project_value eq <projectId>&$top=2000`.
   On `status===404` ⇒ `deps=[]`, warn `"Dependency links unavailable on this environment."`.
   On other `>=400` ⇒ throw (`get_critical_path failed (...)`). Map via
   `linkTypeLabel` into `AnalyticsDep` (lowercase the two `_value` ids so they match
   the lowercased `taskId`).
5. Call `computeCriticalPath(tasks, deps, {floatToleranceDays, nearCriticalDays})`.
6. Enrich `path[].subject` from the task scan (already in `AnalyticsTask.subject`).
7. Return the §1.2 shape; merge handler warnings (404 note, truncated note) with
   core warnings.

### 1.6 Edge cases & graceful degradation
- **No dependencies** (empty or 404): every leaf has float = `projectFinish - finish`;
  the "critical path" is the single leaf (or chain of zero-float leaves) that finishes
  at `projectFinish`. Path may be length 1. No throw.
- **Null/missing dates:** tasks without start AND finish are excluded with a warning;
  they cannot be placed in the schedule.
- **Dependency-entity 404:** degrade exactly like `listDependencies` (empty deps +
  warning). The path then reduces to the latest-finishing leaf chain.
- **Summary-task exclusion:** summaries dropped before graph build.
- **Cycles:** guarded in Step B — warn, break back-edges, continue; never throw.
- **Single task / empty plan:** `criticalPath=[]` or `[onlyLeaf]`,
  `projectStart/Finish` from that leaf or `null`.
- **Milestone (zero-duration) tasks:** `duration=0`; they appear on the path if
  zero-float; flagged via `isMilestone`.
- **Truncated scan:** carry `truncated:true`; warn the result is a lower bound.

---

## 2. `get_schedule_health`

### 2.1 Context
The PM's "what's on fire" view: overdue, at-risk (due soon & behind), blocked
(predecessor incomplete while the successor is scheduled to have started),
milestones at risk, and summary-task slip. Reuses `summariseTasks` for the basic
counts and the **same leaf DAG + `AnalyticsTask`/`AnalyticsDep` model** as critical
path for the "blocked" computation.

### 2.2 Tool contract
- **name:** `get_schedule_health`
- **title:** `Get Schedule Health`
- **description:** "Returns a schedule-risk rollup for a plan: overdue leaf tasks,
  at-risk tasks (due within N days and under X% complete), blocked tasks (an
  incomplete predecessor while the successor is scheduled to have started),
  milestones at risk, and summary tasks slipping (a child finishes after the
  summary's finish). N (atRiskWithinDays) and X (atRiskMinProgressPercent) are
  parameters with sensible defaults. Counts leaf tasks for overdue/at-risk (summary
  dates roll up). Degrades to a warning if dependency links are unavailable. If
  truncated=true the scan was incomplete."
- **inputSchema:**
  ```ts
  {
    projectId: z.string().describe("GUID of the plan (msdyn_projectid)."),
    atRiskWithinDays: z.number().optional()
      .describe("A leaf task due within this many days (and below the progress floor) is 'at risk'. Default 7."),
    atRiskMinProgressPercent: z.number().optional()
      .describe("Progress floor (0-100): an at-risk-window task at/below this percent is flagged. Default 50."),
  }
  ```
- **output shape:**
  ```ts
  {
    ok: true,
    projectId: string,
    now: string,                        // injected nowIso(), echoed for auditability
    counts: {
      totalTasks: number, leafTaskCount: number, summaryTaskCount: number,
      milestoneCount: number,
      overdueLeafCount: number,         // from summariseTasks
      atRiskCount: number,
      blockedCount: number,
      milestonesAtRiskCount: number,
      slippingSummaryCount: number,
    },
    overdue: TaskRef[],                 // capped list (see §2.4), each {taskId, subject, finish, progressPercent}
    atRisk: TaskRef[],
    blocked: Array<{ taskId, subject, finish, blockingPredecessorId, blockingPredecessorSubject, predecessorProgressPercent }>,
    milestonesAtRisk: TaskRef[],
    slippingSummaries: Array<{ taskId, subject, summaryFinish, latestChildFinish, slipDays }>,
    atRiskWithinDays: number,
    atRiskMinProgressPercent: number,
    truncated: boolean,
    warnings: string[],
  }
  ```
  (`TaskRef = { taskId, subject, finish, progressPercent }`.)
- **annotation:** `RO`.

### 2.3 Pure-core signature (same `src/tools/scheduleAnalytics.ts`)
```ts
export interface ScheduleHealthOptions {
  atRiskWithinDays?: number;        // default 7
  atRiskMinProgressPercent?: number; // default 50  (0-100)
  maxListItems?: number;            // default 50 — cap each detail array
}
export interface ScheduleHealthResult {
  counts: { /* as above */ };
  overdue: TaskRef[]; atRisk: TaskRef[];
  blocked: BlockedRef[]; milestonesAtRisk: TaskRef[];
  slippingSummaries: SummarySlip[];
  warnings: string[];
}
export function computeScheduleHealth(
  tasks: AnalyticsTask[],
  deps: AnalyticsDep[],
  now: string,                       // injected — nowIso() at the handler
  options?: ScheduleHealthOptions,
): ScheduleHealthResult;
```

### 2.4 Algorithm
- `nowMs = toMs(now)`. `windowMs = atRiskWithinDays * 24*3600*1000`.
- **Overdue (leaf):** `!isSummary && finish && toMs(finish) < nowMs && progress!=null && progress < 1`
  (identical predicate to `summariseTasks` / `listPlanTasks` overdue — single source of truth).
- **At-risk (leaf):** `!isSummary && finish && nowMs <= toMs(finish) <= nowMs+windowMs &&
  progress != null && round(progress*100) <= atRiskMinProgressPercent`. (Not yet
  overdue, due within the window, behind the progress floor.) Excludes already-overdue.
- **Blocked:** for each dependency edge `pred → succ`:
  if `succ` is scheduled to have started (`succ.start && toMs(succ.start) <= nowMs`)
  and `succ` is not complete (`succ.progress == null || succ.progress < 1`)
  and `pred` is incomplete (`pred.progress == null || pred.progress < 1`),
  flag `succ` as blocked with the offending predecessor. De-dup per successor (keep
  the least-complete predecessor). Only leaf successors counted. (FS semantics
  assumed for "should have started"; SS/FF/SF still counted because an incomplete
  predecessor on any link to a started task is a real risk signal — note this in a
  warning if non-FS links exist.)
- **Milestones at risk:** `isMilestone && finish && toMs(finish) <= nowMs+windowMs &&
  (progress == null || progress < 1)` — a milestone due within the window (or already
  past) and not done. (Milestones are leaf by nature.)
- **Slipping summaries:** for each summary task `S` with a finish, compute
  `latestChildFinish = max(child.finish)` over its direct children; if
  `latestChildFinish > S.finish`, `slipDays = (latestChildFinish - S.finish)/dayMs`
  (>0). Requires the parent→children map (built from `_msdyn_parenttask_value`).
- **Caps:** each detail array sliced to `maxListItems` (default 50); the `counts.*`
  values are the **true** totals (not the sliced length). If any array was sliced,
  warn `"<kind> list truncated to 50 of N; counts reflect the full total."`.
- Reuse `summariseTasks(tasks, now)` for `totalTasks/leaf/summary/milestone/overdue`
  base counts so overdue stays definitionally identical across tools.

### 2.5 Thin handler
- `assertGuid`. One task scan — **superset select** that also covers critical path so
  the two tools share a scan shape:
  `msdyn_projecttaskid,msdyn_subject,msdyn_start,msdyn_finish,msdyn_progress,`
  `msdyn_ismilestone,msdyn_effort,_msdyn_parenttask_value`.
- Dependency fetch with 404-degrade (same as §1.5 step 4).
- `computeScheduleHealth(tasks, deps, nowIso(), {atRiskWithinDays, atRiskMinProgressPercent})`.
- Return §2.2 shape; echo `now`.

### 2.6 Edge cases & graceful degradation
- **No deps / 404:** `blocked = []` + warning; all other sections still computed.
- **Null dates/progress:** a null finish excludes a task from overdue/at-risk (can't
  judge); null progress treated as incomplete for the **blocked** signal (worst-case,
  flagged) but **not** counted overdue (matches `summariseTasks`, which requires a
  numeric progress < 1). Document this asymmetry inline.
- **No milestones / no summaries:** empty arrays, zero counts.
- **Truncated scan:** carry flag + lower-bound warning.

---

## 3. `get_resource_workload`

### 3.1 Context
Per-team-member load across a plan: how many tasks assigned, total & remaining
effort, and how many are overdue. Built from `msdyn_resourceassignments` (study from
`getTask.ts`) joined to the plan's tasks.

### 3.2 Tool contract
- **name:** `get_resource_workload`
- **title:** `Get Resource Workload`
- **description:** "Returns per-team-member workload for a plan: assigned leaf-task
  count, total effort hours, remaining effort hours, and overdue count. Joins
  resource assignments to tasks. Members with no assignments are omitted unless they
  appear on the team. Remaining-effort hours are null on environments that don't
  expose msdyn_remainingeffort (a warning is added). Unassigned tasks are summed
  under a synthetic '(Unassigned)' row. If truncated=true a scan was incomplete."
- **inputSchema:**
  ```ts
  { projectId: z.string().describe("GUID of the plan (msdyn_projectid).") }
  ```
- **output shape:**
  ```ts
  {
    ok: true,
    projectId: string,
    members: Array<{
      teamMemberId: string | null,     // _msdyn_projectteamid_value ('(Unassigned)' uses null)
      name: string | null,
      assignedTaskCount: number,       // distinct leaf tasks
      totalEffortHours: number | null,
      remainingEffortHours: number | null,  // null if env lacks the field
      overdueTaskCount: number,
    }>,
    memberCount: number,
    hasRemainingEffort: boolean,       // mirrors the capability probe
    truncated: boolean,
    warnings: string[],
  }
  ```
  Sorted by `assignedTaskCount` desc, then `name`.
- **annotation:** `RO`.

### 3.3 Pure-core signature (same module)
```ts
export interface Assignment { taskId: string; teamMemberId: string | null; name: string | null; }
export interface ResourceWorkloadResult {
  members: Array<{ teamMemberId: string | null; name: string | null;
    assignedTaskCount: number; totalEffortHours: number | null;
    remainingEffortHours: number | null; overdueTaskCount: number }>;
  warnings: string[];
}
export function computeResourceWorkload(
  tasks: AnalyticsTask[],          // leaf set; carries effort + remainingEffort
  assignments: Assignment[],
  now: string,
  options?: { hasRemainingEffort?: boolean },
): ResourceWorkloadResult;
```

### 3.4 Algorithm
- Index tasks by lowercased id. Drop summary tasks from effort/overdue (summary
  effort rolls up). Build per-member buckets keyed by `teamMemberId`
  (`'(Unassigned)'` synthetic key, exposed with `teamMemberId:null`).
- For each assignment whose `taskId` resolves to a **leaf** task: add the task to
  that member's distinct-task set (a task assigned to two members counts once per
  member). For each task, sum `effort ?? 0` into `totalEffortHours` and
  `remainingEffort ?? 0` into `remainingEffortHours` (only when `hasRemainingEffort`,
  else leave null). Overdue uses the same predicate as `summariseTasks`.
- Tasks with **no** assignment row become the `(Unassigned)` bucket.
- `totalEffortHours`/`remainingEffortHours` rounded to 1 decimal; `null` when no
  numeric contribution / capability absent.

### 3.5 Thin handler
1. `assertGuid`.
2. Resolve `hasRemainingEffort` via the **capability cache** (§5) — avoids an
   extra fallback round-trip.
3. Task scan with the extended-aware select (uses capability to decide whether to ask
   for `msdyn_remainingeffort`):
   base `msdyn_projecttaskid,msdyn_subject,msdyn_finish,msdyn_progress,msdyn_effort,`
   `_msdyn_parenttask_value` plus `,msdyn_remainingeffort` when capability says present.
   If the capability is **unknown**, try-with-`msdyn_remainingeffort` then fall back
   on the `/could not find a property named/i` 400 (and record the result in the
   cache). Capture `truncated`.
4. Assignment scan, paginated, plan-scoped (this is the cross-plan join — `getTask`
   filters by one task; here we filter by project):
   `msdyn_resourceassignments?$select=_msdyn_taskid_value,_msdyn_projectteamid_value`
   `&$expand=msdyn_projectteamid($select=msdyn_name)&$filter=_msdyn_projectid_value eq <projectId>`.
   On `>=400` (incl. 404): warn `"Resource assignments unavailable on this environment."`,
   set `assignments=[]` (→ everything lands in `(Unassigned)`).
   Map each to `Assignment { taskId: lower(_msdyn_taskid_value),
   teamMemberId: _msdyn_projectteamid_value, name: msdyn_projectteamid?.msdyn_name ?? null }`.
5. `computeResourceWorkload(tasks, assignments, nowIso(), {hasRemainingEffort})`.
6. Return §3.2 shape.

### 3.6 Edge cases & graceful degradation
- **No assignments / assignment 404:** single `(Unassigned)` row with plan totals;
  warning added.
- **No `msdyn_remainingeffort`:** `remainingEffortHours: null` for all,
  `hasRemainingEffort:false`, warning.
- **Assignment to a summary task:** ignored for effort/overdue (summary excluded);
  counted toward `assignedTaskCount`? — **No**: only leaf tasks counted (consistent
  with effort exclusion). Document.
- **Orphan assignment** (task id not in the scan, e.g. truncated): skipped + warn
  `"K assignment(s) referenced tasks outside the scanned page set."`.
- **Truncated task or assignment scan:** carry flag + lower-bound warning.

---

## 4. `list_plan_tasks` extended fields (TODO read-item 1)

### 4.1 Context
`list_plan_tasks` currently omits `msdyn_remainingeffort`, `msdyn_duration`,
`msdyn_actualstart`, `msdyn_actualfinish`. `get_task` already reads them with a
try-then-fallback on `400 "Could not find a property named"`. Mirror that exact
pattern in `listPlanTasks`, gated by the capability cache (§5) so the fallback
round-trip is paid at most once per process.

### 4.2 Change (modify `src/tools/listPlanTasks.ts` only — no new tool)
- Extend `FullTask` with `msdyn_remainingeffort?`, `msdyn_duration?`,
  `msdyn_actualstart?`, `msdyn_actualfinish?` (all `number|string|null`).
- Define `EXTENDED_TASK_FIELDS = "msdyn_remainingeffort,msdyn_duration,msdyn_actualstart,msdyn_actualfinish"`
  (identical to `getTask.ts`'s `EXTENDED_FIELDS` — **lift this constant into the
  capability module** so both tools share one literal; see §5).
- Build the `$select`: CORE (current select) + (if capability ≠ "absent") the
  extended fields. Because `pageAll` is used (not a single `dvReq`), the
  try-then-fallback wraps the **first** page: attempt the extended URL via one
  `dvReq`; if `400` + property-not-found, set capability "absent" and re-run
  `pageAll` with the CORE-only URL. (Simplest correct shape: a small helper
  `pagedTasksWithExtended(baseUrl, capability)` in the capability module that
  encapsulates the probe-then-page, returns `{paged, hasExtended}`, and updates the
  cache.) Cache hit ⇒ no probe, go straight to the right select.
- Map new output fields only when present:
  ```ts
  ...(hasExtended && {
    remainingEffortHours: t.msdyn_remainingeffort ?? null,
    durationHours: t.msdyn_duration ?? null,
    actualStart: t.msdyn_actualstart ?? null,
    actualFinish: t.msdyn_actualfinish ?? null,
  }),
  ```
  (Same conditional-spread style as `getTask.ts` lines 172-177.) When absent, push a
  one-time warning `"Extended scheduling fields (remaining effort, duration, actuals) are not available on this environment."` and add a `warnings: string[]` array to the
  output (currently `list_plan_tasks` returns none — additive, low risk).
- Field names/units echo `getTask`: `remainingEffortHours`, `durationHours`,
  `actualStart`, `actualFinish`.

### 4.3 Edge cases
- Tenant lacks the fields ⇒ fields omitted + warning (no throw).
- Capability already known absent ⇒ never sends the extended select (no wasted 400).
- Bucket-scoped + filter combos unchanged; the extended fields ride along the same
  paginated scan.

---

## 5. Schema capability cache (`src/tools/capabilities.ts`)

### 5.1 Context
Both `get_task` and `list_plan_tasks` (and `get_resource_workload`) probe for the
extended task fields. Today `get_task` pays a fallback round-trip on **every** call
on a tenant that lacks them. Cache the probe result per process so the cost is paid
once.

### 5.2 Design (new module, pure-ish + documented reset)
```ts
// src/tools/capabilities.ts
export type Capability = "present" | "absent" | "unknown";

/** Shared literal — the four Project-Operations-only task fields. */
export const EXTENDED_TASK_FIELDS =
  "msdyn_remainingeffort,msdyn_duration,msdyn_actualstart,msdyn_actualfinish";

/** Detects the get_task-style 'extended field not present' 400. PURE. */
export function isMissingPropertyError(status: number, message: string): boolean {
  return status === 400 && /could not find a property named/i.test(message);
}

/** Process-lifetime cache (module-scoped). Keyed for future multi-capability use. */
export function getExtendedTaskFieldsCapability(): Capability;   // default 'unknown'
export function setExtendedTaskFieldsCapability(c: "present" | "absent"): void;
/** Test/diagnostic reset — documented for unit tests. */
export function resetCapabilities(): void;
```
- Storage is a module-scoped `let cap: Capability = "unknown"` (per process / per
  tenant — the server is single-tenant via `DATAVERSE_ORG_URL`, so a process-wide
  cache is tenant-scoped by construction; document this assumption explicitly).
- **No persistence, no fetch** in the module — it's a value cache + a pure error
  predicate. The handlers do the network and call `set...` after a probe.
- `resetCapabilities()` exists **for tests** (mirrors `resetEnvCache()`), called in
  `afterEach` so cached state never leaks across tests.

### 5.3 Wiring
- `get_task`: before the request, read `getExtendedTaskFieldsCapability()`. If
  `"absent"`, skip the extended select entirely (go straight to CORE) — saves the
  per-call 400. If `"present"`, use extended and trust it. If `"unknown"`, do the
  existing try-then-fallback and **record** the outcome via `set...`. Replace the
  inline regex with `isMissingPropertyError(status, dvErrorMessage(res))`. The
  existing `getTask` behaviour/tests stay green (the fallback path is preserved for
  the unknown case).
- `list_plan_tasks`: per §4.2, same capability gate.
- `get_resource_workload`: per §3.5 step 2-3.
- **No guardrail touched.** This is a read-side latency optimisation only.

### 5.4 Edge cases
- First call on a fresh process always probes (unknown → present/absent), then caches.
- A tenant that *gains* the fields mid-process won't be re-detected until restart —
  acceptable (Dataverse schema is stable within a deploy); documented.
- Concurrency: two in-flight first-calls may both probe; both write the same value —
  benign (last-writer-wins, value identical). No locking needed.

---

## 6. `list_dependencies` 404-fallback (TODO read-item 2) — VERIFY, don't rebuild

### 6.1 Current state (confirmed by reading)
- `src/tools/listDependencies.ts` **already** degrades on 404 (lines 40-47): returns
  `{ ok:true, projectId, count:0, dependencies:[], warnings:["Dependency links unavailable on this environment."] }`.
- A unit test **already** covers it: `test/listDependencies.test.ts` →
  *"returns ok with an empty list and a warning when the entity 404s"* (plus a
  plural-entity-set regression test and a *"still throws on a non-404 error (403)"*
  test). Commit `3979447` ("bisect dependency fallback") was about the **PM
  acceptance harness bisect**, not this fallback — the fallback predates it.

**Conclusion:** the feature is done. This item becomes (a) a verification note and
(b) one small hardening fix below. **Do not duplicate** the fallback.

### 6.2 Hardening fix to plan (small)
The existing test fixture at `test/listDependencies.test.ts` line 70 returns
`msdyn_linklagduration: null`, but production code and the schedule API sample use
`msdyn_projecttaskdependencylinklag`. The fixture's lag key is therefore **never read**
by the tool (the test only asserts `type`, so it passes regardless). Plan a one-line
fixture correction so the success-path test actually exercises the real lag column:
change the fixture key to `msdyn_projecttaskdependencylinklag: 60` and add an
assertion `expect(res.dependencies[0].lagMinutes).toBe(60)`. This locks the lag
field name (which the critical-path lag math in §1 depends on). No `src/` change.

### 6.3 Investigate "alternate query path" (TODO note)
The TODO also says "investigate alternate query path". Document the finding: the
plural set `msdyn_projecttaskdependencies` is the correct one and works on the live
EU tenant (per the regression test + commit `5e99432`). The only known-failing path
is the **singular** `msdyn_projecttaskdependency` (404s). No alternate path is
needed; record this so the TODO can be checked off with a comment rather than a
code change. (If a future tenant 404s the plural set too, the existing degrade
already handles it gracefully.)

---

## 7. Files to create / modify

### CREATE
| File | Purpose |
|---|---|
| `src/tools/scheduleAnalytics.ts` | **Pure cores:** `computeCriticalPath`, `computeScheduleHealth`, `computeResourceWorkload` + shared types (`AnalyticsTask`, `AnalyticsDep`, `Assignment`) and helpers (`toMs`, working-day conversion, topo-sort/cycle-guard). No fetch, no env. |
| `src/tools/capabilities.ts` | Capability cache + `EXTENDED_TASK_FIELDS` literal + `isMissingPropertyError` (pure) + `resetCapabilities` (test reset). No fetch. |
| `src/tools/getCriticalPath.ts` | Thin handler — `get_critical_path`. Reuses `pageAll`/`readHeaders`/`linkTypeLabel`, the 404-degrade, calls `computeCriticalPath`. |
| `src/tools/getScheduleHealth.ts` | Thin handler — `get_schedule_health`. Shares the scan shape; calls `computeScheduleHealth`. |
| `src/tools/getResourceWorkload.ts` | Thin handler — `get_resource_workload`. Plan-scoped assignment join; calls `computeResourceWorkload`. |
| `test/scheduleAnalytics.test.ts` | **Unit** (vitest, no network): all three cores with hand-built graphs (see §8). |
| `test/capabilities.test.ts` | **Unit:** `isMissingPropertyError` truth table + cache get/set/reset lifecycle. |
| `test/getCriticalPath.test.ts` | **Handler test** (fetch-mock, `withBearer`): dep-404 degrade, truncated flag, end-to-end shape on a small mocked board. |
| `test/getResourceWorkload.test.ts` | **Handler test:** assignment-404 degrade, capability-gated extended select, `(Unassigned)` bucket. |

### MODIFY (shared — see §9)
| File | Change |
|---|---|
| `src/tools/index.ts` | Import the 3 new handlers; append to `allTools[]` (after `listDependencies`, before `listTeamMembers` for natural grouping); add `get_critical_path`, `get_schedule_health`, `get_resource_workload` to `toolAnnotations` with `RO`. |
| `src/tools/getTask.ts` | Use `isMissingPropertyError` + `EXTENDED_TASK_FIELDS` from `capabilities.ts`; consult/record the capability cache (behaviour-preserving for the unknown case; faster on absent tenants). |
| `src/tools/listPlanTasks.ts` | Add the four extended fields via the capability-gated try-then-fallback (§4); add a `warnings: string[]` to its output. |
| `README.md` | Add 3 rows to the tool table (lines 83-109); bump the tool count `25 → 28` at line 32 and line 272; tick the `list_plan_tasks` extended-fields, capability-cache, and `list_dependencies` 404 items in `## Open TODOs` (lines 310-342). |
| `test/listDependencies.test.ts` | §6.2 fixture/lag hardening (one fixture key + one assertion). |
| `TODO.md` | (Optional, only if the autonomous loop checks these off) mark read-items 1-2 and the capability-cache infra item done. Not required by this plan; the loop does it on merge. |

### MUST NOT touch
`.env*`, `package-lock.json`, `.claude/**`, `src/auth.ts`/`config.ts`/`dataverse.ts`/
`logger.ts` (no security-critical change is needed), and any token. No new dependency
(graph logic is hand-rolled — `package.json` confirms no graph lib, and CLAUDE.md
rule 6 forbids casual deps).

---

## 8. Unit tests (file + concrete cases)

### `test/scheduleAnalytics.test.ts` — `computeCriticalPath`
Use a fixed clock-free design (critical path needs no `now`). GUID-shaped ids.
- **Linear chain (A→B→C, all FS, no lag):** dates contiguous (A 1-2, B 2-3, C 3-4);
  assert path `[A,B,C]`, all `floatDays ≈ 0`, `criticalCount=3`, `projectFinish = C.finish`.
- **Diamond (A→B, A→C, B→D, C→D):** B on the long branch, C with slack; assert the
  path runs A→(longer of B/C)→D, the short branch task has `floatDays > tolerance`
  and is **not** on the path, `criticalCount` counts only the zero-float nodes.
- **Parallel independent branches (A→B and C→D, no cross-link):** two zero-float
  chains; assert the **longer** chain is returned and the warning about multiple
  critical chains is present; `criticalCount` includes both chains.
- **Lag (A→B FS lag=480 min = 1 working day):** assert B's late start absorbs the lag
  and the float math accounts for `lagMs` (B not spuriously slack/critical).
- **No deps:** three leaves with different finishes; assert the single latest-finishing
  leaf is the path, others carry positive float, no throw, no dep warning beyond empty.
- **Cycle (A→B→A):** assert **no throw**, a cycle warning is present, the acyclic
  remainder is still analysed.
- **Missing dates:** a task with null start/finish is excluded with a warning; the
  rest compute normally.
- **SS/FF/SF present:** assert the non-FS approximation warning fires and float is
  finite (not NaN) for an SS edge.
- **Unknown link type (option value not in `LINK_TYPE_LABELS`):** treated as FS, warning fired.

### `test/scheduleAnalytics.test.ts` — `computeScheduleHealth`
Fixed `now = "2026-06-15T00:00:00Z"` (matches the existing readHelpers test clock).
- **Overdue:** a leaf finishing 2026-06-10 at 20% → in `overdue`; a summary parent
  with the same dates → **not** counted (reuses `summariseTasks` predicate).
- **At-risk window:** leaf due 2026-06-18 (within default 7d) at 30% → `atRisk`; same
  task at 80% → not at risk; a task due 2026-07-30 → not at risk (outside window).
- **Blocked:** dep `P→S`, S.start = 2026-06-12 (already started) at 0%, P at 40%
  incomplete → S in `blocked` with `blockingPredecessorId = P`; when P is 100% →
  not blocked.
- **Milestone at risk:** milestone finishing 2026-06-16 at 0% → in `milestonesAtRisk`.
- **Slipping summary:** parent finish 2026-06-20, a child finish 2026-06-25 →
  `slippingSummaries` with `slipDays = 5`.
- **List cap:** 60 overdue tasks with `maxListItems=50` → array length 50,
  `counts.overdueLeafCount = 60`, truncation warning present.
- **No deps:** `blocked = []`, other sections unaffected.

### `test/scheduleAnalytics.test.ts` — `computeResourceWorkload`
Fixed `now`.
- **Two members, shared task:** task T assigned to M1 and M2 → both have
  `assignedTaskCount` including T (counted once per member); effort summed per member.
- **Unassigned:** a leaf with no assignment → `(Unassigned)` row, `teamMemberId:null`.
- **Overdue per member:** M1 has one overdue leaf → `overdueTaskCount=1`.
- **No remaining effort (capability absent):** `hasRemainingEffort:false` →
  every `remainingEffortHours` null, warning.
- **Summary task assigned:** assignment to a summary → not counted (effort/overdue
  excluded), documented behaviour asserted.
- **Orphan assignment** (taskId not in the task list) → skipped + warning.

### `test/capabilities.test.ts`
- `isMissingPropertyError(400, "Could not find a property named 'msdyn_duration'")` → true;
  `(400, "some other 400")` → false; `(404, "...")` → false.
- cache lifecycle: default `"unknown"`; `set("absent")` → `"absent"`; `resetCapabilities()` → `"unknown"`.

### `test/getCriticalPath.test.ts` (handler, fetch-mock)
- dep-entity **404** → tool returns `ok:true` with a dependency-unavailable warning
  and a path derived from dates only.
- happy path: mock task scan + dep scan → assert `criticalPath` ordering and `projectFinish`.
- truncated: mock `@odata.nextLink` beyond the page cap → `truncated:true` + warning.
- non-404 dep error (403) → throws `get_critical_path failed`.

### `test/getResourceWorkload.test.ts` (handler, fetch-mock)
- assignment **404/4xx** → all tasks under `(Unassigned)` + warning.
- capability **absent** (first scan returns 400 property-not-found) → CORE select on
  retry, `hasRemainingEffort:false`, cache set to absent (assert via `getExtendedTaskFieldsCapability()`),
  `resetCapabilities()` in `afterEach`.
- happy path: assignments expand member names; per-member counts correct.

All handler tests follow the `listMyTasks.test.ts` setup: env vars +
`resetEnvCache()` in `beforeEach`, `vi.restoreAllMocks()` + `resetEnvCache()` +
`resetCapabilities()` in `afterEach`, `withBearer(() => (tool.handler as any)(args))`.

---

## 9. e2e self-test scenarios (against the seed board, asserted via independent OData)

These hook into the **seed-once harness defined in `docs/plans/00-test-seed-harness.md`**
(the `ZZ-MCP-SEED-itboard` plan, ~642 tasks built from
`test/e2e/fixtures/it-planner-board.json`). The analytics tools are **all read-only**,
so each is a `mode: "read"` `SeedScenario` (contract from plan 00 §5.1) registered in
`test/e2e/scenarios/registry.ts`. They run via `npm run e2e:seed`
(`FEATURE=critical-path|schedule-health|resource-workload`), never writing to the seed.

### New scenario file `test/e2e/scenarios/seedScheduleAnalytics.ts`
Exports three `SeedScenario`s. Each receives `SeedScenarioCtx` (`projectId`,
`taskGuidByNumber`, `summaryTaskNumbers`, `bearer`, `orgUrl`). Each asserts the tool
result against an **independent OData oracle** in `test/e2e/verify.ts` (direct
`dvGet`, bypassing the MCP server), so a bug in the tool can't mask itself.

- **critical-path scenario:** call `get_critical_path` on the seed; assert
  `ok:true`, `criticalPath` non-empty (the fixture has dependency chains), every
  `path[i].finish <= path[i+1].start` (ordering sanity for FS chains, allowing lag),
  `projectFinish` equals the max `msdyn_finish` over leaf tasks from a direct OData
  `$orderby=msdyn_finish desc&$top=1` oracle, and no task on the path is a summary
  (cross-check each `path[].taskId` against a direct `_msdyn_parenttask_value`
  child-existence probe). Assert `criticalCount >= criticalPath.length`.
- **schedule-health scenario:** call `get_schedule_health`; assert
  `counts.overdueLeafCount` equals an **independent** OData count:
  `verifyTasksByFilter(projectId, "msdyn_finish lt <nowIso> and msdyn_progress lt 1", bearer)`
  intersected with "is a leaf" (oracle filters by a not-a-parent check, or — simpler —
  assert the tool count equals `get_plan_summary.overdueLeafTaskCount`, which is
  itself OData-derived and independently validated by the readSweep). Assert
  `atRiskCount`, `blockedCount`, `milestonesAtRiskCount`, `slippingSummaryCount` are
  numbers ≥ 0 and the detail arrays are capped at 50.
- **resource-workload scenario:** call `get_resource_workload`; assert the sum of
  `assignedTaskCount` over members ≥ the assignment count from a direct
  `msdyn_resourceassignments?$filter=_msdyn_projectid_value eq <projectId>&$count=true&$top=0`
  oracle is consistent (sum may exceed assignment rows if a task has multiple
  members, equal otherwise — assert `>=` and that `(Unassigned)` accounts for the
  remainder so `Σ assignedTaskCount` over leaf tasks reconciles with the leaf count
  from `verifyTaskCount`-style leaf oracle). Assert `hasRemainingEffort` matches
  whether `get_task` on a sample seed task returned `remainingEffortHours`.

### Oracle helpers to add to `test/e2e/verify.ts` (additive, direct-OData only)
- `verifyTasksByFilter(projectId, odataFilter, bearer): Promise<{count:number}>` —
  paginates `msdyn_projecttasks?$filter=_msdyn_project_value eq <id> and (<odataFilter>)&$count=true&$top=0`.
- `verifyMaxTaskFinish(projectId, bearer): Promise<string|null>` —
  `…?$select=msdyn_finish&$orderby=msdyn_finish desc&$top=1`.
- `verifyAssignmentCount(projectId, bearer): Promise<number>` —
  `msdyn_resourceassignments?$filter=_msdyn_projectid_value eq <id>&$count=true&$top=0`.

These mirror the existing `verifyTaskCount`/`verifyTaskField` style (direct `fetch`,
no server `pageAll` import). **Coordinate the names with plan 00 §8/§9**, which also
plans `verifyPlanExists`/`verifyTasksByFilter`/`verifyBucketTaskCounts` — `verifyTasksByFilter`
is a shared name, so agree one signature (the plan-00 paginating variant) and reuse it.

> e2e is **live-only** (`npm run e2e:seed`, real tenant, human-initiated per CLAUDE.md).
> The green-gate Stop hook runs only `npm run typecheck` + `npm test` (unit, no
> network); the analytics cores are fully exercised offline by §8, so the gate is
> satisfied without the seed board.

---

## 10. Shared-file touchpoints & sequencing / conflict notes

### Shared files this suite edits
- **`src/tools/index.ts`** — append 3 imports + 3 `allTools` entries + 3
  `toolAnnotations` (`RO`). Additive; the only conflict risk is *another* feature
  also appending to `allTools[]`/`toolAnnotations` in the same PR window — keep the
  diff to clean appends and grep for duplicate names before merge.
- **`src/tools/getTask.ts`** — refactor to use `capabilities.ts`
  (`EXTENDED_TASK_FIELDS`, `isMissingPropertyError`, cache get/set). **Behaviour must
  stay green against the existing `getTask` tests** — the unknown-capability path is
  byte-equivalent to today (try extended → fallback). This is the one existing tool
  whose internals change; review carefully that no guardrail/field is dropped.
- **`src/tools/listPlanTasks.ts`** — additive extended fields + a new `warnings`
  array on the output. Additive to the contract; downstream readers ignore unknown
  fields. The readSweep e2e asserts `list_plan_tasks` shape loosely (array + filter
  echo + truncated) so it stays green.
- **`README.md`** — tool table (lines 83-109) + count (lines 32, 272) + Open-TODOs
  ticks (lines 310-342). Common conflict point with any tool-adding PR; keep the
  diff to the 3 new rows and the count bump.
- **`test/listDependencies.test.ts`** — small fixture/lag hardening (§6.2). Isolated.
- **`test/e2e/verify.ts`** — additive oracle helpers; **shared with plan 00** —
  agree on `verifyTasksByFilter` signature there. Low risk if names are coordinated.
- **`test/e2e/scenarios/registry.ts`** — created by plan 00; this suite **adds entries**.
  Land plan 00's harness first (it owns the registry + `SeedScenarioCtx`); this suite
  then adds `seedScheduleAnalytics.ts` + 3 registry rows with no other shared churn.

### Files NOT shared (safe to build in isolation)
`src/tools/scheduleAnalytics.ts`, `src/tools/capabilities.ts`, the 3 new handler
files, and all 4 new unit-test files are net-new — zero conflict surface.

### `readHelpers.ts`
**No change required.** All reused helpers (`pageAll`, `readHeaders`,
`summariseTasks`, `nowIso`, `linkTypeLabel`, `RawTask`) are consumed as-is. The
analytics module defines its own richer `AnalyticsTask` rather than widening
`RawTask`, to avoid perturbing the existing `summariseTasks` contract its tests lock
in. (If a reviewer prefers, `AnalyticsTask` could `extends RawTask` — optional, not
required; flagged so it's a conscious choice, not an oversight.)

### `SERVER_INSTRUCTIONS` (`src/server.ts`)
**Optional, low-priority.** The current prose tells the model to route "plain
reads/reporting" through generic Dataverse tools. These analytics tools are
*derived* reporting the generic tool can't easily produce (critical path, float,
blocked detection). Consider adding one sentence: *"For schedule analytics —
critical path, slack/float, schedule risk, resource load — prefer the dedicated
get_critical_path / get_schedule_health / get_resource_workload tools over raw
reads."* Not load-bearing; can ship in the same PR or be skipped. No guardrail
implication.

### Sequencing
1. **`capabilities.ts` + its unit test first** (foundational; `getTask`,
   `listPlanTasks`, `getResourceWorkload` all depend on it). Green-gate after.
2. **`scheduleAnalytics.ts` pure cores + `test/scheduleAnalytics.test.ts`** (no deps
   on the handlers; fully offline). Green-gate.
3. **3 thin handlers + their fetch-mock tests**, then register in `index.ts` + README.
   Green-gate (`typecheck` + `test`).
4. **`getTask`/`listPlanTasks` capability rewire** (touches existing tools — do after
   the cache exists and its tests are green; re-run the full unit suite).
5. **`listDependencies` fixture hardening** (§6.2) — independent, any time.
6. **e2e seed scenarios** — only after plan 00's harness lands (depends on its
   registry + `SeedScenarioCtx` + `verify.ts` oracles). Live-run, human-initiated.

Each step is its own `feat/<slug>` branch per CLAUDE.md, green before merge. Because
the pure cores carry the algorithmic risk and are 100% offline-testable, the
green-gate (`npm run typecheck && npm test`) fully covers correctness without the
live tenant; the seed scenarios are confirmation, not the proof.

---

## 11. Summary (tools, new files, shared-file conflicts)

**New tools (3, all `RO`):** `get_critical_path`, `get_schedule_health`,
`get_resource_workload`. **Modified tool behaviour:** `list_plan_tasks` (extended
fields), `get_task` (capability-cached probe). **Verified-not-rebuilt:**
`list_dependencies` 404-fallback (already shipped + tested; one fixture/lag hardening).

**New src files:** `src/tools/scheduleAnalytics.ts` (pure cores),
`src/tools/capabilities.ts` (probe cache), `src/tools/getCriticalPath.ts`,
`src/tools/getScheduleHealth.ts`, `src/tools/getResourceWorkload.ts`.
**New test files:** `test/scheduleAnalytics.test.ts`, `test/capabilities.test.ts`,
`test/getCriticalPath.test.ts`, `test/getResourceWorkload.test.ts`, plus e2e
`test/e2e/scenarios/seedScheduleAnalytics.ts`.

**Shared-file conflicts to coordinate:** `src/tools/index.ts` (append-only registry +
annotations), `src/tools/getTask.ts` (capability rewire — keep tests green),
`src/tools/listPlanTasks.ts` (additive fields), `README.md` (3 rows + count 25→28 +
TODO ticks), `test/e2e/verify.ts` + `test/e2e/scenarios/registry.ts` (**shared with
plan 00** — land that harness first, agree `verifyTasksByFilter` signature),
`test/listDependencies.test.ts` (fixture fix). No `readHelpers.ts` change, no new
dependency, no security-critical file touched, no guardrail weakened.
