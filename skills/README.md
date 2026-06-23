# Host-side skills

These are **prompts for the MCP host**, not part of the server. The server in
`src/` exposes the tools and enforces the hard guardrails; the prompts here tell a
host (Claude, Langdock, etc.) *how to use* those tools well once it's connected.

Give one of these to your MCP host as its system prompt / skill after wiring up the
connection (see [Wire up an MCP host](../README.md#wire-up-an-mcp-host)).

| Skill | Purpose | Audience |
|---|---|---|
| [guided-assistant.md](guided-assistant.md) | A guided Planner Premium assistant — propose → approve → verify discipline for every change, GUID-only task targeting, summary-task protection, plain language. | Project managers with no AI/automation experience. |
| [acceptance-test-runner.md](acceptance-test-runner.md) | Drives an interactive acceptance run (read sweep, write lifecycle, guardrail tests) through any MCP host and writes a pass/fail report plus a follow-up fix prompt. | QA / maintainers validating a deployment. |

> Conversation-level safety lives in these prompts; the server enforces an
> independent hard floor (allow-lists, the `confirmed` delete gate, summary-task
> blocks, the 200-item cap). The two layers are intentionally redundant — neither
> relies on the other.
