// Appearance settings in the settings file (DESK-11): theme, document background, document text size and the default note
// mode. Rust keeps them (`appearance_get`, `appearance_set`) and tells every window with `appearance`. localStorage holds
// a copy only so the first paint needs no round trip: after start the file wins, and a value only the copy has (kept
// before the settings file held it) is sent to the file once. To add a setting: a field in `Appearance`, an arm in
// `appearance::change` and a validator in settings.rs, then `followAppearance` in the module that shows it.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Mode } from "../workspace/store";
import { inTauri } from "./native";
import type { PaperDefault } from "./paper";
import { prefs } from "./prefs";
import type { ThemeChoice } from "./theme";

export interface Appearance {
  theme: ThemeChoice | null;
  document_background: PaperDefault | null;
  document_size: number | null;
  default_mode: Mode | null;
}
export type AppearanceKey = keyof Appearance;

/** Keep `value` in the settings file; Rust checks it and tells every window. Outside the app there is no file. */
export function saveAppearance<K extends AppearanceKey>(key: K, value: NonNullable<Appearance[K]>): void {
  if (inTauri()) invoke("appearance_set", { key, value }).catch(() => undefined);
}

/** Call `apply` with the setting's value from the settings file at start and whenever any window changes it. `stored` reads
 *  this window's localStorage copy, null when it has none. Returns the undo. */
export function followAppearance<K extends AppearanceKey>(
  key: K, stored: () => Appearance[K], apply: (value: NonNullable<Appearance[K]>) => void,
): () => void {
  if (!inTauri()) return () => {};
  let stopped = false;
  invoke<Appearance>("appearance_get").then((all) => {
    if (stopped) return;
    const value = all[key];
    if (value != null) apply(value as NonNullable<Appearance[K]>);
    else { const copy = stored(); if (copy != null) saveAppearance(key, copy as NonNullable<Appearance[K]>); }
  }, () => undefined);
  const unlisten = listen<Appearance>("appearance", (e) => {
    const value = e.payload[key];
    if (value != null) apply(value as NonNullable<Appearance[K]>);
  });
  return () => { stopped = true; void unlisten.then((u) => u()); };
}

/** Open notes in `mode` from now on: kept in the settings file, and in this window's copy for `prefs.defaultMode()`. */
export function setDefaultMode(mode: Mode): void {
  prefs.setDefaultMode(mode);
  saveAppearance("default_mode", mode);
}

/** Follow the settings file for the default note mode. Called once, before the first render. */
export function initDefaultMode(): () => void {
  return followAppearance("default_mode", () => prefs.stored(prefs.defaultModeKey) as Mode | null, (mode) => prefs.setDefaultMode(mode));
}
