// The Rich editor's document back to Markdown (NS-3B): editor nodes to mdast, and one edited block to text in the
// page's style. A block is written without escaping its text when that reads back as the same block, so prose keeps
// its brackets and asterisks; otherwise it is written with `mdast-util-to-markdown`'s escapes.
import type { Mark, Node as PMNode } from "@tiptap/pm/model";
import type { BlockContent, ListItem, Nodes, PhrasingContent, RootContent, TableCell, TableRow } from "mdast";
import { sameMarkdown } from "./canon";
import { parse, stringify, type Overrides, type Style } from "./markdown";

type Parent = { children: PhrasingContent[] };

function markNode(mark: Mark): PhrasingContent & Parent {
  switch (mark.type.name) {
    case "bold": return { type: "strong", children: [] };
    case "italic": return { type: "emphasis", children: [] };
    case "strike": return { type: "delete", children: [] };
    case "highlight": return { type: "highlight", children: [] };
    case "link": return { type: "link", url: mark.attrs.href ?? "", title: mark.attrs.title ?? null, children: [] };
    default: return { type: "emphasis", children: [] };
  }
}

const WRAPPING = new Set(["bold", "italic", "strike", "highlight", "link"]);

function leaf(n: PMNode): PhrasingContent | null {
  const a = n.attrs;
  if (n.isText) return n.marks.some((m) => m.type.name === "code") ? { type: "inlineCode", value: n.text! } : { type: "text", value: n.text! };
  switch (n.type.name) {
    case "hardBreak": return { type: "break" };
    case "image": return { type: "image", url: a.src, alt: a.alt, title: a.title ?? null };
    case "mathInline": return { type: "inlineMath", value: a.value, dollars: a.dollars };
    case "wikiLink": return { type: "wikiLink", value: a.value };
    case "embed": return { type: "embed", value: a.value };
    case "footnoteRef": return { type: "footnoteReference", identifier: a.identifier, label: a.label ?? undefined };
    case "rawInline": return { type: "raw", value: a.value, original: a.original };
    default: return null;
  }
}

/** Inline content as mdast phrasing: marks shared by neighbours become one wrapping node. A mark that is already open
 *  stays open while it lasts, and of the marks that open together the longest-lasting is outermost (links innermost
 *  on a tie), so `*a **b** c*` is written as it was read. */
export function phrasing(block: PMNode): PhrasingContent[] {
  const root: Parent = { children: [] };
  let stack: { mark: Mark; node: Parent }[] = [];
  const kids: PMNode[] = [];
  block.forEach((c) => kids.push(c));
  const lasts = (mark: Mark, from: number) => {
    let i = from;
    while (i < kids.length && mark.isInSet(kids[i].marks)) i++;
    return i - from;
  };
  kids.forEach((child, index) => {
    const node = leaf(child);
    if (!node) return;
    const marks = child.marks.filter((m) => WRAPPING.has(m.type.name));
    let keep = 0;
    while (keep < stack.length && stack[keep].mark.isInSet(marks)) keep++;
    stack = stack.slice(0, keep);
    const opening = marks.filter((m) => !stack.some((s) => s.mark.eq(m)))
      .map((mark) => ({ mark, length: lasts(mark, index), link: mark.type.name === "link" }))
      .sort((a, b) => b.length - a.length || Number(a.link) - Number(b.link))
      .map((o) => o.mark);
    for (const mark of opening) {
      const wrapper = markNode(mark);
      (stack.length ? stack[stack.length - 1].node : root).children.push(wrapper);
      stack.push({ mark, node: wrapper });
    }
    const into = stack.length ? stack[stack.length - 1].node : root;
    const last = into.children[into.children.length - 1];
    if (node.type === "text" && last?.type === "text") last.value += node.value;
    else into.children.push(node);
  });
  return root.children;
}

const blocksOf = (n: PMNode): BlockContent[] => {
  const out: BlockContent[] = [];
  n.forEach((c) => {
    const b = blockToMdast(c);
    if (b) out.push(b as BlockContent);
  });
  return out;
};

const isEmptyParagraph = (n: PMNode) => n.type.name === "paragraph" && n.childCount === 0;

/** One editor block as mdast; an empty paragraph is nothing. */
export function blockToMdast(n: PMNode): RootContent | null {
  const a = n.attrs;
  switch (n.type.name) {
    case "paragraph": return n.childCount ? { type: "paragraph", children: phrasing(n) } : null;
    case "heading": return { type: "heading", depth: a.level, children: phrasing(n) };
    case "horizontalRule": return { type: "thematicBreak" };
    case "blockquote": return { type: "blockquote", children: blocksOf(n) };
    case "callout": {
      const title = n.child(0);
      const marker: PhrasingContent = { type: "text", value: `${a.marker}${a.sep}` };
      const rest: PMNode[] = [];
      n.forEach((c, _o, i) => { if (i > 0) rest.push(c); });
      const head: PhrasingContent[] = [marker, ...phrasing(title)];
      if (a.joined && rest[0]?.type.name === "paragraph" && rest[0].childCount) {
        head.push({ type: "text", value: "\n" }, ...phrasing(rest.shift()!));
      }
      // Neighbouring text nodes merge, as a parser would read them.
      const children: PhrasingContent[] = [];
      for (const c of head) {
        const last = children[children.length - 1];
        if (c.type === "text" && last?.type === "text") last.value += c.value;
        else children.push(c);
      }
      const body = rest.map(blockToMdast).filter(Boolean) as BlockContent[];
      return { type: "blockquote", children: [{ type: "paragraph", children }, ...body] };
    }
    case "bulletList": case "orderedList": {
      const items: ListItem[] = [];
      n.forEach((item) => items.push({
        type: "listItem", spread: !!item.attrs.spread, checked: item.type.name === "taskItem" ? !!item.attrs.checked : null, children: blocksOf(item),
      }));
      const ordered = n.type.name === "orderedList";
      return { type: "list", ordered, ...(ordered ? { start: a.start ?? 1 } : { start: null }), spread: !!a.spread, children: items };
    }
    case "codeBlock": return { type: "code", lang: a.language ?? null, meta: a.meta ?? null, value: n.textContent };
    case "mathBlock": return { type: "math", value: a.value, closed: a.closed };
    case "table": {
      const rows: TableRow[] = [];
      n.forEach((row) => {
        const cells: TableCell[] = [];
        row.forEach((cell) => cells.push({ type: "tableCell", children: cell.firstChild ? phrasing(cell.firstChild) : [] }));
        rows.push({ type: "tableRow", children: cells });
      });
      const width = rows[0]?.children.length ?? 0;
      const align = Array.from({ length: width }, (_, i) => (a.align as (string | null)[])[i] ?? null) as ("left" | "right" | "center" | null)[];
      return { type: "table", align, children: rows };
    }
    case "footnoteDef": return { type: "footnoteDefinition", identifier: a.identifier, label: a.label ?? undefined, children: blocksOf(n) };
    case "rawBlock": return { type: "raw", value: a.value, original: a.original };
    default: return null;
  }
}

