// @vitest-environment jsdom
// Settings: the Document background choice next to the theme. It applies at once, is kept on this computer and needs no Save.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("../../shell/Sidebar", () => ({ useAvailableSections: () => [] }));
vi.mock("../../lib/lm", async (original) => ({
  ...(await original<object>()),
  getSettings: vi.fn(async () => ({ python: null, script: null, root: null })),
  captureStatus: vi.fn(async () => ({})),
  saveSettings: vi.fn(async () => ({})),
}));

const { SettingsForm } = await import("./SettingsForm");
const { applyPaperDefault, paperDefault } = await import("../../lib/paper");
const { prefs } = await import("../../lib/prefs");

let root: ReturnType<typeof createRoot> | null = null;
let el: HTMLElement;
beforeEach(async () => {
  localStorage.clear();
  applyPaperDefault("theme", false);
  el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<QueryClientProvider client={new QueryClient()}><SettingsForm onSaved={() => {}} /></QueryClientProvider>));
  await act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); });
});
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.innerHTML = ""; });

const select = () => [...el.querySelectorAll<HTMLLabelElement>("label.field")].find((l) => l.textContent?.startsWith("Document background"))!.querySelector("select")!;

describe("the Document background setting", () => {
  it("sits after the theme choice, with Theme and White, starting on Theme", () => {
    const labels = [...el.querySelectorAll("label.field > span")].map((s) => s.textContent);
    expect(labels.indexOf("Document background")).toBe(labels.indexOf("Theme") + 1);
    expect([...select().options].map((o) => [o.value, o.textContent])).toEqual([["theme", "Theme"], ["white", "White"]]);
    expect(select().value).toBe("theme");
  });

  it("applies at once and is kept without pressing Save", async () => {
    await act(async () => {
      select().value = "white";
      select().dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(paperDefault()).toBe("white");
    expect(prefs.paper()).toBe("white");
    expect(select().value).toBe("white");
  });

  it("shows a change that came from the other window", async () => {
    localStorage.setItem(prefs.paperKey, "white");
    await act(async () => applyPaperDefault(prefs.paper(), false));
    expect(select().value).toBe("white");
  });
});
