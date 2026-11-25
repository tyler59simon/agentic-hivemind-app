// @vitest-environment jsdom
// Mermaid under a Windows contrast theme (DESK-A11Y A4): the base theme with the system colours, drawn again when the theme changes.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const initialize = vi.fn();
vi.mock("mermaid", () => ({ default: { initialize: (o: unknown) => initialize(o), render: async (id: string) => ({ svg: `<svg id="${id}"></svg>` }) } }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("../lib/forcedColors", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/forcedColors")>();
  const rgb: Record<string, string> = { Canvas: "rgb(0, 0, 0)", CanvasText: "rgb(255, 255, 255)", Highlight: "rgb(26, 235, 255)", HighlightText: "rgb(0, 0, 0)", GrayText: "rgb(63, 242, 63)" };
  return { ...real, systemPalette: () => real.systemPalette((k) => rgb[k]) };
});

const { Mermaid, mermaidTheme } = await import("./Mermaid");

describe("mermaidTheme", () => {
  it("is Mermaid's dark or default theme without a contrast theme", () => {
    expect(mermaidTheme(true, null)).toEqual({ theme: "dark" });
    expect(mermaidTheme(false, null)).toEqual({ theme: "default" });
  });

  it("is the base theme in the system colours under one: surfaces Canvas, lines and text CanvasText, whatever dark says", () => {
    const palette = { canvas: "rgb(0, 0, 0)", text: "rgb(255, 255, 255)", highlight: "rgb(26, 235, 255)", highlightText: "rgb(0, 0, 0)", gray: "rgb(63, 242, 63)" };
    const { theme, themeVariables: v } = mermaidTheme(false, palette);
    expect(theme).toBe("base");
    expect(v).toMatchObject({
      darkMode: true, background: palette.canvas, mainBkg: palette.canvas, primaryColor: palette.canvas, clusterBkg: palette.canvas,
      primaryTextColor: palette.text, textColor: palette.text, lineColor: palette.text, nodeBorder: palette.text, actorLineColor: palette.text,
      activationBkgColor: palette.highlight,
    });
    expect(mermaidTheme(true, { ...palette, canvas: "rgb(255, 255, 255)" }).themeVariables).toMatchObject({ darkMode: false });
  });
});

describe("Mermaid in a contrast theme", () => {
  let forced = false;
  const listeners = new Set<() => void>();
  let root: ReturnType<typeof createRoot>;
  beforeEach(() => {
    initialize.mockClear(); forced = false; listeners.clear();
    vi.stubGlobal("matchMedia", (q: string) => ({
      get matches() { return q.includes("forced-colors") && forced; },
      addEventListener: (_: string, fn: () => void) => listeners.add(fn),
      removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
    }));
    const pane = document.createElement("div");
    document.body.append(pane);
    root = createRoot(pane);
  });
  afterEach(async () => { await act(async () => root.unmount()); document.body.innerHTML = ""; vi.unstubAllGlobals(); });
  const settle = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); });
  const configs = () => initialize.mock.calls.map((c) => c[0] as { theme: string; themeVariables?: Record<string, unknown> });

  it("draws with the system colours when the theme is on, and again with Mermaid's own when it goes off", async () => {
    forced = true;
    await act(async () => root.render(<Mermaid source={"flowchart LR\n  a --> b"} />));
    await settle();
    expect(configs().map((c) => c.theme)).toEqual(["base"]);
    expect(configs()[0].themeVariables).toMatchObject({ primaryColor: "rgb(0, 0, 0)", lineColor: "rgb(255, 255, 255)" });
    forced = false;
    await act(async () => listeners.forEach((fn) => fn()));
    await settle();
    expect(configs().map((c) => c.theme)).toEqual(["base", "dark"]);
    expect(configs()[1]).not.toHaveProperty("themeVariables");
  });
});
