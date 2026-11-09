import { describe, expect, it } from "vitest";
import { fuzzy, highlight, terms } from "./text";

describe("fuzzy", () => {
  it("matches subsequences and rejects others", () => {
    expect(fuzzy("lmrd", "Living Memory roadmap")).not.toBeNull();
    expect(fuzzy("xyz", "Living Memory roadmap")).toBeNull();
    expect(fuzzy("", "anything")).toBe(0);
  });

  it("prefers word starts and runs", () => {
    const start = fuzzy("road", "Living Memory roadmap")!;
    const scattered = fuzzy("road", "random old adder")!;
    expect(start).toBeGreaterThan(scattered);
  });
});

describe("highlight", () => {
  it("marks query terms case-insensitively", () => {
    const words = terms("Cache, the");
    expect(words).toEqual(["cache", "the"]);
    expect(highlight("The cache is rebuildable", ["cache"])).toEqual([
      { text: "The ", hit: false }, { text: "cache", hit: true }, { text: " is rebuildable", hit: false },
    ]);
  });

  it("escapes regex characters", () => {
    expect(highlight("a+b", ["a+b"])).toEqual([{ text: "a+b", hit: true }]);
  });
});
