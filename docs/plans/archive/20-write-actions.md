# Plan 20 — WRITE / PM-ACTION features

Architect plan for the PM-action write features on `feat/pm-feature-suite`. **Planning
only.** Implementers must read `CLAUDE.md` first and obey every golden rule: never weaken
a guardrail, branch per feature, green (`npm run typecheck && npm test`) before done, tests
ship with behaviour, Zod at the boundary, `assertGuid` before any GUID enters a URL/session.

All Dataverse entity-set / bind / field names in this plan are **copied verbatim from the
existing code** (`addTasksSimple.ts`, `getTask.ts`, `deleteTasks.ts`, `findTeamMember.ts`,
`listTeamMembers.ts`). Nothing here is invented — every name below is already proven live.

---

## Current-state verification (what the commits already did)

Read before implementing — most of this suite is **already shipped**; the remaining work is
narrow. Verified by reading the source on `feat/pm-feature-suite` (not just the commit log):

| TODO item | State | Evidence |
|---|---|---|
| Sprint on `add_tasks` | **DONE** (203c5ef) | `addTasksSimple.ts` `SimpleTask.sprint` + lines 221-229 emit `msdyn_projectsprint@odata.bind`; handler resolves sprint name→id (lines 540-582). Tested: `buildTasks.test.ts` "binds a sprint via the resolver" / "throws when a sprint cannot be resolved". |
| Sprint on `update_tasks` | **MISSING** | `SimpleTaskUpdate` (updateTasksSimple.ts:11-26) has no `sprint`. This is the only sprint gap. |
| Reparent via `update_tasks parent` | **DONE** (9e5b2fa) | `updateTasksSimple.ts:134-163` emits `msdyn_parenttask@odata.bind`; null-parent dropped with warning; non-GUID rejected. Tested: `buildUpdate.test.ts:118-144` (3 reparent cases). `validateUpdateEntities` already folds parent-bind targets into the summary set (updateTasks.ts:78-84). **Open item:** README "Open TODOs" still says "Whether PSS honours a parent change on update is unconfirmed live — needs an e2e test." → e2e confirmation is the remaining work, not code. |
| Assignees on `add_tasks` | **DONE** | `addTasksSimple.ts:342-367` builds `msdyn_resourceassignment` with proven binds; handler resolves team members (lines 615-649). Tested: `buildTasks.test.ts` "builds a resource assignment for a resolved team member". |
| Standalone assign / **unassign** tool | **MISSING** | No tool to add/remove an assignment on an *existing* task without re-running `add_tasks`; no way to **remove** an assignment at all from the ergonomic surface (only raw `delete_tasks_batch` with a hand-tracked assignmentId). |
| Dependency cascade-delete | **MISSING** | `deleteTasks.ts` requires the caller to pass dependency GUIDs in `records` before task ids. README "Open TODOs" describes the desired auto-fetch. No test, no "cascade" string anywhere in the repo. |

**Net remaining work:** (1) standalone assign/unassign tool, (2) `sprint` on `update_tasks`,
(3) e2e confirmation + (kept) unit test for reparent, (4) cascade dependency auto-fetch in
`delete_tasks_batch`.

---

## Proven Dataverse names (single source of truth for this plan)

Copy these exactly. Casing matters (PSS rejects wrong casing).

**Resource assignment entity** (`msdyn_resourceassignment`) — write binds, from
`addTasksSimple.ts:356-365`:
- `@odata.type`: `Microsoft.Dynamics.CRM.msdyn_resourceassignment`
- pk: `msdyn_resourceassignmentid`
- `msdyn_name` (string; the assignment label — the code uses the assignee string)
- `msdyn_taskid@odata.bind` → `/msdyn_projecttasks(<taskGuid>)`
- `msdyn_projectid@odata.bind` → `/msdyn_projects(<projectGuid>)`
- `msdyn_projectteamid@odata.bind` → `/msdyn_projectteams(<teamMemberGuid>)`
- `msdyn_bookableresourceid@odata.bind` → `/bookableresources(<bookableResourceGuid>)` (optional)

**Resource assignment read** (from `getTask.ts:137-158`):
- collection: `msdyn_resourceassignments`
- `$select=msdyn_resourceassignmentid,_msdyn_taskid_value,_msdyn_projectteamid_value,_msdyn_projectid_value`
- `$expand=msdyn_projectteamid($select=msdyn_name)`
- `$filter=_msdyn_taskid_value eq <taskGuid>`

