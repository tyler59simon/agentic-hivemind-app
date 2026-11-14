import { describe, expect, it } from "vitest";
import type { ViewItem } from "../../lib/lm";
import { badgeClass, chipGroups, defaultTab, liveTags, linkParts, missingModel, noteBanner, noteId, passes, priorityOf, sortItems, tagKind, visibleItems, type Filters } from "./dashboard";

describe("deleted and moved notes", () => {
  const row = { note: "3a562a09-2b34-4a43-8901-c7a1801168e6", domain: "old", title: "Plan", note_title: null, path: "x.html", fresh: false, artifact_url: null, artifact_current: false, exists: true };
  it("builds the missing-note model from the registry row", () => {
    const m = missingModel(row);
    expect(m.status).toBe("missing");
    expect(m.counts.total).toBe(0);
    expect(noteBanner(m)).toMatch(/not found/);
  });
  it("takes the note ID from a ref in any domain", () => {
    expect(noteId("new:3a562a09-2b34-4a43-8901-c7a1801168e6")).toBe(row.note);
    expect(noteId(row.note)).toBe(row.note);
  });
});

const item = (index: number, over: Partial<ViewItem> = {}): ViewItem =>
  ({ index, done: false, text: `item ${index}`, tags: [], id: null, detail: null, ...over });
const none: Filters = { tab: "all", tags: new Set(), q: "" };

describe("tagKind", () => {
  it("knows priorities", () => {
    expect(["P1", "P2", "P9", "p3"].map(tagKind)).toEqual(Array(4).fill("priority"));
    expect(tagKind("P10")).toBe("other");
    expect(tagKind("P")).toBe("other");
  });
  it("knows status words, including the roadmap ones", () => {
    for (const w of ["approved", "active", "succeeded", "next", "proposed", "busy", "running", "waiting", "paused", "deprecated", "failed", "blocked", "done", "deferred", "conditional", "idea", "later", "check", "Blocked", "IDEA"]) {
      expect(tagKind(w)).toBe("status");
    }
  });
  it("calls everything else other", () => {
    expect(["ALM", "HM", "ux", "checked"].map(tagKind)).toEqual(Array(4).fill("other"));
  });
});

describe("badgeClass", () => {
  it("maps each tag to its colour", () => {
    expect(["P1", "failed", "blocked", "BLOCKED"].map(badgeClass)).toEqual(Array(4).fill("bad"));
    expect(["P2", "waiting", "paused", "deprecated"].map(badgeClass)).toEqual(Array(4).fill("warn"));
    expect(badgeClass("P3")).toBe("p3");
    expect(["approved", "active", "succeeded"].map(badgeClass)).toEqual(Array(3).fill("ok"));
    expect(["next", "proposed", "busy", "running"].map(badgeClass)).toEqual(Array(4).fill("next"));
    expect(["ALM", "done", "idea", "P4"].map(badgeClass)).toEqual(Array(4).fill(""));
  });
});

describe("chipGroups", () => {
  it("groups by kind in the order priority, status, other and sorts each group", () => {
    const items = [item(1, { tags: ["HM", "P2", "next"] }), item(2, { tags: ["ALM", "P1", "blocked", "P2"] })];
    expect(chipGroups(items)).toEqual([
      { kind: "priority", tags: ["P1", "P2"] },
      { kind: "status", tags: ["blocked", "next"] },
      { kind: "other", tags: ["ALM", "HM"] },
    ]);
  });
  it("leaves out empty groups", () => {
    expect(chipGroups([item(1, { tags: ["ALM"] })])).toEqual([{ kind: "other", tags: ["ALM"] }]);
    expect(chipGroups([])).toEqual([]);
  });
});

