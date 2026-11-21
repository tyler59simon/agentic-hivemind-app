// The values the attributes of a rich page may hold (NS-3C), where Tiptap does not say. The validator refuses a file that
// holds another value, so nothing the editor makes may hold one either: HTML pasted into a page is cleaned by the same
// rules (`sanitise.ts`). A colour is a palette name, never hex.
import { isNotebookPath } from "../../lib/notebooks";
import { isIcon } from "./blocks/callout";
import { isColour } from "./palette";

const int = (min: number, max: number) => (v: unknown) => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
const nullOr = (ok: (v: unknown) => boolean) => (v: unknown) => v === null || ok(v);
const text = (v: unknown) => typeof v === "string";
const flag = (v: unknown) => typeof v === "boolean";
// 0 is prosemirror-tables' mark for a column of a merged cell whose width is not set: resizing one column of a cell that
// spans two stores [0, 96].
const widths = nullOr((v) => Array.isArray(v) && v.every((w) => typeof w === "number" && Number.isFinite(w) && w >= 0));

const CONTROL = /[\u0000-\u001f\u007f]/;
/** One line of text of at most `max` characters. */
const line = (max: number) => (v: unknown) => typeof v === "string" && v.length <= max && !CONTROL.test(v);
const title = line(300);

const pathWith = (ext: RegExp) => (v: unknown) => isNotebookPath(v) && ext.test(v);
export const PICTURE_PATH = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i;

/** A diagram's path in its system's manifest: relative, with no `..`. The manifest decides which paths exist. */
const manifestPath = (v: unknown) => typeof v === "string" && v.length > 0 && v.length <= 300 && !CONTROL.test(v) && !v.includes("\\") &&
  !v.startsWith("/") && !/^[A-Za-z]:/.test(v) && v.split("/").every((p) => p.length > 0 && p !== "." && p !== "..");

export const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** The most lines and characters a code range keeps a copy of. */
export const MAX_RANGE_LINES = 200;
export const MAX_RANGE_CHARS = 20_000;
export const MAX_GALLERY = 60;

/** By `type.attribute`. An attribute with no rule takes any value. */
export const RULES: Record<string, (v: unknown) => boolean> = {
  // A ref goes to `alm read` as an argument, so one that starts with `-` would be read as an option.
  "noteCard.ref": (v) => line(200)(v) && (v as string).trim().length > 0 && !(v as string).trim().startsWith("-"),
  "noteCard.title": title,
  "diagram.system": (v) => typeof v === "string" && SLUG.test(v),
  "diagram.path": manifestPath,
  "diagram.title": title,
  "codeRange.file": isNotebookPath,
  "codeRange.from": int(1, 10_000_000),
  "codeRange.to": int(1, 10_000_000),
  "codeRange.sha256": (v) => typeof v === "string" && /^[0-9a-f]{64}$/.test(v),
  "codeRange.text": (v) => typeof v === "string" && v.length <= MAX_RANGE_CHARS && v.split("\n").length <= MAX_RANGE_LINES,
  "codeRange.language": line(40),
  "codeRange.title": title,
  "pdfPage.file": pathWith(/\.pdf$/i),
  "pdfPage.page": int(1, 100_000),
  "pdfPage.title": title,
  "gallery.images": (v) => Array.isArray(v) && v.length >= 1 && v.length <= MAX_GALLERY && v.every(pathWith(PICTURE_PATH)),
  "gallery.columns": int(2, 4),
  "gallery.title": title,
  "excalidraw.scene": pathWith(/\.excalidraw$/i),
  "excalidraw.preview": pathWith(/\.png$/i),
  "excalidraw.title": title,
  "freeform.height": int(0, 100_000),
  "frame.x": int(0, 100_000),
  "frame.y": int(0, 100_000),
  "frame.w": int(1, 100_000),
  "frame.h": int(1, 100_000),
  "frame.z": int(0, 100_000),
  "heading.level": int(1, 6),
  // CommonMark allows up to nine digits in a list number; HTML lets `<ol start>` be negative, and earlier pages may hold one.
  "orderedList.start": int(-1_000_000, 999_999_999),
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

/** The nodes NS-3D adds whose attributes must all be present and accepted: every one has a default only so that Tiptap
 *  can build the node, and a default is not a value the rules take. */
export const CHECKED_NODES = ["noteCard", "diagram", "codeRange", "pdfPage", "gallery", "excalidraw", "freeform", "frame"] as const;

/** Rules that compare attributes of one node. */
const NODE_RULES: Record<string, (a: Record<string, unknown>) => string | null> = {
  codeRange: (a) => {
    const from = a.from as number, to = a.to as number;
    if (to < from) return "a range that ends before it starts";
    if (to - from + 1 > MAX_RANGE_LINES) return `a range of more than ${MAX_RANGE_LINES} lines`;
    return null;
  },
};

/** Why the node `name` with these attributes is not one a rich page may hold, or null. Every attribute the type has is
 *  checked, so one left out of a file (and so given its default) is refused when the default is not a good value. */
export function nodeProblem(name: string, attrs: Record<string, unknown>): string | null {
  if (!(CHECKED_NODES as readonly string[]).includes(name)) return null;
  for (const [key, value] of Object.entries(attrs)) {
    if (!attrAccepts(name, key, value)) return `a value Hivemind does not accept for "${key}" on the node "${name}"`;
  }
  const odd = NODE_RULES[name]?.(attrs);
  return odd ? `a node "${name}" with ${odd}` : null;
}
