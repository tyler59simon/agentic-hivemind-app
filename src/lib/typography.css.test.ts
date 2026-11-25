// @ts-expect-error no @types/node package (as in vite.config.ts); vitest empties CSS imports, so the file is read directly
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DOC_WIDTHS, FONT_STACKS, TYPE_DEFAULTS } from "./fonts";

const css: string = readFileSync(new URL("../App.css", import.meta.url), "utf8");
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
    expect(rule(".note")).toContain("max-width: var(--doc-width);");
    for (const selector of [".markdown", ".md-editor"]) expect(rule(selector), selector).toContain("font-family: var(--font-doc);");
    expect(rule(".markdown")).toContain("line-height: var(--doc-line-height);");
  });

  it("has no use of the old --font-sans token", () => {
    expect(css).not.toContain("--font-sans");
  });
});
