// @vitest-environment jsdom
// Search in focus mode (DESK-LAYOUT, review R1): the top bar is hidden then, so Ctrl+K and Ctrl+Shift+F leave focus mode first and
// focus the search box only once it is drawn, with the panel open as before.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
    if (cmd === "notebooks_list" || cmd === "index_tags") return [];
    if (cmd === "lm") return { exit_code: 0, error: null, result: { domains: [], aliases: {}, global_domains: [], foreign_domains: [], notes: [] } };
    return null;
  }),
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setTitle: async () => {} }) }));

const { Topbar } = await import("./Topbar");
const { useLayout } = await import("./layout");
const { useNotesSearch } = await import("../features/search/store");

let root: Root | null = null;
const input = () => document.querySelector<HTMLInputElement>("input[role='combobox']")!;
const press = async (key: string, mods: Partial<KeyboardEventInit> = {}) => {
  await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key, cancelable: true, bubbles: true, ...mods })); });
};

beforeEach(async () => {
  useLayout.setState({ focusMode: true });
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><Topbar /></QueryClientProvider>));
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  useLayout.setState({ focusMode: false });
  document.body.innerHTML = "";
});

describe("search from focus mode", () => {
  for (const [name, key, mods] of [["Ctrl+K", "k", { ctrlKey: true }], ["Ctrl+Shift+F", "F", { ctrlKey: true, shiftKey: true }]] as const) {
    it(`${name} leaves focus mode, then focuses the search box`, async () => {
      const seen: boolean[] = [];
      const focus = vi.spyOn(input(), "focus").mockImplementation(() => { seen.push(useLayout.getState().focusMode); });
      await press(key, mods);
      expect(useLayout.getState().focusMode).toBe(false);
      expect(focus).toHaveBeenCalled();
      expect(seen).toEqual([false]); // the mode was already off when the box was asked to focus
    });
  }

  it("opens the search panel as it does outside focus mode", async () => {
    useNotesSearch.getState().close();
    await press("k", { ctrlKey: true });
    expect(useNotesSearch.getState().open).toBe(true);
    expect(document.activeElement).toBe(input());
  });

  it("does nothing to the mode when it is not on", async () => {
    useLayout.setState({ focusMode: false });
    await press("k", { ctrlKey: true });
    expect(useLayout.getState().focusMode).toBe(false);
    expect(document.activeElement).toBe(input());
  });
});
