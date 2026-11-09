import { describe, expect, it } from "vitest";
import { parseTags, tagUsage } from "./taxonomy";

describe("taxonomy", () => {
  it("counts usage per facet and finds unregistered tags", () => {
    const { byFacet, unknown } = tagUsage(
      ["subject/project", "concern/bug", "technology/python", "concern/decision"],
      [{ tags: ["subject/project", "concern/bug"] }, { tags: ["subject/project", "concern/legacy"] }, { tags: ["concern/legacy"] }],
    );
    expect(byFacet.subject).toEqual([{ tag: "subject/project", count: 2, known: true }]);
    expect(byFacet.concern.map((t) => [t.tag, t.count])).toEqual([["concern/bug", 1], ["concern/decision", 0]]);
    expect(byFacet.platform).toEqual([]);
    expect(unknown).toEqual([{ tag: "concern/legacy", count: 2, known: false }]);
  });

  it("parses new tags and rejects what LM would", () => {
    expect(parseTags("Platform/Linux, technology/rust  concern/x")).toEqual({ tags: ["platform/linux", "technology/rust", "concern/x"], invalid: [] });
    expect(parseTags("misc/thing, subject/, nofacet").invalid).toEqual(["misc/thing", "subject/", "nofacet"]);
  });
});
