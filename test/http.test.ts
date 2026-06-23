import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { resetEnvCache } from "../src/config.js";
import { buildApp } from "../src/app.js";
import { TOOLSETS } from "../src/toolFilter.js";
import { allTools, toolAnnotations } from "../src/tools/index.js";

const ORG = "https://org12345.crm4.dynamics.com";

// Derived from the registry so these survive future tool additions.
const TOTAL_TOOLS = allTools.length;
const READ_ONLY_TOOLS = allTools.filter(
  (t) => toolAnnotations[t.name]?.readOnlyHint === true,
).length;

function setEnv(extra: Record<string, string | undefined> = {}) {
  process.env.DATAVERSE_ORG_URL = ORG;
  process.env.LOG_LEVEL = "silent";
  process.env.DATAVERSE_LINK_TYPE_STYLE = "global";
  delete process.env.TENANT_ID;
  delete process.env.AUTH_MODE;
  delete process.env.READ_ONLY_MODE;
  delete process.env.ENABLED_TOOLS;
  delete process.env.TOOLSETS;
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  resetEnvCache();
}

// buildApp() reads env lazily, so a single import + cache reset suffices.
function freshApp() {
  return buildApp();
}

describe("HTTP layer", () => {
  beforeEach(() => setEnv());
  afterEach(() => resetEnvCache());

  it("GET /healthz returns ok", async () => {
    setEnv({ AUTH_MODE: "insecure-passthrough" });
    const app = await freshApp();
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("GET /mcp returns 405", async () => {
    setEnv({ AUTH_MODE: "insecure-passthrough" });
    const app = await freshApp();
    const res = await request(app).get("/mcp");
    expect(res.status).toBe(405);
  });

  it("DELETE /mcp returns 405", async () => {
    setEnv({ AUTH_MODE: "insecure-passthrough" });
    const app = await freshApp();
    const res = await request(app).delete("/mcp");
    expect(res.status).toBe(405);
  });

  it("POST /mcp without a token is 401 when AUTH_MODE=validate", async () => {
    setEnv({ AUTH_MODE: "validate", TENANT_ID: "00000000-0000-0000-0000-000000000000" });
    const app = await freshApp();
    const res = await request(app)
      .post("/mcp")
      .set("Accept", "application/json, text/event-stream")
      .send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    expect(res.status).toBe(401);
    expect(res.headers["www-authenticate"]).toMatch(/missing_token/);
  });

  it("POST /mcp with a bogus token is 401 when AUTH_MODE=validate", async () => {
    setEnv({ AUTH_MODE: "validate", TENANT_ID: "00000000-0000-0000-0000-000000000000" });
    const app = await freshApp();
    const res = await request(app)
      .post("/mcp")
      .set("Authorization", "Bearer not.a.jwt")
      .set("Accept", "application/json, text/event-stream")
      .send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    expect(res.status).toBe(401);
    expect(res.headers["www-authenticate"]).toMatch(/invalid_token/);
  });

  it("config fails fast when AUTH_MODE=validate but TENANT_ID is missing", async () => {
    setEnv({ AUTH_MODE: "validate" });
    expect(() => freshApp()).toThrow(/TENANT_ID is required/);
  });

  it("lists tools over MCP when auth is in passthrough mode", async () => {
    setEnv({ AUTH_MODE: "insecure-passthrough" });
    const app = await freshApp();
    // initialize
    const init = await request(app)
      .post("/mcp")
      .set("Accept", "application/json, text/event-stream")
      .send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        },
      });
    expect(init.status).toBe(200);
    const list = await request(app)
      .post("/mcp")
      .set("Accept", "application/json, text/event-stream")
      .send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    expect(list.status).toBe(200);
    expect(list.text).toContain("add_tasks");
    expect(list.text).toContain("update_tasks");
  });

  // --- Production-ops: READ_ONLY_MODE ---

  it("READ_ONLY_MODE shrinks tools/list to only read-only tools", async () => {
    setEnv({ AUTH_MODE: "insecure-passthrough", READ_ONLY_MODE: "true" });
    const app = freshApp();
    const list = await request(app)
      .post("/mcp")
      .set("Accept", "application/json, text/event-stream")
      .send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    expect(list.status).toBe(200);
    // Read-only tools must be present
    expect(list.text).toContain("list_plans");
    expect(list.text).toContain("whoami");
    expect(list.text).toContain("check_change_session_status");
    // Write/session tools must be absent
    expect(list.text).not.toContain('"add_tasks"');
    expect(list.text).not.toContain('"start_change_session"');
    expect(list.text).not.toContain('"delete_tasks_batch"');
    expect(list.text).not.toContain('"update_tasks"');
  });

  it("/healthz reports readOnly:true and the read-only tool count under READ_ONLY_MODE", async () => {
    setEnv({ AUTH_MODE: "insecure-passthrough", READ_ONLY_MODE: "true" });
    const app = freshApp();
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.readOnly).toBe(true);
    expect(res.body.toolCount).toBe(READ_ONLY_TOOLS);
  });

  it("/healthz reports readOnly:false and the full tool count by default", async () => {
    setEnv({ AUTH_MODE: "insecure-passthrough" });
    const app = freshApp();
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body.readOnly).toBe(false);
    expect(res.body.toolCount).toBe(TOTAL_TOOLS);
  });

  // --- Production-ops: TOOLSETS subset ---

  it("TOOLSETS=reporting shrinks tools/list to reporting tools only", async () => {
    setEnv({ AUTH_MODE: "insecure-passthrough", TOOLSETS: "reporting" });
    const app = freshApp();
    const list = await request(app)
      .post("/mcp")
      .set("Accept", "application/json, text/event-stream")
      .send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    expect(list.status).toBe(200);
    // reporting tools must be present
    for (const name of TOOLSETS["reporting"]) {
      expect(list.text).toContain(`"${name}"`);
    }
    // discovery-only tools must be absent
    expect(list.text).not.toContain('"whoami"');
    expect(list.text).not.toContain('"describe_option_set"');
    // write tools must be absent
    expect(list.text).not.toContain('"add_tasks"');
  });

  it("/healthz toolCount reflects TOOLSETS=reporting (9 tools)", async () => {
    setEnv({ AUTH_MODE: "insecure-passthrough", TOOLSETS: "reporting" });
    const app = freshApp();
    const res = await request(app).get("/healthz");
    expect(res.body.toolCount).toBe(9);
  });

  // --- Production-ops: ENABLED_TOOLS subset ---

  it("ENABLED_TOOLS=whoami,list_plans returns exactly those 2 tools", async () => {
    setEnv({ AUTH_MODE: "insecure-passthrough", ENABLED_TOOLS: "whoami,list_plans" });
    const app = freshApp();
    const list = await request(app)
      .post("/mcp")
      .set("Accept", "application/json, text/event-stream")
      .send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    expect(list.status).toBe(200);
    expect(list.text).toContain('"whoami"');
    expect(list.text).toContain('"list_plans"');
    expect(list.text).not.toContain('"add_tasks"');
    expect(list.text).not.toContain('"get_task"');
  });

  // --- Production-ops: fail-closed boot ---

  it("buildApp throws on unknown TOOLSETS value (fail-closed boot)", () => {
    setEnv({ AUTH_MODE: "insecure-passthrough", TOOLSETS: "nope" });
    expect(() => freshApp()).toThrow(/unknown toolset/i);
  });

  it("buildApp throws on unknown ENABLED_TOOLS value (fail-closed boot)", () => {
    setEnv({ AUTH_MODE: "insecure-passthrough", ENABLED_TOOLS: "bogus_tool" });
    expect(() => freshApp()).toThrow(/unknown tool name/i);
  });
});
