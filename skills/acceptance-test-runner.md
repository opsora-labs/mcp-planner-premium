# Skill: MCP Planner Premium — Acceptance Test Runner

## Purpose

You are a QA engineer running the acceptance test suite for the **mcp-planner-premium** MCP server.
You have the server's MCP connection active in this session. Your job is to call each tool in the
prescribed order, record every result as you go, then write a complete markdown report at the end.

The server exposes **31 tools**. This suite is designed to exercise **all of them** and to mirror
the automated end-to-end harness (`test/e2e/`), so a clean run here means the same surface the CI
harness covers has been checked live through a real MCP host.

**Pass/fail is decided by you checking the actual return values — not by trusting that a tool call
"looked successful". Check every field listed in each step's criteria.**

---

## Before you start

Ask the user **both** questions before calling any tool:

1. **Which phases?** — "Which phases should I run? Reply with a comma list:
   - `0` — Preflight (whoami + 31-tool inventory) — always recommended
   - `1` — Read, reporting & analytics sweep (the 17 read/reporting/discovery/analytics tools, no writes)
   - `2` — Write lifecycle (creates a real test plan with 3 buckets, a sprint and 10 tasks, verifies
     all attributes, then exercises updates, bucket-move, reparent, sprint placement, resource
     assignment/unassignment, summary-task protection, single-delete and session-cancel, and cleans up)
   - `3` — Guardrail tests (14 negative-path tests, no real data needed)

   Examples: `0,1,2,3` (full run), `0,1` (read-only), `3` (guardrails only), `0,1,2` (write but skip guardrails)"

2. **Write mode (only if Phase 2 is selected)** — "Phase 2 creates a test plan, 3 buckets, a sprint
   and 10 tasks with rich attributes, then runs a full change lifecycle over them (updates, bucket-move,
   reparent, resource assign/unassign, summary-task protection, single-delete, session-cancel) and
   cleans everything up. Confirm YES to proceed, or NO to skip Phase 2."

Keep a running tally in memory: `PASS`, `FAIL`, `SKIP` counts, **plus a per-tool covered/result map**
(you will need it for the tool-coverage matrix in the report). Do **not** stop on first failure —
continue all selected phases and report everything at the end.

> **Mind the tool-call budget.** A full run (Phases 0-3) makes ~120+ tool calls (Phase 2's
> update/move/reparent/assign/delete/cancel lifecycle adds several apply+poll+verify cycles). If you
> notice you are running low on budget mid-Phase 2, finish Phase 2 cleanup first (the final step),
> then start a fresh session for Phase 3 (it is self-contained and needs no real data). When you
> split, mark the skipped steps as `SKIP (run separately)`, not silent gaps.

The environment is determined by the MCP server's connection — do **not** ask the user for it.
Populate the `**Environment:**` field in the report from the `whoami` response (Step 0.2) if it
includes an org/tenant identifier, otherwise write "derived from MCP server connection".

---

## Phase 0 — Preflight (always run)

### Step 0.1 — Tool inventory

Verify all **31 tools** are available in this MCP session. The expected tool names, grouped:

```
Reads / reporting (9):
  list_plans, list_my_tasks, list_user_tasks, get_plan_summary,
  get_plan_tasks_and_buckets, get_task, list_plan_tasks, get_bucket_breakdown, list_dependencies

Discovery / identity (6):
  find_plan_by_name, find_team_member, find_team_member_across_plans,
  list_team_members, whoami, describe_option_set

Analytics (3):
  get_critical_path, get_schedule_health, get_resource_workload

Change-session lifecycle (4):
  start_change_session, apply_changes, check_change_session_status, cancel_change_session

Writes (9):
  create_plan, add_bucket, add_sprint, add_tasks, add_tasks_batch,
  update_tasks, update_tasks_batch, assign_task, delete_tasks_batch
```

**Pass:** All 31 names are present.
**Fail:** List any missing names. **Note** any unexpected extra tool names (the server may be running
with a `READ_ONLY_MODE` / `ENABLED_TOOLS` / `TOOLSETS` filter — if fewer than 31 appear, say so and
record which group is missing; a read-only instance correctly exposes only the 19 read-only tools —
the 17 read/discovery/analytics tools plus `whoami` and `check_change_session_status`).

> You cannot list tools explicitly in most MCP hosts — instead note which tools appear in your
> session's available tool list, or proceed to call them and note any "tool not found" errors.

### Step 0.2 — whoami

Call: `whoami` (no arguments)

**Pass criteria:**
- `ok` is `true`
- `userId` is a non-empty string (looks like a GUID)
- `bookableResourceId` is present (string or null — null is valid if the signed-in user is not a
  Project resource; record as PASS with a NOTE, because per-user task tests in Phase 1 will then SKIP)

Record `userId`, `bookableResourceId` and `resourceName` — later steps reference them.

---

## Phase 1 — Read, reporting & analytics sweep (always run, no writes)

These tools are safe on any live environment. If `list_plans` returns zero plans, skip Steps 1.2 to
1.17 and record them as `SKIP` with reason "no plans in environment".

### Step 1.1 — list_plans

Call: `list_plans` with `{ "top": 5 }`

**Pass criteria:**
- `plans` is an array (may be empty)
- If plans exist: first item has `projectId` (string) and `name` (string)
- If plans exist: `progressPercent` (if not null) is between 0 and 100 — **not** a 0–1 fraction

Record the first plan's `projectId` as `TEST_PROJECT_ID` and its `name` for the following steps.

### Step 1.2 — find_plan_by_name

Call: `find_plan_by_name` with the first 3 characters of the plan name from Step 1.1.

**Pass criteria:**
- `plans` is an array
- `count` is a number
- `plans[0].progress` (if not null) is between 0 and 1 (this tool returns a raw fraction, not %)

### Step 1.3 — get_plan_summary

Call: `get_plan_summary` with `{ "projectId": "<TEST_PROJECT_ID>" }`

**Pass criteria:**
- `ok` is `true`
- `totalTasks` is a number ≥ 0
- `progressPercent` (if not null) is between 0 and 100
- `warnings` is an array (may be empty — it is the degrade path for missing resource columns)

### Step 1.4 — get_plan_tasks_and_buckets (+ pagination)

Call: `get_plan_tasks_and_buckets` with `{ "projectId": "<TEST_PROJECT_ID>" }`

**Pass criteria:**
- `buckets` is an array
- `tasks` is an array
- `summaryTaskIds` is an array
- `truncated` is a boolean
- If tasks exist: `tasks[0].progress` (if not null) is between 0 and 1 (raw fraction in this tool)
- **Pagination:** if the response has `hasMore: true` (or a `nextPageToken`), call the SAME tool again
  with that `pageToken` and confirm (a) no `taskId` appears on two pages, (b) paging eventually ends
  (`hasMore: false`). Record how many pages were needed.

