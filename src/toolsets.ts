/**
 * Toolset group → tool-name map.
 *
 * Every registered tool belongs to ≥1 group. A map-integrity check flags any gap
 * between this map and the registered tool set, so a tool added without a group
 * (or a group entry with no matching tool) is caught in tests.
 *
 * Groups:
 *   reporting  — read-only reporting / list views
 *   discovery  — read-only lookup / identity
 *   sessions   — change-session lifecycle (write/session)
 *   write      — structural write tools
 *   analytics  — curated "insights" subset (overlaps reporting intentionally)
 */
export const TOOLSETS: Record<string, readonly string[]> = {
  reporting: [
    "list_plans",
    "list_my_tasks",
    "list_user_tasks",
    "get_plan_summary",
    "get_task",
    "list_plan_tasks",
    "search_plan_tasks",
    "get_bucket_breakdown",
    "list_dependencies",
  ],
  discovery: [
    "find_plan_by_name",
    "find_team_member",
    "find_team_member_across_plans",
    "get_plan_tasks_and_buckets",
    "list_team_members",
    "whoami",
    "describe_option_set",
    "list_custom_columns",
    "describe_columns",
  ],
  sessions: [
    "start_change_session",
    "apply_changes",
    "check_change_session_status",
    "cancel_change_session",
  ],
  write: [
    "create_plan",
    "add_bucket",
    "add_sprint",
    "add_tasks",
    "add_tasks_batch",
    "update_tasks",
    "update_tasks_batch",
    "delete_tasks_batch",
    // Forward-references — not yet registered; added here for later-wave integration.
    "assign_task",
  ],
  analytics: [
    "get_plan_summary",
    "get_bucket_breakdown",
    "list_dependencies",
    "list_plan_tasks",
    // Registered in the read/analytics wave.
    "get_critical_path",
    "get_schedule_health",
    "get_resource_workload",
  ],
} as const;
