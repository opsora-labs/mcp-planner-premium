#!/usr/bin/env node
// PreToolUse(Edit|Write|MultiEdit|NotebookEdit) guard. Blocks edits to files the
// agent must never modify: secrets, the lockfile, and the Claude Code safety
// config itself (so the agent can't disable its own guardrails).
import { readFileSync } from "node:fs";
import path from "node:path";

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }),
  );
  process.exit(0);
}

let input = {};
try {
  input = JSON.parse(readFileSync(0, "utf8") || "{}");
} catch {
  process.exit(0);
}

const ti = input?.tool_input || {};
const fp = ti.file_path || ti.notebook_path || ti.path;
if (typeof fp !== "string" || !fp) process.exit(0);

const projectDir = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
const rel = path
  .relative(projectDir, path.resolve(projectDir, fp))
  .split(path.sep)
  .join("/");
const base = path.basename(fp);

const PROTECTED = [
  {
    when: () => base === ".env" || /^\.env\./.test(base),
    reason: "Secrets files (.env / .env.*) must never be edited by the agent.",
  },
  {
    when: () => base === "package-lock.json",
    reason:
      "package-lock.json is generated. Change dependencies with `npm install <pkg>` " +
      "(which regenerates it) instead of editing it by hand.",
  },
  {
    when: () => rel === ".claude/settings.json" || rel === ".claude/settings.local.json",
    reason:
      "Claude Code settings (permissions + hooks) are protected so the agent cannot " +
      "disable its own guardrails. The human maintainer edits this file directly.",
  },
  {
    when: () => rel.startsWith(".claude/hooks/"),
    reason:
      "The Claude Code safety hooks are protected. Ask the human maintainer to change them.",
  },
];

for (const p of PROTECTED) {
  if (p.when()) deny(p.reason);
}

process.exit(0);