Record the first task's `taskId` as `TEST_TASK_ID`.

### Step 1.5 — get_task

Call: `get_task` with `{ "taskId": "<TEST_TASK_ID>" }`

**Pass criteria:**
- `ok` is `true`
- `task.taskId` matches the input
- `task.description`, `task.bucketName`, `task.parentTaskSubject`, `task.displaySequence`,
  `task.sprintId`, `task.effortHours`, `task.outlineLevel` are all present (value or null)
- `task.progressPercent` (if not null) is between 0 and 100
- `task.isSummary` and `task.isMilestone` are booleans
- `predecessors`, `successors`, `assignments` are arrays (each assignment has `teamMemberId` and `name`)
- `warnings` is an array (degrade path — OK to be empty)

> **Extended fields** (`actualStart`, `actualFinish`, `remainingEffortHours`, `durationHours`)
> are only present on Project Operations tenants. On basic Planner Premium they are absent — correct
> behaviour, not a FAIL.

### Step 1.6 — list_plan_tasks (three filters)

Call `list_plan_tasks` three times with `{ "projectId": "<TEST_PROJECT_ID>", "filter": "<value>" }`,
`<value>` = `"all"`, `"overdue"`, `"milestones"`.

**Pass criteria per call:**
- `tasks` is an array; `filter` echoes back the input; `truncated` is a boolean
- If tasks exist, each task has: `taskId`, `subject`, `description`, `start`, `finish`,
  `progressPercent`, `effortHours`, `outlineLevel`, `displaySequence`, `priority`, `isMilestone`,
  `isSummary`, `bucketId`, `bucketName`, `parentTaskId`, `parentTaskSubject`, `sprintId`
- `overdue` results contain **no summary tasks** (their dates roll up)

### Step 1.7 — get_bucket_breakdown

Call: `get_bucket_breakdown` with `{ "projectId": "<TEST_PROJECT_ID>" }`

**Pass criteria:**
- `buckets` is an array; `method` is a string (`"aggregate"` or `"client"`); `truncated` is a boolean
- If buckets exist: `buckets[0].taskCount` is a number; `buckets[0].avgProgressPercent` (if not null) is 0–100

### Step 1.8 — list_dependencies

Call: `list_dependencies` with `{ "projectId": "<TEST_PROJECT_ID>" }`

**Pass criteria:**
- `dependencies` is an array; `count` is a number
- If entries exist: `dependencies[0].predecessorTaskId` and `successorTaskId` are strings
- If `warnings` mentions dependencies unavailable: record as NOTE (tenant limitation), not FAIL

### Step 1.9 — list_team_members

Call: `list_team_members` with `{ "projectId": "<TEST_PROJECT_ID>" }`

**Pass criteria:**
- `members` is an array; `count` is a number
- If members exist: `members[0]` has `teamMemberId`, `bookableResourceId`, and a name/upn/email field

Record the first member's `name` (or `email`) as `MEMBER_NAME` and its `bookableResourceId` as
`MEMBER_RESOURCE_ID` for Steps 1.10–1.13. If `count` is 0, mark those steps `SKIP` (no team member).

### Step 1.10 — find_team_member

Call: `find_team_member` with `{ "projectId": "<TEST_PROJECT_ID>", "name": "<MEMBER_NAME>" }`
(use the first ~3 chars of the name for a partial match).

**Pass criteria:**
- `members` (or matches) is an array; if a match is found each entry carries `matchType`
  (`"exact"` | `"partial"`), `teamMemberId`, `bookableResourceId`, and identity (`upn`/`email`/`fullName`)
- If nothing matches: a `candidates` array is present — record as PASS with a NOTE (matcher returned the
  fallback list, which is the designed behaviour)

### Step 1.11 — find_team_member_across_plans

Call: `find_team_member_across_plans` with `{ "name": "<MEMBER_NAME>" }` (partial is fine).

**Pass criteria:**
- A results array is returned; if a person matches, the entry is **grouped by `bookableResourceId`**
  and lists the `plans` that person is on (each with its own `teamMemberId`)
- If nothing matches: a `candidates` array (deduped) is present — PASS with a NOTE
- `truncated` (if present) is a boolean

### Step 1.12 — list_my_tasks (signed-in user)

Call: `list_my_tasks` with `{ "filter": "all" }` (no projectId — across all plans).

**Pass criteria:**
- `tasks` is an array; `count` is a number; `userId` echoes the signed-in user
- If `bookableResourceId` was null in Step 0.2 (user is not a Project resource): expect `count: 0`
  with a `note` — record as PASS with NOTE, **not** FAIL
- If tasks exist: each has `taskId`, `subject`, and the plan context (`projectId`/plan name)

### Step 1.13 — list_user_tasks (specific person)

Only if `MEMBER_RESOURCE_ID` was captured in Step 1.9. Call: `list_user_tasks` with
`{ "bookableResourceId": "<MEMBER_RESOURCE_ID>", "filter": "all" }`.

**Pass criteria:**
- `tasks` is an array; `count` is a number
- If tasks exist: each task carries its plan context

> Never invent a `bookableResourceId` — it must come from `find_team_member` /
> `find_team_member_across_plans` / `list_team_members`. If none was found, record `SKIP`.

### Step 1.14 — describe_option_set

Call: `describe_option_set` with
```json
{ "entityLogicalName": "msdyn_projecttaskdependency", "attributeLogicalName": "msdyn_projecttaskdependencylinktype" }
```

**Pass criteria:**
- `ok` is `true`; `options` is an array with at least 4 entries
- A Finish-to-Start option exists (label like `"Finish to Start"` / `"FinishToStart"`). **Record its `value`.**

> **The FS numeric value is environment-dependent.** Most tenants use `192350000`; EU/CRM4 tenants use
> `1`. The server's `DATAVERSE_LINK_TYPE_STYLE` (`global`/`eu`) must match what this returns. Flag as
> NOTE (not FAIL) if the value isn't `192350000`; only FAIL if no Finish-to-Start option appears at all.

### Step 1.15 — get_critical_path (analytics)

Call: `get_critical_path` with `{ "projectId": "<TEST_PROJECT_ID>" }`

**Pass criteria:**
- `ok` is `true`
- `projectStart`, `projectFinish`, `totalDurationDays`, `criticalCount`, `nearCriticalCount` are present
- `path` is an array; if non-empty, each entry has `taskId` and `totalFloatDays` (a number)
- `warnings` is an array (SS/FF/SF-link approximations and dependency-404 degrade land here)

> If the plan has no dependencies, `path` may be empty / equal to the longest schedule chain — record
> as PASS with a NOTE ("no dependency graph to drive a critical path"), not FAIL.

### Step 1.16 — get_schedule_health (analytics)

Call: `get_schedule_health` with `{ "projectId": "<TEST_PROJECT_ID>" }`

