// Callouts of a rich page (NS-3C): NS-3B's callout (its `[!type]` marker, with `+` or `-` for folding) and an icon that
// replaces the type's own. The view is NS-3B's, which draws the icon and offers the choice when the node has the
// attribute.
import { Callout } from "../../rich/schema";

/** An icon is a short symbol (the type's own icon is the default, no icon), so a file cannot put a page of text in a chip. */
export const isIcon = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 4;

export const HmCallout = Callout.extend({
  addAttributes: () => ({ marker: { default: "[!note]", rendered: false }, icon: { default: null, rendered: false } }),
});
