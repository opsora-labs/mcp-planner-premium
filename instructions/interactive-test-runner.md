# Skill: MCP Planner Premium — Interactive Test Runner

## Purpose

You are a QA engineer running the acceptance test suite for the **mcp-planner-premium** MCP server.
You have the server's MCP connection active in this session. Your job is to call each tool in the
prescribed order, record every result as you go, then write a complete markdown report at the end.

**Pass/fail is decided by you checking the actual return values — not by trusting that a tool call
"looked successful". Check every field listed in each step's criteria.**

---

## Before you start

Ask the user **both** questions before calling any tool:

1. **Which phases?** — "Which phases should I run? Reply with a comma list:
   - `0` — Preflight (whoami + tool inventory) — always recommended
   - `1` — Read sweep (all 10 read tools, no writes)
   - `2` — Write lifecycle (creates a real test plan with 3 buckets and 10 tasks, verifies all attributes, cleans up)
   - `3` — Guardrail tests (13 negative-path tests, no real data needed)
   
   Examples: `0,1,2,3` (full run), `0,1` (read-only), `3` (guardrails only), `0,1,2` (write but skip guardrails)"

2. **Write mode (only if Phase 2 is selected)** — "Phase 2 creates a test plan, 3 buckets, and 10 tasks with rich attributes, then cleans everything up. Confirm YES to proceed, or NO to skip Phase 2."

Keep a running tally in memory: `PASS`, `FAIL`, `SKIP` counts. Do **not** stop on first failure —
continue all selected phases and report everything at the end.

> **Mind the tool-call budget.** A full run (Phases 0-3) makes ~70+ tool calls. If you notice
> you are running low on budget mid-Phase 2, finish Phase 2 cleanup first, then start a fresh
> session for Phase 3 (it is self-contained and needs no real data). When you split, mark the
> skipped steps as `SKIP (run separately)`, not silent gaps.

The environment is determined by the MCP server's connection — do **not** ask the user for it.
Populate the `**Environment:**` field in the report from the `whoami` response (Step 0.2) if it
includes an org/tenant identifier, otherwise write "derived from MCP server connection".

---

## Phase 0 — Preflight (always run)

### Step 0.1 — Tool inventory

Verify all 23 tools are available in this MCP session. The expected tool names are:

```
create_plan, add_bucket, start_change_session,
add_tasks, add_tasks_batch,
update_tasks, update_tasks_batch,
delete_tasks_batch,
apply_changes, check_change_session_status, cancel_change_session,
find_plan_by_name, find_team_member, get_plan_tasks_and_buckets, whoami,
list_plans, get_plan_summary, get_task, list_plan_tasks,
get_bucket_breakdown, list_dependencies, list_team_members, describe_option_set
```

**Pass:** All 23 names are present.
**Fail:** List any missing names.

> You cannot list tools explicitly in most MCP hosts — instead note which tools appear in your
> session's available tool list, or proceed to call them and note any "tool not found" errors.

### Step 0.2 — whoami

Call: `whoami` (no arguments)

**Pass criteria:**
- `ok` is `true`
- `userId` is a non-empty string (looks like a GUID)
- `userEmail` or `userName` is present *(optional — some tenants return only `userId`, `businessUnitId`, `organizationId`; record as PASS with a NOTE if identity display fields are absent)*

Record the `userId` — you will reference it in the report.

---

## Phase 1 — Read sweep (always run, no writes)

These tools are safe on any live environment. If `list_plans` returns zero plans, skip Steps 1.2–1.8
and record them as `SKIP` with reason "no plans in environment".

### Step 1.1 — list_plans

Call: `list_plans` with `{ "top": 5 }`

**Pass criteria:**
- `plans` is an array (may be empty)
- If plans exist: first item has `projectId` (string) and `name` (string)
- If plans exist: `progressPercent` (if not null) is between 0 and 100 — **not** a 0–1 fraction

Record the first plan's `projectId` as `TEST_PROJECT_ID` for the following steps.

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

### Step 1.4 — get_plan_tasks_and_buckets

Call: `get_plan_tasks_and_buckets` with `{ "projectId": "<TEST_PROJECT_ID>" }`

**Pass criteria:**
- `buckets` is an array
- `tasks` is an array
- `summaryTaskIds` is an array
- `truncated` is a boolean
- If tasks exist: `tasks[0].progress` (if not null) is between 0 and 1 (raw fraction in this tool)

Record the first task's `taskId` as `TEST_TASK_ID`.

### Step 1.5 — get_task

Call: `get_task` with `{ "taskId": "<TEST_TASK_ID>" }`

**Pass criteria:**
- `ok` is `true`
- `task.taskId` matches the input
- `task.description` is present (string or null)
- `task.bucketName` is present (string or null — resolved via `$expand`)
- `task.parentTaskSubject` is present (string or null — resolved via `$expand`)
- `task.displaySequence` is present (number or null)
- `task.sprintId` is present (string or null)
- `task.effortHours` is present (number or null)
- `task.outlineLevel` is present (number or null)
- `task.progressPercent` (if not null) is between 0 and 100
- `task.isSummary` is a boolean (true if the task has children)
- `predecessors` is an array
- `successors` is an array
- `assignments` is an array (each entry has `teamMemberId` and `name`)
- `warnings` is an array (degrade path — OK to be empty)