**Pass criteria:**
- `ok` is `true`; `now` is present
- `counts` is an object, and `overdue`, `atRisk`, `blocked`, `milestonesAtRisk`, `slippingSummaries`
  are all arrays (any may be empty)
- Spot-check: the `overdue` count here is consistent with `list_plan_tasks filter=overdue` (Step 1.6)

### Step 1.17 — get_resource_workload (analytics)

Call: `get_resource_workload` with `{ "projectId": "<TEST_PROJECT_ID>" }`

**Pass criteria:**
- `ok` is `true`; `members` is an array
- If members exist: each has `assignedTaskCount`, `totalEffortHours`, `overdueCount` (numbers);
  `remainingEffortHours` is a number **or null** (null + a warning is correct on tenants without
  `msdyn_remainingeffort` — NOTE, not FAIL)
- An `(Unassigned)` synthetic row may appear for tasks with no assignee — that is expected

---

## Phase 2 — Write lifecycle (only if user approved writes)

If Phase 2 was not selected or the user said NO to write mode, record all steps as
`SKIP (write mode disabled)` and move to Phase 3.

**Naming convention:** use `ZZ-MCP-TEST-<YYYYMMDD-HHmm>` (date plus the current hour and minute,
e.g. `ZZ-MCP-TEST-20260623-1430`) — clearly identifiable as a test plan and unique per run. The plan
cannot be deleted via the API — remind the user to remove it manually in the Planner UI.

---

### Step 2.1 — create_plan

Call: `create_plan` with
```json
{ "subject": "ZZ-MCP-TEST-<YYYYMMDD-HHmm>", "description": "MCP acceptance run — multi-bucket rich hierarchy" }
```
**Pass:** `ok: true`, `projectId` is a GUID. Save as `NEW_PROJECT_ID`. (A default "Bucket 1" is auto-created.)

---

### Steps 2.2a–2.2c — add three buckets

Call `add_bucket` three times. Each routes through PSS and polls for completion (~10-45 s).
```json
{ "projectId": "<NEW_PROJECT_ID>", "name": "Planning" }
{ "projectId": "<NEW_PROJECT_ID>", "name": "Development" }
{ "projectId": "<NEW_PROJECT_ID>", "name": "Testing" }
```
**Pass each:** `ok: true`, `bucketId` is a GUID, `note` indicates persisted.
Save IDs as `BID_PLANNING`, `BID_DEVELOPMENT`, `BID_TESTING`.

---

### Step 2.3 — add_sprint

Call: `add_sprint` with
```json
{ "projectId": "<NEW_PROJECT_ID>", "name": "Sprint 1", "start": "2026-09-01", "finish": "2026-09-14" }
```
**Pass criteria:** `ok: true`, `sprintId` is a GUID, `note` indicates the sprint persisted (or queued —
if queued, the later sprint-membership check becomes a NOTE rather than a hard assertion).

> `add_sprint` requires **all** of `name`, `start`, `finish` (mandatory in PSS) and manages its own
> change session. Save `sprintId` as `SPRINT_1`.

---

### Step 2.4 — start_change_session

Call: `start_change_session` with `{ "projectId": "<NEW_PROJECT_ID>", "description": "E2E — rich hierarchy" }`
**Pass:** `ok: true`, `operationSetId` is a GUID. Save as `OP_SET_1`.

---

### Step 2.5 — add_tasks (10 tasks, 3-level hierarchy, 3 buckets, sprint placement, 2 FS dependencies)

This payload exercises multi-bucket assignment, parent hierarchy, dates, effort, description, priority,
**sprint placement** (R2A1) and dependencies across roots — all on the ergonomic path.

```json
{
  "operationSetId": "<OP_SET_1>",
  "projectId": "<NEW_PROJECT_ID>",
  "tasks": [
    { "ref": "R1",   "subject": "Programme Kick-off", "bucket": "Planning" },
    { "ref": "R1A",  "subject": "Stakeholder Alignment", "bucket": "Planning", "parent": "R1", "start": "2026-09-01", "finish": "2026-09-05", "effortHours": 16, "description": "Align all key stakeholders before kick-off", "priority": 2 },
    { "ref": "R1A1", "subject": "Draft Meeting Agenda", "bucket": "Planning", "parent": "R1A", "description": "Prepare detailed agenda for kick-off meeting" },
    { "ref": "R1A2", "subject": "Send Invitations", "bucket": "Planning", "parent": "R1A", "dependsOn": [{ "on": "R1A1", "type": "FS" }] },
    { "ref": "R1B",  "subject": "Technical Setup", "bucket": "Development", "parent": "R1", "start": "2026-09-08", "finish": "2026-09-12" },
    { "ref": "R1B1", "subject": "Environment Configuration", "bucket": "Development", "parent": "R1B", "effortHours": 8 },
    { "ref": "R2",   "subject": "Delivery Phase", "bucket": "Development", "start": "2026-09-15", "finish": "2026-09-30" },
    { "ref": "R2A",  "subject": "Development Sprint", "bucket": "Development", "parent": "R2", "effortHours": 40, "description": "Primary development sprint" },
    { "ref": "R2A1", "subject": "Core Feature Build", "bucket": "Development", "parent": "R2A", "effortHours": 32, "description": "Primary deliverable — core feature implementation", "sprint": "Sprint 1", "dependsOn": [{ "on": "R1B1", "type": "FS" }] },
    { "ref": "R2B",  "subject": "QA and Sign-off", "bucket": "Testing", "parent": "R2", "priority": 2 }
  ]
}
```

**Pass criteria:**
- `ok` is `true`
- `taskRefs` has 10 keys: `R1, R1A, R1A1, R1A2, R1B, R1B1, R2, R2A, R2A1, R2B`
- `dependencyIds` is an array with **2 GUIDs** (R1A1→R1A2, R1B1→R2A1)
- `warnings` contains entries for **R1A** and **R2A** (PSS ignores `effortHours` on summary/parent
  tasks and the server surfaces this). **FAIL** if `warnings` is absent/empty when effortHours was set
  on those refs.

Save all 10 task IDs as `CREATED_TASK_IDS`; `dependencyIds` (2 GUIDs) as `CREATED_DEP_IDS`;
`taskRefs.R1A` as `VERIFY_R1A`; `taskRefs.R2A1` as `VERIFY_R2A1`.

---

### Step 2.6 — apply_changes

Call: `apply_changes` with `{ "operationSetId": "<OP_SET_1>" }`

**Pass:** `ok: true`. `apply_changes` waits for PSS (up to ~60 s) and returns `persisted: true` with
statusCode `192350003` when complete. If it returns `persisted: false` / `timedOut: true`, poll Step 2.7.

### Step 2.7 — poll (only if apply_changes did not confirm persistence)

Call `check_change_session_status` (no args, or with `{ "operationSetId": "<OP_SET_1>" }`). Repeat up to
10 × 3 s until Completed / `openSets` is empty. **Pass:** persistence confirmed within budget.

