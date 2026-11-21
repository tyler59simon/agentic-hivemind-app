// The rich page's document model (NS-3C): NS-3B's extensions without the attributes that only Markdown needs (the
// source slice `srcId`, list markers, a heading's underline, a code fence, the original mdast of source boxes), and
// with what JSON can hold that Markdown cannot: power tables, columns, toggles, a callout icon, text colour and
// highlight colour.
import type { MarkType, NodeType } from "@tiptap/pm/model";
import { Plugin } from "@tiptap/pm/state";
import { Extension, getSchema, Mark, mergeAttributes, type AnyExtension } from "@tiptap/core";
import { Highlight, RawBlock, RawInline, baseExtensions } from "../rich/schema";
import { HmCallout } from "./blocks/callout";
import { Column, Columns } from "./blocks/columns";
import { HmTable, HmTableCell, HmTableHeader, HmTableRow, TableIds } from "./blocks/table/extensions";
import { Toggle, ToggleSummary } from "./blocks/toggle";
import { DEFAULT_HIGHLIGHT } from "./palette";
import { sanitiseSlice } from "./sanitise";

const hidden = (fallback: unknown) => ({ default: fallback, rendered: false });

/** What the page keeps for NS-3B's nodes beyond Tiptap's own: a table's column alignment and id, a link's title. */
const HmdocAttributes = Extension.create({
  name: "hmdocAttributes",
  addGlobalAttributes() {
    return [
      { types: ["table"], attributes: { align: hidden([]), id: hidden(null) } },
      { types: ["link"], attributes: { title: hidden(null) } },
    ];
  },
});

/** `==highlight==` with a palette colour; no colour is the plain highlight. */
const HmHighlight = Highlight.extend({
  addAttributes: () => ({
    color: {
      default: DEFAULT_HIGHLIGHT,
      parseHTML: (el: HTMLElement) => el.getAttribute("data-color") ?? DEFAULT_HIGHLIGHT,
      rendered: false,
    },
  }),
  parseHTML: () => [{ tag: "mark" }],
  renderHTML: ({ mark, HTMLAttributes }) => ["mark", mergeAttributes(HTMLAttributes, { "data-color": mark.attrs.color, class: `hm-hl hm-hl-${mark.attrs.color}` }), 0],
});

export const TextColor = Mark.create({
  name: "textColor",
  addAttributes: () => ({ color: { default: "red", rendered: false } }),
  parseHTML: () => [{ tag: "span[data-text-color]", getAttrs: (el) => ({ color: (el as HTMLElement).getAttribute("data-text-color") }) }],
  renderHTML: ({ mark }) => ["span", { "data-text-color": mark.attrs.color, class: `hm-tc hm-tc-${mark.attrs.color}` }, 0],
});

/** Source boxes keep their text and what kind of source it is; the mdast they were read as is Markdown's. */
const SourceBlock = RawBlock.extend({ addAttributes: () => ({ value: { default: "", rendered: false }, kind: { default: "block", rendered: false } }) });
const SourceInline = RawInline.extend({ addAttributes: () => ({ value: { default: "", rendered: false }, kind: { default: "html", rendered: false } }) });

/** What is pasted or dropped is cleaned of attribute values the file format refuses (see `sanitise.ts`). */
const PasteGuard = Extension.create({
  name: "hmdocPasteGuard",
  addProseMirrorPlugins: () => [new Plugin({ props: { transformPasted: sanitiseSlice } })],
});

const REPLACED = new Set(["markdownAttributes", "table", "tableRow", "tableHeader", "tableCell", "callout", "rawBlock", "rawInline", "highlight"]);

/** The extensions of a rich page without views or editing helpers, as `baseExtensions` is for Markdown pages. */
export function hmdocExtensions(): AnyExtension[] {
  return [
    ...baseExtensions().filter((e) => !REPLACED.has(e.name)),
    HmTable, HmTableRow, HmTableHeader, HmTableCell, TableIds,
    HmCallout, SourceBlock, SourceInline, HmHighlight, TextColor,
    Columns, Column, Toggle, ToggleSummary, HmdocAttributes, PasteGuard,
  ];
}

/** The names and defaults of the attributes of a node or mark type. */
export const attrsOf = (type: NodeType | MarkType): Record<string, unknown> => type.spec.attrs ?? {};

let cached: ReturnType<typeof getSchema> | null = null;
/** The schema, for building and reading documents outside an editor (validation, conversion, export, tests). */
export function hmdocSchema() {
  return (cached ??= getSchema(hmdocExtensions()));
}
