// @vitest-environment jsdom
// The Help items of the account menu (DESK-HELP): what they are, how the keyboard moves through them, and what each one does.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const diagnostics = vi.hoisted(() => ({ copyDiagnostics: vi.fn(), openLogsFolder: vi.fn(), reportProblem: vi.fn(), appInfo: vi.fn(async () => ({})) }));
vi.mock("../lib/diagnostics", () => diagnostics);
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("../features/projects/ProjectSwitcher", () => ({ ProjectSwitcher: () => null }));
vi.mock("../features/review/useInboxItems", () => ({ useInboxItems: () => ({ total: 0 }) }));
vi.mock("../lib/connection", () => ({ useSystemsEnabled: () => false }));

const { Sidebar } = await import("./Sidebar");
const { useAboutDialog } = await import("../features/help/AboutDialog");
const { useShortcutsDialog } = await import("../features/shortcuts/ShortcutsDialog");
const info = { user: "Ada", root: "/lm", script: "lm" } as never;

let root: Root | null = null;
const trigger = () => document.querySelector<HTMLButtonElement>(".user-menu .menu-button")!;
const items = () => [...document.querySelectorAll<HTMLButtonElement>('[role="menu"] [role="menuitem"]')];
const names = () => items().map((b) => b.querySelector(".grow")!.textContent);
const item = (name: string) => items().find((b) => b.querySelector(".grow")!.textContent === name)!;
const key = async (k: string) => { await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })); }); };
const openMenu = async () => { trigger().focus(); await act(async () => trigger().click()); };

beforeEach(async () => {
  Object.values(diagnostics).forEach((f) => f.mockClear());
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<QueryClientProvider client={new QueryClient()}><Sidebar info={info} onSettings={() => {}} onReconnect={() => {}} /></QueryClientProvider>));
});
afterEach(async () => {
  useAboutDialog.getState().hide();
  useShortcutsDialog.getState().hide();
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

describe("the Help items in the account menu", () => {
  it("follow the existing items, in order, with the shortcut keys on the shortcuts item", async () => {
    await openMenu();
    expect(names()).toEqual(["Settings", "Command palette", "Refresh", "Reconnect to Living Memory", "About Hivemind", "Keyboard shortcuts", "Open logs folder", "Copy diagnostics", "Report a problem"]);
    expect(item("Keyboard shortcuts").querySelector("kbd")!.textContent).toBe("Ctrl+/");
  });

  it("move with the arrow keys, Home, End and letters, and Escape gives the focus back to the account button", async () => {
    await openMenu();
    expect(document.activeElement).toBe(item("Settings"));
    await key("End");
    expect(document.activeElement).toBe(item("Report a problem"));
    await key("ArrowDown");
    expect(document.activeElement).toBe(item("Settings"));
    await key("ArrowUp");
    expect(document.activeElement).toBe(item("Report a problem"));
    await key("o");
    expect(document.activeElement).toBe(item("Open logs folder"));
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("About opens the About dialog with the account button as the place to return to", async () => {
    await openMenu();
    await act(async () => item("About Hivemind").click());
    expect(useAboutDialog.getState().open).toBe(true);
    expect(useAboutDialog.getState().returnTo).toBe(trigger());
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it("Keyboard shortcuts opens the sheet", async () => {
    await openMenu();
    await act(async () => item("Keyboard shortcuts").click());
    expect(useShortcutsDialog.getState().open).toBe(true);
    expect(useShortcutsDialog.getState().returnTo).toBe(trigger());
  });

  it("Open logs folder, Copy diagnostics and Report a problem run the existing functions, the menu closed first", async () => {
    for (const [name, fn] of [["Open logs folder", diagnostics.openLogsFolder], ["Copy diagnostics", diagnostics.copyDiagnostics], ["Report a problem", diagnostics.reportProblem]] as const) {
      await openMenu();
      await act(async () => item(name).click());
      expect(fn).toHaveBeenCalledTimes(1);
      expect(document.querySelector('[role="menu"]')).toBeNull();
      expect(document.activeElement).toBe(trigger());
    }
  });
});
