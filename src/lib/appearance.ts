// Appearance settings in the settings file (DESK-11): theme, document background, document text size, the default note
// mode and the spelling check (DESK-8). Rust keeps them (`appearance_get`, `appearance_set`) and tells every window with
// `appearance`. localStorage holds a copy only so the first paint needs no round trip: after start the file wins, and a
// value only the copy has (kept before the settings file held it) is sent to the file once. To add a setting: a field in
// `Appearance`, an arm in `appearance::change` and a validator in settings.rs, then `followAppearance` in the module that
// shows it.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useSyncExternalStore } from "react";
import { toast } from "../ui/toast";
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
  spellcheck: boolean | null;
}
export type AppearanceKey = keyof Appearance;

// Counts the changes to each key this window made (saves) or heard (events), so a read that answers after a newer change
// (a start-up read, or the read after a refused save) does not undo it.
const changes: Partial<Record<AppearanceKey, number>> = {};
const changed = (key: AppearanceKey) => { changes[key] = (changes[key] ?? 0) + 1; };
// What shows each key in this window, so a refused save can put back what the file holds.
const applies = new Map<AppearanceKey, (value: never) => void>();
const NAMES: Record<AppearanceKey, string> = {
  theme: "theme", document_background: "document background", document_size: "document text size", default_mode: "default note mode", spellcheck: "spelling check",
};
const COPIES: Record<AppearanceKey, string> = {
  theme: prefs.themeKey, document_background: prefs.paperKey, document_size: prefs.docSizeKey, default_mode: prefs.defaultModeKey, spellcheck: prefs.spellcheckKey,
};

/** Keep `value` in the settings file; Rust checks it and tells every window. Outside the app there is no file. */
export function saveAppearance<K extends AppearanceKey>(key: K, value: NonNullable<Appearance[K]>): void {
  changed(key);
  if (inTauri()) invoke("appearance_set", { key, value }).catch(() => refused(key));
}

/** The file did not take a change: say so, and show what it holds, so the screen and the copy match it. When the file holds
 *  nothing for the key, the refused value is dropped from the copy, so the next start does not move it into the file. */
function refused(key: AppearanceKey): void {
  toast(`Could not save the ${NAMES[key]} setting.`, "error");
  const at = changes[key];
  invoke<Appearance>("appearance_get").then((all) => {
    if (changes[key] !== at) return;
    if (all[key] != null) applies.get(key)?.(all[key] as never);
    else try { localStorage.removeItem(COPIES[key]); } catch { /* no copy kept */ }
  }, () => undefined);
}

/** Call `apply` with the setting's value from the settings file at start and whenever any window changes it. `stored` reads
 *  this window's localStorage copy, null when it has none. Returns the undo. */
export function followAppearance<K extends AppearanceKey>(
  key: K, stored: () => Appearance[K], apply: (value: NonNullable<Appearance[K]>) => void,
): () => void {
  if (!inTauri()) return () => {};
  let stopped = false;
  const atStart = changes[key];
  applies.set(key, apply as (value: never) => void);
  const read = () => invoke<Appearance>("appearance_get").then((all) => {
    // A change made or heard while the read was on its way is newer than what it read.
    if (stopped || changes[key] !== atStart) return;
    const value = all[key];
    if (value != null) apply(value as NonNullable<Appearance[K]>);
    else {
      // Only a value the file still lacks: another window or an explicit choice may have set it since.
      const copy = stored();
      if (copy != null) invoke("appearance_init", { key, value: copy }).catch(() => undefined);
    }
  }, () => undefined);
  const unlisten = listen<Appearance>("appearance", (e) => {
    const value = e.payload[key];
    if (value == null) return;
    changed(key);
    apply(value as NonNullable<Appearance[K]>);
  });
  // The read waits for the subscription, so a change between the two is heard, not missed.
  void unlisten.then(read, read);
  return () => { stopped = true; if (applies.get(key) === apply) applies.delete(key); void unlisten.then((u) => u(), () => undefined); };
}

// The mode in effect, kept here too so it holds when localStorage cannot be used.
let mode: Mode | null = null;
const modeListeners = new Set<() => void>();
const showMode = (next: Mode) => { mode = next; prefs.setDefaultMode(next); modeListeners.forEach((l) => l()); };

/** How a note opens by default. */
export const defaultMode = (): Mode => mode ?? prefs.defaultMode();
export const useDefaultMode = (): Mode => useSyncExternalStore(
  (l) => { modeListeners.add(l); return () => { modeListeners.delete(l); }; }, defaultMode);

/** Open notes in `next` from now on: kept in the settings file, and in this window's copy. */
export function setDefaultMode(next: Mode): void {
  showMode(next);
  saveAppearance("default_mode", next);
}

/** Follow the settings file for the default note mode. Called once, before the first render. */
export function initDefaultMode(): () => void {
  mode = prefs.defaultMode();
  return followAppearance("default_mode", () => prefs.stored(prefs.defaultModeKey) as Mode | null, showMode);
}
