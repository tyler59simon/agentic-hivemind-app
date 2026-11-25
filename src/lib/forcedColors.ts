// Forced colours (DESK-OS, DESK-A11Y A4): a Windows contrast theme sets `forced-colors: active`, and the browser replaces the colours
// of text, backgrounds and borders. It does not touch what a canvas draws (the graph) or what a drawing library writes into an SVG
// (Mermaid), so those read the system colours here and paint with them.
import { useSyncExternalStore } from "react";

const QUERY = "(forced-colors: active)";

/** Whether a contrast theme is on. */
export const forcedColorsActive = (): boolean => typeof matchMedia === "function" && matchMedia(QUERY).matches;

/** Re-renders a component when the contrast theme is turned on or off, or the system changes it. */
export function useForcedColors(): boolean {
  return useSyncExternalStore(
    (notify) => {
      if (typeof matchMedia !== "function") return () => {};
      const query = matchMedia(QUERY);
      query.addEventListener("change", notify);
      return () => query.removeEventListener("change", notify);
    },
    forcedColorsActive,
    () => false,
  );
}

/** A system colour keyword (Canvas, CanvasText, Highlight, ...) as the rgb() string the browser resolves it to. WebGL and Mermaid's
 *  colour parser take no keywords, so the colour is read from an element that is not adjusted by forced colours. */
export function systemColor(keyword: string): string {
  const probe = document.createElement("span");
  probe.style.cssText = `position:absolute;visibility:hidden;forced-color-adjust:none;color:${keyword}`;
  document.body.appendChild(probe);
  try { return getComputedStyle(probe).color; } finally { probe.remove(); }
}

export type SystemPalette = { canvas: string; text: string; highlight: string; highlightText: string; gray: string };

/** The colours of the contrast theme in use. `resolve` is `systemColor`, replaceable in a test. */
export const systemPalette = (resolve: (keyword: string) => string = systemColor): SystemPalette => ({
  canvas: resolve("Canvas"), text: resolve("CanvasText"), highlight: resolve("Highlight"), highlightText: resolve("HighlightText"), gray: resolve("GrayText"),
});
