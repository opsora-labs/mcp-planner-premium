# Plan 30 — Production-Ops features

Architect plan (PLANNING ONLY). Scope: three operator-facing controls for the
mcp-planner-premium MCP server, adapting the patterns mcp-atlassian uses
(READ_ONLY_MODE, ENABLED_TOOLS, TOOLSETS, /healthz) to **this** repo's idioms —
stateless Streamable-HTTP, delegated per-request token, no standing secrets, Zod
fail-fast config, pure-function + vitest unit-test discipline.

Three features:

1. **READ_ONLY_MODE** — env flag that exposes only read-only tools.
2. **Toolset filtering** — `ENABLED_TOOLS` (explicit allowlist) + `TOOLSETS`
   (named groups), fail-closed on unknown names.
3. **Link-type auto-detect** — derive `global` vs `eu` link-type values from the
   tenant instead of requiring `DATAVERSE_LINK_TYPE_STYLE`; make the env var an
   optional override.

Features 1 and 2 share one **pure filtering function** (`src/toolFilter.ts`) that
`server.ts` calls at registration time. Feature 3 is independent and touches the
read/write link-type paths.

The golden rules apply: never weaken a guardrail, branch per feature, green
before done (`npm run typecheck` + `npm test`), tests come with behaviour, no
secrets, Zod at boundaries, no new runtime deps (none are needed here).

---

## Ground truth gathered from the code

The 25 tools and their MCP `name` ids (from `src/tools/index.ts` order; import →
`name`):

| # | import | MCP `name` | `readOnlyHint` | annotation const |
|---|---|---|---|---|
| 1 | createPlan | `create_plan` | false | ADD |
| 2 | addBucket | `add_bucket` | false | ADD |
| 3 | addSprint | `add_sprint` | false | ADD |
| 4 | startChangeSession | `start_change_session` | false | ADD |
| 5 | addTasksSimple | `add_tasks` | false | ADD |
| 6 | addTasks | `add_tasks_batch` | false | ADD |
| 7 | updateTasksSimple | `update_tasks` | false | UPDATE |
| 8 | updateTasks | `update_tasks_batch` | false | UPDATE |
| 9 | deleteTasks | `delete_tasks_batch` | false | (destructive) |
| 10 | applyChanges | `apply_changes` | false | (apply) |
| 11 | checkStatus | `check_change_session_status` | **true** | RO |
| 12 | cancelSession | `cancel_change_session` | false | (destructive) |
| 13 | findPlan | `find_plan_by_name` | **true** | RO |
| 14 | findTeamMember | `find_team_member` | **true** | RO |
| 15 | getPlanContents | `get_plan_tasks_and_buckets` | **true** | RO |
| 16 | whoami | `whoami` | **true** | RO |
| 17 | listPlans | `list_plans` | **true** | RO |
| 18 | listMyTasks | `list_my_tasks` | **true** | RO |
| 19 | getPlanSummary | `get_plan_summary` | **true** | RO |
| 20 | getTask | `get_task` | **true** | RO |
| 21 | listPlanTasks | `list_plan_tasks` | **true** | RO |
| 22 | getBucketBreakdown | `get_bucket_breakdown` | **true** | RO |
| 23 | listDependencies | `list_dependencies` | **true** | RO |
| 24 | listTeamMembers | `list_team_members` | **true** | RO |
| 25 | describeOptionSet | `describe_option_set` | **true** | RO |

So **14 read-only** (`readOnlyHint === true`) and **11 write/session**
(`readOnlyHint === false`). `start_change_session` and `apply_changes` are
correctly write/session — they mutate server-side change-session state — so they
are filtered out under READ_ONLY_MODE. `check_change_session_status` is read-only
and survives.

Other facts the plan relies on:

- `config.ts`: `EnvSchema` is a single Zod object with a `.superRefine` for the
  AUTH cross-field rule; `getEnv()` parses+caches once (fail-fast); `splitList`
  already exists (private) for comma lists; `DATAVERSE_LINK_TYPE_STYLE` is
  currently a **required** `z.enum(["global","eu"])`.
- `server.ts`: `buildServer()` loops `for (const tool of allTools)
  server.registerTool(tool.name, { …, annotations: toolAnnotations[tool.name] },
  handler)`. Built once **per request** (stateless transport) — so filtering runs
  on every request; it must be cheap and deterministic.
