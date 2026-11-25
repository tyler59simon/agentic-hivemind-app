// @vitest-environment jsdom
// DESKA3-PAN (WCAG 2.5.7): the preview pans with the arrow keys when it has the focus, so dragging is not the only way.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { expectNoNewAxeViolations } from "../test/axe";
import { PanZoomViewport } from "./PanZoomViewport";
import { PAN_HINT, PAN_STEP, PAN_STEP_FAR } from "./panKeys";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let el: HTMLElement;
beforeEach(async () => {
  el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<PanZoomViewport label="SVG preview" actions={<button type="button" className="mine">Copy</button>}><p>Content</p></PanZoomViewport>));
});
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.innerHTML = ""; });

const viewport = () => el.querySelector<HTMLElement>(".panzoom-viewport")!;
/** Where the content sits: the translate part of the world's transform. */
const offset = () => /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(el.querySelector<HTMLElement>(".panzoom-world")!.style.transform)!.slice(1).map(Number);
const key = async (target: Element, k: string, init: KeyboardEventInit = {}) => {
  const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init });
  await act(async () => { target.dispatchEvent(e); });
  return e;
};

describe("the pan and zoom viewport from the keyboard", () => {
  it("is a tab stop with a name and a description that says how to pan", () => {
    const v = viewport();
    expect(v.tabIndex).toBe(0);
    expect(v.getAttribute("role")).toBe("group");
    expect(v.getAttribute("aria-label")).toBe("SVG preview");
    expect(document.getElementById(v.getAttribute("aria-describedby")!)!.textContent).toBe(PAN_HINT);
    expect(PAN_HINT).toContain("arrow keys");
  });

  it("pans by a step with an arrow key and by a larger one with Shift, the way a scroll bar moves", async () => {
    const [x, y] = offset();
    const e = await key(viewport(), "ArrowDown");
    expect(e.defaultPrevented).toBe(true);
    expect(offset()).toEqual([x, y - PAN_STEP]);
    await key(viewport(), "ArrowRight");
    expect(offset()).toEqual([x - PAN_STEP, y - PAN_STEP]);
    await key(viewport(), "ArrowUp", { shiftKey: true });
    expect(offset()).toEqual([x - PAN_STEP, y - PAN_STEP + PAN_STEP_FAR]);
    await key(viewport(), "ArrowLeft", { shiftKey: true });
    expect(offset()).toEqual([x - PAN_STEP + PAN_STEP_FAR, y - PAN_STEP + PAN_STEP_FAR]);
  });

  it("leaves a key pressed on a control inside the viewport alone, and keys with Ctrl, Alt or Meta, and other keys", async () => {
    const before = offset();
    const e = await key(el.querySelector(".mine")!, "ArrowRight");
    expect(e.defaultPrevented).toBe(false);
    for (const init of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }]) expect((await key(viewport(), "ArrowRight", init)).defaultPrevented).toBe(false);
    expect((await key(viewport(), "a")).defaultPrevented).toBe(false);
    expect(offset()).toEqual(before);
  });

  it("has no axe violations", async () => {
    await expectNoNewAxeViolations(el, []);
  });
});
