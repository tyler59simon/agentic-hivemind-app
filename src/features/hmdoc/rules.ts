// The values the attributes of a rich page may hold (NS-3C), where Tiptap does not say. The validator refuses a file that
// holds another value, so nothing the editor makes may hold one either: HTML pasted into a page is cleaned by the same
// rules (`sanitise.ts`). A colour is a palette name, never hex.
import { isIcon } from "./blocks/callout";
import { isColour } from "./palette";

const int = (min: number, max: number) => (v: unknown) => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
const nullOr = (ok: (v: unknown) => boolean) => (v: unknown) => v === null || ok(v);
const text = (v: unknown) => typeof v === "string";
const flag = (v: unknown) => typeof v === "boolean";
const widths = nullOr((v) => Array.isArray(v) && v.every((w) => typeof w === "number" && w > 0));

/** By `type.attribute`. An attribute with no rule takes any value. */
export const RULES: Record<string, (v: unknown) => boolean> = {
  "heading.level": int(1, 6),
  "orderedList.start": int(-1_000_000, 1_000_000),
  "taskItem.checked": flag,
  "textColor.color": isColour,
  "highlight.color": isColour,
  "tableCell.background": nullOr(isColour),
  "tableHeader.background": nullOr(isColour),
  "tableCell.colspan": int(1, 1000),
  "tableCell.rowspan": int(1, 1000),
  "tableHeader.colspan": int(1, 1000),
  "tableHeader.rowspan": int(1, 1000),
  "tableCell.colwidth": widths,
  "tableHeader.colwidth": widths,
  "table.id": nullOr((v) => typeof v === "string" && v.length > 0),
  "table.align": (v) => Array.isArray(v) && v.every((a) => a === null || a === "left" || a === "center" || a === "right"),
  "toggle.open": flag,
  "callout.icon": nullOr(isIcon),
  "callout.marker": (v) => typeof v === "string" && /^\[![A-Za-z][\w-]*\][+-]?$/.test(v),
  // What the views of atoms and code draw as text.
  "codeBlock.language": nullOr(text),
  "link.href": nullOr(text),
  "link.title": nullOr(text),
  "image.src": text, "image.alt": text, "image.title": nullOr(text),
  "mathBlock.value": text, "mathBlock.closed": flag,
  "mathInline.value": text, "mathInline.dollars": int(1, 2),
  "wikiLink.value": text, "embed.value": text,
  "rawBlock.value": text, "rawBlock.kind": text,
  "rawInline.value": text, "rawInline.kind": text,
  "footnoteRef.identifier": text, "footnoteRef.label": nullOr(text),
  "footnoteDef.identifier": text, "footnoteDef.label": nullOr(text),
};

/** Whether `value` is one the attribute `attr` of the node or mark type `type` may hold. */
export const attrAccepts = (type: string, attr: string, value: unknown) => RULES[`${type}.${attr}`]?.(value) ?? true;
