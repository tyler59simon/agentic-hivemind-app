// NS-7A: the calendar's month grid.
import { describe, expect, it } from "vitest";
import { monthGrid } from "./DailyViews";

describe("the calendar month", () => {
  it("starts each week on Sunday and pads the first and last week", () => {
    const weeks = monthGrid(new Date(2026, 10, 1)); // November 2026 starts on a Sunday and has 30 days
    expect(weeks).toHaveLength(5);
    expect(weeks[0][0]?.getDate()).toBe(1);
    expect(weeks[4].map((d) => d?.getDate() ?? null)).toEqual([29, 30, null, null, null, null, null]);
    // February 2026 starts on a Sunday and fits in four weeks.
    expect(monthGrid(new Date(2026, 1, 1))).toHaveLength(4);
    const dec = monthGrid(new Date(2026, 11, 1)); // starts on a Tuesday
    expect(dec[0].map((d) => d?.getDate() ?? null)).toEqual([null, null, 1, 2, 3, 4, 5]);
    expect(dec.flat().filter(Boolean)).toHaveLength(31);
  });
});