> **Extended fields** (`actualStart`, `actualFinish`, `remainingEffortHours`, `durationHours`)
> are only present on Project Operations tenants. On basic Planner Premium they are absent
> from the response — this is correct behaviour, not a FAIL.

### Step 1.6 — list_plan_tasks (three filters)

Call `list_plan_tasks` three times with `{ "projectId": "<TEST_PROJECT_ID>", "filter": "<value>" }`:

| Call | filter value |
|---|---|
| A | `"all"` |
| B | `"overdue"` |
| C | `"milestones"` |

**Pass criteria per call:**
- `tasks` is an array
- `filter` echoes back the input value
- `truncated` is a boolean
- If tasks exist, each task has: `taskId`, `subject`, `description`, `start`, `finish`,
  `progressPercent`, `effortHours`, `outlineLevel`, `displaySequence`, `priority`,
  `isMilestone`, `isSummary`, `bucketId`, `bucketName`, `parentTaskId`,
  `parentTaskSubject`, `sprintId`

### Step 1.7 — get_bucket_breakdown

Call: `get_bucket_breakdown` with `{ "projectId": "<TEST_PROJECT_ID>" }`

**Pass criteria:**
- `buckets` is an array
- `method` is a string (either `"aggregate"` or `"client"`)
- `truncated` is a boolean
- If buckets exist: `buckets[0].taskCount` is a number; `buckets[0].avgProgressPercent` (if not null) is 0–100

### Step 1.8 — list_dependencies

Call: `list_dependencies` with `{ "projectId": "<TEST_PROJECT_ID>" }`

**Pass criteria:**
- `dependencies` is an array
- `count` is a number
- If entries exist: `dependencies[0].predecessorTaskId` and `successorTaskId` are strings

### Step 1.9 — list_team_members

Call: `list_team_members` with `{ "projectId": "<TEST_PROJECT_ID>" }`

**Pass criteria:**
- `members` is an array
- `count` is a number

### Step 1.10 — describe_option_set

Call: `describe_option_set` with:
```json
{
  "entityLogicalName": "msdyn_projecttaskdependency",
  "attributeLogicalName": "msdyn_projecttaskdependencylinktype"
}
```

**Pass criteria:**
- `ok` is `true`
- `options` is an array with at least 4 entries
- A Finish-to-Start option exists (label like `"Finish to Start"` / `"FinishToStart"`).
  **Record its `value`.**

> **The FS numeric value is environment-dependent — do not hard-fail on a specific
> number.** Most tenants use `192350000` for Finish-to-Start; EU/CRM4 tenants use `1`.
> The server's `DATAVERSE_LINK_TYPE_STYLE` env var (`global` or `eu`) must match what
> this call returns — if FS value is `1`, the server must be running with
> `DATAVERSE_LINK_TYPE_STYLE=eu`, otherwise dependencies are created with the wrong link
> type (`ScheduleAPI-AV-0043`). Flag as NOTE (not FAIL) if the value doesn't match `192350000`;
> only record FAIL if no Finish-to-Start option appears at all.

---

## Phase 2 — Write lifecycle (only if user approved writes)

If Phase 2 was not selected or the user said NO to write mode, record all steps as
`SKIP (write mode disabled)` and move to Phase 3.

**Naming convention:** use `ZZ-MCP-TEST-<YYYYMMDD>` — clearly identifiable as a test plan.
The plan cannot be deleted via the API — remind the user to remove it manually in the Planner UI.

---

### Step 2.1 — create_plan

Call: `create_plan` with:
```json
{ "subject": "ZZ-MCP-TEST-<YYYYMMDD>", "description": "MCP interactive test run — multi-bucket rich hierarchy" }
```

**Pass criteria:** `ok: true`, `projectId` is a GUID.

Save as `NEW_PROJECT_ID`.

---

### Steps 2.2a–2.2c — add three buckets

Call `add_bucket` three times. Each call routes through PSS and polls for completion (~10-30 s).

```json
{ "projectId": "<NEW_PROJECT_ID>", "name": "Planning" }
{ "projectId": "<NEW_PROJECT_ID>", "name": "Development" }
{ "projectId": "<NEW_PROJECT_ID>", "name": "Testing" }
```

**Pass criteria each:** `ok: true`, `bucketId` is a GUID, `note` contains "Bucket persisted".

Save bucket IDs as `BID_PLANNING`, `BID_DEVELOPMENT`, `BID_TESTING`.

---

### Step 2.3 — start_change_session

Call: `start_change_session` with:
```json
{ "projectId": "<NEW_PROJECT_ID>", "description": "E2E test — rich hierarchy" }
```

**Pass criteria:** `ok: true`, `operationSetId` is a GUID. Save as `OP_SET_1`.

---

### Step 2.4 — add_tasks (10 tasks, 3-level hierarchy, 3 buckets, 2 FS dependencies)

This payload exercises: multi-bucket assignment, parent hierarchy, dates, effort, description,
priority, and dependencies across roots. All attributes are set on the ergonomic path.

