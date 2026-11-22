import { describe, expect, it } from "vitest";
import { quotePaths } from "./paths";

describe("quotePaths", () => {
  it("quotes each path and ends with a space", () => {
    expect(quotePaths(["C:\a b\c.png"])).toBe('"C:\a b\c.png" ');
    expect(quotePaths(["C:\a.txt", "D:\b.txt"])).toBe('"C:\a.txt" "D:\b.txt" ');
  });
  it("gives nothing for no paths", () => {
    expect(quotePaths([])).toBe("");
    expect(quotePaths([], "powershell")).toBe("");
  });

  // Codex review of 7320d7f, PROC-2: PowerShell expands `$` and the backtick inside double quotes.
  describe("for a PowerShell tab", () => {
    it("uses single quotes, so nothing in a name is expanded", () => {
      expect(quotePaths(["C:\Price $USD.txt"], "powershell")).toBe("'C:\Price $USD.txt' ");
      expect(quotePaths(["C:\a`b $(calc).txt"], "powershell")).toBe("'C:\a`b $(calc).txt' ");
      expect(quotePaths(["C:\my notes\a.md", "D:\b.md"], "powershell")).toBe("'C:\my notes\a.md' 'D:\b.md' ");
    });
    it("doubles a single quote, and the curly quotes PowerShell also reads as one", () => {
      expect(quotePaths(["C:\Tyler's file.txt"], "powershell")).toBe("'C:\Tyler''s file.txt' ");
      expect(quotePaths(["C:\it’s.txt"], "powershell")).toBe("'C:\it’’s.txt' ");
      expect(quotePaths(["C:\‘a’.txt"], "powershell")).toBe("'C:\‘‘a’’.txt' ");
    });
  });
});
