/**
 * One-time interactive login via Entra device-code flow.
 * Caches the refresh token to .tokens.json (gitignored) so that
 * get-dataverse-token.ts can silently mint new access tokens without
 * any further user interaction.
 *
 * Run this once before starting an autonomous session.
 *
 * Usage:
 *   npx tsx --env-file .env scripts/auth-login.ts
 *
 * Required env vars (in .env):
 *   TENANT_ID          Entra tenant GUID
 *   ENTRA_CLIENT_ID    App registration client ID
 *   DATAVERSE_ORG_URL  e.g. https://contoso.crm.dynamics.com
 *
 * Optional:
 *   ENTRA_CLIENT_SECRET  Binds the refresh token to this client (more secure).
 *                        Requires the app to be a confidential client.
 *
 * Entra app prerequisites:
 *   - API permissions: Dynamics CRM → Delegated → user_impersonation (admin consent granted)
 *   - Authentication → "Allow public client flows" = Yes  (needed for device code)
 *   - The signing-in user must hold a Project Plan P3 / Planner Premium license
 */

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const TOKEN_CACHE = resolve(__dirname, "../.tokens.json");

const tenantId = process.env.TENANT_ID;
const clientId = process.env.ENTRA_CLIENT_ID;
const clientSecret = process.env.ENTRA_CLIENT_SECRET; // optional
const orgUrl = (process.env.DATAVERSE_ORG_URL ?? "").replace(/\/+$/, "");

for (const [k, v] of [["TENANT_ID", tenantId], ["ENTRA_CLIENT_ID", clientId], ["DATAVERSE_ORG_URL", orgUrl]] as [string, string | undefined][]) {
  if (!v) { process.stderr.write(`Missing required env var: ${k}\n`); process.exit(1); }
}

const scope = `${orgUrl}/user_impersonation offline_access`;
const tokenEndpoint = `https://login.microsoftonline.com/${tenantId!}/oauth2/v2.0/token`;

// ── Step 1: Request device code ──────────────────────────────────────────────
const dcRes = await fetch(
  `https://login.microsoftonline.com/${tenantId!}/oauth2/v2.0/devicecode`,
  {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId!, scope }).toString(),
  },
);

if (!dcRes.ok) {
  const text = await dcRes.text();
  process.stderr.write(`Device code request failed (${dcRes.status}): ${text}\n`);
  process.exit(1);
}

const dc = (await dcRes.json()) as {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
  message: string;
};

console.log("\n" + "=".repeat(60));
console.log(dc.message);
console.log("=".repeat(60));
console.log("\nWaiting for you to complete sign-in…\n");

// ── Step 2: Poll until the user authenticates ────────────────────────────────
const pollBody: Record<string, string> = {
  grant_type: "urn:ietf:params:oauth:grant-type:device_code",
  client_id: clientId!,
  device_code: dc.device_code,
};
if (clientSecret) pollBody.client_secret = clientSecret;

const deadline = Date.now() + dc.expires_in * 1000;
let intervalMs = (dc.interval ?? 5) * 1000;
let tokens: { access_token: string; refresh_token: string } | null = null;

while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, intervalMs));

  const res = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(pollBody).toString(),
  });

  const data = (await res.json()) as any;

  if (data.error === "authorization_pending") continue;
  if (data.error === "slow_down") { intervalMs += 5000; continue; }
  if (data.error) {
    process.stderr.write(`Auth failed: ${data.error} — ${data.error_description}\n`);
    process.exit(1);
  }

  if (data.access_token && data.refresh_token) {
    tokens = data;
    break;
  }
}

if (!tokens) {
  process.stderr.write("Timed out waiting for sign-in.\n");
  process.exit(1);
}

// ── Step 3: Persist the refresh token ────────────────────────────────────────
const cache = {
  refresh_token: tokens.refresh_token,
  tenant_id: tenantId!,
  client_id: clientId!,
  org_url: orgUrl,
};

await writeFile(TOKEN_CACHE, JSON.stringify(cache, null, 2) + "\n", "utf-8");

console.log("Signed in. Refresh token cached to .tokens.json");
console.log("Claude can now run autonomous sessions without further interaction.");
