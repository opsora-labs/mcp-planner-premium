/**
 * E2E test runner — entry point for `npm run e2e`.
 *
 * Usage:
 *   DATAVERSE_ORG_URL=https://contoso.crm.dynamics.com \
 *   E2E_ACCESS_TOKEN=<delegated-dataverse-token>   \
 *   [MCP_URL=https://your-server/mcp]              \  # omit to boot locally
 *   [E2E_ALLOW_WRITES=true]                         \  # default: read-only
 *   [E2E_AGENTIC=true ANTHROPIC_API_KEY=sk-ant-…]  \  # optional agentic layer
 *   npm run e2e
 *
 * Security: E2E_ACCESS_TOKEN is only held in memory and redacted from logs.
 * The report file is written to e2e-report-<UTC>.md in the project root.
 */

import { createServer, type Server } from "node:http";
import { writeFile, mkdir } from "node:fs/promises";
import { getConfig, redact } from "./config.js";
import { stepLog, clearLog } from "./steps.js";
import type { StepContext } from "./steps.js";
import { mcpInitialize } from "./mcpClient.js";
import { runPreflight } from "./scenarios/preflight.js";
import { runReadSweep } from "./scenarios/readSweep.js";
import { runLifecycle } from "./scenarios/lifecycle.js";
import { runGuardrails } from "./scenarios/guardrails.js";
import { runCustomColumns } from "./scenarios/customColumns.js";
import { runAgentic } from "./agentic.js";
import { renderReport } from "./report.js";
import type { RunSummary } from "./report.js";

async function bootLocalServer(port: number): Promise<Server> {
  // Import the app factory (same code the production server uses).
  const { buildApp } = await import("../../src/app.js");
  const app = buildApp();
  return new Promise((resolve, reject) => {
    const srv = createServer(app);
    srv.listen(port, () => resolve(srv));
    srv.once("error", reject);
  });
}

