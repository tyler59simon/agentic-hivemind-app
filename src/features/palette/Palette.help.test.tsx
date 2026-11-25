// @vitest-environment jsdom
// DESK-HELP: the palette's "About Hivemind" and "Report a problem" entries, beside the existing "Copy diagnostics",
// "Open logs folder" and "Keyboard shortcuts".
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const diagnostics = vi.hoisted(() => ({ copyDiagnostics: vi.fn(), openLogsFolder: vi.fn(), reportProblem: vi.fn(), appInfo: vi.fn(async () => ({})) }));
vi.mock("../../lib/diagnostics", () => diagnostics);
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

const { Palette } = await import("./Palette");
const { useApp } = await import("../../store");
const { useAboutDialog } = await import("../help/AboutDialog");

let root: Root | null = null;
const row = (label: string) => [...document.querySelectorAll<HTMLButtonElement>(".palette li button")].find((b) => b.querySelector("span")!.textContent === label);
const settle = async () => { for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 20)); }); };

beforeEach(async () => {
  Object.values(diagnostics).forEach((f) => f.mockClear());
  document.body.innerHTML = '<main id="page"><button id="before">Before</button></main>';
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><Palette onSettings={() => {}} onReconnect={() => {}} /></QueryClientProvider>));
  document.getElementById("before")!.focus();
  await act(async () => useApp.getState().setPalette("commands"));
  await settle();
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  useAboutDialog.getState().hide();
  useApp.getState().setPalette(null);
  document.body.innerHTML = "";
});

describe("the palette's Help entries", () => {
  it("lists them all", () => {
    for (const label of ["About Hivemind", "Keyboard shortcuts", "Open logs folder", "Copy diagnostics", "Report a problem"]) expect(row(label), label).toBeDefined();
  });

  it("About opens the dialog and returns to what had the focus before the palette", async () => {
    await act(async () => row("About Hivemind")!.click());
    expect(useAboutDialog.getState().open).toBe(true);
    expect(useAboutDialog.getState().returnTo).toBe(document.getElementById("before"));
    expect(useApp.getState().palette).toBeNull();
  });

  it("Report a problem closes the palette and runs the report", async () => {
    await act(async () => row("Report a problem")!.click());
    expect(diagnostics.reportProblem).toHaveBeenCalledTimes(1);
    expect(useApp.getState().palette).toBeNull();
  });
});
