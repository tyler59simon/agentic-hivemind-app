// The colours of a rich page (NS-3C): a fixed list of names, stored by name and never as hex, and drawn through the
// `--pal-<name>-fg` and `--pal-<name>-bg` variables of App.css, which differ for the light and dark themes.
export const PALETTE = ["gray", "red", "orange", "yellow", "green", "blue", "purple", "pink"] as const;
export type Colour = (typeof PALETTE)[number];

export const isColour = (v: unknown): v is Colour => typeof v === "string" && (PALETTE as readonly string[]).includes(v);

/** The highlight a plain `==text==` is. */
export const DEFAULT_HIGHLIGHT: Colour = "yellow";

export const PAGE_WIDTHS = ["normal", "wide", "full"] as const;
export type PageWidth = (typeof PAGE_WIDTHS)[number];
