import { describe, expect, it } from "vitest";
import type { SearchHit } from "../../lib/lm";
import { byUpdatedDesc, filterMemoryItems, fromSearchHit, hitRef, MEMORY_DISPLAY_LIMIT, memoryProjectLabel, memorySearchOptions, type MemoryItem } from "./memory";

const item = (over: Partial<MemoryItem>): MemoryItem => ({
  ref: "d:1", domain: "d", title: "T", type: "knowledge", status: "active", tags: [], updated: "2026-11-01", snippet: "", ...over,
});

describe("unified memory search helpers (CON-11)", () => {
  it("normalizes bare ids and domain:id refs", () => {
    expect(hitRef({ id: "abc", domain: "demo" })).toBe("demo:abc");
    expect(hitRef({ id: "demo:abc", domain: "demo" })).toBe("demo:abc");
    const hit = { id: "abc", domain: "demo", title: "Note", type: "decision", status: "active", tags: ["project/pay"], updated: "2026-11-20", snippet: "s" } as SearchHit;
    expect(fromSearchHit(hit).ref).toBe("demo:abc");
  });

  it("builds search options across all domains and widens the net when client-side filtering is needed", () => {
    const base = { query: "plan", domain: "demo", status: "active" as const, noteType: "", tag: "" };
    expect(memorySearchOptions(base)).toEqual({ query: "plan", domain: "demo", scope: "all", type: undefined, status: "active", tag: undefined, limit: MEMORY_DISPLAY_LIMIT });
    expect(memorySearchOptions({ ...base, noteType: "decision", projectTag: "project/pay" })).toMatchObject({ type: "decision", tag: "project/pay", limit: MEMORY_DISPLAY_LIMIT });
    expect(memorySearchOptions({ ...base, status: "archived" })).toMatchObject({ status: undefined, limit: 60 });
    expect(memorySearchOptions({ ...base, tag: "concern/bug", projectTag: "project/pay" })).toMatchObject({ tag: "concern/bug", limit: 60 });
  });

  it("filters by status, note type, and required tags", () => {
    const items = [
      item({ ref: "d:1", type: "decision", status: "active", tags: ["project/pay", "concern/bug"] }),
      item({ ref: "d:2", type: "bug", status: "resolved", tags: ["project/pay"] }),
      item({ ref: "d:3", type: "plan", status: "archived", tags: [] }),
    ];
    expect(filterMemoryItems(items, { status: "active", noteType: "", tags: [] }).map((i) => i.ref)).toEqual(["d:1"]);
    expect(filterMemoryItems(items, { status: "archived", noteType: "", tags: [] }).map((i) => i.ref)).toEqual(["d:2", "d:3"]);
    expect(filterMemoryItems(items, { status: "any", noteType: "bug", tags: ["project/pay"] }).map((i) => i.ref)).toEqual(["d:2"]);
    expect(filterMemoryItems(items, { status: "active", noteType: "", tags: ["project/pay", "concern/bug"] }).map((i) => i.ref)).toEqual(["d:1"]);
  });

  it("sorts newest updated first and labels projects", () => {
    const sorted = byUpdatedDesc([item({ ref: "a", updated: "2026-11-01" }), item({ ref: "b", updated: "2026-11-10" })]);
    expect(sorted.map((i) => i.ref)).toEqual(["b", "a"]);
    const names = new Map([["project/pay", "Paystream"]]);
    expect(memoryProjectLabel(["project/pay", "concern/bug"], names)).toBe("Paystream");
    expect(memoryProjectLabel(["concern/bug"], names)).toBe("Unassigned");
    expect(memoryProjectLabel(["project/pay"], new Map())).toBeNull();
  });
});
