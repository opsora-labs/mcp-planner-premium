# Documentation

Developer and operator documentation for **mcp-planner-premium**. Start with the
top-level [README.md](../README.md) for what the server is and how to run it; the
documents here go deeper.

| Document | Read it when |
|---|---|
| [../CLAUDE.md](../CLAUDE.md) | You (or Claude Code) are about to change the code — golden rules, guardrails, definition of done. Lives at the root because Claude Code loads it automatically. |
| [../SECURITY.md](../SECURITY.md) | You need the security posture, threat model, or compliance checklist. At the root by GitHub convention. |
| [QUALITY-ASSURANCE.md](QUALITY-ASSURANCE.md) | You want to understand the QA strategy and the test matrix that locks in the guardrails. |
| [AUTONOMOUS-SETUP.md](AUTONOMOUS-SETUP.md) | You're setting up unattended Claude Code sessions (Entra app, env vars, the one-time `auth-login.ts` sign-in). |
| [PSS-IMPLEMENTATION-LESSONS.md](PSS-IMPLEMENTATION-LESSONS.md) | You're adding a Planner-Premium / PSS capability — the field guide of Dataverse traps and verified payload recipes. |
| [plans/archive/](plans/archive/) | Historical architecture plans for the original feature build. Kept for context; not active work. |

Host-side prompts (for the MCP host that connects to this server, not for the
server itself) live in [../skills/](../skills/).
