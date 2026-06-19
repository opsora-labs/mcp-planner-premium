/**
 * Silently acquires a Dataverse access token by redeeming the cached refresh
 * token from .tokens.json (written by scripts/auth-login.ts).
 *
 * Refresh tokens rotate on each use — the updated token is written back to
 * .tokens.json automatically, so the cache stays valid indefinitely as long
 * as it is used at least once every 90 days.
 *
 * Usage:
 *   export E2E_ACCESS_TOKEN=$(npx tsx --env-file .env scripts/get-dataverse-token.ts)
 *   E2E_ALLOW_WRITES=true npm run e2e
 *
 * If the cache is missing or expired, re-run auth-login.ts:
 *   npx tsx --env-file .env scripts/auth-login.ts
 *
 * Optional env var:
 *   ENTRA_CLIENT_SECRET  If the app is a confidential client, include the
 *                        secret here to bind the refresh to this client instance.
 */

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const TOKEN_CACHE = resolve(__dirname, "../.tokens.json");

// ── Load cached tokens ────────────────────────────────────────────────────────
let cache: { refresh_token: string; tenant_id: string; client_id: string; org_url: string };
try {
  cache = JSON.parse(await readFile(TOKEN_CACHE, "utf-8"));
} catch {
  process.stderr.write(
    "No .tokens.json found — run this first:\n" +
    "  npx tsx --env-file .env scripts/auth-login.ts\n",
  );
  process.exit(1);
}

const { refresh_token, tenant_id, client_id, org_url } = cache;
const clientSecret = process.env.ENTRA_CLIENT_SECRET; // optional

// ── Exchange refresh token for a new access token ─────────────────────────────
const body: Record<string, string> = {
  grant_type: "refresh_token",
  client_id,
  refresh_token,
  scope: `${org_url}/user_impersonation offline_access`,
};
if (clientSecret) body.client_secret = clientSecret;

const res = await fetch(
  `https://login.microsoftonline.com/${tenant_id}/oauth2/v2.0/token`,
  {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  },
);

if (!res.ok) {
  const text = await res.text();
  process.stderr.write(`Token refresh failed (${res.status}): ${text}\n`);
  process.stderr.write(
    "If the refresh token has expired, re-run:\n" +
    "  npx tsx --env-file .env scripts/auth-login.ts\n",
  );
  process.exit(1);
}

const data = (await res.json()) as {
  access_token?: string;
  refresh_token?: string;
  error?: string;
  error_description?: string;
};

if (!data.access_token) {
  process.stderr.write(
    `No access_token returned: ${data.error} — ${data.error_description}\n`,
  );
  process.exit(1);
}

// ── Persist rotated refresh token ─────────────────────────────────────────────
if (data.refresh_token && data.refresh_token !== refresh_token) {
  await writeFile(
    TOKEN_CACHE,
    JSON.stringify({ ...cache, refresh_token: data.refresh_token }, null, 2) + "\n",
    "utf-8",
  );
}

// Stdout only — no trailing newline so $() substitution works cleanly
process.stdout.write(data.access_token);