> **Persistence lag:** wait an additional ~5–10 s after completion before Step 2.8.

---

### Step 2.8 — verify creation

**2.8a — count.** Call `get_plan_tasks_and_buckets` with `{ "projectId": "<NEW_PROJECT_ID>" }`. Retry
up to 6 × 5 s until `taskCount` reaches 10.
**Pass:** `taskCount` = 10; `summaryTaskIds` includes at least R1, R1A, R1B, R2, R2A. Save `summaryTaskIds` as `SUMMARY_IDS`.

**2.8b — R1A attributes.** Call `get_task` with `{ "taskId": "<VERIFY_R1A>" }`.
**Pass:** `subject` = "Stakeholder Alignment"; `bucketName` = "Planning"; `effortHours` = `0` (summary —
PSS rolls up from leaf children, covered by the Step 2.5 warning); `description` matches; `priority` = 2;
`isSummary` = true; `parentTaskSubject` = "Programme Kick-off".
- `start`/`finish`: **PSS clamps task dates to the plan's active range.** If they differ from the
  September values, record PASS with NOTE "dates clamped by PSS".

**2.8c — R2A1 attributes, sprint & dependency.** Call `get_task` with `{ "taskId": "<VERIFY_R2A1>" }`.
**Pass:** `subject` = "Core Feature Build"; `bucketName` = "Development"; `effortHours` = `32`;
`description` matches; `isSummary` = false; `sprintId` is **non-null** (R2A1 was placed in "Sprint 1" —
if Step 2.3 reported the sprint only "queued", record a NOTE if sprintId is still null);
`predecessors` is non-empty and `predecessors[0].predecessorTaskId` matches `taskRefs.R1B1`.

**2.8d — dependencies.** Call `list_dependencies` with `{ "projectId": "<NEW_PROJECT_ID>" }`.
**Pass:** `count` = 2. (If `warnings` says links unavailable: NOTE, not FAIL — env limitation.)

---

### Step 2.9 — update_tasks (progress, rename, confirm milestone-drop)

Open `OP_SET_2` (`start_change_session`). Call `update_tasks`:
```json
{
  "operationSetId": "<OP_SET_2>",
  "projectId": "<NEW_PROJECT_ID>",
  "tasks": [
    { "taskId": "<taskRefs.R1A1>", "subject": "Draft Meeting Agenda (done)", "progressPercent": 100, "description": "Agenda finalised and approved" },
    { "taskId": "<taskRefs.R1B1>", "progressPercent": 50, "milestone": true },
    { "taskId": "<taskRefs.R2B>", "progressPercent": 0, "description": "QA not yet started", "priority": 1 }
  ]
}
```
**Pass:** `ok: true`; `warnings` is non-empty and mentions `milestone` was ignored on R1B1.
**FAIL** if `warnings` is absent (milestone must be dropped with a warning).

### Step 2.10 — apply + verify updates

`apply_changes` on `OP_SET_2`; wait ~10 s; then `get_task` each:
- **R1A1:** `subject` = "Draft Meeting Agenda (done)", `progressPercent` = 100, `description` updated, `isMilestone` = false
- **R1B1:** `progressPercent` = 50, `isMilestone` = false (PSS manages this flag; cannot be set via API)
- **R2B:** `progressPercent` = 0, `description` = "QA not yet started", `priority` = 1

---

### Step 2.11 — note (description) round-trip fidelity

