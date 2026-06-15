import { z } from "zod";
import { getApiBase } from "../config.js";
import { dvReq, dvHeaders, dvPssErrorMessage, parsePssError, assertGuid } from "../dataverse.js";
import type { ToolDef } from "./types.js";

// Execute OperationSet - msdyn_ExecuteOperationSetV1 (commits the transaction, async)
export const applyChanges: ToolDef = {
  name: "apply_changes",
  title: "Apply Changes to Plan",
  description:
    "Saves (commits) all queued changes of a change session via msdyn_ExecuteOperationSetV1. Saving is ASYNCHRONOUS - after this call, poll 'Check Change Session Status' every ~5s until statusCode 192350003 (Completed). Never report success to the user before Completed.",
  inputSchema: {
    operationSetId: z.string().describe("GUID of the open OperationSet to commit."),
  },
  handler: async (input: { operationSetId: string }) => {
    const BASE = getApiBase();

    const operationSetId = assertGuid(input.operationSetId, "operationSetId");

    const response = await dvReq({
      url: BASE + "/msdyn_ExecuteOperationSetV1",
      method: "POST",
      headers: dvHeaders({ json: true }),
      body: { OperationSetId: operationSetId },
    });

    if (response.status >= 400) {
      const pss = parsePssError(response.json || {});
      const innerKey = pss?.innerKey ?? pss?.outerKey;
      if (innerKey === "E_LIMITEXCEEDED_TASKLEVEL") {
        const idx = pss?.failedBatchRequestIndex;
        throw new Error(
          "TASK_LEVEL_LIMIT_EXCEEDED: The plan has reached its PSS task-nesting depth limit." +
          (idx !== undefined ? " PSS rejected the operation at batch index " + idx + "." : "") +
          " Options: (a) use a shallower hierarchy in new tasks, (b) delete tasks to reduce depth," +
          " (c) create a new plan. Call get_plan_summary to check currentMaxOutlineLevel." +
          " [pssErrorKey=" + innerKey + "]",
        );
      }
      throw new Error(
        "execute_operation_set failed (" + response.status + "): " + dvPssErrorMessage(response),
      );
    }
    return {
      ok: true,
      operationSetId: operationSetId,
      note: "Execution accepted - PSS persists asynchronously. Poll 'Check Change Session Status' every ~5s until statusCode 192350003 (Completed) before telling the user it is done.",
    };
  },
};
