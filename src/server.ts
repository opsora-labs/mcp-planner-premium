import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { allTools, toolAnnotations } from "./tools/index.js";
import { filterTools } from "./toolFilter.js";
import { isReadOnlyMode, getEnabledTools, getToolsets } from "./config.js";

/**
 * Server-level guidance, returned to every MCP host on `initialize`. This is the
 * portable safety FLOOR - the non-negotiable, mechanical invariants of the PSS
 * Schedule APIs - so the server is safe even when used from a host that lacks a
 * dedicated orchestration skill.
 *
 * It deliberately does NOT duplicate a host/agent's conversation-level safety
 * (propose/approve dialogues, date disambiguation, prompt-injection defence, GUID
 * disambiguation menus). Those remain the orchestrating host/agent's job.
 */
const SERVER_INSTRUCTIONS = [
  "Microsoft Planner Premium toolset (Project for the web plans), acting in the signed-in user's delegated Dataverse context. It does TWO things: (a) STRUCTURAL writes to the engine-managed schedule entities via the change-session flow, and (b) first-class READS / reporting / analytics over those plans. Prefer these dedicated tools over generic Dataverse record tools for anything plan-related; only fall back to generic tools for entities this server does not model. Task notes/descriptions ARE editable here - pass the 'description' field on add_tasks / update_tasks.",
  "",
  "Reads/reporting/analytics (all read-only, paged and size-capped): use this server's get_* / list_* / find_* / describe_option_set / whoami tools - e.g. get_plan_summary (rollups), get_plan_tasks_and_buckets (task tree + buckets), list_plan_tasks (filtered task lists with descriptions), get_bucket_breakdown, list_dependencies, get_task (one task in full), list_team_members, list_my_tasks / list_user_tasks (across plans), and get_critical_path / get_schedule_health / get_resource_workload. They understand the PSS schema and stay within host size limits (see invariant 10 on paging).",
  "",
  "Typical write flow: find_plan_by_name -> create_plan / add_bucket / add_sprint -> start_change_session -> add_tasks / update_tasks / assign_task / delete_tasks_batch -> apply_changes -> get_plan_tasks_and_buckets to verify. apply_changes now WAITS for PSS to finish persisting (default up to 60s) and returns persisted:true when Completed, so a separate check_change_session_status poll is usually unnecessary; only poll it if apply_changes returns persisted:false with timedOut:true. Prefer the ergonomic add_tasks / update_tasks (plain lists, server builds the OData payload; update_tasks auto-protects summary tasks when given projectId) over the raw add_tasks_batch / update_tasks_batch.",
  "",
  "Hard invariants (the server enforces these and will reject violations - do not work around them):",
  "1. Scheduling entities (msdyn_project/projecttask/projectbucket/projecttaskdependency/resourceassignment/projectsprint) are engine-managed. Change them ONLY through this server's change-session flow. NEVER create/delete them with generic Dataverse record tools - PSS silently discards direct inserts and the tasks vanish on refresh.",
  "2. A change session saves NOTHING until apply_changes completes (statusCode 192350003). Max 10 open sessions per user; max 200 items per batch. Call start_change_session and the batch in SEPARATE turns - never the same parallel block (causes duplicate-entity errors); submit each batch exactly once.",
  "3. Summary (parent) tasks: msdyn_start/finish/effort/progress/duration roll up from children and must not be written. With the ergonomic update_tasks, just pass projectId and the server auto-detects and protects summary tasks - no prior read needed. With the raw update_tasks_batch, first call get_plan_tasks_and_buckets and pass its summaryTaskIds. Renames/descriptions on summary tasks are fine.",
  "4. Target tasks by msdyn_projecttaskid GUID only, never by name (duplicate names are common). Resolve via get_plan_tasks_and_buckets; if a name matches more than one task, ask the user - never pick silently.",
  "5. Exact @odata.bind keys: msdyn_project, msdyn_projectbucket, msdyn_parenttask, and the PascalCase msdyn_PredecessorTask / msdyn_SuccessorTask for dependency links. NEVER msdyn_bucket / msdyn_projectbucketid / msdyn_parent / msdyn_parenttaskid, and NEVER the lowercase msdyn_predecessortask / msdyn_successortask (Dataverse rejects those as annotation-only properties). On a 'not a valid navigation property' error, use the corrected key the server names - do not retry the same payload.",
  "6. Hierarchy on create comes from msdyn_parenttask@odata.bind (parents before children in the batch), NOT msdyn_outlinelevel/displaysequence. New tasks are APPENDED (display order is blocked on create); exact reordering must be done in the Planner UI.",
  "7. msdyn_progress and actuals are rejected on create - set them in a follow-up update_tasks / update_tasks_batch session. msdyn_ismilestone is engine-managed: it CANNOT be set via the API on create or update (PSS rejects it; the engine auto-sets it on summary tasks). The ergonomic tools don't error on it - add_tasks returns the affected ids in milestoneTaskIds and update_tasks drops it with a warning; point the user to the Planner UI to flag milestones. Dependencies cannot be updated - delete and recreate.",
  "8. delete_tasks_batch requires confirmed=true only after explicit per-record user confirmation. Whole-plan deletion is blocked - point the user to the Planner UI. (assign_task mode='unassign' likewise requires confirmed=true.)",
  "9. After a write, treat get_plan_tasks_and_buckets as authoritative; if it returns truncated=true the read is incomplete - do not report success from it.",
  "10. Reads are PAGED and size-capped (each response is kept under hosts' ~200k-char limit so it is never silently truncated). A response with hasMore:true / a nextPageToken is INCOMPLETE - call the SAME tool again with that pageToken and keep paging until hasMore is false before counting tasks, summarising, or claiming you have the whole plan. A clipped note shows descriptionTruncated:true - fetch the full text with get_task.",
  "Capability note: add_tasks / update_tasks can also place a task in a sprint (create it first with add_sprint); add_tasks can attach checklist items and assign project-team members (assignees), and assign_task (un)assigns members on existing tasks. Labels can only be APPLIED, not created, via the API (Project/Planner UI only) - an unknown label is skipped with a warning. Tasks, dependencies, checklist items, label links and assignment links all count toward the 200-per-batch cap.",
  "Schema note: a plan's end date is msdyn_finish (not msdyn_scheduledend). Progress fields are 0-1 (0.5 = 50%); effort is in hours.",
  "Date range note: PSS clamps task dates to the plan's scheduling window, so tasks dated before the plan's start can be silently normalised. Set the plan's start early enough AT CREATION via create_plan's scheduledStart (msdyn_scheduledstart) to cover your earliest task date - the start can only be set at create time. The plan's end date (msdyn_finish) is engine-managed and CANNOT be set via the API (project-finish updates are rejected and create_plan has no finish parameter); for hard date-window changes use the Planner UI.",
  "Description note: Dataverse sanitises task descriptions. Standard special characters round-trip (the read tools decode &quot;/&amp;/&lt;/&gt; back to \" & < > to match the Planner UI), but tag-like angle-bracket content (e.g. <2 weeks>) is STRIPPED before storage and cannot be recovered — do not rely on literal <...> text surviving in a description.",
  "Custom Dataverse columns note: customer-added (non-msdyn_) columns are OPT-IN and disabled by default (CUSTOM_COLUMNS_MODE=off on the server) — call list_custom_columns / describe_columns to discover what exists on this tenant BEFORE using customFields on add_tasks / update_tasks / create_plan or includeCustomColumns on get_task / list_plan_tasks / get_plan_summary; never guess a custom column's name or type.",
].join("\n");

