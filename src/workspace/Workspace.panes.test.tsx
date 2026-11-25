// @vitest-environment jsdom
// Pane widths (DESK-LAYOUT): a splitter between two panes moves width from one to the other, every pane keeps its minimum
// width as drawn, the row is measured again when it changes, and the menu on the divider does what dragging does.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({}) }));
vi.mock("../features/editor/NoteTab", () => ({ NoteTab: () => null }));
vi.mock("../features/editor/NewNote", () => ({ NewNote: () => null }));
vi.mock("../features/notes/FileTab", () => ({ FileTab: () => null, saveFileTab: vi.fn() }));
vi.mock("../features/notes/NewFileTab", () => ({ NewFileTab: () => null }));
Element.prototype.scrollIntoView = () => {};

const { Workspace } = await import("./Workspace");
const { PANE_MIN_REM } = await import("../shell/budget");
const { paneSize, useWorkspace } = await import("./store");

let root: Root | null = null;
/** The width of the row of panes in px; the panes themselves have no layout in jsdom. */
let rowPx = 960;
vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
  return { width: this.classList.contains("workspace") ? rowPx : 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON() {} } as DOMRect;
});
// A ResizeObserver that tells when the test says the row changed.
const observers: { cb: () => void; target: Element | null; gone: boolean }[] = [];
class FakeObserver {
  entry = { cb: () => {}, target: null as Element | null, gone: false };
  constructor(cb: () => void) { this.entry.cb = cb; observers.push(this.entry); }
  observe(el: Element) { this.entry.target = el; }
  disconnect() { this.entry.gone = true; }
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeObserver;
const resizeRow = async (px: number) => { rowPx = px; await act(async () => observers.filter((o) => !o.gone).forEach((o) => o.cb())); };

const panes = (sizes: number[]) => useWorkspace.setState({
  panes: sizes.map((size, i) => ({ id: `p${i}`, tabs: [], active: null, size })), focused: "p0", dirty: {}, reveal: null,
});
const seps = () => [...document.querySelectorAll<HTMLElement>("[role='separator']")];
const sizes = () => useWorkspace.getState().panes.map(paneSize);
const grows = () => [...document.querySelectorAll<HTMLElement>(".pane")].map((p) => Number(p.style.flexGrow));
const key = (el: Element, k: string, mods: Partial<KeyboardEventInit> = {}) => act(() => { el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...mods })); });
const mount = async () => {
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<QueryClientProvider client={new QueryClient()}><Workspace /></QueryClientProvider>));
};

beforeEach(() => {
  document.documentElement.style.fontSize = "16px";
  rowPx = 960; // 60 rem
  observers.length = 0;
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  document.documentElement.style.fontSize = "";
});

