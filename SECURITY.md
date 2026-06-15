# Security & Best-Practice Compliance — mcp-planner-premium

This document records the security posture of the `mcp-planner-premium` MCP server
against industry standards: the **Model Context Protocol security best
practices**, the **OWASP API Security Top 10 (2023)**, and general production /
container hardening guidance. Each control is marked **✅ Done**, **⚠️ Partial**,
**❌ Not done**, or **N/A**, with the implementation location or the reason.

- Reviewed: 2026-06 (post multi-agent review + hardening).
- Component: remote, stateless Streamable-HTTP MCP server (Node 22 / TypeScript)
  that performs Microsoft Planner-Premium / Dataverse PSS writes in the
  signed-in user's **delegated** context.
- Deployment target: Azure Container Apps (public HTTPS ingress, scale-to-zero).

---

## 1. Authentication & authorization model (design decision)

The MCP client (Langdock's "Advanced OAuth" connector) performs the Microsoft
Entra OAuth flow and forwards the resulting **delegated Dataverse access token**
to this server, which relays it to Dataverse. The token's audience is Dataverse,
not this server — i.e. **token passthrough**, which the MCP spec discourages.

We mitigate this with **defensive inbound-token validation** rather than full
resource-server semantics, because (a) the server holds no long-lived secret and
acts purely as the user, (b) Dataverse independently enforces the token's
audience, and (c) the deployment is private (Langdock-only). The fully
spec-compliant alternative (resource server + On-Behalf-Of) is recorded as a
roadmap item in §9.

---

## 2. MCP specification — security best practices

| # | Control | Status | Implementation / reason |
|---|---|---|---|
| 2.1 | Token audience validation / no blind passthrough | ⚠️ Partial | Inbound JWT is cryptographically validated (signature via Entra JWKS, `exp`/`nbf`, `iss`=tenant, `aud`=Dataverse org, optional `appid` pin) in [`src/auth.ts`](src/auth.ts), enforced in [`src/app.ts`](src/app.ts). Full resource-server audience binding (token minted *for this server*) is **not** done — deliberate; see §1 and roadmap §9. |
| 2.2 | Origin header validation / DNS-rebinding protection | ✅ Done | `enableDnsRebindingProtection` with `allowedHosts` on the Streamable-HTTP transport ([`src/app.ts`](src/app.ts)). The Host allow-list is **auto-derived from the Azure Container Apps FQDN at runtime** (`CONTAINER_APP_NAME` + `CONTAINER_APP_ENV_DNS_SUFFIX`), so protection is on by default in production with no deploy-time URL needed; `ALLOWED_HOSTS` adds custom domains. The SDK checks `Origin` only when the client sends one, so server-to-server clients are unaffected. |
| 2.3 | TLS for all transport | ✅ Done | Terminated by Azure Container Apps ingress (HTTPS only); HSTS header set via helmet. |
| 2.4 | No token logged or persisted | ✅ Done | pino `redact` censors `authorization`/`access_token`/`refresh_token` ([`src/logger.ts`](src/logger.ts)); request bodies are never logged. Verified in tests. |
| 2.5 | Rate limiting / DoS protection | ✅ Done | Per-IP rate limit on `/mcp` (`express-rate-limit`), 2 MB JSON body cap, request/header timeouts ([`src/app.ts`](src/app.ts), [`src/index.ts`](src/index.ts)). |
| 2.6 | Confused-deputy prevention | ⚠️ Partial | `appid`/`azp` pinning (`MCP_CLIENT_ID`) ensures the token came from our app; network ingress restriction is an operator control (§5.3). Full prevention requires OBO (§9). |
| 2.7 | Tool input validation | ✅ Done | Zod schemas per tool + hand-written guardrails (allow-lists, GUID checks, 200-entity cap, bind-alias traps). |
| 2.8 | Least privilege | ✅ Done | Server holds no credentials; every call runs as the end user's delegated token. Tool scope is structural Planner writes only; reads/text edits are out of scope (routed to the generic Dataverse tool). |
| 2.9 | Tool annotations (read-only/destructive hints) | ✅ Done | `readOnlyHint`/`destructiveHint`/`idempotentHint`/`openWorldHint` per tool ([`src/tools/index.ts`](src/tools/index.ts)). Advisory only — not relied on for enforcement. |
| 2.10 | Human-in-the-loop for destructive ops | ✅ Done | `delete_tasks_batch` requires `confirmed=true`; whole-plan delete hard-blocked. Conversation-level approval lives in the Langdock orchestration skill. |

---

## 3. OWASP API Security Top 10 (2023)

| ID | Risk | Status | Notes |
|---|---|---|---|
| API1 | Broken Object Level Authorization | ✅ Done | Authorization is delegated to Dataverse, which enforces row/field security in the user's context. The server cannot escalate beyond the user. |
| API2 | Broken Authentication | ⚠️ Partial | Inbound JWT verified (§2.1). Residual: token-passthrough model (§1). |
| API3 | Broken Object Property Level Authorization | ✅ Done | Allow-listed `@odata.type`/fields; blocked-on-create and rolled-up-field guards; Dataverse enforces field security. |
| API4 | Unrestricted Resource Consumption | ✅ Done | Rate limit, body cap, outbound timeout, paginated reads with a hard page cap + `truncated` flag, optional `bucketId` narrowing. |
| API5 | Broken Function Level Authorization | ✅ Done | Only the registered tools are exposed (writes + read-only reporting reads scoped to Planner entities); no generic record CRUD or free-form query; destructive ops gated; read tools are annotated `readOnlyHint` and only issue GETs. |
| API6 | Unrestricted Access to Sensitive Business Flows | ⚠️ Partial | `confirmed` gate + change-session model + bulk caps in-code; conversation-flow controls (bulk-confirm, approvals) live in the Langdock skill, not the server. |
| API7 | Server-Side Request Forgery | ✅ Done | All outbound URLs are built from the env-fixed `DATAVERSE_ORG_URL` + fixed paths; no model input selects the host. GUIDs validated before entering URL paths. |
| API8 | Security Misconfiguration | ✅ Done | helmet security headers, `x-powered-by` disabled, fail-fast config validation, non-root container, secure defaults (`AUTH_MODE=validate`). |
| API9 | Improper Inventory Management | ✅ Done | This document + README enumerate every tool, env var and version; single documented `/mcp` endpoint. |
| API10 | Unsafe Consumption of APIs (Dataverse) | ✅ Done | Dataverse responses are validated (status + error shape); JSON parsed defensively; timeouts + bounded retry on reads. |

---

## 4. Injection & input handling

| Control | Status | Implementation / reason |
|---|---|---|
| SSRF (host injection) | ✅ Done | Org URL fixed by env; no model-controlled host ([`src/config.ts`](src/config.ts)). |
| OData filter injection | ✅ Done | Single-quote doubling on literal values in `find_plan_by_name`/`find_team_member`; values are `$filter` literals, not structural. |
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
| 5.3 Ingress restriction to known caller | ❌ Not done (operator action) | Recommended: restrict the Azure Container Apps ingress to the MCP host's egress IP range, or use internal ingress for a dedicated deployment. This is an Azure deployment-time control, not code. Documented in README. |
| 5.4 No secrets committed to the repo | ✅ Done | No credentials, tenant ids or org URLs in source - only example placeholders (`contoso`, all-zero GUIDs). `.env` and build artifacts are gitignored. |

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
| Token passthrough (audience = Dataverse, not this server) | Accepted for private deployment | Migrate to OAuth **resource server + On-Behalf-Of**: expose an API scope on a dedicated Entra app, validate tokens minted *for this server*, then OBO-exchange for a Dataverse token. Closes confused-deputy fully. Triggered if the server is ever exposed to hosts beyond Langdock. |
| Ingress IP restriction | Operator action | Apply Azure Container Apps ingress allow-list (Langdock egress) at deploy time (§5.3). |
| `outputSchema` per tool | Deferred | `structuredContent` is returned for all tools; strict per-tool `outputSchema` is deferred because several tools passthrough dynamic Dataverse response bodies that don't fit a fixed schema. Low risk. |
| Cursor pagination on `get_plan_tasks_and_buckets` | Partial | Added `bucketId` filter + page cap + `truncated`; full cursor pagination deferred until needed. |
| Metrics/tracing | Deferred | See §8. |

---

## 10. Test coverage of security controls

| Control | Test |
|---|---|
| JWT validation (valid / expired / wrong audience / wrong app / garbage / `azp`) | [`test/auth.test.ts`](test/auth.test.ts) |
| Missing/invalid token → 401 with `WWW-Authenticate` | [`test/http.test.ts`](test/http.test.ts) |
| Fail-fast config (validate mode without `TENANT_ID`) | [`test/http.test.ts`](test/http.test.ts) |
| 405 on GET/DELETE `/mcp`, health, `tools/list` | [`test/http.test.ts`](test/http.test.ts) |
| Guardrails (allow-lists, GUID, bind aliases, summary protection, delete confirm, 200-cap) | [`test/guardrails.test.ts`](test/guardrails.test.ts), [`test/buildTasks.test.ts`](test/buildTasks.test.ts), [`test/buildUpdate.test.ts`](test/buildUpdate.test.ts) |

Run: `npm test` (53 tests, no network required).
