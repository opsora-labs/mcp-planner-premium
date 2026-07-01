# Planner Premium / PSS — Implementation & Testing Lessons (handoff)

A field guide for adding features to **mcp-planner-premium** (a Dataverse-only MCP
server over the Microsoft Project Scheduling Service, "PSS"). It records what was
built, the **method that worked**, and — most importantly — the **PSS/Dataverse
gotchas that cost real time**, so the next session avoids them.

Context: the server talks **only to the Dataverse Web API** with a single
delegated user token. No Microsoft Graph, no second token. Tasks live in
`msdyn_projecttask`; structural writes go through PSS actions
(`msdyn_CreateProjectV1`, `msdyn_CreateOperationSetV1`, `msdyn_PssCreateV2`,
`msdyn_PssUpdateV2`, `msdyn_PssDeleteV2`, `msdyn_ExecuteOperationSetV1`).

---

## 1. The method that worked (do this, in this order)

1. **Probe the live schema BEFORE writing any entity payload.** Never guess field
   or nav-property names. Query metadata:
   - Required fields: `EntityDefinitions(LogicalName='X')/Attributes?$select=LogicalName,AttributeType,RequiredLevel,IsValidForCreate`
   - Lookups / `@odata.bind` names: `EntityDefinitions(LogicalName='X')/ManyToOneRelationships?$select=ReferencingEntityNavigationPropertyName,ReferencedEntity`
   - Child collections: `.../OneToManyRelationships`
   - Capability flags: `EntityDefinitions(LogicalName='X')?$select=HasNotes,HasActivities`
2. **Prove a MINIMAL create live** (one entity, raw `add_tasks_batch` or direct
   PSS) before implementing the tool. Iterate on the real error messages — PSS
   tells you exactly which field/bind it rejects.
3. **Implement** in the pure builder (`buildTaskEntities` in
   `src/tools/addTasksSimple.ts`) so it stays unit-testable.
4. **Unit-test the builder** (no network) + a small **live throwaway script** to
   confirm persistence (create → read back via raw OData → cleanup).
5. **Then** wire it into the big acceptance harness — never debug a new entity
   shape inside a 600-task run.

Corollary: **keep the plan on failure and reuse it.** Building hundreds of tasks
takes minutes; don't rebuild to retry one sub-step. The harness keeps the plan on
any failure (and `KEEP_PLAN=1`) precisely for this.

---

## 2. PSS / Dataverse gotchas (the expensive ones)

### Hierarchy
- **Root-task auto-nesting (severe, silent).** PSS has no "append at top level" on
  create. A **parentless** task added to a **non-empty** plan gets silently
  **nested under an existing task**, building a false deep spine that eventually
  trips `E_LIMITEXCEEDED_TASKLEVEL` (~max 10 levels). Fix: **create all roots in
  the first batch of the still-empty plan, then create tasks level-by-level with
  an EXPLICIT parent GUID.** Do NOT batch by outline order. `add_tasks` now also
  warns when roots are added to a populated plan (you can't prevent the nesting —
  `outlinelevel` is blocked on create and un-parenting is blocked on update).
- **Parents must precede children in the same batch** (the builder auto-sorts).

### Batching / sessions
- **The 200-entity cap is per OPERATION SET (session), not per call.** Multiple
  `add_tasks_batch` calls in one session still sum against 200. One session per
  ≤~190-entity chunk, each applied separately.
- **One bad entity fails the WHOLE operation set** (`E_BATCHFAILED`) — nothing in
  it persists. To create the good ones and isolate the bad, **bisect** the batch
  (split in half, recurse) — O(failures·log n) applies, not N.

### Entity-set names & field names (don't guess — they 404 silently)
- Entity **set** names are the **plural** collection: it's
  `msdyn_projecttaskdependencies`, **not** `msdyn_projecttaskdependency`. A wrong
  set returns **404**, which a graceful-degrade path may swallow as "empty" — so a
  read silently returns 0 and looks like "no data" instead of "wrong URL".
- The dependency **lag** column is `msdyn_projecttaskdependencylinklag`, **not**
  `msdyn_linklagduration` (which does not exist). The 404 above had masked this.
