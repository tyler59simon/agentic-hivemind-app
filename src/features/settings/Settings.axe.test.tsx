// @vitest-environment jsdom
// Accessibility of the Settings card (DESK-A11Y A1): the card App shows when Living Memory cannot be reached, with the real
// SettingsForm, ShortcutsSection, HelpRow and BeforeUninstall, checked with axe. The baseline lists what axe reports today; a
// later stage removes an entry when it fixes the cause. The Schedules and Maintenance sections need a connection and are not drawn.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectNoNewAxeViolations } from "../../test/axe";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ onCloseRequested: async () => () => {}, destroy: async () => {} }) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("../graph/GraphCanvas", () => ({ GraphCanvas: () => null }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
    if (cmd === "connect") throw "Could not start Living Memory";
    if (cmd === "open_pending") return [];
    if (cmd === "get_settings") return { python: null, script: null, root: null };
    if (cmd === "capture_status") return { shortcut: null, error: null, close_to_tray: true };
    return null;
  }),
}));

const { default: App } = await import("../../App");

let root: Root | null = null;
const settle = async () => { for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 20)); }); };

beforeEach(async () => {
  localStorage.clear();
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<QueryClientProvider client={new QueryClient()}><App /></QueryClientProvider>));
  await settle();
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

/** What axe reports on this page today: nothing. */
const BASELINE: string[] = [];

describe("the Settings card", () => {
  it("draws the form, the shortcuts and the Help row", () => {
    expect(document.querySelector("main.center .card h1")).not.toBeNull();
    expect(document.querySelector("form.settings")).not.toBeNull();
    expect(document.querySelector('section[aria-label="Help"]')).not.toBeNull();
  });

  it("names the window Settings - Hivemind", () => {
    expect(document.title).toBe("Settings - Hivemind");
  });

  it("has one h1, the sections as h2 and their groups as h3, with no level skipped", () => {
    const levels = [...document.querySelectorAll("h1, h2, h3, h4, h5, h6")].map((h) => Number(h.tagName[1]));
    expect(levels.filter((l) => l === 1).length).toBe(1);
    expect(levels[0]).toBe(1);
    expect(levels.filter((l) => l === 2).length).toBeGreaterThanOrEqual(5); // Living Memory, Quick capture, Agents, Keyboard shortcuts, Help...
    expect(Math.max(...levels)).toBe(3);
    levels.forEach((l, i) => { if (i > 0) expect(l, `heading ${i}`).toBeLessThanOrEqual(levels[i - 1] + 1); });
  });

  it("has only the violations recorded in the baseline", async () => {
    await expectNoNewAxeViolations(document.body, BASELINE);
  });
});
