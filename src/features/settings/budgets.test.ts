import { describe, expect, it } from "vitest";
import { amount, EXECUTIVE_CALLS, withCallLimit } from "./budgets";

describe("budgets", () => {
  it("reads an empty field as the default and keeps zero", () => {
    expect(amount("")).toBeNull();
    expect(amount("  ")).toBeNull();
    expect(amount("0")).toBe(0);
    expect(amount("2.5")).toBe(2.5);
    expect(amount("abc")).toBeNull();
  });

  it("sets or removes one call's limit and keeps the others", () => {
    const all = { brief: 0.8, extract: 0.3 };
    expect(withCallLimit(all, "brief", 1)).toEqual({ brief: 1, extract: 0.3 });
    expect(withCallLimit(all, "brief", null)).toEqual({ extract: 0.3 });
    expect(withCallLimit({ brief: 0.8 }, "brief", null)).toBeNull();
    expect(withCallLimit(null, "extract", 0.2)).toEqual({ extract: 0.2 });
    expect(all).toEqual({ brief: 0.8, extract: 0.3 });
  });

  it("lists the two executive calls Rust knows", () => {
    expect(EXECUTIVE_CALLS.map((c) => c.id)).toEqual(["brief", "extract"]);
  });
});