describe("passes", () => {
  it("filters by tab", () => {
    const done = item(1, { done: true });
    expect(passes(done, { ...none, tab: "open" })).toBe(false);
    expect(passes(done, { ...none, tab: "done" })).toBe(true);
    expect(passes(done, none)).toBe(true);
    expect(passes(item(2), { ...none, tab: "done" })).toBe(false);
  });
  it("is OR within a kind and AND across kinds", () => {
    const a = item(1, { tags: ["P1", "ALM"] }), b = item(2, { tags: ["P2", "ALM"] }), c = item(3, { tags: ["P1", "HM"] });
    const tags = (...t: string[]): Filters => ({ ...none, tags: new Set(t) });
    expect([a, b, c].map((i) => passes(i, tags("P1", "P2")))).toEqual([true, true, true]);
    expect([a, b, c].map((i) => passes(i, tags("P1", "ALM")))).toEqual([true, false, false]);
    expect([a, b, c].map((i) => passes(i, tags("ALM", "HM")))).toEqual([true, true, true]);
    expect([a, b, c].map((i) => passes(i, tags("P2", "HM")))).toEqual([false, false, false]);
  });
  it("searches text, id, tags and detail without regard to case", () => {
    const i = item(1, { text: "Cap batches", id: "ING-7", tags: ["Vault"], detail: "Uses Jitter" });
    for (const q of ["batches", "ing-7", "vault", "jitter", "  JITTER "]) expect(passes(i, { ...none, q })).toBe(true);
    expect(passes(i, { ...none, q: "nothing" })).toBe(false);
  });
});

describe("liveTags", () => {
  it("drops selected tags no item has any more", () => {
    expect([...liveTags([item(1, { tags: ["A"] })], new Set(["A", "B"]))]).toEqual(["A"]);
  });
});

describe("sorting", () => {
  const items = [item(1, { tags: ["P3"], id: "X-10" }), item(2, { id: "X-2" }), item(3, { tags: ["P1"] }), item(4, { tags: ["P1", "P2"], id: "A-1" }), item(5, { tags: ["P2"] })];
  it("keeps written order", () => expect(sortItems(items, "written").map((i) => i.index)).toEqual([1, 2, 3, 4, 5]));
  it("puts P1 first, then by written order, with unprioritised last", () => {
    expect(sortItems(items, "priority").map((i) => i.index)).toEqual([3, 4, 5, 1, 2]);
    expect(priorityOf(item(1, { tags: ["ALM", "P2"] }))).toBe(2);
    expect(priorityOf(item(1))).toBe(99);
  });
  it("sorts by ID, numeric-aware, with items that have an ID first", () => {
    expect(sortItems(items, "id").map((i) => i.id)).toEqual(["A-1", "X-2", "X-10", null, null]);
  });
  it("does not change its input", () => {
    const copy = [...items];
    sortItems(items, "id");
    expect(items).toEqual(copy);
  });
});

describe("visibleItems", () => {
  it("filters, then sorts", () => {
    const items = [item(1, { tags: ["P2"] }), item(2, { tags: ["P1"], done: true }), item(3, { tags: ["P1"] })];
    expect(visibleItems(items, { ...none, tab: "open" }, "priority").map((i) => i.index)).toEqual([3, 1]);
  });
});

describe("defaultTab", () => {
  it("opens on Open unless nothing is open", () => {
    expect(defaultTab({ open: 2, done: 1, total: 3 })).toBe("open");
    expect(defaultTab({ open: 0, done: 3, total: 3 })).toBe("all");
    expect(defaultTab({ open: 0, done: 0, total: 0 })).toBe("all");
  });
});

describe("noteBanner", () => {
  it("is empty for an active note", () => expect(noteBanner({ status: "active", superseded_by: null })).toBeNull());
  it("explains each state", () => {
    expect(noteBanner({ status: "superseded", superseded_by: "New plan" })).toBe("This note was superseded by New plan.");
    expect(noteBanner({ status: "superseded", superseded_by: null })).toBe("This note was superseded.");
    expect(noteBanner({ status: "resolved", superseded_by: null })).toBe("This note is resolved.");
    expect(noteBanner({ status: "archived", superseded_by: "Other" })).toBe("This note is archived. It was replaced by Other.");
    expect(noteBanner({ status: "missing", superseded_by: null })).toMatch(/not found/);
  });
});

describe("linkParts", () => {
  it("picks out [[links]] with their labels", () => {
    expect(linkParts("See [[Key retention period]] and [[Map#Top|the map]] now.")).toEqual([
      { text: "See " }, { link: "Key retention period", label: "Key retention period" },
      { text: " and " }, { link: "Map", label: "the map" }, { text: " now." },
    ]);
  });
  it("returns plain text as one part and nothing for empty text", () => {
    expect(linkParts("no links")).toEqual([{ text: "no links" }]);
    expect(linkParts("")).toEqual([]);
  });
});
