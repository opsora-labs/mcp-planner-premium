import { describe, it, expect } from "vitest";
import {
  summariseTasks,
  linkTypeLabel,
  decodeDataverseText,
  hasStrippableTagContent,
  type RawTask,
} from "../src/tools/readHelpers.js";

const NOW = "2026-06-15T00:00:00Z";

describe("linkTypeLabel", () => {
  it("maps standard 192350000-range values to FS/SS/FF/SF", () => {
    expect(linkTypeLabel(192350000)).toBe("FS");
    expect(linkTypeLabel(192350001)).toBe("SS");
    expect(linkTypeLabel(192350002)).toBe("FF");
    expect(linkTypeLabel(192350003)).toBe("SF");
  });

  it("maps EU/CRM4 small-integer values (0-3) to FF/FS/SF/SS", () => {
    // EU tenants expose 0=FF, 1=FS, 2=SF, 3=SS (confirmed via describe_option_set).
    expect(linkTypeLabel(0)).toBe("FF");
    expect(linkTypeLabel(1)).toBe("FS");
    expect(linkTypeLabel(2)).toBe("SF");
    expect(linkTypeLabel(3)).toBe("SS");
  });

  it("returns Unknown(N) for unrecognised values and undefined for non-numbers", () => {
    expect(linkTypeLabel(999)).toBe("Unknown(999)");
    expect(linkTypeLabel(undefined)).toBeUndefined();
  });
});

describe("decodeDataverseText", () => {
  it("decodes the standard entities Dataverse stores in descriptions", () => {
    expect(decodeDataverseText("Risks: &quot;vendor lock-in&quot; &amp; data")).toBe(
      'Risks: "vendor lock-in" & data',
    );
    expect(decodeDataverseText("&lt;tag&gt;")).toBe("<tag>");
    expect(decodeDataverseText("it&#39;s &apos;quoted&apos;")).toBe("it's 'quoted'");
  });

  it("decodes &amp; LAST so an escaped entity is not double-decoded", () => {
    // Stored "&amp;lt;" is the literal text "&lt;" — must NOT collapse to "<".
    expect(decodeDataverseText("&amp;lt;")).toBe("&lt;");
    expect(decodeDataverseText("&amp;quot;")).toBe('&quot;');
  });

  it("leaves plain text and unicode untouched", () => {
    expect(decodeDataverseText("Budget €50k — José")).toBe("Budget €50k — José");
    expect(decodeDataverseText("no entities here")).toBe("no entities here");
  });

  it("maps null/undefined to null (matches the read-tool field contract)", () => {
    expect(decodeDataverseText(null)).toBeNull();
    expect(decodeDataverseText(undefined)).toBeNull();
  });
});

describe("hasStrippableTagContent", () => {
  it("flags tag-like <...> spans that Dataverse strips", () => {
    expect(hasStrippableTagContent("follow-up <2 weeks>")).toBe(true);
    expect(hasStrippableTagContent("see <b>bold</b>")).toBe(true);
    // Broad on purpose: a < ... > span counts even if not a real tag.
    expect(hasStrippableTagContent("5 < 10 > 2")).toBe(true);
  });

  it("does NOT flag a lone < or > (those round-trip safely)", () => {
    expect(hasStrippableTagContent("a < b")).toBe(false);
    expect(hasStrippableTagContent("a > b")).toBe(false);
    expect(hasStrippableTagContent("plain text, no brackets")).toBe(false);
  });

  it("is false for null/undefined", () => {
    expect(hasStrippableTagContent(null)).toBe(false);
    expect(hasStrippableTagContent(undefined)).toBe(false);
  });
});

describe("summariseTasks", () => {
  const parentId = "aaaaaaaa-0000-0000-0000-000000000001";
  const child1 = "aaaaaaaa-0000-0000-0000-000000000002";
  const child2 = "aaaaaaaa-0000-0000-0000-000000000003";
  const leaf = "aaaaaaaa-0000-0000-0000-000000000004";

  const tasks: RawTask[] = [
    // parent (summary) - overdue + <100% but must NOT count as overdue (summary)
    { msdyn_projecttaskid: parentId, msdyn_finish: "2026-01-01T00:00:00Z", msdyn_progress: 0.5 },
    // child overdue + incomplete -> counts
    {
      msdyn_projecttaskid: child1,
      _msdyn_parenttask_value: parentId,
      msdyn_finish: "2026-01-02T00:00:00Z",
      msdyn_progress: 0.2,
    },
    // child overdue but 100% -> not overdue
    {
      msdyn_projecttaskid: child2,
      _msdyn_parenttask_value: parentId,
      msdyn_finish: "2026-01-03T00:00:00Z",
      msdyn_progress: 1,
    },
    // leaf milestone, future -> milestone but not overdue
    {
      msdyn_projecttaskid: leaf,
      msdyn_ismilestone: true,
      msdyn_finish: "2026-12-01T00:00:00Z",
      msdyn_progress: 0,
    },
  ];

  it("computes summary-aware counts", () => {
    const r = summariseTasks(tasks, NOW);
    expect(r.totalTasks).toBe(4);
    expect(r.summaryTaskCount).toBe(1); // parentId
    expect(r.leafTaskCount).toBe(3);
    expect(r.milestoneCount).toBe(1);
    // only child1 is overdue (parent excluded as summary; child2 is 100%; leaf is future)
    expect(r.overdueLeafTaskCount).toBe(1);
    expect(r.summaryTaskIds.map((s) => s.toLowerCase())).toContain(parentId);
  });

  it("treats a finish in the future as not overdue", () => {
    const r = summariseTasks(
      [{ msdyn_projecttaskid: leaf, msdyn_finish: "2099-01-01T00:00:00Z", msdyn_progress: 0 }],
      NOW,
    );
    expect(r.overdueLeafTaskCount).toBe(0);
  });
});