**Project team** (member resolution, from `findTeamMember.ts:30-38` / `listTeamMembers.ts:20-31`):
- collection: `msdyn_projectteams`
- `$select=msdyn_projectteamid,msdyn_name,_msdyn_bookableresourceid_value`
- `$filter=_msdyn_project_value eq <projectGuid>`
- member → assignment: `teamMemberId = msdyn_projectteamid`, `bookableResourceId = _msdyn_bookableresourceid_value`

**Sprint** (from `addTasksSimple.ts:228` + resolver 540-582):
- bind: `msdyn_projectsprint@odata.bind` → `/msdyn_projectsprints(<sprintGuid>)`
- resolve: collection `msdyn_projectsprints`, `$select=msdyn_projectsprintid,msdyn_name`, `$filter=_msdyn_project_value eq <projectGuid>&$top=200`

**Dependency** (from `getTask.ts:74-103` + write side `addTasksSimple.ts:277-299`):
- collection (READ, plural): `msdyn_projecttaskdependencies`
- pk: `msdyn_projecttaskdependencyid`
- read value aliases (lowercase): `_msdyn_predecessortask_value`, `_msdyn_successortask_value`
- read filter: `_msdyn_predecessortask_value eq <taskGuid> or _msdyn_successortask_value eq <taskGuid>`
- deletable logical name (singular): `msdyn_projecttaskdependency` (already in `DELETABLE`, deleteTasks.ts:8)

**Parent task** (reparent, from `updateTasksSimple.ts:160`):
- bind: `msdyn_parenttask@odata.bind` → `/msdyn_projecttasks(<parentGuid>)`

---

# Feature 1 — Resource assignments (assign / unassign on an existing task)

### Context
`add_tasks` can assign members at create time, but a PM working a live board needs to
add/remove an assignee on a task that already exists, without re-creating it. There is no
ergonomic unassign path at all today. We add ONE new tool that covers both directions.

### Decision: how to write
Match the codebase. All structural writes go through the **PSS change-session** lifecycle
(`start_change_session` → tool → `apply_changes`). `add_tasks` already creates
`msdyn_resourceassignment` via `msdyn_PssCreateV2`, and `delete_tasks_batch` removes them via
`msdyn_PssDeleteV2`. So:
- **Assign** = build a `msdyn_resourceassignment` create entity → `msdyn_PssCreateV2`
  (reuse `throwIfPssCreateError`). Same shape as the assignees branch in `buildTaskEntities`.
- **Unassign** = `msdyn_PssDeleteV2` of the existing `msdyn_resourceassignmentid`(s), behind the
  `confirmed` gate (unassign is a removal of existing data — destructive).

Do **not** do a direct entity create/delete outside a change session — that would be a second
write contract and break the "everything is in an operation set" model the server guarantees.

### Tool / contract
New tool `assign_task` (one tool, two modes), registered in `index.ts`.

- **name:** `assign_task`
- **title:** `Assign / Unassign Task`
- **annotation:** split is awkward for a dual-mode tool; register it as **UPDATE**
  (`{readOnlyHint:false, destructiveHint:true, openWorldHint:true}`) because the unassign mode
  removes existing data. (Assign-only is additive, but annotations are advisory and the
  `confirmed` gate is the real guard; the stricter hint is the safe choice.)
- **inputSchema** (Zod at boundary):
  - `operationSetId: z.string()` — GUID of the open OperationSet.
  - `projectId: z.string()` — GUID of the plan (needed to resolve members AND to bind
    `msdyn_projectid@odata.bind` on create; also used to scope the membership guardrail).
  - `taskId: z.string()` — GUID of the task to (un)assign.
  - `assignees: z.union([z.string(), z.array(z.string())])` — member name(s) OR teamMemberId
    GUID(s), resolved against the plan's project team (same resolver semantics as `add_tasks`).
  - `mode: z.enum(["assign","unassign"]).optional()` default `"assign"`.
  - `confirmed: z.boolean().optional()` — REQUIRED to be `true` only when `mode==="unassign"`
    (mirror the `delete_tasks_batch` gate; an explicit per-record user confirmation).
- **output:** `{ ok, mode, taskId, queued, assigned?: [{name, teamMemberId, assignmentId}],
  removed?: [{assignmentId, teamMemberId, name}], skipped?: string[], warnings?, response, note }`.
  `note` ends with the standard "NOT saved until 'Apply Changes to Plan'." line.

