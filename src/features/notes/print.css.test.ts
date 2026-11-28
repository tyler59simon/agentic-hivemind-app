// DOCOS-1A: the print rules Export to PDF depends on (jsdom has no print media, so App.css is read as text).
import { describe, expect, it } from "vitest";
import { rawCss } from "../../test/css";

const css = rawCss();

describe("the print rules", () => {
  const print = css.slice(css.indexOf("@media print {"));
  const rules = print.slice(0, print.indexOf("\n}\n"));

  it("hide the copy on screen and show only it when printing, everything else in the body hidden", () => {
    expect(css).toContain("\n.print-root { display: none; }\n");
    expect(css.indexOf(".print-root { display: none; }")).toBeLessThan(css.indexOf("@media print {"));
    expect(rules).toContain("body > :not(.print-root) { display: none !important; }");
    expect(rules).toContain(".print-root { display: block;");
  });

  it("let the page run over as many sheets as it needs", () => {
    expect(rules).toContain("html, body { background: #fff !important; height: auto !important; overflow: visible !important; }");
    expect(rules).toMatch(/\.print-root pre, .*\{ break-inside: avoid; \}/);
    expect(rules).toMatch(/\.print-root h6 \{ break-after: avoid; \}/);
  });
});
