// @vitest-environment jsdom
// Window zoom keys, steps and Ctrl+wheel (DESK-ZOOM). Outside the app the zoom is kept in this module only.
import { afterEach, describe, expect, it } from "vitest";
import { currentZoom, initZoom, setZoom, stepZoom, wheelSteps, zoomKey, zoomPercent } from "./zoom";

const key = (k: string, mods: Partial<KeyboardEventInit> = {}) => ({ key: k, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods });
let undo: (() => void) | null = null;
afterEach(async () => { undo?.(); undo = null; await setZoom(1); document.body.innerHTML = ""; });

describe("zoomKey", () => {
  it("reads Ctrl with = + - _ 0, and never AltGr or a bare key", () => {
    expect(zoomKey(key("=", { ctrlKey: true }))).toBe("in");
    expect(zoomKey(key("+", { ctrlKey: true, shiftKey: true }))).toBe("in");
    expect(zoomKey(key("-", { metaKey: true }))).toBe("out");
    expect(zoomKey(key("_", { ctrlKey: true, shiftKey: true }))).toBe("out");
    expect(zoomKey(key("0", { ctrlKey: true }))).toBe("reset");
    expect(zoomKey(key("=", { ctrlKey: true, altKey: true }))).toBeNull();
    expect(zoomKey(key("="))).toBeNull();
    expect(zoomKey(key("9", { ctrlKey: true }))).toBeNull();
  });
});

describe("stepZoom", () => {
  it("steps through the browser levels and stops at the ends", () => {
    expect(stepZoom(1, "in")).toBe(1.1);
    expect(stepZoom(1, "out")).toBe(0.9);
    expect(stepZoom(1.17, "in")).toBe(1.25);
    expect(stepZoom(1.17, "out")).toBe(1.1);
    expect(stepZoom(2, "in")).toBe(2);
    expect(stepZoom(0.5, "out")).toBe(0.5);
    expect(stepZoom(1.75, "reset")).toBe(1);
    expect(zoomPercent(0.67)).toBe("67%");
  });
});

describe("wheelSteps", () => {
  it("adds small deltas up to one step, so a touchpad pinch moves a level at a time", () => {
    const step = wheelSteps();
    expect(step(-40)).toBeNull();
    expect(step(-40)).toBeNull();
    expect(step(-40)).toBe("in");
    expect(step(120)).toBe("out");
  });
});

describe("initZoom", () => {
  it("zooms on the keys before an editor or terminal sees them, and leaves the wheel to a view that zooms itself", async () => {
    undo = initZoom(window);
    const field = document.createElement("textarea");
    const board = document.createElement("div");
    board.setAttribute("data-own-zoom", "");
    const inner = document.createElement("span");
    board.append(inner);
    const drawing = document.createElement("div");
    drawing.setAttribute("data-own-zoom", "");
    drawing.setAttribute("data-own-zoom-keys", "");
    document.body.append(field, board, drawing);
    let reached = false;
    field.addEventListener("keydown", () => { reached = true; });

    const press = (target: Element, k: string) => {
      const e = new KeyboardEvent("keydown", { key: k, ctrlKey: true, bubbles: true, cancelable: true });
      target.dispatchEvent(e);
      return e.defaultPrevented;
    };
    expect(press(field, "=")).toBe(true);
    await Promise.resolve();
    expect(currentZoom()).toBe(1.1);
    expect(reached).toBe(false);
    // A board zooms itself with the wheel but has no zoom keys: the keys still zoom the window (Codex review, DESK-R4).
    expect(press(inner, "-")).toBe(true);
    await Promise.resolve();
    expect(currentZoom()).toBe(1);
    expect(press(drawing, "=")).toBe(false);
    expect(currentZoom()).toBe(1);
    const boardWheel = new WheelEvent("wheel", { deltaY: -120, ctrlKey: true, bubbles: true, cancelable: true });
    inner.dispatchEvent(boardWheel);
    expect(boardWheel.defaultPrevented).toBe(false);
    press(field, "=");
    await Promise.resolve();

    const wheel = new WheelEvent("wheel", { deltaY: 120, ctrlKey: true, bubbles: true, cancelable: true });
    field.dispatchEvent(wheel);
    await Promise.resolve();
    expect(wheel.defaultPrevented).toBe(true);
    expect(currentZoom()).toBe(1);
    const plain = new WheelEvent("wheel", { deltaY: 120, bubbles: true, cancelable: true });
    field.dispatchEvent(plain);
    expect(plain.defaultPrevented).toBe(false);
  });
});