### Behaviour
**assign mode:**
1. `assertGuid` on `operationSetId`, `projectId`, `taskId`.
2. Resolve each assignee against `msdyn_projectteams` for `projectId` (reuse the exact resolver
   logic already in `addTasksSimple.ts:615-649`: by-id map keyed on `msdyn_projectteamid`
   lowercased, by-name map on `msdyn_name`). Unknown assignee → **skip with warning**
   (same wording as add_tasks: "not a member of this plan's project team").
   **Guardrail (membership):** a member that does not belong to *this* plan's team is never
   assigned — the resolver only knows members returned by the `_msdyn_project_value eq projectId`
   query, so cross-plan assignment is structurally impossible.
3. (Recommended) idempotence read: GET existing `msdyn_resourceassignments` for `taskId`
   (the getTask read shape) and skip-with-warning any assignee whose `teamMemberId` is already
   assigned, so a re-run doesn't create a duplicate row. Non-fatal if the read fails.
4. Build a `msdyn_resourceassignment` create entity per resolved, not-already-assigned member —
   **identical field set to `addTasksSimple.ts:356-365`** (name + the 3 required binds + optional
   bookableresource bind; NEVER set `msdyn_start`/`msdyn_finish` — blocked on create).
5. Extract the pure builder so it is unit-testable (see "Files").
6. `msdyn_PssCreateV2` with `{ EntityCollection, OperationSetId }`; `throwIfPssCreateError`.

**unassign mode:**
1. `assertGuid` on the three GUIDs; require `confirmed === true` (reuse the delete-gate message).
2. Read `msdyn_resourceassignments` for `taskId` (`_msdyn_taskid_value eq taskId`, select id +
   `_msdyn_projectteamid_value`, expand team name).
3. Resolve each requested assignee to a `teamMemberId` (name or GUID), then map to the
   `msdyn_resourceassignmentid`(s) whose `_msdyn_projectteamid_value` matches. Requested
   assignee with no live assignment → skip with warning ("not currently assigned to this task").
4. `msdyn_PssDeleteV2` of those assignment ids using `buildDeleteEntities`
   (`entityLogicalName: "msdyn_resourceassignment"`). Reuse `validateDeleteRecords` (it already
   allows `msdyn_resourceassignment` and enforces the 200 cap + whole-plan block).

### Exact Dataverse entities/binds
See "Proven Dataverse names" → Resource assignment entity (create) + Resource assignment read +
Project team. Delete uses logical name `msdyn_resourceassignment` through the existing
`buildDeleteEntities`/`validateDeleteRecords`.

### Guardrails preserved (enumerate)
- GUIDs validated via `assertGuid` before any URL/session call (op set, project, task).
- **Entity allow-list:** the create collection contains only `msdyn_resourceassignment`; run
  `validateAddEntities(entities)` on the built batch (defense-in-depth, as `add_tasks` does) so
  the existing allow-list / blocked-field checks apply.
- **Blocked-on-create:** never emit `msdyn_start`/`msdyn_finish` on the assignment (matches
  add_tasks; PSS derives them).
- **Membership guardrail:** assignee must belong to this plan's project team (resolver-scoped).
- **`confirmed` gate** required for unassign (a removal). Assign does not need it (additive).
- **200-entity cap** via `validateAddEntities` (create) and `validateDeleteRecords` (delete).
- **Whole-plan delete block** inherited from `validateDeleteRecords` (n/a here but preserved).
- Change-session lifecycle preserved (writes only via an open operationSetId, applied later).

### New guardrail
- **Duplicate-assignment guard** (idempotence): skip an assignee already assigned to the task
  (warning, not error) so re-runs don't create duplicate `msdyn_resourceassignment` rows.

### Files to create / modify
- **Create** `src/tools/assignTask.ts` — tool + a pure exported builder
  `buildAssignmentEntities(projectId, taskId, members)` returning
  `{ entities, assigned, skipped, warnings }` (members already resolved → `{name, teamMemberId,
  bookableResourceId}`), so resolution (network) stays in the handler and the OData shape stays
  unit-testable. Reuse `buildDeleteEntities`/`validateDeleteRecords` from `deleteTasks.ts` for
  the unassign path (import, do not duplicate).
- **Modify** `src/tools/index.ts` — import `assignTask`, add to `allTools`, add
  `assign_task: UPDATE` to `toolAnnotations`.
