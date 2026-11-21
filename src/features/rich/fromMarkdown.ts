// Markdown to the Rich editor's document (NS-3B). Every top-level block becomes one node carrying `srcId`, its index
// in the page; a block the editor cannot hold exactly (checked by converting it back) becomes a source box with its
// text as written. `loadPage` also keeps what the writer needs to give untouched blocks back byte for byte.
import type { Mark, Node as PMNode, Schema } from "@tiptap/pm/model";
import type { Blockquote, List, Nodes, PhrasingContent, Root, RootContent, Table } from "mdast";
import { sameMarkdown } from "./canon";
import { DEFAULT_STYLE, parse, stringify, type Style } from "./markdown";
import { blockToMdast } from "./toMarkdown";

/** What a loaded page was: its source, each top-level block's slice and node, the text between them, the page's
 *  style, and the definitions an edited block needs to be read again on its own. */
export interface Original {
  source: string;
  slices: { from: number; to: number }[];
  /** `gaps[i]` is the text before block `i` (`gaps[0]` is the text before the first block). */
  gaps: string[];
  /** The text after the last block. */
  suffix: string;
  nodes: PMNode[];
  style: Style;
  /** Link and footnote definitions of the page, as lines to append when a block is parsed alone. */
  definitions: string[];
}

const CALLOUT = /^\[!([A-Za-z][\w-]*)\]([+-]?)([ \t]*)/;

class Unsupported extends Error {}

interface Cx { schema: Schema; source: string }

const slice = (cx: Cx, n: Nodes) => cx.source.slice(n.position!.start.offset!, n.position!.end.offset!);

function inline(cx: Cx, children: readonly PhrasingContent[], marks: readonly Mark[] = []): PMNode[] {
  const { schema } = cx;
  const out: PMNode[] = [];
  const mark = (name: string, attrs?: Record<string, unknown>) => [...marks.filter((m) => m.type.name !== name), schema.marks[name].create(attrs)];
  for (const c of children) {
    switch (c.type) {
      case "text": if (c.value) out.push(schema.text(c.value, marks)); break;
      case "inlineCode": if (c.value) out.push(schema.text(c.value, mark("code"))); else throw new Unsupported(); break;
      case "emphasis": out.push(...inline(cx, c.children, mark("italic"))); break;
      case "strong": out.push(...inline(cx, c.children, mark("bold"))); break;
      case "delete": out.push(...inline(cx, c.children, mark("strike"))); break;
      case "highlight": out.push(...inline(cx, c.children, mark("highlight"))); break;
      case "link": out.push(...inline(cx, c.children, [...marks, schema.marks.link.create({ href: c.url, title: c.title ?? null })])); break;
      case "break": out.push(schema.nodes.hardBreak.create(null, null, marks)); break;
      case "image": out.push(schema.nodes.image.create({ src: c.url, alt: c.alt ?? "", title: c.title ?? null }, null, marks)); break;
      case "inlineMath": out.push(schema.nodes.mathInline.create({ value: c.value, dollars: c.dollars }, null, marks)); break;
      case "wikiLink": out.push(schema.nodes.wikiLink.create({ value: c.value }, null, marks)); break;
      case "embed": out.push(schema.nodes.embed.create({ value: c.value }, null, marks)); break;
      case "footnoteReference": out.push(schema.nodes.footnoteRef.create({ identifier: c.identifier, label: c.label ?? null }, null, marks)); break;
      case "comment": out.push(schema.nodes.rawInline.create({ value: c.value, kind: "comment", original: strip(c) }, null, marks)); break;
      case "html": out.push(schema.nodes.rawInline.create({ value: c.value, kind: "html", original: strip(c) }, null, marks)); break;
      case "linkReference": case "imageReference": {
        // Written as it was; a reference over two lines would need its container's marks, so its block stays source.
        const text = slice(cx, c);
        if (text.includes("\n")) throw new Unsupported();
        out.push(schema.nodes.rawInline.create({ value: text, kind: "reference", original: strip(c) }, null, marks));
        break;
      }
      default: throw new Unsupported();
    }
  }
  return out;
}

