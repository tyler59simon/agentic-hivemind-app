import { describe, expect, it } from "vitest";
import type { LogRow } from "../../lib/lm";
import { groupByDay, sessionLine, targetOf } from "./log";

const row = (over: Partial<LogRow> = {}): LogRow =>
  ({ time: "2026-11-10T10:00:00", event: "created", ref: "demo:abc12345", title: "T", type: "decision", domain: "demo", projects: [], ...over });

describe("log view", () => {
  it("groups rows by day, keeping the order", () => {
    const now = new Date(2026, 10, 10, 12);
    const days = groupByDay([row({ time: "2026-11-10T11:00:00" }), row({ time: "2026-11-10T09:00:00" }), row({ time: "2026-11-09T09:00:00" })], now);
    expect(days.map((d) => [d.label, d.rows.length])).toEqual([["Today", 2], ["Yesterday", 1]]);
  });

  it("picks what a row opens", () => {
    expect(targetOf(row())).toEqual({ kind: "note", ref: "demo:abc12345" });
    expect(targetOf(row({ event: "change_update", ref: "CHG-014" }))).toEqual({ kind: "change", id: 14 });
    expect(targetOf(row({ event: "session", ref: "demo:abc12345" }))).toBeNull();
    expect(targetOf(row({ ref: "" }))).toBeNull();
  });

  it("summarizes a session", () => {
    expect(sessionLine({ harness: "claude", notes: ["a", "b"], files: ["x"] })).toBe("claude, 2 notes saved, 1 file changed");
    expect(sessionLine({})).toBe("0 notes saved, 0 files changed");
  });
});
