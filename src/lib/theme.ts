// The colour theme: Purple (the default, no attribute) or Emerald Enterprise (<html data-theme="emerald">).
// App.css holds both palettes as tokens; code that reads tokens at runtime listens with onThemeChange.
import { useSyncExternalStore } from "react";
import { prefs } from "./prefs";

export type Theme = "purple" | "emerald";
export const THEMES: { id: Theme; label: string }[] = [
  { id: "purple", label: "Purple" },
  { id: "emerald", label: "Emerald Enterprise" },
];

const listeners = new Set<() => void>();
let current: Theme = "purple";

/** Show `theme` in this window; with `save`, also keep it for the next start and the other window. */
export function applyTheme(theme: Theme, save = true): void {
  current = theme;
  if (theme === "purple") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  if (save) prefs.setTheme(theme);
  listeners.forEach((l) => l());
}

export function onThemeChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export const currentTheme = (): Theme => current;
export const useTheme = (): Theme => useSyncExternalStore(onThemeChange, currentTheme);

/** Apply the saved theme and follow changes made in the other window. Called once, before the first render. */
export function initTheme(): void {
  applyTheme(prefs.theme(), false);
  window.addEventListener("storage", (e) => { if (e.key === prefs.themeKey) applyTheme(prefs.theme(), false); });
}
