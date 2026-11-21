// NS-3D UI pass: styles jsdom cannot lay out are checked as the rules the stylesheet holds (a selector that is gone or
// loses its declaration fails here), and the code range header says its label once.
import { describe, expect, it } from "vitest";
// @ts-expect-error type error without @types/node package
import { readFileSync } from "node:fs";

// Read from disk: Vitest hands a stylesheet imported as text back empty.
const css = (readFileSync(new URL("../../../App.css", import.meta.url), "utf8") as string).replace(/\/\*[^]*?\*\//g, "");

/** The declarations of the rule whose selector list holds `selector`, or null. */
function ruleFor(selector: string): string | null {
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (m[1].split(",").map((s) => s.trim()).includes(selector)) return m[2];
  }
  return null;
}

describe("UI-3: the drawing editor hides Excalidraw's library trigger and help button", () => {
  it("hides the library label and the help button by the selectors Excalidraw uses", () => {
    for (const selector of [
      ".hm-drawing .layer-ui__wrapper__top-right .sidebar-trigger__label-element",
      ".hm-drawing .sidebar-trigger__label-element",
      ".hm-drawing .sidebar-trigger",
      ".hm-drawing button.help-icon",
      ".hm-drawing .help-icon",
      ".hm-drawing .library-menu-browse-button",
    ]) expect(ruleFor(selector), selector).toMatch(/display:\s*none/);
  });
});

describe("UI-4: the Edit drawing button is readable on a white preview", () => {
  it("has an opaque themed background, text colour and border", () => {
    const rule = ruleFor(".hm-drawing-edit")!;
    expect(rule).toMatch(/background:\s*var\(--bg-alt\)/);
    expect(rule).toMatch(/color:\s*var\(--fg\)/);
    expect(rule).toMatch(/border:\s*1px solid var\(--border-strong\)/);
  });
});

describe("UI-6: a free-positioned block is its own stacking context", () => {
  it("isolates what is inside it, so no frame or bar rises above the page's sticky toolbar", () => {
    expect(ruleFor(".hm-freeform")).toMatch(/isolation:\s*isolate/);
    expect(ruleFor(".hm-freeform")).toMatch(/position:\s*relative/);
  });
});
