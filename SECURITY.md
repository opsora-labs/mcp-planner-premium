# Security & Best-Practice Compliance — mcp-planner-premium

This document records the security posture of the `mcp-planner-premium` MCP server
against industry standards: the **Model Context Protocol security best
practices**, the **OWASP API Security Top 10 (2023)**, and general production /
container hardening guidance. Each control is marked **✅ Done**, **⚠️ Partial**,
**❌ Not done**, or **N/A**, with the implementation location or the reason.

- Reviewed: 2026-06 (multi-host repositioning + claim/code reconciliation).
- Component: remote, stateless Streamable-HTTP MCP server (Node 22 / TypeScript)
  that performs Microsoft Planner-Premium / Dataverse PSS writes in the
  signed-in user's **delegated** context.
- Deployment target: Azure Container Apps (public HTTPS ingress, scale-to-zero).

---

## 1. Authentication & authorization model (design decision)

The MCP host (e.g. an "Advanced OAuth" connector) performs the Microsoft
Entra OAuth flow and forwards the resulting **delegated Dataverse access token**
to this server, which relays it to Dataverse. The token's audience is Dataverse,
not this server — i.e. **token passthrough**, which the MCP spec discourages.

The interim mitigation is **defensive inbound-token validation** (§2.1) rather
than full resource-server semantics: (a) the server holds no long-lived secret
and acts purely as the user, and (b) Dataverse independently enforces the token's
audience. That was sufficient while the server ran behind a single private host.
**The server is now used from multiple MCP hosts**, so the token's audience not
being bound to this server is a real confused-deputy exposure — migrating to the
spec-compliant **resource server + On-Behalf-Of** design (§9) is the recommended
next step, not a deferred one.

---

## 2. MCP specification — security best practices

| # | Control | Status | Implementation / reason |
|---|---|---|---|
| 2.1 | Token audience validation / no blind passthrough | ⚠️ Partial | Inbound JWT is cryptographically validated (signature via Entra JWKS, `exp`/`nbf`, `iss`=tenant, `aud`=Dataverse org, optional `appid` pin) in [`src/auth.ts`](src/auth.ts), enforced in [`src/app.ts`](src/app.ts). Full resource-server audience binding (token minted *for this server*) is **not** done — deliberate; see §1 and roadmap §9. |
| 2.2 | Origin header validation / DNS-rebinding protection | ✅ Done | `enableDnsRebindingProtection` with `allowedHosts` on the Streamable-HTTP transport ([`src/app.ts`](src/app.ts)). The Host allow-list is **auto-derived from the Azure Container Apps FQDN at runtime** (`CONTAINER_APP_NAME` + `CONTAINER_APP_ENV_DNS_SUFFIX`), so protection is on by default in production with no deploy-time URL needed; `ALLOWED_HOSTS` adds custom domains. The SDK checks `Origin` only when the client sends one, so server-to-server clients are unaffected. |
| 2.3 | TLS for all transport | ✅ Done | Terminated by Azure Container Apps ingress (HTTPS only); HSTS header set via helmet. |
| 2.4 | No token logged or persisted | ✅ Done | pino `redact` censors `authorization`/`access_token`/`refresh_token` ([`src/logger.ts`](src/logger.ts)); request bodies are never logged. Verified in tests. |
| 2.5 | Rate limiting / DoS protection | ✅ Done | Per-IP rate limit on `/mcp` (`express-rate-limit`), 2 MB JSON body cap, request/header timeouts ([`src/app.ts`](src/app.ts), [`src/index.ts`](src/index.ts)). |
| 2.6 | Confused-deputy prevention | ⚠️ Partial | `appid`/`azp` pinning (`ENTRA_CLIENT_ID`) ensures the token came from an expected app; network ingress restriction is an operator control (§5.3). The single-`ENTRA_CLIENT_ID` pin covers one host app — with multiple hosts, either front them with one app registration or rely on OBO. Full prevention requires OBO (§9). |
| 2.7 | Tool input validation | ✅ Done | Zod schemas per tool + hand-written guardrails (allow-lists, GUID checks, 200-entity cap, bind-alias traps). |
| 2.8 | Least privilege | ✅ Done | Server holds no credentials; every call runs as the end user's delegated token. Tool scope is structural Planner writes only; reads/text edits are out of scope (routed to the generic Dataverse tool). |
| 2.9 | Tool annotations (read-only/destructive hints) | ✅ Done | `readOnlyHint`/`destructiveHint`/`idempotentHint`/`openWorldHint` per tool ([`src/tools/index.ts`](src/tools/index.ts)). Advisory only — not relied on for enforcement. |
| 2.10 | Human-in-the-loop for destructive ops | ✅ Done | `delete_tasks_batch` requires `confirmed=true`; whole-plan delete hard-blocked. Conversation-level approval lives in the host's orchestration skill (e.g. [`skills/guided-assistant.md`](skills/guided-assistant.md)). |

