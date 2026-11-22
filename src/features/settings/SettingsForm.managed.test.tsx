// @vitest-environment jsdom
// Settings: "Allow Claude under managed policy" (REG-16). Off by default, explains what it lets through, and is saved with Save.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("../../shell/Sidebar", () => ({ useAvailableSections: () => [] }));
const lm = vi.hoisted(() => ({
  settings: { python: null, script: null, root: null } as Record<string, unknown>,
  save: vi.fn(async (_value: unknown) => undefined),
}));
vi.mock("../../lib/lm", async (original) => ({
  ...(await original<object>()),
  getSettings: vi.fn(async () => lm.settings),
  captureStatus: vi.fn(async () => ({})),
  saveSettings: lm.save,
}));

const { SettingsForm } = await import("./SettingsForm");

let root: ReturnType<typeof createRoot> | null = null;
let el: HTMLElement;
async function render() {
  el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<QueryClientProvider client={new QueryClient()}><SettingsForm onSaved={() => {}} /></QueryClientProvider>));
  await act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); });
}
beforeEach(() => { localStorage.clear(); lm.settings = { python: null, script: null, root: null }; lm.save.mockClear(); });
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.innerHTML = ""; });

const box = () => [...el.querySelectorAll<HTMLLabelElement>("label.check")].find((l) => l.textContent?.includes("Allow Claude under managed policy"))?.querySelector("input");

describe("the Allow Claude under managed policy setting", () => {
  it("is off by default and its help says managed hooks run", async () => {
    await render();
    expect(box()?.checked).toBe(false);
    const help = el.textContent ?? "";
    expect(help).toContain("Managed hooks then run");
    expect(help).toContain("--strict-mcp-config");
  });

  it("shows a saved choice", async () => {
    lm.settings = { ...lm.settings, claude_under_managed_policy: true };
    await render();
    expect(box()?.checked).toBe(true);
  });

  it("is saved with Save", async () => {
    await render();
    await act(async () => box()!.click());
    expect(box()?.checked).toBe(true);
    await act(async () => { el.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    expect(lm.save).toHaveBeenCalledTimes(1);
    expect(lm.save.mock.calls[0][0]).toMatchObject({ claude_under_managed_policy: true });
  });

  it("is not offered while Claude Code is hidden", async () => {
    lm.settings = { ...lm.settings, hidden_engines: ["claude"] };
    await render();
    expect(box()).toBeUndefined();
  });
});
