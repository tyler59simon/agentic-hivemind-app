// @vitest-environment jsdom
// The region splitters (DESK-LAYOUT, review C2): value, limits and drag start are what is drawn now, not what was saved, so a
// width the window has no room for does not stall the divider, and the window growing is followed without a re-render of the page.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({}) }));

const { RailSplitter, SidebarSplitter, TreeSplitter } = await import("./RegionSplitters");
const { useLayout } = await import("./layout");
const { useApp } = await import("../store");
const { useWorkspace } = await import("../workspace/store");

let root: Root | null = null;
const sep = (label: string) => document.querySelector<HTMLElement>(`[role='separator'][aria-label='${label}']`)!;
const num = (el: HTMLElement, attr: string) => Number(el.getAttribute(attr));
const key = (el: Element, k: string, mods: Partial<KeyboardEventInit> = {}) => act(() => { el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...mods })); });
const resizeTo = (px: number) => act(() => { Object.defineProperty(window, "innerWidth", { value: px, configurable: true }); window.dispatchEvent(new Event("resize")); });

beforeEach(async () => {
  document.documentElement.style.fontSize = "16px";
  Object.defineProperty(window, "innerWidth", { value: 1101, configurable: true });
  // The Notes page with a document open and the rail on, every region saved at its largest.
  useApp.setState({ route: { page: "notes" } });
  useWorkspace.setState({ panes: [{ id: "p0", tabs: [{ id: "t", kind: "note", ref: "d:1" }], active: "t", size: 1 }], focused: "p0", rail: true, railSplit: false, railNarrow: false });
  useLayout.setState({ sidebarWidth: 24, treeWidth: 28, railWidth: 32, sidebarCollapsed: false, focusMode: false });
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<><SidebarSplitter /><TreeSplitter /><RailSplitter /></>));
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  document.documentElement.style.fontSize = "";
  Object.defineProperty(window, "innerWidth", { value: 1024, configurable: true });
  useLayout.setState({ sidebarWidth: 15.4, treeWidth: 16, railWidth: null });
});

describe("what the dividers report", () => {
  it("is the width drawn, with a range that holds it (1101 px, all maxima: the rail 15, the list 15.8)", () => {
    expect(num(sep("Context rail width"), "aria-valuenow")).toBe(15);
    expect(num(sep("Notes list width"), "aria-valuenow")).toBeCloseTo(15.81, 1);
    expect(num(sep("Sidebar width"), "aria-valuenow")).toBe(24);
    for (const label of ["Context rail width", "Notes list width", "Sidebar width"]) {
      const s = sep(label);
      expect(num(s, "aria-valuenow"), label).toBeGreaterThanOrEqual(num(s, "aria-valuemin"));
      expect(num(s, "aria-valuenow"), label).toBeLessThanOrEqual(num(s, "aria-valuemax"));
    }
  });

  it("names the region each one controls", () => {
    expect(sep("Sidebar width").getAttribute("aria-controls")).toBe("app-sidebar");
    expect(sep("Notes list width").getAttribute("aria-controls")).toBe("notes-tree");
    expect(sep("Context rail width").getAttribute("aria-controls")).toBe("note-rail");
  });

  it("moves from the drawn width: one step down is a real step, and the saved width follows it", () => {
    // Saved 28 but drawn 15.8: a step down must not be swallowed by the difference.
    key(sep("Notes list width"), "ArrowLeft");
    expect(useLayout.getState().treeWidth).toBeCloseTo(14.81, 1);
    expect(num(sep("Notes list width"), "aria-valuenow")).toBeCloseTo(14.81, 1);
  });

  it("cannot grow past what the window has room for", () => {
    key(sep("Notes list width"), "ArrowRight");
    key(sep("Notes list width"), "End");
    // Nothing to give: the saved preference stays, and the divider stays where it is.
    expect(useLayout.getState().treeWidth).toBe(28);
    expect(num(sep("Notes list width"), "aria-valuenow")).toBeCloseTo(15.81, 1);
  });

  it("follows the window as it grows, without the page drawing again: the saved widths come back", async () => {
    await resizeTo(2560);
    expect(num(sep("Notes list width"), "aria-valuenow")).toBe(28);
    expect(num(sep("Context rail width"), "aria-valuenow")).toBe(32);
    key(sep("Context rail width"), "ArrowLeft"); // the rail grows to the left: this makes it wider
    expect(useLayout.getState().railWidth).toBe(32); // held at its limit
    key(sep("Context rail width"), "ArrowRight");
    expect(useLayout.getState().railWidth).toBe(31);
  });

  it("starts the rail from its automatic width, not from a jump, when it was never set", async () => {
    useLayout.setState({ railWidth: null });
    await resizeTo(1500);
    const before = num(sep("Context rail width"), "aria-valuenow");
    expect(before).toBeCloseTo(22.5, 1); // 24 vw of 1500 px at 16 px
    key(sep("Context rail width"), "ArrowLeft");
    expect(useLayout.getState().railWidth).toBeCloseTo(23.5, 1);
    await resizeTo(1000);
    useLayout.setState({ railWidth: null });
  });

  it("goes to the default on a double click", () => {
    act(() => { sep("Notes list width").dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
    expect(useLayout.getState().treeWidth).toBe(16);
    act(() => { sep("Context rail width").dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
    expect(useLayout.getState().railWidth).toBeNull();
  });
});
