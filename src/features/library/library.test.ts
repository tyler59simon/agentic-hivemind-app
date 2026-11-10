import { describe, expect, it } from "vitest";
import { NOTE_TYPES } from "../../lib/lm";
import { byUpdated, filterItems, GROUPS, searchFilters, type Filter, type Item } from "./library";

const item = (over: Partial<Item>): Item =>
  ({ ref: "d:1", title: "T", type: "knowledge", status: "active", domain: "d", tags: [], updated: "2026-11-01", text: "", ...over });
const all: Filter = { group: "all", shelf: "any", tags: [], domains: null };
const refs = (items: Item[]) => items.map((i) => i.ref);

describe("library", () => {
  it("puts every note type in exactly one tab besides All", () => {
    const grouped = GROUPS.flatMap((g) => g.types ?? []);
    expect([...grouped].sort()).toEqual([...NOTE_TYPES].sort());
    expect(new Set(grouped).size).toBe(grouped.length);
  });

  const items = [
    item({ ref: "d:1", type: "decision", tags: ["project/pay", "subject/x"] }),
    item({ ref: "d:2", type: "bug", status: "resolved", tags: ["project/pay"] }),
    item({ ref: "g:3", type: "plan", domain: "g", status: "archived" }),
    item({ ref: "e:4", type: "runbook", domain: "e" }),
  ];

  it("filters by tab, shelf, tags and domains together", () => {
    expect(refs(filterItems(items, all))).toEqual(["d:1", "d:2", "g:3", "e:4"]);
    expect(refs(filterItems(items, { ...all, group: "risks" }))).toEqual(["d:2"]);
    expect(refs(filterItems(items, { ...all, group: "knowledge" }))).toEqual(["e:4"]);
    expect(refs(filterItems(items, { ...all, shelf: "active" }))).toEqual(["d:1", "e:4"]);
    expect(refs(filterItems(items, { ...all, shelf: "archived" }))).toEqual(["d:2", "g:3"]);
    expect(refs(filterItems(items, { ...all, tags: ["project/pay", "subject/x"] }))).toEqual(["d:1"]);
    expect(refs(filterItems(items, { ...all, domains: ["d", "g"], shelf: "archived" }))).toEqual(["d:2", "g:3"]);
  });

  it("asks Living Memory to filter what it can, and widens the search for what is filtered here", () => {
    const base = { group: "all" as const, shelf: "active" as const, tag: "" };
    expect(searchFilters(base)).toEqual({ type: undefined, status: "active", tag: undefined, limit: 60 });
    // One type: Living Memory filters it, so the usual limit is enough.
    expect(searchFilters({ ...base, group: "decisions" })).toMatchObject({ type: "decision", limit: 60 });
    expect(searchFilters({ ...base, group: "plans" })).toMatchObject({ type: "plan", limit: 60 });
    // Several types, the archive, or a second tag are filtered here: ask for more.
    expect(searchFilters({ ...base, group: "risks" })).toMatchObject({ type: undefined, limit: 200 });
    expect(searchFilters({ ...base, shelf: "archived" })).toMatchObject({ status: undefined, limit: 200 });
    expect(searchFilters({ ...base, shelf: "any" })).toMatchObject({ status: undefined, limit: 60 });
    expect(searchFilters({ ...base, projectTag: "project/pay" })).toMatchObject({ tag: "project/pay", limit: 60 });
    expect(searchFilters({ ...base, tag: "subject/x", projectTag: "project/pay" })).toMatchObject({ tag: "subject/x", limit: 200 });
    expect(searchFilters({ ...base, tag: "subject/x" })).toMatchObject({ tag: "subject/x", limit: 60 });
  });

  it("sorts newest first without changing the input", () => {
    const rows = [item({ ref: "a", updated: "2026-11-01" }), item({ ref: "b", updated: "2026-11-09" })];
    expect(refs(byUpdated(rows))).toEqual(["b", "a"]);
    expect(refs(rows)).toEqual(["a", "b"]);
  });
});