- `app.ts`: `buildApp()` calls `getEnv()` (fail-fast at boot); `/healthz` already
  exists and reports `{ ok, service }` / 503 when draining. JWT verify + rate
  limit + helmet already present.
- `src/index.ts`: calls `getEnv()` at module load (fail-fast). **No token at
  boot; no standing secret** — the delegated bearer arrives per request via the
  `Authorization` header and lives in `requestContext` (AsyncLocalStorage). This
  is the hard constraint for Feature 3.
- Write link-type path: `addTasksSimple.ts` selects
  `LINK_TYPE_VALUES_EU`/`LINK_TYPE_VALUES_GLOBAL` from
  `getEnv().DATAVERSE_LINK_TYPE_STYLE` and passes it into the pure
  `buildTaskEntities(...)`. Read link-type path: `readHelpers.ts`
  `LINK_TYPE_LABELS` maps **both** ranges already (no style needed on read).
- `describeOptionSet.ts` already reads option-set values+labels for
  `msdyn_projecttaskdependency` / `msdyn_projecttaskdependencylinktype` via
  `dvReq` + `dvHeaders()`. Its inner logic is the basis for auto-detect.
- `dvHeaders(opts?: { json?: boolean; extra?: Record<string,string> })` →
  headers (uses `getBearer()` from request context).
- Tests: pure-function vitest under `test/*.test.ts`; HTTP tests in
  `test/http.test.ts` use `supertest` + `setEnv()` + `resetEnvCache()`. E2E uses
  `test/e2e/mcpClient.ts` `mcpToolNames(mcpUrl, bearer)` against the live
  protocol.

---

# Feature 1 — READ_ONLY_MODE

## Context

An operator wants to deploy a **reporting-only** instance: it can read plans,
tasks, dependencies, team members, change-session status, etc., but cannot create
plans/buckets/tasks, open/cancel/apply change sessions, update, or delete. This
is the mcp-atlassian `READ_ONLY_MODE` analogue. Two layers:

1. **At registration** (`server.ts`): write/session tools are filtered OUT of
   `tools/list`, so a host never sees them.
2. **Defense-in-depth at call time**: even if a write tool were somehow invoked
   (stale client, direct JSON-RPC), the handler is rejected with a clear
   "server is in read-only mode" error before any Dataverse call.

Read-only-ness is decided by `toolAnnotations[name].readOnlyHint === true` — the
**single source of truth** already in `tools/index.ts`. We do not introduce a
second classification list to drift from it.

## Env / config addition (Zod)

In `EnvSchema` (config.ts):

```ts
// When true, the server exposes ONLY read-only tools (readOnlyHint===true) and
// rejects any write/session tool call. For a safe reporting-only deployment.
READ_ONLY_MODE: z
  .union([z.boolean(), z.string()])
  .optional()
  .default(false)
  .transform(coerceBool), // see helper below
```

`process.env` values are strings, so add a small **boolean coercion** helper
(local to config.ts, unit-tested), accepting `"true"/"1"/"yes"/"on"` (case-
insensitive) as true and `"false"/"0"/"no"/"off"/""` as false; reject anything
else with a Zod issue (fail-fast). Default `false`. Expose via a getter:

```ts
export function isReadOnlyMode(): boolean { return getEnv().READ_ONLY_MODE; }
```

Validation: invalid string (e.g. `READ_ONLY_MODE=maybe`) → boot crash with a
clear message, consistent with the existing fail-fast posture.

## Behaviour & exact tool classification

Under `READ_ONLY_MODE=true` the **14 read-only** tools are exposed:

`check_change_session_status, find_plan_by_name, find_team_member,
get_plan_tasks_and_buckets, whoami, list_plans, list_my_tasks, get_plan_summary,
get_task, list_plan_tasks, get_bucket_breakdown, list_dependencies,
list_team_members, describe_option_set`

The **11 write/session** tools are hidden + hard-rejected:

`create_plan, add_bucket, add_sprint, start_change_session, add_tasks,
add_tasks_batch, update_tasks, update_tasks_batch, delete_tasks_batch,
apply_changes, cancel_change_session`