---

## 3. OWASP API Security Top 10 (2023)

| ID | Risk | Status | Notes |
|---|---|---|---|
| API1 | Broken Object Level Authorization | ✅ Done | Authorization is delegated to Dataverse, which enforces row/field security in the user's context. The server cannot escalate beyond the user. |
| API2 | Broken Authentication | ⚠️ Partial | Inbound JWT verified (§2.1). Residual: token-passthrough model (§1). |
| API3 | Broken Object Property Level Authorization | ✅ Done | Allow-listed `@odata.type`/fields; blocked-on-create and rolled-up-field guards; Dataverse enforces field security. |
| API4 | Unrestricted Resource Consumption | ✅ Done | Rate limit, body cap, outbound timeout, paginated reads with a hard page cap + `truncated` flag, optional `bucketId` narrowing. |
| API5 | Broken Function Level Authorization | ✅ Done | Only the registered tools are exposed (writes + read-only reporting reads scoped to Planner entities); no generic record CRUD or free-form query; destructive ops gated; read tools are annotated `readOnlyHint` and only issue GETs. |
| API6 | Unrestricted Access to Sensitive Business Flows | ⚠️ Partial | `confirmed` gate + change-session model + bulk caps in-code; conversation-flow controls (bulk-confirm, approvals) live in the host's orchestration skill (`skills/guided-assistant.md`), not the server. |
| API7 | Server-Side Request Forgery | ✅ Done | All outbound URLs are built from the env-fixed `DATAVERSE_ORG_URL` + fixed paths; no model input selects the host. GUIDs validated before entering URL paths. |
| API8 | Security Misconfiguration | ✅ Done | helmet security headers, `x-powered-by` disabled, fail-fast config validation, non-root container, secure defaults (`AUTH_MODE=validate`). |
| API9 | Improper Inventory Management | ✅ Done | This document + README enumerate every tool, env var and version; single documented `/mcp` endpoint. |
| API10 | Unsafe Consumption of APIs (Dataverse) | ✅ Done | Dataverse responses are validated (status + error shape); JSON parsed defensively; timeouts + bounded retry on reads. |

---

## 4. Injection & input handling

| Control | Status | Implementation / reason |
|---|---|---|
| SSRF (host injection) | ✅ Done | Org URL fixed by env; no model-controlled host ([`src/config.ts`](src/config.ts)). |
| OData filter injection | ✅ Done | `find_plan_by_name` doubles single quotes on the name before it enters `$filter` ([`src/tools/findPlan.ts`](src/tools/findPlan.ts)). `find_team_member` builds no name filter server-side — it filters the team by the validated `projectId` GUID and matches names in memory, so no user string reaches OData ([`src/tools/teamMemberSearch.ts`](src/tools/teamMemberSearch.ts)). |
| Path-segment injection (GUIDs) | ✅ Done | Canonical `GUID_RE` enforced via `assertGuid` before any id enters a URL path or session call ([`src/dataverse.ts`](src/dataverse.ts) + all session/read tools). |
| Prototype pollution | ✅ Done | `Object.prototype.hasOwnProperty.call` used throughout; parsed payloads are forwarded to Dataverse, never merged into local config; `JSON.parse` used without a reviver. |
| Oversized payloads | ✅ Done | 2 MB JSON cap; 200-entity batch cap. |
| Prompt injection via Dataverse content | ✅ Done (by design) | Plan content is treated as DATA, never instructions. Enforced at the orchestration (skill) layer; the server never executes content. |

