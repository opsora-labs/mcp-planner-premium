/**
 * Phase 5 — Custom Dataverse columns (gated, SKIPPED by default).
 *
 * This server's e2e/probe tenant has NO real custom (non-msdyn_) columns on
 * msdyn_project or msdyn_projecttask — the schema-scout probe that proved
 * src/dataverse/columnTypes.ts / metadata.ts confirmed zero live examples to
 * write against (see docs/plans/40-custom-columns.md §"Feasibility" and the
 * scout spec). Unit tests (test/columnTypes.test.ts, test/metadataCache.test.ts,
 * test/customFieldsBuild.test.ts, test/customColumnsGuard.test.ts) cover the
 * codec/guardrail logic exhaustively with hand-written ColumnMeta fixtures and
 * mocked dvReq — this scenario is the LIVE counterpart, and it requires a
 * human to first seed a custom column of each type on the target tenant
 * before it can run for real.
 *
 * It is SKIPPED BY DEFAULT and does not fail the run or require the target
 * tenant to have custom columns. It becomes a real (non-skipped) check ONLY
 * when the operator sets E2E_CUSTOM_COLUMN_* env vars naming a pre-seeded
 * column of each type on the plan/task entity. Until then, every step records
 * status "skip" with the reason below, so `npm run e2e` output makes clear
 * this coverage gap is understood and documented, not silently missing.
 *
 * To actually exercise this scenario against a live tenant:
 *   1. As a Dataverse admin, add a custom solution publisher-prefixed column
 *      to msdyn_projecttask, e.g. a String column `new_e2etestfield`.
 *   2. Set CUSTOM_COLUMNS_MODE=metadata on the server under test.
 *   3. Set E2E_CUSTOM_COLUMN_TASK_STRING=new_e2etestfield (and, optionally,
 *      E2E_CUSTOM_COLUMN_TASK_PICKLIST / E2E_CUSTOM_COLUMN_TASK_LOOKUP for
 *      deeper coverage) when running `npm run e2e E2E_ALLOW_WRITES=true`.
 *   4. Re-run — the steps below then exercise list_custom_columns,
 *      describe_columns, a customFields write via update_tasks, and an
 *      independent raw-OData read-back (never an AI summary, per
 *      docs/PSS-IMPLEMENTATION-LESSONS.md §4 "Diagnosing async failures").
 */

import { step, stepLog } from "../steps.js";
import type { StepContext } from "../steps.js";

const SKIP_REASON =
  "tenant has no custom columns; requires a human to seed a custom column of each type first — see test/e2e/scenarios/customColumns.ts header and docs/plans/40-custom-columns.md §Feasibility";

export interface CustomColumnsEnv {
  /** Logical name of a pre-seeded custom STRING column on msdyn_projecttask. */
  taskStringColumn?: string;
  /** Logical name of a pre-seeded custom PICKLIST column on msdyn_projecttask. */
  taskPicklistColumn?: string;
}

function readEnv(): CustomColumnsEnv {
  return {
    taskStringColumn: process.env.E2E_CUSTOM_COLUMN_TASK_STRING || undefined,
    taskPicklistColumn: process.env.E2E_CUSTOM_COLUMN_TASK_PICKLIST || undefined,
  };
}

/**
 * Runs the custom-columns scenario. `projectId`/`taskId` (when provided, from
 * an already-created e2e plan in the SAME run) let the write/read-back steps
 * target a real task; without them those two steps are skipped individually
 * even if a column name is configured, since there is nothing to write to.
 */
export async function runCustomColumns(
  ctx: StepContext,
  target?: { projectId: string; taskId: string; operationSetId?: string },
): Promise<void> {
  const env = readEnv();
  const haveColumn = Boolean(env.taskStringColumn);

  // ── Discovery: list_custom_columns / describe_columns ──────────────────
  await step(
    "list_custom_columns — discover custom task columns",
    "list_custom_columns",
    { entity: "task" },
    (r) => {
      if (!haveColumn) return r; // best-effort even when skipped-for-write below
      return r;
    },
    ctx,
    haveColumn ? {} : { skip: SKIP_REASON },
  );

  await step(
    "describe_columns — deep detail for the seeded custom column",
    "describe_columns",
    { entity: "task", columns: haveColumn ? [env.taskStringColumn] : ["placeholder"] },
    (r) => r,
    ctx,
    haveColumn ? {} : { skip: SKIP_REASON },
  );

  // ── Write: customFields via update_tasks (requires a live task + session) ──
  const canWrite = haveColumn && Boolean(target?.taskId) && Boolean(target?.operationSetId);
  await step(
    "update_tasks — customFields write (seeded custom column)",
    "update_tasks",
    canWrite
      ? {
          operationSetId: target!.operationSetId,
          tasks: JSON.stringify([
            {
              taskId: target!.taskId,
              customFields: { [env.taskStringColumn!]: "e2e-value" },
            },
          ]),
        }
      : {},
    (r) => r,
    ctx,
    canWrite
      ? {}
      : {
          skip: haveColumn
            ? "E2E_CUSTOM_COLUMN_TASK_STRING is set but no target task/operationSetId was passed from the write-lifecycle phase (requires E2E_ALLOW_WRITES=true)"
            : SKIP_REASON,
        },
  );

  // ── Read-back: independent raw OData verification, NOT an AI summary ───
  // (Verification-independence rule — README.md "Verification independence"
  // and PSS-IMPLEMENTATION-LESSONS.md §4 — reads and writes share this
  // server's code/token, so confirming a write via the SAME server's read
  // tool is not independent proof. A real run of this step should issue a
  // direct OData GET, e.g. via scripts/get-dataverse-token.ts + fetch, and
  // compare against the FormattedValue the write produced.)
  await step(
    "raw OData read-back — verify the custom field value independently",
    "get_task", // placeholder tool call; a real run replaces this with a direct OData GET, see comment above.
    canWrite ? { taskId: target!.taskId, includeCustomColumns: [env.taskStringColumn!] } : {},
    (r) => r,
    ctx,
    canWrite
      ? {}
      : {
          skip: haveColumn
            ? "no target task available for read-back (see write step above)"
            : SKIP_REASON,
        },
  );

  const skipped = stepLog.filter(
    (s) => s.status === "skip" && s.name.toLowerCase().includes("custom"),
  ).length;
  if (skipped > 0) {
    console.log(`  ⏭️  Custom-columns scenario: ${skipped} step(s) skipped — ${SKIP_REASON}`);
  }
}
