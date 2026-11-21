// NS-3D: a code range's hash, badge and Update logic.
import { describe, expect, it } from "vitest";
import { captureRange, fileLines, hashLines, rangeLabel, rangeState, updated } from "./codeRange";
import { MAX_RANGE_CHARS, MAX_RANGE_LINES } from "../rules";

const file = ["one", "two", "three", "four", "five"].join("\n");

describe("lines of a file", () => {
  it("a final line break ends the last line and does not start another", () => {
    expect(fileLines("a\nb\n")).toEqual(["a", "b"]);
    expect(fileLines("a\nb")).toEqual(["a", "b"]);
    expect(fileLines("a\n\nb\n\n")).toEqual(["a", "", "b", ""]);
    expect(fileLines("")).toEqual([]);
    expect(fileLines("\n")).toEqual([""]);
  });

  it("the hash is of the lines joined with LF", () => {
    expect(hashLines(["a", "b"])).toBe(hashLines(["a\nb"]));
    expect(hashLines(["a", "b"])).not.toBe(hashLines(["a", "b", ""]));
  });
});

describe("capturing a range", () => {
  const lines = fileLines(file);
  it("stores the lines and their hash", () => {
    const r = captureRange(lines, 2, 3);
    expect(r).toEqual({ ok: true, captured: { text: "two\nthree", sha256: hashLines(["two", "three"]) } });
  });

  it("refuses a range that is not in the file", () => {
    expect(captureRange(lines, 0, 2).ok).toBe(false);
    expect(captureRange(lines, 3, 2)).toEqual({ ok: false, reason: "The last line is before the first." });
    expect(captureRange(lines, 4, 6)).toEqual({ ok: false, reason: "The file has 5 lines." });
    expect(captureRange(lines, 1.5, 2).ok).toBe(false);
  });

  it("holds at most 200 lines and 20,000 characters", () => {
    const long = Array.from({ length: 300 }, (_, i) => `line ${i}`);
    expect(captureRange(long, 1, MAX_RANGE_LINES).ok).toBe(true);
    expect(captureRange(long, 1, MAX_RANGE_LINES + 1)).toEqual({ ok: false, reason: "A range holds at most 200 lines." });
    const wide = ["x".repeat(MAX_RANGE_CHARS / 2), "y".repeat(MAX_RANGE_CHARS / 2)];
    expect(captureRange(wide, 1, 2)).toEqual({ ok: false, reason: "A range holds at most 20,000 characters." });
    expect(captureRange(["x".repeat(MAX_RANGE_CHARS)], 1, 1).ok).toBe(true);
  });
});

describe("the badge and Update", () => {
  const stored = captureRange(fileLines(file), 2, 3);
  if (!stored.ok) throw new Error("setup");
  const attrs = { from: 2, to: 3, sha256: stored.captured.sha256, text: stored.captured.text };

  it("the same lines show the file's lines, with no badge", () => {
    expect(rangeState(attrs, file)).toEqual({ kind: "same", shown: "two\nthree" });
    // Other lines of the file may change: the range is what counts.
    expect(rangeState(attrs, `zero\n${file}`.replace("one", "uno")).kind).toBe("changed");
    expect(rangeState(attrs, file.replace("four", "FOUR")).kind).toBe("same");
  });

  it("different lines show the file's current lines, with what Update would store", () => {
    const now = file.replace("three", "THREE");
    const state = rangeState(attrs, now);
    expect(state).toEqual({ kind: "changed", shown: "two\nTHREE", current: { text: "two\nTHREE", sha256: hashLines(["two", "THREE"]) } });
    if (state.kind !== "changed") return;
    const next = updated({ ...attrs, file: "a.ts", language: "ts", title: "t" }, state.current);
    // Update stores the current lines and hash; the range, file and title stay.
    expect(next).toEqual({ from: 2, to: 3, sha256: hashLines(["two", "THREE"]), text: "two\nTHREE", file: "a.ts", language: "ts", title: "t" });
    expect(rangeState(next, now).kind).toBe("same");
  });

  it("a missing file, or a range past the end of the file, shows the stored lines", () => {
    expect(rangeState(attrs, null)).toEqual({ kind: "missing" });
    expect(rangeState(attrs, "one\ntwo")).toEqual({ kind: "past-end", lines: 2 });
    expect(rangeState(attrs, "")).toEqual({ kind: "past-end", lines: 0 });
  });

  it("a line break at the end of the file does not count as a line", () => {
    expect(rangeState({ ...attrs, from: 4, to: 5 }, `${file}\n`).kind).toBe("changed");
    expect(rangeState({ ...attrs, from: 5, to: 6 }, `${file}\n`)).toEqual({ kind: "past-end", lines: 5 });
  });
});

describe("the label", () => {
  it("is file:from-to, or file:line for one line", () => {
    expect(rangeLabel("src/a.ts", 12, 20)).toBe("src/a.ts:12-20");
    expect(rangeLabel("src/a.ts", 7, 7)).toBe("src/a.ts:7");
  });
});
