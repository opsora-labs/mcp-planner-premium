# 50 — Checklist add / adjust / remove via `update_tasks`

Status: implemented on `feat/checklist-in-update-tasks`; **live e2e PASSED** on a
crm4/EU tenant (2026-07-01, 35/35). Both §6 assumptions are now proven.

## Goal

Let `update_tasks` (the ergonomic tool) add, adjust and remove checklist items on
**existing** tasks, in the same open change session, saved on `apply_changes`.

Today `add_tasks` can attach checklist items at create time
([`addTasksSimple.ts`](../../src/tools/addTasksSimple.ts) → `msdyn_projectchecklist`),
but there is no ergonomic path to touch checklist items on a task that already
exists (only the raw `add_tasks_batch` / `delete_tasks_batch` escape hatches).

## Entity model (recap)

A checklist item is its own Dataverse row — `msdyn_projectchecklist` — bound to its
task via the **PascalCase** nav-property `msdyn_ProjectTaskId@odata.bind`. Fields:

| Field | Meaning |
|---|---|
| `msdyn_projectchecklistid` | primary key (client-generated GUID on create) |
| `msdyn_name` | item title |
| `msdyn_projectchecklistcompleted` | bool, ticked/not |

- **create** → `msdyn_PssCreateV2` (PROVEN — `add_tasks` already does this, e2e-covered)
- **delete** → `msdyn_PssDeleteV2` (PROVEN — in `delete_tasks_batch` `DELETABLE`)
- **update** → `msdyn_PssUpdateV2` (**NOT yet proven live** — see §6)

## API shape (user-facing)

Each task object in `update_tasks.tasks` gains an optional `checklist` array. Every
entry is one operation:

```jsonc
{
  "taskId": "<existing task GUID>",
  "checklist": [
    "Buy milk",                                  // ADD (string shorthand)
    { "title": "Draft spec", "completed": false }, // ADD (object)
    { "match": "Draft spec", "completed": true },  // ADJUST existing (find by title)
    { "match": "Draft spec", "title": "Draft specification" }, // RENAME existing
    { "id": "<checklistId>", "completed": true },  // ADJUST existing (by id)
    { "match": "Old item", "remove": true },       // REMOVE existing (find by title)
    { "id": "<checklistId>", "remove": true }      // REMOVE existing (by id)
  ]
}
```

Discriminator (no ambiguity):

| Entry | Classified as |
|---|---|
| `string`, or object with **no** `id`/`match`/`remove` | **ADD** (needs `title`) |
| object with `remove: true` | **REMOVE** (needs `id` or `match`) |
| object with `id` or `match` (and not `remove`) | **ADJUST** (needs `title` and/or `completed`) |

- `match` = "find the existing item whose current title equals this" (resolved
  server-side against the task's live checklist, mirroring bucket/sprint/label
  name resolution). `title` on an ADJUST is the **new** title (rename).
- `id` takes precedence over `match`. Ambiguous `match` (two items same title) →
  error asking for `id`. Unknown `id`/`match` → error (item not on this task).
- A task may carry `checklist` **and** scalar field changes, or `checklist` only
  (a checklist-only task produces no task-update entity — see §5).

## Guardrails / decisions

1. **Removal requires confirmation.** Deleting a checklist item is user-data loss,
   so — consistent with the repo's delete-confirm golden rule — `update_tasks`
   grows an optional top-level `confirmed` boolean that MUST be `true` when any
   entry has `remove: true`. Non-removal updates never need it (backward-compatible).
2. **Fail-closed resolution.** `match`/`id` ops require a successful read of the
   task's current checklist. If that read fails, the op batch is rejected with a
   clear message rather than guessing.
3. **Reuse proven validators.** Checklist create entities pass through
   `validateAddEntities` (allow-list + unique-GUID + 200-cap); removes through
   `validateDeleteRecords`; the combined update collection (task edits + checklist
   edits) through `validateUpdateEntities`. No guardrail is weakened.
4. **One source of truth for the schema.** All checklist entity/field/entity-set
   knowledge lives in the new [`src/tools/checklist.ts`](../../src/tools/checklist.ts);
   `add_tasks` is refactored to build its create entity from the same helper.

## §5 Execution plan (per `update_tasks` call)

1. `buildUpdateEntities` builds the scalar task-update entities as today, but a task
   whose only change is `checklist` yields **no** task entity (and does not throw
   "nothing to change").
2. Collect checklist ops per task. For tasks with any ADJUST/REMOVE op, GET the
   task's current items:
   `GET /msdyn_projectchecklists?$select=msdyn_projectchecklistid,msdyn_name,msdyn_projectchecklistcompleted&$filter=_msdyn_projecttaskid_value eq <taskId>&$top=200`
3. `planChecklistOps(...)` (pure) → `{ creates, updates, removes, warnings }`.
4. Assemble payloads and fire, each conditional on being non-empty, all against the
   same `operationSetId`:
   - task edits + checklist edits → one `msdyn_PssUpdateV2`
   - checklist adds → `msdyn_PssCreateV2`
   - checklist removes → `msdyn_PssDeleteV2`
5. Return counts (`taskUpdates`, `checklistAdded/Updated/Removed`), the new
   `checklistIds`, and merged warnings. Nothing saved until `apply_changes`.

## §6 Live-unproven assumptions — ✅ BOTH PROVEN (2026-07-01)

Per `CLAUDE.md` ("discover before you code"), two facts were inferred from Dataverse
convention + the verified write binds. Both were centralised in `checklist.ts` and
have now been **confirmed live** by the featureLive write tier (35/35, crm4/EU):

1. ✅ **Read filter field `_msdyn_projecttaskid_value`** on entity set
   `msdyn_projectchecklists`. The tool's read AND the independent `verifyChecklist`
   OData read both used it and returned the rows — a wrong field would have 400'd.
2. ✅ **`msdyn_PssUpdateV2` accepts `msdyn_projectchecklist` partial updates**
   (`msdyn_name` / `msdyn_projectchecklistcompleted`): the adjust step ticked
   'Chk A' complete and renamed 'Chk B' → 'Chk B2', both verified via OData.

**Proof command (crm4/EU tenant needs `DATAVERSE_LINK_TYPE_STYLE=eu`):**
```bash
export E2E_ACCESS_TOKEN=$(npx tsx --env-file .env scripts/get-dataverse-token.ts)
E2E_ALLOW_WRITES=true DATAVERSE_LINK_TYPE_STYLE=eu \
  npx tsx --env-file .env test/e2e/featureLive.ts   # checklist add→adjust→remove
```
Result: `✅ ALL PASS (35 pass / 0 fail)` including all seven checklist assertions.
