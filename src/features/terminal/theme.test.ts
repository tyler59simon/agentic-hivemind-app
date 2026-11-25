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

  it("takes the text, background, cursor and selection from the system colours when given them, and leaves the 16 ANSI colours", () => {
    const system = { canvas: "rgb(0, 0, 0)", text: "rgb(255, 255, 255)", highlight: "rgb(26, 235, 255)", highlightText: "rgb(0, 0, 0)", gray: "rgb(63, 242, 63)" };
    const read = (token: string) => `<${token}>`;
    const t = xtermTheme(read, system);
    expect([t.background, t.foreground, t.cursor, t.cursorAccent, t.selectionBackground, t.selectionForeground])
      .toEqual([system.canvas, system.text, system.highlight, system.canvas, system.highlight, system.highlightText]);
    const { background, foreground, cursor, cursorAccent, selectionBackground, selectionForeground, ...ansi } = t;
    const { background: _b, foreground: _f, cursor: _c, cursorAccent: _a, selectionBackground: _s, selectionForeground: _sf, ...plain } = xtermTheme(read);
    expect(ansi).toEqual(plain);
    expect(Object.keys(ansi)).toHaveLength(16);
    expect(xtermTheme(read, null)).toEqual(xtermTheme(read));
  });
});