Open `OP_SET_NOTE`. Call `update_tasks` (a leaf description-only edit needs no projectId):
```json
{
  "operationSetId": "<OP_SET_NOTE>",
  "tasks": [
    { "taskId": "<taskRefs.R2A1>", "description": "Meeting notes:\n- Budget approved (€50k) at 50% margin\n- Risks: \"vendor lock-in\" & data-residency\n- Owner: José; follow-up <2 weeks>\nPath: C:\\plans\\Q3" }
  ]
}
```
`apply_changes`; wait ~10 s; `get_task` R2A1. Dataverse HTML-encodes on write and **strips tag-like
angle-bracket content**; the read tools decode entities back. Expected returned value:
```
Meeting notes:
- Budget approved (€50k) at 50% margin
- Risks: "vendor lock-in" & data-residency
- Owner: José; follow-up 
Path: C:\plans\Q3
```
- **PASS:** the real characters (`"`, `&`, `€`, `é`, `\`, `;`, `:`) survive as literals (NOT `&quot;`/`&amp;`).
- **Expected loss (not FAIL):** `<2 weeks>` is stripped by Dataverse and cannot be recovered.
- **FAIL:** entities come back un-decoded (`&quot;`/`&amp;` literally present).
- Line-ending `\r\n` vs `\n` difference only → PASS with NOTE.

---

### Step 2.12 — move bucket + leaf schedule field

Open `OP_SET_3`. Call `update_tasks` with **projectId** (needed for bucket-name resolution + summary protection):
```json
{ "operationSetId": "<OP_SET_3>", "projectId": "<NEW_PROJECT_ID>", "tasks": [ { "taskId": "<taskRefs.R2B>", "bucket": "Planning", "effortHours": 12 } ] }
```
`apply_changes`; wait ~10 s; `get_task` R2B. **Pass:** `bucketName` = "Planning" (moved from Testing);
`effortHours` = 12 (leaf — effort kept exactly).

---

### Step 2.13 — reparent 2 tasks AND change their values

Open `OP_SET_4`. Call `update_tasks` with **projectId** (summary protection auto-guards the new parents):
```json
{
  "operationSetId": "<OP_SET_4>",
  "projectId": "<NEW_PROJECT_ID>",
  "tasks": [
    { "taskId": "<taskRefs.R1A2>", "parent": "<taskRefs.R1B>", "progressPercent": 25, "description": "Moved under Technical Setup" },
    { "taskId": "<taskRefs.R1B1>", "parent": "<taskRefs.R2A>", "effortHours": 6, "description": "Moved under Development Sprint" }
  ]
}
```
`apply_changes`; wait ~10 s; verify:
- **R1A2:** `parentTaskSubject` = "Technical Setup", `progressPercent` = 25, `description` updated
- **R1B1:** `parentTaskSubject` = "Development Sprint", `effortHours` = 6, `description` updated

> `update_tasks` takes `parent` as an **existing task GUID** (no in-batch refs). If PSS rejects a
> combined reparent + field change in one entity, split into two sessions and record PASS with a NOTE.
> A hard FAIL is only when the reparent itself is rejected for a non-cycle reason.

---

### Step 2.14 — summary-task protection fires on real data (negative)

Open `OP_SET_5`. Call `update_tasks` with **projectId** (auto-detects summary tasks):
```json
{ "operationSetId": "<OP_SET_5>", "projectId": "<NEW_PROJECT_ID>", "tasks": [ { "taskId": "<taskRefs.R1>", "effortHours": 99, "finish": "2026-12-31" } ] }
```
R1 is a top-level summary task. **Pass (guardrail FIRES):** the call returns an **error** mentioning
"summary" / "roll up from its children". **FAIL** if it returns `ok: true`. No `apply_changes` — cancel
the empty session: `cancel_change_session` `{ "operationSetId": "<OP_SET_5>" }`.

---

### Step 2.15 — assign_task (assign a team member)

Resolve a member of the NEW plan first. Call `find_team_member` with
`{ "projectId": "<NEW_PROJECT_ID>", "name": "<resourceName from Step 0.2>" }` (or `email`). The plan
creator is normally on the project team.

- If **no member resolves** (empty team / creator not a bookable Project resource): record Steps 2.15
  and 2.16 as `SKIP` with NOTE "no resolvable team member on a fresh plan — assignment needs a bookable
  Project resource", and continue.

Otherwise save the match's `teamMemberId` as `ASSIGNEE_ID`. Open `OP_SET_ASSIGN`. Call `assign_task`:
```json
{ "operationSetId": "<OP_SET_ASSIGN>", "projectId": "<NEW_PROJECT_ID>", "taskId": "<taskRefs.R2A1>", "assignees": ["<ASSIGNEE_ID>"] }
```
**Pass:** `ok: true`; `mode` = "assign"; `queued` ≥ 1; `assigned` lists the member.
`apply_changes` on `OP_SET_ASSIGN`; wait ~10 s; then verify two ways:
- `get_task` R2A1 → `assignments` array includes the member (`teamMemberId` matches `ASSIGNEE_ID`).
- `get_resource_workload` `{ "projectId": "<NEW_PROJECT_ID>" }` → that member's row shows
  `assignedTaskCount` ≥ 1 (analytics reflect the live assignment).

---

### Step 2.16 — assign_task (unassign — confirmed gate)

Open `OP_SET_UNASSIGN`. First confirm the gate fires WITHOUT confirmation:
```json
{ "operationSetId": "<OP_SET_UNASSIGN>", "projectId": "<NEW_PROJECT_ID>", "taskId": "<taskRefs.R2A1>", "assignees": ["<ASSIGNEE_ID>"], "mode": "unassign" }
```
**Pass (gate fires):** returns an **error** mentioning `confirmed`. (If it doesn't, that is a FAIL — but
record it; do not stop.) Then unassign for real:
```json
{ "operationSetId": "<OP_SET_UNASSIGN>", "projectId": "<NEW_PROJECT_ID>", "taskId": "<taskRefs.R2A1>", "assignees": ["<ASSIGNEE_ID>"], "mode": "unassign", "confirmed": true }
```
**Pass:** `ok: true`; `mode` = "unassign"; `removed` lists the member. `apply_changes`; wait ~10 s;
`get_task` R2A1 → `assignments` no longer includes the member.

---

### Step 2.17 — delete a single task (partial delete)

Open `OP_SET_6`. Call `delete_tasks_batch` (R2B is a leaf with no dependency entities):
```json
{ "operationSetId": "<OP_SET_6>", "projectId": "<NEW_PROJECT_ID>", "taskIds": ["<taskRefs.R2B>"], "confirmed": true }
```
`apply_changes`; wait ~10 s; `get_plan_tasks_and_buckets` (retry up to 3 × 5 s).
**Pass:** `taskCount` = 9; no task has `taskId` = `taskRefs.R2B`; the other 9 survive (no cascade).
Remove R2B from `CREATED_TASK_IDS` — cleanup must delete the **remaining 9**.

---

### Step 2.18 — cancel a change session (rollback before save)

Open `OP_SET_7`. Queue a harmless rename:
```json
{ "operationSetId": "<OP_SET_7>", "projectId": "<NEW_PROJECT_ID>", "tasks": [ { "taskId": "<taskRefs.R1>", "description": "THIS SHOULD NEVER PERSIST" } ] }
```
**Pass (queue):** `ok: true`. Now `cancel_change_session` `{ "operationSetId": "<OP_SET_7>" }`.
**Pass (cancel):** `ok: true`. Verify:
- `check_change_session_status` `{ "operationSetId": "<OP_SET_7>" }` → `statusCode` 192350004 / `status` "Abandoned"
- `get_task` R1 → `description` is **NOT** "THIS SHOULD NEVER PERSIST" (the queued change was discarded)

---

### Step 2.19 — cleanup (delete remaining tasks + dependency entities)

Open `OP_SET_CLEAN`. `<REMAINING_TASK_IDS>` = `CREATED_TASK_IDS` minus R2B (9 tasks).
```json
{
  "operationSetId": "<OP_SET_CLEAN>",
  "projectId": "<NEW_PROJECT_ID>",
  "taskIds": <REMAINING_TASK_IDS>,
  "confirmed": true
}
```
> With `projectId` supplied, `delete_tasks_batch` **auto-fetches and prepends the dependency deletes**
> and auto-sorts tasks leaves-first, so you no longer need to pass `CREATED_DEP_IDS` in `records`
> manually. (If your build predates that behaviour, add them via `records`.)

`apply_changes`; verify `get_plan_tasks_and_buckets` (retry up to 3 × 5 s).
**Pass:** both calls `ok: true`; `taskCount` = 0 (or only the default "Bucket 1" remains, no tasks).

**Residue:** the plan `ZZ-MCP-TEST-<YYYYMMDD-HHmm>` (+ buckets + sprint) remains — remove manually in Planner UI.

---

## Phase 3 — Guardrail tests (always run — no real data needed)

These send deliberately invalid payloads. **A test passes when the server returns an error.** A tool
that returns `ok: true` / success here is a FAIL.

> **Phase 3 is self-contained — run it standalone if low on budget.** Every guard uses placeholder
> GUIDs and needs no plan, session, or Phase 0-2 state.

### Two tools, two input formats — why the guardrail payloads differ

| Tool | Input format | Who builds the OData? |
|---|---|---|
| `add_tasks` | Simplified JSON (`ref`, `subject`, `bucket`, `parent`, `dependsOn`) | **Server** — builds `@odata.type`/`@odata.bind`/GUIDs, orders parents first |
| `add_tasks_batch` | Raw OData array (`@odata.type`, `msdyn_*`, `@odata.bind`) | **Caller** — you send the full entity structure |

So raw-OData mistakes (wrong `@odata.type`, bad bind alias, blocked-on-create fields, child-before-parent)
can only be triggered via `add_tasks_batch`; ergonomic-input mistakes (duplicate `ref`, cycle) only via
`add_tasks`. Send each test to the named tool; do not swap them.

Placeholder GUIDs:
```
FAKE_A = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
FAKE_B = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff"
FAKE_P = "cccccccc-dddd-eeee-ffff-aaaaaaaaaaaa"
FAKE_K = "dddddddd-eeee-ffff-aaaa-bbbbbbbbbbbb"
```

| # | Tool | Payload | Expected error keyword |
|---|---|---|---|
| G1 | `find_plan_by_name` | `{ "name": "" }` | `required` |
| G2 | `get_plan_summary` | `{ "projectId": "not-a-guid" }` | `guid` |
| G3 | `add_tasks_batch` | `{ "operationSetId": "FAKE_A", "entities": "[{\"@odata.type\":\"Microsoft.Dynamics.CRM.account\"}]" }` | `disallowed` |
| G4 | `add_tasks_batch` | task with `msdyn_ismilestone: true` (blocked-on-create) — see payload below | `not allowed on pss create` |
| G5 | `add_tasks_batch` | task using `"msdyn_bucket@odata.bind"` instead of `"msdyn_projectbucket@odata.bind"` | `valid navigation property` |
| G6 | `add_tasks_batch` | two tasks, child before parent — see payload below | `parents must appear before` |
| G7 | `add_tasks_batch` | 201 task entities (over the 200 cap) | `max 200` *(optional — skip if budget tight; cap is enforced before any network call)* |
| G8 | `delete_tasks_batch` | `{ "operationSetId": "FAKE_A", "taskIds": ["FAKE_B"], "confirmed": false }` | `confirmed` |
| G9 | `delete_tasks_batch` | `{ "operationSetId": "FAKE_A", "records": "[{\"entityLogicalName\":\"msdyn_project\",\"recordId\":\"FAKE_B\"}]", "confirmed": true }` | `blocked by policy` |
| G10 | `update_tasks_batch` | `{ "operationSetId": "FAKE_A", "entities": "[{\"@odata.type\":\"Microsoft.Dynamics.CRM.msdyn_projecttaskdependency\"}]" }` | `cannot be updated` |
| G11 | `update_tasks` | `{ "operationSetId": "FAKE_A", "tasks": [{ "taskId": "FAKE_B", "progressPercent": 150 }] }` | `between 0 and 100` |
| G12 | `add_tasks` | two tasks with the same `ref` — see payload below | `duplicate` |
| G13 | `add_tasks` | two tasks with a cycle (A.parent=B, B.parent=A) — see payload below | `cycle` |
| G14 | `assign_task` | `{ "operationSetId": "FAKE_A", "projectId": "FAKE_P", "taskId": "FAKE_B", "assignees": ["FAKE_A"], "mode": "unassign" }` (no `confirmed`) | `confirmed` |

G4 payload:
```json
[{ "@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask", "msdyn_projecttaskid": "FAKE_B", "msdyn_subject": "T", "msdyn_project@odata.bind": "/msdyn_projects(FAKE_P)", "msdyn_projectbucket@odata.bind": "/msdyn_projectbuckets(FAKE_K)", "msdyn_ismilestone": true }]
```
G6 payload (child first):
```json
[
  { "@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask", "msdyn_projecttaskid": "FAKE_B", "msdyn_subject": "Child", "msdyn_project@odata.bind": "/msdyn_projects(FAKE_P)", "msdyn_projectbucket@odata.bind": "/msdyn_projectbuckets(FAKE_K)", "msdyn_parenttask@odata.bind": "/msdyn_projecttasks(FAKE_A)" },
  { "@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask", "msdyn_projecttaskid": "FAKE_A", "msdyn_subject": "Parent", "msdyn_project@odata.bind": "/msdyn_projects(FAKE_P)", "msdyn_projectbucket@odata.bind": "/msdyn_projectbuckets(FAKE_K)" }
]
```
G12 payload:
```json
{ "operationSetId": "FAKE_A", "projectId": "FAKE_P", "tasks": [ { "ref": "t1", "subject": "Task A", "bucket": "Sprint 1" }, { "ref": "t1", "subject": "Task B", "bucket": "Sprint 1" } ] }
```
G13 payload:
```json
{ "operationSetId": "FAKE_A", "projectId": "FAKE_P", "tasks": [ { "ref": "a", "subject": "A", "bucket": "Sprint 1", "parent": "b" }, { "ref": "b", "subject": "B", "bucket": "Sprint 1", "parent": "a" } ] }
```

---

## Generating the report

Once all phases are done, write the markdown report below. Fill in every `[...]` with real values.
Do not omit sections or skip failed steps. **Lead with the tool-coverage matrix** — it is the
"great overview" of which of the 31 tools were exercised and how each fared.

---

```markdown
# MCP Planner Premium — Acceptance Test Report

**Run date:** [date and time]
**Environment:** [from MCP server connection]
**Tester:** [your model name, e.g. claude-opus-4-8]
**Write mode:** [YES / NO]
**User ID (whoami):** [userId] · **bookableResourceId:** [value or null]

---

## Overall Result: [✅ ALL PASS / ❌ N FAILURE(S)]

| Metric | Value |
|---|---|
| Tools available (Step 0.1) | [N]/31 |
| Tools exercised | [N]/31 |
| Total steps | [N] |
| Pass | [N] |
| Fail | [N] |
| Skip | [N] |
| Guardrails fired correctly | [N]/14 |

## Tool coverage matrix (all 31)

> ✅ pass · ❌ fail · ⏭️ skip · ➖ not exercised this run. One row per tool.

| Tool | Group | Exercised in | Result |
|---|---|---|---|
| list_plans | read | 1.1 | [✅/❌/⏭️/➖] |
| list_my_tasks | read | 1.12 | [ ] |
| list_user_tasks | read | 1.13 | [ ] |
| get_plan_summary | read | 1.3 | [ ] |
| get_plan_tasks_and_buckets | read | 1.4 / 2.8 | [ ] |
| get_task | read | 1.5 / 2.x | [ ] |
| list_plan_tasks | read | 1.6 | [ ] |
| get_bucket_breakdown | read | 1.7 | [ ] |
| list_dependencies | read | 1.8 / 2.8d | [ ] |
| find_plan_by_name | discovery | 1.2 | [ ] |
| find_team_member | discovery | 1.10 / 2.15 | [ ] |
| find_team_member_across_plans | discovery | 1.11 | [ ] |
| list_team_members | discovery | 1.9 | [ ] |
| whoami | discovery | 0.2 | [ ] |
| describe_option_set | discovery | 1.14 | [ ] |
| get_critical_path | analytics | 1.15 | [ ] |
| get_schedule_health | analytics | 1.16 | [ ] |
| get_resource_workload | analytics | 1.17 / 2.15 | [ ] |
| start_change_session | session | 2.4+ | [ ] |
| apply_changes | session | 2.6+ | [ ] |
| check_change_session_status | session | 2.7 / 2.18 | [ ] |
| cancel_change_session | session | 2.14 / 2.18 | [ ] |
| create_plan | write | 2.1 | [ ] |
| add_bucket | write | 2.2 | [ ] |
| add_sprint | write | 2.3 | [ ] |
| add_tasks | write | 2.5 | [ ] |
| add_tasks_batch | write | G3–G7 | [ ] |
| update_tasks | write | 2.9+ / G11 | [ ] |
| update_tasks_batch | write | G10 | [ ] |
| assign_task | write | 2.15 / 2.16 / G14 | [ ] |
| delete_tasks_batch | write | 2.17 / 2.19 / G8–G9 | [ ] |

---

## Phase 0 — Preflight

| # | Step | Result | Notes |
|---|---|---|---|
| 0.1 | Tool inventory (31 tools) | [✅/❌] | [missing/extra tools or "all 31 present"] |
| 0.2 | whoami | [✅/❌] | userId: [value]; bookableResourceId: [value/null] |

## Phase 1 — Read, reporting & analytics sweep

| # | Step | Tool | Result | Notes |
|---|---|---|---|---|
| 1.1 | list_plans | `list_plans` | [✅/❌/⏭️] | [count] |
| 1.2 | find_plan_by_name | `find_plan_by_name` | [ ] | [count] |
| 1.3 | get_plan_summary | `get_plan_summary` | [ ] | totalTasks=[N], progress=[N] |
| 1.4 | get_plan_tasks_and_buckets (+paging) | `get_plan_tasks_and_buckets` | [ ] | [N] tasks / [N] buckets / [N] pages |
| 1.5 | get_task | `get_task` | [ ] | isSummary/isMilestone, extended fields=[present/absent] |
| 1.6 | list_plan_tasks (all/overdue/milestones) | `list_plan_tasks` | [ ] | counts; overdue excludes summaries=[bool] |
| 1.7 | get_bucket_breakdown | `get_bucket_breakdown` | [ ] | method=[aggregate/client] |
| 1.8 | list_dependencies | `list_dependencies` | [ ] | [N] deps |
| 1.9 | list_team_members | `list_team_members` | [ ] | [N] members |
| 1.10 | find_team_member | `find_team_member` | [ ] | matchType=[exact/partial/candidates] |
| 1.11 | find_team_member_across_plans | `find_team_member_across_plans` | [ ] | grouped-by-person=[bool] |
| 1.12 | list_my_tasks | `list_my_tasks` | [ ] | count=[N] (NOTE if user not a resource) |
| 1.13 | list_user_tasks | `list_user_tasks` | [ ] | count=[N] / SKIP if no resource id |
| 1.14 | describe_option_set | `describe_option_set` | [ ] | FS value=[N] (NOTE if ≠192350000) |
| 1.15 | get_critical_path | `get_critical_path` | [ ] | pathLen=[N], critical=[N] |
| 1.16 | get_schedule_health | `get_schedule_health` | [ ] | overdue=[N], atRisk=[N], blocked=[N] |
| 1.17 | get_resource_workload | `get_resource_workload` | [ ] | members=[N], remainingEffort=[present/null] |

## Phase 2 — Write Lifecycle

[If skipped: "⏭️ Skipped — write mode not selected or not enabled."]

| # | Step | Tool | Result | Notes |
|---|---|---|---|---|
| 2.1 | create_plan | `create_plan` | [✅/❌] | projectId=[value] |
| 2.2 | add_bucket ×3 | `add_bucket` | [ ] | 3 bucketIds |
| 2.3 | add_sprint | `add_sprint` | [ ] | sprintId=[value], persisted=[bool] |
| 2.4 | start_change_session | `start_change_session` | [ ] | OP_SET_1 |
| 2.5 | add_tasks (10, sprint, 2 deps) | `add_tasks` | [ ] | 10 refs, 2 depIds, warnings=[R1A/R2A] |
| 2.6 | apply_changes | `apply_changes` | [ ] | persisted=[bool] |
| 2.7 | poll | `check_change_session_status` | [ ] | [N] polls / not needed |
| 2.8 | verify creation (count/attrs/sprint/deps) | `get_plan_tasks_and_buckets`,`get_task`,`list_dependencies` | [ ] | taskCount=10, R2A1 sprintId=[value] |
| 2.9 | update_tasks (progress/rename/milestone-drop) | `update_tasks` | [ ] | warnings=[milestone ignored] |
| 2.10 | verify updates | `get_task` | [ ] | R1A1/R1B1/R2B values |
| 2.11 | note round-trip | `update_tasks`→`get_task` | [ ] | entities decoded; `<2 weeks>` stripped |
| 2.12 | move bucket + leaf effort | `update_tasks` | [ ] | R2B Planning, effort=12 |
| 2.13 | reparent 2 + values | `update_tasks` | [ ] | R1A2/R1B1 reparented |
| 2.14 | summary protection (negative) | `update_tasks` | [✅ fired/❌] | rejected on R1 |
| 2.15 | assign_task (assign) | `assign_task` | [✅/❌/⏭️] | assigned=[member]; workload reflects |
| 2.16 | assign_task (unassign + confirmed gate) | `assign_task` | [ ] | gate fired; removed=[member] |
| 2.17 | delete single task | `delete_tasks_batch` | [ ] | taskCount=9, R2B gone |
| 2.18 | cancel change session | `cancel_change_session` | [ ] | Abandoned (192350004), not persisted |
| 2.19 | cleanup (9 tasks + deps) | `delete_tasks_batch` | [ ] | taskCount=0 |

**Residue:** Plan `ZZ-MCP-TEST-<YYYYMMDD-HHmm>` (id: [projectId]) + 3 buckets + sprint need manual removal in Planner UI.

## Phase 3 — Guardrail Tests

| # | Guard tested | Tool | Fired? | Error snippet |
|---|---|---|---|---|
| G1 | Empty plan name | `find_plan_by_name` | [✅/❌] | [error] |
| G2 | Invalid GUID | `get_plan_summary` | [ ] | [error] |
| G3 | Disallowed @odata.type | `add_tasks_batch` | [ ] | [error] |
| G4 | Blocked-on-create field | `add_tasks_batch` | [ ] | [error] |
| G5 | Wrong bind alias | `add_tasks_batch` | [ ] | [error] |
| G6 | Child before parent | `add_tasks_batch` | [ ] | [error] |
| G7 | >200 entities | `add_tasks_batch` | [✅/❌/⏭️] | [error or "skipped"] |
| G8 | Delete without confirmed | `delete_tasks_batch` | [ ] | [error] |
| G9 | Whole-plan delete blocked | `delete_tasks_batch` | [ ] | [error] |
| G10 | Dependency update rejected | `update_tasks_batch` | [ ] | [error] |
| G11 | progressPercent > 100 | `update_tasks` | [ ] | [error] |
| G12 | Duplicate ref | `add_tasks` | [ ] | [error] |
| G13 | Cycle in parent chain | `add_tasks` | [ ] | [error] |
| G14 | Unassign without confirmed | `assign_task` | [ ] | [error] |

## Failure Detail

[For each ❌ FAIL: Step ID — name; Tool; Input summary; Actual response; Expected.]

## Cleanup Notes

[List test artefacts left in Planner Premium for manual removal.]

---

*Report generated by [model] following `skills/acceptance-test-runner.md` in mcp-planner-premium.*
```

---

## Generating the Claude Code optimization prompt

After the markdown report, **always** generate a second output block titled
**"Claude Code Optimization Prompt"**. The user pastes it into a Claude Code session opened at the
project root (`mcp-planner-premium/`).

### Rules

- **All-pass** (every step + all 14 guardrails): ask for code-quality / observability improvements only.
- **Any failure / missed guardrail:** list every issue with the exact file to change, the current
  behaviour, and the correct behaviour.
- Always include the project map, test commands, and verification section so Claude Code can confirm
  its own fixes.
- **Never** include any bearer/access token or secret in the prompt.

### Project map (paste verbatim)

```
Project: mcp-planner-premium
Language: TypeScript (Node.js ≥ 20, @modelcontextprotocol/sdk)
Test command: npm test                  (unit tests — no network)
Type-check:   npm run typecheck (src/) · npm run typecheck:e2e (test/e2e/)
E2E command:  npm run e2e                (read sweep + lifecycle + guardrails; needs env — see README)
              npm run e2e:acceptance     (large-board PM acceptance, writes reports/pm-acceptance-report-*.md)

Server / infra:
  src/server.ts                  MCP server, tool registration, SERVER_INSTRUCTIONS
  src/app.ts                     Express app, JWT middleware, rate limit, helmet, /mcp, /healthz
  src/auth.ts                    JWT validation (jose, Entra JWKS)
  src/config.ts                  Zod env schema, allowed-hosts, READ_ONLY/ENABLED_TOOLS/TOOLSETS
  src/context.ts                 AsyncLocalStorage bearer context
  src/dataverse.ts               dvReq(), assertGuid(), errMessage(), PSS error parsing, retry
  src/toolFilter.ts              filterTools() — read-only / enabled / toolset gating
  src/toolsets.ts                toolset group → tool-name map
  src/tools/index.ts             allTools[] (31 tools) + toolAnnotations (readOnly/destructive hints)
  src/tools/types.ts             ToolDef type

Read / reporting tools:
  listPlans.ts listMyTasks.ts listUserTasks.ts getPlanSummary.ts getPlanContents.ts
  getTask.ts listPlanTasks.ts getBucketBreakdown.ts listDependencies.ts readHelpers.ts capabilities.ts

Discovery / identity:
  findPlan.ts findTeamMember.ts findTeamMemberAcrossPlans.ts listTeamMembers.ts
  teamMemberSearch.ts identity.ts whoami.ts describeOptionSet.ts

Analytics:
  getCriticalPath.ts getScheduleHealth.ts getResourceWorkload.ts scheduleAnalytics.ts

Change-session lifecycle:
  startChangeSession.ts applyChanges.ts checkStatus.ts cancelSession.ts

Writes (guardrails live here):
  createPlan.ts addBucket.ts addSprint.ts
  addTasksSimple.ts (ergonomic add_tasks) addTasks.ts (raw add_tasks_batch)
  updateTasksSimple.ts (ergonomic update_tasks) updateTasks.ts (raw update_tasks_batch)
  assignTask.ts taskAssignments.ts deleteTasks.ts

Key unit tests:
  test/guardrails.test.ts  test/buildTasks.test.ts  test/buildUpdate.test.ts
  test/buildAssignment.test.ts  test/deleteTasks.test.ts  test/scheduleAnalytics.test.ts
  test/listDependencies.test.ts  test/deepHierarchy.test.ts  test/readHelpers.test.ts
  test/auth.test.ts  test/http.test.ts  test/toolFilter.test.ts
```

### Template — when there are failures or missed guardrails

````
I ran the MCP Planner Premium acceptance suite using `skills/acceptance-test-runner.md`.
Please fix all issues below, run `npm test` to confirm no unit tests broke, then confirm which files
changed and why.

## Test run summary
- Date: [date/time] · Environment: [org URL] · Write mode: [YES/NO]
- Result: [N pass / N fail / N skip · guardrails N/14 · tools exercised N/31]

## Issues to fix
[For each FAIL:]
### Issue [N]: [short title]
- **Tool:** `[tool_name]`
- **Step:** [phase + step]
- **Most likely file:** `[src/tools/fileName.ts]` — [what to look for]
- **Current behaviour:** [exact field values returned]
- **Expected behaviour:** [precise pass criteria]
- **Reproduction:** Call `[tool_name]` with `[minimal JSON]` and check `[field]`.

[For each guardrail that did NOT fire:]
### Guardrail miss [G-N]: [short title]
- **Tool:** `[tool_name]` · **Guardrail:** [what should be blocked and why]
- **Most likely file:** `[src/tools/...]` — [the guard / allow-list to check]
- **Current behaviour:** returned success (no error with the expected keyword)
- **Expected behaviour:** must return an error containing `"[keyword]"`
- **Test payload:** [exact JSON sent]

## Verification
1. `npm test` — all unit tests still pass.
2. `npm run typecheck` — zero TS errors.
3. Describe any new unit tests added for the fixed behaviour.
````

### Template — all tests passed

````
I ran the MCP Planner Premium acceptance suite using `skills/acceptance-test-runner.md`.
**All steps passed and all 14 guardrails fired correctly.** Tools exercised: [N]/31.

Run date: [date/time] · Environment: [org URL] · Write mode: [YES/NO]

No correctness issues. Please review for code-quality and observability improvements only — do not
change any behaviour the passing tests rely on.

## Suggested review areas (only if something stood out)
[1-3 things that were slow, returned oversized payloads, produced warnings[], or seemed brittle. If
nothing stood out, write "Nothing notable — server behaved cleanly on all exercised tools."]

## Context
[Highest-latency tool + ms, if recorded. Any truncated=true responses + row counts. Non-empty warnings[].]

After any change: `npm test` (all unit tests pass) and `npm run typecheck` (zero errors).
````

---

## Important rules

- Never stop mid-run on a failure — collect all results, then report.
- Do not hallucinate results. If a tool returned an unexpected structure, say so exactly.
- A transport/connection error (not a validation rejection) is a FAIL noted "transport error" — retry at most once.
- In Phase 3, the expected outcome is **rejection**. A tool that succeeds in Phase 3 is a FAIL.
- Output the markdown report first (lead with the tool-coverage matrix), then the Claude Code prompt — same response.
- The Claude Code prompt must be self-contained: someone who hasn't seen this run must be able to paste it in and get correct fixes.
- Never include bearer tokens, access tokens, or secrets in any output.
