import { describe, expect, it } from "vitest";
import { fontPx, xtermTheme } from "./theme";

describe("terminal theme", () => {
  it("maps the app's tokens to an xterm theme", () => {
    const t = xtermTheme((token) => "<" + token + ">");
    expect(t.background).toBe("<--bg-code>");
    expect(t.foreground).toBe("<--fg>");
    expect(t.cursor).toBe("<--accent>");
    expect(t.green).toBe("<--success>");
    expect(t.blue).toBe("#7fb0ff");
    expect(fontPx(18)).toBe(15);
    expect(fontPx(14)).toBe(12);
  });
});
