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
   - 23 tools (incl. whoami diagnostic)
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

The 8 read tools (`list_plans`, `get_plan_summary`, `get_plan_tasks_and_buckets`,
`get_task`, `list_plan_tasks`, `get_bucket_breakdown`, `list_dependencies`,
`list_team_members`) cover Planner-Premium reporting and exploration in the same
delegated context as the write tools — **one connection, one token, one
allow-listed surface**.

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
| `create_plan` | Create a new plan |
| `add_bucket` | Add a bucket to a plan |
| `start_change_session` | Open a change session; returns `operationSetId` |
| `add_tasks` | Add tasks — ergonomic, **preferred** |
| `add_tasks_batch` | Add tasks — raw OData, advanced escape hatch |
| `update_tasks` | Update tasks — ergonomic, **preferred** |
| `update_tasks_batch` | Update tasks — raw OData, advanced escape hatch |
| `delete_tasks_batch` | Delete tasks, dependencies, buckets, or assignments |
| `apply_changes` | Commit a change session |
| `check_change_session_status` | Poll a session (or list open sessions) |
| `cancel_change_session` | Abandon a change session |
| `find_plan_by_name` | Resolve a plan by name |
| `find_team_member` | Resolve a team member by name |
| `get_plan_tasks_and_buckets` | Full task + bucket list with `summaryTaskIds` |
| `whoami` | Diagnostic: confirms signed-in user and token |
| `list_plans` | Recent plans (name, dates, progress, effort) — read |
| `get_plan_summary` | Plan rollup: dates, %, effort, task/milestone/overdue counts — read |
| `get_task` | One task in full + dependency links + assignments — read |
| `list_plan_tasks` | Filtered task list (`all` / `overdue` / `milestones`, optional bucket) — read |
| `get_bucket_breakdown` | Per-bucket task count + avg progress — read |
| `list_dependencies` | All predecessor→successor links (type + lag) — read |
| `list_team_members` | All plan team members — read |
| `describe_option_set` | Choice-column values + labels (e.g. link types, status) — read |

## Ergonomic vs. raw task creation

`add_tasks` lets the model send a plain task list; the server generates GUIDs,
resolves bucket names, orders parents-before-children, maps FS/SS/FF/SF link
types and builds every `@odata.bind`. This cuts tokens and removes a whole class
of model errors (wrong bind keys, GUID collisions, bad option-set numbers). The
raw `add_tasks_batch` stays for the long tail (resource assignments, checklists,
sprints, custom fields).

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

Run **Test connection** — it should list the 23 tools.
Smoke-test with `whoami`, then the full happy path: `find_plan_by_name` /
`create_plan` → `add_bucket` → `start_change_session` → `add_tasks` →
`apply_changes` → poll `check_change_session_status` until `192350003`
(Completed) → `get_plan_tasks_and_buckets`.

## End-to-end acceptance test

The e2e harness connects to the server **through the MCP protocol** (same path any MCP host uses), drives all 23 tools, and writes a markdown report.

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
- **Phase 0 — Preflight:** confirms all 23 tools are advertised and the delegated token reaches Dataverse (`whoami`).
- **Phase 1 — Read sweep:** exercises all 8 read/reporting tools and asserts shapes and units (progressPercent 0-100 vs 0-1 fraction, truncated flags, degrade-to-warning arrays).
- **Phase 2 — Write lifecycle** (`E2E_ALLOW_WRITES=true`): create plan → bucket → open session → `add_tasks` with a 6-level tree + FS dependency → apply → poll until 192350003 → `get_plan_tasks_and_buckets` + independent OData cross-check → second session: `update_tasks` (rename + milestone) → apply → field-level OData verify → cleanup (tasks/buckets deleted, session cancelled).
- **Phase 3 — Guardrails:** 13 negative tests that must be *rejected* (bad bind alias, blocked-on-create fields, child-before-parent, >200 entities, delete without `confirmed`, whole-plan delete, dependency update, progress out-of-range, cycle detection, etc.).
- **Phase 4 — Agentic exploratory** (optional): a real `claude-opus-4-8` reads only the tool descriptions, builds a small plan autonomously, and **code verifies** the Dataverse result. Tests interface usability, not just correctness.

