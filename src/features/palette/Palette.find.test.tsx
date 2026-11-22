// @vitest-environment jsdom
// NS-6B: the command palette starts Find in files.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("sigma", () => ({ default: class {} }));
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
const { useWorkspace } = await import("../../workspace/store");

let root: Root | null = null;
const settle = async () => { for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 30)); }); };

beforeEach(() => { useWorkspace.setState({ panes: [{ id: "p0", tabs: [], active: null }], focused: "p0", dirty: {} }); });
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  useApp.getState().setPalette(null);
});

describe("the command palette", () => {
  it("has Find in files, which opens its tab", async () => {
    const el = document.createElement("div");
    document.body.append(el);
    root = createRoot(el);
    await act(async () => root!.render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><Palette onSettings={() => {}} onReconnect={() => {}} /></QueryClientProvider>));
    await act(async () => useApp.getState().setPalette("commands"));
    const input = document.querySelector<HTMLInputElement>(".palette input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "find in");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await settle();
    const row = [...document.querySelectorAll<HTMLElement>(".palette li button")].find((b) => b.querySelector("span")!.textContent === "Find in files…");
    expect(row).toBeDefined();
    await act(async () => { row!.click(); });
    expect(useWorkspace.getState().panes[0].tabs.map((t) => t.kind)).toEqual(["find"]);
    expect(useApp.getState().palette).toBeNull();
  });
});
