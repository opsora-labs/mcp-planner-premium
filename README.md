# mcp-planner-premium

A self-hosted **MCP server** that exposes Microsoft Planner Premium structural
writes (via the Dataverse PSS V2 APIs) as MCP tools, running in the signed-in
user's **delegated** context.

It can be used from any MCP host. Every PSS
guardrail is enforced server-side: entity allow-lists, blocked-on-create fields,
bind-alias traps, dependency link-type validation, parents-before-children
ordering, duplicate-GUID detection, the 200-entity cap, summary-task protection,
the delete `confirmed` gate + whole-plan-delete block, and paginated reads.

> All identifiers below (org URLs, tenant/client ids, GUIDs) are **examples**
> (`contoso`, all-zero GUIDs). Replace them with your own values.

## Why an MCP server

- **Portable** - the same server works in Claude, Cursor, or any MCP host,
  instead of being locked to a single host integration.
- **Real source, real tests, real logging** - no snippet size limits or sandbox
  constraints; guardrails live in `src/tools/*` with unit tests in `test/`.

## Architecture

```
MCP host (OAuth client)
   1. OAuth against Entra (delegated, your app + scopes)
   2. POST /mcp  with header:  Authorization: Bearer <delegated token>
        |
        v
this server (stateless, streamable HTTP)
   - 32 tools (incl. whoami diagnostic)
   - validates then forwards the inbound bearer to Dataverse
        |
        v
Dataverse Web API (msdyn_CreateProjectV1, msdyn_*OperationSet*V1,
                   msdyn_PssCreateV2 / PssUpdateV2 / PssDeleteV2, WhoAmI)
```

**Auth model: token passthrough with inbound validation.** The MCP host performs
the Entra OAuth flow and injects the resulting **delegated Dataverse access token**
into the `Authorization` header. The server
verifies that token (`AUTH_MODE=validate`, the default — see [SECURITY.md](./SECURITY.md))
and forwards it to Dataverse. No Entra app changes; per-user delegated context
preserved.

> The token's audience is Dataverse, not this server, so the server does **not**
> validate it as its own OAuth resource. That is deliberate for a private,
> single-consumer deployment. For use from arbitrary MCP hosts, switch to a
> standards-compliant OAuth resource server + Entra On-Behalf-Of (roadmap in
> [SECURITY.md](./SECURITY.md)).

## Read tools