- Lesson: when a read returns empty, **verify the URL against metadata** before
  assuming the tenant lacks the data.

### `@odata.bind` nav-property casing is per-entity (a guard footgun)
- On **tasks**: `msdyn_project@odata.bind`, `msdyn_projectbucket@odata.bind`,
  `msdyn_parenttask@odata.bind`, `msdyn_projectsprint@odata.bind` (lowercase).
- On **dependencies**: PascalCase — `msdyn_Project@odata.bind`,
  `msdyn_PredecessorTask@odata.bind`, `msdyn_SuccessorTask@odata.bind`. Lowercase
  is rejected as "annotation-only property with no value".
- On **resource assignments**: lowercase `msdyn_projectid@odata.bind`,
  `msdyn_taskid@odata.bind`, `msdyn_projectteamid@odata.bind`,
  `msdyn_bookableresourceid@odata.bind`. Note `msdyn_projectid` here is CORRECT,
  even though it's WRONG on a task.
- On **checklist** / **label junction**: PascalCase `msdyn_ProjectTaskId@odata.bind`
  (and `msdyn_ProjectLabelId@odata.bind`).
- Therefore any "wrong bind alias" guard MUST be **entity-type-scoped** — the same
  key is valid on one entity and invalid on another. (We had to fix exactly this.)

### Custom (non-`msdyn_`) column lookup nav-property resolution
- The same casing trap above applies to **customer-added lookup columns** —
  never guess or hand-derive the nav-property name (e.g. by upper-casing the
  first letter). Resolve it from
  `EntityDefinitions(LogicalName='<entity>')/ManyToOneRelationships?$select=ReferencingAttribute,ReferencingEntityNavigationPropertyName,ReferencedEntity`
  and use `ReferencingEntityNavigationPropertyName` **verbatim** as the
  `@odata.bind` key. It is sometimes a **compound alias**, not just a casing
  change — e.g. a lookup with logical name `new_projectimportstagingid`
  resolved to nav property
  `new_projectimportstagingid_msdyn_projectimportstaging`, not
  `new_ProjectImportStagingId`. The target **entity set** (plural, for the
  `/set(guid)` fragment) is a *separate* lookup:
  `EntityDefinitions(LogicalName='<target>')?$select=EntitySetName`.
- Three corrections proven live against a real tenant while building custom-column
  support (`src/dataverse/columnTypes.ts`, `src/dataverse/metadata.ts`) —
  the original design doc got these wrong; obey the code, not old doc drafts:
  1. **`IsCustomAttribute` is NOT a usable "is this a customer-added column"
     discriminator.** On this tenant, 45/46 standard `msdyn_` fields on
     `msdyn_projecttask` report `IsCustomAttribute:true` (60/61 on
     `msdyn_project`) — using that flag as the gate would admit nearly the
     entire standard schema as "custom" and defeat every downstream guardrail.
     The real gate is **prefix discipline**: a column is custom only if its
     logical name does **not** start with `msdyn_` (`isCustomColumnName()` in
     `metadata.ts`). `IsCustomAttribute` is carried on `ColumnMeta` only as a
     weak, non-load-bearing hint.
  2. **DateOnly vs. DateTime is decided by the top-level `Format` field**
     (`"DateOnly"` vs `"DateAndTime"`), **not** `DateTimeBehavior`.
     `DateTimeBehavior.Value` is only ever `"UserLocal"` or
     `"TimeZoneIndependent"` on Dataverse — it never signals date-only. Fetch
     the `DateTimeAttributeMetadata` cast (`$select=DateTimeBehavior,Format`)
     and branch on `Format`, not `DateTimeBehavior`.
  3. **Lookup target logical name on read requires a widened `Prefer` header.**
     With only `odata.include-annotations="OData.Community.Display.V1.FormattedValue"`
     (what the standard read tools already send), the
     `@Microsoft.Dynamics.CRM.lookuplogicalname` annotation is **not** returned
     — so a polymorphic lookup's target entity can't be told apart from its
     display name. Widen `Prefer` to also include
     `Microsoft.Dynamics.CRM.lookuplogicalname` (or `*`) on any read path that
     surfaces custom lookup columns, and degrade gracefully (fall back to a
     bare id/FormattedValue) if the annotation is still absent.

