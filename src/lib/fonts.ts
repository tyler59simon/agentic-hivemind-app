// The choices for fonts, document line height, document width and density (DESK-TYPE), as plain data. A font is a preset
// key, never CSS text: the stack for each key lives here, and the Rust side (settings.rs) validates the same keys.
export interface Choice<V> { value: V; label: string }

/** Font stacks by key. `jakarta` and `jetbrains` are bundled (main.tsx); the others come from the system, with fallbacks. */
export const FONT_STACKS = {
  jakarta: '"Plus Jakarta Sans Variable", "Segoe UI", system-ui, -apple-system, sans-serif',
  segoe: '"Segoe UI", system-ui, -apple-system, sans-serif',
  system: 'system-ui, -apple-system, "Segoe UI", sans-serif',
  georgia: 'Georgia, "Times New Roman", serif',
  cambria: 'Cambria, Georgia, "Times New Roman", serif',
  jetbrains: '"JetBrains Mono Variable", ui-monospace, "Cascadia Code", Consolas, monospace',
  cascadia: '"Cascadia Code", "Cascadia Mono", ui-monospace, Consolas, monospace',
  consolas: 'Consolas, ui-monospace, "Cascadia Code", monospace',
} as const;
export type FontKey = keyof typeof FONT_STACKS;

export type UiFont = "jakarta" | "segoe" | "system";
export type DocFont = UiFont | "georgia" | "cambria";
export type MonoFont = "jetbrains" | "cascadia" | "consolas";
export type LineHeight = 1.4 | 1.6 | 1.8;
export type DocWidth = "narrow" | "normal" | "wide" | "full";
export type Density = "comfortable" | "compact";

export const UI_FONTS: Choice<UiFont>[] = [
  { value: "jakarta", label: "Plus Jakarta Sans" }, { value: "segoe", label: "Segoe UI" }, { value: "system", label: "System" },
];
export const DOC_FONTS: Choice<DocFont>[] = [...UI_FONTS, { value: "georgia", label: "Georgia" }, { value: "cambria", label: "Cambria" }];
export const MONO_FONTS: Choice<MonoFont>[] = [
  { value: "jetbrains", label: "JetBrains Mono" }, { value: "cascadia", label: "Cascadia Code" }, { value: "consolas", label: "Consolas" },
];
export const LINE_HEIGHTS: Choice<LineHeight>[] = [
  { value: 1.4, label: "Tight (1.4)" }, { value: 1.6, label: "Normal (1.6)" }, { value: 1.8, label: "Loose (1.8)" },
];
/** `width` is the CSS max-width of a note's reading column. */
export const DOC_WIDTHS: (Choice<DocWidth> & { width: string })[] = [
  { value: "narrow", label: "Narrow", width: "46rem" }, { value: "normal", label: "Normal", width: "54rem" },
  { value: "wide", label: "Wide", width: "72rem" }, { value: "full", label: "Full width", width: "none" },
];
export const DENSITIES: Choice<Density>[] = [{ value: "comfortable", label: "Comfortable" }, { value: "compact", label: "Compact" }];

/** What each setting is when nothing was chosen. Keep in step with the :root tokens in App.css. */
export const TYPE_DEFAULTS = {
  ui_font: "jakarta" as UiFont, doc_font: "jakarta" as DocFont, mono_font: "jetbrains" as MonoFont,
  doc_line_height: 1.6 as LineHeight, doc_width: "normal" as DocWidth, density: "comfortable" as Density,
};
export type TypeKey = keyof typeof TYPE_DEFAULTS;
export type TypeValue<K extends TypeKey> = (typeof TYPE_DEFAULTS)[K];

/** The values each setting may have, for checking a stored copy. */
export const TYPE_CHOICES: { [K in TypeKey]: Choice<TypeValue<K>>[] } = {
  ui_font: UI_FONTS, doc_font: DOC_FONTS, mono_font: MONO_FONTS, doc_line_height: LINE_HEIGHTS, doc_width: DOC_WIDTHS, density: DENSITIES,
};
