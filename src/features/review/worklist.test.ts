import { describe, expect, it } from "vitest";
import type { ReviewResult, ReviewRow } from "../../lib/lm";
import { countLine, kindCounts, primaryAction, worklistRows } from "./worklist";

const row = (over: Partial<ReviewRow> = {}): ReviewRow => ({ ref: "d:a", title: "A", type: "knowledge", updated: "2026-11-01", ...over });
const base: ReviewResult = { ok: true, domain: null, due: 1, notes: [row({ ref: "d:old" })] };

describe("review worklist", () => {
  it("reads the rows from notes", () => {
    expect(worklistRows(base).map((r) => r.ref)).toEqual(["d:old"]);
    expect(worklistRows(undefined)).toEqual([]);
  });

  it("counts by kind, skipping zeros, in the store's order", () => {
    const counts = { stale: 2, due: 0, interim: 0, duplicate: 1, warned: 0, noisy: 3 };
    expect(kindCounts(counts)).toEqual([{ kind: "stale", count: 2 }, { kind: "duplicate", count: 1 }, { kind: "noisy", count: 3 }]);
    expect(countLine(counts)).toBe("2 stale, 1 duplicate, 3 noisy");
    expect(kindCounts(undefined)).toEqual([]);
    expect(countLine(undefined)).toBe("");
    expect(kindCounts(counts, ["due", "stale"]).map((c) => [c.kind, c.count])).toEqual([["stale", 2], ["due", 0], ["duplicate", 1], ["noisy", 3]]);
  });

  it("maps an action to the first button", () => {
    const pair = { ref: "d:b", title: "B", score: 0.9 };
    expect(primaryAction({})).toEqual({ kind: "confirm", label: "Still true" });
    expect(primaryAction({ action: "confirm" })).toEqual({ kind: "confirm", label: "Still true" });
    expect(primaryAction({ action: "update" })).toEqual({ kind: "open", label: "Open" });
    expect(primaryAction({ action: "resolve" })).toEqual({ kind: "resolve", label: "Resolve…" });
    expect(primaryAction({ action: "archive-plan" })).toEqual({ kind: "archive", label: "Archive…" });
    expect(primaryAction({ action: "merge-plan", pair })).toEqual({ kind: "merge", label: "Merge…" });
    expect(primaryAction({ action: "supersede", pair })).toEqual({ kind: "merge", label: "Merge…" });
    expect(primaryAction({ action: "merge-plan" })).toEqual({ kind: "open", label: "Open" });
  });
});
