// @vitest-environment jsdom
// Settings, Layout (DESK-LAYOUT, review A2 / WCAG 2.5.7): the widths and the collapse can be set without dragging.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({}) }));

const { LayoutSection } = await import("./LayoutSection");
const { useLayout } = await import("../../shell/layout");
const { useWorkspace } = await import("../../workspace/store");

let root: Root | null = null;
const range = (label: string) => [...document.querySelectorAll<HTMLInputElement>("input[type='range']")].find((i) => document.querySelector(`label[for='${i.id}']`)?.textContent === label)!;
const change = (input: HTMLInputElement, value: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
});

beforeEach(async () => {
  useLayout.setState({ sidebarWidth: 15.4, treeWidth: 16, railWidth: null, sidebarCollapsed: false });
  useWorkspace.setState({ panes: [{ id: "a", tabs: [], active: null, size: 1.6 }, { id: "b", tabs: [], active: null, size: 0.4 }], focused: "a" });
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<LayoutSection />));
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

describe("the Layout settings", () => {
  it("has a labelled range for each width, in rem, with its limits, 0.1 rem steps and the value shown", () => {
    for (const [label, min, max] of [["Sidebar width", 12, 24], ["Notes list width", 12, 28], ["Rail width when docked", 15, 32]] as const) {
      const input = range(label);
      expect(input, label).toBeDefined();
      expect([input.min, input.max, input.step], label).toEqual([String(min), String(max), "0.1"]);
    }
    // F6: the slider, the readout and the spoken text are one number (the default sidebar is 15.4 rem, not a slider that says 15).
    const sidebar = range("Sidebar width");
    expect(sidebar.value).toBe("15.4");
    expect(sidebar.getAttribute("aria-valuetext")).toBe("15.4 rem");
    expect(document.querySelector(`output[for='${range("Sidebar width").id}']`)?.textContent).toBe("15.4 rem");
    expect(range("Sidebar width").getAttribute("aria-valuetext")).toBe("15.4 rem");
  });

  it("sets the widths in the layout store, held to the limits, and says so at once", () => {
    change(range("Sidebar width"), "20");
    expect(useLayout.getState().sidebarWidth).toBe(20);
    expect(document.querySelector(`output[for='${range("Sidebar width").id}']`)?.textContent).toBe("20 rem");
    change(range("Notes list width"), "13");
    expect(useLayout.getState().treeWidth).toBe(13);
    change(range("Rail width when docked"), "30");
    expect(useLayout.getState().railWidth).toBe(30);
  });

  it("shows the rail as following the window until it is set", () => {
    expect(document.querySelector(".layout")!.textContent).toContain("Follows the window until you set it.");
    change(range("Rail width when docked"), "20");
    expect(document.querySelector(".layout")!.textContent).not.toContain("Follows the window");
  });

  it("collapses and expands the sidebar with a checkbox", () => {
    const box = [...document.querySelectorAll<HTMLInputElement>("input[type='checkbox']")].find((b) => b.closest("label")?.textContent?.includes("Collapse sidebar"))!;
    act(() => box.click());
    expect(useLayout.getState().sidebarCollapsed).toBe(true);
    expect(box.checked).toBe(true);
    act(() => box.click());
    expect(useLayout.getState().sidebarCollapsed).toBe(false);
  });

  it("resets the widths, the collapse and the pane widths", () => {
    useLayout.setState({ sidebarWidth: 22, treeWidth: 20, railWidth: 28, sidebarCollapsed: true });
    const reset = [...document.querySelectorAll("button")].find((b) => b.textContent === "Reset layout")!;
    act(() => reset.click());
    expect(useLayout.getState()).toMatchObject({ sidebarWidth: 15.4, treeWidth: 16, railWidth: null, sidebarCollapsed: false });
    expect(useWorkspace.getState().panes.map((p) => p.size)).toEqual([1, 1]);
  });

  // F6: until it is set the rail follows the window, and so does what the setting shows.
  it("shows the automatic rail width as the window changes", () => {
    const at = (px: number) => act(() => { Object.defineProperty(window, "innerWidth", { value: px, configurable: true }); window.dispatchEvent(new Event("resize")); });
    const shown = () => document.querySelector(`output[for='${range("Rail width when docked").id}']`)!.textContent;
    at(1500);
    expect(shown()).toBe("22.5 rem");
    expect(range("Rail width when docked").value).toBe("22.5");
    at(1200);
    expect(shown()).toBe("18 rem");
    at(1024);
  });
});