async function main(): Promise<void> {
  const runAt = new Date().toISOString();
  const cfg = getConfig();
  clearLog();

  console.log(`\n${"=".repeat(70)}`);
  console.log("  MCP Planner Premium — E2E Acceptance Test");
  console.log(`${"=".repeat(70)}`);
  console.log(`  Token  : ${redact(cfg.E2E_ACCESS_TOKEN)}`);
  console.log(`  Writes : ${cfg.E2E_ALLOW_WRITES}`);
  console.log(`  Agentic: ${cfg.E2E_AGENTIC}`);
  console.log(`  Org    : ${cfg.DATAVERSE_ORG_URL}`);

  // ── 1. Resolve / boot server ──────────────────────────────────────────
  let mcpUrl = cfg.MCP_URL ?? "";
  let localServer: Server | null = null;

  if (!mcpUrl) {
    const port = cfg.PORT;
    console.log(`\n  No MCP_URL — booting local server on :${port} (AUTH_MODE=insecure-passthrough)`);
    process.env.AUTH_MODE = "insecure-passthrough";
    localServer = await bootLocalServer(port);
    mcpUrl = `http://localhost:${port}/mcp`;
  }
  console.log(`  MCP URL: ${mcpUrl}\n`);

  const ctx: StepContext = { mcpUrl, bearer: cfg.E2E_ACCESS_TOKEN };

  // ── 2. Initialize MCP ─────────────────────────────────────────────────
  await mcpInitialize(mcpUrl, cfg.E2E_ACCESS_TOKEN);

  const t0 = Date.now();
  let manifest;
  let agenticResult;
  let preflight;

  try {
    // ── Phase 0: Preflight (always) ───────────────────────────────────
    console.log("Phase 0: Preflight...");
    try {
      preflight = await runPreflight(ctx);
      console.log(`  ✅  ${preflight.toolsAdvertised.length} tools, userId ${preflight.userId}`);
    } catch (e) {
      console.error("  ❌  Preflight FAILED — aborting.", e);
      process.exitCode = 1;
      return;
    }

    // ── Phase 1: Read sweep (always) ──────────────────────────────────
    console.log("Phase 1: Read sweep...");
    try {
      await runReadSweep(ctx);
      const r = stepLog.filter((s) => s.status === "fail" && s.name.toLowerCase().includes("read"));
      console.log(`  ${r.length === 0 ? "✅" : "❌"}  ${stepLog.filter((s) => s.status === "pass").length} pass / ${r.length} fail`);
    } catch (e) {
      console.warn("  ⚠️  Read sweep partial failure:", (e as Error).message);
    }

    // ── Phase 2: Write lifecycle (gated) ──────────────────────────────
    if (cfg.E2E_ALLOW_WRITES) {
      console.log("Phase 2: Write lifecycle...");
      try {
        manifest = await runLifecycle(ctx);
        const fails = stepLog.filter((s) => s.status === "fail").length;
        console.log(`  ${fails === 0 ? "✅" : "❌"}  lifecycle done; leftover plan: ${manifest.planName}`);
      } catch (e) {
        console.warn("  ⚠️  Lifecycle failed:", (e as Error).message);
      }
    } else {
      console.log("Phase 2: Write lifecycle — SKIPPED (E2E_ALLOW_WRITES not set)");
      stepLog.push({
        name: "write lifecycle — skipped (E2E_ALLOW_WRITES not set)",
        status: "skip",
        latencyMs: 0,
        skipped: "Set E2E_ALLOW_WRITES=true to run the full write lifecycle",
      });
    }

    // ── Phase 3: Guardrails (always — no writes needed) ───────────────
    console.log("Phase 3: Guardrails (negative tests)...");
    try {
      await runGuardrails(ctx);
      const g = stepLog.filter((s) => s.name.toLowerCase().includes("rejected") || s.name.toLowerCase().includes("refused") || s.name.toLowerCase().includes("blocked") || s.name.toLowerCase().includes("confirmed") || s.name.toLowerCase().includes("cycle") || s.name.toLowerCase().includes("duplicate") || s.name.toLowerCase().includes("disallowed") || s.name.toLowerCase().includes(">200") || s.name.toLowerCase().includes("out of range"));
      const gFired = g.filter((s) => s.status === "pass").length;
      console.log(`  ✅  ${gFired}/${g.length} guardrails fired correctly`);
    } catch (e) {
      console.warn("  ⚠️  Guardrail phase error:", (e as Error).message);
    }

    // ── Phase 5: Custom Dataverse columns (gated, SKIPPED by default) ──
    // No target tenant used for e2e/CI has real custom columns, so every step
    // here reports status "skip" with a documented reason unless the operator
    // has seeded a column and set E2E_CUSTOM_COLUMN_TASK_STRING (see
    // scenarios/customColumns.ts header). Never requires or assumes a live
    // custom column; safe to run unconditionally.
    console.log("Phase 5: Custom Dataverse columns (gated)...");
    try {
      const target =
        manifest && manifest.projectId && manifest.createdTaskIds.length > 0
          ? { projectId: manifest.projectId, taskId: manifest.createdTaskIds[0] }
          : undefined;
      await runCustomColumns(ctx, target);
    } catch (e) {
      console.warn("  ⚠️  Custom-columns phase error:", (e as Error).message);
    }

    // ── Phase 4: Agentic (optional) ───────────────────────────────────
    console.log("Phase 4: Agentic exploratory pass...");
    agenticResult = await runAgentic(ctx);
    if (agenticResult.skipped) {
      console.log(`  ⏭️  Skipped — ${agenticResult.reason}`);
    } else {
      console.log(`  ${agenticResult.descriptionUsabilityPassed ? "✅" : "❌"}  Usability pass: ${agenticResult.descriptionUsabilityPassed}`);
    }
  } finally {
    // ── Shutdown local server ──────────────────────────────────────────
    if (localServer) {
      await new Promise<void>((r) => localServer!.close(() => r()));
    }
  }

  // ── 3. Render report ─────────────────────────────────────────────────
  const durationMs = Date.now() - t0;
  const totalFails = stepLog.filter((s) => s.status === "fail").length;

  const summary: RunSummary = {
    runAt,
    orgUrl: cfg.DATAVERSE_ORG_URL,
    serverUrl: mcpUrl,
    serverVersion: "1.0.0",
    protocol: "2025-03-26",
    toolsAdvertised: preflight?.toolsAdvertised.length ?? 0,
    userId: preflight?.userId,
    writeMode: cfg.E2E_ALLOW_WRITES,
    durationMs,
    steps: stepLog,
    agenticResult,
    manifest: manifest ? { planName: manifest.planName, projectId: manifest.projectId, leftoverNotes: manifest.leftoverNotes } : undefined,
  };

  const report = renderReport(summary);
  await mkdir("reports", { recursive: true });
  const reportFile = `reports/e2e-report-${runAt.replace(/[:.]/g, "-").slice(0, 19)}.md`;
  await writeFile(reportFile, report, "utf-8");

  // ── 4. Console summary + exit ─────────────────────────────────────────
  console.log(`\n${"=".repeat(70)}`);
  console.log(`  Result : ${totalFails === 0 ? "✅  ALL PASS" : `❌  ${totalFails} FAILURE(S)`}`);
  console.log(`  Report : ${reportFile}`);
  console.log(`  Steps  : ${stepLog.filter((s) => s.status === "pass").length} pass / ${totalFails} fail / ${stepLog.filter((s) => s.status === "skip").length} skip`);
  console.log(`  Time   : ${(durationMs / 1000).toFixed(1)}s`);
  console.log(`${"=".repeat(70)}\n`);

  process.exit(totalFails > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("E2E runner crashed:", e);
  process.exit(2);
});
