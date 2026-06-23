import { z } from "zod";

/** Token-safe redaction. Never log or print a bearer value. */
export function redact(s: string): string {
  if (!s) return s;
  if (s.length <= 12) return "[REDACTED]";
  return s.slice(0, 6) + "…[REDACTED]…" + s.slice(-4);
}

const EnvSchema = z.object({
  /** Delegated Dataverse access token (never logged). */
  E2E_ACCESS_TOKEN: z.string().min(10),
  /** MCP server URL. Falls back to booting a local server. */
  MCP_URL: z.string().url().optional(),
  /** Dataverse org URL — used for independent OData verification reads. */
  DATAVERSE_ORG_URL: z.string().url().transform((s) => s.replace(/\/+$/, "")),
  /** Set to "true" to enable mutating writes. Default: read-only. */
  E2E_ALLOW_WRITES: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  /** Anthropic API key — only required for the agentic layer. */
  ANTHROPIC_API_KEY: z.string().optional(),
  /** Enable the agentic exploratory pass. Requires ANTHROPIC_API_KEY. */
  E2E_AGENTIC: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  /** Timeout per individual MCP tool call (ms). */
  E2E_TOOL_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  /** Maximum polls when waiting for status 192350003 (Completed). */
  E2E_MAX_POLLS: z.coerce.number().int().positive().default(20),
  /** Seconds between status polls. */
  E2E_POLL_INTERVAL_S: z.coerce.number().int().positive().default(5),
  /** Port for the local server when MCP_URL is not set. */
  PORT: z.coerce.number().int().positive().default(4000),

  // ── Seed harness flags (test/e2e/seedRun.ts) ────────────────────────────────
  /**
   * Prefer reuse/resume of the named seed plan over a fresh build.
   * Default: true (warm path). Set to "false" to force a fresh disposable plan
   * per run (legacy fresh-plan behaviour).
   */
  REUSE_SEED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  /**
   * Force a complete cold rebuild of the seed plan, deleting the stale plan
   * out-of-band if one exists. Takes precedence over REUSE_SEED.
   */
  REBUILD_SEED: z
    .enum(["true", "false", "1", "0"])
    .default("false")
    .transform((v) => v === "true" || v === "1"),
  /**
   * Name of the long-lived seed plan in Dataverse.
   * Default: ZZ-MCP-SEED-itboard (never swept by cleanup-e2e-plans.ts).
   */
  SEED_PLAN_NAME: z.string().default("ZZ-MCP-SEED-itboard"),
  /**
   * Run only scenarios whose `feature` field matches this value.
   * When unset all scenarios run.
   */
  FEATURE: z.string().optional(),
  /**
   * Keep the seed plan even after a fully-green run.
   * Also honoured wherever the e2e harness creates a disposable plan.
   */
  KEEP_PLAN: z
    .enum(["true", "false", "1", "0"])
    .default("false")
    .transform((v) => v === "true" || v === "1"),
});

export type E2EConfig = z.infer<typeof EnvSchema>;

let _cfg: E2EConfig | null = null;

export function getConfig(): E2EConfig {
  if (!_cfg) _cfg = EnvSchema.parse(process.env);
  return _cfg;
}

export function resetConfig(): void {
  _cfg = null;
}