```json
{
  "operationSetId": "<OP_SET_1>",
  "projectId": "<NEW_PROJECT_ID>",
  "tasks": [
    {
      "ref": "R1",
      "subject": "Programme Kick-off",
      "bucket": "Planning"
    },
    {
      "ref": "R1A",
      "subject": "Stakeholder Alignment",
      "bucket": "Planning",
      "parent": "R1",
      "start": "2026-09-01",
      "finish": "2026-09-05",
      "effortHours": 16,
      "description": "Align all key stakeholders before kick-off",
      "priority": 2
    },
    {
      "ref": "R1A1",
      "subject": "Draft Meeting Agenda",
      "bucket": "Planning",
      "parent": "R1A",
      "description": "Prepare detailed agenda for kick-off meeting"
    },
    {
      "ref": "R1A2",
      "subject": "Send Invitations",
      "bucket": "Planning",
      "parent": "R1A",
      "dependsOn": [{ "on": "R1A1", "type": "FS" }]
    },
    {
      "ref": "R1B",
      "subject": "Technical Setup",
      "bucket": "Development",
      "parent": "R1",
      "start": "2026-09-08",
      "finish": "2026-09-12"
    },
    {
      "ref": "R1B1",
      "subject": "Environment Configuration",
      "bucket": "Development",
      "parent": "R1B",
      "effortHours": 8
    },
    {
      "ref": "R2",
      "subject": "Delivery Phase",
      "bucket": "Development",
      "start": "2026-09-15",
      "finish": "2026-09-30"
    },
    {
      "ref": "R2A",
      "subject": "Development Sprint",
      "bucket": "Development",
      "parent": "R2",
      "effortHours": 40,
      "description": "Primary development sprint"
    },
    {
      "ref": "R2A1",
      "subject": "Core Feature Build",
      "bucket": "Development",
      "parent": "R2A",
      "effortHours": 32,
      "description": "Primary deliverable — core feature implementation",
      "dependsOn": [{ "on": "R1B1", "type": "FS" }]
    },
    {
      "ref": "R2B",
      "subject": "QA and Sign-off",
      "bucket": "Testing",
      "parent": "R2",
      "priority": 2
    }
  ]
}
```

**Pass criteria:**
- `ok` is `true`
- `taskRefs` has 10 keys: `R1`, `R1A`, `R1A1`, `R1A2`, `R1B`, `R1B1`, `R2`, `R2A`, `R2A1`, `R2B`
- `dependencyIds` is an array with **2 GUIDs** (one per FS dependency: R1A1→R1A2, R1B1→R2A1)

Save all 10 task IDs as `CREATED_TASK_IDS`. Save `dependencyIds` (2 GUIDs) as `CREATED_DEP_IDS`.
Save `taskRefs.R1A` as `VERIFY_TASK_R1A`. Save `taskRefs.R2A1` as `VERIFY_TASK_R2A1`.

---

### Step 2.5 — apply_changes

Call: `apply_changes` with `{ "operationSetId": "<OP_SET_1>" }`

**Pass criteria:** `ok: true`.

---

### Step 2.6 — poll for completion

Call `check_change_session_status` (no args). Repeat up to 10 × 3 s until `openSets` is empty.

**Pass criteria:** `openSets` empties within the budget.

> **Persistence lag:** wait an additional ~5–10 s after openSets clears before Step 2.7.

---

### Step 2.7 — verify task creation

**Step 2.7a — bulk count.** Call `get_plan_tasks_and_buckets` with `{ "projectId": "<NEW_PROJECT_ID>" }`.
Retry up to 6 × 5 s until `taskCount` reaches 10.

**Pass criteria:**
- `taskCount` = 10
- `summaryTaskIds` includes at least `R1`, `R1A`, `R1B`, `R2`, `R2A` (all 5 parents)

Save `summaryTaskIds` as `SUMMARY_IDS`.

**Step 2.7b — attribute verification on R1A.** Call `get_task` with `{ "taskId": "<VERIFY_TASK_R1A>" }`.

**Pass criteria — check every attribute set in Step 2.4:**
- `task.subject` is `"Stakeholder Alignment"`
- `task.bucketName` is `"Planning"` — bucket name resolved correctly
- `task.effortHours` is `16`
- `task.description` is `"Align all key stakeholders before kick-off"`
- `task.priority` is `2`
- `task.start` contains `"2026-09-01"` (may include time component)
- `task.finish` contains `"2026-09-05"`
- `task.isSummary` is `true` (R1A has children R1A1 and R1A2)
- `task.parentTaskSubject` is `"Programme Kick-off"` — parent name resolved

**Step 2.7c — dependency verification on R2A1.** Call `get_task` with `{ "taskId": "<VERIFY_TASK_R2A1>" }`.

**Pass criteria:**
- `task.subject` is `"Core Feature Build"`
- `task.bucketName` is `"Development"`
- `task.effortHours` is `32`
- `task.description` is `"Primary deliverable — core feature implementation"`
- `task.isSummary` is `false` (leaf task)
- `predecessors` is a non-empty array (R1B1 is a predecessor via FS link)
- `predecessors[0].predecessorTaskId` matches `taskRefs.R1B1`

