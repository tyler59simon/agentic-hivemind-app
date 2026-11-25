// @vitest-environment jsdom
// Forced colours (DESK-A11Y A4): the system colours that sigma and Mermaid are given, and the hook that follows a contrast theme.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { forcedColorsActive, systemColor, systemPalette, useForcedColors } from "./forcedColors";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function mockForced(initial: boolean) {
  let forced = initial;
  const listeners = new Set<() => void>();
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches() { return query === "(forced-colors: active)" && forced; },
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  }));
  return { set(next: boolean) { forced = next; listeners.forEach((fn) => fn()); }, listeners };
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("forcedColorsActive", () => {
  it("follows the media query, and is off where matchMedia does not exist", () => {
    const m = mockForced(false);
    expect(forcedColorsActive()).toBe(false);
    m.set(true);
    expect(forcedColorsActive()).toBe(true);
    vi.stubGlobal("matchMedia", undefined);
    expect(forcedColorsActive()).toBe(false);
  });
});

describe("systemColor", () => {
  it("reads the keyword from a probe the contrast theme does not adjust, and removes the probe", () => {
    const seen: string[] = [];
    vi.spyOn(window, "getComputedStyle").mockImplementation((el: Element) => {
      seen.push((el as HTMLElement).style.cssText);
      return { color: "rgb(0, 120, 215)" } as CSSStyleDeclaration;
    });
    expect(systemColor("Highlight")).toBe("rgb(0, 120, 215)");
    expect(seen[0]).toContain("forced-color-adjust");
    expect(seen[0].toLowerCase()).toContain("highlight");
    expect(document.body.children).toHaveLength(0);
  });
});

describe("systemPalette", () => {
  it("asks for the five colours the graph and the diagrams use", () => {
    const asked: string[] = [];
    const palette = systemPalette((k) => { asked.push(k); return `rgb(${k})`; });
    expect(palette).toEqual({ canvas: "rgb(Canvas)", text: "rgb(CanvasText)", highlight: "rgb(Highlight)", highlightText: "rgb(HighlightText)", gray: "rgb(GrayText)" });
    expect(asked).toEqual(["Canvas", "CanvasText", "Highlight", "HighlightText", "GrayText"]);
  });
});

describe("useForcedColors", () => {
  it("re-renders when a contrast theme is turned on, and lets go of the listener on unmount", async () => {
    const m = mockForced(false);
    const seen: boolean[] = [];
    function Probe() { seen.push(useForcedColors()); return null; }
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(<Probe />));
    expect(seen[seen.length - 1]).toBe(false);
    await act(async () => m.set(true));
    expect(seen[seen.length - 1]).toBe(true);
    await act(async () => root.unmount());
    expect(m.listeners.size).toBe(0);
  });
});
