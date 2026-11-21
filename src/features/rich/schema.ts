// The Rich editor's document model (NS-3B): Tiptap's nodes and marks for what Markdown and GFM have, Hivemind's own
// for Obsidian syntax and for source the editor holds only as text, and the attributes that let an edited block be
// written back the way the page wrote it. No extension here rewrites nodes it did not change: untouched blocks keep
// their identity, and with it their original source.
import { Extension, Mark, Node, getSchema, markInputRule, mergeAttributes, type AnyExtension } from "@tiptap/core";
import { Code } from "@tiptap/extension-code";
import { CodeBlock } from "@tiptap/extension-code-block";
import { BulletList, ListItem, ListKeymap, OrderedList, TaskItem } from "@tiptap/extension-list";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import StarterKit from "@tiptap/starter-kit";

/** Block types that can sit at the top of a page, and so own a source slice. */
export const TOP_TYPES = ["paragraph", "heading", "blockquote", "callout", "bulletList", "orderedList", "codeBlock", "horizontalRule", "table", "mathBlock", "rawBlock", "footnoteDef"];

const hidden = (fallback: unknown, keepOnSplit = true) => ({ default: fallback, rendered: false, keepOnSplit });

/** Attributes Markdown needs and the editor does not draw. `srcId` is the index of the top-level block a node was
 *  read as; it is set only when a page is loaded and never copied onto a split. */
const MarkdownAttributes = Extension.create({
  name: "markdownAttributes",
  addGlobalAttributes() {
    return [
      { types: TOP_TYPES, attributes: { srcId: hidden(null, false) } },
      { types: ["bulletList", "orderedList", "listItem", "taskItem"], attributes: { spread: hidden(false) } },
      { types: ["bulletList", "orderedList"], attributes: { marker: hidden(null) } },
      { types: ["heading"], attributes: { setext: hidden(false, false) } },
      { types: ["codeBlock"], attributes: { meta: hidden(null), fence: hidden(null) } },
      { types: ["horizontalRule"], attributes: { markup: hidden(null) } },
      { types: ["table"], attributes: { align: hidden([]) } },
      { types: ["link"], attributes: { title: hidden(null) } },
    ];
  },
});

/** Lists hold plain and task items alike, as Markdown lists do. */
const ITEMS = "(listItem|taskItem)+";
const Bullets = BulletList.extend({ content: () => ITEMS });
const Numbers = OrderedList.extend({ content: () => ITEMS });
const Tasks = TaskItem.configure({ nested: true });

/** Inline code combines with bold, links and the rest, as Markdown allows. */
const InlineCode = Code.extend({ excludes: "" });

/** `==highlight==`. */
export const Highlight = Mark.create({
  name: "highlight",
  parseHTML: () => [{ tag: "mark" }],
  renderHTML: ({ HTMLAttributes }) => ["mark", HTMLAttributes, 0],
  addKeyboardShortcuts() {
    return { "Mod-Shift-h": () => this.editor.commands.toggleMark(this.name) };
  },
  addInputRules() {
    return [markInputRule({ find: /(?:^|\s)(==(?!\s)([^=]+?)(?<!\s)==)$/, type: this.type })];
  },
});

/** `> [!type] Title` and its body. `marker` is the `[!type]` mark as written (with `+` or `-` for folding), `sep` the
 *  space after it, and `joined` whether the body's first paragraph continued the title's line. */
export const Callout = Node.create({
  name: "callout",
  group: "block",
  content: "calloutTitle block*",
  defining: true,
  addAttributes: () => ({ marker: { default: "[!note]", rendered: false }, sep: hidden(" "), joined: hidden(false) }),
  parseHTML: () => [{ tag: "div[data-callout]", getAttrs: (el) => ({ marker: (el as HTMLElement).dataset.callout ?? "[!note]" }) }],
  renderHTML: ({ node }) => ["div", { "data-callout": node.attrs.marker, class: "rich-callout" }, 0],
});

