import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { ToolDef } from "./types.js";
import { createPlan } from "./createPlan.js";
import { addBucket } from "./addBucket.js";
import { addSprint } from "./addSprint.js";
import { startChangeSession } from "./startChangeSession.js";
import { addTasksSimple } from "./addTasksSimple.js";
import { addTasks } from "./addTasks.js";
import { updateTasksSimple } from "./updateTasksSimple.js";
import { updateTasks } from "./updateTasks.js";
import { deleteTasks } from "./deleteTasks.js";
import { assignTask } from "./assignTask.js";
import { applyChanges } from "./applyChanges.js";
import { checkStatus } from "./checkStatus.js";
import { cancelSession } from "./cancelSession.js";
import { findPlan } from "./findPlan.js";
import { findTeamMember } from "./findTeamMember.js";
import { findTeamMemberAcrossPlans } from "./findTeamMemberAcrossPlans.js";
import { getPlanContents } from "./getPlanContents.js";
import { whoami } from "./whoami.js";
import { listPlans } from "./listPlans.js";
import { listMyTasks } from "./listMyTasks.js";
import { listUserTasks } from "./listUserTasks.js";
import { getPlanSummary } from "./getPlanSummary.js";
import { getTask } from "./getTask.js";
import { listPlanTasks } from "./listPlanTasks.js";
import { searchPlanTasks } from "./searchPlanTasks.js";
import { getBucketBreakdown } from "./getBucketBreakdown.js";
import { listDependencies } from "./listDependencies.js";
import { listTeamMembers } from "./listTeamMembers.js";
import { describeOptionSet } from "./describeOptionSet.js";
import { getCriticalPath } from "./getCriticalPath.js";
import { getScheduleHealth } from "./getScheduleHealth.js";
import { getResourceWorkload } from "./getResourceWorkload.js";

/**
 * All tools, in the natural workflow order. The 12 ports of the Langdock
 * actions plus a `whoami` diagnostic (replacement for the OAuth auth-test
 * snippet, which has no MCP equivalent).
 */
export const allTools: ToolDef[] = [
  createPlan,
  addBucket,
  addSprint,
  startChangeSession,
  addTasksSimple,
  addTasks,
  updateTasksSimple,
  updateTasks,
  deleteTasks,
  assignTask,
  applyChanges,
  checkStatus,
  cancelSession,
  findPlan,
  findTeamMember,
  findTeamMemberAcrossPlans,
  getPlanContents,
  whoami,
  // Reporting / read tools (replace the generic Dataverse MCP for the Planner
  // workflow). All read-only.
  listPlans,
  listMyTasks,
  listUserTasks,
  getPlanSummary,
  getTask,
  listPlanTasks,
  searchPlanTasks,
  getBucketBreakdown,
  listDependencies,
  listTeamMembers,
  describeOptionSet,
  // Analytics tools (schedule & resource insights)
  getCriticalPath,
  getScheduleHealth,
  getResourceWorkload,
];

/**
 * Behavioural hints per tool (MCP tool annotations). Advisory only - they help
 * a host present/confirm tools correctly; they are NOT a security boundary (the
 * in-code `confirmed` gate and guardrails remain authoritative). Every tool is
 * openWorldHint:true because they all call the external Dataverse API.
 */
const RO = { readOnlyHint: true, openWorldHint: true } as const;
const ADD = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;
const UPDATE = { readOnlyHint: false, destructiveHint: true, openWorldHint: true } as const;

export const toolAnnotations: Record<string, ToolAnnotations> = {
  // Reads
  find_plan_by_name: RO,
  find_team_member: RO,
  find_team_member_across_plans: RO,
  get_plan_tasks_and_buckets: RO,
  check_change_session_status: RO,
  whoami: RO,
  list_plans: RO,
  list_my_tasks: RO,
  list_user_tasks: RO,
  get_plan_summary: RO,
  get_task: RO,
  list_plan_tasks: RO,
  search_plan_tasks: RO,
  get_bucket_breakdown: RO,
  list_dependencies: RO,
  list_team_members: RO,
  describe_option_set: RO,
  get_critical_path: RO,
  get_schedule_health: RO,
  get_resource_workload: RO,
  // Additive writes (create new records, don't overwrite/remove existing data)
  create_plan: ADD,
  add_bucket: ADD,
  add_sprint: ADD,
  add_tasks: ADD,
  add_tasks_batch: ADD,
  start_change_session: ADD,
  assign_task: UPDATE,
  // Updates (overwrite existing field values)
  update_tasks: UPDATE,
  update_tasks_batch: UPDATE,
  // Irreversible / destructive
  apply_changes: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  cancel_change_session: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  delete_tasks_batch: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
};