The read tools (`list_plans`, `list_my_tasks`, `get_plan_summary`,
`get_plan_tasks_and_buckets`, `get_task`, `list_plan_tasks`, `search_plan_tasks`,
`get_bucket_breakdown`, `list_dependencies`, `list_team_members`) cover Planner-Premium reporting and
exploration in the same delegated context as the write tools — **one connection,
one token, one allow-listed surface**. `list_my_tasks` resolves "me" via `whoami`
(→ the user's bookable resource) so the caller never passes a user id.

> **Verification independence.** Read and write tools share this server's code
> and token. For *confirming a write you just made*, prefer an independent path
> (e.g. a direct OData call or a separately connected Dataverse tool) so a shared
> bug can't make a failed write look verified. Paginating reads carry a `truncated`
> flag — never treat a truncated result as complete.

## Safety layering

This server is the **mechanical floor**, not the orchestration layer. Conversation-level
safety — propose/approve dialogues, date disambiguation, GUID disambiguation
menus, prompt-injection defence, sequential apply — belongs in the AI skill or
system prompt of the host and cannot live in a single-shot tool call.

What the server enforces itself: hard guardrails (entity allow-lists, bind-alias
traps, summary-task protection, 200-item cap, `confirmed` delete gate, whole-plan
block, pagination) plus a distilled set of non-negotiable invariants returned in
the MCP `instructions` field on every `initialize` (`src/server.ts`). That floor
means the server is not dangerous even when used from a host with no skill loaded.

## Tools

| Tool (MCP name) | Description |
|---|---|
| `create_plan` | Create a new plan (optional `customFields` — see [Custom Dataverse columns](#custom-dataverse-columns), unverified live) |
| `add_bucket` | Add a bucket to a plan |
| `add_sprint` | Add a sprint (name + start + finish) to a plan |
| `start_change_session` | Open a change session; returns `operationSetId` |
| `add_tasks` | Add tasks (+ checklist, sprint, labels, assignees, optional `customFields`) — ergonomic, **preferred** |
| `add_tasks_batch` | Add tasks — raw OData, advanced escape hatch |
| `update_tasks` | Update tasks (optional `customFields`) — ergonomic, **preferred** |
| `update_tasks_batch` | Update tasks — raw OData, advanced escape hatch |
| `delete_tasks_batch` | Delete tasks, dependencies, buckets, or assignments |
| `apply_changes` | Commit a change session |
| `check_change_session_status` | Poll a session (or list open sessions) |
| `cancel_change_session` | Abandon a change session |
| `find_plan_by_name` | Resolve a plan by name |
| `find_team_member` | Resolve a team member by name **and/or email/UPN** for one plan — matches the resolved identity (full name/email), not just the team-row label; returns `bookableResourceId` + UPN/email/full name |
| `find_team_member_across_plans` | Find a person by name **and/or email/UPN** across **all** plans at once; matches resolved identity; groups by person with UPN/email and the plans they're on — read |
| `get_plan_tasks_and_buckets` | Full task + bucket list with `summaryTaskIds` |
| `whoami` | Diagnostic: confirms signed-in user and token |
| `list_plans` | Recent plans (name, dates, progress, effort) — read |
| `list_my_tasks` | The signed-in user's tasks across plans (`all`/`overdue`/`active`, optional `bucketId` scope) — read |
| `list_user_tasks` | A **specific** person's tasks (by `bookableResourceId`) across plans (`all`/`overdue`/`active`, optional `bucketId` scope) — read |
| `get_plan_summary` | Plan rollup: dates, %, effort, task/milestone/overdue counts — read |
| `get_task` | One task in full + dependency links + assignments — read |
| `list_plan_tasks` | Filtered task list (`all` / `overdue` / `milestones`, optional bucket) — read |
| `search_plan_tasks` | Find tasks whose title/notes **contain** given text (server-side `contains()`); `query` accepts one string or an array of terms (OR), and is optional when combined with property filters: `bucketId` / `sprintId` / `parentTaskId`, `isMilestone`, `priority`/`progress`/`effort` ranges, and `start`/`finish` (+actuals) date windows — all AND-composed server-side. `projectId` is optional: **omit it to search across all plans** (results carry `projectId`/`projectName`) — read |
| `get_bucket_breakdown` | Per-bucket task count + avg progress — read |
| `list_dependencies` | All predecessor→successor links (type + lag) — read |
| `list_team_members` | All plan team members, each with `bookableResourceId` + UPN/email/full name — read |
| `describe_option_set` | Choice-column values + labels (e.g. link types, status) — read |
| `list_custom_columns` | Discover customer-added (non-`msdyn_`) columns on a plan or task, via live metadata — read, opt-in (see [Custom Dataverse columns](#custom-dataverse-columns)) |
| `describe_columns` | Deep detail (type, option list, date format, lookup nav/targets) for named custom columns — read, opt-in |
| `get_critical_path` | Critical-path chain with per-task total float (slack) in working days — read |
| `get_schedule_health` | Schedule-risk rollup: overdue, at-risk, blocked, milestones, slipping summaries — read |
| `get_resource_workload` | Per-team-member assigned-task count, effort hours, and overdue count — read |
| `assign_task` | Assign or unassign a project-team member on an existing task (requires `confirmed=true` to unassign) — destructive |

## Ergonomic vs. raw task creation

`add_tasks` lets the model send a plain task list; the server generates GUIDs,
resolves bucket names, orders parents-before-children, maps FS/SS/FF/SF link
types and builds every `@odata.bind`. This cuts tokens and removes a whole class
of model errors (wrong bind keys, GUID collisions, bad option-set numbers). It
also carries `checklist`, `sprint`, `labels` (assign existing) and `assignees`
(project-team members). The raw `add_tasks_batch` stays for the long tail
(custom fields and entity types `add_tasks` does not model).

```jsonc
// add_tasks — what the model writes:
{
  "operationSetId": "<guid>",
  "projectId": "<guid>",
  "tasks": [
    { "ref": "design", "subject": "Design API", "bucket": "Sprint 1",
      "start": "2026-07-01", "finish": "2026-07-05", "effortHours": 16 },
    { "ref": "build", "subject": "Build API", "bucket": "Sprint 1",
      "parent": "design", "dependsOn": [{ "on": "design", "type": "FS" }] }
  ]
}
```

The server expands that into the full `msdyn_PssCreateV2` `EntityCollection`
(`@odata.type`, `msdyn_project@odata.bind`, `msdyn_projectbucket@odata.bind`,
client GUIDs, `msdyn_parenttask@odata.bind`, a `msdyn_projecttaskdependency`
with the correct `msdyn_projecttaskdependencylinktype` integer for your tenant,
resolved from `DATAVERSE_LINK_TYPE_STYLE`, …) and returns
`taskRefs` (`ref -> created taskId`) plus `milestoneTaskIds` for the follow-up
milestone update. The mapping logic is the pure, unit-tested `buildTaskEntities`
in `src/tools/addTasksSimple.ts`; the built collection is re-checked by the same
`validateAddEntities` guardrails before it is sent.

The same approach is applied wherever the model was writing raw OData:

- **`update_tasks`** — `[{ taskId, subject?, start?, finish?, effortHours?,
  progressPercent?, milestone?, priority?, description? }]`. The server emits only
  the changed fields and converts `progressPercent` (0-100) to `msdyn_progress`
  (0-1). Summary-task protection still runs via `validateUpdateEntities`
  (pass `summaryTaskIds`). `update_tasks_batch` remains for raw field control.
- **`delete_tasks_batch`** now also accepts a `taskIds` array (expanded to
  `msdyn_projecttask` deletes) for the common case; `records` stays for
  dependencies/buckets/assignments. The `confirmed` gate is unchanged.

The other 9 tools already take plain scalars, so they need no wrapper.

## Custom Dataverse columns

Customers on full Project Plan 3/5 licenses often add **custom columns**
(publisher-prefixed, e.g. `new_riskscore`, `contoso_category`) to the plan
(`msdyn_project`) or task (`msdyn_projecttask`) entity. This server can read
and write them, entirely **opt-in** and off by default:

- Set `CUSTOM_COLUMNS_MODE=metadata` (or `metadata+allowlist`, see
  [Configuration](#configuration)) to turn the feature on. With the default
  `off`, `customFields`/`includeCustomColumns` are ignored and every existing
  tool signature and output is byte-for-byte unchanged.
- **Discover first.** Call `list_custom_columns` (`entity: "project"` or
  `"task"`) to see what's actually on your tenant — logical name, normalized
  type, whether it's writable, option-set labels, lookup targets. Use
  `describe_columns` for deep detail on specific columns.
- **Read.** Pass `includeCustomColumns: true` (or an array of specific logical
  names) to `get_task`, `list_plan_tasks`, or `get_plan_summary`. Values come
  back label-shaped (`{ value, label }` for choices, `{ id, logicalName, name }`
  for lookups) under a `customFields` object, degrading gracefully to core
  fields only if metadata can't be read or a column was renamed/removed.
- **Write.** Pass `customFields: { "new_riskscore": 7, "new_category": "High" }`
  to `add_tasks`, `update_tasks`, or `create_plan`. Values are label-friendly:
  a picklist accepts its label or integer value; a lookup accepts a bare GUID
  (when the column has a single target) or `{ target, id }`. The server
  resolves each key's type from live Dataverse metadata and serializes it
  correctly (including the `<NavProperty>@odata.bind` form lookups require —
  never the logical name). Any key starting with `msdyn_` is rejected — that
  channel is for customer-added columns only, never a way around the standard
  named parameters or their guardrails (summary-task protection, blocked-on-create
  fields, the 200-entity cap all still apply to the same batch).
- **`create_plan`'s `customFields` is unverified against a live tenant** — this
  server's test tenant has no real custom columns, so whether
  `msdyn_CreateProjectV1` accepts custom columns on create is unproven. It is
  implemented and gated the same way as `add_tasks`/`update_tasks`, and fails
  closed with a clear error if metadata can't be resolved; if PSS itself
  rejects a custom field on plan create, set it afterwards via
  `update_tasks_batch` (`@odata.type: Microsoft.Dynamics.CRM.msdyn_project`).
- **Fail-closed, not silent.** If metadata can't be read (missing privilege,
  tenant lockdown) or a column can't be resolved/serialized, the write is
  rejected with a specific, actionable error — never a silent drop or partial
  write.
- The raw `add_tasks_batch`/`update_tasks_batch` tools get the same protection:
  when `CUSTOM_COLUMNS_MODE!=off`, any non-`msdyn_` key in a raw entity is
  validated against metadata (writable, not computed, correct nav-property
  bind key for lookups) and rejected with a teachable error instead of being
  passed through to PSS unchecked — a strengthening of the existing allow-list,
  not a new bypass.

## Configuration

Validated once at boot with a zod schema (fail-fast — a bad value crashes the
container loudly instead of failing per-request).

| Env var | Required | Default | Example / notes |
|---|---|---|---|
| `DATAVERSE_ORG_URL` | yes | — | `https://contoso.crm.dynamics.com` |
| `DATAVERSE_LINK_TYPE_STYLE` | yes | — | `global` for standard tenants (FS=192350000 …); `eu` for EU/CRM4 tenants (FS=1, SS=3, FF=0, SF=2). Run `describe_option_set` on `msdyn_projecttaskdependency` / `msdyn_projecttaskdependencylinktype` to find your value: if FinishToStart has value `1`, use `eu`; if it has value `192350000`, use `global`. The server will not start without this set. |
| `TENANT_ID` | yes when `AUTH_MODE=validate` | — | Entra tenant GUID, e.g. `00000000-0000-0000-0000-000000000000` |
| `AUTH_MODE` | no | `validate` | `validate` = verify inbound JWT; `insecure-passthrough` = skip (LOCAL DEV ONLY) |
| `ENTRA_CLIENT_ID` | no (recommended) | — | Client ID of the Entra app registration your MCP host uses for OAuth — the same value you enter in the host's "Client ID" field. When set, the server rejects any token not issued to this app. |
| `ALLOWED_HOSTS` | no | — | Extra Host(s) to allow (e.g. a custom domain). The Azure Container Apps FQDN is **auto-derived** at runtime, so you do not set it here. DNS-rebinding protection turns on automatically once a host is known. |
| `ALLOWED_ORIGINS` | no | — | Comma list of allowed `Origin` headers (only checked when the client sends one) |
| `PORT` | no | `3000` | Port the container listens on (plain HTTP). TLS is terminated by the cloud ingress (ACA / reverse proxy), not by this server. |
| `REQUEST_TIMEOUT_MS` | no | `30000` | Outbound Dataverse call timeout |
| `RATE_LIMIT_PER_MIN` | no | `120` | Per-IP requests/min on `/mcp` |
| `JSON_BODY_LIMIT` | no | `2mb` | Max request body |
| `LOG_LEVEL` | no | `info` | pino level |
| `READ_ONLY_MODE` | no | `false` | When `true`, exposes only the read-only tools (`readOnlyHint:true` in `src/tools/index.ts`, including `list_custom_columns`/`describe_columns`) and hard-rejects any write/session tool call. Useful for a reporting-only deployment. Accepts `true/1/yes/on` (case-insensitive); invalid values crash at boot. |
| `ENABLED_TOOLS` | no | — | Comma-separated allowlist of exact tool names. When set, only those tools are exposed. Unknown names crash at boot (fail-closed). |
| `TOOLSETS` | no | — | Comma-separated list of named tool groups to expose: `reporting` (list views), `discovery` (lookup/identity), `sessions` (change-session lifecycle), `write` (structural writes), `analytics` (schedule and resource insights — overlaps `reporting`). Union of all selected groups is taken. Unknown group names crash at boot (fail-closed). All three controls are AND-ed: a tool must pass READ_ONLY_MODE, ENABLED_TOOLS, and TOOLSETS to be registered. |
| `CUSTOM_COLUMNS_MODE` | no | `off` | `off` = custom-column read/discovery/write disabled entirely (default, zero behaviour change). `metadata` = any non-`msdyn_` column discoverable via live Dataverse metadata is eligible for `customFields`/`includeCustomColumns`. `metadata+allowlist` = metadata-eligible AND present in `CUSTOM_COLUMNS_ALLOWLIST`. See [Custom Dataverse columns](#custom-dataverse-columns). |
| `CUSTOM_COLUMNS_ALLOWLIST` | no | — | Comma list of custom-column logical names, used only when `CUSTOM_COLUMNS_MODE=metadata+allowlist`, to further restrict which discovered columns are actually usable. |
| `CUSTOM_COLUMNS_METADATA_TTL_MS` | no | (none — cached for process lifetime) | Optional TTL for the custom-column metadata cache. Schema is normally stable within a deployment (same rationale as the capability cache); set this only if you're actively iterating on custom-column schema on a live server. |

**Deployment hardening note:** combine `READ_ONLY_MODE=true` (or `TOOLSETS=reporting,discovery,analytics`) with
network-ingress restrictions (see Deploy section) to run a safe reporting-only instance that cannot
write to Planner regardless of the bearer token's permissions. `/healthz` reports `readOnly` and
`toolCount` so you can verify the effective surface without an MCP handshake.

**Inbound token validation (`AUTH_MODE=validate`, the default):** before
forwarding the bearer to Dataverse, the server verifies its Entra signature
(JWKS), `exp`/`nbf`, issuer (your tenant), audience (your Dataverse org), and —
if `ENTRA_CLIENT_ID` is set — that the token was issued to your app. Forged,
expired, foreign-tenant or foreign-app tokens are rejected with `401` before any
Dataverse call. See [SECURITY.md](./SECURITY.md) for the full security posture.

## Run locally

```bash
npm install
npm run build
# Local dev: skip token validation. PORT defaults to 3000.
DATAVERSE_ORG_URL=https://contoso.crm.dynamics.com \
  DATAVERSE_LINK_TYPE_STYLE=global \
  AUTH_MODE=insecure-passthrough \
  npm start
# health check
curl localhost:3000/healthz
```

Point the [MCP Inspector](https://github.com/modelcontextprotocol/inspector) at
`http://localhost:3000/mcp` (transport: Streamable HTTP) and add an
`Authorization: Bearer <a-valid-delegated-Dataverse-token>` header to exercise
the tools. `npm test` runs the unit tests (no network needed).

## Deploy to Azure Container Apps

```bash
# build & push
az acr build -r <registry> -t mcp-planner-premium:1 .

# create the container app (external HTTPS ingress, scale to zero).
# No FQDN needed at create time: the app auto-derives its own host for
# DNS-rebinding protection from the variables ACA injects at runtime.
az containerapp create \
  -g <rg> -n mcp-planner-premium \
  --environment <aca-env> \
  --image <registry>.azurecr.io/mcp-planner-premium:1 \
  --target-port 3000 --ingress external \
  --min-replicas 0 --max-replicas 3 \
  --env-vars \
    DATAVERSE_ORG_URL=https://contoso.crm.dynamics.com \
    DATAVERSE_LINK_TYPE_STYLE=global \
    TENANT_ID=00000000-0000-0000-0000-000000000000 \
    ENTRA_CLIENT_ID=11111111-1111-1111-1111-111111111111

# Read the assigned URL afterwards (not needed for the app to protect itself):
az containerapp show -g <rg> -n mcp-planner-premium \
  --query properties.configuration.ingress.fqdn -o tsv

# Recommended: restrict ingress to your MCP host's egress IP range.
az containerapp ingress access-restriction set \
  -g <rg> -n mcp-planner-premium \
  --rule-name allow-host --ip-address <host-egress-cidr> --action Allow
```

The public URL's `/mcp` path is your MCP endpoint. If you later map a **custom
domain**, add it to `ALLOWED_HOSTS` (the auto-derived ACA host stays allowed too).

## Wire up an MCP host

This server works with any MCP host that supports remote servers with OAuth
(Claude, Cursor, MCP Inspector, and others).

### 1. Create a dedicated Entra app registration

In the [Azure Portal](https://portal.azure.com) → **App registrations → New registration**:

- **Name:** `Planner-Premium-MCP` (or similar)
- **Supported account types:** Single tenant
- **Redirect URI (Web):** your MCP host's OAuth callback URL — the host shows this exact URL when you configure the OAuth connector (copy it from there)

Then on the app:
- **Certificates & secrets → New client secret** — copy the value immediately
- **API permissions → Add a permission → APIs my organisation uses → `Dataverse`** → delegated `user_impersonation` → Grant admin consent

The app's **Application (client) ID** is what goes into the host's OAuth connector and into `ENTRA_CLIENT_ID` below.

### 2. Configure the MCP host

In your host's remote MCP / OAuth connector settings, provide:

- **Server URL**: `https://<container-app-fqdn>/mcp`
- **Client ID**: the Application (client) ID from the app registration above
- **Client Secret**: the secret you copied
- **Authorization URL**: `https://login.microsoftonline.com/<tenantId>/oauth2/v2.0/authorize`
- **Token URL**: `https://login.microsoftonline.com/<tenantId>/oauth2/v2.0/token`
- **Scopes**: `https://contoso.crm.dynamics.com/user_impersonation offline_access openid profile`
- **Token injection**: configure the host to forward the access token as `Authorization: Bearer <token>` on each MCP request (the exact setting name varies by host)

Set `ENTRA_CLIENT_ID` on the container app to the same client ID so the server pins
inbound tokens to this app and rejects anything else.

Run **Test connection** — it should list the 32 tools.
Smoke-test with `whoami`, then the full happy path: `find_plan_by_name` /
`create_plan` → `add_bucket` → `start_change_session` → `add_tasks` →
`apply_changes` → poll `check_change_session_status` until `192350003`
(Completed) → `get_plan_tasks_and_buckets`.

## End-to-end acceptance test

The e2e harness connects to the server **through the MCP protocol** (same path any MCP host uses), drives all 32 tools, and writes a markdown report.

```bash
# Minimum — read-only, boots a local server automatically:
DATAVERSE_ORG_URL=https://contoso.crm.dynamics.com \
E2E_ACCESS_TOKEN=<delegated-Dataverse-token>       \
npm run e2e

# Against a deployed server + full write lifecycle:
DATAVERSE_ORG_URL=https://contoso.crm.dynamics.com \
E2E_ACCESS_TOKEN=<delegated-Dataverse-token>       \
MCP_URL=https://<your-fqdn>/mcp                    \
E2E_ALLOW_WRITES=true                              \
npm run e2e

# + Agentic usability layer (requires an Anthropic API key):
... E2E_AGENTIC=true ANTHROPIC_API_KEY=sk-ant-... npm run e2e
```

The harness:
- **Phase 0 — Preflight:** confirms all 32 tools are advertised and the delegated token reaches Dataverse (`whoami`).
- **Phase 1 — Read sweep:** exercises all 8 read/reporting tools and asserts shapes and units (progressPercent 0-100 vs 0-1 fraction, truncated flags, degrade-to-warning arrays).
- **Phase 2 — Write lifecycle** (`E2E_ALLOW_WRITES=true`): create plan → bucket → open session → `add_tasks` with a 6-level tree + FS dependency → apply → poll until 192350003 → `get_plan_tasks_and_buckets` + independent OData cross-check → second session: `update_tasks` (rename + milestone) → apply → field-level OData verify → cleanup (tasks/buckets deleted, session cancelled).
- **Phase 3 — Guardrails:** 13 negative tests that must be *rejected* (bad bind alias, blocked-on-create fields, child-before-parent, >200 entities, delete without `confirmed`, whole-plan delete, dependency update, progress out-of-range, cycle detection, etc.).
- **Phase 4 — Agentic exploratory** (optional): a real `claude-opus-4-8` reads only the tool descriptions, builds a small plan autonomously, and **code verifies** the Dataverse result. Tests interface usability, not just correctness.

**Security:** `E2E_ACCESS_TOKEN` is held in memory only, redacted from all logs and the report, and never written to disk. Pass/fail is decided by code assertions, never by an AI-generated summary. The report is written to `reports/e2e-report-<UTC>.md` (gitignored — reports can contain real task names) and exits non-zero on any failure (CI-friendly).

> **Residue:** whole-plan deletion is blocked by the PSS API. Each write run leaves one clearly-named test plan (`ZZ-MCP-E2E-<UTC>`) — the report lists it and you remove it in the Planner UI.

## Repository layout

```
src/         server + one file per MCP tool (guardrails live here)
test/        unit tests (npm test) and the live e2e harness (test/e2e/)
scripts/     one-time/maintenance scripts (auth-login, token, e2e cleanup)
docs/        developer & operator documentation (see docs/README.md)
skills/      host-side prompts you give an MCP host that connects to this server
reports/     local acceptance/e2e report output (gitignored)
.claude/     Claude Code safety setup — hooks, slash commands, subagents
```

**Documentation** (all in [docs/](docs/)):
- [CLAUDE.md](./CLAUDE.md) — start here if you're changing the code (golden rules, guardrails).
- [SECURITY.md](./SECURITY.md) — security posture and compliance checklist.
- [docs/QUALITY-ASSURANCE.md](docs/QUALITY-ASSURANCE.md) — the QA strategy and test matrix.
- [docs/AUTONOMOUS-SETUP.md](docs/AUTONOMOUS-SETUP.md) — one-time setup for autonomous Claude Code sessions.
- [docs/PSS-IMPLEMENTATION-LESSONS.md](docs/PSS-IMPLEMENTATION-LESSONS.md) — the Dataverse/PSS field guide (read before adding a PSS feature).

**Host-side skills** ([skills/](skills/)) — prompts for the MCP host once it's connected to this server:
- [skills/guided-assistant.md](skills/guided-assistant.md) — a guided Planner Premium assistant for non-technical PMs.
- [skills/acceptance-test-runner.md](skills/acceptance-test-runner.md) — drive an interactive acceptance run through any MCP host.

## Open TODOs

Known gaps and planned improvements. Contributions welcome.

### Read tools

- ~~**`list_plan_tasks` — extended optional fields.**~~ *Done.* `remainingEffortHours`, `durationHours`, `actualStart`, `actualFinish` are now returned when the tenant exposes them (Project Operations). The same try-with-fallback pattern as `get_task` is used, gated by the schema capability cache so the fallback round-trip is paid at most once per process lifetime.

- ~~**`list_dependencies` — environment availability.**~~ *Resolved.* The earlier 404 was a wrong entity-set name: the read tools queried `msdyn_projecttaskdependency` (singular) and `msdyn_linklagduration`, neither of which exists. Fixed to the plural set `msdyn_projecttaskdependencies` and the real lag column `msdyn_projecttaskdependencylinklag` (in `list_dependencies` and `get_task`). The 404 graceful-degrade path is kept for genuinely unsupported tenants.

- **`describe_option_set` — link-type value range varies by tenant.** The server's hard-coded `LINK_TYPE_VALUES` uses the 192350000-range (standard tenants) or 0-3 (EU/CRM4, controlled by `DATAVERSE_LINK_TYPE_STYLE`). Consider resolving the correct values at runtime via `describe_option_set` at boot rather than requiring an env var.

### Write tools

- ~~**`delete_tasks_batch` — dependency entities must be deleted separately.**~~ *Done.* When `projectId` is supplied, `delete_tasks_batch` now auto-fetches all `msdyn_projecttaskdependency` rows referencing the to-be-deleted tasks and prepends those deletes automatically. Callers no longer need to track dependency GUIDs. Auto-fetched dependencies count toward the 200-entity cap. If the dependency fetch fails (e.g. unsupported tenant), the tool degrades gracefully and falls back to the caller-supplied `records` with a warning.

- **Task reparenting.** `update_tasks` supports changing a task's parent (`msdyn_parenttask@odata.bind`). Pass `parent` as a task GUID (or ref) — the server emits `msdyn_parenttask@odata.bind` on update. Whether PSS honours the change live is confirmed by unit tests; e2e confirmation (verifying via independent OData) is still pending. Setting `parent: null` is not supported (PSS rejects null lookup binds) and is silently dropped with a warning.

- ~~**Sprint assignment.**~~ *Done.* `add_sprint` creates a sprint; `add_tasks` accepts `sprint` (name or sprintId) and sets the task's `msdyn_projectsprint` lookup. `update_tasks` also accepts `sprint` to move an existing task into a sprint.

- ~~**Resource assignments.**~~ *Done.* `add_tasks` accepts `assignees` (project-team member name or teamMemberId, resolved against `msdyn_projectteam`) and creates `msdyn_resourceassignment` rows. The new `assign_task` tool assigns or unassigns members on an existing task without re-creating it. `start`/`finish` are blocked on create (PSS derives them from the task).

- **Checklists** are supported via `add_tasks` `checklist`. **Labels**: `add_tasks` `labels` *assigns* existing plan labels, but label **creation** is UI-only — `msdyn_projectlabel` rejects both direct OData create ("edit through the Project UI") and PSS create. Unknown labels are skipped with a warning.

- **Milestone flag.** `msdyn_ismilestone` is engine-managed and rejected by PSS on both create and update (`ScheduleAPI-AV-0002`). No API path is currently known. Investigate whether a different Dataverse action exposes it; otherwise this remains UI-only.

- **Task comments — out of scope (Teams-backed).** Project/Planner Premium task comments are not stored in Dataverse: `msdyn_projecttaskconversation` holds only a Teams pointer (`msdyn_teamschannelid` + `msdyn_teamsconversationid`), with the comment text in Microsoft Teams. Reading/writing real comments would require a **Microsoft Graph** (Teams) integration with its own scopes and a second token, which breaks this server's single-token, Dataverse-only design. Dataverse Notes (`annotation`, `HasNotes: True` on tasks) are a possible *parallel* notes store, but they do not appear as comments in the Planner/Project UI.

### Infrastructure

- **`DATAVERSE_LINK_TYPE_STYLE` auto-detection.** Currently a required env var. A better UX would be to probe `describe_option_set` at startup (or lazily on first write) to detect the correct range for the tenant, removing the manual configuration step. Planned but not yet implemented.

- ~~**Schema capability cache.**~~ *Done.* The extended-field probe result (`msdyn_remainingeffort`, `msdyn_duration`, `msdyn_actualstart`, `msdyn_actualfinish`) is now cached in `src/tools/capabilities.ts` for the process lifetime. `get_task`, `list_plan_tasks`, and `get_resource_workload` all consult the cache before issuing requests, so the fallback round-trip is paid at most once per process on tenants that lack those fields.

## Security

This server holds **no long-lived secret of its own**; it only relays the
per-request user token (redacted from logs). Never hardcode the MCP host's API
key or the Entra client secret - keep them in your host/secret store. See
[SECURITY.md](./SECURITY.md) for the full posture and compliance checklist.
