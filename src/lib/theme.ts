// The colour theme: Purple (the default, no attribute), Emerald Enterprise Dark (<html data-theme="emerald">)
// or Emerald Enterprise Light (<html data-theme="emerald-light">).
// App.css holds the palettes as tokens; code that reads tokens at runtime listens with onThemeChange.
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useSyncExternalStore } from "react";
import { inTauri } from "./native";
import { prefs } from "./prefs";

export type Theme = "purple" | "emerald" | "emerald-light";
export const THEMES: { id: Theme; label: string }[] = [
  { id: "purple", label: "Purple" },
  { id: "emerald", label: "Emerald Enterprise Dark" },
  { id: "emerald-light", label: "Emerald Enterprise Light" },
];

const listeners = new Set<() => void>();
let current: Theme = "purple";

/** Show `theme` in this window; with `save`, also keep it for the next start and the other window. */
export function applyTheme(theme: Theme, save = true): void {
  current = theme;
  if (theme === "purple") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  if (save) prefs.setTheme(theme);
  syncNativeTheme(theme);
  listeners.forEach((l) => l());
}

/** The theme the window's own title bar is drawn in (DESK-9). Emerald Light is the only light theme. */
export const nativeTheme = (theme: Theme): "light" | "dark" => (theme === "emerald-light" ? "light" : "dark");

/** Draw this window's title bar to match. Outside the app (tests, a plain browser) there is no window to tell. */
function syncNativeTheme(theme: Theme): void {
  if (!inTauri()) return;
  try { getCurrentWindow().setTheme(nativeTheme(theme)).catch(() => undefined); } catch { /* no window */ }
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
