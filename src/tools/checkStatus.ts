import { z } from "zod";
import { getApiBase } from "../config.js";
import { dvReq, dvHeaders, dvErrorMessage, assertGuid } from "../dataverse.js";
import type { ToolDef } from "./types.js";

export const STATUS_MAP: Record<number, string> = {
  192350000: "Open",
  192350001: "Executing",
  192350002: "Failed",
  192350003: "Completed",
  192350004: "Abandoned",
};

// Get OperationSet Status - poll msdyn_operationsets (or list open sets if no ID given)
export const checkStatus: ToolDef = {
  name: "check_change_session_status",
  title: "Check Change Session Status",
  description:
    "With operationSetId: returns the save status of a change session (192350000 Open, 192350001 Executing, 192350002 Failed, 192350003 Completed/saved, 192350004 Abandoned (cancelled)). The returned 'status' string for 192350004 is \"Abandoned\". Without ID: lists the user's OPEN sessions for housekeeping. Use after 'Apply Changes to Plan' (poll until Completed) and before starting new sessions when near the 10-session limit.",
  inputSchema: {
    operationSetId: z
      .string()
      .optional()
      .describe("GUID to check. Leave empty to list all open sets (housekeeping mode)."),
  },
  handler: async (input: { operationSetId?: string }) => {
    const BASE = getApiBase();
    const headers = dvHeaders();

    const id = (input.operationSetId || "").trim();
    if (id) assertGuid(id, "operationSetId");

    if (id) {
      const response = await dvReq(
        {
          url:
            BASE +
            "/msdyn_operationsets(" +
            id +
            ")?$select=msdyn_status,msdyn_description,modifiedon",
          method: "GET",
          headers: headers,
        },
        { retry: true },
      );
      const body = response.json || {};
      if (response.status >= 400) {
        throw new Error(
          "status query failed (" + response.status + "): " + dvErrorMessage(response),
        );
      }
      const code = body.msdyn_status;
      return {
        ok: true,
        operationSetId: id,
        statusCode: code,
        status: STATUS_MAP[code] || "Unknown(" + code + ")",
        persisted: code === 192350003,
        hint:
          code === 192350003
            ? "All changes persisted to Dataverse. Run Tier-1 verification via the Dataverse MCP integration now."
            : code === 192350002
              ? "Failed - query msdyn_psserrorlogs for details."
              : "Not finished - poll again in 5 seconds.",
      };
    }

    // List mode: open sets for housekeeping
    const response = await dvReq(
      {
        url:
          BASE +
          "/msdyn_operationsets?$select=msdyn_operationsetid,msdyn_status,msdyn_description,createdon&$filter=msdyn_status eq 192350000&$top=10",
        method: "GET",
        headers: headers,
      },
      { retry: true },
    );
    const body = response.json || {};
    if (response.status >= 400) {
      throw new Error(
        "list query failed (" + response.status + "): " + dvErrorMessage(response),
      );
    }
    // Map to clean camelCase, consistent with the other tools.
    const openSets = (body.value || []).map((s: any) => ({
      operationSetId: s.msdyn_operationsetid,
      statusCode: s.msdyn_status,
      status: STATUS_MAP[s.msdyn_status] || "Unknown(" + s.msdyn_status + ")",
      description: s.msdyn_description,
      createdOn: s.createdon,
    }));
    return {
      ok: true,
      mode: "list_open",
      openSets,
      hint: "Cancel stale sessions via 'Cancel Change Session' to stay under the 10-session limit.",
    };
  },
};