/** A node without positions, kept to compare against. */
function strip<T>(node: T): T {
  return JSON.parse(JSON.stringify(node, (k, v) => (k === "position" ? undefined : v)));
}

function blocks(cx: Cx, children: readonly RootContent[]): PMNode[] {
  return children.map((c) => block(cx, c, false));
}

/** Block content that must start with a paragraph (list items) or hold at least one block. */
function leading(cx: Cx, content: PMNode[], paragraphFirst: boolean): PMNode[] {
  if (!content.length || (paragraphFirst && content[0].type.name !== "paragraph")) return [cx.schema.nodes.paragraph.create(), ...content];
  return content;
}

function listMarker(cx: Cx, list: List): string | null {
  const item = list.children[0];
  if (!item?.position) return null;
  const text = cx.source.slice(item.position.start.offset!, item.position.start.offset! + 12);
  const m = list.ordered ? /^\s*\d+([.)])/.exec(text) : /^\s*([-*+])/.exec(text);
  return m ? m[1] : null;
}

function callout(cx: Cx, quote: Blockquote): PMNode | null {
  const first = quote.children[0];
  if (first?.type !== "paragraph" || first.children[0]?.type !== "text") return null;
  const m = CALLOUT.exec(first.children[0].value);
  if (!m) return null;
  const { schema } = cx;
  const content = inline(cx, first.children);
  // The first text node starts with the marker; take it off, then split the title from the body at the first line
  // break (Obsidian's title is the rest of the first line).
  const head = content[0];
  const remainder = head.text!.slice(m[0].length);
  const rest = [...(remainder ? [schema.text(remainder, head.marks)] : []), ...content.slice(1)];
  const title: PMNode[] = [], body: PMNode[] = [];
  let split = false;
  for (const n of rest) {
    if (split) { body.push(n); continue; }
    if (n.type.name === "hardBreak") throw new Unsupported();
    const at = n.isText ? n.text!.indexOf("\n") : -1;
    if (at < 0) { title.push(n); continue; }
    split = true;
    if (at > 0) title.push(schema.text(n.text!.slice(0, at), n.marks));
    if (at < n.text!.length - 1) body.push(schema.text(n.text!.slice(at + 1), n.marks));
  }
  const joined = split && body.length > 0;
  const tail = blocks(cx, quote.children.slice(1));
  return schema.nodes.callout.create(
    { marker: `[!${m[1]}]${m[2]}`, sep: m[3], joined },
    [schema.nodes.calloutTitle.create(null, title), ...(joined ? [schema.nodes.paragraph.create(null, body)] : []), ...tail],
  );
}

function table(cx: Cx, t: Table): PMNode {
  const { schema } = cx;
  const width = Math.max(...t.children.map((r) => r.children.length));
  const rows = t.children.map((row, r) => {
    const cells = row.children.map((cell) => (r === 0 ? schema.nodes.tableHeader : schema.nodes.tableCell).create(null, schema.nodes.paragraph.create(null, inline(cx, cell.children))));
    while (cells.length < width) cells.push((r === 0 ? schema.nodes.tableHeader : schema.nodes.tableCell).create(null, schema.nodes.paragraph.create()));
    return schema.nodes.tableRow.create(null, cells);
  });
  return schema.nodes.table.create({ align: Array.from({ length: width }, (_, i) => t.align?.[i] ?? null) }, rows);
}

