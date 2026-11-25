import { describe, expect, it } from "vitest";
import { appCss, parseCss, rawCss } from "../test/css";

// Target size (DESK-A11Y A4, WCAG 2.5.8). axe's target-size rule needs layout, which jsdom does not have, so this reads App.css and checks
// that each control that was under 24 by 24 CSS px has a rule that makes it that size, at every density (the sizes are in px, so they do
// not follow the spacing scale). The sizes of the controls that were already large enough were measured in a browser and are not listed.

const css = appCss();
const rules = parseCss(css);

/** The declarations the rules outside any media query give to exactly this selector, later rules over earlier ones. */
const declsOf = (selector: string) => {
  const merged = new Map<string, string>();
  for (const r of rules) if (!r.media && r.selectors.includes(selector)) for (const [k, v] of r.decls) merged.set(k, v);
  return merged;
};

/** A length in CSS px, for the forms the style sheet uses for a hit area; 0 for anything that depends on layout. */
const px = (value: string | undefined): number => {
  if (!value) return 0;
  const plain = /^(\d*\.?\d+)(px|rem)$/.exec(value);
  if (plain) return Number(plain[1]) * (plain[2] === "rem" ? 16 : 1);
  const floor = /^max\(100%, (\d+)px\)$/.exec(value); // at least this many px, more if the element is larger
  if (floor) return Number(floor[1]);
  const scaled = /^calc\((\d+)px \/ var\(--k, 1\)\)$/.exec(value); // 24 screen px on a board scaled by --k
  if (scaled) return Number(scaled[1]);
  return 0;
};

/** The size on one axis: the element's own width or min-width, or the transparent ::before box over it. */
function size(selector: string, axis: "x" | "y") {
  const [dim, min] = axis === "x" ? ["width", "min-width"] : ["height", "min-height"];
  const own = declsOf(selector);
  const before = declsOf(`${selector}::before`);
  const hitBox = before.get("position") === "absolute" && before.get("content") === '""' ? px(before.get(dim)) : 0;
  if (hitBox) expect(["relative", "absolute", "fixed", "sticky"], `${selector} is positioned, so its ::before box is laid out against it`).toContain(own.get("position"));
  return Math.max(px(own.get(dim)), px(own.get(min)), hitBox);
}

/** [selector, axes that were short]. A control with one axis already large (a divider as long as its pane) lists only the short one. */
const TARGETS: [string, "xy" | "x" | "y"][] = [
  [".tab-close", "xy"], // the mouse-only close, move and shell icons on a tab (a span)
  [".tag-x", "xy"], // remove a tag, remove a note from a chat
  [".tree-toggle", "x"], // 20.8 px wide
  [".drawio-page-del", "xy"],
  [".canvas-swatch", "xy"], // canvas, Draw.io, PDF and Word colour swatches
  [".status-menu .menu-button", "y"], // the encoding, line ending, indentation and language buttons of the status line: 19.2 px high
  [".pdf-ann-del", "xy"],
  [".hm-toggle-caret", "xy"],
  [".hm-frame-remove", "xy"],
  [".hm-frame-handle", "y"], // the move strip of a free-form frame: 19.2 px high
  [".hm-frame-corner", "xy"],
  [".rich-grip", "xy"],
  [".md-editor .cm-rich-resize", "xy"],
  [".canvas-handle", "xy"], // card and Draw.io connection handles (24 screen px at any zoom)
  [".canvas-corner", "xy"], // card and Draw.io resize handles
  [".split-divider", "x"], // 5 px wide
  [".md-editor .cm-rich-table-menu", "xy"], // a select: it grows, it cannot have a ::before
  [".briefing-notes input", "xy"], // a checkbox the author sized to 19.2 px, so it is not a user agent control
  [".switch", "y"], // the label around the 20 px track
  [".canvas-tools button:not(.canvas-swatch)", "xy"], // the icon buttons (Undo, Redo, Zoom, Fit) were 27 by 20 at compact density
  [".panzoom-tools button", "xy"],
  [".pdf-toolbar button:not(.canvas-swatch)", "xy"],
  [".docx-preview-bar button", "xy"],
  [".pdf-thumb-ops button", "xy"],
  [".icon-menu .menu-button", "xy"], // 23.2 px at compact density with a 1 em icon
];

describe("target size, WCAG 2.5.8 (DESK-A11Y A4)", () => {
  it("has a 24 px target for each control that was smaller", () => {
    for (const [selector, axes] of TARGETS) {
      if (axes.includes("x")) expect(size(selector, "x"), `${selector} is at least 24 px wide`).toBeGreaterThanOrEqual(24);
      if (axes.includes("y")) expect(size(selector, "y"), `${selector} is at least 24 px high`).toBeGreaterThanOrEqual(24);
    }
  });

  it("does not hide a hit box inside a clipping parent that the list does not know about", () => {
    // A ::before box is clipped by an ancestor with overflow: hidden. These are the parents the listed controls sit in; none clips.
    for (const parent of [".note-tab-pill", ".tag", ".chip", ".tree-row", ".drawio-page-tab", ".canvas-tools", ".pdf-toolbar", ".diagram-editor"]) {
      const overflow = declsOf(parent).get("overflow");
      if (parent === ".diagram-editor") expect(overflow, "the divider is in the middle of its parent").toBe("hidden");
      else expect(overflow, `${parent} does not clip`).not.toBe("hidden");
    }
  });

  it("keeps a hit box above the other listed controls it overlaps: the frame's remove button is positioned after the strip's box", () => {
    expect(declsOf(".hm-frame-remove").get("position")).toBe("relative");
    expect(declsOf(".hm-frame-handle").get("position")).toBe("relative");
  });

  it("draws the source and preview divider above the preview, so the preview does not cover the right half of its hit box", () => {
    expect(declsOf(".split-divider").get("position")).toBe("relative");
    expect(Number(declsOf(".split-divider").get("z-index"))).toBeGreaterThanOrEqual(1);
  });

  it("names the 2.5.8 exceptions it relies on", () => {
    expect(css).not.toMatch(/input\[type="checkbox"\][^{]*\{[^}]*(width|height)/); // a checkbox the author sizes is not a user agent control
    expect(rawCss()).toContain("Left alone on purpose, under the 2.5.8 exceptions");
  });
});
