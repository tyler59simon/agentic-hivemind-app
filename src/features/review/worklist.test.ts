import { describe, expect, it } from "vitest";
import type { ReviewResult, ReviewRow } from "../../lib/lm";
import { countLine, filterByKind, kindCounts, primaryAction, worklistRows } from "./worklist";

const row = (over: Partial<ReviewRow> = {}): ReviewRow => ({ ref: "d:a", title: "A", type: "knowledge", updated: "2026-11-01", ...over });
const base: ReviewResult = { ok: true, domain: null, due: 1, notes: [row({ ref: "d:old" })] };

describe("review worklist", () => {
  it("uses items when present, else notes", () => {
    expect(worklistRows(base).map((r) => r.ref)).toEqual(["d:old"]);
    expect(worklistRows({ ...base, items: [row({ ref: "d:new" })] }).map((r) => r.ref)).toEqual(["d:new"]);
    expect(worklistRows({ ...base, items: [] })).toEqual([]);
    expect(worklistRows(undefined)).toEqual([]);
  });

  it("counts by kind, skipping zeros, in the store's order", () => {
    const counts = { stale: 2, due: 0, interim: 0, duplicate: 1, warned: 0, noisy: 3 };
    expect(kindCounts(counts)).toEqual([{ kind: "stale", count: 2 }, { kind: "duplicate", count: 1 }, { kind: "noisy", count: 3 }]);
    expect(countLine(counts)).toBe("2 stale, 1 duplicate, 3 noisy");
    expect(kindCounts(undefined)).toEqual([]);
    expect(countLine(undefined)).toBe("");
  });

  it("filters rows by any picked kind", () => {
    const rows = [row({ ref: "d:1", kinds: ["stale", "due"] }), row({ ref: "d:2", kinds: ["duplicate"] }), row({ ref: "d:3" })];
    expect(filterByKind(rows, []).length).toBe(3);
    expect(filterByKind(rows, ["due"]).map((r) => r.ref)).toEqual(["d:1"]);
    expect(filterByKind(rows, ["due", "duplicate"]).map((r) => r.ref)).toEqual(["d:1", "d:2"]);
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
