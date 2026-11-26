import { describe, expect, it } from "vitest";
import { ago, fuzzy, highlight, lineDiff, terms } from "./text";

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

describe("ago", () => {
  const now = Date.parse("2026-11-15T12:00:00Z");
  it("says today, yesterday and a day count, for dates and for milliseconds", () => {
    expect(ago("2026-11-15T01:00:00Z", now)).toBe("today");
    expect(ago(now - 86_400_000 * 1.5, now)).toBe("yesterday");
    expect(ago("2026-11-10T12:00:00Z", now)).toBe("5 days ago");
  });
  it("falls back to the date after two months, and to nothing for a bad time", () => {
    expect(ago("2026-01-02T03:00:00Z", now)).toBe("2026-01-02");
    expect(ago(Date.parse("2026-01-02T03:00:00Z"), now)).toBe("2026-01-02");
    expect(ago(Number.NaN, now)).toBe("");
  });
});

// Codex re-review, N01: the merge composer shows what changed in a note as these lines.
describe("lineDiff", () => {
  it("shows the changed lines with one unchanged line on each side", () => {
    expect(lineDiff("a\nb\nc\nd", "a\nb\nC\nX\nd")).toBe(" b\n-c\n+C\n+X\n d");
    expect(lineDiff("same", "same")).toBe("");
    expect(lineDiff("", "new")).toBe("-\n+new");
  });
});
