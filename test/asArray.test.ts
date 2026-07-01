import { describe, it, expect } from "vitest";
import { asArray } from "../src/dataverse.js";

// asArray() is the shared parser behind the array params of add_tasks (tasks),
// assign_task (assignees), delete_tasks (taskIds/records), update_tasks
// (entities/tasks/summaryTaskIds). These tests lock in the robustness added to
// prevent the two real-world MCP failures:
//   1) a truncated/malformed JSON string for an object-array param, and
//   2) a bare scalar string (e.g. "Tobias Schüle") for a string-list param.

describe("asArray", () => {
  describe("native arrays (the preferred path)", () => {
    it("returns a real array unchanged", () => {
      const arr = [{ subject: "a" }, { subject: "b" }];
      expect(asArray(arr, "tasks")).toBe(arr);
    });

    it("returns a real string array unchanged", () => {
      expect(asArray(["Alice", "Bob"], "assignees")).toEqual(["Alice", "Bob"]);
    });

    it("coerceScalar does not disturb an already-native array", () => {
      expect(
        asArray(["Alice"], "assignees", { coerceScalar: true }),
      ).toEqual(["Alice"]);
    });
  });

  describe("JSON-encoded string (compatibility fallback)", () => {
    it("parses a valid JSON array string", () => {
      expect(asArray('["Alice","Bob"]', "assignees")).toEqual(["Alice", "Bob"]);
    });

    it("treats empty / whitespace-only string as []", () => {
      expect(asArray("", "assignees")).toEqual([]);
      expect(asArray("   ", "assignees")).toEqual([]);
    });
  });

  describe("string-list coercion (fixes the assign_task bare-string error)", () => {
    it("wraps a bare non-JSON scalar into a one-element array", () => {
      // The exact failing input from the bug report.
      expect(
        asArray("Tobias Schüle", "assignees", { coerceScalar: true }),
      ).toEqual(["Tobias Schüle"]);
    });

    it("wraps a JSON-quoted single string into a one-element array", () => {
      expect(
        asArray('"Alice"', "assignees", { coerceScalar: true }),
      ).toEqual(["Alice"]);
    });

    it("wraps a lone non-string scalar when coercion is on", () => {
      expect(asArray(5, "count", { coerceScalar: true })).toEqual([5]);
    });

    it("still parses a real JSON array even with coercion enabled", () => {
      expect(
        asArray('["a","b"]', "assignees", { coerceScalar: true }),
      ).toEqual(["a", "b"]);
    });

    it("does NOT wrap a malformed JSON-looking string — it errors instead", () => {
      // A truncated array must not become ['["Alice"'].
      expect(() =>
        asArray('["Alice"', "assignees", { coerceScalar: true }),
      ).toThrow(/must be a JSON array/);
    });
  });

  describe("object-array params reject bad input with a teaching error", () => {
    it("throws on a truncated JSON array (the add_tasks error) with an example", () => {
      let msg = "";
      try {
        asArray('[{"subject":"a"}', "tasks", {
          example: '[{"subject": "My task"}]',
        });
      } catch (e) {
        msg = (e as Error).message;
      }
      expect(msg).toMatch(/tasks must be a JSON array/);
      expect(msg).toContain('[{"subject": "My task"}]'); // the example
      expect(msg).toMatch(/pass a real array/i); // the actionable hint
    });

    it("does NOT coerce a bare string for an object-array param", () => {
      // Without coerceScalar, "hello" is a clear mistake, not a 1-item list.
      expect(() => asArray("hello", "tasks")).toThrow(/must be a JSON array/);
    });

    it("throws when a parsed value is a non-array object", () => {
      expect(() => asArray('{"subject":"a"}', "tasks")).toThrow(
        /must be a JSON array/,
      );
    });
  });
});
