/**
 * Deletes ZZ-MCP-E2E-* test plans directly via Dataverse OData,
 * bypassing the MCP server's whole-plan-delete guardrail (which is correct
 * for the server to enforce — this is an out-of-band maintenance utility).
 *
 * Usage:
 *   export E2E_ACCESS_TOKEN=$(npx tsx --env-file .env scripts/get-dataverse-token.ts)
 *   npx tsx --env-file .env scripts/cleanup-e2e-plans.ts
 *
 * Required env vars:
 *   E2E_ACCESS_TOKEN   Valid Dataverse access token (from get-dataverse-token.ts)
 *   DATAVERSE_ORG_URL  e.g. https://contoso.crm.dynamics.com
 */

const token = process.env.E2E_ACCESS_TOKEN;
const orgUrl = (process.env.DATAVERSE_ORG_URL ?? "").replace(/\/+$/, "");

if (!token) {
  process.stderr.write("Missing E2E_ACCESS_TOKEN\n");
  process.exit(1);
}
if (!orgUrl) {
  process.stderr.write("Missing DATAVERSE_ORG_URL\n");
  process.exit(1);
}

const headers = {
  Authorization: `Bearer ${token}`,
  "OData-MaxVersion": "4.0",
  "OData-Version": "4.0",
  Accept: "application/json",
  "Content-Type": "application/json",
};

async function dvGet(path: string): Promise<any> {
  const res = await fetch(`${orgUrl}/api/data/v9.2${path}`, { headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GET ${path} → ${res.status}: ${text}`);
  }
  return res.json();
}

async function dvDelete(path: string): Promise<void> {
  const res = await fetch(`${orgUrl}/api/data/v9.2${path}`, {
    method: "DELETE",
    headers,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`DELETE ${path} → ${res.status}: ${text}`);
  }
}

// Query all projects named ZZ-MCP-E2E-*
const query =
  "/msdyn_projects" +
  "?$filter=startswith(msdyn_subject,'ZZ-MCP-E2E-')" +
  "&$select=msdyn_projectid,msdyn_subject,statecode";

console.log("Querying for ZZ-MCP-E2E-* test plans…");
const { value: plans } = await dvGet(query);

if (!plans || plans.length === 0) {
  console.log("No test plans found.");
  process.exit(0);
}

console.log(`Found ${plans.length} test plan(s):\n`);
for (const p of plans) {
  console.log(`  ${p.msdyn_subject} (${p.msdyn_projectid})`);
}
console.log();

let deleted = 0;
let failed = 0;

for (const plan of plans) {
  const id: string = plan.msdyn_projectid;
  const name: string = plan.msdyn_subject;
  try {
    await dvDelete(`/msdyn_projects(${id})`);
    console.log(`  ✓ Deleted: ${name}`);
    deleted++;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  ✗ Failed:  ${name}`);
    console.error(`    ${msg}`);
    failed++;
  }
}

console.log(`\nDone — ${deleted} deleted, ${failed} failed.`);
if (failed > 0) process.exit(1);
