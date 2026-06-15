import { describe, it, expect } from "vitest";
import { pollOperationSet } from "../src/tools/applyChanges.js";

const OPEN = 192350000;
const EXECUTING = 192350001;
const FAILED = 192350002;
const COMPLETED = 192350003;
const ABANDONED = 192350004;

// Fake clock: now() reads a virtual time that sleep() advances — so the poll
// loop runs instantly while still honouring the timeout/interval arithmetic.
function fakeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

// Returns a getStatus that yields each value in sequence, repeating the last.
function statusSequence(values: (number | undefined)[]) {
  let i = 0;
  return async () => values[Math.min(i++, values.length - 1)];
}

describe("pollOperationSet", () => {
  it("returns completed as soon as the status reaches Completed", async () => {
    const clock = fakeClock();
    const r = await pollOperationSet(statusSequence([EXECUTING, EXECUTING, COMPLETED]), {
      timeoutMs: 60_000,
      intervalMs: 3_000,
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(r.result).toBe("completed");
    expect(r.statusCode).toBe(COMPLETED);
    expect(r.polls).toBe(3);
  });

  it("completes on the very first poll when PSS is already done", async () => {
    const clock = fakeClock();
    const r = await pollOperationSet(statusSequence([COMPLETED]), {
      timeoutMs: 60_000,
      intervalMs: 3_000,
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(r.result).toBe("completed");
    expect(r.polls).toBe(1);
  });

  it("returns failed (does not keep polling) when the set finishes Failed", async () => {
    const clock = fakeClock();
    const r = await pollOperationSet(statusSequence([EXECUTING, FAILED]), {
      timeoutMs: 60_000,
      intervalMs: 3_000,
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(r.result).toBe("failed");
    expect(r.statusCode).toBe(FAILED);
    expect(r.polls).toBe(2);
  });

  it("returns abandoned when the set is Abandoned", async () => {
    const clock = fakeClock();
    const r = await pollOperationSet(statusSequence([ABANDONED]), {
      timeoutMs: 60_000,
      intervalMs: 3_000,
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(r.result).toBe("abandoned");
    expect(r.polls).toBe(1);
  });

  it("times out (with the last status) if it never completes within the budget", async () => {
    const clock = fakeClock();
    const r = await pollOperationSet(statusSequence([EXECUTING]), {
      timeoutMs: 10_000,
      intervalMs: 3_000,
      sleep: clock.sleep,
      now: clock.now,
    });
    // deadline=10000: polls at t=0,3000,6000,9000 then 9000+3000>=10000 -> timeout.
    expect(r.result).toBe("timeout");
    expect(r.statusCode).toBe(EXECUTING);
    expect(r.polls).toBe(4);
  });

  it("tolerates transient read errors (undefined) and still completes", async () => {
    const clock = fakeClock();
    const r = await pollOperationSet(statusSequence([undefined, OPEN, COMPLETED]), {
      timeoutMs: 60_000,
      intervalMs: 3_000,
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(r.result).toBe("completed");
    expect(r.polls).toBe(3);
  });

  it("always polls at least once even with a zero-ish budget", async () => {
    const clock = fakeClock();
    const r = await pollOperationSet(statusSequence([EXECUTING]), {
      timeoutMs: 1,
      intervalMs: 3_000,
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(r.result).toBe("timeout");
    expect(r.polls).toBe(1);
  });
});
