import { describe, expect, it } from "vitest";
import { snoozeDate } from "./work";

describe("work helpers", () => {
  it("snoozes in local time as YYYY-MM-DD", () => {
    expect(snoozeDate(7, new Date(2026, 10, 30, 23, 30))).toBe("2026-12-07");
    expect(snoozeDate(30, new Date(2026, 0, 5))).toBe("2026-02-04");
  });
});
