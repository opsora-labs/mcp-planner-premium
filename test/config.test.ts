/**
 * Tests for the new production-ops config additions:
 *   - READ_ONLY_MODE boolean coercion
 *   - ENABLED_TOOLS and TOOLSETS comma-list parsing
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  getEnv,
  resetEnvCache,
  isReadOnlyMode,
  getEnabledTools,
  getToolsets,
  getCustomColumnsMode,
  getCustomColumnsAllowlist,
  getCustomColumnsMetadataTtlMs,
} from "../src/config.js";

const BASE_ENV: Record<string, string> = {
  DATAVERSE_ORG_URL: "https://org12345.crm4.dynamics.com",
  AUTH_MODE: "insecure-passthrough",
  DATAVERSE_LINK_TYPE_STYLE: "global",
};

function setEnv(extra: Record<string, string | undefined> = {}) {
  // Clear all keys from previous runs
  delete process.env.READ_ONLY_MODE;
  delete process.env.ENABLED_TOOLS;
  delete process.env.TOOLSETS;
  delete process.env.CUSTOM_COLUMNS_MODE;
  delete process.env.CUSTOM_COLUMNS_ALLOWLIST;
  delete process.env.CUSTOM_COLUMNS_METADATA_TTL_MS;
  Object.assign(process.env, BASE_ENV);
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  resetEnvCache();
}

beforeEach(() => setEnv());
afterEach(() => resetEnvCache());

describe("READ_ONLY_MODE coercion", () => {
  it('defaults to false when READ_ONLY_MODE is unset', () => {
    setEnv();
    expect(getEnv().READ_ONLY_MODE).toBe(false);
    expect(isReadOnlyMode()).toBe(false);
  });

  it('"true" coerces to true', () => {
    setEnv({ READ_ONLY_MODE: "true" });
    expect(isReadOnlyMode()).toBe(true);
  });

  it('"1" coerces to true', () => {
    setEnv({ READ_ONLY_MODE: "1" });
    expect(isReadOnlyMode()).toBe(true);
  });

  it('"yes" coerces to true', () => {
    setEnv({ READ_ONLY_MODE: "yes" });
    expect(isReadOnlyMode()).toBe(true);
  });

  it('"on" coerces to true', () => {
    setEnv({ READ_ONLY_MODE: "on" });
    expect(isReadOnlyMode()).toBe(true);
  });

  it('"TRUE" (uppercase) coerces to true', () => {
    setEnv({ READ_ONLY_MODE: "TRUE" });
    expect(isReadOnlyMode()).toBe(true);
  });

  it('"false" coerces to false', () => {
    setEnv({ READ_ONLY_MODE: "false" });
    expect(isReadOnlyMode()).toBe(false);
  });

  it('"0" coerces to false', () => {
    setEnv({ READ_ONLY_MODE: "0" });
    expect(isReadOnlyMode()).toBe(false);
  });

  it('"no" coerces to false', () => {
    setEnv({ READ_ONLY_MODE: "no" });
    expect(isReadOnlyMode()).toBe(false);
  });

  it('"off" coerces to false', () => {
    setEnv({ READ_ONLY_MODE: "off" });
    expect(isReadOnlyMode()).toBe(false);
  });

  it('empty string coerces to false', () => {
    setEnv({ READ_ONLY_MODE: "" });
    expect(isReadOnlyMode()).toBe(false);
  });

  it('invalid string "maybe" throws a fail-fast error', () => {
    setEnv({ READ_ONLY_MODE: "maybe" });
    expect(() => getEnv()).toThrow(/Invalid boolean value/);
  });

  it('invalid string "2" throws a fail-fast error', () => {
    setEnv({ READ_ONLY_MODE: "2" });
    expect(() => getEnv()).toThrow(/Invalid boolean value/);
  });
});

describe("getEnabledTools", () => {
  it("returns undefined when ENABLED_TOOLS is not set", () => {
    setEnv();
    expect(getEnabledTools()).toBeUndefined();
  });

  it("parses a comma-separated list", () => {
    setEnv({ ENABLED_TOOLS: "whoami,list_plans" });
    expect(getEnabledTools()).toEqual(["whoami", "list_plans"]);
  });

  it("trims whitespace around names", () => {
    setEnv({ ENABLED_TOOLS: " whoami , list_plans " });
    expect(getEnabledTools()).toEqual(["whoami", "list_plans"]);
  });

  it("drops empty entries (trailing comma)", () => {
    setEnv({ ENABLED_TOOLS: "whoami," });
    expect(getEnabledTools()).toEqual(["whoami"]);
  });

  it("returns undefined for an all-whitespace string", () => {
    setEnv({ ENABLED_TOOLS: "  " });
    expect(getEnabledTools()).toBeUndefined();
  });
});

describe("getToolsets", () => {
  it("returns undefined when TOOLSETS is not set", () => {
    setEnv();
    expect(getToolsets()).toBeUndefined();
  });

  it("parses a single group", () => {
    setEnv({ TOOLSETS: "reporting" });
    expect(getToolsets()).toEqual(["reporting"]);
  });

  it("parses multiple groups", () => {
    setEnv({ TOOLSETS: "reporting,sessions" });
    expect(getToolsets()).toEqual(["reporting", "sessions"]);
  });

  it("trims whitespace", () => {
    setEnv({ TOOLSETS: " reporting , sessions " });
    expect(getToolsets()).toEqual(["reporting", "sessions"]);
  });

  it("returns undefined for empty string", () => {
    setEnv({ TOOLSETS: "" });
    expect(getToolsets()).toBeUndefined();
  });
});

describe("CUSTOM_COLUMNS_MODE", () => {
  it("defaults to 'off' when unset", () => {
    setEnv();
    expect(getCustomColumnsMode()).toBe("off");
  });

  it("accepts 'metadata'", () => {
    setEnv({ CUSTOM_COLUMNS_MODE: "metadata" });
    expect(getCustomColumnsMode()).toBe("metadata");
  });

  it("accepts 'metadata+allowlist'", () => {
    setEnv({ CUSTOM_COLUMNS_MODE: "metadata+allowlist" });
    expect(getCustomColumnsMode()).toBe("metadata+allowlist");
  });

  it("rejects an invalid value", () => {
    setEnv({ CUSTOM_COLUMNS_MODE: "bogus" });
    expect(() => getEnv()).toThrow();
  });
});

describe("CUSTOM_COLUMNS_ALLOWLIST", () => {
  it("returns undefined when unset", () => {
    setEnv();
    expect(getCustomColumnsAllowlist()).toBeUndefined();
  });

  it("parses a comma-separated list and trims whitespace", () => {
    setEnv({ CUSTOM_COLUMNS_ALLOWLIST: " new_riskscore , new_category " });
    expect(getCustomColumnsAllowlist()).toEqual(["new_riskscore", "new_category"]);
  });
});

describe("CUSTOM_COLUMNS_METADATA_TTL_MS", () => {
  it("returns undefined when unset (no expiry)", () => {
    setEnv();
    expect(getCustomColumnsMetadataTtlMs()).toBeUndefined();
  });

  it("parses a positive integer", () => {
    setEnv({ CUSTOM_COLUMNS_METADATA_TTL_MS: "60000" });
    expect(getCustomColumnsMetadataTtlMs()).toBe(60000);
  });

  it("rejects a non-positive value", () => {
    setEnv({ CUSTOM_COLUMNS_METADATA_TTL_MS: "0" });
    expect(() => getEnv()).toThrow();
  });
});

describe("DATAVERSE_LINK_TYPE_STYLE stays required", () => {
  it("accepts 'global'", () => {
    setEnv({ DATAVERSE_LINK_TYPE_STYLE: "global" });
    expect(getEnv().DATAVERSE_LINK_TYPE_STYLE).toBe("global");
  });

  it("accepts 'eu'", () => {
    setEnv({ DATAVERSE_LINK_TYPE_STYLE: "eu" });
    expect(getEnv().DATAVERSE_LINK_TYPE_STYLE).toBe("eu");
  });

  it("rejects an invalid value", () => {
    setEnv({ DATAVERSE_LINK_TYPE_STYLE: "xx" });
    expect(() => getEnv()).toThrow();
  });
});
