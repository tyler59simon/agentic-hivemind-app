import { describe, expect, it } from "vitest";
import { appCss, parseCss } from "../../test/css";

// DESKA3-DRAWIO-WRAP. In a narrow pane the Draw.io toolbar wraps to several rows. The style bar (Fill, Stroke) used to be a second
// absolutely positioned bar at a fixed `top: 3.1rem`, which is the height of one row, so it was drawn over the lower rows. Both bars are
// now in one positioned box, laid out one after the other. jsdom has no layout, so this reads App.css for the rules that make that so.

const rules = parseCss(appCss());
/** The declarations the rules outside any media query give to exactly this selector, later rules over earlier ones. */
const declsOf = (selector: string) => {
  const merged = new Map<string, string>();
  for (const r of rules) if (!r.media && r.selectors.includes(selector)) for (const [k, v] of r.decls) merged.set(k, v);
  return merged;
};

describe("the Draw.io toolbar and style bar in a narrow pane", () => {
  it("stacks them in one absolutely positioned column, as wide as the pane allows", () => {
    const box = declsOf(".drawio-tools");
    expect(box.get("position")).toBe("absolute");
    expect(box.get("display")).toBe("flex");
    expect(box.get("flex-direction")).toBe("column");
    expect(box.get("max-width")).toBe("calc(100% - 1.2rem)");
  });

  it("lays the bars out in normal flow inside it, so the second is as far down as the first is tall", () => {
    expect(declsOf(".drawio-tools > .canvas-tools").get("position")).toBe("static");
  });

  it("gives the style bar no position or offset of its own", () => {
    for (const r of rules) {
      if (!r.selectors.some((s) => s.includes(".drawio-inspector"))) continue;
      expect(r.decls.has("top"), `${r.selectors.join(", ")} sets top`).toBe(false);
      expect(r.decls.get("position"), `${r.selectors.join(", ")} sets position`).toBeUndefined();
    }
  });

  it("leaves the canvas toolbar, which has one row of its own, as it was", () => {
    const own = declsOf(".canvas-tools");
    expect([own.get("position"), own.get("top"), own.get("left")]).toEqual(["absolute", ".6rem", ".6rem"]);
  });
});
