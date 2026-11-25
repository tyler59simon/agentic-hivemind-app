import { describe, expect, it } from "vitest";
import { appCss, parseCss } from "../test/css";

// Windows contrast themes (DESK-A11Y A4). The rules were tried in Edge with --force-high-contrast; this keeps the lists from shrinking:
// the selectors that mark a chosen or active state by a background colour, the focus rings, the SVG that is not recoloured by the
// browser, and every `outline: none`, each of which needs a ring of its own or a reason.

const rules = parseCss(appCss());
const forced = rules.filter((r) => r.media.includes("forced-colors: active"));
const normal = rules.filter((r) => !r.media);

/** The declarations the forced-colours rules give to exactly this selector. */
const forcedDecls = (selector: string) => {
  const merged = new Map<string, string>();
  for (const r of forced) if (r.selectors.includes(selector)) for (const [k, v] of r.decls) merged.set(k, v);
  return merged;
};
const hasRule = (selector: string, within = normal) => within.some((r) => r.selectors.includes(selector));

describe("forced colours: chosen and active states", () => {
  // Each of these is drawn with a background colour or a gradient alone, which a contrast theme removes.
  const SELECTED = [
    '[role="tab"][aria-selected="true"]', ".tree-row.on", ".wiki-tree-row.on", ".nav-item.on", ".note-tab-pill.on", ".chip.on", ".icon-button.on", ".icon-button.active",
    ".segmented .on", ".pill-tabs .on", ".folder-pick.on", ".tree-item.on", ".tag-row.on", ".palette li button.on", ".search-group li button.on",
    ".history-list button.on", ".session-item.on", ".review-item.on", ".item-row.on", ".link-row.on", ".rich-slash button.active", ".drawio-page-tab.on",
    ".docx-preview-bar button.on", ".pdf-toolbar button.on", ".panzoom-tools button.on", ".pdf-thumb-row.on", ".bigfile-row.selected", ".calendar-day.shown",
    ".mini-node.on", 'button[aria-pressed="true"]', '[aria-current="true"]',
  ];
  it("get a Highlight outline", () => {
    for (const selector of SELECTED) expect(forcedDecls(selector).get("outline"), selector).toContain("Highlight");
  });

  it("have a Highlight outline on the boards' chosen card, shape and edge label, and Highlight for the border that marks today and the open tab", () => {
    for (const selector of [".canvas-node.on", ".drawio-node.on", ".canvas-edge-label.on"]) expect(forcedDecls(selector).get("outline"), selector).toContain("Highlight");
    expect(forcedDecls(".calendar-day.today").get("border-color")).toBe("Highlight");
    expect(forcedDecls(".line-tabs .on").get("border-bottom-color")).toBe("Highlight");
  });
});

