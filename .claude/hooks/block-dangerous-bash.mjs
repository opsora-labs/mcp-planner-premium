#!/usr/bin/env node
// PreToolUse(Bash) guard. Deterministically blocks destructive / unsafe shell
// commands before they run. A PreToolUse "deny" is evaluated before any
// permission-mode check, so this holds even under --dangerously-skip-permissions.
//
// Written in Node (no jq dependency) because the project already requires Node.
import { readFileSync } from "node:fs";

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
  process.exit(0); // can't parse → don't interfere
}

const cmd = input?.tool_input?.command;
if (typeof cmd !== "string" || !cmd.trim()) process.exit(0);

// Simple substring/regex rules: [pattern, reason].
const RULES = [
  [/\bsudo\b/, "sudo is not needed in this project. Run privileged commands yourself if truly required."],
  [/\bgit\s+push\b[^\n]*(--force\b|--force-with-lease\b|\s-f\b)/, "Force-push is blocked — it can overwrite shared history. Push normally, or do it manually."],
  [/\bgit\s+push\b[^\n]*\b(main|master)\b/, "Pushing directly to main/master is blocked. Use a feature branch and open a PR."],
  [/\bgit\s+commit\b[^\n]*(--no-verify\b|\s-n\b)/, "Bypassing commit hooks (--no-verify) is blocked."],
  [/\bgit\s+reset\s+--hard\b/, "`git reset --hard` discards work. If you really mean to, do it manually."],
  [/\bgit\s+clean\s+-[a-zA-Z]*f/, "`git clean -f` deletes untracked files. Do it manually if intended."],
  [/\b(npm|pnpm|yarn)\s+publish\b/, "Publishing to a registry is blocked from inside Claude Code."],
  [/\b(curl|wget)\b[^\n]*\|\s*(sudo\s+)?(sh|bash|zsh)\b/, "Piping a downloaded script into a shell is blocked (supply-chain risk)."],
  [/\bchmod\s+(-R\s+)?0?777\b/, "chmod 777 is blocked."],
  [/(^|[^>])>>?\s*['\"]?\.?\/?\.env(\.[\w.-]+)?\b/, "Writing to .env via the shell is blocked. Secrets must not be written by the agent."],
  [/\btee\b[^\n]*\.env\b/, "Writing to .env via the shell is blocked."],
];

for (const [re, reason] of RULES) {
  if (re.test(cmd)) deny(reason);
}

// rm -rf / -fr guard: allow only known throwaway build targets.
if (/\brm\b/.test(cmd)) {
  const flagBlob = (cmd.match(/\s-([a-zA-Z]+)/g) || []).join("");
  const recursive = /r/.test(flagBlob);
  const force = /f/.test(flagBlob);
  if (recursive && force) {
    const SAFE = /^(?:\.\/)?(node_modules|dist|coverage|build|\.vite|\.turbo|\.cache|tmp)(\/.*)?$/;
    const targets = cmd
      .replace(/.*\brm\b/, "")
      .split(/\s+/)
      .map((t) => t.replace(/^['"]|['"]$/g, ""))
      .filter((t) => t && !t.startsWith("-"));
    const allSafe = targets.length > 0 && targets.every((t) => SAFE.test(t));
    if (!allSafe) {
      deny(
        "Recursive force-delete (rm -rf) is only allowed for build artifacts " +
          "(node_modules, dist, coverage, build, .cache, tmp). Delete anything else manually.",
      );
    }
  }
}

process.exit(0);