**Step 2.7d — list_dependencies.** Call `list_dependencies` with `{ "projectId": "<NEW_PROJECT_ID>" }`.

**Pass criteria:**
- `count` is 2 (two FS dependencies created)
- If `warnings` contains "Dependency links unavailable": record as NOTE, not FAIL — this is an environment limitation (the test created the deps correctly; they just can't be queried via REST on this tenant)

---

### Step 2.8 — update_tasks (set progress, rename, confirm milestone-drop)

Open a second change session:

Call: `start_change_session` with `{ "projectId": "<NEW_PROJECT_ID>", "description": "E2E updates" }`
Save as `OP_SET_2`.

Call `update_tasks` with the following — this also tests milestone being silently dropped:

```json
{
  "operationSetId": "<OP_SET_2>",
  "projectId": "<NEW_PROJECT_ID>",
  "tasks": [
    {
      "taskId": "<taskRefs.R1A1>",
      "subject": "Draft Meeting Agenda (done)",
      "progressPercent": 100,
      "description": "Agenda finalised and approved"
    },
    {
      "taskId": "<taskRefs.R1B1>",
      "progressPercent": 50,
      "milestone": true
    },
    {
      "taskId": "<taskRefs.R2B>",
      "progressPercent": 0,
      "description": "QA not yet started",
      "priority": 1
    }
  ]
}
```

**Pass criteria:**
- `ok` is `true`
- `warnings` is a non-empty array mentioning that `milestone` was ignored on R1B1
- **FAIL** if `warnings` is absent (milestone must be dropped with a warning)

---

### Step 2.9 — apply update session

Call: `apply_changes` with `{ "operationSetId": "<OP_SET_2>" }`

**Pass criteria:** `ok: true`. Wait ~10 s before verifying.

---

### Step 2.10 — verify updates

**Step 2.10a — R1A1 rename + progress + description.** Call `get_task` with `{ "taskId": "<taskRefs.R1A1>" }`.

**Pass criteria:**
- `task.subject` is `"Draft Meeting Agenda (done)"`
- `task.progressPercent` is `100`
- `task.description` is `"Agenda finalised and approved"`
- `task.isMilestone` is `false` (leaf, not a summary, milestone not settable via API)

**Step 2.10b — R1B1 progress + milestone ignored.** Call `get_task` with `{ "taskId": "<taskRefs.R1B1>" }`.

**Pass criteria:**
- `task.progressPercent` is `50`
- `task.isMilestone` is `false` (PSS manages this flag; it cannot be set via API)

**Step 2.10c — R2B description + priority.** Call `get_task` with `{ "taskId": "<taskRefs.R2B>" }`.

**Pass criteria:**
- `task.progressPercent` is `0`
- `task.description` is `"QA not yet started"`
- `task.priority` is `1`

---

### Step 2.11 — cleanup (delete all tasks and dependency entities)

Open cleanup session:

```json
{ "projectId": "<NEW_PROJECT_ID>", "description": "Cleanup" }
```
Save as `OP_SET_CLEAN`.

Call `delete_tasks_batch`:

```json
{
  "operationSetId": "<OP_SET_CLEAN>",
  "projectId": "<NEW_PROJECT_ID>",
  "taskIds": <CREATED_TASK_IDS>,
  "records": [
    { "entityLogicalName": "msdyn_projecttaskdependency", "recordId": "<CREATED_DEP_IDS[0]>" },
    { "entityLogicalName": "msdyn_projecttaskdependency", "recordId": "<CREATED_DEP_IDS[1]>" }
  ],
  "confirmed": true
}
```

Call: `apply_changes` with `{ "operationSetId": "<OP_SET_CLEAN>" }`

**Pass criteria:**
- Both `delete_tasks_batch` and `apply_changes` return `ok: true`

> **Dependency records must come first** in `records` — PSS rejects task deletion if a dependency
> entity still references it (`E_INVALIDENTITYUID`). `projectId` also triggers auto-sort so tasks
> are deleted leaves-first automatically.

**Verify cleanup:** Call `get_plan_tasks_and_buckets` with `{ "projectId": "<NEW_PROJECT_ID>" }`. Retry up to 3 × 5 s.

**Pass criteria:** `taskCount` = 0 (or only Bucket 1 default remains, no tasks).

**Residue:** The plan `ZZ-MCP-TEST-<date>` (and its 3 buckets) remains — remove manually in Planner UI.

---

## Phase 3 — Guardrail tests (always run — no real data needed)

These tests send deliberately invalid payloads. **A test passes when the server returns an error
(not a success).** If the tool returns `ok: true` or a success result, that is a FAIL.

> **Phase 3 is self-contained — run it standalone if you are low on tool-call budget.**
> Every guardrail below uses the placeholder GUIDs and needs no plan, no write session,
> and no Phase 0-2 state. If a full Write-mode run is about to exhaust its budget, start
> a fresh session and run **only** Phase 3 (G1-G13), then merge the guardrail results into
> the report. The last run hit the tool-call limit mid-Phase-2 and never reached these —
> splitting avoids that.

### Two tools, two input formats — why the guardrail payloads differ

The server exposes two task-creation tools with different contracts:

| Tool | Input format | Who builds the OData? |
|---|---|---|
| `add_tasks` | Simplified JSON: `ref`, `subject`, `bucket`, `parent`, `dependsOn` | **Server** — builds `@odata.type`, `@odata.bind`, GUIDs, orders parents first automatically |
| `add_tasks_batch` | Raw OData array: `@odata.type`, `msdyn_*` fields, `@odata.bind` nav properties | **Caller** — you send the full Dataverse entity structure |

This means:
- Guardrails about **raw OData mistakes** (wrong `@odata.type`, bad bind alias, blocked-on-create
  fields, child-before-parent in the array) can **only** be triggered via `add_tasks_batch`,
  because `add_tasks` builds the OData internally and can never produce those errors.
- Guardrails about **ergonomic-input mistakes** (duplicate `ref`, cycle in `parent` chain) can
  **only** be triggered via `add_tasks`, because `ref` and `parent` are ergonomic concepts that do
  not exist in `add_tasks_batch`.
- **Child-before-parent ordering** (G6) is a `add_tasks_batch`-only guard: the ergonomic
  `add_tasks` **auto-reorders** tasks parents-first via topological sort — child-before-parent
  input is silently fixed, never rejected.

Send each test to the tool named in the table below. Do not swap them.

Use these placeholder GUIDs throughout Phase 3 (they don't need to exist in Planner Premium):
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
| G4 | `add_tasks_batch` | Task with `msdyn_ismilestone: true` in entities (blocked-on-create field) | `not allowed on pss create` |
| G5 | `add_tasks_batch` | Task using `"msdyn_bucket@odata.bind"` instead of `"msdyn_projectbucket@odata.bind"` | `valid navigation property` |
| G6 | `add_tasks_batch` | Two tasks where child appears before parent in the array | `parents must appear before` |
| G7 | `add_tasks_batch` | 201 task entities (over the 200-entity cap) | `max 200` *(optional — skip if token budget is tight; the cap is enforced in code before any network call)* |
| G8 | `delete_tasks_batch` | `{ "operationSetId": "FAKE_A", "taskIds": ["FAKE_B"], "confirmed": false }` | `confirmed` |
| G9 | `delete_tasks_batch` | `{ "operationSetId": "FAKE_A", "records": "[{\"entityLogicalName\":\"msdyn_project\",\"recordId\":\"FAKE_B\"}]", "confirmed": true }` | `blocked by policy` |
| G10 | `update_tasks_batch` | `{ "operationSetId": "FAKE_A", "entities": "[{\"@odata.type\":\"Microsoft.Dynamics.CRM.msdyn_projecttaskdependency\"}]" }` | `cannot be updated` |
| G11 | `update_tasks` | `{ "operationSetId": "FAKE_A", "tasks": [{ "taskId": "FAKE_B", "progressPercent": 150 }] }` | `between 0 and 100` |
| G12 | `add_tasks` | Two tasks with the same `ref` value | `duplicate` |
| G13 | `add_tasks` | Two tasks with a cycle: A's parent = B, B's parent = A | `cycle` |

For G4, use this entity payload:
```json
[{
  "@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
  "msdyn_projecttaskid": "FAKE_B",
  "msdyn_subject": "T",
  "msdyn_project@odata.bind": "/msdyn_projects(FAKE_P)",
  "msdyn_projectbucket@odata.bind": "/msdyn_projectbuckets(FAKE_K)",
  "msdyn_ismilestone": true
}]
```

For G6, use this (child listed first):
```json
[
  {
    "@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
    "msdyn_projecttaskid": "FAKE_B",
    "msdyn_subject": "Child",
    "msdyn_project@odata.bind": "/msdyn_projects(FAKE_P)",
    "msdyn_projectbucket@odata.bind": "/msdyn_projectbuckets(FAKE_K)",
    "msdyn_parenttask@odata.bind": "/msdyn_projecttasks(FAKE_A)"
  },
  {
    "@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
    "msdyn_projecttaskid": "FAKE_A",
    "msdyn_subject": "Parent",
    "msdyn_project@odata.bind": "/msdyn_projects(FAKE_P)",
    "msdyn_projectbucket@odata.bind": "/msdyn_projectbuckets(FAKE_K)"
  }
]
```

For G12:
```json
{
  "operationSetId": "FAKE_A",
  "projectId": "FAKE_P",
  "tasks": [
    { "ref": "t1", "subject": "Task A", "bucket": "Sprint 1" },
    { "ref": "t1", "subject": "Task B", "bucket": "Sprint 1" }
  ]
}
```

For G13:
```json
{
  "operationSetId": "FAKE_A",
  "projectId": "FAKE_P",
  "tasks": [
    { "ref": "a", "subject": "A", "bucket": "Sprint 1", "parent": "b" },
    { "ref": "b", "subject": "B", "bucket": "Sprint 1", "parent": "a" }
  ]
}
```

---

## Generating the report

Once all phases are done, write a markdown report using the template below. Fill in every `[...]`
placeholder with real values from your test run. Do not omit sections or skip failed steps — include
everything.

---

```markdown
# MCP Planner Premium — Interactive Test Report

**Run date:** [today's date and time]
**Environment:** [Planner Premium environment, from MCP server connection]
**Tester:** [your model name, e.g. claude-opus-4-8]
**Write mode:** [YES / NO]
**User ID (whoami):** [userId returned in Step 0.2]

---

## Overall Result: [✅ ALL PASS / ❌ N FAILURE(S)]

| Category | Count |
|---|---|
| Total steps | [N] |
| Pass | [N] |
| Fail | [N] |
| Skip | [N] |
| Guardrails fired correctly | [N]/13 |

---

## Phase 0 — Preflight

| # | Step | Result | Notes |
|---|---|---|---|
| 0.1 | Tool inventory (23 tools) | [✅ PASS / ❌ FAIL] | [missing tools or "all present"] |
| 0.2 | whoami | [✅ PASS / ❌ FAIL] | userId: [value] |

---

## Phase 1 — Read Sweep

| # | Step | Tool | Result | Notes |
|---|---|---|---|---|
| 1.1 | list_plans | `list_plans` | [✅/❌/⏭️] | [count returned] |
| 1.2 | find_plan_by_name | `find_plan_by_name` | [✅/❌/⏭️] | [count returned] |
| 1.3 | get_plan_summary | `get_plan_summary` | [✅/❌/⏭️] | totalTasks=[N], progressPercent=[N] |
| 1.4 | get_plan_tasks_and_buckets | `get_plan_tasks_and_buckets` | [✅/❌/⏭️] | [N] tasks, [N] buckets |
| 1.5 | get_task | `get_task` | [✅/❌/⏭️] | isMilestone=[bool], isSummary=[bool], bucketName=[str\|null], extended fields=[present\|absent] |
| 1.6a | list_plan_tasks (all) | `list_plan_tasks` | [✅/❌/⏭️] | [N] tasks, bucketName/parentTaskSubject present=[bool] |
| 1.6b | list_plan_tasks (overdue) | `list_plan_tasks` | [✅/❌/⏭️] | [N] tasks |
| 1.6c | list_plan_tasks (milestones) | `list_plan_tasks` | [✅/❌/⏭️] | [N] tasks |
| 1.7 | get_bucket_breakdown | `get_bucket_breakdown` | [✅/❌/⏭️] | method=[aggregate\|client] |
| 1.8 | list_dependencies | `list_dependencies` | [✅/❌/⏭️] | [N] dependencies |
| 1.9 | list_team_members | `list_team_members` | [✅/❌/⏭️] | [N] members |
| 1.10 | describe_option_set (link types) | `describe_option_set` | [✅/❌/⏭️] | [N] options, FS value=[N] (NOTE if ≠192350000) |

---

## Phase 2 — Write Lifecycle

[If skipped, write: "⏭️ Skipped — write mode not selected or not enabled."]

| # | Step | Tool | Result | Notes |
|---|---|---|---|---|
| 2.1 | create_plan | `create_plan` | [✅/❌] | projectId=[value] |
| 2.2a | add_bucket: Planning | `add_bucket` | [✅/❌] | bucketId=[value], note=[persisted\|queued] |
| 2.2b | add_bucket: Development | `add_bucket` | [✅/❌] | bucketId=[value] |
| 2.2c | add_bucket: Testing | `add_bucket` | [✅/❌] | bucketId=[value] |
| 2.3 | start_change_session | `start_change_session` | [✅/❌] | operationSetId=[value] |
| 2.4 | add_tasks (10 tasks, 3 buckets, 2 deps) | `add_tasks` | [✅/❌] | taskRefs=[R1..R2B], depIds=2 |
| 2.5 | apply_changes | `apply_changes` | [✅/❌] | — |
| 2.6 | poll for completion | `check_change_session_status` | [✅/❌] | [N] polls needed |
| 2.7a | verify task count | `get_plan_tasks_and_buckets` | [✅/❌] | taskCount=10, summaryIds=[N] |
| 2.7b | verify R1A attributes | `get_task` | [✅/❌] | bucketName=Planning, effortHours=16, isSummary=true, parentSubject correct |
| 2.7c | verify R2A1 dependency | `get_task` | [✅/❌] | predecessors=[R1B1], description correct |
| 2.7d | verify dependencies | `list_dependencies` | [✅/❌/⏭️NOTE] | count=2 or env-limitation note |
| 2.8 | update_tasks (progress+desc; milestone drop) | `update_tasks` | [✅/❌] | warnings=[milestone ignored] |
| 2.9 | apply update session | `apply_changes` | [✅/❌] | — |
| 2.10a | verify R1A1 update | `get_task` | [✅/❌] | subject=done, progress=100, desc updated |
| 2.10b | verify R1B1 update | `get_task` | [✅/❌] | progress=50, isMilestone=false |
| 2.10c | verify R2B update | `get_task` | [✅/❌] | desc set, priority=1 |
| 2.11 | cleanup (10 tasks + 2 dep entities) | `delete_tasks_batch` | [✅/❌] | taskCount=0 after verify |

**Residue:** Plan `ZZ-MCP-TEST-<date>` (id: [projectId]) remains — 3 buckets + plan need manual removal in Planner UI.

---

## Phase 3 — Guardrail Tests

| # | Guard tested | Tool | Fired correctly? | Error snippet |
|---|---|---|---|---|
| G1 | Empty plan name | `find_plan_by_name` | [✅ YES / ❌ NO] | [first line of error] |
| G2 | Invalid GUID format | `get_plan_summary` | [✅/❌] | [error] |
| G3 | Disallowed @odata.type | `add_tasks_batch` | [✅/❌] | [error] |
| G4 | Blocked-on-create field | `add_tasks_batch` | [✅/❌] | [error] |
| G5 | Wrong bind alias | `add_tasks_batch` | [✅/❌] | [error] |
| G6 | Child before parent | `add_tasks_batch` | [✅/❌] | [error] |
| G7 | >200 entities | `add_tasks_batch` | [✅/❌/⏭️ SKIP-optional] | [error or "skipped — token cost"] |
| G8 | Delete without confirmed=true | `delete_tasks_batch` | [✅/❌] | [error] |
| G9 | Whole-plan delete blocked | `delete_tasks_batch` | [✅/❌] | [error] |
| G10 | Dependency update rejected | `update_tasks_batch` | [✅/❌] | [error] |
| G11 | progressPercent > 100 | `update_tasks` | [✅/❌] | [error] |
| G12 | Duplicate ref | `add_tasks` | [✅/❌] | [error] |
| G13 | Cycle in parent chain | `add_tasks` | [✅/❌] | [error] |

---

## Failure Detail

[For each ❌ FAIL above, add a subsection:]

### [Step ID] — [Step name]

- **Tool:** `[tool name]`
- **Input summary:** [key fields sent]
- **Actual response:** [what the tool returned]
- **Expected:** [what the pass criteria required]

---

## Cleanup Notes

[List any test artefacts remaining in Planner Premium that the user must remove manually.]

---

*Report generated by [model] following `instructions/SKILL.md` in mcp-planner-premium.*
```

---

## Generating the Claude Code optimization prompt

After the markdown report, **always** generate a second output block titled
**"Claude Code Optimization Prompt"**. The user pastes this directly into a Claude Code session
opened at the project root (`mcp-planner-premium/`) — no manual translation needed.

### Rules for building the prompt

- If all tests passed and all 13 guardrails fired: the prompt asks for code-quality and
  observability improvements only (see the "All-pass template" below).
- If any tests failed or any guardrail did not fire: the prompt lists every issue with the exact
  file to change, what the current behaviour is, and what the correct behaviour must be.
- Always include the project map, the test commands, and the verification section so Claude Code
  can confirm its own fixes without asking the user.
- Never include the Dataverse access token or any bearer token in the prompt.

---

### Project map (paste verbatim into every prompt)

```
Project: mcp-planner-premium
Language: TypeScript (Node.js ≥ 22, @modelcontextprotocol/sdk)
Test command: npm test                  (unit tests — no network needed)
Type-check:   npm run typecheck         (src/) and npm run typecheck:e2e (test/e2e/)
E2E command:  npm run e2e               (requires env vars — see README §End-to-end)

Key source files:
  src/server.ts                         MCP server, tool registration, SERVER_INSTRUCTIONS
  src/app.ts                            Express app, JWT middleware, rate limit, helmet
  src/auth.ts                           JWT validation (jose, Entra JWKS)
  src/config.ts                         Zod env schema, acaDerivedHost()
  src/context.ts                        AsyncLocalStorage bearer context
  src/dataverse.ts                      dvReq(), assertGuid(), errMessage(), throwIfPssCreateError()
  src/tools/index.ts                    allTools[] array, toolAnnotations
  src/tools/addTasksSimple.ts           buildTaskEntities() — ergonomic add_tasks logic
  src/tools/updateTasksSimple.ts        buildUpdateEntities() — ergonomic update_tasks logic
  src/tools/addTasks.ts                 raw add_tasks_batch handler + guardrails
  src/tools/updateTasks.ts              raw update_tasks_batch handler + guardrails
  src/tools/deleteTasks.ts             delete_tasks_batch handler + confirmed gate
  src/tools/createPlan.ts              create_plan handler
  src/tools/addBucket.ts               add_bucket handler
  src/tools/startChangeSession.ts      start_change_session handler
  src/tools/applyChanges.ts            apply_changes handler
  src/tools/checkStatus.ts             check_change_session_status handler
  src/tools/cancelSession.ts           cancel_change_session handler
  src/tools/findPlan.ts                find_plan_by_name handler
  src/tools/findTeamMember.ts          find_team_member handler
  src/tools/getPlanContents.ts         get_plan_tasks_and_buckets handler
  src/tools/whoami.ts                  whoami handler
  src/tools/listPlans.ts               list_plans handler
  src/tools/getPlanSummary.ts          get_plan_summary handler
  src/tools/getTask.ts                 get_task handler
  src/tools/listPlanTasks.ts           list_plan_tasks handler
  src/tools/getBucketBreakdown.ts      get_bucket_breakdown handler
  src/tools/listDependencies.ts        list_dependencies handler
  src/tools/listTeamMembers.ts         list_team_members handler
  src/tools/describeOptionSet.ts       describe_option_set handler
  src/tools/readHelpers.ts             summariseTasks(), pageAll(), nowIso(), linkTypeLabel()
  test/guardrails.test.ts              unit tests: validateAddEntities, validateUpdateEntities
  test/buildTasks.test.ts              unit tests: buildTaskEntities
  test/buildUpdate.test.ts             unit tests: buildUpdateEntities
  test/deleteTasks.test.ts             unit tests: buildDeleteEntities, sortTaskIdsLeavesFirst
  test/listDependencies.test.ts        unit tests: list_dependencies graceful 404 degrade
  test/deepHierarchy.test.ts           unit tests: 6-level hierarchy
  test/readHelpers.test.ts             unit tests: summariseTasks, linkTypeLabel (dual range)
  test/auth.test.ts                    unit tests: JWT validation
  test/http.test.ts                    unit tests: HTTP layer (supertest)
```

---

### Template — when there are failures or missed guardrails

Produce a code block containing:

````
I ran the MCP Planner Premium interactive acceptance test suite using `instructions/SKILL.md`.
Here are the findings. Please fix all issues listed below, run `npm test` to verify no unit tests
broke, then confirm which files were changed and why.

## Test run summary

- Date: [date/time]
- Environment: [org URL]
- Write mode: [YES / NO]
- Overall result: [N pass / N fail / N skip / N guardrails fired out of 13]

## Issues to fix

[For each FAIL, one entry in this exact format:]

### Issue [N]: [Short title, e.g. "get_task returns progress as 0-1 fraction instead of 0-100"]

- **Tool:** `[tool_name]`
- **Step:** [phase and step number, e.g. "Phase 1, Step 1.5"]
- **Most likely file:** `[src/tools/fileName.ts]` — [one sentence on what to look for]
- **Current behaviour:** [what the tool returned — exact field values]
- **Expected behaviour:** [what the pass criteria require — be precise]
- **Reproduction:** Call `[tool_name]` with `[minimal input JSON]` and check `[field]`.

[For each guardrail that did NOT fire (tool returned success instead of error), one entry:]

### Guardrail miss [G-N]: [Short title, e.g. "add_tasks_batch accepted msdyn_ismilestone on create"]

- **Tool:** `[tool_name]`
- **Guardrail:** [what was supposed to be blocked and why]
- **Most likely file:** `[src/tools/addTasks.ts]` — check the `BLOCKED_ON_CREATE` list or the
  relevant guard function
- **Current behaviour:** tool returned success (or no error mentioning the expected keyword)
- **Expected behaviour:** tool must return an error containing `"[expected keyword]"`
- **Test payload:** [paste the exact JSON sent]

## Verification

After your changes:

1. Run `npm test` — all [N] existing unit tests must still pass.
2. Run `npm run typecheck` — zero TypeScript errors.
3. If you added new unit tests for the fixed behaviour, describe them.
4. Optionally note which tests in `test/guardrails.test.ts` or `test/buildTasks.test.ts` already
   cover the fixed case (so I can re-run the interactive suite to confirm).

## Context

[If there were any ambiguous failures — e.g. "it might be a Dataverse environment quirk, not a
code bug" — note them here so Claude Code can weigh the probability before changing code.]
````

---

### Template — all tests passed (no failures)

Produce a code block containing:

````
I ran the MCP Planner Premium interactive acceptance test suite using `instructions/SKILL.md`.
**All tests passed and all 13 guardrails fired correctly.**

Run date: [date/time] · Environment: [org URL] · Write mode: [YES/NO]
Result: [N] pass / 0 fail / [N] skip · Guardrails: 13/13

No correctness issues to fix. Please review the server for code-quality and observability
improvements only. Do not change any behaviour that the passing tests rely on.

## Suggested review areas (if any stood out during the run)

[List 1-3 things that were slow, returned more data than expected, had unexpectedly large response
payloads, produced warnings[], or seemed brittle based on what you saw. If nothing stood out, write
"Nothing notable — server behaved cleanly on all 23 tools."]

## Context

[Tool with highest latency and its latency in ms, if you recorded it.]
[Any tools that returned truncated=true and what the row count was.]
[Any warnings[] arrays that were non-empty and what they contained.]

After any changes:
1. Run `npm test` — all unit tests must still pass.
2. Run `npm run typecheck` — zero TypeScript errors.
````

---

## Important rules

- Never stop mid-run on a failure — collect all results then report.
- Do not hallucinate results. If a tool returned an unexpected structure, say so exactly.
- If a tool call fails with a transport/connection error (not a validation rejection), record it as
  FAIL and note "transport error" — do not retry more than once.
- In Phase 3, the expected outcome is **rejection**. A tool that succeeds in Phase 3 is a test FAIL.
- Output the markdown report first, then the Claude Code prompt — both in the same response.
- The Claude Code prompt must be self-contained: someone who hasn't seen this test run must be
  able to paste it into Claude Code and get correct fixes without asking follow-up questions.
- Never include bearer tokens, access tokens, or secrets in the Claude Code prompt.
