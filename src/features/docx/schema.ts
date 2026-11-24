// Tiptap document schema for `.docx` editing: reuses Hivemind's table and list support plus Word marks
// (underline, text alignment, subscript, superscript, exact hex text color & highlight, inline images, page breaks,
// and read-only `docxRawBlock` placeholders for preserved Word-only XML).
import { Mark, Node, getSchema, mergeAttributes, type AnyExtension } from "@tiptap/core";
import { Code } from "@tiptap/extension-code";
import { CodeBlock } from "@tiptap/extension-code-block";
import { BulletList, ListItem, ListKeymap, OrderedList } from "@tiptap/extension-list";
import { Subscript } from "@tiptap/extension-subscript";
import { Superscript } from "@tiptap/extension-superscript";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import { TextAlign } from "@tiptap/extension-text-align";
import { Underline } from "@tiptap/extension-underline";
import StarterKit from "@tiptap/starter-kit";

const SAFE_HEX = /^#[0-9a-f]{6}$/i;

export const DocxTextColor = Mark.create({
  name: "docxTextColor",
  addAttributes: () => ({
    color: {
      default: "#1f2937",
      parseHTML: (el: HTMLElement) => el.getAttribute("data-docx-color") ?? "#1f2937",
      renderHTML: (attrs: { color?: string }) => (attrs.color && SAFE_HEX.test(attrs.color) ? { "data-docx-color": attrs.color, style: `color:${attrs.color}` } : {}),
    },
  }),
  parseHTML: () => [{ tag: "span[data-docx-color]" }],
  renderHTML: ({ HTMLAttributes }) => ["span", HTMLAttributes, 0],
});

export const DocxHighlight = Mark.create({
  name: "docxHighlight",
  addAttributes: () => ({
    color: {
      default: "#fef08a",
      parseHTML: (el: HTMLElement) => el.getAttribute("data-docx-hl") ?? "#fef08a",
      renderHTML: (attrs: { color?: string }) => (attrs.color && SAFE_HEX.test(attrs.color) ? { "data-docx-hl": attrs.color, style: `background-color:${attrs.color}` } : {}),
    },
  }),
  parseHTML: () => [{ tag: "mark[data-docx-hl]" }],
  renderHTML: ({ HTMLAttributes }) => ["mark", HTMLAttributes, 0],
});

export const DocxImage = Node.create({
  name: "docxImage",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes: () => ({
    mediaId: { default: "" },
    alt: { default: "" },
  }),
  parseHTML: () => [{
    tag: "img[data-docx-media]",
    getAttrs: (el) => ({
      mediaId: (el as HTMLElement).getAttribute("data-docx-media") ?? "",
      alt: (el as HTMLElement).getAttribute("alt") ?? "",
    }),
  }],
  renderHTML: ({ node, HTMLAttributes }) => [
    "img",
    mergeAttributes(HTMLAttributes, { "data-docx-media": node.attrs.mediaId, alt: node.attrs.alt, class: "docx-inline-img" }),
  ],
});

export const DocxPageBreak = Node.create({
  name: "docxPageBreak",
  group: "block",
  atom: true,
  selectable: true,
  parseHTML: () => [{ tag: "div[data-docx-pagebreak]" }],
  renderHTML: () => ["div", { "data-docx-pagebreak": "", class: "docx-page-break", contenteditable: "false" }, "Page break"],
});

export const DocxRawBlock = Node.create({
  name: "docxRawBlock",
  group: "block",
  atom: true,
  selectable: true,
  addAttributes: () => ({
    label: { default: "Preserved Word block" },
    xml: { default: "" },
  }),
  parseHTML: () => [{
    tag: "div[data-docx-raw]",
    getAttrs: (el) => ({
      label: (el as HTMLElement).getAttribute("data-docx-label") ?? "Preserved Word block",
      xml: (el as HTMLElement).getAttribute("data-docx-raw") ?? "",
    }),
  }],
  renderHTML: ({ node }) => [
    "div",
    { "data-docx-raw": node.attrs.xml, "data-docx-label": node.attrs.label, class: "docx-raw-block", contenteditable: "false" },
    `${node.attrs.label} (preserved on save)`,
  ],
});

const InlineCode = Code.extend({ excludes: "" });

export function docxExtensions(): AnyExtension[] {
  return [
    StarterKit.configure({
      bulletList: false,
      orderedList: false,
      listItem: false,
      listKeymap: false,
      code: false,
      codeBlock: false,
      underline: false,
      link: { openOnClick: false, autolink: false, linkOnPaste: true, HTMLAttributes: { rel: null, target: null } },
    }),
    BulletList,
    OrderedList,
    ListItem,
    ListKeymap.configure({ listTypes: [{ itemName: "listItem", wrapperNames: ["bulletList", "orderedList"] }] }),
    CodeBlock.configure({ defaultLanguage: null, enableTabIndentation: true }),
    InlineCode,
    Underline,
    Subscript,
    Superscript,
    TextAlign.configure({ types: ["heading", "paragraph"] }),
    Table.configure({ resizable: false }),
    TableRow,
    TableHeader.extend({ content: "block+" }),
    TableCell.extend({ content: "block+" }),
    DocxTextColor,
    DocxHighlight,
    DocxImage,
    DocxPageBreak,
    DocxRawBlock,
  ];
}

let cached: ReturnType<typeof getSchema> | null = null;
export function docxSchema() {
  return (cached ??= getSchema(docxExtensions()));
}