### Fields blocked on create (set via update afterward, or not at all)
- `msdyn_progress` — blocked on create; set with `update_tasks` after apply.
- `msdyn_ismilestone` — rejected on create AND update (`ScheduleAPI-AV-000x`);
  **UI-only**, no API path. Surface it for the user to set manually.
- `msdyn_outlinelevel` / `msdyn_displaysequence` — blocked; hierarchy comes from
  parent binds only.
- `msdyn_resourceassignment.msdyn_start` / `msdyn_finish` — blocked on create
  (PSS derives them from the task), even though metadata marks them required.

### Tenant variants
- **Link-type option values differ.** EU/CRM4 tenants use **0–3**
  (FF=0, FS=1, SF=2, SS=3); standard tenants use the **192350000-range**.
  Selected by `DATAVERSE_LINK_TYPE_STYLE` (`eu` | `global`).

### Summary (parent) tasks
- **Cannot be endpoints of a dependency** — PSS refuses links touching a summary
  task. Filter them out (assign links between leaves only).
- Rolled-up fields (start/finish/effort/progress) are **protected on update** and
  **ignored on create**.

### Scheduling-engine rejections
- The engine **rejects some dependencies that conflict with imported fixed dates**
  (e.g. `SS`/`FF` links whose two tasks have incompatible start/finish) with
  `E_BATCHFAILED`. This is data-dependent, not a bug — isolate (bisect) and skip,
  reporting which links were refused.

### Things that simply aren't possible via Dataverse
- **Labels: creation is UI-only.** `msdyn_projectlabel` rejects direct OData create
  ("edit through the Project UI") and PSS create. You can only **assign existing**
  labels (the `msdyn_projecttasktolabel` junction). The tenant may have **zero**
  predefined labels.