**Security:** `E2E_ACCESS_TOKEN` is held in memory only, redacted from all logs and the report, and never written to disk. Pass/fail is decided by code assertions, never by an AI-generated summary. The report is written to `e2e-report-<UTC>.md` and exits non-zero on any failure (CI-friendly).

> **Residue:** whole-plan deletion is blocked by the PSS API. Each write run leaves one clearly-named test plan (`ZZ-MCP-E2E-<UTC>`) — the report lists it and you remove it in the Planner UI.

## Open TODOs

Known gaps and planned improvements. Contributions welcome.

### Read tools

- **`list_plan_tasks` — extended optional fields.** `remainingEffortHours`, `durationHours`, `actualStart`, `actualFinish` are absent from the list response. They exist only on Project Operations tenants (not basic Planner Premium) and require a try-with-fallback pattern on a paged collection query (the single-entity `get_task` already does this). Implement the same graceful degrade for `list_plan_tasks`.

- **`list_dependencies` — environment availability.** On some tenants `msdyn_projecttaskdependency` is not exposed (returns 404, degraded to empty list + warning). No known workaround; investigate whether a different query path surfaces the data.

- **`describe_option_set` — link-type value range varies by tenant.** The server's hard-coded `LINK_TYPE_VALUES` uses the 192350000-range (standard tenants) or 0-3 (EU/CRM4, controlled by `DATAVERSE_LINK_TYPE_STYLE`). Consider resolving the correct values at runtime via `describe_option_set` at boot rather than requiring an env var.

### Write tools

- **`delete_tasks_batch` — dependency entities must be deleted separately.** PSS rejects deletion of a task that still has a `msdyn_projecttaskdependency` entity referencing it (`E_INVALIDENTITYUID`). `add_tasks` now returns `dependencyIds` so callers can pass the dependency GUIDs in the `records` field of `delete_tasks_batch` before the task IDs. However, this is a caller-burden: if `dependencyIds` are lost or the caller forgets them, cleanup fails. Investigate whether PSS can auto-cascade dependency deletion when a task is deleted, or add an auto-fetch of dependency entities to `delete_tasks_batch` when `projectId` is provided (similar to the hierarchy fetch for leaves-first sorting) so the caller never has to track dependency IDs manually.

- **Task reparenting.** `update_tasks` does not support changing a task's parent (`msdyn_parenttask@odata.bind`). Whether PSS honours a parent change on update is unconfirmed live — needs an e2e test. If supported, add a `parent` field (ref or GUID) to `update_tasks`.

- **Sprint assignment.** Neither `add_tasks` nor `update_tasks` supports assigning a task to a sprint (`msdyn_projectsprint@odata.bind`). Accessible via the raw `add_tasks_batch` / `update_tasks_batch` escape hatches.

- **Resource assignments.** Creating or removing resource assignments (`msdyn_resourceassignment`) is not supported. These are separate entities that go through PSS create/delete; they could be added as a new tool or as an extension to `add_tasks`.

- **Milestone flag.** `msdyn_ismilestone` is engine-managed and rejected by PSS on both create and update (`ScheduleAPI-AV-0002`). No API path is currently known. Investigate whether a different Dataverse action exposes it; otherwise this remains UI-only.

### Infrastructure

- **`DATAVERSE_LINK_TYPE_STYLE` auto-detection.** Currently a required env var. A better UX would be to probe `describe_option_set` at startup, detect which range the tenant uses, and set the style automatically — removing the manual configuration step.

- **Schema capability cache.** `get_task` probes for extended fields (`msdyn_remainingeffort`, `msdyn_duration`, `msdyn_actualstart`, `msdyn_actualfinish`) on every call, wasting a round-trip on the retry when the tenant lacks them. Cache the result at server startup so subsequent calls skip the extended `$select` immediately on tenants that don't support it.

## Security

This server holds **no long-lived secret of its own**; it only relays the
per-request user token (redacted from logs). Never hardcode the MCP host's API
key or the Entra client secret - keep them in your host/secret store. See
[SECURITY.md](./SECURITY.md) for the full posture and compliance checklist.
