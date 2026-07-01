# Custom Dataverse Column Support — Architecture Design

**Target repo:** `mcp-planner-premium`
**Status:** Shipped (merged in PR #1) — archived 2026-07-01.
**Author perspective:** metadata-driven, guardrail-preserving, additive.

## 1. Problem & goal

The server today accepts writes only against a fixed allow-list of standard `msdyn_` fields, enforced in `src/tools/addTasks.ts` and `src/tools/updateTasks.ts`. Customers on full Project Plan 3/5 licenses have added **custom columns** (typically a publisher prefix like `new_`, `contoso_`) to `msdyn_project` and `msdyn_projecttask`. We must let callers **read and set** those columns, with **correct Web API serialization per Dataverse attribute type**, without weakening any existing guardrail (CLAUDE.md golden rule #1; `SECURITY.md`).

Two facts from the code shape the whole design:

1. **Writes never PATCH a row directly.** They post an OData `EntityCollection` to `msdyn_PssCreateV2` / `msdyn_PssUpdateV2` (`src/tools/addTasks.ts:333`, `src/tools/updateTasks.ts:192`, ergonomic variants at `addTasksSimple.ts:735` and `updateTasksSimple.ts:432`). Custom columns therefore ride as **extra keys inside each entity object** in that collection — the same serialization rules as any OData create/update body. `validateUpdateEntities` already permits `msdyn_project` entities (`updateTasks.ts:110`), so project custom columns have a write path too.
2. **The metadata query pattern already exists** in `src/tools/describeOptionSet.ts` (it hits `EntityDefinitions(LogicalName='…')/Attributes(LogicalName='…')/<cast>?$expand=OptionSet`), and the **capability-cache pattern** already exists in `src/tools/capabilities.ts` (module-scoped, process-lifetime, tenant-stable). The design reuses both.

## 2. Approach decision: metadata-driven, with a config guardrail (hybrid, metadata-first)

| Criterion | (1) Static config allow-list | (2) Metadata discovery | Chosen |
|---|---|---|---|
| Correctness across all types | Operator must hand-declare type per column; wrong type = silently corrupt writes (e.g. picklist as string) | Type comes from Dataverse `AttributeType`/`AttributeTypeName`; authoritative | **2** |
| Lookup nav-property resolution | Operator must know PascalCase nav name + target set — the exact trap `PSS-IMPLEMENTATION-LESSONS.md` §"@odata.bind casing" warns about | Resolved from `ManyToOneRelationships` metadata automatically | **2** |
| Option-set value/label mapping | Operator hand-copies integers | Read from `OptionSet.Options` (already done in `describeOptionSet.ts`) | **2** |
| Operator burden | High and error-prone; every schema change needs a redeploy | Zero per-column config | **2** |
| Permissions to read metadata | None | Needs read on Entity/Attribute metadata (`prvReadEntity`/`prvReadAttribute`) — normally held by any user who can read the record | 2 (graceful degrade) |
| Cold-start latency | Zero | One metadata read per entity, cached process-lifetime | 2 (amortized) |
| Failure modes | Can't discover new columns; stale config | Metadata read can 403 on locked-down tenants | Both — mitigated |
| Security / guardrails | Trusts operator | Must NOT auto-allow engine-managed columns | Both need a guardrail |

**Recommendation: metadata-driven discovery (approach 2) as the source of truth for _types_, wrapped by a policy guardrail (a slice of approach 1) that decides _which_ columns are writable.** This is a hybrid where metadata answers "how do I serialize this?" and policy answers "am I allowed to write this?".

The guardrail is intrinsic, not operator config in the common case:

- **Custom-only by prefix + `IsCustomAttribute`.** A column is eligible for write only if `IsCustomAttribute === true` (metadata flag) AND its logical name is **not** in the existing engine-managed block-lists (`BLOCKED_ON_CREATE`, `HIERARCHY_BLOCKED` in `addTasks.ts`; `BLOCKED_PROJECT_FIELDS`, `ROLLED_UP_FIELDS` in `updateTasks.ts`). Standard `msdyn_` fields keep flowing through the existing ergonomic tools exactly as today — the custom-column path never touches them.
- **Read-only computed columns rejected on write** using metadata flags: `IsValidForCreate`, `IsValidForUpdate`, and `AttributeOf`/`SourceType` (calculated/rollup). This is stronger than the current hardcoded lists because it's derived, not guessed.
- **Optional env override** `CUSTOM_COLUMNS_MODE` (`off` | `metadata` | `metadata+allowlist`) and `CUSTOM_COLUMNS_ALLOWLIST` (comma list of logical names) for tenants that want to *further* restrict which custom columns are writable, or to run in a locked-down mode where metadata can't be read. Default is `off` so the feature is **opt-in and backward-compatible** (see §9).

Net: metadata gives correctness for free; the prefix + `IsCustom*` + block-list intersection keeps the "no engine-managed writes" guarantee that is the whole point of this server.

## 3. Normalized type system (the type registry)

New module `src/dataverse/columnTypes.ts` defines a **normalized internal type** and a **serializer/deserializer per type**. It is pure (no network), so it is fully unit-testable per the CLAUDE.md test rule.

```ts
export type NormalizedType =
  | "string" | "memo" | "int" | "bigint" | "decimal" | "double"
  | "money" | "boolean" | "dateonly" | "datetime" | "picklist"
  | "multipicklist" | "lookup" | "customer" | "owner" | "uniqueidentifier"
  | "state" | "status" | "image" | "file" | "unsupported";

export interface ColumnMeta {
  logicalName: string;             // e.g. new_riskscore
  schemaName: string;              // e.g. new_RiskScore (used nowhere for scalars; needed for casing hints)
  type: NormalizedType;
  isCustom: boolean;               // IsCustomAttribute
  isValidForCreate: boolean;       // IsValidForCreate
  isValidForUpdate: boolean;       // IsValidForUpdate
  isComputed: boolean;             // calculated/rollup/formula: AttributeOf!=null || SourceType>0
  // lookup-only:
  navigationProperty?: string;     // ReferencingEntityNavigationPropertyName — the @odata.bind key
  targets?: string[];              // ReferencedEntity logical names (polymorphic => >1)
  targetEntitySets?: Record<string,string>; // logicalName -> EntitySetName for the /set(guid) form
  // picklist-only:
  options?: { value: number; label: string | null }[];
  dateBehavior?: "DateOnly" | "UserLocal" | "TimeZoneIndependent"; // DateTimeBehavior
}
```

### 3.1 Serializer / deserializer contract

```ts
export interface TypeCodec {
  /** Build the OData write payload fragment: returns [key, value] pairs to
   *  splice into the entity object. Lookups return a different KEY
   *  (navProp@odata.bind) than the logical name; scalars return the logical
   *  name unchanged. Throws a clear error on an invalid input value. */
  toWrite(col: ColumnMeta, input: unknown): Array<[string, unknown]>;
  /** Shape a read value + its @OData…FormattedValue annotation into the
   *  surfaced JSON. */
  fromRead(col: ColumnMeta, row: Record<string, unknown>): unknown;
}
```

### 3.2 The mapping table (Dataverse AttributeType → normalized → write shape → read shape)

`AttributeType` alone is ambiguous for several cases, so resolution uses `AttributeTypeName` where needed (e.g. `BigIntType`, `MultiSelectPicklistType`, `ImageType`, `FileType`).

| Dataverse AttributeType / TypeName | Normalized | Write payload (key → value) | Read shape (surfaced) |
|---|---|---|---|
| `String` | `string` | `new_x` → JSON string (HTML-safe; run through the same sanitizer note as descriptions) | plain string, decoded via `decodeDataverseText` (`readHelpers.ts:49`) |
| `Memo` | `memo` | `new_x` → JSON string | string (clip like descriptions if huge) |
| `Integer` | `int` | `new_x` → JSON number (must be integer) | number |
| `BigInt` | `bigint` | `new_x` → JSON number **or numeric string** (>2^53 safety) | number/string |
| `Decimal` | `decimal` | `new_x` → JSON number | number |
| `Double` | `double` | `new_x` → JSON number | number |
| `Money` | `money` | `new_x` → JSON number | number; `FormattedValue` = currency string |
| `Boolean` | `boolean` | `new_x` → JSON bool | bool; `FormattedValue` = Yes/No label |
| `DateTime` + `DateOnly` behavior | `dateonly` | `new_x` → `"YYYY-MM-DD"` (no time/zone) | `"YYYY-MM-DD"` |
| `DateTime` + `UserLocal`/`TimeZoneIndependent` | `datetime` | `new_x` → ISO-8601 UTC (`...Z`) | ISO-8601 string |
| `Picklist` | `picklist` | `new_x` → **integer option value** (accept label→value via metadata) | `{ value, label }` from `_value` + `FormattedValue` |
| `MultiSelectPicklist` | `multipicklist` | `new_x` → **comma-joined integers** `"1,3,7"` (accept array of values or labels) | `{ values:[…], labels:[…] }` |
| `Lookup` (single-target) | `lookup` | **`<navProp>@odata.bind`** → `"/<entitySet>(<guid>)"` (NOT logical name) | `_<logical>_value` + `…@Microsoft.Dynamics.CRM.lookuplogicalname` + FormattedValue |
| `Lookup` (polymorphic) / `Customer` | `customer` | `<navProp>@odata.bind` → `"/<entitySet>(<guid>)"` where set is chosen from caller-supplied `target` + metadata `targets` | as lookup, plus target entity logical name annotation |
| `Owner` | `owner` | `ownerid@odata.bind` → `/systemusers(guid)` or `/teams(guid)` | owner id + type |
| `Uniqueidentifier` | `uniqueidentifier` | `new_x` → GUID string (validated via `assertGuid`) | GUID string |
| `State` | `state` | **blocked on write** (engine/lifecycle-managed) | int + label |
| `Status` | `status` | **blocked by default** (transition-guarded); read-only surface | int + label |
| `Image` / `ImageType` | `image` | **out of scope** — reject with pointer to the image upload endpoint | thumbnail flag only |
| `File` / `FileType` | `file` | **out of scope** — reject with pointer to `…/new_x` file endpoint | file name/size only |
| calculated / rollup / formula (`SourceType>0` or `AttributeOf!=null`) | (any) + `isComputed` | **rejected on write** | read-only value |
| unknown / `Virtual` / `EntityName` / `PartyList` | `unsupported` | **rejected** with an explicit "type not supported by this server" error | passthrough read if present |

**Boundary called out explicitly:** Image and File columns are **not writable here.** They use dedicated Web API upload streams (`PATCH .../new_imagecolumn` with binary body, or the file upload session endpoints), which are outside this server's `PssCreate/UpdateV2` entity-collection model and outside the single-JSON-body `dvReq` shape (`src/dataverse.ts:75`). The codec throws a clear, actionable error naming the correct out-of-band path.

### 3.3 Lookup handling in detail (the hard case)

For a lookup/customer/owner column named e.g. `new_ownerteam`:

1. Metadata read returns the `ManyToOneRelationships` for the entity (as `PSS-IMPLEMENTATION-LESSONS.md` §1 already prescribes): each has `ReferencingAttribute` (= the logical name), `ReferencingEntityNavigationPropertyName` (= the `@odata.bind` key — this is what must be used, **not** the logical name), and `ReferencedEntity` (target logical name).
2. The **navigation property name is what differs from the logical name** and is exactly the trap this repo already mitigates for standard binds (`TASK_BIND_ALIASES` in `addTasks.ts:45`). We resolve it from metadata instead of hardcoding.
3. The **target entity set** (plural collection name for the `/set(guid)` URL fragment) is resolved from `EntityDefinitions(LogicalName='<target>')?$select=EntitySetName`. This closes the plural-set-name trap called out in `PSS-IMPLEMENTATION-LESSONS.md` §"Entity-set names" (`msdyn_projecttaskdependencies`, not `…dependency`).
4. **Polymorphic** lookups (`Customer`, or a lookup with >1 `ReferencedEntity`) need the caller to say which target: the ergonomic input is `{ target: "systemuser", id: "<guid>" }`; the codec picks the entity set for `target` from `targetEntitySets`. If the metadata reports a single target, `target` is optional.
5. Output write fragment: `[ "new_OwnerTeam@odata.bind", "/teams(<guid>)" ]`. The GUID is run through `assertGuid` (`dataverse.ts:39`) before it enters the URL fragment — preserving the "never trust model GUIDs in a URL" rule (CLAUDE.md conventions).

## 4. Metadata retrieval + caching layer

New module `src/dataverse/metadata.ts`.

**Endpoints** (delegated user token, via `dvReq` with `retry:true`):
- Attributes: `EntityDefinitions(LogicalName='msdyn_projecttask')/Attributes?$select=LogicalName,SchemaName,AttributeType,AttributeTypeName,IsCustomAttribute,IsValidForCreate,IsValidForUpdate,IsValidForRead,AttributeOf,SourceType,RequiredLevel`
- Type-specific casts for choices/dates (reuse the `describeOptionSet.ts` cast approach): `.../Attributes(LogicalName='new_x')/Microsoft.Dynamics.CRM.PicklistAttributeMetadata?$expand=OptionSet($select=Options)`; `DateTimeAttributeMetadata?$select=DateTimeBehavior,Format`; `MultiSelectPicklistAttributeMetadata`.
- Lookups: `.../ManyToOneRelationships?$select=ReferencingAttribute,ReferencingEntityNavigationPropertyName,ReferencedEntity`.
- Entity-set names for lookup targets: `EntityDefinitions(LogicalName='<target>')?$select=EntitySetName`.

**Cache** (mirrors `capabilities.ts` exactly — single-tenant per process, tenant-stable):
- Module-scoped `Map<string, EntityMetadata>` keyed by entity logical name (`msdyn_project`, `msdyn_projecttask`). Each `EntityMetadata` holds `Map<logicalName, ColumnMeta>` for the custom columns plus a resolved lookup index and an entity-set-name sub-cache.
- **TTL:** none by default (schema is stable within a deployment, per the capabilities.ts rationale). Add an optional `CUSTOM_COLUMNS_METADATA_TTL_MS` for tenants iterating on schema; on expiry the next describe re-reads. A `resetMetadataCache()` export for tests, matching `resetCapabilities()`.
- **Cold start:** first custom-column write/read for an entity does one metadata round-trip (attributes) plus lazily one cast per custom column actually referenced and one entity-set lookup per distinct lookup target. All cached thereafter. Bounded because we only fetch metadata for columns the caller actually names.
- **Graceful degradation:** if the metadata read 403s (locked-down tenant) or errors, and `CUSTOM_COLUMNS_MODE=metadata`, the write of a custom column **fails closed** with a clear message ("cannot read column metadata; ask an admin for `prvReadAttribute`, or set `CUSTOM_COLUMNS_ALLOWLIST` with explicit types"). Standard fields are unaffected. Reads of custom columns degrade to raw passthrough (surface the raw `_value`/scalar without type shaping) rather than failing the whole read — same philosophy as the extended-field probe in `getTask.ts:79`.

**Privileges required:** read on entity/attribute metadata (`prvReadEntity`, `prvReadAttribute`) — held by essentially any user who can read the record, so this is normally free. Documented in `SECURITY.md`.

## 5. MCP tool surface (ergonomic + raw layers)

Preserve the two-layer contract described in CLAUDE.md ("Don't blur the two contracts").

### 5.1 New read/discovery tools
- **`list_custom_columns`** — input `{ entity: "project" | "task" }`; returns the custom columns discovered via metadata: `{ logicalName, label, type, writable, readOnlyReason?, options?, lookupTargets? }`. Lets the model learn the schema before writing (the "discover before you code" doctrine, applied at runtime for the agent).
- **`describe_columns`** — input `{ entity, columns: string[] }`; deep detail for named columns (option lists, date behavior, lookup nav/targets). A superset of the existing `describe_option_set` for the choice case; `describe_option_set` stays for back-compat.

Both are `readOnlyHint` (`RO` in `index.ts:87`) and eligible in the `reporting`/`discovery` toolsets.

### 5.2 Ergonomic write path — a `customFields` map
Extend `add_tasks`, `update_tasks`, and `create_plan` (and a new small `update_plan` if desired — see §12) with an optional `customFields: Record<string, unknown>` on the task/plan object:

```jsonc
// add_tasks task object
{ "ref":"t1", "subject":"…", "bucket":"…",
  "customFields": {
    "new_riskscore": 7,
    "new_category": "High",                     // picklist by LABEL (resolved to value)
    "new_reviewdate": "2026-08-01",             // dateonly
    "new_owningteam": { "target":"team", "id":"<guid>" }  // lookup
  } }
```

- The map is **only** the custom-column channel; standard fields keep their existing named parameters. This keeps the ergonomic tools' curated shape intact and additive.
- The tool resolves each key through `metadata.ts` → `columnTypes.ts` codec → splices `toWrite` fragments into the built entity in `buildTaskEntities` (`addTasksSimple.ts:150`) / `buildUpdateEntities` (`updateTasksSimple.ts:52`). Since those builders are pure, the metadata is fetched in the async handler and passed in as an injected resolver (same pattern as `resolveBucketId`), so the builders stay unit-testable with a fake resolver.
- Label-friendly by default: picklist accepts a label or an integer; lookup accepts `{target,id}` or a bare guid when single-target.

### 5.3 Raw write path — extend the batch allow-list check
`add_tasks_batch` / `update_tasks_batch` currently reject any key not on the standard list only implicitly (they reject bad `@odata.type`, blocked fields, wrong binds). Today an unknown scalar key on a task actually passes through to PSS. The design **tightens and clarifies** this: `validateAddEntities`/`validateUpdateEntities` gain a step that, for any key with a custom prefix (not `msdyn_`), validates it against metadata + policy (custom, valid-for-create/update, not computed, supported type, correct bind key for lookups) and rejects otherwise — turning a silent PSS failure into a precise, teachable error, consistent with the existing "teach the correct key" philosophy (`addTasks.ts:135`). This is a net guardrail **strengthening**, so it aligns with golden rule #1.

## 6. Validation & guardrails

Keeping the invariants in CLAUDE.md §"Guardrails you must preserve":

1. **No engine-managed writes.** A custom column is writable only if `isCustom && isValidForCreate/Update && !isComputed && type ∉ {state,status,image,file,unsupported}` and its logical name is not in any existing block-list. Standard rollup/blocked fields are untouched by this path.
2. **Prefix discipline.** Anything starting `msdyn_` is treated as standard and routed through existing logic; only publisher-prefixed columns (or metadata `isCustom`) enter the codec path. Distinguishing by `IsCustomAttribute` (authoritative) rather than string prefix alone avoids false positives.
3. **Lookups validated:** GUID via `assertGuid` before it enters the `/set(guid)` fragment; nav-property key comes from metadata, never caller input; polymorphic target must be one of the metadata `targets` or it's rejected.
4. **200-item cap, session flow, summary-task protection** all unchanged — custom columns ride inside the same entities, so `validateUpdateEntities`'s summary-task guard (`updateTasks.ts:136`) still fires on those entities.
5. **Errors surface specifically:** "column `new_x` is a calculated column and cannot be written", "`new_x` is a File column — use the file upload endpoint `…`", "`new_x` picklist has no option labeled 'Foo'; valid: [Low, Medium, High]". No silent drops (matches the existing reject-don't-guess convention).
6. **Read-only mode / toolsets** honored — the new write channel is inert when `READ_ONLY_MODE` is on (defense-in-depth check in `server.ts:79` still applies; the discovery tools are `RO`).

## 7. Read-path changes

- **Dynamic `$select`.** The read tools (`getTask.ts`, `listPlanTasks.ts`, `getPlanSummary.ts`) currently use hardcoded `CORE_SELECT`. Add an optional `includeCustomColumns?: boolean | string[]` input. When set, the handler asks `metadata.ts` for the writable/readable custom columns of the entity, expands each to the correct read projection: scalar → `new_x`; lookup → `_new_x_value`; and appends to `$select`.
- **Formatted values & labels.** The read headers already request `OData.Community.Display.V1.FormattedValue` annotations (`readHelpers.ts:171,313`). The deserializer reads both the raw value and its `…@OData.Community.Display.V1.FormattedValue` sibling, plus the `…@Microsoft.Dynamics.CRM.lookuplogicalname` annotation for polymorphic lookups, and surfaces `{ value, label }` for choices, `{ id, logicalName, name }` for lookups (name from the FormattedValue). This mirrors how `linkTypeLabel` (`readHelpers.ts:26`) already labels the one hardcoded option set today, generalized.
- **Graceful absence** reuses the `isMissingPropertyError` probe (`capabilities.ts:36`): a `$select` on a column the tenant renamed/removed degrades to core-only with a warning rather than failing (same pattern as extended fields in `listPlanTasks.ts:142`).
- **Budgeting:** custom memo/string columns pass through the same `fitToBudget`/`pageByOffset` clipping (`readHelpers.ts:212`) so custom columns can't blow the ~200k host cap.

## 8. Module list (new + touched)

New:
- `src/dataverse/columnTypes.ts` — `NormalizedType`, `ColumnMeta`, per-type `TypeCodec` registry, `toWrite`/`fromRead`. **Pure.**
- `src/dataverse/metadata.ts` — metadata fetch + process-lifetime cache; `getEntityMetadata(entity)`, `resolveColumn(entity, logicalName)`, `resolveLookupTargetSet(target)`; graceful-degrade. Mirrors `capabilities.ts`.
- `src/tools/listCustomColumns.ts`, `src/tools/describeColumns.ts` — discovery tools.
- Tests: `test/columnTypes.test.ts` (codec per type), `test/metadataCache.test.ts` (cache/degrade with mocked `dvReq`), `test/customFieldsBuild.test.ts` (builder splicing with a fake resolver).

Touched:
- `src/tools/addTasksSimple.ts` / `updateTasksSimple.ts` — accept `customFields`, inject resolver into the pure builders.
- `src/tools/createPlan.ts` — accept `customFields` on the plan (spliced into the `Project` body of `msdyn_CreateProjectV1`, `createPlan.ts:32`).
- `src/tools/addTasks.ts` / `updateTasks.ts` — extend `validateAddEntities`/`validateUpdateEntities` with the metadata-backed custom-key check.
- `src/tools/getTask.ts` / `listPlanTasks.ts` / `getPlanSummary.ts` — dynamic `$select` + custom-column deserialization.
- `src/tools/index.ts` — register the two new tools + annotations (`RO`).
- `src/config.ts` — `CUSTOM_COLUMNS_MODE`, `CUSTOM_COLUMNS_ALLOWLIST`, `CUSTOM_COLUMNS_METADATA_TTL_MS`.
- `src/server.ts` — one line in `SERVER_INSTRUCTIONS` on the custom-column capability (opt-in, discover first).
- `src/toolsets.ts` — put discovery tools in `reporting`/`discovery`.
- Docs: `README.md` tool table, `SECURITY.md` (metadata privilege + guardrail), `docs/PSS-IMPLEMENTATION-LESSONS.md` (lookup/nav resolution notes).

## 9. Backward compatibility

- **Default `CUSTOM_COLUMNS_MODE=off`** → no behavior change at all; `customFields` and `includeCustomColumns` are ignored/absent; existing tests untouched.
- When on, the feature is **purely additive**: new optional inputs, new tools; every existing tool signature and output shape is unchanged. Existing standard-field flows never route through the codec.
- The raw-batch tightening (rejecting unknown custom keys unless metadata-approved) only fires for non-`msdyn_` keys, which previously would have failed at PSS anyway — so no previously-working call breaks; it just fails earlier and more clearly. Guarded behind `CUSTOM_COLUMNS_MODE` so it's opt-in.

## 10. Phased implementation plan

**Phase 0 — Discovery/proof (no code shipped).** Using an e2e token, `describe_option_set`-style probes against `msdyn_projecttask/Attributes` on a tenant with a real custom column of each type; capture the exact `AttributeType`/`AttributeTypeName`/nav-property/`EntitySetName` shapes and one live `msdyn_PssUpdateV2` per type. Record recipes in `docs/PSS-IMPLEMENTATION-LESSONS.md`. (Follows the repo's "probe before code" doctrine.)

**Phase 1 — Type registry (pure, no network).** Build `columnTypes.ts` + `test/columnTypes.test.ts` with a hand-written `ColumnMeta` fixture per row of §3.2. No tool wiring yet. Green: `npm run typecheck && npm test`.

**Phase 2 — Metadata layer.** `metadata.ts` + `test/metadataCache.test.ts` (mock `dvReq`): attribute parse, cast fan-out, lookup nav resolution, entity-set resolution, cache hit/miss, 403 degrade. Config vars in `config.ts` + `config.test.ts` update.

**Phase 3 — Read path.** Add `includeCustomColumns` to `getTask`/`listPlanTasks`; dynamic `$select`, deserialization with FormattedValue, graceful absence. Unit tests with recorded row fixtures (include a lookup `_value`+annotation and a picklist FormattedValue). This ships read value early with low risk.

**Phase 4 — Discovery tools.** `listCustomColumns`/`describeColumns` + register in `index.ts`/toolsets; annotations `RO`.

**Phase 5 — Ergonomic write.** `customFields` on `add_tasks`/`update_tasks`/`create_plan`; inject resolver into the pure builders; `test/customFieldsBuild.test.ts` (fake resolver → assert spliced payload per type, incl. lookup `@odata.bind` and picklist label→value). Defense-in-depth `validate*Entities` still runs on the built collection (as `addTasksSimple.ts:700` already does).

**Phase 6 — Raw-batch guardrail.** Extend `validateAddEntities`/`validateUpdateEntities` with the metadata-backed custom-key check + tests in `test/guardrails.test.ts` (reject computed, reject wrong lookup key, accept a valid custom scalar).

**Phase 7 — E2E + docs.** Add a custom-column scenario to `test/e2e/` (seed a custom column of a few types on the e2e tenant; the `.e2e-seed-cache.json` seed can carry expected shapes). Update `README.md`, `SECURITY.md`, `SERVER_INSTRUCTIONS`.

## 11. Testing strategy

- **Per-type serializer unit tests** (Phase 1): one `toWrite`/`fromRead` assertion per §3.2 row, including boundary rejects (image/file/computed/state throw). No network — the CLAUDE.md bar for "works".
- **Metadata cache tests** with mocked `dvReq`: verify only-fetch-once, correct casts, 403 degrade path.
- **Builder tests** with an injected fake column resolver so lookups/choices are tested **without a live custom column** (the resolver returns canned `ColumnMeta`). This is how the repo already tests bucket/sprint resolution (`buildTasks.test.ts`, injected `resolveBucketId`).
- **Guardrail tests**: reject engine-managed/computed/wrong-lookup-key; accept valid custom scalar; confirm summary-task and 200-cap guards still fire with custom keys present.
- **E2E (live, opt-in)**: create a plan, set custom scalar + picklist + lookup + dateonly via `update_tasks`, `apply_changes`, read back via `get_task includeCustomColumns` and independent raw OData — never via an AI summary (per `PSS-IMPLEMENTATION-LESSONS.md` §4). Lookups/choices without a pre-existing custom column are covered by seeding one in the e2e setup or by mocking at the builder layer for CI.

## 12. Risks, edge cases, open questions

- **PSS may reject some custom columns on create even when `IsValidForCreate=true`** (as it does for engine-managed standard fields). Mitigation: mode `metadata` fails closed on the *live* PSS error and teaches "set via `update_tasks` after apply", mirroring the `msdyn_progress` blocked-on-create remedy (`addTasks.ts:24`). Open question resolved in Phase 0 probing.
- **BigInt precision** beyond 2^53: prefer numeric-string on write when the input exceeds the safe integer range.
- **DateOnly vs DateTime ambiguity**: both are `AttributeType=DateTime`; only `DateTimeBehavior` distinguishes. Must read the `DateTimeAttributeMetadata` cast — a scalar attributes query alone is insufficient (called out in §4).
- **Polymorphic lookup with an ambiguous target** and no caller `target`: reject with the list of valid targets rather than guessing.
- **Metadata read denied (403)**: covered by graceful degrade + `CUSTOM_COLUMNS_ALLOWLIST` escape hatch (operator declares logical name + type).
- **Multi-tenant reuse**: the module-scoped cache assumes single tenant per process (true — `DATAVERSE_ORG_URL` is env-fixed, per `capabilities.ts` rationale). If the server ever becomes multi-tenant, the cache key must include the org URL.
- **`create_plan` uses `msdyn_CreateProjectV1`, not the PSS entity collection** — confirm custom columns are accepted in its `Project` body (Phase 0). If not, route plan custom-column writes through a follow-up `update_tasks_batch`-style `msdyn_PssUpdateV2` on the `msdyn_project` entity (already permitted at `updateTasks.ts:110`). This motivates an optional small **`update_plan`** ergonomic tool.
- **Choice label collisions / renamed options**: prefer value when the caller passes an integer; when passing a label, reject on ambiguity rather than pick.

## Critical files for implementation
- `src/tools/addTasks.ts` (raw create allow-list + `validateAddEntities` — where the custom-key guardrail is added)
- `src/tools/updateTasks.ts` (raw update allow-list + `validateUpdateEntities`; already accepts `msdyn_project` entities)
- `src/tools/addTasksSimple.ts` (pure `buildTaskEntities` — where `customFields` codec fragments splice in)
- `src/tools/describeOptionSet.ts` and `src/tools/capabilities.ts` (existing metadata-query + process-lifetime cache patterns the new `metadata.ts`/`columnTypes.ts` modules mirror)
- `src/tools/getTask.ts` (read-path `$select` + FormattedValue deserialization to extend for custom columns)
