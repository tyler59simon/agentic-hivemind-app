import { describe, expect, it } from "vitest";
import { fontPx, xtermTheme } from "./theme";

describe("terminal theme", () => {
  it("maps the app's tokens to an xterm theme", () => {
    const t = xtermTheme((token) => "<" + token + ">");
    expect(t.background).toBe("<--term-bg>");
    expect(t.foreground).toBe("<--term-fg>");
    expect(t.cursor).toBe("<--term-cursor>");
    expect(t.green).toBe("<--term-green>");
    expect(t.blue).toBe("<--term-blue>");
    expect(fontPx(18)).toBe(15);
    expect(fontPx(14)).toBe(12);
  });
});