---

## 5. Secrets, tokens & network

| Control | Status | Implementation / reason |
|---|---|---|
| 5.1 No hardcoded secrets in this server | ✅ Done | The server stores no long-lived secret; it only relays the per-request user token. Config from env. |
| 5.2 Token redaction in logs | ✅ Done | pino `redact` ([`src/logger.ts`](src/logger.ts)); verified by test output. |
| 5.3 Ingress restriction to known caller | ❌ Not done (operator action) | Recommended: restrict the Azure Container Apps ingress to the egress IP range(s) of the MCP host(s), or use internal ingress for a dedicated deployment. More important now that multiple hosts connect (§1). This is an Azure deployment-time control, not code. Documented in README. |
| 5.4 No secrets committed to the repo | ✅ Done | No credentials, tenant ids or org URLs in source - only example placeholders (`contoso`, all-zero GUIDs). `.env` and build artifacts are gitignored. |
| 5.5 Read-only and scoped-toolset deployment | ✅ Done | `READ_ONLY_MODE=true` filters the server to the read-only tools (22 of 32 total, including `list_custom_columns`/`describe_columns`) at registration time and adds a call-time hard-reject for any write/session tool call — a reporting-only instance cannot write to Planner regardless of the bearer token's permissions. `ENABLED_TOOLS` and `TOOLSETS` provide an explicit allowlist and named-group allowlist respectively. All three controls are AND-ed; the classification derives from `readOnlyHint` in `src/tools/index.ts` (single source of truth). Unknown names/groups fail closed at boot — a misconfigured allowlist crashes the container rather than silently exposing nothing or everything. `/healthz` reports `readOnly` and `toolCount` for operator verification without an MCP handshake. |
| 5.6 Custom Dataverse column metadata privilege | ✅ Done | Discovering/reading/writing custom (non-`msdyn_`) columns (`CUSTOM_COLUMNS_MODE!=off`, §11) requires only `prvReadEntity`/`prvReadAttribute` on entity/attribute metadata — a read privilege normally held by any user who can read the record at all, so no elevated grant is needed. If the tenant locks this down and the metadata read 403s, custom-column writes fail closed with an actionable error (§11); standard `msdyn_` fields are entirely unaffected either way. |

---

## 6. Reliability & availability

| Control | Status | Implementation |
|---|---|---|
| Graceful shutdown (SIGTERM drain) | ✅ Done | In-app SIGTERM/SIGINT handler drains the HTTP server with an 8 s hard-exit safety net; `/healthz` returns 503 while draining ([`src/index.ts`](src/index.ts), [`src/app.ts`](src/app.ts)). |
| Outbound call timeout | ✅ Done | `AbortSignal.timeout(REQUEST_TIMEOUT_MS)` on every Dataverse `fetch` ([`src/dataverse.ts`](src/dataverse.ts)). |
| Retry on transient failures | ✅ Done (reads only) | Bounded, `Retry-After`-aware retry on 429/5xx for idempotent **reads**; writes (`PssCreate/Update/Delete`) are intentionally **not** retried to avoid duplicate side effects. |
| Fail-fast configuration | ✅ Done | zod env schema validated at boot ([`src/config.ts`](src/config.ts)). |
| Health/readiness probe | ✅ Done | Dependency-free `/healthz`, 503 while draining. |
| Slowloris/request timeouts | ✅ Done | `requestTimeout`/`headersTimeout` set on the HTTP server. |

---

## 7. Container & supply chain

