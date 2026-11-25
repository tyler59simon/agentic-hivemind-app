// @vitest-environment jsdom
// The top bar's search keys (DESK-KEYS): Ctrl+K and Ctrl+Shift+F focus the search box by default, a dialog in front stops them,
// and a remap in Settings moves them.
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
const { setOverrides } = await import("../lib/shortcuts");
const { pushLayer } = await import("../ui/layers");
const { setMacForTests } = await import("../lib/platform");

let root: Root | null = null;
const input = () => document.querySelector<HTMLInputElement>("input[role='combobox']")!;
const press = async (key: string, mods: Partial<KeyboardEventInit> = {}) => {
  const e = new KeyboardEvent("keydown", { key, cancelable: true, bubbles: true, ...mods });
  await act(async () => { window.dispatchEvent(e); });
  return e;
};

beforeEach(async () => {
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><Topbar /></QueryClientProvider>));
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  setOverrides({});
  setMacForTests(false);
  document.body.innerHTML = "";
});

describe("the search keys", () => {
  it("Ctrl+K and Ctrl+Shift+F focus the search box", async () => {
    expect(document.activeElement).not.toBe(input());
    expect((await press("k", { ctrlKey: true })).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(input());
    input().blur();
    await press("F", { ctrlKey: true, shiftKey: true });
    expect(document.activeElement).toBe(input());
  });

  it("ignores Ctrl+Shift+K, Ctrl+F, Alt and a bare k", async () => {
    await press("k", { ctrlKey: true, shiftKey: true });
    await press("f", { ctrlKey: true });
    await press("k", { ctrlKey: true, altKey: true });
    await press("k");
    expect(document.activeElement).not.toBe(input());
  });

  it("does nothing while a dialog is open", async () => {
    const layer = pushLayer(() => {}, undefined, true);
    await press("k", { ctrlKey: true });
    expect(document.activeElement).not.toBe(input());
    layer.pop();
  });

  it("wants Cmd on macOS", async () => {
    setMacForTests(true);
    await press("k", { ctrlKey: true });
    expect(document.activeElement).not.toBe(input());
    await press("k", { metaKey: true });
    expect(document.activeElement).toBe(input());
  });

  it("follows a remap: the new combo works and the old one does not", async () => {
    setOverrides({ "search.focus": "Mod+J", "search.alt": "Alt+J" });
    await press("k", { ctrlKey: true });
    await press("F", { ctrlKey: true, shiftKey: true });
    expect(document.activeElement).not.toBe(input());
    await press("j", { ctrlKey: true });
    expect(document.activeElement).toBe(input());
    input().blur();
    await press("j", { altKey: true });
    expect(document.activeElement).toBe(input());
  });
});
