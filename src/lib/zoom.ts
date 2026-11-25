// Window zoom (DESK-ZOOM): Ctrl+= / Ctrl+- / Ctrl+0 (as remapped in Settings, DESK-KEYS) and Ctrl+wheel zoom every window through WebView2's own zoom, so
// media queries, window-width checks and px sizes all follow. Rust keeps the zoom in the settings file and applies it
// when a window is made; `ui-zoom` tells every window when it changes.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useSyncExternalStore } from "react";
import { inTauri } from "./native";
import { matches, type ComboEvent } from "./shortcuts";

/** The zoom levels Ctrl+= and Ctrl+- step through, as in a browser. */
export const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2] as const;

export type ZoomAction = "in" | "out" | "reset";

/** The zoom action a key is: by default Ctrl (or Cmd) with = or +, - or _, or 0, and no Alt (AltGr). Shift is allowed on
 *  = and -: + is Shift+= on most layouts. */
export function zoomKey(e: ComboEvent): ZoomAction | null {
  if (matches(e, "zoom.in")) return "in";
  if (matches(e, "zoom.out")) return "out";
  if (matches(e, "zoom.reset")) return "reset";
  return null;
}

/** The next level from `zoom`: one step up or down from wherever it is, or 100%. */
export function stepZoom(zoom: number, action: ZoomAction): number {
  if (action === "reset") return 1;
  if (action === "in") return ZOOM_STEPS.find((s) => s > zoom + 0.001) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1];
  return [...ZOOM_STEPS].reverse().find((s) => s < zoom - 0.001) ?? ZOOM_STEPS[0];
}

export const zoomPercent = (zoom: number): string => `${Math.round(zoom * 100)}%`;

let current = 1;
// The level the latest request asked for, until that request is answered: quick steps build on it, not on `current`.
let wanted: { n: number; zoom: number } | null = null;
let asked = 0;
const listeners = new Set<(zoom: number) => void>();
const changed = (zoom: number) => { current = zoom; listeners.forEach((l) => l(zoom)); };

export const currentZoom = (): number => current;
const subscribe = (l: () => void) => onZoomChange(l);
export const useZoom = (): number => useSyncExternalStore(subscribe, currentZoom);

/** Called with the new zoom after every change, in this window or the other. */
export function onZoomChange(listener: (zoom: number) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Zoom every window to `zoom` and keep it. Resolves to the zoom kept. */
export async function setZoom(zoom: number): Promise<number> {
  if (!inTauri()) { changed(zoom); return zoom; }
  const n = ++asked;
  wanted = { n, zoom };
  try {
    const kept = await invoke<number>("ui_zoom_set", { zoom });
    changed(kept);
    return kept;
  } finally {
    if (wanted?.n === n) wanted = null;
  }
}

/** One step in or out, or back to 100 percent, from the level last asked for (two quick presses go two steps). */
export const zoomBy = (action: ZoomAction): Promise<number> => setZoom(stepZoom(wanted?.zoom ?? current, action));

/** Views that zoom themselves (boards, the architecture canvas, drawings) keep Ctrl+wheel. Only a view with its own zoom
 *  keys (the drawing editor, marked data-own-zoom-keys) keeps Ctrl+=, Ctrl+- and Ctrl+0 as well. */
const owns = (target: EventTarget | null, marker: string) => target instanceof Element && target.closest(marker) !== null;

/** Wheel notches add up before a step, so a touchpad pinch moves one level at a time, not one per event. */
export function wheelSteps(): (deltaY: number) => ZoomAction | null {
  let total = 0;
  return (deltaY) => {
    total += deltaY;
    if (Math.abs(total) < 100) return null;
    const action = total < 0 ? "in" : "out";
    total = 0;
    return action;
  };
}

/** Read the saved zoom and listen for keys and Ctrl+wheel in this window. Capture phase: a terminal or an editor never
 *  sees the keys, so they never type a character. Returns the undo for tests. */
export function initZoom(target: Window = window): () => void {
  const onKey = (e: KeyboardEvent) => {
    const action = zoomKey(e);
    if (!action || owns(e.target, "[data-own-zoom-keys]")) return;
    e.preventDefault();
    e.stopPropagation();
    void zoomBy(action);
  };
  const step = wheelSteps();
  const onWheel = (e: WheelEvent) => {
    if (!(e.ctrlKey || e.metaKey) || owns(e.target, "[data-own-zoom]")) return;
    e.preventDefault();
    const action = step(e.deltaY);
    if (action) void zoomBy(action);
  };
  target.addEventListener("keydown", onKey, true);
  target.addEventListener("wheel", onWheel, { capture: true, passive: false });
  let stop = () => {};
  if (inTauri()) {
    invoke<number>("ui_zoom").then(changed, () => undefined);
    const unlisten = listen<number>("ui-zoom", (e) => changed(e.payload));
    stop = () => { void unlisten.then((u) => u()); };
  }
  return () => {
    target.removeEventListener("keydown", onKey, true);
    target.removeEventListener("wheel", onWheel, true);
    stop();
  };
}