/**
 * Builds a fresh McpServer with all Planner-Premium writer tools registered.
 * In the stateless HTTP transport we build one server per request, so this is
 * called on every inbound POST.
 */
export function buildServer(): McpServer {
  const server = new McpServer(
    {
      name: "mcp-planner-premium",
      version: "1.0.0",
    },
    {
      instructions: SERVER_INSTRUCTIONS,
    },
  );

  // Determine the active tool surface. filterTools is pure and cheap (~25
  // iterations); it runs per request because buildServer() is called per
  // request in the stateless HTTP transport.
  const { tools, readOnlyNames } = filterTools(allTools, toolAnnotations, {
    readOnly: isReadOnlyMode(),
    enabledTools: getEnabledTools(),
    toolsets: getToolsets(),
  });

  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: toolAnnotations[tool.name],
      },
      async (args: unknown) => {
        // Defense-in-depth: even if a write/session tool were somehow invoked
        // (e.g. a stale client replaying a direct JSON-RPC call), reject it
        // here before any Dataverse call is made. The registration filter above
        // is the primary gate; this is the secondary layer.
        if (isReadOnlyMode() && !readOnlyNames.has(tool.name)) {
          throw new Error(
            `This server is running in read-only mode; '${tool.name}' is a write/session tool and is disabled.`,
          );
        }

        const result = await tool.handler(args as any);
        // Send the payload ONCE, as content[].text (compact JSON - no pretty
        // indentation, pure token waste for an LLM). MCP also offers a
        // `structuredContent` channel, but it carries the SAME data — doubling the
        // bytes a host counts toward its response-size cap (e.g. Langdock truncates
        // at ~200k chars). The model and this project's clients read content[].text,
        // and no tool declares an outputSchema, so structuredContent only added a
        // redundant copy; dropping it ~halves every response. (Trade-off: a host's
        // typed-output panel falls back to showing the raw JSON text.)
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      },
    );
  }

  return server;
}
