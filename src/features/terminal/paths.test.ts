import { describe, expect, it } from "vitest";
import { quotePaths } from "./paths";

describe("quotePaths", () => {
  it("quotes each path and ends with a space", () => {
    expect(quotePaths(["C:\a b\c.png"])).toBe("\"C:\a b\c.png\" ");
    expect(quotePaths(["C:\a.txt", "D:\b.txt"])).toBe("\"C:\a.txt\" \"D:\b.txt\" ");
  });
  it("gives nothing for no paths", () => {
    expect(quotePaths([])).toBe("");
  });
});
