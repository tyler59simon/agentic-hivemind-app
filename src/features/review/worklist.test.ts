import { describe, expect, it } from "vitest";
import type { ReviewResult, ReviewRow } from "../../lib/lm";
import { countKinds, countLine, inboxTabs, inboxTotal, kindCounts, NO_COUNTS, primaryAction, shownKind, worklistRows } from "./worklist";

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
    expect(primaryAction({ action: "archive" })).toEqual({ kind: "archive", label: "Archive…" });
    expect(primaryAction({ action: "merge-plan", pair })).toEqual({ kind: "merge", label: "Merge…" });
    expect(primaryAction({ action: "supersede", pair })).toEqual({ kind: "merge", label: "Merge…" });
    expect(primaryAction({ action: "merge-plan" })).toEqual({ kind: "open", label: "Open" });
  });
});

describe("inbox groups", () => {
  const counts = { ...NO_COUNTS, code: 3, memory: 2, captures: 1 };

  it("adds every group into one total, which is the badge and the All tab", () => {
    expect(inboxTotal(NO_COUNTS)).toBe(0);
    expect(inboxTotal(counts)).toBe(6);
    expect(inboxTotal({ code: 1, memory: 2, pages: 3, captures: 4, maintenance: 5, architecture: 6, skills: 7 })).toBe(28);
  });

  it("offers All and the groups that have something, counts included", () => {
    const tabs = inboxTabs(counts);
    expect(tabs.map((t) => `${t.id}:${t.count}`)).toEqual(["all:6", "code:3", "memory:2", "captures:1"]);
    expect(tabs[0].count).toBe(tabs.slice(1).reduce((n, t) => n + t.count, 0));
    expect(inboxTabs(NO_COUNTS)).toEqual([{ id: "all", label: "All", count: 0 }]);
  });

  it("falls back to All when the group asked for is empty", () => {
    expect(shownKind("memory", counts)).toBe("memory");
    expect(shownKind("pages", counts)).toBe("all");
    expect(shownKind("all", NO_COUNTS)).toBe("all");
  });

  it("counts the kinds of the rows it is given", () => {
    const rows = [row({ kinds: ["stale", "due"] }), row({ kinds: ["stale"] }), row({})];
    expect(countKinds(rows)).toEqual({ stale: 2, due: 1, interim: 0, duplicate: 0, warned: 0, noisy: 0 });
  });
});
