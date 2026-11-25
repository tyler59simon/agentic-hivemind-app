// @vitest-environment jsdom
// DESK-HELP: when Living Memory cannot be reached the app shows the Settings card instead of the shell, and Help is still
// there: About (which says Not connected), Copy diagnostics, Open logs folder and Report a problem.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const diagnostics = vi.hoisted(() => ({ copyDiagnostics: vi.fn(), openLogsFolder: vi.fn(), reportProblem: vi.fn(), appInfo: vi.fn(async () => ({
  version: "0.1.0", tauri: "2.12.5", webviewEngine: "WebView2", webview: "140", os: "windows", arch: "x86_64", osVersion: null, dataDir: "D", configDir: "C", logDir: "L",
})) }));
vi.mock("./lib/diagnostics", () => diagnostics);
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ onCloseRequested: async () => () => {}, destroy: async () => {} }) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("./features/graph/GraphCanvas", () => ({ GraphCanvas: () => null }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
    if (cmd === "connect") throw "Could not start Living Memory";
    if (cmd === "open_pending") return [];
    if (cmd === "get_settings") return { python: null, script: null, root: null };
    if (cmd === "capture_status") return { shortcut: null, error: null, close_to_tray: true };
    return null;
  }),
}));

const { default: App } = await import("./App");
const { useAboutDialog } = await import("./features/help/AboutDialog");

let root: Root | null = null;
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === text)!;
const settle = async () => { for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 20)); }); };

beforeEach(async () => {
  Object.values(diagnostics).forEach((f) => f.mockClear());
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<QueryClientProvider client={new QueryClient()}><App /></QueryClientProvider>));
  await settle();
});
afterEach(async () => {
  useAboutDialog.getState().hide();
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

describe("Help on the connection error screen", () => {
  it("shows the error and the four Help buttons, and no shell", () => {
    expect(document.querySelector(".card .error")!.textContent).toContain("Could not start Living Memory");
    expect(document.querySelector(".shell")).toBeNull();
    const help = document.querySelector('section[aria-label="Help"]')!;
    expect([...help.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["About Hivemind", "Copy diagnostics", "Open logs folder", "Report a problem"]);
  });

  it("run the same functions", async () => {
    await act(async () => button("Copy diagnostics").click());
    await act(async () => button("Open logs folder").click());
    await act(async () => button("Report a problem").click());
    expect(diagnostics.copyDiagnostics).toHaveBeenCalledTimes(1);
    expect(diagnostics.openLogsFolder).toHaveBeenCalledTimes(1);
    expect(diagnostics.reportProblem).toHaveBeenCalledTimes(1);
  });

  it("About opens the dialog, which says Living Memory is not connected, and Escape returns the focus to the button", async () => {
    const about = button("About Hivemind");
    about.focus();
    await act(async () => about.click());
    await settle();
    const dialog = document.querySelector('[role="dialog"][aria-label="About Hivemind"]')!;
    expect(dialog.textContent).toContain("Not connected");
    expect(dialog.textContent).toContain("0.1.0");
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
    await settle();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(about);
  });
});