describe("the splitter between panes", () => {
  it("is not there for one pane, and is one separator between each two panes, naming and controlling the left one", async () => {
    panes([1]);
    await mount();
    expect(seps()).toHaveLength(0);
    await act(async () => root?.unmount());
    root = null;
    panes([1, 1]);
    await mount();
    expect(seps().map((s) => s.getAttribute("aria-label"))).toEqual(["Width of the left pane"]);
    expect(seps()[0].getAttribute("aria-controls")).toBe("pane-p0");
    expect(document.getElementById("pane-p0")).not.toBeNull();
    await act(async () => root?.unmount());
    root = null;
    panes([1, 1, 1]);
    await mount();
    expect(seps().map((s) => s.getAttribute("aria-label"))).toEqual(["Width of pane 1", "Width of pane 2"]);
    expect(seps().map((s) => s.getAttribute("aria-controls"))).toEqual(["pane-p0", "pane-p1"]);
  });

  it("lies in a zero-width slot between the panes and gives each pane its share to grow by", async () => {
    panes([1.5, 0.5]);
    await mount();
    const children = [...document.querySelector(".workspace")!.children].map((c) => c.className.split(" ")[0]);
    expect(children).toEqual(["pane", "pane-gap", "pane"]);
    expect(grows()).toEqual([1.5, 0.5]);
  });

  it("fills the row whatever the sizes are (a pane left alone after a drag)", async () => {
    panes([0.3]);
    await mount();
    expect(grows()).toEqual([1]);
  });

  it("reports the left pane's share and limits that hold it, in percent", async () => {
    panes([1, 3]);
    await mount();
    const s = seps()[0];
    // 25% of 60 rem is 15 rem: above the 14 rem minimum, so as saved.
    expect(s.getAttribute("aria-valuenow")).toBe("25");
    expect(s.getAttribute("aria-valuetext")).toBe("25% and 75%");
    const min = (PANE_MIN_REM / 60) * 100;
    expect(Number(s.getAttribute("aria-valuemin"))).toBeCloseTo(min, 1);
    expect(Number(s.getAttribute("aria-valuemax"))).toBeCloseTo(100 - min, 1);
  });

  it("keeps every pane at its minimum when the window gets narrow, and the range holds the value (a restored 25/75 at 800 px)", async () => {
    panes([1, 3]);
    rowPx = 448; // 28 rem: exactly two minimums
    await mount();
    const s = seps()[0];
    expect(Number(s.getAttribute("aria-valuenow"))).toBeCloseTo(50, 1);
    expect(grows().map((g) => Math.round(g * 100) / 100)).toEqual([1, 1]);
    for (const px of [500, 560, 800]) {
      await resizeRow(px);
      const now = Number(s.getAttribute("aria-valuenow")), min = Number(s.getAttribute("aria-valuemin")), max = Number(s.getAttribute("aria-valuemax"));
      expect(now, `${px} px`).toBeGreaterThanOrEqual(min - 0.01);
      expect(now, `${px} px`).toBeLessThanOrEqual(max + 0.01);
      const left = (px / 16) * (grows()[0] / 2);
      expect(left, `${px} px`).toBeGreaterThanOrEqual(PANE_MIN_REM - 0.01);
      expect(px / 16 - left, `${px} px`).toBeGreaterThanOrEqual(PANE_MIN_REM - 0.01);
    }
    await resizeRow(960);
    expect(s.getAttribute("aria-valuenow")).toBe("25"); // the saved split comes back with the room
  });

  it("shares equally when the minimums cannot fit at all", async () => {
    rowPx = 320; // 20 rem for two panes
    panes([1, 3]);
    await mount();
    expect(grows()).toEqual([1, 1]);
    expect(Number(seps()[0].getAttribute("aria-valuemin"))).toBe(50);
    expect(Number(seps()[0].getAttribute("aria-valuemax"))).toBe(50);
  });

  it("measures the row again when it changes, not only when the window does (the rail or the sidebar changed it)", async () => {
    panes([1, 1]);
    await mount();
    expect(observers.some((o) => !o.gone && o.target?.classList.contains("workspace"))).toBe(true);
    key(seps()[0], "ArrowRight"); // 1 rem of 60
    expect(sizes()[0]).toBeCloseTo(1 + 2 / 60, 2);
    panes([1, 1]);
    await resizeRow(1500); // 93.75 rem
    key(seps()[0], "ArrowRight");
    expect(sizes()[0]).toBeCloseTo(1 + 2 / 93.75, 2);
  });

  it("stops watching when it goes", async () => {
    panes([1, 1]);
    await mount();
    await act(async () => root?.unmount());
    root = null;
    expect(observers.every((o) => o.gone)).toBe(true);
  });

  it("moves 1 rem with an arrow and 4 rem with Shift, keeping what the two have together", async () => {
    panes([1, 1]);
    await mount();
    key(seps()[0], "ArrowRight");
    const [a, b] = sizes();
    expect(a + b).toBeCloseTo(2, 5);
    expect(a).toBeCloseTo(1 + 2 / 60, 2);
    key(seps()[0], "ArrowLeft", { shiftKey: true });
    expect(sizes()[0]).toBeCloseTo(1 - 3 * (2 / 60), 2);
  });

  it("stops at the minimum width, so neither pane collapses", async () => {
    panes([1, 1]);
    await mount();
    key(seps()[0], "Home");
    const [a, b] = sizes();
    expect(a / (a + b)).toBeCloseTo(PANE_MIN_REM / 60, 2);
    key(seps()[0], "End");
    expect(sizes()[1] / 2).toBeCloseTo(PANE_MIN_REM / 60, 2);
  });

  it("makes the two panes equal on a double click, and leaves the third pane alone", async () => {
    panes([1.6, 0.4, 1]);
    await mount();
    act(() => { seps()[0].dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
    expect(sizes()).toEqual([1, 1, 1]);
    panes([0.5, 1.9, 0.6]);
    act(() => { seps()[1].dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
    expect(sizes().map((n) => Math.round(n * 100) / 100)).toEqual([0.5, 1.25, 1.25]);
  });
});

describe("the menu on the divider (a way to size the panes without dragging)", () => {
  const items = () => [...document.querySelectorAll<HTMLElement>("[role='menuitem']")];
  const open = () => act(() => { seps()[0].dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })); });

  it("opens on a right click, and from the keyboard with Shift+F10 and the Menu key", async () => {
    panes([1, 1]);
    await mount();
    open();
    expect(document.querySelector("[role='menu']")?.getAttribute("aria-label")).toBe("Pane widths");
    expect(items().map((i) => i.textContent)).toEqual(["Make left pane wider", "Make right pane wider", "Equal widths"]);
    for (const k of [{ key: "F10", shiftKey: true }, { key: "ContextMenu" }]) {
      key(document.querySelector("[role='menu']")!, "Escape");
      expect(document.querySelector("[role='menu']")).toBeNull();
      expect(document.activeElement).toBe(seps()[0]);
      const e = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...k });
      act(() => { seps()[0].dispatchEvent(e); });
      expect(e.defaultPrevented).toBe(true);
      expect(document.querySelector("[role='menu']")).not.toBeNull();
    }
  });

  it("makes the left or the right pane wider by 4 rem, and the two equal", async () => {
    panes([1, 1]);
    await mount();
    open();
    act(() => items()[0].click());
    expect(sizes()[0]).toBeCloseTo(1 + 4 * (2 / 60), 2);
    expect(document.querySelector("[role='menu']")).toBeNull();
    open();
    act(() => items()[1].click());
    expect(sizes()[0]).toBeCloseTo(1, 2);
    open();
    act(() => items()[1].click());
    expect(sizes()[0]).toBeCloseTo(1 - 4 * (2 / 60), 2);
    open();
    act(() => items()[2].click());
    expect(sizes().map((n) => Math.round(n * 100) / 100)).toEqual([1, 1]);
  });

  it("does not go past the minimum width", async () => {
    panes([1, 1]);
    rowPx = 464; // 29 rem: 14 + 15
    await mount();
    open();
    act(() => items()[0].click());
    open();
    act(() => items()[0].click());
    expect(sizes()[1] / 2).toBeGreaterThanOrEqual(PANE_MIN_REM / 29 - 0.001);
  });
});