- **Modify** `README.md` tool table + the tool-notes section.
- **Modify** `SERVER_INSTRUCTIONS` in `src/server.ts` (new write surface) and `SECURITY.md` /
  `QUALITY-ASSURANCE.md` (new confirmed-gated removal path + membership guarantee).

### Unit tests — `test/buildAssignment.test.ts`
Import `buildAssignmentEntities` from `../src/tools/assignTask.js` and
`validateAddEntities` from `../src/tools/addTasks.js`. Mirror `buildTasks.test.ts` style
(`describe/it`, `expect().toBe/toHaveLength/toThrow/not.toThrow`, `find`-by-`@odata.type`).
Cases:
1. **builds a single assignment with the four proven binds, no start/finish** — assert
   `@odata.type`, `msdyn_taskid@odata.bind`, `msdyn_projectid@odata.bind`,
   `msdyn_projectteamid@odata.bind`, `msdyn_bookableresourceid@odata.bind`; assert
   `"msdyn_start" in e === false` and `"msdyn_finish" in e === false`; `validateAddEntities` not.toThrow.
2. **omits the bookableresource bind when bookableResourceId is empty** (optional bind).
3. **multiple members → one entity each, unique GUIDs** (assert `validateAddEntities` passes the
   duplicate-GUID guard).
4. **already-assigned member is skipped** — pass an `alreadyAssignedTeamIds` set into the
   builder; assert the entity is omitted and a warning is produced.
5. (negative) **empty members → no entities / clear error** (match the empty-array contract).
For the delete/unassign path, add cases to `test/deleteTasks.test.ts` (or a small block in the
new file): a `msdyn_resourceassignment` record passes `validateDeleteRecords`; whole-plan still
blocked; >200 still throws.

### e2e self-test (`scenarios/lifecycle.ts`, gated `E2E_ALLOW_WRITES`, scratch plan only)
Operate on the **throwaway `ZZ-MCP-E2E-*` plan** (each run creates its own — there is no shared
seed board to corrupt). Sequence, appended after the existing add/update steps:
1. Resolve a team member via `list_team_members` (the plan creator is on the team). If the team
   is empty, **skip the assignment steps with a logged note** (do not fail — some test tenants
   have no extra bookable resources).
2. Open a session → `assign_task` (mode assign) on an existing leaf task → `apply_changes` → poll.
3. **Independent OData verify** (extend `verify.ts`): new helper
   `verifyAssignmentCount(taskId, bearer): Promise<number>` GETting
   `/msdyn_resourceassignments?$filter=_msdyn_taskid_value eq <taskId>&$count=true&$top=0` →
   assert count increased by the number assigned.
4. Open a session → `assign_task` (mode unassign, `confirmed:true`) → apply → poll →
   `verifyAssignmentCount` back to baseline.
5. Cleanup is unchanged (tasks deleted in the existing cleanup; assignments cascade via task
   delete — and the new cascade in Feature 4 also covers deps). No seed corruption: everything is
   inside the test's own plan.

---

# Feature 2 — Sprint on `update_tasks`

### Context
`add_tasks` already places a task in a sprint (`sprint` field). `update_tasks` cannot move an
*existing* task into/out of a sprint except via the raw `update_tasks_batch`
(`msdyn_projectsprint@odata.bind`). Add first-class `sprintId`/`sprint` to the ergonomic update.

