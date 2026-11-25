// The colour theme: Purple (the default, no attribute), Emerald Enterprise Dark (<html data-theme="emerald">)
// or Emerald Enterprise Light (<html data-theme="emerald-light">). "Follow system" picks one of the two Emerald themes from
// the Windows app mode and changes with it (DESK-OS).
// App.css holds the palettes as tokens; code that reads tokens at runtime listens with onThemeChange.
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useSyncExternalStore } from "react";
import { followAppearance, saveAppearance } from "./appearance";
import { inTauri } from "./native";
import { prefs } from "./prefs";

export type Theme = "purple" | "emerald" | "emerald-light";
export const THEMES: { id: Theme; label: string }[] = [
  { id: "purple", label: "Purple" },
  { id: "emerald", label: "Emerald Enterprise Dark" },
  { id: "emerald-light", label: "Emerald Enterprise Light" },
];

/** What the user picked in Settings: a theme, or "system" for whichever Emerald theme matches the Windows app mode. */
export type ThemeChoice = Theme | "system";
export const THEME_CHOICES: { id: ThemeChoice; label: string }[] = [
  { id: "system", label: "Follow system (Emerald Dark or Light)" },
  ...THEMES,
];

const listeners = new Set<() => void>();
let current: Theme = "purple";
let choice: ThemeChoice = "purple";
const DARK = "(prefers-color-scheme: dark)";

/** The Emerald theme that matches the system's light or dark mode (dark when it cannot tell). */
export const systemTheme = (): Theme => (typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: light)").matches ? "emerald-light" : "emerald");

/** Show `theme` in this window; with `save`, also keep it in the settings file, which tells the other window. */
export function applyTheme(theme: ThemeChoice, save = true): void {
  choice = theme;
  if (save) { prefs.setTheme(theme); saveAppearance("theme", theme); }
  show(theme === "system" ? systemTheme() : theme, theme === "system");
}

function show(theme: Theme, follow: boolean): void {
  current = theme;
  if (theme === "purple") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  // Following the system, the window is told nothing (null), so the web view keeps reporting the system's mode.
  syncNativeTheme(follow ? null : theme);
  listeners.forEach((l) => l());
}

/** The theme the window's own title bar is drawn in (DESK-9). Emerald Light is the only light theme. */
export const nativeTheme = (theme: Theme): "light" | "dark" => (theme === "emerald-light" ? "light" : "dark");

/** Draw this window's title bar to match, or let it follow the system (null). A value also forces the web view's
 *  prefers-color-scheme. Outside the app (tests, a plain browser) there is no window to tell. */
function syncNativeTheme(theme: Theme | null): void {
  if (!inTauri()) return;
  try { getCurrentWindow().setTheme(theme === null ? null : nativeTheme(theme)).catch(() => undefined); } catch { /* no window */ }
}

export function onThemeChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export const currentTheme = (): Theme => current;
export const useTheme = (): Theme => useSyncExternalStore(onThemeChange, currentTheme);
export const currentThemeChoice = (): ThemeChoice => choice;
export const useThemeChoice = (): ThemeChoice => useSyncExternalStore(onThemeChange, currentThemeChoice);

/** Apply the theme from the first-paint copy, then follow the settings file and the other window. Called once, before the first render. */
export function initTheme(): void {
  applyTheme(prefs.theme(), false);
  followAppearance("theme", () => prefs.stored(prefs.themeKey) as ThemeChoice | null, (theme) => { prefs.setTheme(theme); applyTheme(theme, false); });
  if (typeof matchMedia === "function") matchMedia(DARK).addEventListener("change", followSystem);
}

/** The system switched between light and dark mode: follow it if the user chose to. */
export function followSystem(): void {
  if (choice === "system") show(systemTheme(), true);
}
