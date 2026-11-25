// @vitest-environment jsdom
// The layout store (DESK-LAYOUT): widths held to their limits when they are set and when they are read, the key and shape
// of what is kept, and full screen.
import { beforeEach, describe, expect, it, vi } from "vitest";

const win = { isFullscreen: vi.fn(async () => false), setFullscreen: vi.fn(async () => {}) };
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => win }));
vi.mock("../lib/native", () => ({ inTauri: () => true }));

const { LIMITS, DEFAULT_WIDTH, autoRailWidth, clampWidth, sanitize, toggleFullscreen, useLayout } = await import("./layout");

const reset = () => useLayout.setState({ sidebarWidth: 15.4, sidebarCollapsed: false, treeWidth: 16, railWidth: null, focusMode: false });
const stored = () => JSON.parse(localStorage.getItem("hivemind.layout") ?? "null");

beforeEach(() => { localStorage.clear(); reset(); win.isFullscreen.mockReset(); win.setFullscreen.mockReset(); });

describe("the limits", () => {
  it("are 12 to 24 rem for the sidebar, 12 to 28 for the tree and 15 to 32 for the rail", () => {
    expect(LIMITS).toEqual({ sidebar: { min: 12, max: 24 }, tree: { min: 12, max: 28 }, rail: { min: 15, max: 32 } });
  });

  it("hold a width written, and start at the sizes the CSS had", () => {
    expect(DEFAULT_WIDTH).toEqual({ sidebar: 15.4, tree: 16 });
    const s = () => useLayout.getState();
    s().setSidebarWidth(100); expect(s().sidebarWidth).toBe(24);
    s().setSidebarWidth(1); expect(s().sidebarWidth).toBe(12);
    s().setTreeWidth(99); expect(s().treeWidth).toBe(28);
    s().setTreeWidth(-5); expect(s().treeWidth).toBe(12);
    s().setRailWidth(99); expect(s().railWidth).toBe(32);
    s().setRailWidth(3); expect(s().railWidth).toBe(15);
    s().setRailWidth(null); expect(s().railWidth).toBeNull();
    s().setSidebarWidth(Number.NaN); expect(s().sidebarWidth).toBe(15.4);
  });

  it("repair a bad value: not a number, infinite, a string", () => {
    expect(clampWidth("sidebar", "wide", 15.4)).toBe(15.4);
    expect(clampWidth("tree", Number.POSITIVE_INFINITY, 16)).toBe(16);
    expect(clampWidth("rail", undefined)).toBe(15);
    expect(clampWidth("rail", 20)).toBe(20);
  });
});

describe("what is kept", () => {
  it("is under hivemind.layout with the three widths and the collapse flag, and not focus mode", () => {
    const s = useLayout.getState();
    s.setSidebarWidth(18); s.setTreeWidth(20); s.setRailWidth(22); s.setSidebarCollapsed(true); s.setFocusMode(true);
    expect(stored()).toEqual({ state: { sidebarWidth: 18, sidebarCollapsed: true, treeWidth: 20, railWidth: 22 }, version: 1 });
  });

  it("is read back, each width held to its limits (a hand-edited value does not break the layout)", async () => {
    localStorage.setItem("hivemind.layout", JSON.stringify({ state: { sidebarWidth: 400, sidebarCollapsed: "yes", treeWidth: "x", railWidth: 1, focusMode: true }, version: 1 }));
    await useLayout.persist.rehydrate();
    expect(useLayout.getState()).toMatchObject({ sidebarWidth: 24, sidebarCollapsed: false, treeWidth: 16, railWidth: 15, focusMode: false });
  });

  it("starts from the defaults when nothing is stored or the value is not an object", async () => {
    await useLayout.persist.rehydrate();
    expect(useLayout.getState()).toMatchObject({ sidebarWidth: 15.4, treeWidth: 16, railWidth: null, sidebarCollapsed: false });
    expect(sanitize("junk")).toEqual({ sidebarWidth: 15.4, sidebarCollapsed: false, treeWidth: 16, railWidth: null });
  });
});

describe("the rail until it is set", () => {
  it("is 24 vw held between 15 and 25 rem, as the CSS clamp says", () => {
    const at = (px: number) => { Object.defineProperty(window, "innerWidth", { value: px, configurable: true }); return autoRailWidth(); };
    expect(at(1440)).toBeCloseTo(21.6, 5); // 345.6 px of 16 px
    expect(at(800)).toBe(15);
    expect(at(3000)).toBe(25);
  });
});

describe("full screen", () => {
  it("turns it on when the window is not in it, and off when it is", async () => {
    win.isFullscreen.mockResolvedValueOnce(false);
    await toggleFullscreen();
    expect(win.setFullscreen).toHaveBeenLastCalledWith(true);
    win.isFullscreen.mockResolvedValueOnce(true);
    await toggleFullscreen();
    expect(win.setFullscreen).toHaveBeenLastCalledWith(false);
  });

  it("says so when the window cannot change", async () => {
    win.isFullscreen.mockRejectedValueOnce(new Error("not allowed"));
    await expect(toggleFullscreen()).resolves.toBeUndefined();
    expect(win.setFullscreen).not.toHaveBeenCalled();
  });
});
