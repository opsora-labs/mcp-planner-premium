# CLAUDE.md — mcp-planner-premium

Guidance for any Claude Code session working in this repo. Read this fully before
changing anything. The rules here are enforced by automated hooks in `.claude/` —
this file explains the *why* so you work with them, not against them.

## What this project is

A self-hosted **MCP server** (TypeScript, Node 22 LTS — min Node 20) that exposes
Microsoft Planner Premium structural writes (via Dataverse PSS V2 APIs) and
read-only reporting as MCP tools, in the signed-in user's **delegated** context.

It is **security-hardened on purpose**. Its safety comes from server-side
guardrails (allow-lists, GUID checks, summary-task protection, the 200-item cap,
the delete-confirm gate, whole-plan-delete block). The whole value of this server
is that those guardrails hold. See `SECURITY.md` and `docs/QUALITY-ASSURANCE.md`.

## Golden rules (do not break these)

1. **Never weaken a guardrail to make something pass.** If a test, allow-list,
   GUID check, cap, or the `confirmed` delete gate is in your way, that is almost
   always the guardrail doing its job. Change the calling code, not the guard.
   If you genuinely believe a guard is wrong, **stop and ask the human** — explain
   the case; do not quietly remove or loosen it.
2. **Work on a branch, never commit straight to `main`.** Create a feature branch
   for any change (`git switch -c fix/<short-name>`).
3. **Green before done.** `npm run typecheck` and `npm test` must both pass before
   you consider a change finished. A Stop hook enforces this automatically.
4. **Never touch secrets.** Do not read, print, edit, or commit `.env` / `.env.*`
   or any token. The server holds no standing secrets by design — keep it that way.
5. **Tests come with behaviour changes.** If you change tool logic, add or update
   the matching unit test in `test/`. Don't delete a failing test to go green.
6. **Don't add a dependency casually.** New runtime deps expand the attack surface
   and the supply chain. Prefer the standard library. If a dep is truly needed,
   call it out to the human and explain why.

## Commands

| Task | Command | Notes |
|---|---|---|
| Type-check (src) | `npm run typecheck` | Fast, no network. Run after edits. |
| Type-check (e2e) | `npm run typecheck:e2e` | For `test/e2e/`. |
| Unit tests | `npm test` | vitest, ~50+ tests, **no network**. The bar for "works". |
| Build | `npm run build` | `tsc` → `dist/`. |
| Dev server | `npm run dev` | `tsx watch`. Needs env vars (see README). |
| E2E (live) | `npm run e2e` | **Hits a real tenant** — only run when the human asks and env is set. |

Quick gate any time: run `/verify` (typecheck + tests).

## Adding a PSS feature (read this before touching a new entity/field/bind)

This server talks only to Dataverse/PSS, where **guessing a field name, an
`@odata.bind` casing, the plural entity-set name, or what is even API-creatable
wastes hours**. Two rules:

1. **Discover before you code.** Probe the live schema and prove a minimal create
   live FIRST. `docs/PSS-IMPLEMENTATION-LESSONS.md` is the field guide — the
   actual traps (root-task auto-nesting, per-entity bind casing, blocked-on-create
   fields, 200-per-operation-set, EU link-type values, labels/milestone/comments
   being non-creatable, identity-by-resource-id) and verified payload recipes.
2. **Use the workflow.** Run `/add-pss-feature <capability>`, which drives the
   `pss-schema-scout` subagent (Opus — discovers + proves the schema) then
   `pss-feature-implementer` (Sonnet — implements per the proven spec + tests),
   then `guardrail-auditor`. Don't implement from a guessed schema.

## Where things live

```
src/index.ts        HTTP server bootstrap, graceful shutdown, timeouts
src/app.ts          Express app: JWT middleware, rate limit, helmet, /mcp, /healthz
src/auth.ts         JWT validation (jose, Entra JWKS) — SECURITY-CRITICAL
src/config.ts       Zod env schema, fail-fast config — SECURITY-CRITICAL
src/dataverse.ts    dvReq(), assertGuid(), error handling, retries — SECURITY-CRITICAL
src/logger.ts       pino + token redaction — SECURITY-CRITICAL (never log tokens)
src/server.ts       MCP server, tool registration, SERVER_INSTRUCTIONS
src/tools/*.ts      One file per tool. Guardrails live here.
src/tools/index.ts  allTools[] registry + tool annotations (readOnly/destructive hints)
test/*.test.ts      Unit tests (guardrails, build logic, auth, http, reporting)
```

The two "preferred" ergonomic tools (`add_tasks`, `update_tasks`) build the raw
Dataverse payload for you in `addTasksSimple.ts` / `updateTasksSimple.ts`. The
`*_batch` tools are raw-OData escape hatches with their own guardrails in
`addTasks.ts` / `updateTasks.ts`. Don't blur the two contracts.

## Code conventions

- TypeScript ESM (`"type": "module"`), strict. Match the style of the file you edit.
- Validate input with **Zod** at the tool boundary; never trust model-supplied
  GUIDs — run them through `assertGuid` before they enter a URL path.
