import { describe, expect, it } from "vitest";
import { facetsOf, parseTags, SYSTEM_TAG_MESSAGE, tagUsage } from "./taxonomy";

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