## Integration points

- **Registration** (`server.ts`): replace the `for (const tool of allTools)` loop
  source with the **filtered** list returned by the pure function (Feature 2
  describes the combined function; READ_ONLY_MODE is one of its inputs).
- **Call-time guard** (`server.ts`, inside the registered handler): wrap the
  handler so that, if `READ_ONLY_MODE` is on and the tool is not read-only, it
  throws `Error("This server is running in read-only mode; '<name>' is a
  write/session tool and is disabled.")` before `tool.handler(args)`. Because
  registration already hides them, this guard fires only for the defense-in-depth
  path; keep it cheap (a `Set<string>` of read-only names captured once when
  `buildServer()` runs). Throwing surfaces as an MCP tool error (matches existing
  error convention).

This guard must NOT weaken any existing guardrail — it is an additional gate that
sits *before* the tool's own validation.

---

# Feature 2 — Toolset filtering (ENABLED_TOOLS + TOOLSETS)

## Context

Two orthogonal allowlists, mirroring mcp-atlassian:

- **ENABLED_TOOLS** — explicit comma-list of exact tool `name`s. If set, only
  those names are eligible.
- **TOOLSETS** — comma-list of named **groups**; a tool is eligible if it belongs
  to ≥1 selected group.

Both fail **closed** on an unknown tool name / unknown toolset (clear boot error),
so a typo can never silently expose nothing-or-everything. Combined with
READ_ONLY_MODE per the semantics table below.

## Proposed toolset groups (every tool maps to ≥1 group)

| group | tools |
|---|---|
| `reporting` | `list_plans`, `list_my_tasks`, `get_plan_summary`, `get_task`, `list_plan_tasks`, `get_bucket_breakdown`, `list_dependencies` |
| `discovery` | `find_plan_by_name`, `find_team_member`, `get_plan_tasks_and_buckets`, `list_team_members`, `whoami`, `describe_option_set` |
| `sessions` | `start_change_session`, `apply_changes`, `check_change_session_status`, `cancel_change_session` |
| `write` | `create_plan`, `add_bucket`, `add_sprint`, `add_tasks`, `add_tasks_batch`, `update_tasks`, `update_tasks_batch`, `delete_tasks_batch` |
| `analytics` | `get_plan_summary`, `get_bucket_breakdown`, `list_dependencies`, `list_plan_tasks` (overlap with `reporting` is intentional — a curated "insights" subset) |

Notes on the mapping:

- Every one of the 25 tools belongs to at least one group. `reporting`+`discovery`
  together cover all 14 read-only tools. `sessions`+`write` cover all 11
  write/session tools. `analytics` deliberately re-uses four reporting tools so an
  operator can expose a tight analytics surface without the full reporting set.
- The group→tools map lives in `src/toolFilter.ts` as a `const TOOLSETS:
  Record<string, readonly string[]>`, with a compile-time/boot-time self-check
  (unit-tested) that every group member is a real tool `name` and that the union
  of all groups equals the full tool set — so the map can't silently drift from
  `allTools`.

## Env / config additions (Zod)

In `EnvSchema` (config.ts), reuse the existing comma-list style:

```ts
// Explicit allowlist of tool names (comma list). Unset = all tools eligible.
ENABLED_TOOLS: z.string().optional(),
// Named tool groups to expose (comma list). Unset = all groups eligible.
TOOLSETS: z.string().optional(),
```

Add getters mirroring `getAllowedHosts()`:

```ts
export function getEnabledTools(): string[] | undefined { return splitList(getEnv().ENABLED_TOOLS); }
export function getToolsets(): string[] | undefined { return splitList(getEnv().TOOLSETS); }
```

`splitList` already trims, drops empties, and returns `undefined` for empty —
exactly the "unset = no constraint" semantics we want. **Validation of the
*values*** (unknown tool name / unknown toolset → fail-closed) happens in the pure
filter function, surfaced at boot (see below) — not in the Zod schema, because the
schema must not import the tool registry (keeps config.ts free of tool deps and
avoids a cycle).

## The pure filtering function

New file **`src/toolFilter.ts`**. Pure, no I/O, fully unit-testable.

