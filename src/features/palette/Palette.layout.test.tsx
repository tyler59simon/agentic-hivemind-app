// @vitest-environment jsdom
// DESK-LAYOUT: the palette has a command for the sidebar, focus mode and full screen, with their keys.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const win = { isFullscreen: vi.fn(async () => false), setFullscreen: vi.fn(async () => {}) };
vi.mock("sigma", () => ({ default: class {} }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => win }));
vi.mock("../../lib/native", () => ({ inTauri: () => true }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
    switch (cmd) {
      case "notebooks_list": return [];
      case "lm": return { exit_code: 0, error: null, result: { domains: [], notes: [] } };
    }
    return null;
  }),
}));

const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { Palette } = await import("./Palette");
const { useApp } = await import("../../store");
const { useLayout } = await import("../../shell/layout");

let root: Root | null = null;
const row = (label: string) => [...document.querySelectorAll<HTMLButtonElement>(".palette li button")].find((b) => b.querySelector("span")!.textContent === label);
const detail = (label: string) => row(label)?.querySelectorAll("span")[1]?.textContent;
const settle = async () => { for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 20)); }); };
const reset = () => useLayout.setState({ sidebarCollapsed: false, focusMode: false });

beforeEach(async () => {
  reset();
  win.isFullscreen.mockClear(); win.setFullscreen.mockClear();
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><Palette onSettings={() => {}} onReconnect={() => {}} /></QueryClientProvider>));
  await act(async () => useApp.getState().setPalette("commands"));
  await settle();
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  useApp.getState().setPalette(null);
  reset();
  document.body.innerHTML = "";
});

describe("the layout commands", () => {
  it("show their keys", () => {
    expect(detail("Collapse the sidebar")).toBe("Ctrl+Shift+B");
    expect(detail("Focus mode")).toBe("Ctrl+Shift+M");
    expect(detail("Full screen")).toBe("F11");
  });

  it("collapse and expand the sidebar, and say which they will do", async () => {
    await act(async () => row("Collapse the sidebar")!.click());
    expect(useLayout.getState().sidebarCollapsed).toBe(true);
    expect(useApp.getState().palette).toBeNull();
    await act(async () => useApp.getState().setPalette("commands"));
    await settle();
    expect(row("Expand the sidebar")).toBeDefined();
    expect(row("Collapse the sidebar")).toBeUndefined();
  });

  it("enter and leave focus mode", async () => {
    await act(async () => row("Focus mode")!.click());
    expect(useLayout.getState().focusMode).toBe(true);
    await act(async () => useApp.getState().setPalette("commands"));
    await settle();
    await act(async () => row("Exit focus mode")!.click());
    expect(useLayout.getState().focusMode).toBe(false);
  });

  it("turn full screen on", async () => {
    await act(async () => row("Full screen")!.click());
    expect(win.setFullscreen).toHaveBeenCalledWith(true);
  });
});