### Tool / contract changes
Extend the existing `update_tasks` (no new tool).
- `updateSchema` (updateTasksSimple.ts) gains:
  `sprint: z.string().optional()` — sprint NAME (resolved against the plan; requires `projectId`)
  OR a `sprintId` GUID. Description mirrors the bucket field ("Requires projectId at the top level
  for name resolution; pass a sprintId GUID to skip the lookup.").
- `SimpleTaskUpdate` gains `sprint?: string`.
- `buildUpdateEntities` gains a `resolvedSprintIds?: Map<number, string>` parameter (mirror the
  existing `resolvedBucketIds` plumbing exactly). When `t.sprint` is set, emit
  `ent["msdyn_projectsprint@odata.bind"] = "/msdyn_projectsprints(" + sprintId + ")"` and
  `changed++`. If `t.sprint` is set but no resolved id → throw the same "could not be resolved …
  create it first with add_sprint, or pass a sprintId GUID" error used in `add_tasks`.
- Handler resolves sprint names→ids with **one read** of `msdyn_projectsprints` for `projectId`
  (copy the resolver block from `addTasksSimple.ts:540-582`; reuse the duplicate-name guard).
  GUIDs in `sprint` bypass the lookup (set directly into the map, mirroring the bucket-GUID path
  at updateTasksSimple.ts:298-303).

**Note (scope):** "remove from sprint" (null sprint) is **not supported** — PSS rejects null
lookup binds (consistent with the null-parent / null-date handling already in the file). If
`sprint === null` is passed, drop it with a warning, matching the `parent === null` pattern
(updateTasksSimple.ts:140-149). Document this in the field description.

### Exact Dataverse entities/binds
`msdyn_projectsprint@odata.bind` → `/msdyn_projectsprints(<sprintGuid>)`. Resolver collection
`msdyn_projectsprints` (select `msdyn_projectsprintid,msdyn_name`, filter `_msdyn_project_value
eq <projectId>`).

### Guardrails preserved
- `msdyn_projectsprint@odata.bind` is the only sprint bind; no other entity types touched.
- Summary-task protection unchanged — sprint is not a rolled-up field, and
  `validateUpdateEntities` still runs on the result.
- `changed===0` guard still fires correctly (sprint counts as a change).
- 200-cap, bind-alias rejection, dependency-update block all unchanged in
  `validateUpdateEntities`.
- `assertGuid(projectId)` already enforced when names need resolving (it is required for bucket
  names too).

### New guardrail
None. (Reuses the existing duplicate-sprint-name guard and the null-bind-drop pattern.)

### Files to modify
- `src/tools/updateTasksSimple.ts` — schema, `SimpleTaskUpdate`, `buildUpdateEntities` signature +
  body, handler sprint-resolution block.
- `README.md` — note `update_tasks` now accepts `sprint`.
- `SERVER_INSTRUCTIONS` (src/server.ts) if it enumerates `update_tasks` fields.

### Unit tests — extend `test/buildUpdate.test.ts`
Import unchanged. Cases (mirror the bucket tests already in that file):
1. **binds a sprint via a resolved id** — `buildUpdateEntities([{taskId: ID, sprint:"S1"}],
   undefined, new Map([[0, SPRINT]]))` → `entities[0]["msdyn_projectsprint@odata.bind"]` ===
   `/msdyn_projectsprints(<SPRINT>)`; `validateUpdateEntities(entities)` not.toThrow.
2. **accepts a sprintId GUID directly** (resolved map carries the GUID).
3. **throws when a sprint name cannot be resolved** (no entry in the map) → `/could not be
   resolved/i`.
4. **sprint counts as a change** (sprint-only update is accepted, no `nothing to change` throw).
5. **sprint combined with effort/progress** sets both binds/fields in one entity.
6. **sprint=null is dropped with a warning** (mirror parent=null test).

### e2e self-test (scratch plan, gated)
On the `ZZ-MCP-E2E-*` plan: `add_sprint` (it is already creatable) → open session →
`update_tasks` with `{taskId: <existing leaf>, sprint: "<sprint name>"}` → apply → poll →
independent OData verify via a new `verify.ts` helper
`verifyTaskField(taskId, "_msdyn_projectsprint_value", bearer)` (existing generic helper already
supports any field) → assert it equals the created sprint id. Cleanup unchanged.

---

# Feature 3 — Reparent via `update_tasks parent` (confirm + lock in)

### Context & current state
**Already implemented and unit-tested** (commit 9e5b2fa; `updateTasksSimple.ts:134-163`,
`buildUpdate.test.ts:118-144`). The README "Open TODOs" still lists it as unconfirmed live and
asks for an e2e test. So the remaining work is **(a) an e2e confirmation that PSS honours a parent
change on update, and (b) keep/round-out the unit test** — NOT reimplementation. Do not touch the
working builder logic except as noted below.

### Verify, don't rebuild
- Confirm `msdyn_parenttask@odata.bind` is emitted on update (it is).
- Confirm un-parenting (null parent) is dropped with a warning (it is — keep that behaviour;
  PSS rejects null parent binds).
- Confirm summary protection still holds: `validateUpdateEntities` folds the new parent's GUID
  into the summary set (updateTasks.ts:78-84), so a rolled-up-field write on the *new parent* in
  the same batch stays blocked. **Add a unit test that proves this** (see below) if absent — it is
  the one reparent case not yet asserted.

### Guardrails preserved
- Parent must be an existing task GUID (non-GUID → throw; null → warn-and-drop). Unchanged.
- Summary-task protection: new-parent GUID added to summary set; rolled-up writes on it rejected.
- Parents-before-children ordering is an add-time concern; on update the engine validates cycles
  on apply (`apply_changes` surfaces `E_LIMITEXCEEDED_TASKLEVEL` / scheduling errors). Document
  that an invalid move (cycle) is rejected on apply, not in the builder.

### Files to modify
- `test/buildUpdate.test.ts` — add the summary-protection-after-reparent case if not present.
- `scenarios/lifecycle.ts` + `verify.ts` — e2e step (below).
- `README.md` "Open TODOs" — move the reparent item from open → done once e2e confirms it.

### Unit test (add to `test/buildUpdate.test.ts`)
- **reparenting marks the new parent as a summary task, blocking rolled-up writes on it in the
  same batch** — build `[{taskId: CHILD, parent: NEWP}, {taskId: NEWP, effortHours: 5}]`, then
  `expect(() => validateUpdateEntities(entities)).toThrow(/summary/i)` (NEWP became a summary via
  the parent bind). This locks the cross-feature invariant.

### e2e self-test (scratch plan, gated) — THE primary deliverable for this feature
On the `ZZ-MCP-E2E-*` plan, which already builds a 6-level tree with a sibling `SIB` under `L1`:
1. Open a session → `update_tasks` `[{ taskId: <SIB>, parent: <L2> }]` (move SIB from under L1 to
   under L2) → apply → poll.
2. **Independent OData verify** via existing `verifyTaskField(SIB, "_msdyn_parenttask_value",
   bearer)` → assert it now equals `L2`'s id. This is the live confirmation the README asks for.
3. (negative, optional) attempt an obvious cycle (`update_tasks [{taskId: L1, parent: <L2>}]`
   where L2 is a descendant of L1) and assert `apply_changes` throws — confirms the engine guards
   cycles. Keep this best-effort (log, don't hard-fail, if PSS error text varies).
Does not corrupt anything: SIB/L1/L2 are in the test's own plan and are deleted in cleanup.

---

# Feature 4 — Dependency cascade-delete in `delete_tasks_batch`

### Context
PSS rejects deleting a task while a `msdyn_projecttaskdependency` still references it
(`E_INVALIDENTITYUID`). Today the caller must track dependency GUIDs (returned by `add_tasks` as
`dependencyIds`) and pass them in `records` *before* the task ids. That is a caller burden and a
foot-gun (lost ids → cleanup fails). Auto-fetch the live dependency rows for the to-be-deleted
tasks and queue their deletes first.

### Behaviour change (in `deleteTasks.ts` handler only)
When `projectId` is provided alongside `taskIds` (the same condition already used for leaves-first
sorting), **after** computing `taskIdList`, also auto-fetch dependencies:
1. Build the set of task ids being deleted (lowercased).
2. GET live dependencies that reference any of them. Use the **plural** read collection
   `msdyn_projecttaskdependencies` with
   `$select=msdyn_projecttaskdependencyid,_msdyn_predecessortask_value,_msdyn_successortask_value`
   and `$filter=_msdyn_project_value eq <projectId>` (scope to the plan; then filter client-side
   to deps whose predecessor OR successor is in the delete set). Plan-scoped + client filter
   avoids a giant `or` filter and matches how the rest of the code reads per-plan. `$top` high
   (e.g. 5000) with a warning if truncated.
   - **404/4xx graceful-degrade:** if the dependency read fails (tenant without the entity set,
     or a transient error), **do not block the delete** — fall back to caller-supplied `records`
     exactly as today, and append a warning ("could not auto-fetch dependencies; pass dependency
     GUIDs in records if PSS rejects the delete"). This mirrors the existing best-effort fallback
     when the hierarchy fetch fails (deleteTasks.ts:228).
3. Prepend the discovered `msdyn_projecttaskdependency` records to the records array **before**
   the task records (the handler already puts `input.records` before tasks at lines 231-243; the
   auto-fetched deps go in the same pre-task position). De-dupe against any dependency ids the
   caller already passed in `records` (don't double-delete).
4. Everything else (validate, 200-cap, leaves-first task order, PSS delete) is unchanged.

Keep the **pure** ordering logic testable: extract a small pure helper
`selectDependenciesToDelete(taskIds, depRows)` that takes the lowercased delete-set and the raw
dependency rows (`{msdyn_projecttaskdependencyid, _msdyn_predecessortask_value,
_msdyn_successortask_value}`) and returns the list of dependency record descriptors
(`{entityLogicalName:"msdyn_projecttaskdependency", recordId}`), de-duped. This is the unit-test
seam (no network).

### Exact Dataverse entities/binds
Read: collection `msdyn_projecttaskdependencies`, fields `msdyn_projecttaskdependencyid`,
`_msdyn_predecessortask_value`, `_msdyn_successortask_value`, `_msdyn_project_value` (all proven in
`getTask.ts`/`listDependencies`). Delete logical name: `msdyn_projecttaskdependency` (already in
`DELETABLE`).

### Guardrails preserved (enumerate)
- **`confirmed: true` gate** unchanged and checked before any read/fetch (keep it first, as now).
- **Whole-plan delete hard-block** unchanged (`validateDeleteRecords` rejects `msdyn_project`).
- **200-entity cap** unchanged — the cap now counts auto-fetched deps too; if tasks+deps exceed
  200, `validateDeleteRecords` throws (correct: surface it so the caller splits the batch). Add a
  helpful message hinting that auto-fetched dependencies count toward the cap.
- **Delete ordering** preserved and strengthened: dependencies (and any caller `records`) before
  tasks; tasks still leaves-first.
- GUIDs: `assertGuid(projectId)` already enforced on the fetch path; dependency ids come straight
  from Dataverse (trusted) but still flow through `validateDeleteRecords`'s recordId presence check.

### New guardrail
- **Auto-cascade is best-effort, never weakens the gate:** the dependency fetch runs only after
  `confirmed===true`; a failed fetch degrades to the documented manual path, never silently
  deletes more than intended, and never bypasses confirmation.

### Files to modify
- `src/tools/deleteTasks.ts` — add `selectDependenciesToDelete` (pure, exported) + the auto-fetch
  block in the handler (guarded by `projectId && taskIdList.length>0`); update the tool
  description to state that dependencies are auto-removed when `projectId` is supplied.
- `README.md` "Open TODOs" — move the dependency-cascade item open → done.
- `QUALITY-ASSURANCE.md` — note the new auto-cascade behaviour and its best-effort fallback.

### Unit tests — extend `test/deleteTasks.test.ts`
Import `selectDependenciesToDelete` from `../src/tools/deleteTasks.js`. Cases:
1. **selects a dependency whose successor is in the delete set** → returns one record with the
   right `entityLogicalName`/`recordId`.
2. **selects a dependency whose predecessor is in the delete set**.
3. **ignores a dependency referencing only tasks NOT being deleted** → empty result.
4. **de-dupes a dependency id already present in caller records** (pass the caller set; assert no
   duplicate).
5. **integration with ordering:** feed the resulting records + task ids through
   `buildDeleteEntities` and assert dependency entities precede task entities (mirror the existing
   ordering assertions in this file).
6. (guardrail) tasks + auto-deps > 200 → `validateDeleteRecords` throws the 200-cap error.

### e2e self-test (scratch plan, gated)
The lifecycle plan already creates an FS dependency (`SIB depends on L2`). Replace/augment the
existing cleanup so it deletes `SIB` and `L2` **via `delete_tasks_batch` with `projectId` set and
WITHOUT passing the dependency id** — proving the cascade. Verify with `verifyTaskDeleted(SIB)` and
`verifyTaskDeleted(L2)` (existing helper) and a new
`verifyDependencyCount(projectId, bearer): Promise<number>` (`/msdyn_projecttaskdependencies?
$filter=_msdyn_project_value eq <projectId>&$count=true&$top=0`) → assert 0 dependencies remain.
This is the strongest possible proof and uses only the throwaway plan.

---

## Shared-file touchpoints & sequencing (read before parallelising)

These files are touched by MORE THAN ONE feature → **serialize edits or expect merge conflicts**:

| File | Features touching it | Nature of edit |
|---|---|---|
| `src/tools/index.ts` | F1 only (new tool import + `allTools` + `assign_task: UPDATE`) | One insertion each in 3 lists. Low conflict risk if F1 owns it. |
| `src/tools/updateTasksSimple.ts` | F2 (sprint) and F3 (reparent already merged) | F3 is code-complete; F2 edits the schema/builder/handler. **F2 should base on current HEAD** (reparent already present) and not revert it. |
| `src/tools/deleteTasks.ts` | F1 (imports `buildDeleteEntities`/`validateDeleteRecords`) and F4 (adds `selectDependenciesToDelete` + handler block) | F1 only *imports* from it (no edit); F4 *edits* it. Land F4's `deleteTasks.ts` change, then F1 imports. |
| `test/deleteTasks.test.ts` | F1 (unassign delete record cases) and F4 (cascade cases) | Both append `it()` blocks. Serialize or split into clearly separated `describe` blocks. |
| `test/buildUpdate.test.ts` | F2 (sprint cases) and F3 (summary-after-reparent case) | Both append; low risk, separate `describe`s. |
| `test/e2e/verify.ts` | F1 (`verifyAssignmentCount`), F4 (`verifyDependencyCount`) | Both add exported helpers; append-only, low risk. |
| `test/e2e/scenarios/lifecycle.ts` | F1, F2, F3, F4 all add steps | **Highest conflict surface.** One implementer should own lifecycle.ts and stitch all four e2e steps in, OR each feature adds its e2e step last in a dedicated section. Recommend a single "e2e wiring" pass after the unit work lands. |
| `README.md` | F1 (tool table row), F2/F3/F4 (Open TODOs flips) | Append/flip; serialize the Open-TODOs edits. |
| `SERVER_INSTRUCTIONS` (src/server.ts), `SECURITY.md`, `QUALITY-ASSURANCE.md` | F1 (new surface + gate), F4 (cascade behaviour) | Serialize doc edits. |

**Recommended order:** F4 (deleteTasks core) → F1 (assign tool; imports from deleteTasks) →
F2 (update sprint) → F3 (e2e confirm + summary test) → single e2e-wiring pass on lifecycle.ts.
F2 and F3 are independent of F1/F4 and may run in parallel **if** lifecycle.ts/test files are
owned by one person at the end.

**Pure-builder discipline (CLAUDE.md):** every new behaviour ships a pure exported builder
(`buildAssignmentEntities`, `selectDependenciesToDelete`, extended `buildUpdateEntities`) so the
OData payload is asserted in vitest with no network — handlers stay thin (resolve → build →
validate → PSS call). Never weaken `validateAddEntities` / `validateUpdateEntities` /
`validateDeleteRecords`; run them on every built batch as defense-in-depth.

---

## Summary

**Already done (verify, don't rebuild):** sprint on `add_tasks`, assignees on `add_tasks`,
reparent builder logic in `update_tasks` — all with passing unit tests.

**Tools/fields changed:**
- **New tool `assign_task`** (assign/unassign existing-task members; `msdyn_resourceassignment`
  via PSS create/delete; `confirmed` gate on unassign; membership + duplicate guardrails) — F1.
- **`update_tasks` gains `sprint`** (`msdyn_projectsprint@odata.bind`; name→id resolver) — F2.
- **`update_tasks parent`** — no code change; add summary-after-reparent unit test + e2e live
  confirmation — F3.
- **`delete_tasks_batch` auto-cascades dependencies** when `projectId` is set (auto-fetch
  `msdyn_projecttaskdependencies`, queue dep deletes before tasks; best-effort 4xx fallback) — F4.

**New files:** `src/tools/assignTask.ts`, `test/buildAssignment.test.ts`. New exported pure
helpers: `buildAssignmentEntities` (assignTask.ts), `selectDependenciesToDelete` (deleteTasks.ts),
plus `verifyAssignmentCount`/`verifyDependencyCount` in `test/e2e/verify.ts`.

**Shared-file conflicts to coordinate:** `src/tools/index.ts` (F1), `deleteTasks.ts` (F4 edits /
F1 imports), `updateTasksSimple.ts` (F2 on top of F3-merged code), `test/deleteTasks.test.ts`,
`test/buildUpdate.test.ts`, `test/e2e/verify.ts`, and especially
`test/e2e/scenarios/lifecycle.ts` (all four features add steps — assign one owner). README "Open
TODOs" and the SECURITY/QA docs are edited by F1 + F4 — serialize.

**Guardrails:** no guardrail is weakened. New guards added: duplicate-assignment skip (F1),
best-effort-but-gated dependency cascade (F4). All builds still pass `validateAddEntities` /
`validateUpdateEntities` / `validateDeleteRecords`; `confirmed` gate and whole-plan-delete block
are untouched. E2E operates only on each run's throwaway `ZZ-MCP-E2E-*` plan (no shared seed
board exists to corrupt), verifying via independent OData reads in `test/e2e/verify.ts`.
