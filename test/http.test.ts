import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { resetEnvCache } from "../src/config.js";
import { buildApp } from "../src/app.js";

const ORG = "https://org12345.crm4.dynamics.com";

function setEnv(extra: Record<string, string> = {}) {
  process.env.DATAVERSE_ORG_URL = ORG;
  process.env.LOG_LEVEL = "silent";
  process.env.DATAVERSE_LINK_TYPE_STYLE = "global";
  delete process.env.TENANT_ID;
  delete process.env.AUTH_MODE;
  for (const [k, v] of Object.entries(extra)) process.env[k] = v;
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
});
