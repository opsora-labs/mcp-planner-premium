#!/usr/bin/env node
// Stop hook. When a turn changed source or tests, run typecheck + unit tests and
// refuse to let the turn finish while they are red — handing the failure back to
// Claude to fix. This is the "don't break anything" safety net.
//
// Loop-safe: after several consecutive failed attempts it stands down (exit 0)
// so it can never trap the session in an infinite fix loop.
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

let input = {};
try {
  input = JSON.parse(readFileSync(0, "utf8") || "{}");
} catch {
  process.exit(0);
}

const projectDir = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
const run = (c) =>
  execSync(c, { cwd: projectDir, stdio: "pipe", encoding: "utf8" });

// Only verify when relevant files actually changed (keeps non-code turns fast).
// If git is unavailable, verify anyway (fail safe).
let relevant = true;
try {
  const out = run(
    "git status --porcelain -- src test package.json tsconfig.json tsconfig.e2e.json",
  );
  relevant = out
    .split("\n")
    .some((l) => /\.(ts|tsx)$/.test(l.trim()) || /package\.json|tsconfig.*json/.test(l));
} catch {
  relevant = true;
}
if (!relevant) process.exit(0);

const counterFile = path.join(
  os.tmpdir(),
  `mpp-verify-${input.session_id || "nosession"}.count`,
);

function check(cmd) {
  try {
    run(cmd);
    return { ok: true, out: "" };
  } catch (e) {
    return { ok: false, out: `${e.stdout || ""}${e.stderr || ""}` };
  }
}

function tail(text, n = 40) {
  const lines = text.trim().split("\n");
  return lines.length > n ? lines.slice(-n).join("\n") : lines.join("\n");
}

const tc = check("npm run typecheck");
const tt = tc.ok ? check("npm test") : { ok: false, out: "(skipped — fix typecheck first)" };

if (tc.ok && tt.ok) {
  try {
    rmSync(counterFile);
  } catch {}
  process.exit(0); // all green — let the turn finish
}

// Failed. Count attempts so we never loop forever.
let count = 0;
try {
  count = parseInt(readFileSync(counterFile, "utf8"), 10) || 0;
} catch {}

if (count >= 4) {
  try {
    rmSync(counterFile);
  } catch {}
  console.error(
    "⚠️ Verification still failing after several attempts. Auto-verify is standing " +
      "down for this turn to avoid a loop. Run `/verify`, fix the failures, and do " +
      "not commit until typecheck + tests are green.",
  );
  process.exit(0); // stand down — do not block further
}

writeFileSync(counterFile, String(count + 1));

const parts = [];
if (!tc.ok) parts.push(`TYPECHECK FAILED (npm run typecheck):\n${tail(tc.out)}`);
if (!tt.ok) parts.push(`TESTS FAILED (npm test):\n${tail(tt.out)}`);

console.error(
  "Don't finish yet — this change broke verification. These must pass before the " +
    "work is done:\n\n" +
    parts.join("\n\n"),
);
process.exit(2); // block the Stop; stderr is fed back to Claude to fix
