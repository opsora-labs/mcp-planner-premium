import { z } from "zod";
import { getApiBase } from "../config.js";
import { dvReq, dvHeaders, dvPssErrorMessage, parsePssError, assertGuid } from "../dataverse.js";
import { STATUS_MAP } from "./checkStatus.js";
import type { ToolDef } from "./types.js";

// OperationSet status codes (msdyn_status option set).
const COMPLETED = 192350003;
const FAILED = 192350002;
const ABANDONED = 192350004;

const DEFAULT_POLL_TIMEOUT_MS = 60_000;
const MAX_POLL_TIMEOUT_MS = 300_000;
const POLL_INTERVAL_MS = 3_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface PollResult {
  result: "completed" | "failed" | "abandoned" | "timeout";
  /** Last observed msdyn_status (undefined if every read errored). */
  statusCode: number | undefined;
  polls: number;
}

/**
 * Polls an operation set's status until it reaches a terminal state or the time
 * budget elapses. Pure and dependency-injected (no network/clock of its own) so
 * the apply_changes wait logic is unit-testable:
 *   - `getStatus` returns the current msdyn_status, or undefined on a read error
 *     (transient read failures are tolerated — we just keep polling).
 *   - `sleep`/`now` are injected so tests run instantly with a fake clock.
 * Always polls at least once. Stops before sleeping past the deadline.
 */
export async function pollOperationSet(
  getStatus: () => Promise<number | undefined>,
  opts: {
    timeoutMs: number;
    intervalMs: number;
    sleep: (ms: number) => Promise<void>;
    now?: () => number;
  },
): Promise<PollResult> {
  const now = opts.now ?? Date.now;
  const deadline = now() + opts.timeoutMs;
  let polls = 0;
  let statusCode: number | undefined;
  for (;;) {
    statusCode = await getStatus();
    polls++;
    if (statusCode === COMPLETED) return { result: "completed", statusCode, polls };
    if (statusCode === FAILED) return { result: "failed", statusCode, polls };
    if (statusCode === ABANDONED) return { result: "abandoned", statusCode, polls };
    // Still Open (192350000) / Executing (192350001), or a transient read error:
    // keep waiting unless the next interval would overshoot the deadline.
    if (now() + opts.intervalMs >= deadline) return { result: "timeout", statusCode, polls };
    await opts.sleep(opts.intervalMs);
  }
}

// Execute OperationSet - msdyn_ExecuteOperationSetV1 (commits the transaction, async)
export const applyChanges: ToolDef = {
  name: "apply_changes",
  title: "Apply Changes to Plan",
  description:
    "Saves (commits) all queued changes of a change session via msdyn_ExecuteOperationSetV1, then WAITS for PSS to finish persisting (polls internally up to pollTimeoutMs, default 60s). Returns persisted:true with statusCode 192350003 (Completed) once the changes are saved - so a single call is enough and you do NOT need to poll 'Check Change Session Status' yourself. If the wait elapses first, returns persisted:false with timedOut:true and the last known status - then poll 'Check Change Session Status' until Completed before reporting success. Throws if the operation set finishes Failed. Set pollTimeoutMs:0 to return immediately on acceptance (legacy behaviour) without waiting.",
  inputSchema: {
    operationSetId: z.string().describe("GUID of the open OperationSet to commit."),
    pollTimeoutMs: z
      .number()
      .optional()
      .describe(
        "Max time in ms to wait for PSS to finish persisting before returning. Default 60000 (60s); clamped to 300000 (5 min) max. The call blocks until the operation set is Completed (returns persisted:true) or this budget elapses (returns persisted:false, timedOut:true with the last status). Set 0 to skip waiting and return immediately on acceptance, then poll 'Check Change Session Status' yourself.",
      ),
  },
  handler: async (input: { operationSetId: string; pollTimeoutMs?: number }) => {
    const BASE = getApiBase();

    const operationSetId = assertGuid(input.operationSetId, "operationSetId");

    // Clamp the wait budget. 0 = legacy: return on acceptance without waiting.
    let pollTimeoutMs =
      typeof input.pollTimeoutMs === "number" ? input.pollTimeoutMs : DEFAULT_POLL_TIMEOUT_MS;
    if (!Number.isFinite(pollTimeoutMs) || pollTimeoutMs < 0) pollTimeoutMs = DEFAULT_POLL_TIMEOUT_MS;
    if (pollTimeoutMs > MAX_POLL_TIMEOUT_MS) pollTimeoutMs = MAX_POLL_TIMEOUT_MS;

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

    // Legacy opt-out: return immediately on acceptance without waiting.
    if (pollTimeoutMs === 0) {
      return {
        ok: true,
        operationSetId,
        persisted: false,
        note: "Execution accepted - PSS persists asynchronously (waiting was disabled via pollTimeoutMs:0). Poll 'Check Change Session Status' every ~5s until statusCode 192350003 (Completed) before telling the user it is done.",
      };
    }

    // Block until the operation set reaches a terminal state or the budget elapses.
    const poll = await pollOperationSet(
      async () => {
        const statusRes = await dvReq(
          {
            url: BASE + "/msdyn_operationsets(" + operationSetId + ")?$select=msdyn_status",
            method: "GET",
            headers: dvHeaders(),
          },
          { retry: true },
        );
        return statusRes.status < 400 ? statusRes.json?.msdyn_status : undefined;
      },
      { timeoutMs: pollTimeoutMs, intervalMs: POLL_INTERVAL_MS, sleep },
    );

    if (poll.result === "failed") {
      throw new Error(
        "execute_operation_set: the operation set finished with status Failed (192350002) - changes were NOT saved. Query msdyn_psserrorlogs for details. [operationSetId=" +
          operationSetId +
          "]",
      );
    }
    if (poll.result === "abandoned") {
      throw new Error(
        "execute_operation_set: the operation set is Abandoned (192350004) - changes were NOT saved. [operationSetId=" +
          operationSetId +
          "]",
      );
    }
    if (poll.result === "completed") {
      return {
        ok: true,
        operationSetId,
        statusCode: COMPLETED,
        status: STATUS_MAP[COMPLETED],
        persisted: true,
        polls: poll.polls,
        note: "All changes persisted to Dataverse (operation set Completed). Reads can still lag a few seconds, so allow a brief pause (or retry once) before treating get_plan_tasks_and_buckets as authoritative.",
      };
    }

    // Timed out before Completed — return the last known status as a safe partial
    // result so the caller can confirm via 'Check Change Session Status'.
    return {
      ok: true,
      operationSetId,
      statusCode: poll.statusCode ?? null,
      status:
        poll.statusCode !== undefined
          ? STATUS_MAP[poll.statusCode] ?? "Unknown(" + poll.statusCode + ")"
          : "Pending",
      persisted: false,
      timedOut: true,
      polls: poll.polls,
      note:
        "Execution accepted but not confirmed Completed within pollTimeoutMs (" +
        pollTimeoutMs +
        " ms). PSS is still persisting - poll 'Check Change Session Status' until statusCode 192350003 (Completed) before telling the user it is done.",
    };
  },
};
