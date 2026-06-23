# Quality and Data-Integrity Assurance

## Planner Premium (MCP server)

This page explains, in plain terms, how we make sure the Planner Premium
works correctly and safely: what we have tested and checked, how we prevent data
problems, how every action runs as intended, and how the AI assistant (the "MCP
client") always knows exactly what to send.

---

## 1. What this component is

The Planner Premium is a small, self-hosted server that lets an AI
assistant create and change Microsoft Planner Premium plans (plans, buckets,
tasks, dependencies) and read plan information for reporting. It connects to your
Microsoft Dataverse environment using the official, supported scheduling APIs and
always acts in the signed-in user's own account, so each person only ever sees
and changes what their own Microsoft permissions allow.

It exposes 23 well-defined actions (called "tools"): structural changes, saving,
status checks, and read-only reporting.

---

## 2. How we prevent data issues

Data safety is built into the server itself, not left to chance or to the AI.

| Safeguard | What it protects against |
| --- | --- |
| Supported write path only | All structural changes go through Microsoft's official change-session API. The server never writes scheduling records directly, which is the cause of "tasks that disappear after refresh." |
| Nothing saves until you apply | Changes are queued in a change session and are only written when an explicit "Apply Changes" step runs. This gives a clear preview-and-approve point before anything is committed. |
| Summary-task protection | Dates, effort and progress of a parent (summary) task are calculated by Microsoft from its child tasks. The server rejects attempts to overwrite these rolled-up values, so the schedule stays consistent. |
| Field allow-lists | Only known, valid fields and record types are accepted. Unknown or unsafe fields are rejected with a clear message rather than silently dropped. |
| Correct linking enforced | Bucket, parent-task and dependency links are validated. Common wrong field names are caught and corrected, so a task can never be attached to the wrong place. |
| Deletion guard | Deleting items requires an explicit confirmation flag, and deleting an entire plan is blocked by policy and pointed to the Planner interface instead. |
| Batch-size limit | Each change is capped at 200 items, matching the platform limit, so oversized requests fail early and cleanly. |
| User-context only | Every action runs with the signed-in user's permissions. The server holds no standing credentials of its own. |

The result: an action either completes correctly, or it stops with a clear,
specific error - it does not produce partial or inconsistent data.

---

## 3. How each action runs correctly

Every action follows the same discipline:

- Inputs are validated before any call to Microsoft (for example, identifiers
  must be valid GUIDs, dates and values must be well-formed).
- The server builds the exact technical request Microsoft expects, so the AI
  never has to assemble low-level details that are easy to get wrong.
- Reads and status checks automatically retry briefly on temporary network or
  service hiccups, and every call has a timeout so a request cannot hang.
- Saving is asynchronous: after "Apply Changes", the assistant polls the status
  until Microsoft confirms "Completed" before reporting success. Success is never
  reported early.
- Large reads are paged and clearly flagged if a result was too large to return
  in full, so an incomplete list is never mistaken for a complete one.

The table in section 6 lists, action by action, what is validated and how the AI
is guided.

---

## 4. How the AI client always knows what to send

This is a common failure point for AI integrations, and we address it in three
layers:

1. **Self-describing actions.** Every action carries a precise description and a
   typed list of its inputs (what each field means, whether it is required, the
   expected units and formats). The assistant reads these directly from the
   server.

2. **Server-level rules.** The server publishes a short list of non-negotiable
   rules to every assistant on connection (for example: parents before children,
   nothing saves until apply, never overwrite summary-task rollups, target tasks
   by their unique identifier, the exact link field names). These travel with the
   server, so the same safety applies in any AI tool that connects to it.

3. **Plain-language actions that build the technical details.** For the common
   tasks (adding and updating tasks), the assistant sends a simple list - task
   name, bucket, dates, who it reports to - and the server constructs all of the
   underlying Microsoft payload (identifiers, links, ordering, option codes).
   Because the assistant never writes the low-level format, an entire class of
   mistakes simply cannot happen.

We also specifically documented the few "traps" that could cause silent errors,
so the assistant is warned in the action description itself. Examples that were
reviewed and corrected:

- Progress values: the simple update action takes a percentage (0-100); the
  advanced action takes a fraction (0-1). Each now states its unit explicitly so
  the two cannot be confused.
- Status codes: the wording now matches the exact status text the server returns.
- Buckets must exist before tasks reference them, and the action says so and
  accepts a bucket by name.
- Setting a milestone or progress is not allowed at creation time; the action
  explains this and points to the follow-up step.

---

## 5. What we tested and checked

The component was checked in two complementary ways: an automated test suite that
runs on every change, and several independent expert reviews.

### Automated tests

62 automated tests run on every build and currently all pass. They cover:

| Test area | What it proves |
| --- | --- |
| Data guardrails (24 tests) | Invalid input is rejected with the correct, specific error: wrong field names, duplicate identifiers, blocked fields, oversized batches, missing required fields, summary-task protection, deletion-confirmation gate, whole-plan-delete block. |
| Request construction (15 tests) | The simple task lists are turned into correct Microsoft payloads, including identifiers, links, dependency types and percentage conversion. |
| Deep hierarchy (6 tests) | Subtasks nested six levels deep are built and ordered correctly, including when the assistant provides them in any order, and a wrongly ordered request is rejected. |
| Access control (7 tests) | Valid access tokens are accepted; forged, expired, wrong-audience and wrong-application tokens are rejected before any data is touched. |
| Service endpoint (7 tests) | The server starts safely, refuses requests without a valid token, refuses unsupported calls, and never logs the access token. |
| Reporting logic (3 tests) | Status roll-ups (overdue, milestone and summary counts) are calculated correctly and exclude rolled-up parent tasks where appropriate. |

### Independent expert reviews

The design and the action descriptions were reviewed by separate expert reviews,
each focused on one area:

| Review | Focus | Outcome |
| --- | --- | --- |
| Security | Authentication, data exposure, injection, transport | Findings addressed; token validation, rate limiting, security headers and graceful shutdown added. |
| Standards conformance | Alignment with Model Context Protocol best practice | Action hints and structured results added; design confirmed appropriate. |
| Reliability | Production readiness on the hosting platform | Timeouts, retries, fail-fast configuration and safe logging added. |
| Microsoft scheduling expertise | Correct entity and field names, query behaviour, Project workflow rules | Read and reporting actions validated against Microsoft documentation; environment-specific fields made to degrade safely. |
| Action-description audit | Whether the AI can build each request without mistakes | All 23 actions audited line by line against the code; wording corrected so units, ordering and identifiers are unambiguous. |

Every finding from these reviews was applied, and the results were re-verified by
the automated tests.

---

## 6. Action-by-action assurance

| Action | Purpose | Built-in safeguards | How the AI is guided |
| --- | --- | --- | --- |
| Create plan | Start a new plan | Runs in user context; returns the plan identifier | States it runs immediately and creates a default bucket |
| Add bucket | Add a grouping column | Direct, supported insert; returns bucket identifier | States no change session needed; buckets needed before tasks |
| Start change session | Open a transaction for task changes | Enforces the supported flow; warns about the session limit | Tells the AI to wait for the session id before sending changes |
| Add tasks (simple) | Add tasks, hierarchy, dependencies | Builds all technical details; orders parents before children at any depth | AI sends a plain list in any order; server does the rest |
| Add tasks (advanced) | Raw control for unusual cases | Full validation of fields, links, ordering, limits | Documents exact field names and parents-before-children rule |
| Update tasks (simple) | Change dates, effort, progress, milestone | Converts percentages; protects summary tasks | States this is where milestone is set; percentage is 0-100 |
| Update tasks (advanced) | Raw control for unusual cases | Protects rolled-up fields; rejects dependency edits | Warns progress is a fraction (0-1), not a percentage |
| Delete tasks | Remove tasks and related items | Requires explicit confirmation; blocks whole-plan delete | States at least one identifier list is required |
| Apply changes | Save the queued change session | Asynchronous; success only after confirmed completion | Tells the AI to poll status until "Completed" |
| Check session status | Track saving / list open sessions | Read-only | Status wording matches the exact returned values |
| Cancel change session | Discard unsaved changes | Read-only effect on uncommitted work | Notes the resulting "Abandoned" status |
| Find plan by name | Resolve a plan to its identifier | Read-only; flags exact and multiple matches | Notes progress is a 0-1 fraction |
| Find team member | Resolve a person for assignment | Read-only; never guesses identifiers | Tells the AI to add the person in Planner if not found |
| Get plan tasks and buckets | Full plan contents | Read-only; paginated with a completeness flag | Provides the summary-task list for safe updates |
| List plans | Recent plans for reporting | Read-only | Returns progress as a percentage |
| Plan summary | Roll-up: dates, effort, counts | Read-only; overdue excludes summary tasks | Explains counts and the completeness flag |
| Get task | One task in full, with links | Read-only; degrades safely if optional data is unavailable | States which details may be omitted with a note |
| List plan tasks | Filtered list (all / overdue / milestones) | Read-only; overdue excludes summary tasks | Filter options explained in the input |
| Bucket breakdown | Count and average progress per bucket | Read-only; flags incomplete on very large plans | Stated as a reporting estimate |
| List dependencies | All task links in a plan | Read-only; resolves task names | Link type and lag explained |
| List team members | All people on a plan | Read-only | Returns the identifiers needed for assignment |
| Describe option set | Look up valid choice values | Read-only metadata | Removes the need to guess numeric codes |
| Who am I | Connection diagnostic | Read-only | Confirms the connection is valid |

---

## 7. Security and compliance

The component was hardened to industry standards and mapped against the Model
Context Protocol security best practices and the OWASP API Security Top 10. A
full control-by-control checklist, including the items that are deliberate design
choices or operator responsibilities, is maintained in `SECURITY.md`.

Key points:

- The server holds no standing secrets; it only relays each user's own access
  token, which is verified on the way in and never written to logs.
- It runs as a non-privileged process in a hardened container, with rate
  limiting, security headers, request timeouts and graceful shutdown.
- All actions are scoped to Planner Premium data; there is no general-purpose
  data access path.

---

## 8. Honest scope of this assurance

We want to be clear about what the testing does and does not prove, so there are
no surprises:

- The automated tests and expert reviews prove that the **logic, safeguards and
  request construction are correct**, and that the AI is given unambiguous
  instructions. They run without touching live data.
- The **final confirmation for your specific environment** is a short set of live
  runs in your Dataverse tenant (create a small plan, add nested tasks, apply,
  and read it back). This is the only step that exercises Microsoft's service
  end to end, and we recommend running it once during onboarding.
- A small number of optional fields (for example, certain resource-assignment
  columns) vary between Microsoft environments. These are confirmed on first use
  and, if unavailable, are returned as a clearly labelled note rather than
  causing an action to fail.
- For confirming a change immediately after it is made, an independent read path
  remains available, so a single shared issue cannot make a failed change appear
  successful.

---

*This document reflects the state of the component at the time of review. The
automated tests and the security checklist are kept current in the source
repository.*
