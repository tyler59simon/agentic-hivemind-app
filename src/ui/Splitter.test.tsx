// @vitest-environment jsdom
// The splitter (DESK-LAYOUT): the ARIA window splitter pattern, keys, pointer drag and reset.
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Splitter } from "./Splitter";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
const onReset = vi.fn();
const sep = () => document.querySelector<HTMLElement>("[role='separator']")!;

/** Holds the value, as a caller does; `reverse` is a region on the right. */
function Host({ start = 16, reverse = false }: { start?: number; reverse?: boolean }) {
  const [value, setValue] = useState(start);
  return <Splitter label="Sidebar width" value={value} min={12} max={24} step={1} bigStep={4} pxPerUnit={10} reverse={reverse} text={`${value} rem`} onChange={setValue} onReset={onReset} />;
}
const mount = async (props: { start?: number; reverse?: boolean } = {}) => {
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<Host {...props} />));
};
const key = (k: string, mods: Partial<KeyboardEventInit> = {}) => {
  const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...mods });
  act(() => { sep().dispatchEvent(e); });
  return e;
};
/** jsdom has no PointerEvent: a MouseEvent of the same type carries the coordinates React reads. */
const pointer = (type: string, clientX: number, extra: Record<string, unknown> = {}) => {
  const e = new MouseEvent(type, { clientX, button: 0, bubbles: true, cancelable: true });
  Object.assign(e, { pointerId: 1 }, extra);
  act(() => { sep().dispatchEvent(e); });
  return e;
};
const now = () => Number(sep().getAttribute("aria-valuenow"));

beforeEach(() => onReset.mockClear());
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

describe("the separator", () => {
  it("is a focusable vertical separator with a name, a value and its limits", async () => {
    await mount();
    const s = sep();
    expect(s.getAttribute("aria-orientation")).toBe("vertical");
    expect(s.getAttribute("aria-label")).toBe("Sidebar width");
    expect(s.getAttribute("aria-valuenow")).toBe("16");
    expect(s.getAttribute("aria-valuemin")).toBe("12");
    expect(s.getAttribute("aria-valuemax")).toBe("24");
    expect(s.getAttribute("aria-valuetext")).toBe("16 rem");
    expect(s.tabIndex).toBe(0);
  });

  it("moves 1 with an arrow and 4 with Shift, and stops at the limits", async () => {
    await mount();
    expect(key("ArrowRight").defaultPrevented).toBe(true);
    expect(now()).toBe(17);
    key("ArrowLeft"); key("ArrowLeft");
    expect(now()).toBe(15);
    key("ArrowRight", { shiftKey: true });
    expect(now()).toBe(19);
    key("ArrowRight", { shiftKey: true }); key("ArrowRight", { shiftKey: true });
    expect(now()).toBe(24);
    key("ArrowLeft", { shiftKey: true }); key("ArrowLeft", { shiftKey: true }); key("ArrowLeft", { shiftKey: true });
    expect(now()).toBe(12);
  });

  it("goes to the limits with Home and End", async () => {
    await mount();
    key("End");
    expect(now()).toBe(24);
    key("Home");
    expect(now()).toBe(12);
  });

  it("grows to the left for a region on the right", async () => {
    await mount({ reverse: true });
    key("ArrowLeft");
    expect(now()).toBe(17);
    key("ArrowRight", { shiftKey: true });
    expect(now()).toBe(13);
  });

  it("leaves other keys and modified arrows alone", async () => {
    await mount();
    expect(key("a").defaultPrevented).toBe(false);
    expect(key("ArrowUp").defaultPrevented).toBe(false);
    expect(key("ArrowRight", { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(key("ArrowRight", { altKey: true }).defaultPrevented).toBe(false);
    expect(now()).toBe(16);
  });

  it("follows a drag by the pixels each unit is, and holds the limits", async () => {
    await mount();
    const set = vi.fn();
    sep().setPointerCapture = set;
    pointer("pointerdown", 100);
    expect(set).toHaveBeenCalledWith(1);
    expect(document.activeElement).toBe(sep());
    pointer("pointermove", 130); // +30 px at 10 px a unit
    expect(now()).toBe(19);
    pointer("pointermove", 70);
    expect(now()).toBe(13);
    pointer("pointermove", 1000);
    expect(now()).toBe(24);
    pointer("pointerup", 1000);
    pointer("pointermove", 100); // not dragging any more
    expect(now()).toBe(24);
  });

  it("drags the other way for a region on the right, and ignores another pointer and other buttons", async () => {
    await mount({ reverse: true });
    pointer("pointerdown", 100);
    pointer("pointermove", 90, { pointerId: 2 });
    expect(now()).toBe(16);
    pointer("pointermove", 80);
    expect(now()).toBe(18);
    pointer("pointercancel", 80);
    pointer("pointermove", 0);
    expect(now()).toBe(18);
    const e = new MouseEvent("pointerdown", { clientX: 5, button: 2, bubbles: true, cancelable: true });
    act(() => { sep().dispatchEvent(e); });
    pointer("pointermove", 500);
    expect(now()).toBe(18);
  });

  it("asks the caller to reset on a double click", async () => {
    await mount();
    act(() => { sep().dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
    expect(onReset).toHaveBeenCalledOnce();
  });
});
