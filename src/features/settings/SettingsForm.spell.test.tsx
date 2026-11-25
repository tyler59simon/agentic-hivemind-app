// @vitest-environment jsdom
// Settings: "Check spelling in notes" (DESK-8) applies at once, with no Save, and shows the setting in effect.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("../../shell/Sidebar", () => ({ useAvailableSections: () => [] }));
const save = vi.hoisted(() => vi.fn(async (_value: unknown) => undefined));
vi.mock("../../lib/lm", async (original) => ({
  ...(await original<object>()),
  getSettings: vi.fn(async () => ({ python: null, script: null, root: null })),
  captureStatus: vi.fn(async () => ({})),
  saveSettings: save,
}));

const { SettingsForm } = await import("./SettingsForm");
const { setSpellcheck, spellcheck } = await import("../../lib/spellcheck");

let root: ReturnType<typeof createRoot> | null = null;
let el: HTMLElement;
beforeEach(async () => {
  localStorage.clear();
  setSpellcheck(true);
  save.mockClear();
  el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<QueryClientProvider client={new QueryClient()}><SettingsForm onSaved={() => {}} /></QueryClientProvider>));
  await act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); });
});
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.innerHTML = ""; });

const box = () => [...el.querySelectorAll<HTMLLabelElement>("label.check")].find((l) => l.textContent?.includes("Check spelling in notes"))!.querySelector("input")!;

it("shows the setting and changes it at once, without Save", async () => {
  expect(box().checked).toBe(true);
  await act(async () => box().click());
  expect(spellcheck()).toBe(false);
  expect(box().checked).toBe(false);
  expect(save).not.toHaveBeenCalled();
  await act(async () => box().click());
  expect(spellcheck()).toBe(true);
});
