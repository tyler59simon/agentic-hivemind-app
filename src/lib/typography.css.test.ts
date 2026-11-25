// @ts-expect-error no @types/node package (as in vite.config.ts); vitest empties CSS imports, so the file is read directly
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DOC_WIDTHS, FONT_STACKS, TYPE_DEFAULTS } from "./fonts";

const css: string = readFileSync(new URL("../App.css", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const rule = (selector: string) => css.split("\n").find((l) => l.startsWith(`${selector} {`)) ?? "";
const root = css.slice(css.indexOf(":root {"), css.indexOf("\n}\n", css.indexOf(":root {")));

describe("the typography tokens (DESK-TYPE)", () => {
  it("starts from the defaults lib/fonts.ts names", () => {
    expect(root).toContain(`--font-ui: ${FONT_STACKS[TYPE_DEFAULTS.ui_font]};`);
    expect(root).toContain(`--font-mono: ${FONT_STACKS[TYPE_DEFAULTS.mono_font]};`);
    expect(root).toContain("--font-doc: var(--font-ui);");
    expect(root).toContain(`--doc-line-height: ${TYPE_DEFAULTS.doc_line_height};`);
    expect(root).toContain(`--doc-width: ${DOC_WIDTHS.find((w) => w.value === TYPE_DEFAULTS.doc_width)!.width};`);
    expect(root).toContain("font-family: var(--font-ui);");
  });

  it("reads them in notes and editors", () => {
    // Only the Markdown reading and editing columns follow the width; Hmdoc, Canvas, Draw.io and the others keep 54rem (review C2).
    expect(rule(".note")).toContain("max-width: 54rem;");
    expect(rule(".note.doc-column")).toContain("max-width: var(--doc-width);");
    for (const selector of [".markdown", ".md-editor"]) expect(rule(selector), selector).toContain("font-family: var(--font-doc);");
    expect(rule(".markdown")).toContain("line-height: var(--doc-line-height);");
  });

  it("has a spacing scale, N / 20 rem, that compact density replaces step by step", () => {
    const scale = (block: string) => new Map([...block.matchAll(/^\s*--(sp-\d+|row-h|tree-row-h|control-h): ([\d.]+)rem;/gm)].map((m) => [m[1], Number(m[2])] as const));
    const comfortable = scale(root);
    const compactStart = css.indexOf(':root[data-density="compact"] {');
    expect(compactStart).toBeGreaterThan(0);
    const compact = scale(css.slice(compactStart, css.indexOf("\n}\n", compactStart)));
    const steps = [...comfortable.keys()].filter((k) => k.startsWith("sp-"));
    expect(steps.length).toBeGreaterThan(10);
    for (const step of steps) expect(comfortable.get(step)).toBeCloseTo(Number(step.slice(3)) / 20, 4);
    expect([...compact.keys()]).toEqual([...comfortable.keys()]);
    for (const [name, value] of compact) expect(value, name).toBeLessThan(comfortable.get(name)!);
    // Nothing is thinner than a pixel or two at a 16 px root: the smallest step stays above 1 px.
    for (const [name, value] of compact) expect(value * 16, name).toBeGreaterThan(1);
  });

  it("uses only steps that exist, and leaves document text on its own spacing", () => {
    const used = new Set([...css.matchAll(/var\(--(sp-\d+)\)/g)].map((m) => m[1]));
    const defined = new Set([...root.matchAll(/^\s*--(sp-\d+):/gm)].map((m) => m[1]));
    expect([...used].filter((u) => !defined.has(u))).toEqual([]);
    expect(used.size).toBeGreaterThan(10);
    for (const selector of [".markdown", ".md-editor", ".canvas-text"]) {
      const own = css.split("\n").filter((l) => l.startsWith(`${selector} `) || l.startsWith(`${selector},`));
      expect(own.length, selector).toBeGreaterThan(0);
      expect(own.filter((l) => l.includes("var(--sp-")), selector).toEqual([]);
    }
  });

  it("starts the narrow rail under the tab strip in either density (review R1)", () => {
    const rail = css.split("\n").find((l) => l.startsWith(".notes-area.narrow .note-rail {"))!;
    // Comfortable: 2.1rem tab + 2 x .5rem padding + .05rem + 1px = the old 3.15rem + 1px.
    expect(rail).toContain("top: calc(var(--row-h) + 2 * var(--sp-10) + .05rem + 1px);");
    expect(rule(".note-tabs")).toContain("padding: var(--sp-10) var(--sp-16);");
    expect(rule(".note-tab-pill")).toContain("height: var(--row-h);");
  });

  it("has no use of the old --font-sans token", () => {
    expect(css).not.toContain("--font-sans");
  });
});
