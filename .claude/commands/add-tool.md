---
description: Add a new MCP tool the safe way (schema, guardrails, registration, tests).
---

A guided, guardrail-preserving workflow for adding a new MCP tool to this server.
Follow it in order. Do not skip the test step. Tool to add: $ARGUMENTS

## 1. Understand the pattern first

- Read `src/tools/index.ts` to see how `allTools[]` and the tool annotations
  (`readOnlyHint` / `destructiveHint` / `idempotentHint` / `openWorldHint`) work.
- Pick the closest existing tool as a template and read it in full:
  - Read-only reporting tool → e.g. `src/tools/getTask.ts` or `listPlans.ts`.
  - Ergonomic write tool → `src/tools/addTasksSimple.ts`.
  - Raw OData write tool → `src/tools/addTasks.ts`.
- Read `src/dataverse.ts` for `dvReq`, `assertGuid`, error handling, and retry
  rules (reads retry; writes never retry).

## 2. Implement

- Create `src/tools/<name>.ts` mirroring the template's structure.
- Define inputs with a **Zod schema**. Every GUID input must pass through
  `assertGuid` before it touches a URL path. Never let input choose a host/path.
- Build outbound URLs only from the env-fixed org URL + fixed paths (no SSRF).
- If it writes: respect the change-session model, the allow-lists, the 200-item
  cap, summary-task protection, and the `confirmed` gate where relevant. A new
  write tool must not become a way around an existing guardrail.
- If it reads: it must only issue GETs, page large results, and set `truncated`.
- Register it in `src/tools/index.ts` with correct annotations. A read tool is
  `readOnlyHint: true`; a delete/destructive tool is `destructiveHint: true`.

## 3. Test (required)

- Add a unit test in `test/` covering the happy path **and** the guardrail
  rejections (bad GUID, missing required field, any cap/allow-list the tool
  relies on). Match the style of `test/guardrails.test.ts`.

## 4. Verify and document

- Run `/verify` (typecheck + tests). Both must be green.
- Update the tool table in `README.md`.
- If the tool changes a security guarantee, update `SECURITY.md` and
  `QUALITY-ASSURANCE.md`.

## 5. Finish

- Make sure you are on a feature branch (not `main`).
- Summarise: the new tool, its guardrails, and the tests you added. Let the human
  review before pushing.