function block(cx: Cx, n: RootContent, top: boolean): PMNode {
  const { schema } = cx;
  const N = schema.nodes;
  switch (n.type) {
    case "paragraph": return N.paragraph.create(null, inline(cx, n.children));
    case "heading": {
      const setext = n.depth <= 2 && !/^\s{0,3}#/.test(slice(cx, n));
      return N.heading.create({ level: n.depth, setext }, inline(cx, n.children));
    }
    case "thematicBreak": return N.horizontalRule.create({ markup: slice(cx, n).trim() });
    case "blockquote": return callout(cx, n) ?? N.blockquote.create(null, leading(cx, blocks(cx, n.children), false));
    case "list": {
      const items = n.children.map((item) => {
        const content = leading(cx, blocks(cx, item.children), true);
        const spread = !!item.spread;
        return item.checked === null || item.checked === undefined ? N.listItem.create({ spread }, content) : N.taskItem.create({ checked: item.checked, spread }, content);
      });
      const attrs = { spread: !!n.spread, marker: listMarker(cx, n) };
      return n.ordered ? N.orderedList.create({ ...attrs, start: n.start ?? 1 }, items) : N.bulletList.create(attrs, items);
    }
    case "code": {
      const fence = /^\s*(`{3,}|~{3,})/.exec(slice(cx, n));
      return N.codeBlock.create({ language: n.lang ?? null, meta: n.meta ?? null, fence: fence ? fence[1] : null }, n.value ? schema.text(n.value) : null);
    }
    case "math": return N.mathBlock.create({ value: n.value, closed: n.closed });
    case "table": return table(cx, n);
    case "footnoteDefinition": return N.footnoteDef.create({ identifier: n.identifier, label: n.label ?? null }, leading(cx, blocks(cx, n.children), false));
    case "html": return N.rawBlock.create({ value: top ? slice(cx, n) : n.value, kind: "html", original: strip(n) });
    case "definition": return N.rawBlock.create({ value: top ? slice(cx, n) : stringify([n], DEFAULT_STYLE, false), kind: "definition", original: strip(n) });
    case "yaml": if (top) return N.rawBlock.create({ value: slice(cx, n), kind: "frontmatter", original: strip(n) }); throw new Unsupported();
    default:
      if ((n.type as string) === "toml" && top) return N.rawBlock.create({ value: slice(cx, n), kind: "frontmatter", original: strip(n) });
      throw new Unsupported();
  }
}

/** One top-level block as an editor node, or a source box when the editor cannot give it back as it was read. */
export function topBlock(schema: Schema, source: string, n: RootContent, srcId: number | null): PMNode {
  const cx = { schema, source };
  let node: PMNode | null = null;
  try {
    node = block(cx, n, true);
    node.check();
    if (!sameMarkdown(blockToMdast(node), n)) node = null;
  } catch (e) {
    if (!(e instanceof Unsupported) && !(e instanceof RangeError)) throw e;
  }
  const at = (node ?? schema.nodes.rawBlock.create({ value: slice(cx, n), kind: n.type === "html" ? "html" : "block", original: strip(n) }));
  return srcId === null ? at : at.type.create({ ...at.attrs, srcId }, at.content, at.marks);
}

/** The style a page writes in, by what most of its blocks use. */
export function detectStyle(root: Root, source: string): Style {
  const votes = new Map<string, Map<string, number>>();
  const vote = (k: string, v: string) => {
    const m = votes.get(k) ?? new Map<string, number>();
    m.set(v, (m.get(v) ?? 0) + 1);
    votes.set(k, m);
  };
  const at = (n: Nodes) => source.slice(n.position?.start.offset ?? 0, n.position?.end.offset ?? 0);
  const visit = (n: Nodes) => {
    switch (n.type) {
      case "list": {
        const marker = /^\s*(?:\d+([.)])|([-*+]))/.exec(at(n));
        if (marker) vote(n.ordered ? "bulletOrdered" : "bullet", marker[1] ?? marker[2]);
        if (n.ordered && n.children.length > 1) {
          const numbers = n.children.map((i) => /^\s*(\d+)/.exec(at(i))?.[1]);
          vote("incrementListMarker", String(new Set(numbers).size > 1));
        }
        for (const item of n.children) {
          const m = /^(\s*(?:\d+[.)]|[-*+]))( +)\S/.exec(at(item));
          if (m) vote("listItemIndent", m[2].length > 1 && (m[1].length + m[2].length) % 4 === 0 ? "tab" : "one");
        }
        break;
      }
      case "emphasis": case "strong": { const c = at(n)[0]; if (c === "*" || c === "_") vote(n.type, c); break; }
      case "code": { const f = /^\s*([`~])\1\1/.exec(at(n)); if (f) vote("fence", f[1]); break; }
      case "thematicBreak": {
        const t = at(n).trim();
        vote("rule", t[0]);
        vote("ruleSpaces", String(/\s/.test(t)));
        vote("ruleRepetition", String(t.replace(/\s/g, "").length));
        break;
      }
      case "heading": if (n.depth <= 2) vote("setext", String(!/^\s{0,3}#/.test(at(n)))); break;
      case "break": vote("hardBreak", at(n).startsWith("\\") ? "backslash" : "spaces"); break;
    }
    if ("children" in n) for (const c of n.children as Nodes[]) visit(c);
  };
  visit(root);
  const pick = <T extends string>(k: string, fallback: T): T => {
    const m = votes.get(k);
    if (!m) return fallback;
    return [...m.entries()].sort((a, b) => b[1] - a[1])[0][0] as T;
  };
  const bullet = pick("bullet", DEFAULT_STYLE.bullet);
  return {
    bullet,
    bulletOrdered: pick("bulletOrdered", DEFAULT_STYLE.bulletOrdered),
    emphasis: pick("emphasis", DEFAULT_STYLE.emphasis),
    strong: pick("strong", DEFAULT_STYLE.strong),
    fence: pick("fence", DEFAULT_STYLE.fence),
    rule: pick("rule", DEFAULT_STYLE.rule),
    ruleRepetition: Math.max(3, Number(pick<string>("ruleRepetition", "3"))),
    ruleSpaces: pick<string>("ruleSpaces", "false") === "true",
    listItemIndent: pick("listItemIndent", DEFAULT_STYLE.listItemIndent),
    setext: pick<string>("setext", "false") === "true",
    incrementListMarker: pick<string>("incrementListMarker", "true") === "true",
    hardBreak: pick("hardBreak", DEFAULT_STYLE.hardBreak),
  };
}

