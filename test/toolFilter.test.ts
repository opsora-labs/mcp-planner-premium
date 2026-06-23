import { describe, it, expect } from "vitest";
import { filterTools, TOOLSETS } from "../src/toolFilter.js";
import { allTools, toolAnnotations } from "../src/tools/index.js";
import type { ToolFilterEnv } from "../src/toolFilter.js";

// Read-only tool names (14 original + 3 analytics tools + 2 member-info/user-task
// tools added in feat/member-info-and-user-tasks + search_plan_tasks).
const READ_ONLY_TOOL_NAMES = new Set([
  "check_change_session_status",
  "find_plan_by_name",
  "find_team_member",
  "find_team_member_across_plans",
  "get_plan_tasks_and_buckets",
  "whoami",
  "list_plans",
  "list_my_tasks",
  "list_user_tasks",
  "get_plan_summary",
  "get_task",
  "list_plan_tasks",
  "search_plan_tasks",
  "get_bucket_breakdown",
  "list_dependencies",
  "list_team_members",
  "describe_option_set",
  "get_critical_path",
  "get_schedule_health",
  "get_resource_workload",
]);

// The 12 write/session tool names (assign_task added in feat/pm-feature-suite).
const WRITE_TOOL_NAMES = new Set([
  "create_plan",
  "add_bucket",
  "add_sprint",
  "start_change_session",
  "add_tasks",
  "add_tasks_batch",
  "update_tasks",
  "update_tasks_batch",
  "delete_tasks_batch",
  "apply_changes",
  "cancel_change_session",
  "assign_task",
]);

function noConstraint(): ToolFilterEnv {
  return { readOnly: false };
}

describe("filterTools — no constraints (default behaviour)", () => {
  it("returns all tools when no constraints are set", () => {
    const { tools, excluded } = filterTools(allTools, toolAnnotations, noConstraint());
    expect(tools).toHaveLength(allTools.length);
    expect(Object.keys(excluded)).toHaveLength(0);
  });

  it("preserves allTools order in output", () => {
    const { tools } = filterTools(allTools, toolAnnotations, noConstraint());
    const names = tools.map((t) => t.name);
    const expected = allTools.map((t) => t.name);
    expect(names).toEqual(expected);
  });

  it("readOnlyNames contains exactly the read-only tools", () => {
    const { readOnlyNames } = filterTools(allTools, toolAnnotations, noConstraint());
    expect(readOnlyNames.size).toBe(READ_ONLY_TOOL_NAMES.size);
    for (const name of READ_ONLY_TOOL_NAMES) {
      expect(readOnlyNames.has(name)).toBe(true);
    }
    for (const name of WRITE_TOOL_NAMES) {
      expect(readOnlyNames.has(name)).toBe(false);
    }
  });
});

describe("filterTools — READ_ONLY_MODE", () => {
  it("exposes exactly the read-only tools", () => {
    const { tools } = filterTools(allTools, toolAnnotations, { readOnly: true });
    const names = new Set(tools.map((t) => t.name));
    expect(tools).toHaveLength(READ_ONLY_TOOL_NAMES.size);
    for (const name of READ_ONLY_TOOL_NAMES) {
      expect(names.has(name)).toBe(true);
    }
    for (const name of WRITE_TOOL_NAMES) {
      expect(names.has(name)).toBe(false);
    }
  });

  it("places all 12 write/session tools in excluded with reason 'read-only mode'", () => {
    const { excluded } = filterTools(allTools, toolAnnotations, { readOnly: true });
    for (const name of WRITE_TOOL_NAMES) {
      expect(excluded[name]).toBe("read-only mode");
    }
    expect(Object.keys(excluded)).toHaveLength(12);
  });

  it("readOnlyNames.size equals the read-only tool count", () => {
    const { readOnlyNames } = filterTools(allTools, toolAnnotations, { readOnly: true });
    expect(readOnlyNames.size).toBe(READ_ONLY_TOOL_NAMES.size);
  });
});

describe("filterTools — ENABLED_TOOLS", () => {
  it("returns exactly the named tools when ENABLED_TOOLS is set", () => {
    const { tools } = filterTools(allTools, toolAnnotations, {
      readOnly: false,
      enabledTools: ["whoami", "list_plans"],
    });
    const names = tools.map((t) => t.name);
    expect(names).toHaveLength(2);
    expect(names).toContain("whoami");
    expect(names).toContain("list_plans");
  });

  it("places non-listed tools in excluded with 'not in ENABLED_TOOLS'", () => {
    const { excluded } = filterTools(allTools, toolAnnotations, {
      readOnly: false,
      enabledTools: ["whoami", "list_plans"],
    });
    expect(Object.keys(excluded)).toHaveLength(allTools.length - 2);
    expect(excluded["add_tasks"]).toBe("not in ENABLED_TOOLS");
    expect(excluded["create_plan"]).toBe("not in ENABLED_TOOLS");
  });

  it("ENABLED_TOOLS with a single tool returns only that tool", () => {
    const { tools } = filterTools(allTools, toolAnnotations, {
      readOnly: false,
      enabledTools: ["get_task"],
    });
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("get_task");
  });
});

