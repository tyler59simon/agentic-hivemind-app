import { describe, expect, it } from "vitest";
import type { RunEvent, SeqEvent } from "../../lib/agent";
import { apply, build, cost, duration, EMPTY, merge } from "./events";

const at = (seq: number, event: RunEvent): SeqEvent => ({ sessionId: "s", seq, at: 0, event });
const finished: RunEvent = { type: "finished", status: "succeeded", reason: null, costUsd: 0.5, durationMs: 65000, turns: 4, result: "ok", structured: null, denials: 1 };
const events: SeqEvent[] = [
  at(0, { type: "started", model: "m", cliVersion: "2.1", plugins: ["architecture-suite"] }),
  at(1, { type: "text", text: "Reading the repo." }),
  at(2, { type: "toolUse", id: "t1", name: "Read", summary: "README.md" }),
  at(3, { type: "toolResult", id: "t1", ok: true, summary: "# Billing" }),
  at(4, { type: "toolUse", id: "t2", name: "Bash", summary: "rm -rf x" }),
  at(5, { type: "denied", tool: "Bash", summary: "Permission to use Bash has been denied" }),
  at(6, { type: "toolResult", id: "t2", ok: false, summary: "denied" }),
  at(7, finished),
];

describe("transcript", () => {
  it("builds items in order and attaches results to their tool calls", () => {
    const t = build(events);
    expect(t.next).toBe(8);
    expect(t.items.map((i) => i.kind)).toEqual(["started", "text", "tool", "tool", "denied"]);
    expect(t.items[2]).toEqual({ kind: "tool", id: "t1", name: "Read", summary: "README.md", result: { ok: true, summary: "# Billing" } });
    expect(t.items[3]).toMatchObject({ id: "t2", result: { ok: false } });
    expect(t.finished).toEqual(finished);
    expect(t.gap).toBe(false);
  });

  it("ignores duplicates and flags a gap instead of applying out of order", () => {
    const some = build(events.slice(0, 3));
    expect(apply(some, events[1])).toBe(some);
    const ahead = apply(some, events[5]);
    expect(ahead.gap).toBe(true);
    expect(ahead.items).toHaveLength(3);
    expect(apply(ahead, events[6])).toBe(ahead);
  });

  it("a stored log plus live events equals the full stream", () => {
    const live = events.slice(4).reduce(apply, build(events.slice(0, 4)));
    expect(live).toEqual(build(events));
  });

  it("a fresh log replaces the live state unless the live state is further along", () => {
    const behind = { ...build(events.slice(0, 2)), gap: true };
    expect(merge(behind, build(events))).toEqual(build(events));
    const further = { ...build(events), gap: true };
    expect(merge(further, build(events.slice(0, 2)))).toEqual({ ...build(events), gap: false });
    expect(merge(EMPTY, EMPTY)).toEqual(EMPTY);
  });

  it("formats durations and cost", () => {
    expect(duration(42_400)).toBe("42 s");
    expect(duration(65_000)).toBe("1 min 5 s");
    expect(duration(null)).toBe("");
    expect(cost(0.456)).toBe("$0.46");
    expect(cost(null)).toBe("");
  });
});