| Control | Status | Implementation |
|---|---|---|
| Non-root container | ✅ Done | `USER node` in the runtime stage ([`Dockerfile`](Dockerfile)). |
| Reproducible install | ✅ Done | `npm ci` against committed `package-lock.json`. |
| Minimal/maintained base image | ✅ Done | `node:22-slim` (Node 22 LTS). |
| Multi-stage build (no dev deps in runtime) | ✅ Done | `--omit=dev` runtime stage; build artifacts copied with `--chown=node:node`. |
| Production dependency vulnerabilities | ✅ Done | `npm audit --omit=dev` → 0 vulnerabilities. (Dev-only toolchain advisories exist and do not ship.) |
| Signal handling for PID 1 | ⚠️ Partial | Explicit in-app SIGTERM handler works as PID 1; an init shim (`--init`) for zombie reaping is recommended at the orchestrator and noted in the Dockerfile. |

---

## 8. Observability

| Control | Status | Implementation |
|---|---|---|
| Structured logging | ✅ Done | pino + pino-http ([`src/logger.ts`](src/logger.ts)). |
| Request correlation id | ✅ Done | `x-request-id` generated per request and returned in the response header. |
| Secret-safe logs | ✅ Done | Redaction (§5.2); bodies never logged. |
| Metrics | ❌ Not done | No Prometheus/OTel metrics yet. Reason: not required for current scale; request logs + ACA platform metrics suffice. Roadmap if traffic grows. |

---

## 9. Known accepted risks & roadmap

