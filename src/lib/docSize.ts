// Document text size (DESK-ZOOM): reading views, editors and chat messages draw at this multiple of their usual size,
// on top of the window zoom. Kept in the settings file (a localStorage copy serves the first paint) and followed in the other window.
import { useSyncExternalStore } from "react";
import { followAppearance, saveAppearance } from "./appearance";
import { prefs } from "./prefs";

export const DOC_SIZES: { value: number; label: string }[] = [
  { value: 0.9, label: "Small" },
  { value: 1, label: "Normal" },
  { value: 1.1, label: "Large" },
  { value: 1.25, label: "Larger" },
  { value: 1.5, label: "Largest" },
];

const listeners = new Set<() => void>();
let current = 1;

/** Show `size` in this window; with `save`, also keep it in the settings file, which tells the other window. */
export function applyDocSize(size: number, save = true): void {
  current = DOC_SIZES.some((s) => s.value === size) ? size : 1;
  document.documentElement.style.setProperty("--doc-size", String(current));
  if (save) { prefs.setDocSize(current); saveAppearance("document_size", current); }
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export const useDocSize = (): number => useSyncExternalStore(subscribe, () => current);

/** Apply the size from the first-paint copy before the first render, then follow the settings file and the other window. */
export function initDocSize(): void {
  applyDocSize(prefs.docSize(), false);
  followAppearance("document_size", () => { const copy = prefs.stored(prefs.docSizeKey); return copy === null ? null : Number(copy); }, (size) => { prefs.setDocSize(size); applyDocSize(size, false); });
}
