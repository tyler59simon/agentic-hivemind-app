import { describe, expect, it } from "vitest";
import { facetsOf, formatTagCounts, parseTags, SYSTEM_TAG_MESSAGE, tagUsage } from "./taxonomy";

describe("taxonomy", () => {
  it("counts usage per facet, merges overlapping page #tags, and lists page-only tags separately", () => {
    const { byFacet, unknown, pageOnly } = tagUsage(
      ["subject/project", "concern/bug", "technology/python", "concern/decision"],
      [{ tags: ["subject/project", "concern/bug"] }, { tags: ["subject/project", "concern/legacy"] }, { tags: ["concern/legacy"] }],
      undefined,
      [
        { tag: "technology/python", count: 2 },
        { tag: "Concern/Legacy", count: 1 },
        { tag: "roadmap", count: 3 },
        { tag: "draft", count: 1 },
      ],
    );
    expect(byFacet.subject).toEqual([{ tag: "subject/project", count: 2, pageCount: 0, known: true }]);
    expect(byFacet.concern.map((t) => [t.tag, t.count, t.pageCount])).toEqual([["concern/bug", 1, 0], ["concern/decision", 0, 0]]);
    expect(byFacet.technology).toEqual([{ tag: "technology/python", count: 0, pageCount: 2, known: true }]);
    expect(byFacet.platform).toEqual([]);
    expect(unknown).toEqual([{ tag: "concern/legacy", count: 2, pageCount: 1, known: false }]);
    expect(pageOnly).toEqual([
      { tag: "roadmap", count: 0, pageCount: 3, known: false },
      { tag: "draft", count: 0, pageCount: 1, known: false },
    ]);
  });

  it("formats combined note and page counts cleanly", () => {
    expect(formatTagCounts({ count: 0, pageCount: 0 })).toBe("unused");
    expect(formatTagCounts({ count: 1, pageCount: 0 })).toBe("1 note");
    expect(formatTagCounts({ count: 0, pageCount: 2 })).toBe("2 pages");
    expect(formatTagCounts({ count: 3, pageCount: 1 })).toBe("3 notes · 1 page");
  });

  it("parses new tags and rejects what LM would", () => {
    expect(parseTags("Platform/Linux, technology/rust  concern/x")).toEqual({ tags: ["platform/linux", "technology/rust", "concern/x"], invalid: [] });
    expect(parseTags("misc/thing, subject/, nofacet").invalid).toEqual(["misc/thing", "subject/", "nofacet"]);
  });

  it("takes facets from the taxonomy, falling back to the built-ins plus project and system", () => {
    expect(facetsOf({ facets: ["subject", "area"] })).toEqual(["subject", "area"]);
    expect(facetsOf({})).toEqual(["subject", "concern", "platform", "technology", "project", "system"]);
    expect(parseTags("system/billing concern/x")).toEqual({ tags: ["concern/x"], invalid: ["system/billing"], error: SYSTEM_TAG_MESSAGE });
    expect(parseTags("area/x", ["area"]).tags).toEqual(["area/x"]);
  });

  it("refuses new project/ tags", () => {
    const r = parseTags("project/foo, concern/x");
    expect(r.tags).toEqual(["concern/x"]);
    expect(r.invalid).toEqual(["project/foo"]);
    expect(r.error).toBe("Create a project instead of adding project/ tags here");
    expect(parseTags("concern/x").error).toBeUndefined();
  });
});
