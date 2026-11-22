import { describe, expect, it } from "vitest";
import { parseHex, parseOffset } from "../../lib/bigfile";
import { firstRowAt, MAX_SPACE, ROW, scrollFor, spaceHeight } from "./virtual";

describe("the scrolling window", () => {
  it("is as tall as its rows until that is more than a browser will draw", () => {
    expect(spaceHeight(100)).toBe(100 * ROW);
    expect(spaceHeight(10_000_000)).toBe(MAX_SPACE);
  });

  it("maps a scroll position to a row by row height while the rows fit", () => {
    expect(firstRowAt(0, 1000, 600)).toBe(0);
    expect(firstRowAt(ROW * 250 + 7, 1000, 600)).toBe(250);
    expect(scrollFor(250, 1000, 600)).toBe(250 * ROW);
    expect(firstRowAt(0, 0, 600)).toBe(0);
  });

  it("maps by proportion once the rows are too many, and can reach the first and the last row", () => {
    const rows = 5_000_000, view = 600;
    expect(firstRowAt(0, rows, view)).toBe(0);
    expect(firstRowAt(MAX_SPACE - view, rows, view)).toBeGreaterThanOrEqual(rows - Math.ceil(view / ROW) - 1);
    // Scrolling to a row and reading the position back gives a row within the few the scroll bar's pixel covers.
    for (const row of [1, 1234, 2_500_000, 4_999_000]) {
      const back = firstRowAt(Math.round(scrollFor(row, rows, view)), rows, view);
      expect(Math.abs(back - row)).toBeLessThanOrEqual(Math.ceil(rows * ROW / MAX_SPACE) + 1);
    }
    expect(firstRowAt(MAX_SPACE * 10, rows, view)).toBe(rows - 1);
  });
});

describe("what is typed in the hex view", () => {
  it("reads bytes as hex in the usual spellings", () => {
    expect(parseHex("de ad be ef")).toEqual([0xde, 0xad, 0xbe, 0xef]);
    expect(parseHex("DEADBEEF")).toEqual([0xde, 0xad, 0xbe, 0xef]);
    expect(parseHex("0xde, 0xad")).toEqual([0xde, 0xad]);
    expect(parseHex("de:ad-be")).toEqual([0xde, 0xad, 0xbe]);
    for (const bad of ["", "d", "xyz1", "dead b"]) expect(parseHex(bad)).toBeNull();
  });

  it("reads an offset as hex with a prefix or suffix, else as decimal", () => {
    expect(parseOffset("0x1F40")).toBe(8000);
    expect(parseOffset("1f40h")).toBe(8000);
    expect(parseOffset("8000")).toBe(8000);
    expect(parseOffset(" 8_000 ")).toBe(8000);
    expect(parseOffset("1f40")).toBeNull();
    expect(parseOffset("")).toBeNull();
  });
});
