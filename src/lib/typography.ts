// Fonts, document line height, document width and density (DESK-TYPE). Each is a CSS variable (or, for density, an
// attribute) on <html> that App.css reads: --font-ui, --font-doc, --font-mono, --doc-line-height, --doc-width and
// data-density. Kept in the settings file (a localStorage copy serves the first paint) and followed in the other window.
import { useSyncExternalStore } from "react";
import { followAppearance, saveAppearance, type AppearanceKey } from "./appearance";
import { DOC_WIDTHS, FONT_STACKS, TYPE_CHOICES, TYPE_DEFAULTS, type TypeKey, type TypeValue } from "./fonts";
import { prefs } from "./prefs";

const current: { [K in TypeKey]: TypeValue<K> } = { ...TYPE_DEFAULTS };
const listeners = new Set<() => void>();

function render(): void {
  const root = document.documentElement;
  root.style.setProperty("--font-ui", FONT_STACKS[current.ui_font]);
  root.style.setProperty("--font-doc", FONT_STACKS[current.doc_font]);
  root.style.setProperty("--font-mono", FONT_STACKS[current.mono_font]);
  root.style.setProperty("--doc-line-height", String(current.doc_line_height));
  root.style.setProperty("--doc-width", DOC_WIDTHS.find((w) => w.value === current.doc_width)?.width ?? "54rem");
  root.dataset.density = current.density;
  listeners.forEach((l) => l());
}

/** Show `value` in this window; with `save`, also keep it in the settings file, which tells the other window. */
export function applyType<K extends TypeKey>(key: K, value: TypeValue<K>, save = true): void {
  current[key] = value;
  if (save) { prefs.setTypeValue(key, value); saveAppearance(key as AppearanceKey, value as never); }
  render();
}

/** Call `listener` after any of these settings changes (the terminals redraw with the code font). Returns the undo. */
export const onTypeChange = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const useType = <K extends TypeKey>(key: K): TypeValue<K> => useSyncExternalStore(onTypeChange, () => current[key]);

/** Apply every setting from the first-paint copy before the first render, then follow the settings file and the other window. */
export function initTypography(): void {
  for (const key of Object.keys(TYPE_DEFAULTS) as TypeKey[]) {
    current[key] = prefs.typeValue(key) as never;
    followAppearance(key as AppearanceKey,
      () => (TYPE_CHOICES[key] as { value: string | number }[]).find((c) => String(c.value) === prefs.stored(prefs.typeKeys[key]))?.value as never ?? null,
      (value) => { prefs.setTypeValue(key, value as string | number); applyType(key, value as never, false); });
  }
  render();
}