describe("forced colours: focus", () => {
  const RING = [
    "button:focus-visible", "a:focus-visible", '[role="tab"]:focus-visible', "input:focus", "select:focus", ".tree-row:focus-visible", ".page-host:focus-visible",
    ".splitter:focus-visible", ".canvas-node:focus-visible", ".drawio-node:focus-visible", ".switch input:focus-visible + span", ".note-tab-pill:has(> .tab-main:focus-visible)",
    ".top-search:focus-within", ".composer-box:focus-within", ".term-box:focus-within", ".wiki-search:focus-within", ".tag-picker:focus-within",
  ];
  it("is Highlight wherever the ring is drawn in the accent colour, and a box that shows focus by its border gets a ring", () => {
    for (const selector of RING) expect(forcedDecls(selector).get("outline-color"), selector).toBe("Highlight");
    for (const selector of [".top-search:focus-within", ".composer-box:focus-within", ".term-box:focus-within", ".wiki-search:focus-within", ".tag-picker:focus-within"]) {
      expect(forcedDecls(selector).get("outline-style"), selector).toBe("solid");
    }
  });

  // `outline: none` hides the ring the browser draws, so each selector either has a ring of its own (a rule for the replacement) or is a place that shows
  // focus in another way. A new `outline: none` fails here until it is listed.
  const REPLACED: Record<string, string> = {
    ".top-search input": ".top-search:focus-within",
    ".title-input:focus": ".title-input:focus", // its own 2 px bottom border, and Highlight in a contrast theme
    ".tag-picker input:focus": ".tag-picker:focus-within",
    ".palette input:focus": ".palette input:focus", // the bottom border turns to the accent colour
    ".bigfile": ".bigfile:focus-visible",
    ".composer textarea": ".composer-box:focus-within",
    ".wiki-search input": ".wiki-search:focus-within",
    ".canvas-board": ".canvas-board:focus-visible",
    ".drawio-shell": ".drawio-shell:focus-visible",
    ".pdf-shell": ".pdf-shell:focus-visible",
    ".page-host:focus": ".page-host:focus-visible",
    ".pane-body:focus": ".pane-body:focus-visible",
    ".note-rail:focus": ".note-rail:focus-visible",
    ".tab-main:focus": ".note-tab-pill:has(> .tab-main:focus-visible)",
  };
  const OTHER_WAY: Record<string, string> = {
    ".modal:focus": "the dialog box takes the focus as a container when it opens, and its first control is focused next",
    ".hm-lightbox": "a full-window overlay that takes the focus as a container",
    ".rich-doc": "an editing surface: the caret shows where the focus is",
    ".docx-rich-body": "an editing surface: the caret shows where the focus is",
    ".rich-raw-code .cm-editor.cm-focused": "an editor inside a bordered block: the caret shows where the focus is",
    ".pdf-note-box textarea": "a text box inside a bordered annotation: the caret shows where the focus is",
    ".pdf-text-box textarea": "a text box inside a bordered annotation: the caret shows where the focus is",
    ".pdf-whiteout-box textarea": "a text box inside a bordered annotation: the caret shows where the focus is",
  };
  it("is never removed without a replacement", () => {
    const removed = normal.filter((r) => /^(none|0)$/.test(r.decls.get("outline") ?? "")).flatMap((r) => r.selectors);
    expect(removed.length).toBeGreaterThan(10);
    for (const selector of removed) {
      const known = REPLACED[selector] ?? (OTHER_WAY[selector] ? selector : undefined);
      expect(known, `${selector} removes the focus ring: give it a replacement here, or say why none is needed`).toBeDefined();
      if (REPLACED[selector] && REPLACED[selector] !== selector) expect(hasRule(REPLACED[selector]), `${selector} is replaced by ${REPLACED[selector]}`).toBe(true);
    }
    for (const selector of [".title-input:focus", ".palette input:focus", ".canvas-board:focus-visible", ".drawio-shell:focus-visible", ".pdf-shell:focus-visible"]) {
      expect(forcedDecls(selector).get("outline"), selector).toContain("Highlight");
    }
  });
});

describe("forced colours: SVG, which the browser does not recolour", () => {
  const PAINT: [string, string, string][] = [
    [".canvas-boundary", "fill", "Canvas"], [".canvas-boundary", "stroke", "CanvasText"], [".canvas-boundary-name", "fill", "CanvasText"],
    [".canvas-edge path", "stroke", "CanvasText"], [".canvas-edge-line", "stroke", "CanvasText"], [".canvas-edge text", "fill", "CanvasText"],
    [".canvas-edge.on path", "stroke", "Highlight"], [".canvas-edge.on .canvas-arrow", "fill", "Highlight"], [".canvas-joining", "stroke", "Highlight"],
    ["#canvas-arrow path", "fill", "CanvasText"], [".canvas-arrow", "fill", "CanvasText"],
    [".drawio-shape-svg rect", "fill", "Canvas"], [".drawio-shape-svg rect", "stroke", "CanvasText"], [".drawio-shape-svg ellipse", "fill", "Canvas"],
    [".drawio-shape-svg polygon", "fill", "Canvas"], [".drawio-shape-svg path", "fill", "Canvas"], [".drawio-shape-svg line", "stroke", "CanvasText"],
    [".drawio-edges polyline:not(.canvas-edge-hit)", "stroke", "CanvasText"], [".drawio-edges polygon", "fill", "CanvasText"],
    [".drawio-edges .canvas-edge.on polyline:not(.canvas-edge-hit)", "stroke", "Highlight"],
  ];
  it("draws the architecture and canvas boards and the Draw.io shapes and arrows in system colours", () => {
    for (const [selector, prop, value] of PAINT) expect(forcedDecls(selector).get(prop), `${selector} ${prop}`).toBe(value);
  });

  it("marks added and changed nodes by line style as well as colour, and keeps the connection and resize handles visible", () => {
    expect(forcedDecls(".canvas-node.diff-added").get("outline")).toContain("double");
    expect(forcedDecls(".canvas-node.diff-changed").get("outline")).toContain("dotted");
    expect(forcedDecls(".canvas-handle").get("background")).toBe("Highlight");
    expect(forcedDecls(".canvas-corner").get("forced-color-adjust")).toBe("none");
  });
});