| Item | Status | Plan |
|---|---|---|
| Token passthrough (audience = Dataverse, not this server) | **Recommended next step** (multi-host) | Migrate to OAuth **resource server + On-Behalf-Of**: expose an API scope on a dedicated Entra app, validate tokens minted *for this server*, then OBO-exchange for a Dataverse token. Closes confused-deputy fully. **Trigger has fired** — the server is now used from multiple MCP hosts (§1), so this is no longer deferred. |
| Ingress IP restriction | Operator action | Apply Azure Container Apps ingress allow-list (the connecting hosts' egress ranges) at deploy time (§5.3). |
| `outputSchema` per tool | Deferred | `structuredContent` is returned for all tools; strict per-tool `outputSchema` is deferred because several tools passthrough dynamic Dataverse response bodies that don't fit a fixed schema. Low risk. |
| Cursor pagination on `get_plan_tasks_and_buckets` | Partial | Added `bucketId` filter + page cap + `truncated`; full cursor pagination deferred until needed. |
| Metrics/tracing | Deferred | See §8. |

---

## 11. Custom Dataverse columns (`CUSTOM_COLUMNS_MODE`)

Custom (customer-added, non-`msdyn_`) Dataverse columns are an **opt-in**
capability, default `off` (§5.5 note; see [`README.md`](README.md#custom-dataverse-columns)
for the full feature description). Its security model:

| Control | Status | Implementation / reason |
|---|---|---|
| Off by default, fully additive | ✅ Done | `CUSTOM_COLUMNS_MODE=off` (default) means `customFields`/`includeCustomColumns` inputs are ignored and no existing tool's behaviour or output changes at all ([`src/config.ts`](src/config.ts)). |
| Metadata read privilege | ✅ Done | Only `prvReadEntity`/`prvReadAttribute` is required (§5.6) — a privilege normally implied by read access to the record itself. No elevated grant. |
| **Prefix discipline (the custom-column gate)** | ✅ Done | A column enters the custom-column codec path **only if its logical name does not start with `msdyn_`** (`isCustomColumnName` in [`src/dataverse/metadata.ts`](src/dataverse/metadata.ts)). This was **deliberately not** gated on the Dataverse `IsCustomAttribute` flag — live probing showed nearly every standard `msdyn_` field on this tenant reports `IsCustomAttribute:true`, which would have made that flag admit almost the entire standard schema as "custom" and defeat the guardrail. Prefix discipline means the custom-column channel can **never** be used to reach a standard `msdyn_` field, so it cannot bypass the existing allow-list, blocked-on-create list, or summary-task protection — those guards keep operating on `msdyn_` fields exactly as before, completely independent of this feature. |
| `customFields` never a bypass | ✅ Done | Any `msdyn_*` key inside `customFields` is rejected outright with a message pointing at the tool's proper named parameter ([`spliceCustomFields`](src/tools/addTasksSimple.ts)); it is never silently routed to a standard field. |
| GUIDs validated before entering a URL fragment | ✅ Done | Lookup/customer/owner writes run the caller-supplied id through `assertGuid` (`src/dataverse.ts`) before it is placed into the `<NavProperty>@odata.bind` → `/entityset(guid)` fragment ([`src/dataverse/columnTypes.ts`](src/dataverse/columnTypes.ts)) — same rule as every other model-supplied GUID in this server. |
| Nav-property (not logical name) resolved from metadata, never guessed | ✅ Done | The `@odata.bind` key for a lookup column is resolved from `ManyToOneRelationships` metadata (`ReferencingEntityNavigationPropertyName`), never hand-typed or derived by casing convention — closing the same nav-property casing trap already documented for standard fields (`docs/PSS-IMPLEMENTATION-LESSONS.md`). |
| Raw-batch guardrail strengthening | ✅ Done | When `CUSTOM_COLUMNS_MODE!=off`, `add_tasks_batch`/`update_tasks_batch` validate every non-`msdyn_` key in a raw entity against metadata (writable, not computed, correct nav-bind key) and reject with a teachable error — turning a silent/cryptic PSS failure into a precise one ([`src/tools/customColumnsGuard.ts`](src/tools/customColumnsGuard.ts)). This check runs strictly **after** (in addition to, never instead of) the existing synchronous `validateAddEntities`/`validateUpdateEntities`, so the allow-list, blocked-on-create fields, bind-alias teaching, summary-task protection, and the 200-entity cap all still fire unchanged, with or without custom keys present. |
| Fail-closed, never a silent drop | ✅ Done | If metadata can't be read (403/error) while `CUSTOM_COLUMNS_MODE=metadata`, the write of a custom column fails closed with an actionable message (ask for `prvReadAttribute`, or use `CUSTOM_COLUMNS_ALLOWLIST`); a column that resolves but is computed/read-only/unsupported-type is rejected with a specific reason, never silently dropped from the payload. Reads degrade gracefully instead (core fields only, with a warning) since a read producing less data is safe, but a write silently dropping a field is not. |
| `create_plan`'s `customFields` — unverified live | ⚠️ Documented gap | This server's probe tenant has no real custom columns, so whether `msdyn_CreateProjectV1` accepts custom fields in its `Project` body on create is unproven. The path is implemented, gated identically to `add_tasks`/`update_tasks`, and fails closed the same way; if PSS itself rejects it live, the documented remedy is to set the field afterwards via `update_tasks_batch` on `msdyn_project` (already-permitted per §API3/API5). |

---

## 12. Test coverage of security controls

| Control | Test |
|---|---|
| JWT validation (valid / expired / wrong audience / wrong app / garbage / `azp`) | [`test/auth.test.ts`](test/auth.test.ts) |
| Missing/invalid token → 401 with `WWW-Authenticate` | [`test/http.test.ts`](test/http.test.ts) |
| Fail-fast config (validate mode without `TENANT_ID`) | [`test/http.test.ts`](test/http.test.ts) |
| 405 on GET/DELETE `/mcp`, health, `tools/list` | [`test/http.test.ts`](test/http.test.ts) |
| Guardrails (allow-lists, GUID, bind aliases, summary protection, delete confirm, 200-cap) | [`test/guardrails.test.ts`](test/guardrails.test.ts), [`test/buildTasks.test.ts`](test/buildTasks.test.ts), [`test/buildUpdate.test.ts`](test/buildUpdate.test.ts) |
| Custom-column prefix discipline, codec correctness, fail-closed metadata degrade | [`test/columnTypes.test.ts`](test/columnTypes.test.ts), [`test/metadataCache.test.ts`](test/metadataCache.test.ts), [`test/customFieldsBuild.test.ts`](test/customFieldsBuild.test.ts) |
| Raw-batch custom-column guardrail (reject computed/wrong-lookup-key, accept valid scalar, summary-task + 200-cap still fire with custom keys present) | [`test/customColumnsGuard.test.ts`](test/customColumnsGuard.test.ts) |

Run: `npm test` (see the count in the latest local run — grows as coverage is added; currently 600+ tests, no network required).
