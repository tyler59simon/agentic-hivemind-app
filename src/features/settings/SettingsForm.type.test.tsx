// @vitest-environment jsdom
// Settings: the font, line height and width choices (DESK-TYPE) apply at once, with no Save, and show the setting in effect.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
const { applyType } = await import("../../lib/typography");
const { prefs } = await import("../../lib/prefs");

let root: ReturnType<typeof createRoot> | null = null;
let el: HTMLElement;
beforeEach(async () => {
  localStorage.clear();
  save.mockClear();
  for (const [key, value] of [["ui_font", "jakarta"], ["doc_font", "jakarta"], ["mono_font", "jetbrains"], ["doc_line_height", 1.6], ["doc_width", "normal"], ["density", "comfortable"]] as const) {
    applyType(key, value as never, false);
  }
  el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<QueryClientProvider client={new QueryClient()}><SettingsForm onSaved={() => {}} /></QueryClientProvider>));
  await act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); });
});
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.innerHTML = ""; });

const select = (label: string) => [...el.querySelectorAll<HTMLLabelElement>("label.field")].find((l) => l.querySelector("span")?.textContent === label)!.querySelector("select")!;
const pick = async (label: string, value: string) => act(async () => {
  select(label).value = value;
  select(label).dispatchEvent(new Event("change", { bubbles: true }));
});
const css = (name: string) => document.documentElement.style.getPropertyValue(name);

describe("the typography settings", () => {
  it("list the presets and start on the defaults", () => {
    expect([...select("Interface font").options].map((o) => o.value)).toEqual(["jakarta", "segoe", "system"]);
    expect([...select("Document font").options].map((o) => o.value)).toEqual(["jakarta", "segoe", "system", "georgia", "cambria"]);
    expect([...select("Code font").options].map((o) => o.value)).toEqual(["jetbrains", "cascadia", "consolas"]);
    expect([...select("Document line height").options].map((o) => o.value)).toEqual(["1.4", "1.6", "1.8"]);
    expect([...select("Document width").options].map((o) => o.value)).toEqual(["narrow", "normal", "wide", "full"]);
    expect([...select("Density").options].map((o) => o.value)).toEqual(["comfortable", "compact"]);
    expect(["Interface font", "Document font", "Code font", "Document line height", "Document width", "Density"].map((l) => select(l).value))
      .toEqual(["jakarta", "jakarta", "jetbrains", "1.6", "normal", "comfortable"]);
  });

  it("apply at once and are kept without pressing Save", async () => {
    await pick("Interface font", "segoe");
    await pick("Document font", "georgia");
    await pick("Code font", "consolas");
    await pick("Document line height", "1.8");
    await pick("Document width", "full");
    await pick("Density", "compact");
    expect(css("--font-ui")).toMatch(/^"Segoe UI"/);
    expect(css("--font-doc")).toMatch(/^Georgia/);
    expect(css("--font-mono")).toMatch(/^Consolas/);
    expect(css("--doc-line-height")).toBe("1.8");
    expect(css("--doc-width")).toBe("none");
    expect(document.documentElement.dataset.density).toBe("compact");
    expect(["ui_font", "doc_font", "mono_font", "doc_line_height", "doc_width", "density"].map((k) => prefs.typeValue(k as "ui_font")))
      .toEqual(["segoe", "georgia", "consolas", 1.8, "full", "compact"]);
    expect(select("Document line height").value).toBe("1.8");
    expect(save).not.toHaveBeenCalled();
  });

  it("show a value applied from outside the form", async () => {
    await act(async () => applyType("doc_width", "wide", false));
    expect(select("Document width").value).toBe("wide");
  });
});