- All outbound URLs are built from the env-fixed org URL + fixed paths. **Never**
  let tool input select a host or path segment (SSRF). 
- Keep secrets out of logs — `logger.ts` redacts `authorization`/`*token*`; don't
  add a log line that prints a request body or header that could contain a token.
- Errors should be specific and safe: reject with a clear message rather than
  silently dropping or guessing.

## Guardrails you must preserve (non-exhaustive)

These are the invariants the test suite and reviewers lock in. If your change
makes one of these stop holding, the change is wrong:

- Entity / field **allow-lists** on `*_batch` writes (no arbitrary `@odata.type`).
- **Blocked-on-create** fields (e.g. `msdyn_ismilestone`) rejected at create time.
- **Bind-alias** correctness (`msdyn_projectbucket@odata.bind`, not `msdyn_bucket@…`).
- **Parents-before-children** ordering (auto-sorted in `add_tasks`, enforced in batch).
- **Summary-task protection**: never overwrite rolled-up parent dates/effort/progress.
- **200-entity** batch cap.
- Delete requires **`confirmed: true`**; **whole-plan delete is hard-blocked**.
- GUIDs validated before entering any URL path or session call.

## Definition of done

- [ ] `npm run typecheck` passes (zero TS errors)
- [ ] `npm test` passes (no test deleted/weakened to get there)
- [ ] New/changed behaviour has a unit test
- [ ] No guardrail removed or loosened (or: explicitly raised with the human)
- [ ] No secret read, logged, or committed
- [ ] Change is on a branch, not `main`
- [ ] Docs updated if the tool surface or a guarantee changed (README tool table,
      and `SECURITY.md` / `docs/QUALITY-ASSURANCE.md` if a safeguard changed)

## What the automation does (so a block isn't a surprise)

`.claude/` ships a safety net. If you get blocked, it's deliberate — read the
reason and adapt, don't try to route around it:

- **Dangerous shell commands are blocked** (force-push, push to `main`,
  `--no-verify`, `rm -rf` of non-build paths, `npm publish`, `curl | sh`, writing
  to `.env`, `sudo`). Do these manually if a human truly intends them.
- **Protected files** can't be edited by you: `.env*`, `package-lock.json`, and
  `.claude/settings.json` + `.claude/hooks/*` (so the agent can't disable its own
  guardrails). The human maintainer edits those directly.
- **Auto-verify on finish**: when a turn changed `src/` or `test/`, a Stop hook
  runs typecheck + tests and won't let the turn end while they're red — it hands
  you the failure to fix.

See `.claude/README.md` for the full design.

## Autonomous operation

When running without a human in the loop (e.g. `claude --dangerously-skip-permissions`),
follow this loop exactly. All golden rules above still apply.

### Task loop

1. Read `TODO.md` — pick the **first unchecked** item (`- [ ]`).
2. If nothing is unchecked, stop — all tasks are done.
3. Create a branch: `git switch -c feat/<short-slug-from-task>`
4. Implement the task, following all golden rules above.
5. Green gate: `npm run typecheck && npm test` must both pass before continuing.
6. If the task changes live API behaviour, run e2e (see below).
7. Push the branch and open a PR:
   ```
   git push origin feat/<slug>
   gh pr create --title "<task summary>" --body "Closes task: <description from TODO.md>"
   ```
8. Merge when checks pass:
   ```
   gh pr merge --merge --auto
   ```
9. Switch back to main and pull:
   ```
   git switch main && git pull
   ```
10. Check off the completed item in `TODO.md` (change `- [ ]` to `- [x]`),
    commit and push directly on main:
    ```
    git add TODO.md && git commit -m "mark done: <task slug>" && git push origin main
    ```
11. Repeat from step 1.

### Getting a Dataverse token for e2e

Requires `.tokens.json` in the project root (created once by the human via
`scripts/auth-login.ts` — see below). After that, token acquisition is silent.

```bash
export E2E_ACCESS_TOKEN=$(npx tsx --env-file .env scripts/get-dataverse-token.ts)
E2E_ALLOW_WRITES=true npm run e2e
```

The script redeems the cached refresh token and writes the rotated token back,
so the cache stays valid indefinitely (refresh tokens expire after 90 days of
**non-use**; any successful refresh resets the clock).

If `get-dataverse-token.ts` fails with "refresh failed", the cache has expired.
Stop and ask the human to re-run `auth-login.ts`.

### Cleaning up e2e test plans after a run

Each e2e write-phase run leaves a `ZZ-MCP-E2E-*` plan in Dataverse (whole-plan
deletion is blocked server-side by design). Clean them up with:

```bash
export E2E_ACCESS_TOKEN=$(npx tsx --env-file .env scripts/get-dataverse-token.ts)
npx tsx --env-file .env scripts/cleanup-e2e-plans.ts
```

### One-time human setup (before first autonomous session)

This is the human's responsibility, done once. See
[docs/AUTONOMOUS-SETUP.md](docs/AUTONOMOUS-SETUP.md) for the full walkthrough:
Entra app registration (delegated `user_impersonation`, public-client flows),
the required `.env` vars, and the one-time `scripts/auth-login.ts` device-code
sign-in that seeds `.tokens.json`.
