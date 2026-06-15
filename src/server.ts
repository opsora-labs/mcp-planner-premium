import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { allTools, toolAnnotations } from "./tools/index.js";

/**
 * Server-level guidance, returned to every MCP host on `initialize`. This is the
 * portable safety FLOOR - the non-negotiable, mechanical invariants of the PSS
 * Schedule APIs - so the server is not dangerous when used from a host that
 * lacks the full Langdock orchestration skill.
 *
 * It deliberately does NOT duplicate the Langdock skill's conversation-level
 * safety (propose/approve dialogues, date disambiguation, prompt-injection
 * defence, GUID disambiguation menus). Those are the host/agent's job; keep the
 * Langdock skill as their single source of truth.
 */
const SERVER_INSTRUCTIONS = [
  "Microsoft Planner Premium STRUCTURAL writer. All tools act in the signed-in user's delegated Dataverse context. This server only does structural writes - route plain reads/reporting and text-only field edits (notes/descriptions) through your generic Dataverse tools instead.",
  "",
  "Typical flow: find_plan_by_name -> create_plan / add_bucket -> start_change_session -> add_tasks / update_tasks / delete_tasks_batch -> apply_changes -> get_plan_tasks_and_buckets to verify. apply_changes now WAITS for PSS to finish persisting (default up to 60s) and returns persisted:true when Completed, so a separate check_change_session_status poll is usually unnecessary; only poll it if apply_changes returns persisted:false with timedOut:true. Prefer the ergonomic add_tasks / update_tasks (plain lists, server builds the OData payload) over the raw add_tasks_batch / update_tasks_batch.",
  "",
  "Hard invariants (the server enforces these and will reject violations - do not work around them):",
  "1. Scheduling entities (msdyn_project/projecttask/projectbucket/projecttaskdependency/resourceassignment/projectsprint) are engine-managed. Change them ONLY through this server's change-session flow. NEVER create/delete them with generic Dataverse record tools - PSS silently discards direct inserts and the tasks vanish on refresh.",
  "2. A change session saves NOTHING until apply_changes completes (statusCode 192350003). Max 10 open sessions per user; max 200 items per batch. Call start_change_session and the batch in SEPARATE turns - never the same parallel block (causes duplicate-entity errors); submit each batch exactly once.",
  "3. Summary (parent) tasks: msdyn_start/finish/effort/progress/duration roll up from children and must not be written. First call get_plan_tasks_and_buckets, then pass its summaryTaskIds into update_tasks_batch. Renames/descriptions on summary tasks are fine.",
  "4. Target tasks by msdyn_projecttaskid GUID only, never by name (duplicate names are common). Resolve via get_plan_tasks_and_buckets; if a name matches more than one task, ask the user - never pick silently.",
  "5. Exact @odata.bind keys: msdyn_project, msdyn_projectbucket, msdyn_parenttask, and the PascalCase msdyn_PredecessorTask / msdyn_SuccessorTask for dependency links. NEVER msdyn_bucket / msdyn_projectbucketid / msdyn_parent / msdyn_parenttaskid, and NEVER the lowercase msdyn_predecessortask / msdyn_successortask (Dataverse rejects those as annotation-only properties). On a 'not a valid navigation property' error, use the corrected key the server names - do not retry the same payload.",
  "6. Hierarchy on create comes from msdyn_parenttask@odata.bind (parents before children in the batch), NOT msdyn_outlinelevel/displaysequence. New tasks are APPENDED (display order is blocked on create); exact reordering must be done in the Planner UI.",
  "7. msdyn_progress and actuals are rejected on create - set them in a follow-up update_tasks_batch session. msdyn_ismilestone is engine-managed: PSS rejects it on create AND on update (and auto-sets it on summary tasks), so it cannot be set via the API - point the user to the Planner UI for milestones. Dependencies cannot be updated - delete and recreate.",
  "8. delete_tasks_batch requires confirmed=true only after explicit per-record user confirmation. Whole-plan deletion is blocked - point the user to the Planner UI.",
  "9. After a write, treat get_plan_tasks_and_buckets as authoritative; if it returns truncated=true the read is incomplete - do not report success from it.",
  "Schema note: a plan's end date is msdyn_finish (not msdyn_scheduledend). Progress fields are 0-1 (0.5 = 50%); effort is in hours.",
  "Date range note: PSS clamps task dates to the plan's own start/finish range. Before adding tasks with explicit dates, set the plan's start/finish (via update on msdyn_project) to cover the full intended task date range — otherwise PSS silently normalises all task dates to the plan's current range.",
  "Description note: Dataverse sanitises task descriptions. Standard special characters round-trip (the read tools decode &quot;/&amp;/&lt;/&gt; back to \" & < > to match the Planner UI), but tag-like angle-bracket content (e.g. <2 weeks>) is STRIPPED before storage and cannot be recovered — do not rely on literal <...> text surviving in a description.",
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

  for (const tool of allTools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: toolAnnotations[tool.name],
      },
      async (args: unknown) => {
        const result = await tool.handler(args as any);
        const out: {
          content: { type: "text"; text: string }[];
          structuredContent?: Record<string, unknown>;
        } = {
          // Compact JSON - no pretty-print indentation (pure token waste for an
          // LLM consumer).
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
        // Provide structured output too when the result is a plain object, so
        // hosts can consume typed fields (projectId, operationSetId, taskRefs…)
        // without re-parsing the text.
        if (result && typeof result === "object" && !Array.isArray(result)) {
          out.structuredContent = result as Record<string, unknown>;
        }
        return out;
      },
    );
  }

  return server;
}