- **Task comments are Teams-backed.** `msdyn_projecttaskconversation` holds only
  `msdyn_teamschannelid` + `msdyn_teamsconversationid` — the comment text is in
  Microsoft Teams. Real comments need **Microsoft Graph**, out of scope for a
  Dataverse-only, single-token server. (Dataverse Notes/`annotation` exist but are
  a separate store the Planner UI doesn't show as comments.)

### Identity ("who am I" / "my tasks")
- `WhoAmI` returns `UserId` = the Dataverse **systemuserid**.
- Chain to a user's tasks: `UserId` → `bookableresources(_userid_value eq UserId)`
  → `msdyn_projectteams(_msdyn_bookableresourceid_value)` →
  `msdyn_resourceassignments(_msdyn_projectteamid_value)` → `msdyn_projecttasks`.
- **A plan auto-adds its creator as a team member with the GENERIC display name
  "Project Manager 1"** — but the underlying bookable resource is the real user.
  **Trace identity by resource id, never by display name.**
- `_value` columns hold lookups on reads; `@odata.bind` is the write side.

### Diagnosing async failures
- PSS apply is asynchronous. When a batch fails, query **`msdyn_psserrorlogs`**
  (`$orderby=createdon desc`) and unescape the nested JSON to get
  `failedBatchRequestIndex` + `errorKey` (e.g. `E_INVALIDENTITYUID`,
  `E_LIMITEXCEEDED_TASKLEVEL`). Note: not every apply error is logged there — some
  only come back synchronously from `ExecuteOperationSetV1`.

---

## 3. Capability map (Dataverse-only)

| PM concept | Supported here? | How |
|---|---|---|
| Hierarchy (n levels) | ✅ | `parent` (ref or GUID); create roots-first, level-by-level |
| Dependencies FS/SS/FF/SF + lag | ✅ leaf↔leaf only | `dependsOn`; EU values 0–3 |
| Priority / effort / dates / bucket / notes | ✅ | task fields |
| Progress | ✅ update-only | `update_tasks.progressPercent` (0–100 → 0–1) |
| Checklist | ✅ | `add_tasks.checklist` → `msdyn_projectchecklist` |
| Sprint | ✅ | `add_sprint` + `add_tasks.sprint` (task lookup) |
| Assignees | ✅ existing team members | `add_tasks.assignees` → `msdyn_resourceassignment` |
| Labels | ⚠️ assign-only | creation is UI-only |
| Milestone flag | ❌ | UI-only |
| Comments | ❌ | Teams/Graph, out of scope |
| "My overdue tasks" | ✅ | `list_my_tasks` (whoami chain) |

---

## 4. Testing & operational notes

- **Auth: app-only/client-credentials does NOT work for PSS** — the Schedule APIs
  require a **licensed user**, and service principals can't hold an M365 license.
  Use a **cached refresh token** from a one-time device-code login by a user with a
  Project Plan P3 / Planner Premium license (`scripts/auth-login.ts` →
  `scripts/get-dataverse-token.ts`).
- **Intermittent `AADSTS500186`** appears under rapid automated token requests
  (risk/conditional-access). **Retry** the token script (a few attempts); a single
  access token covers a whole run, so the harness only needs one at start.
- **`apply_changes` polls** to completion — set the MCP client timeout high
  (`E2E_TOOL_TIMEOUT_MS=290000`, `pollTimeoutMs` up to 300000).
- **Whole-plan delete is blocked in-tool by policy** but a direct
  `DELETE /msdyn_projects(<id>)` works for out-of-band cleanup.
- **Cleanup scoping:** delete only your **own** plan-name prefix; do not nuke all
  `ZZ-*` (you may remove someone else's disposable test plans).
- The acceptance harness (`test/e2e/pmOpsLive.ts`) drives everything through
  the real MCP protocol, keeps the plan on failure, and verifies via independent
  OData reads (never AI summaries). Pure builders are unit-tested separately.

---

## 5. Working payload recipes (verified live)

```jsonc
// Dependency entity (EU tenant: linktype 1 = FS). PascalCase binds.
{
  "@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttaskdependency",
  "msdyn_projecttaskdependencyid": "<uuid>",
  "msdyn_Project@odata.bind": "/msdyn_projects(<projectId>)",
  "msdyn_PredecessorTask@odata.bind": "/msdyn_projecttasks(<predGuid>)",
  "msdyn_SuccessorTask@odata.bind": "/msdyn_projecttasks(<succGuid>)",
  "msdyn_projecttaskdependencylinktype": 1
}

// Checklist item (child of task). PascalCase task bind.
{
  "@odata.type": "Microsoft.Dynamics.CRM.msdyn_projectchecklist",
  "msdyn_projectchecklistid": "<uuid>",
  "msdyn_ProjectTaskId@odata.bind": "/msdyn_projecttasks(<taskGuid>)",
  "msdyn_name": "Do the thing",
  "msdyn_projectchecklistcompleted": false
}

// Resource assignment — NO start/finish (blocked on create). Lowercase binds.
{
  "@odata.type": "Microsoft.Dynamics.CRM.msdyn_resourceassignment",
  "msdyn_resourceassignmentid": "<uuid>",
  "msdyn_name": "Jane Doe",
  "msdyn_taskid@odata.bind": "/msdyn_projecttasks(<taskGuid>)",
  "msdyn_projectid@odata.bind": "/msdyn_projects(<projectId>)",
  "msdyn_projectteamid@odata.bind": "/msdyn_projectteams(<teamMemberId>)",
  "msdyn_bookableresourceid@odata.bind": "/bookableresources(<bookableResourceId>)"
}

// Sprint (top-level; name + start + finish required). Then set the TASK's lookup:
//   task: { "msdyn_projectsprint@odata.bind": "/msdyn_projectsprints(<sprintId>)" }
```

---

## 6. TL;DR for the next session

1. Probe metadata first; never guess field/bind names or entity-set plurality.
2. Prove one entity live before implementing; iterate on real PSS errors.
3. Roots-first, level-by-level, explicit parent GUIDs — or PSS silently mangles
   the hierarchy.
4. 200 is per operation set; one bad entity sinks the set → bisect to isolate.
5. Bind casing is per-entity; make any bind guard entity-aware.
6. Some things are impossible via Dataverse (milestone flag set, label create,
   comments) — confirm with two create paths, then document, don't fight it.
7. Trace user identity by **resource id**, not display name.
8. App-only auth can't do PSS; use a cached licensed-user refresh token; retry on
   intermittent AADSTS500186.
9. Keep test plans on failure and reuse them; scope cleanup to your own prefix.