/** Per-block writing choices: a list's own marker, a heading's underline style, a code block's fence. */
function overridesFor(n: PMNode, style: Style): Overrides {
  const a = n.attrs;
  switch (n.type.name) {
    case "bulletList": {
      const bullet = (a.marker ?? style.bullet) as Style["bullet"];
      return { bullet, bulletOther: bullet === "-" ? "*" : "-" };
    }
    case "orderedList": return { bulletOrdered: (a.marker ?? style.bulletOrdered) as Style["bulletOrdered"] };
    case "heading": return { setext: a.level <= 2 && (a.setext || (a.srcId === null && style.setext)) };
    case "codeBlock": return a.fence ? { fence: a.fence[0] as "`" | "~" } : {};
    case "table": {
      let long = false;
      n.descendants((c) => { if (c.isText && c.text!.length > 60) long = true; return !long; });
      return { tablePipeAlign: !long };
    }
    default: return {};
  }
}

/** One block's Markdown, written as plainly as reads back the same. `definitions` are the page's link and footnote
 *  definitions, so references read back as references. */
export function writeBlock(n: PMNode, style: Style, definitions: readonly string[]): string {
  if (n.type.name === "horizontalRule" && n.attrs.markup) return n.attrs.markup;
  if (n.type.name === "rawBlock") return n.attrs.value;
  if ((n.type.name === "bulletList" || n.type.name === "orderedList") && n.childCount > LONG_LIST) {
    const text = writeLongList(n, style, definitions);
    if (text !== null) return text;
  }
  const tree = blockToMdast(n);
  if (!tree) return "";
  const overrides = overridesFor(n, style);
  const plain = stringify([tree], style, true, overrides);
  if (readsAs(plain, tree, definitions)) return plain;
  return stringify([tree], style, false, overrides);
}

/** Lists longer than this are written item by item. */
const LONG_LIST = 32;

/** What one item of a long list was written as, by item: an unchanged item keeps its node, so typing in one item of a
 *  3,000-item list writes that item alone (it took 640 ms a key to write the whole list; UI pass of NS-3B). */
const itemTexts = new WeakMap<PMNode, { style: Style; definitions: readonly string[]; key: string; text: string }>();

/** A long list as its items, each written as a list of one item with the list's marker and its own number, joined
 *  as the list is (a blank line between items of a loose list). Null when the items would not read as one list: the
 *  writer gave one item another marker, as it does for an item that would read as a rule. */
function writeLongList(n: PMNode, style: Style, definitions: readonly string[]): string | null {
  const ordered = n.type.name === "orderedList";
  const start = (n.attrs.start as number | null) ?? 1;
  const overrides = overridesFor(n, style);
  const parts: string[] = [];
  let marker: string | null = null;
  for (let i = 0; i < n.childCount; i++) {
    const item = n.child(i);
    const number = ordered ? (style.incrementListMarker ? start + i : start) : 0;
    const key = `${JSON.stringify(overrides)}|${number}|${n.attrs.spread}`;
    const hit = itemTexts.get(item);
    let text: string;
    if (hit && hit.style === style && hit.definitions === definitions && hit.key === key) text = hit.text;
    else {
      const one = n.type.create({ ...n.attrs, ...(ordered ? { start: number } : {}) }, item);
      const tree = blockToMdast(one)!;
      const plain = stringify([tree], style, true, overrides);
      text = readsAs(plain, tree, definitions) ? plain : stringify([tree], style, false, overrides);
      itemTexts.set(item, { style, definitions, key, text });
    }
    const mark = ordered ? /^\d+([.)])/.exec(text)?.[1] ?? "" : text[0];
    if (marker === null) marker = mark;
    else if (mark !== marker) return null;
    parts.push(text);
  }
  return parts.join(n.attrs.spread ? "\n\n" : "\n");
}

/** Whether `text` parses, on its own with the definitions after it, as exactly `tree`. */
export function readsAs(text: string, tree: Nodes, definitions: readonly string[]): boolean {
  const root = parse(definitions.length ? `${text}\n\n${definitions.join("\n\n")}\n` : text);
  return root.children.length === 1 + definitions.length && sameMarkdown(root.children[0], tree);
}

export { isEmptyParagraph };