export const CalloutTitle = Node.create({
  name: "calloutTitle",
  content: "inline*",
  defining: true,
  parseHTML: () => [{ tag: "div[data-callout-title]" }],
  renderHTML: () => ["div", { "data-callout-title": "", class: "rich-callout-title" }, 0],
});

/** An atom whose attributes round-trip through its HTML as data attributes (copy and paste inside the editor). */
export function atom(name: string, inline: boolean, attrs: Record<string, unknown>, tag = inline ? "span" : "div", extra: Partial<Parameters<typeof Node.create>[0]> = {}) {
  const keys = Object.keys(attrs);
  return Node.create({
    name,
    group: inline ? "inline" : "block",
    inline,
    atom: true,
    selectable: true,
    addAttributes: () => Object.fromEntries(keys.map((k) => [k, { default: attrs[k], rendered: false }])),
    parseHTML: () => [{
      tag: `${tag}[data-rich="${name}"]`,
      getAttrs: (el) => {
        const raw = (el as HTMLElement).dataset.attrs;
        try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
      },
    }],
    renderHTML: ({ node, HTMLAttributes }) => [tag, mergeAttributes(HTMLAttributes, { "data-rich": name, "data-attrs": JSON.stringify(node.attrs) })],
    ...extra,
  });
}

/** `$$...$$`: `value` is everything between the marks, line breaks included. */
export const MathBlock = atom("mathBlock", false, { value: "\n\n", closed: true });
export const MathInline = atom("mathInline", true, { value: "", dollars: 1 });
/** `[[value]]` and `![[value]]`. */
export const WikiLink = atom("wikiLink", true, { value: "" });
export const Embed = atom("embed", true, { value: "" });
export const Image = atom("image", true, { src: "", alt: "", title: null });
export const FootnoteRef = atom("footnoteRef", true, { identifier: "", label: null });
/** Source the editor cannot model, kept as written: `kind` names what it is (html, definition, frontmatter, comment,
 *  reference, block), `original` the mdast node it was read as. */
export const RawBlock = atom("rawBlock", false, { value: "", kind: "block", original: null });
export const RawInline = atom("rawInline", true, { value: "", kind: "html", original: null });

export const FootnoteDef = Node.create({
  name: "footnoteDef",
  group: "block",
  content: "block+",
  defining: true,
  addAttributes: () => ({ identifier: { default: "", rendered: false }, label: hidden(null) }),
  parseHTML: () => [{ tag: "div[data-footnote]", getAttrs: (el) => ({ identifier: (el as HTMLElement).dataset.footnote ?? "" }) }],
  renderHTML: ({ node }) => ["div", { "data-footnote": node.attrs.identifier, class: "rich-footnote" }, 0],
});

/** Everything the Rich editor's schema has, without views or editing helpers that need a page. */
export function baseExtensions(): AnyExtension[] {
  return [
    StarterKit.configure({
      bulletList: false, orderedList: false, listItem: false, listKeymap: false, code: false, codeBlock: false,
      underline: false, trailingNode: false,
      link: { openOnClick: false, autolink: false, linkOnPaste: true, HTMLAttributes: { rel: null, target: null } },
    }),
    Bullets, Numbers, ListItem, Tasks, ListKeymap.configure({ listTypes: [{ itemName: "listItem", wrapperNames: ["bulletList", "orderedList"] }, { itemName: "taskItem", wrapperNames: ["bulletList", "orderedList"] }] }),
    CodeBlock.configure({ defaultLanguage: null, enableTabIndentation: true }), InlineCode, Highlight,
    Table.configure({ resizable: false }), TableRow, TableHeader.extend({ content: "paragraph" }), TableCell.extend({ content: "paragraph" }),
    Callout, CalloutTitle, MathBlock, MathInline, WikiLink, Embed, Image, FootnoteRef, FootnoteDef, RawBlock, RawInline,
    MarkdownAttributes,
  ];
}

let cached: ReturnType<typeof getSchema> | null = null;
/** The schema, for building and reading documents outside an editor (tests, the corpus). */
export function richSchema() {
  return (cached ??= getSchema(baseExtensions()));
}
