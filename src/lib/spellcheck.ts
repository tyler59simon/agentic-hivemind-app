// Spell checking in Markdown editors (DESK-8): on unless turned off in Settings. Kept in the settings file (a localStorage
// copy serves the first paint), followed in the other window, and held here in memory too, so it holds when localStorage cannot be used.
import { useSyncExternalStore } from "react";
import { followAppearance, saveAppearance } from "./appearance";
import { prefs } from "./prefs";

let on: boolean | null = null;
const listeners = new Set<() => void>();
const show = (next: boolean) => { on = next; prefs.setSpellcheck(next); listeners.forEach((l) => l()); };

/** Whether notes are spell-checked. */
export const spellcheck = (): boolean => on ?? prefs.spellcheck();
export const subscribeSpellcheck = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export const useSpellcheck = (): boolean => useSyncExternalStore(subscribeSpellcheck, spellcheck);

/** Check spelling from now on, or stop: kept in the settings file, and in this window's copy. */
export function setSpellcheck(next: boolean): void {
  show(next);
  saveAppearance("spellcheck", next);
}

/** Follow the settings file for the spelling check. Called once, before the first render. */
export function initSpellcheck(): () => void {
  on = prefs.spellcheck();
  return followAppearance("spellcheck", () => { const copy = prefs.stored(prefs.spellcheckKey); return copy === null ? null : copy !== "0"; }, show);
}