function definitions(root: Root): string[] {
  const out: string[] = [];
  const visit = (n: Nodes) => {
    if (n.type === "definition") out.push(`[${n.label ?? n.identifier}]: <>`);
    if (n.type === "footnoteDefinition") out.push(`[^${n.label ?? n.identifier}]: x`);
    if ("children" in n) for (const c of n.children as Nodes[]) visit(c);
  };
  visit(root);
  return [...new Set(out)];
}

/** A page as an editor document, with what writing it back needs. */
export function loadPage(schema: Schema, source: string): { doc: PMNode; original: Original } {
  const root = parse(source);
  const slices: Original["slices"] = [];
  const gaps: string[] = [];
  let end = 0;
  const nodes = root.children.map((n, i) => {
    const from = n.position!.start.offset!, to = n.position!.end.offset!;
    gaps.push(source.slice(end, from));
    slices.push({ from, to });
    end = to;
    return topBlock(schema, source, n, i);
  });
  const doc = schema.nodes.doc.create(null, nodes.length ? nodes : [schema.nodes.paragraph.create()]);
  // The original nodes are the document's own children, so an untouched block is the same object.
  const own: PMNode[] = [];
  doc.forEach((n) => own.push(n));
  return {
    doc,
    original: { source, slices, gaps, suffix: source.slice(end), nodes: nodes.length ? own : [], style: detectStyle(root, source), definitions: definitions(root) },
  };
}

/** Markdown typed or pasted into the editor, as nodes without source (they are written in the page's style). */
export function markdownNodes(schema: Schema, text: string): PMNode[] {
  const root = parse(text);
  return root.children.map((n) => topBlock(schema, text, n, null));
}

