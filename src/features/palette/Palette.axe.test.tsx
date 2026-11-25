// @vitest-environment jsdom
// Accessibility of the command palette and the notes finder (DESK-A11Y A1), open over a bare page and checked with axe. The
// baseline lists what axe reports today; a later stage removes an entry when it fixes the cause.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectNoNewAxeViolations } from "../../test/axe";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("sigma", () => ({ default: class {} }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ isFullscreen: async () => false, setFullscreen: async () => {} }) }));
vi.mock("../../lib/native", () => ({ inTauri: () => true }));
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
const { useWorkspace } = await import("../../workspace/store");

let root: Root | null = null;
const settle = async () => { for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 20)); }); };

beforeEach(async () => {
  localStorage.clear();
  useApp.setState({ route: { page: "home" } });
  useWorkspace.setState({ panes: [{ id: "p0", tabs: [], active: null }], focused: "p0", dirty: {} });
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><Palette onSettings={() => {}} onReconnect={() => {}} /></QueryClientProvider>));
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  useApp.getState().setPalette(null);
  document.body.innerHTML = "";
});

/** What axe reports on the open palette today. Each entry names its cause; remove the entry in the commit that fixes it. */
const BASELINE: string[] = [];

describe("the palette", () => {
  for (const mode of ["commands", "notes"] as const) {
    it(`has only the violations recorded in the baseline in ${mode} mode`, async () => {
      await act(async () => useApp.getState().setPalette(mode));
      await settle();
      expect(document.querySelector('[role="dialog"][aria-label="Palette"]')).not.toBeNull();
      expect(document.querySelectorAll(".palette li").length).toBeGreaterThan(0);
      await expectNoNewAxeViolations(document.body, BASELINE);
    });
  }
});
