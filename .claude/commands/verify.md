---
description: Type-check and run the unit tests; report pass/fail clearly.
allowed-tools: Bash(npm run typecheck:*), Bash(npm test:*)
---

Run the project's verification gate and report the result plainly.

1. Run `npm run typecheck`.
2. Run `npm test`.

Then report:

- ✅ if both pass — say "typecheck + tests pass, safe to commit".
- ❌ if either fails — show the exact failing output (typecheck errors or failed
  test names) and stop. Do **not** weaken or delete a test or a guardrail to make
  it pass; fix the underlying code, or explain why the failure is expected and
  ask how to proceed.