```ts
import type { ToolDef } from "./tools/types.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

export interface ToolFilterEnv {
  readOnly: boolean;
  enabledTools?: string[]; // exact names; undefined = no constraint
  toolsets?: string[];     // group names; undefined = no constraint
}

export interface ToolFilterResult {
  /** Tools to register, in the original allTools order. */
  tools: ToolDef[];
  /** name -> human reason it was excluded (for /healthz + boot log + tests). */
  excluded: Record<string, string>;
  /** Read-only tool names (for the call-time read-only guard). */
  readOnlyNames: Set<string>;
}

export const TOOLSETS: Record<string, readonly string[]>; // the map above

/**
 * Decides which tools to expose. Pure + deterministic.
 * THROWS (fail-closed) on an unknown tool name in enabledTools or an unknown
 * group in toolsets — the caller (boot) turns that into a fail-fast crash.
 * Semantics: a tool is exposed IFF
 *   (!readOnly || annotations[name].readOnlyHint === true)
 *   AND (enabledTools === undefined || enabledTools.includes(name))
 *   AND (toolsets    === undefined || name ∈ union(TOOLSETS[g] for g in toolsets))
 */
export function filterTools(
  allTools: ToolDef[],
  annotations: Record<string, ToolAnnotations>,
  env: ToolFilterEnv,
): ToolFilterResult;
```

### Semantics table

| READ_ONLY_MODE | ENABLED_TOOLS | TOOLSETS | Result |
|---|---|---|---|
| false | unset | unset | all 25 tools (unchanged behaviour) |
| true | unset | unset | the 14 read-only tools only |
| false | `["whoami","list_plans"]` | unset | exactly those 2 |
| false | unset | `["reporting"]` | the 7 `reporting` tools |
| false | unset | `["reporting","sessions"]` | union: 7 + 4 = 11 tools |
| true | unset | `["write"]` | **0 tools** — `write` ∩ read-only = ∅ (the AND of all three; not an error, just an empty surface; boot logs a warning) |
| true | `["whoami","add_tasks"]` | unset | `whoami` only — `add_tasks` passes ENABLED_TOOLS but fails READ_ONLY_MODE; excluded reason names READ_ONLY_MODE |
| false | `["list_plans"]` | `["sessions"]` | **0 tools** — intersection of ENABLED_TOOLS and TOOLSETS is empty (`list_plans` ∉ sessions) |
| any | `["does_not_exist"]` | — | **throws** at boot: unknown tool name (fail-closed) |
| any | — | `["nope"]` | **throws** at boot: unknown toolset (fail-closed) |

The combine rule is `READ_ONLY AND ENABLED_TOOLS AND TOOLSETS` — identical to
mcp-atlassian's layering (read-only mode is applied on top of the allowlists, not
instead of them). An empty resulting surface is **legal** (the operator asked for
an impossible intersection); only *unknown names* are errors.

`excluded` records, per hidden tool, which constraint removed it
(`"read-only mode"`, `"not in ENABLED_TOOLS"`, `"not in TOOLSETS [reporting]"`).
This drives both the boot log and a `/healthz` enrichment (below).

## server.ts integration point

`buildServer()` changes from looping over `allTools` to:

```ts
const { tools, readOnlyNames } = filterTools(allTools, toolAnnotations, {
  readOnly: isReadOnlyMode(),
  enabledTools: getEnabledTools(),
  toolsets: getToolsets(),
});
for (const tool of tools) {
  server.registerTool(tool.name, { …, annotations: toolAnnotations[tool.name] },
    async (args) => {
      if (isReadOnlyMode() && !readOnlyNames.has(tool.name)) {
        throw new Error(`This server is running in read-only mode; '${tool.name}' is disabled.`);
      }
      // …existing handler body unchanged…
    });
}
```

Because `buildServer()` runs per request, `filterTools` runs per request — it is
pure and ~25 iterations, so negligible. To validate **fail-closed at boot** (not
per request), also call `filterTools(...)` once in `buildApp()` (app.ts) right
after `getEnv()`, discarding the result, so an unknown `ENABLED_TOOLS`/`TOOLSETS`
crashes the container at startup the same way a bad env value does. (Alternative:
call it in `src/index.ts` boot. Recommend `buildApp()` so `test/http.test.ts`
covers it without spinning a real listener.)

