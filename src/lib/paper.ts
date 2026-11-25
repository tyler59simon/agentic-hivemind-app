// Documents on white paper: dark text on a white background while the rest of Hivemind keeps its theme. The setting is
// the default for every document tab ("theme" or "white"); a tab may override it (Tab.paper, undefined = follow the
// setting). App.css gives a pane body marked `data-paper` the Emerald Enterprise Light tokens.
// Code that picks dark or light colours inside a document asks `documentIsDark(el)` and redraws on `onDocumentLook`.
import { useSyncExternalStore } from "react";
import type { Tab } from "../workspace/store";
import { followAppearance, saveAppearance } from "./appearance";
import { prefs } from "./prefs";
import { currentTheme, onThemeChange } from "./theme";

export type PaperDefault = "theme" | "white";
export const PAPER_DEFAULTS: { id: PaperDefault; label: string }[] = [
  { id: "theme", label: "Theme" },
  { id: "white", label: "White" },
];

const settingListeners = new Set<() => void>();
const lookListeners = new Set<() => void>();
let current: PaperDefault = "theme";

/** Use `value` as the default in this window; with `save`, also keep it in the settings file, which tells the other window. */
export function applyPaperDefault(value: PaperDefault, save = true): void {
  current = value;
  if (save) { prefs.setPaper(value); saveAppearance("document_background", value); }
  settingListeners.forEach((l) => l());
}

export const paperDefault = (): PaperDefault => current;
const subscribe = (listener: () => void) => { settingListeners.add(listener); return () => { settingListeners.delete(listener); }; };
export const usePaperDefault = (): PaperDefault => useSyncExternalStore(subscribe, paperDefault);

/** Apply the default from the first-paint copy, then follow the settings file and the other window. Called once, before the first render. */
export function initPaperDefault(): void {
  applyPaperDefault(prefs.paper(), false);
  followAppearance("document_background", () => prefs.stored(prefs.paperKey) as PaperDefault | null, (value) => { prefs.setPaper(value); applyPaperDefault(value, false); });
}

/** Whether a tab shows its document on white paper: its own choice, else the setting. */
export function useWhitePaper(tab: Pick<Tab, "paper"> | undefined): boolean {
  const setting = usePaperDefault();
  return !!tab && (tab.paper ?? setting === "white");
}

/** Whether a document's colours are dark where `el` is drawn: never inside a white pane, else as the theme. */
export function documentIsDark(el: Element | null | undefined): boolean {
  if (el?.closest("[data-paper]")) return false;
  return currentTheme() !== "emerald-light";
}

/** Tell open views a document's background changed (the pane has already been redrawn with its new marker). */
export function announceDocumentLook(): void {
  lookListeners.forEach((l) => l());
}

/** Call `listener` when the answer of `documentIsDark` may have changed: a theme change, or a white pane switched. */
export function onDocumentLook(listener: () => void): () => void {
  lookListeners.add(listener);
  const stop = onThemeChange(listener);
  return () => { lookListeners.delete(listener); stop(); };
}
