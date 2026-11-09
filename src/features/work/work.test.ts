import { describe, expect, it } from "vitest";
import type { NoteRow, OpenItem, TimelineResult } from "../../lib/lm";
import { fromTimeline, groupOpenItems, snoozeDate, toTimeline, workScope } from "./work";

const item = (ref: string, index: number): OpenItem => ({ ref, short_ref: ref, title: ref, type: "plan", updated: "", index, item: `i${index}` });

describe("work helpers", () => {
  it("groups open items by note, keeping order", () => {
    const g = groupOpenItems([item("a:1", 1), item("b:2", 1), item("a:1", 2)]);
    expect(g.map((x) => x.ref)).toEqual(["a:1", "b:2"]);
    expect(g[0].items.map((i) => i.index)).toEqual([1, 2]);
  });
  it("snoozes in local time as YYYY-MM-DD", () => {
    expect(snoozeDate(7, new Date(2026, 10, 30, 23, 30))).toBe("2026-12-07");
    expect(snoozeDate(30, new Date(2026, 0, 5))).toBe("2026-02-04");
  });
  it("sorts timelines newest first", () => {
    const res = { ok: true, domain: "d", by: "updated", anchor: null, notes: [
      { ref: "d:1", short_ref: "1", date: "2026-01-01", type: "plan", title: "old", status: "active", anchor: true },
      { ref: "d:2", short_ref: "2", date: "2026-02-01", type: "bug", title: "new", status: "active" },
    ] } as TimelineResult;
    expect(fromTimeline(res).map((e) => e.title)).toEqual(["new", "old"]);
    expect(fromTimeline(res)[0]).not.toHaveProperty("anchor");
    const rows = [
      { ref: "d:1", title: "a", type: "plan", status: "active", created: "2026-03-01", updated: "2026-01-01" },
      { ref: "d:2", title: "b", type: "plan", status: "archived", created: "2026-01-01", updated: "2026-02-01" },
    ] as NoteRow[];
    expect(toTimeline(rows, "updated").map((e) => e.title)).toEqual(["b", "a"]);
    expect(toTimeline(rows, "created").map((e) => e.title)).toEqual(["a", "b"]);
  });
  it("scopes by api", () => {
    expect(workScope(2, "*")).toEqual({ allDomains: true });
    expect(workScope(1, "*")).toEqual({});
    expect(workScope(2, "demo")).toEqual({ domain: "demo" });
  });
});
