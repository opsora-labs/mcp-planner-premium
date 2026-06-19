# `.claude/` — safe-by-default Claude Code setup

This folder lets anyone use **Claude Code** to make changes to this repo without
breaking the server's security guarantees or its tests. It is designed so the
safety does **not** depend on the person being an expert — the guardrails run
automatically.

## The three layers

1. **`CLAUDE.md`** (repo root) — what every Claude session must *know*: golden
   rules, commands, the guardrails it must never weaken, and the definition of
   done. Loaded automatically at the start of every session.

2. **`settings.json`** — what Claude is *allowed* to do (committed, shared):
   - `deny` — reading/editing `.env*` (secrets) is refused outright.
   - `ask` — risky actions (`git push`, dependency changes, `docker`, `npm
     publish`) require your confirmation each time.
   - `allow` — safe dev commands (typecheck, test, build, read-only git/shell)
     run without nagging, so people don't get prompt-fatigue and start clicking
     "allow all".

3. **`hooks/`** — deterministic code that runs no matter what the model decides.
   A `PreToolUse` *deny* is evaluated **before** any permission mode, so it holds
   even if someone runs with `--dangerously-skip-permissions`.
   - `block-dangerous-bash.mjs` — blocks force-push, push to `main`,
     `--no-verify`, `rm -rf` of non-build paths, `npm publish`, `curl | sh`,
     writing to `.env`, `sudo`.
   - `protect-paths.mjs` — blocks edits to `.env*`, `package-lock.json`, and
     `.claude/settings.json` + `.claude/hooks/*` (so the agent can't switch off
     its own guardrails).
   - `verify-on-stop.mjs` — when a turn changed `src/` or `test/`, runs
     `npm run typecheck` + `npm test` and won't let the turn finish while they're
     red. Loop-safe: stands down after a few failed attempts.

Hooks are plain **Node** scripts (the project already needs Node), so there's no
extra tooling to install — no `jq`, no shell quirks.

## Slash commands

- `/verify` — run typecheck + tests and report pass/fail.
- `/add-tool <name>` — the safe, step-by-step way to add a new MCP tool
  (schema → guardrails → registration → tests → docs).

## Subagents

- `agents/guardrail-auditor.md` — an isolated reviewer you can invoke to check a
  diff against the server's security invariants before you push.

## For the maintainer

- **Personal tweaks:** copy `settings.local.json.example` →
  `settings.local.json` (gitignored). Add commands you trust on your machine.
  Don't weaken the hooks there — they're shared in `settings.json` on purpose.
- **Changing the guardrails:** only a human should edit `settings.json` or
  `hooks/*`; the agent is blocked from doing so by design. Edit them directly in
  your editor.
- **Test the hooks** after changing them:
  ```sh
  echo '{"tool_input":{"command":"git push --force"}}' | node .claude/hooks/block-dangerous-bash.mjs
  echo '{"tool_input":{"file_path":".env"},"cwd":"'"$PWD"'"}' | node .claude/hooks/protect-paths.mjs
  ```
  A blocked action prints a JSON object containing `"permissionDecision":"deny"`.

## What this does and doesn't guarantee

It **prevents the common ways an AI edit breaks things**: leaking/committing
secrets, destructive git/shell actions, silently disabling its own safety, and
finishing with red tests or type errors. It is a strong floor, not a proof of
correctness — a human should still review diffs before they ship, especially
changes to `src/auth.ts`, `src/config.ts`, `src/dataverse.ts`, `src/logger.ts`,
and the guardrails in `src/tools/`.