## /healthz enrichment (optional, low-risk)

Extend `/healthz` to report the effective surface so an operator can confirm a
deployment without an MCP handshake:

```json
{ "ok": true, "service": "mcp-planner-premium",
  "readOnly": true, "toolCount": 14 }
```

Keep it metadata-only (no secrets, no token). This is the mcp-atlassian `/healthz`
parity touch. Do **not** add the full excluded map to the public probe — count +
readOnly flag is enough and avoids leaking the tool catalogue shape.

---

# Feature 3 — Link-type auto-detect

## Context (TODO.md item)

Today `DATAVERSE_LINK_TYPE_STYLE` is a **required** env enum (`global` | `eu`)
that selects which integer range the write path sends for FS/SS/FF/SF
(`addTasksSimple.ts` → `buildTaskEntities`). The read path already handles both
ranges (`readHelpers.LINK_TYPE_LABELS`), so detection only matters for **writes**.
We want to derive the style from the tenant and make the env var an **optional
override**.

## The hard constraint: no token at boot

`describe_option_set`'s probe needs an authenticated Dataverse call
(`dvReq`+`dvHeaders()` → `getBearer()`), and the bearer only exists **per request**
(delegated, AsyncLocalStorage). The server holds **no standing secret** and there
is **no token at boot** (confirmed: `src/index.ts` only calls `getEnv()`).
Therefore **startup probing is not possible** without breaking the no-standing-
secrets model — we will not introduce a service principal or cached token to
enable boot-time detection.

## Recommended design: lazy, cached on first authenticated request

Detect **on first write that needs the link-type values**, then cache for the
process lifetime. Concretely:

1. New module **`src/linkTypeStyle.ts`** with a process-lifetime cache:

   ```ts
   type Style = "global" | "eu";
   let cachedStyle: Style | undefined; // module-scope, per-process
   let inflight: Promise<Style> | undefined; // de-dupe concurrent first calls

   /** Returns the link-type style: env override if set, else detected+cached. */
   export async function getLinkTypeStyle(): Promise<Style>;
   /** Test helper. */
   export function resetLinkTypeStyleCache(): void;
   ```

