// @vitest-environment jsdom
// Pane widths (DESK-LAYOUT): a splitter between two panes moves width from one to the other, keeps both wide enough, and a
// double click makes them equal.
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

const { Workspace, PANE_MIN_REM } = await import("./Workspace");
const { paneSize, useWorkspace } = await import("./store");

let root: Root | null = null;
let widthOf: (el: Element) => number = () => 0;
vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
  return { width: widthOf(this), height: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON() {} } as DOMRect;
});
const panes = (sizes: number[]) => useWorkspace.setState({
  panes: sizes.map((size, i) => ({ id: `p${i}`, tabs: [], active: null, size })), focused: "p0", dirty: {}, reveal: null,
});
const seps = () => [...document.querySelectorAll<HTMLElement>("[role='separator']")];
const sizes = () => useWorkspace.getState().panes.map(paneSize);
const key = (el: Element, k: string, mods: Partial<KeyboardEventInit> = {}) => act(() => { el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...mods })); });
const mount = async () => {
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<QueryClientProvider client={new QueryClient()}><Workspace /></QueryClientProvider>));
};

beforeEach(() => {
  // 16 px to the rem; each of two panes is 480 px (30 rem), each of three 320 px (20 rem).
  document.documentElement.style.fontSize = "16px";
  widthOf = (el) => (el.classList.contains("pane") ? (document.querySelectorAll(".pane").length === 2 ? 480 : 320) : 0);
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  document.documentElement.style.fontSize = "";
});

describe("the splitter between panes", () => {
  it("is not there for one pane, and is one separator between each two panes", async () => {
    panes([1]);
    await mount();
    expect(seps()).toHaveLength(0);
    await act(async () => root?.unmount());
    root = null;
    panes([1, 1, 1]);
    await mount();
    expect(seps().map((s) => s.getAttribute("aria-label"))).toEqual(["Width of panes 1 and 2", "Width of panes 2 and 3"]);
  });

  it("lies in a zero-width slot between the panes and gives each pane its size to grow by", async () => {
    panes([1.5, 0.5]);
    await mount();
    const children = [...document.querySelector(".workspace")!.children].map((c) => c.className.split(" ")[0]);
    expect(children).toEqual(["pane", "pane-gap", "pane"]);
    expect([...document.querySelectorAll<HTMLElement>(".pane")].map((p) => p.style.flexGrow)).toEqual(["1.5", "0.5"]);
  });

  it("scales the sizes so they never add up to less than one (a pane left alone after a drag fills the row)", async () => {
    panes([0.3]);
    await mount();
    expect(document.querySelector<HTMLElement>(".pane")!.style.flexGrow).toBe("1");
  });

  it("reports the left pane's share and its limits in percent", async () => {
    panes([1, 3]);
    await mount();
    const s = seps()[0];
    expect(s.getAttribute("aria-valuenow")).toBe("25");
    expect(s.getAttribute("aria-valuetext")).toBe("25% and 75%");
    // The minimum is 14 rem of the 60 rem the two have together.
    const min = (PANE_MIN_REM / 60) * 100;
    expect(Number(s.getAttribute("aria-valuemin"))).toBeCloseTo(min, 1);
    expect(Number(s.getAttribute("aria-valuemax"))).toBeCloseTo(100 - min, 1);
  });

  it("moves 1 rem with an arrow and 4 rem with Shift, keeping what the two have together", async () => {
    panes([1, 1]);
    await mount();
    key(seps()[0], "ArrowRight");
    const [a, b] = sizes();
    expect(a + b).toBeCloseTo(2, 5);
    expect(a).toBeCloseTo(1 + 2 / 60, 1); // 1 rem of the 60 rem moves 1/60 of the total 2
    key(seps()[0], "ArrowLeft", { shiftKey: true });
    expect(sizes()[0]).toBeCloseTo(1 - 3 * (2 / 60), 1);
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

  it("shares what there is when two panes together are narrower than two minimums", async () => {
    widthOf = (el) => (el.classList.contains("pane") ? 192 : 0); // 12 rem each
    panes([1, 1]);
    await mount();
    expect(Number(seps()[0].getAttribute("aria-valuemin"))).toBe(50);
    expect(Number(seps()[0].getAttribute("aria-valuemax"))).toBe(50);
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
