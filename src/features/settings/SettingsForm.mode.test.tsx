// @vitest-environment jsdom
// Settings: "Open notes in" (DESK-11). The default mode is sent to the settings file only when this form changed it, and
// only after the Settings save went through.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("../../shell/Sidebar", () => ({ useAvailableSections: () => [] }));
const mocks = vi.hoisted(() => ({
  save: vi.fn(async (_value: unknown) => undefined),
  setDefaultMode: vi.fn(),
}));
vi.mock("../../lib/lm", async (original) => ({
  ...(await original<object>()),
  getSettings: vi.fn(async () => ({ python: null, script: null, root: null })),
  captureStatus: vi.fn(async () => ({})),
  saveSettings: mocks.save,
}));
vi.mock("../../lib/appearance", async (original) => ({ ...(await original<object>()), setDefaultMode: mocks.setDefaultMode }));

const { SettingsForm } = await import("./SettingsForm");

let root: ReturnType<typeof createRoot> | null = null;
let el: HTMLElement;
beforeEach(async () => {
  localStorage.clear();
  mocks.save.mockReset().mockResolvedValue(undefined);
  mocks.setDefaultMode.mockReset();
  el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<QueryClientProvider client={new QueryClient()}><SettingsForm onSaved={() => {}} /></QueryClientProvider>));
  await act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); });
});
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.innerHTML = ""; });

const modeSelect = () => [...el.querySelectorAll<HTMLLabelElement>("label.field")].find((l) => l.textContent?.startsWith("Open notes in"))!.querySelector("select")!;
const submit = () => act(async () => {
  el.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
});

describe("the Open notes in setting", () => {
  it("is left alone by a save that did not change it (C4)", async () => {
    await submit();
    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(mocks.setDefaultMode).not.toHaveBeenCalled();
  });

  it("is sent with Save once the picked mode differs, after the settings were saved (C5)", async () => {
    await act(async () => { modeSelect().value = "source"; modeSelect().dispatchEvent(new Event("change", { bubbles: true })); });
    await submit();
    expect(mocks.setDefaultMode).toHaveBeenCalledWith("source");
    expect(mocks.save.mock.invocationCallOrder[0]).toBeLessThan(mocks.setDefaultMode.mock.invocationCallOrder[0]);
  });

  it("is not sent when the settings were refused (C5)", async () => {
    mocks.save.mockRejectedValue("Keep at least one engine shown.");
    await act(async () => { modeSelect().value = "live"; modeSelect().dispatchEvent(new Event("change", { bubbles: true })); });
    await submit();
    expect(mocks.setDefaultMode).not.toHaveBeenCalled();
  });
});