describe("filterTools — TOOLSETS", () => {
  it("reporting toolset returns 9 tools", () => {
    const { tools } = filterTools(allTools, toolAnnotations, {
      readOnly: false,
      toolsets: ["reporting"],
    });
    expect(tools).toHaveLength(9);
    const names = new Set(tools.map((t) => t.name));
    for (const name of TOOLSETS["reporting"]) {
      expect(names.has(name)).toBe(true);
    }
  });

  it("discovery toolset returns 7 tools", () => {
    const { tools } = filterTools(allTools, toolAnnotations, {
      readOnly: false,
      toolsets: ["discovery"],
    });
    expect(tools).toHaveLength(7);
  });

  it("reporting + sessions union returns 13 tools (no duplicates)", () => {
    const { tools } = filterTools(allTools, toolAnnotations, {
      readOnly: false,
      toolsets: ["reporting", "sessions"],
    });
    expect(tools).toHaveLength(13);
    // Check no duplicates
    const names = tools.map((t) => t.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  it("excludes tools not in the selected toolset", () => {
    const { excluded } = filterTools(allTools, toolAnnotations, {
      readOnly: false,
      toolsets: ["reporting"],
    });
    // whoami and describe_option_set are in discovery, not reporting
    expect(excluded["whoami"]).toMatch(/not in TOOLSETS/);
    expect(excluded["describe_option_set"]).toMatch(/not in TOOLSETS/);
  });
});

describe("filterTools — combined constraints", () => {
  it("ENABLED_TOOLS ∩ TOOLSETS: list_plans + sessions = empty", () => {
    const { tools } = filterTools(allTools, toolAnnotations, {
      readOnly: false,
      enabledTools: ["list_plans"],
      toolsets: ["sessions"],
    });
    // list_plans is not in the sessions group
    expect(tools).toHaveLength(0);
  });

  it("ENABLED_TOOLS ∩ TOOLSETS: start_change_session + sessions = [start_change_session]", () => {
    const { tools } = filterTools(allTools, toolAnnotations, {
      readOnly: false,
      enabledTools: ["start_change_session"],
      toolsets: ["sessions"],
    });
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("start_change_session");
  });

  it("readOnly + ENABLED_TOOLS=[whoami,add_tasks]: only whoami is returned", () => {
    const { tools, excluded } = filterTools(allTools, toolAnnotations, {
      readOnly: true,
      enabledTools: ["whoami", "add_tasks"],
    });
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("whoami");
    // add_tasks fails on read-only, not on ENABLED_TOOLS
    expect(excluded["add_tasks"]).toBe("read-only mode");
  });

  it("readOnly + TOOLSETS=[write]: 0 tools (empty intersection, no throw)", () => {
    const { tools } = filterTools(allTools, toolAnnotations, {
      readOnly: true,
      toolsets: ["write"],
    });
    // write toolset tools are all readOnlyHint:false; none pass READ_ONLY_MODE
    expect(tools).toHaveLength(0);
  });
});

describe("filterTools — fail-closed (unknown names throw)", () => {
  it("throws on unknown tool name in ENABLED_TOOLS", () => {
    expect(() =>
      filterTools(allTools, toolAnnotations, {
        readOnly: false,
        enabledTools: ["does_not_exist"],
      }),
    ).toThrow(/unknown tool name/i);
  });

  it("throws on unknown toolset group in TOOLSETS", () => {
    expect(() =>
      filterTools(allTools, toolAnnotations, {
        readOnly: false,
        toolsets: ["bogus_set"],
      }),
    ).toThrow(/unknown toolset/i);
  });

  it("error message for unknown tool names lists the bad name", () => {
    expect(() =>
      filterTools(allTools, toolAnnotations, {
        readOnly: false,
        enabledTools: ["bogus_tool"],
      }),
    ).toThrow(/bogus_tool/);
  });

  it("error message for unknown toolset names lists the bad group", () => {
    expect(() =>
      filterTools(allTools, toolAnnotations, {
        readOnly: false,
        toolsets: ["nope"],
      }),
    ).toThrow(/nope/);
  });
});

describe("TOOLSETS map integrity", () => {
  const allToolNames = new Set(allTools.map((t) => t.name));

  it("every name in every TOOLSETS group is a real allTools name (guards forward-refs separately)", () => {
    // No forward-reference entries remain: assign_task was registered in feat/pm-feature-suite.
    const FORWARD_REFS = new Set<string>();
    for (const [group, tools] of Object.entries(TOOLSETS)) {
      for (const name of tools) {
        if (FORWARD_REFS.has(name)) continue; // expected not-yet-registered
        expect(allToolNames.has(name), `group "${group}" contains unknown tool "${name}"`).toBe(true);
      }
    }
  });

  it("union of all TOOLSETS groups (excluding forward-refs) covers all registered tools", () => {
    // No forward-reference entries remain: assign_task was registered in feat/pm-feature-suite.
    const FORWARD_REFS = new Set<string>();
    const covered = new Set<string>();
    for (const tools of Object.values(TOOLSETS)) {
      for (const name of tools) {
        if (!FORWARD_REFS.has(name)) covered.add(name);
      }
    }
    for (const name of allToolNames) {
      expect(covered.has(name), `tool "${name}" is not covered by any TOOLSETS group`).toBe(true);
    }
    expect(covered.size).toBe(allToolNames.size);
  });

  it("all known groups are present", () => {
    const groups = Object.keys(TOOLSETS);
    expect(groups).toContain("reporting");
    expect(groups).toContain("discovery");
    expect(groups).toContain("sessions");
    expect(groups).toContain("write");
    expect(groups).toContain("analytics");
  });
});

describe("filterTools — output order", () => {
  it("filtered results follow allTools order (ENABLED_TOOLS=[list_plans,whoami])", () => {
    // whoami comes before list_plans in allTools; result must preserve that order
    const { tools } = filterTools(allTools, toolAnnotations, {
      readOnly: false,
      enabledTools: ["list_plans", "whoami"],
    });
    const names = tools.map((t) => t.name);
    // whoami is index 15, list_plans is index 16 in allTools
    expect(names.indexOf("whoami")).toBeLessThan(names.indexOf("list_plans"));
  });
});
