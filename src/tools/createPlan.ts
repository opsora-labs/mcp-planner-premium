import { z } from "zod";
import { getApiBase, getCustomColumnsMode } from "../config.js";
import { dvReq, dvHeaders, dvErrorMessage } from "../dataverse.js";
import { getEntityMetadata } from "../dataverse/metadata.js";
import { spliceCustomFields, type ResolveCustomColumn } from "./addTasksSimple.js";
import type { ToolDef } from "./types.js";

// Create Premium Plan - msdyn_CreateProjectV1 (runs immediately, creates default bucket)
export const createPlan: ToolDef = {
  name: "create_plan",
  title: "Create New Plan",
  description:
    "Creates a new Planner Premium plan (project) in the signed-in user's context via msdyn_CreateProjectV1. Runs immediately - no change session needed - and auto-creates the default bucket 'Bucket 1'. Returns the projectId needed by all other actions. Use FIRST when building a new plan, then add buckets, then start a change session for tasks. " +
    "customFields (custom, non-msdyn_ columns) is UNVERIFIED against a live tenant - msdyn_CreateProjectV1 may reject custom columns on create even when metadata reports them as valid-for-create; if it does, set them afterwards via update_tasks_batch on the msdyn_project entity instead.",
  inputSchema: {
    subject: z.string().describe("Plan name (visible in Planner)."),
    description: z.string().optional().describe("Optional plan description."),
    scheduledStart: z
      .string()
      .optional()
      .describe(
        "Optional ISO start date, e.g. 2026-07-01. Must be a working day in the project calendar.",
      ),
    customFields: z
      .record(z.unknown())
      .optional()
      .describe(
        "Custom (non-msdyn_) Dataverse column values on the new plan, keyed by logical name. Requires CUSTOM_COLUMNS_MODE!=off on the server. UNVERIFIED-LIVE: msdyn_CreateProjectV1 may reject custom columns even when metadata says they're valid for create (this server has no tenant with real custom columns to prove it against) - if create fails because of a customFields value, retry without customFields and set them afterwards via update_tasks_batch (@odata.type Microsoft.Dynamics.CRM.msdyn_project) instead.",
      ),
  },
  handler: async (input: {
    subject: string;
    description?: string;
    scheduledStart?: string;
    customFields?: Record<string, unknown>;
  }) => {
    const BASE = getApiBase();

    const subject = (input.subject || "").trim();
    if (!subject) throw new Error("subject is required (plan name).");

    const project: Record<string, unknown> = {
      "@odata.type": "Microsoft.Dynamics.CRM.msdyn_project",
      msdyn_subject: subject,
    };
    if (input.description) project.msdyn_description = input.description;
    if (input.scheduledStart) project.msdyn_scheduledstart = input.scheduledStart;

    // Custom (non-msdyn_) columns — see the UNVERIFIED-LIVE caveat above.
    if (input.customFields && Object.keys(input.customFields).length > 0) {
      if (getCustomColumnsMode() === "off")
        throw new Error(
          "customFields was provided but CUSTOM_COLUMNS_MODE is 'off' on this server. Ask the server operator to set CUSTOM_COLUMNS_MODE=metadata (or metadata+allowlist), or remove customFields.",
        );
      const entityMeta = await getEntityMetadata("msdyn_project");
      const resolveCustomColumn: ResolveCustomColumn = (logicalName: string) =>
        entityMeta.columns.get(logicalName);
      spliceCustomFields(project, input.customFields, "create", resolveCustomColumn, "plan");
    }

    const response = await dvReq({
      url: BASE + "/msdyn_CreateProjectV1",
      method: "POST",
      headers: dvHeaders({ json: true }),
      body: { Project: project },
    });

    const body = response.json || {};
    if (response.status >= 400) {
      const msg = dvErrorMessage(response);
      if (response.status === 403)
        throw new Error(
          "403 - Your account lacks a Planner/Project license or Dataverse privileges: " +
            msg,
        );
      throw new Error("create_project failed (" + response.status + "): " + msg);
    }
    return {
      ok: true,
      projectId: body.ProjectId,
      note: "Plan created with default bucket 'Bucket 1'. Runs in YOUR user context.",
    };
  },
};