2. `getLinkTypeStyle()` logic:
   - If `getEnv().DATAVERSE_LINK_TYPE_STYLE` is set → return it (override; never
     probes). This preserves today's behaviour exactly for anyone who keeps the
     env var.
   - Else if `cachedStyle` set → return it.
   - Else probe **once** (guarded by `inflight` so concurrent first writes share a
     single network call): read the option-set for
     `msdyn_projecttaskdependency.msdyn_projecttaskdependencylinktype` (reusing
     the `describe_option_set` query — extract its core into a shared helper
     `readLinkTypeOptionValues()` so we don't duplicate the cast-fallback logic),
     inspect the returned `value`s:
       - any value ≥ 192350000 → `"global"`,
       - else (small ints 0..3) → `"eu"`.
     Cache and return. On probe **failure** (network/permission), do **not** cache;
     fall back to `"global"` for *this* call with a logged warning, and let the
     next write retry detection. (`global` is the documented default range; the
     write path will surface a PSS rejection if wrong, exactly as today when the
     env var is mis-set.)

3. **Detection cache key / multi-tenant safety:** the cache is a single
   process-wide value. The org URL is fixed per deployment
   (`DATAVERSE_ORG_URL`), so one process serves exactly one tenant → a single
   cached style is correct. (If the server were ever multi-tenant this would need
   keying by org; call this out but it is out of scope — this server is
   single-org by config.)

4. **Wiring the write path** (`addTasksSimple.ts`): replace

   ```ts
   const linkTypeValues = getEnv().DATAVERSE_LINK_TYPE_STYLE === "eu"
     ? LINK_TYPE_VALUES_EU : LINK_TYPE_VALUES_GLOBAL;
   ```

   with

   ```ts
   const style = await getLinkTypeStyle();
   const linkTypeValues = style === "eu" ? LINK_TYPE_VALUES_EU : LINK_TYPE_VALUES_GLOBAL;
   ```

   `buildTaskEntities` stays pure (still receives `linkTypeValues` as an arg) — the
   detection happens in the handler, not the pure builder. Check whether
   `updateTasksSimple.ts` also sets a link type; if it does, wire it the same way
   (dependencies cannot be *updated* per SERVER_INSTRUCTIONS #7 — they are delete+
   recreate — so the write entry points that emit `msdyn_projecttaskdependencylinktype`
   are `add_tasks` and the raw `add_tasks_batch`; the raw batch passes explicit
   numbers and is out of scope for auto-detect).

## Env / config change

Make the enum **optional** (remove from required), no default added (absence means
"auto-detect"):

```ts
// Optional override. When unset, the server auto-detects the tenant's link-type
// range on first write (cached for the process lifetime). Set to force a value.
DATAVERSE_LINK_TYPE_STYLE: z.enum(["global", "eu"]).optional(),
```

**Backward compatibility / fail-fast note:** this *relaxes* a previously required
var. Existing deployments that set it keep working unchanged (override path).
Deployments that omit it now boot successfully and detect lazily. Because the
detection is lazy, **boot still cannot fail** on a missing link-type style — which
is acceptable since the override is now optional by design. Update the two test
helpers that currently hard-set `DATAVERSE_LINK_TYPE_STYLE=global`
(`test/http.test.ts setEnv`, and any e2e config) — they can keep setting it
(override path) so existing tests stay deterministic and offline.

## Why not startup detection (explicit)

Startup detection was the literal TODO wording ("probe at startup"), but it is
**rejected** here because: (a) no token exists at boot; (b) acquiring one would
require a standing secret/service principal, violating Golden Rule #4 and the
core security model; (c) the server is stateless per request by design. The
lazy-cached-on-first-authenticated-request approach delivers the same operator
outcome (no required env var) **without** introducing a standing credential. This
is the recommended scope; the env override remains for anyone who wants
determinism or to skip the one-time probe.

---

## Files to create / modify

### Create
- `src/toolFilter.ts` — pure `filterTools()` + `TOOLSETS` map (Features 1+2).
- `src/linkTypeStyle.ts` — lazy cached `getLinkTypeStyle()` + reset helper (F3).
- `test/toolFilter.test.ts` — exhaustive filter unit tests.
- `test/linkTypeStyle.test.ts` — detection/override/cache unit tests.
- `test/config.test.ts` — if not already present, boolean-coercion + new-env tests
  (otherwise extend the nearest existing config-level test).

### Modify
- `src/config.ts` — add `READ_ONLY_MODE` (bool coercion), `ENABLED_TOOLS`,
  `TOOLSETS`; make `DATAVERSE_LINK_TYPE_STYLE` optional; add getters
  `isReadOnlyMode`, `getEnabledTools`, `getToolsets`. **SECURITY-CRITICAL —
  preserve fail-fast and the existing `.superRefine`.**
- `src/server.ts` — call `filterTools(...)`; register only the filtered list; add
  the call-time read-only guard inside the handler wrapper.
- `src/app.ts` — call `filterTools(...)` once after `getEnv()` for fail-closed
  boot validation; (optional) enrich `/healthz` with `readOnly` + `toolCount`.
- `src/tools/addTasksSimple.ts` — use `await getLinkTypeStyle()` instead of reading
  `getEnv().DATAVERSE_LINK_TYPE_STYLE` directly.
- `src/tools/describeOptionSet.ts` — extract the option-set read into a shared
  `readLinkTypeOptionValues()` helper that `linkTypeStyle.ts` reuses (avoid
  duplicating the cast-fallback). Keep the tool's external behaviour identical.
- `src/tools/updateTasksSimple.ts` — only if it emits a link-type value (verify
  during implementation; likely no-op).
- `README.md` — new env-vars table rows (`READ_ONLY_MODE`, `ENABLED_TOOLS`,
  `TOOLSETS`, `DATAVERSE_LINK_TYPE_STYLE` now optional/auto-detect), and a
  "reporting-only deployment" note.
- `SECURITY.md` — document READ_ONLY_MODE + toolset filtering as hardening
  controls (defence-in-depth surface reduction; fail-closed allowlists).
- `test/http.test.ts` — keep `setEnv` setting `DATAVERSE_LINK_TYPE_STYLE=global`
  (override path); add the e2e/integration assertions below.

---

## Unit tests (file + concrete cases)

### `test/toolFilter.test.ts` (the pure function — exhaustive)
Build a small fixture or import the real `allTools`/`toolAnnotations`.
- unset/unset/false → returns all 25 names.
- readOnly=true → returns exactly the 14 read-only names; the 11 write/session
  names are in `excluded` with reason "read-only mode"; `readOnlyNames.size===14`.
- ENABLED_TOOLS=`["whoami","list_plans"]` → exactly those 2; others excluded "not
  in ENABLED_TOOLS".
- TOOLSETS=`["reporting"]` → the 7 reporting tools.
- TOOLSETS=`["reporting","sessions"]` → 11 (union, no duplicates).
- ENABLED_TOOLS ∩ TOOLSETS: `["list_plans"]` + `["sessions"]` → empty list (no
  throw); `["start_change_session"]` + `["sessions"]` → `[start_change_session]`.
- readOnly=true + ENABLED_TOOLS=`["whoami","add_tasks"]` → `[whoami]`; `add_tasks`
  excluded for "read-only mode".
- readOnly=true + TOOLSETS=`["write"]` → empty (intersection empty, no throw).
- **fail-closed:** ENABLED_TOOLS=`["bogus_tool"]` → throws /unknown tool/.
- **fail-closed:** TOOLSETS=`["bogus_set"]` → throws /unknown toolset/.
- **map integrity:** every name in every `TOOLSETS` group is a real `allTools`
  name; union of all groups === all 25 names (guards against drift).
- order preserved: output follows `allTools` order.

### `test/linkTypeStyle.test.ts`
Mock the option-set reader (inject it or stub `dvReq`); use `resetLinkTypeStyleCache()`
between cases.
- env override `"eu"` set → returns `"eu"`, **never** calls the probe.
- env override `"global"` set → returns `"global"`, no probe.
- env unset, probe returns values `[192350000,…]` → `"global"`, cached (second
  call does not re-probe — assert probe called once).
- env unset, probe returns `[0,1,2,3]` → `"eu"`, cached.
- env unset, probe throws → returns `"global"` fallback, **not** cached (next call
  re-probes); a warning is logged.
- concurrency: two parallel first calls share one probe (assert single call via
  the `inflight` de-dupe).

### `test/config.test.ts` (or extend existing)
- `READ_ONLY_MODE` coercion: `"true"/"1"/"yes"/"on"` → true; `"false"/"0"/""/unset`
  → false; `"maybe"` → fail-fast throw.
- `DATAVERSE_LINK_TYPE_STYLE` now optional: unset boots OK; `"global"`/`"eu"` OK;
  `"xx"` → throw.
- `getEnabledTools()`/`getToolsets()` parse comma lists via `splitList` (trim,
  drop empties, unset→undefined).

## E2E / integration self-test

In `test/http.test.ts` (offline, `AUTH_MODE=insecure-passthrough`, supertest) —
mirrors the existing "lists tools over MCP" test:

- **READ_ONLY_MODE shrinks tools/list:** `setEnv({ AUTH_MODE:
  "insecure-passthrough", READ_ONLY_MODE: "true" })`; `tools/list` text **contains**
  `list_plans`/`whoami` and **does not contain** `add_tasks`, `start_change_session`,
  `delete_tasks_batch`, `update_tasks`. Optionally assert exactly 14 tools.
- **Write tool rejected in read-only mode:** call `tools/call` for
  `add_tasks` with `READ_ONLY_MODE=true`; assert an MCP error whose message matches
  /read-only mode/ (defense-in-depth path).
- **TOOLSETS subset:** `setEnv({ …, TOOLSETS: "reporting" })`; `tools/list`
  contains the 7 reporting names and excludes `whoami`/`describe_option_set`
  (those are in `discovery`, not `reporting`).
- **ENABLED_TOOLS subset:** `TOOLSETS`/`ENABLED_TOOLS=whoami,list_plans` →
  tools/list has exactly those two.
- **Fail-closed boot:** `setEnv({ …, TOOLSETS: "nope" })` then `freshApp()` →
  `expect(() => buildApp()).toThrow(/unknown toolset/)` (parallels the existing
  "config fails fast when TENANT_ID missing" test). Same for
  `ENABLED_TOOLS=bogus_tool`.
- **/healthz enrichment:** with `READ_ONLY_MODE=true`, GET `/healthz` →
  `{ ok:true, readOnly:true, toolCount:14 }`.

Live E2E (`test/e2e/`, only when the human runs it): add a phase using
`mcpToolNames(mcpUrl, bearer)` to assert the list shrinks under
`READ_ONLY_MODE=true` and a `TOOLSETS` subset. Reuse `mcpToolNames` — no new
client code. Keep this optional/flagged like the existing e2e phases.

---

## Shared-file touchpoints + conflict notes

These four+ files are touched by more than one of the three features and/or by
sibling planned work — coordinate to avoid merge conflicts.

- **`src/config.ts`** (SECURITY-CRITICAL): touched by F1 (`READ_ONLY_MODE` +
  getter), F2 (`ENABLED_TOOLS`, `TOOLSETS` + getters), F3 (make
  `DATAVERSE_LINK_TYPE_STYLE` optional). All edits are additive within the one
  `EnvSchema` object + new exported getters. **Conflict risk: high** (one schema
  object). Mitigation: land the three env additions in one coordinated commit, or
  sequence F1→F2→F3 on the same branch base and rebase. Preserve the existing
  `.superRefine`, `splitList`, fail-fast cache.
- **`src/server.ts`**: F1 (call-time read-only guard) + F2 (filtered registration
  loop) edit the **same** `buildServer()` loop. They must be implemented together
  (the guard needs `readOnlyNames` from `filterTools`). **Treat F1+F2 as one
  branch.** F3 does not touch server.ts.
- **`src/tools/index.ts`**: read-only here (the plan **reuses** `toolAnnotations`
  as the read-only source of truth and `allTools` for ordering). No edit planned
  unless a future tool is added — if a tool is added concurrently, update the
  `TOOLSETS` map and the map-integrity test will flag the gap.
- **`src/app.ts`**: F2 (boot-time `filterTools` fail-closed call + optional
  `/healthz` enrichment). Low conflict.
- **`src/tools/addTasksSimple.ts`** / **`describeOptionSet.ts`**: F3 only. Note the
  sibling TODO item "describe_option_set auto-detect" IS this feature — ensure
  this plan supersedes it. The extracted `readLinkTypeOptionValues()` helper lives
  in/near `describeOptionSet.ts`; keep the tool's public output identical so no
  read test changes.
- **`README.md`** + **`SECURITY.md`**: env table + hardening sections — additive,
  low conflict.
- **`test/http.test.ts`**: F1+F2 add cases and `setEnv` keeps
  `DATAVERSE_LINK_TYPE_STYLE=global` (F3 override path) so existing tests stay
  offline/deterministic. Coordinate the `setEnv` signature if multiple branches
  extend it.

**Recommended branch split:**
- Branch A `feat/toolset-filtering` — F1 + F2 together (config + toolFilter.ts +
  server.ts + app.ts + tests + docs). They share `server.ts` and the filter
  function, so one branch.
- Branch B `feat/link-type-autodetect` — F3 (config optional + linkTypeStyle.ts +
  addTasksSimple + describeOptionSet helper + tests). Only the `src/config.ts`
  `EnvSchema` object overlaps Branch A — rebase B on A (or land A first) to absorb
  that one-line schema overlap.

---

## Guardrail check (nothing weakened)

- READ_ONLY_MODE and toolset filtering only **remove** tools from the surface and
  add a **pre**-handler rejection — they never bypass the `confirmed` delete gate,
  allow-lists, GUID checks, 200-cap, or summary protection. The call-time guard
  runs *before* a tool's own validation, so all existing guards still run for any
  tool that is exposed.
- Auto-detect changes only **which integer** the write path sends for a link type;
  it does not alter any entity/field allow-list, bind alias, ordering, or cap.
  `buildTaskEntities` stays pure and still receives `linkTypeValues` as an argument.
- No standing secret is introduced (Feature 3 explicitly avoids boot-time probing
  for this reason). No new runtime dependency. Zod validates the new env at the
  boundary; fail-fast preserved; unknown allowlist names fail closed at boot.
