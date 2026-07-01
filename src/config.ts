import { z } from "zod";

/**
 * Coerces common string representations of booleans to a JS boolean.
 * Accepts (case-insensitive): true/1/yes/on → true; false/0/no/off/"" → false.
 * Throws a Zod issue for any other value (fail-fast).
 *
 * Used as a .transform() callback; the input type is the output of the preceding
 * z.union([z.boolean(), z.string(), z.undefined()]).optional().default(false),
 * which is boolean | string (after .default() removes undefined from the domain).
 */
function coerceBool(
  value: boolean | string,
  ctx: z.RefinementCtx,
): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const lower = value.toLowerCase().trim();
    if (lower === "" || lower === "false" || lower === "0" || lower === "no" || lower === "off") {
      return false;
    }
    if (lower === "true" || lower === "1" || lower === "yes" || lower === "on") {
      return true;
    }
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Invalid boolean value "${value}". Expected true/false/1/0/yes/no/on/off.`,
    });
    return z.NEVER;
  }
  // Fallback (should be unreachable given the union above)
  return false;
}

/**
 * Environment configuration, validated ONCE with a zod schema. Validation is
 * lazy + cached (getEnv) so importing a tool module for unit testing does not
 * require the full runtime env, but the HTTP entrypoint calls getEnv() at boot
 * to fail fast (a bad value crashes the container loudly instead of failing
 * per-request).
 */
const EnvSchema = z
  .object({
    // Dataverse environment, e.g. https://contoso.crm.dynamics.com
    DATAVERSE_ORG_URL: z
      .string()
      .url()
      .transform((s) => s.replace(/\/+$/, "")),

    // Port the server listens on inside the container. ACA (and any other cloud
    // ingress) terminates TLS externally, so the container only ever receives
    // plain HTTP. Default 3000; no privileged port or special Linux capabilities
    // needed. Override for local dev if 3000 is taken.
    PORT: z.coerce.number().int().positive().default(3000),

    // Inbound-token policy:
    //   validate (default) - cryptographically verify the bearer (jose) before
    //                        forwarding it to Dataverse. Requires TENANT_ID.
    //   insecure-passthrough - skip verification (LOCAL DEV / MCP Inspector only).
    AUTH_MODE: z.enum(["validate", "insecure-passthrough"]).default("validate"),

    // Entra tenant that issues the tokens (GUID). Required when AUTH_MODE=validate.
    TENANT_ID: z.string().optional(),

    // Application (client) id of the MCP host's Entra app registration (the same
    // value the MCP client uses as its OAuth client ID). When set, the inbound
    // token's appid/azp must match it — rejects tokens from any other app.
    ENTRA_CLIENT_ID: z.string().optional(),

    // DNS-rebinding protection for the Streamable-HTTP transport. Comma lists.
    // The ACA FQDN is auto-derived at runtime, so ALLOWED_HOSTS is only needed
    // for EXTRA hosts (e.g. a custom domain) or when self-hosting outside ACA.
    ALLOWED_HOSTS: z.string().optional(),
    ALLOWED_ORIGINS: z.string().optional(),

    // Link-type option-set value range used by this Dataverse tenant.
    //   global  — standard tenants: FS=192350000, SS=192350001, FF=192350002, SF=192350003
    //   eu      — EU/CRM4 tenants:  FS=1, SS=3, FF=0, SF=2
    // Check with: describe_option_set on msdyn_projecttaskdependency/msdyn_projecttaskdependencylinktype
    DATAVERSE_LINK_TYPE_STYLE: z.enum(["global", "eu"]),

    // Outbound Dataverse call timeout, and inbound rate limit.
    REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
    RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(120),
    JSON_BODY_LIMIT: z.string().default("2mb"),

    // --- Production-ops tool filtering ---

    // When true, the server exposes ONLY read-only tools (readOnlyHint===true) and
    // rejects any write/session tool call at call time. For a safe reporting-only
    // deployment. Accepts "true"/"1"/"yes"/"on" (case-insensitive) as true.
    READ_ONLY_MODE: z
      .union([z.boolean(), z.string(), z.undefined()])
      .optional()
      .default(false)
      .transform(coerceBool),

    // Explicit allowlist of tool names (comma list). Unset = all tools eligible.
    ENABLED_TOOLS: z.string().optional(),

    // Named tool groups to expose (comma list). Unset = all groups eligible.
    // Known groups: reporting, discovery, sessions, write, analytics.
    TOOLSETS: z.string().optional(),

    // --- Custom Dataverse column support (opt-in; default off = zero behaviour change) ---

    // "off" (default)            - custom-column read/discovery is disabled entirely.
    // "metadata"                 - any non-msdyn_ column discoverable via metadata is eligible.
    // "metadata+allowlist"       - metadata-eligible AND present in CUSTOM_COLUMNS_ALLOWLIST.
    CUSTOM_COLUMNS_MODE: z.enum(["off", "metadata", "metadata+allowlist"]).default("off"),

    // Comma list of logical names further restricting which custom columns are
    // usable, when CUSTOM_COLUMNS_MODE=metadata+allowlist.
    CUSTOM_COLUMNS_ALLOWLIST: z.string().optional(),

    // Optional TTL for the process-lifetime metadata cache (ms). Unset = no
    // expiry (schema is stable within a deployment, same rationale as
    // capabilities.ts). Only useful for tenants iterating on custom-column schema.
    CUSTOM_COLUMNS_METADATA_TTL_MS: z.coerce.number().int().positive().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.AUTH_MODE === "validate" && !v.TENANT_ID) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["TENANT_ID"],
        message:
          "TENANT_ID is required when AUTH_MODE=validate. Set it to your Entra tenant GUID, or set AUTH_MODE=insecure-passthrough for local development only.",
      });
    }
  });

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

/** Parses and caches the environment. Throws (fail-fast) on invalid config. */
export function getEnv(): Env {
  if (!cached) cached = EnvSchema.parse(process.env);
  return cached;
}

/** Test helper: clears the cached env so a new process.env can be re-read. */
export function resetEnvCache(): void {
  cached = null;
}

/** Dataverse Web API base, e.g. https://org.crm4.dynamics.com/api/data/v9.2 */
export function getApiBase(): string {
  return getEnv().DATAVERSE_ORG_URL + "/api/data/v9.2";
}

function splitList(v?: string): string[] | undefined {
  if (!v) return undefined;
  const items = v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length ? items : undefined;
}

/** Audience values accepted on the inbound token (org URL, with/without slash). */
export function getAudiences(): string[] {
  const org = getEnv().DATAVERSE_ORG_URL;
  return [org, org + "/"];
}

/**
 * The app's own public FQDN on Azure Container Apps, derived from the variables
 * ACA injects at runtime. The external app URL is `<name>.<env-dns-suffix>`, so
 * the server can allow-list its own host WITHOUT knowing the URL at deploy time
 * (which solves the create-time chicken-and-egg: the FQDN doesn't exist until
 * after the app is created).
 */
function acaDerivedHost(): string | undefined {
  const name = process.env.CONTAINER_APP_NAME;
  const suffix = process.env.CONTAINER_APP_ENV_DNS_SUFFIX;
  return name && suffix ? `${name}.${suffix}` : undefined;
}

/**
 * Effective allowed Host headers: any explicit ALLOWED_HOSTS (e.g. a custom
 * domain) PLUS the auto-derived ACA FQDN. Returns undefined only when neither is
 * available (local dev) - in which case DNS-rebinding protection stays off.
 */
export function getAllowedHosts(): string[] | undefined {
  const hosts = new Set<string>(splitList(getEnv().ALLOWED_HOSTS) ?? []);
  const derived = acaDerivedHost();
  if (derived) hosts.add(derived);
  return hosts.size ? [...hosts] : undefined;
}

export function getAllowedOrigins(): string[] | undefined {
  return splitList(getEnv().ALLOWED_ORIGINS);
}

/** Returns true when READ_ONLY_MODE is enabled. */
export function isReadOnlyMode(): boolean {
  return getEnv().READ_ONLY_MODE;
}

/**
 * Returns the ENABLED_TOOLS allowlist (parsed comma list), or undefined when
 * the env var is not set (no constraint).
 */
export function getEnabledTools(): string[] | undefined {
  return splitList(getEnv().ENABLED_TOOLS);
}

/**
 * Returns the TOOLSETS allowlist (parsed comma list), or undefined when the
 * env var is not set (no constraint).
 */
export function getToolsets(): string[] | undefined {
  return splitList(getEnv().TOOLSETS);
}

/** Returns the configured custom-columns mode. Default "off". */
export function getCustomColumnsMode(): "off" | "metadata" | "metadata+allowlist" {
  return getEnv().CUSTOM_COLUMNS_MODE;
}

/**
 * Returns the CUSTOM_COLUMNS_ALLOWLIST (parsed comma list of logical names),
 * or undefined when unset.
 */
export function getCustomColumnsAllowlist(): string[] | undefined {
  return splitList(getEnv().CUSTOM_COLUMNS_ALLOWLIST);
}

/** Returns the configured metadata cache TTL in ms, or undefined (no expiry). */
export function getCustomColumnsMetadataTtlMs(): number | undefined {
  return getEnv().CUSTOM_COLUMNS_METADATA_TTL_MS;
}
