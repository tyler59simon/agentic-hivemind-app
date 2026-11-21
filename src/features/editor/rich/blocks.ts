// The block half of the rich page editor (NS-3A): tables, Mermaid fences, `$$` math, callouts, and paragraphs that are
// only a picture or an `![[embed]]`. CodeMirror takes block widgets and replacements that cross lines only from a state
// field, so these live here; inline marks are in `inline.ts`. Only top-level blocks render; a block holding the cursor
// or a selection shows its source.
//
// The field keeps the page's top-level blocks. An edit redraws only the blocks around it: it rescans the syntax tree
// from the edit until a block matches the old list again (an opened fence can swallow the blocks after it), and a
// cursor move redraws only the blocks it entered or left. A new syntax tree without an edit, a new configuration and a
// refresh redraw everything.
import { syntaxTree } from "@codemirror/language";
import { MapMode, StateField, type ChangeDesc, type EditorState, type Range, type Transaction } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet, type WidgetType } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { currentTheme } from "../../../lib/theme";
import { richContext, richRefresh, type RichContext } from "./context";
import { parseCallout, parseEmbed } from "./parse";
import { CalloutTitleWidget, EmbedWidget, MathWidget, MermaidWidget, PictureWidget, TableWidget, toggleCallout } from "./widgets";

/** A paragraph longer than this is never a lone picture or embed, so it is not sliced to check. */
const LONE_MAX = 4096;
/** The top-level blocks that can draw something. */
const KINDS = new Set(["Table", "FencedCode", "BlockMath", "Blockquote", "Paragraph"]);

/** A top-level block and its whole lines. */
interface Block { name: string; from: number; to: number }

interface Blocks {
  deco: DecorationSet;
  /** Every top-level block of the page, in order. */
  blocks: readonly Block[];
  /** Starts of callouts whose fold the user flipped. */
  toggled: readonly number[];
  /** Bumped by `richRefresh`, so embeds read their page again. */
  stamp: number;
  /** The drawable blocks the selection is in: they show their source. */
  active: readonly Block[];
}

/** The top-level blocks from the first one ending at or after `from`, until `until` says to stop. */
function scan(state: EditorState, from: number, until: (b: Block) => boolean): { node: SyntaxNode; block: Block }[] {
  const out: { node: SyntaxNode; block: Block }[] = [];
  const top = syntaxTree(state).topNode;
  for (let node = from > 0 ? top.childAfter(from - 1) : top.firstChild; node; node = node.nextSibling) {
    const block = { name: node.name, from: state.doc.lineAt(node.from).from, to: state.doc.lineAt(node.to).to };
    if (until(block)) break;
    out.push({ node, block });
  }
  return out;
}

/** The index of the first block ending at or after `pos`. */
function firstEnding(blocks: readonly Block[], pos: number): number {
  let lo = 0, hi = blocks.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (blocks[mid].to < pos) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The drawable blocks the selection is in. */
function activeBlocks(state: EditorState, blocks: readonly Block[]): Block[] {
  const out: Block[] = [];
  for (const r of state.selection.ranges) {
    for (let i = firstEnding(blocks, r.from); i < blocks.length && blocks[i].from <= r.to; i++) {
      if (KINDS.has(blocks[i].name) && !out.includes(blocks[i])) out.push(blocks[i]);
    }
  }
  return out;
}

const sameBlocks = (a: readonly Block[], b: readonly Block[]) =>
  a.length === b.length && a.every((x, i) => x.from === b[i].from && x.to === b[i].to && x.name === b[i].name);

const replaceBlock = (widget: WidgetType) => Decoration.replace({ widget, block: true });
const hide = Decoration.replace({});

function callout(state: EditorState, from: number, to: number, active: boolean, toggled: readonly number[], out: Range<Decoration>[]) {
  const first = state.doc.lineAt(from);
  const c = parseCallout(first.text);
  if (!c) return;
  const last = state.doc.lineAt(to);
  const open = c.fold ? (c.fold === "+") !== toggled.includes(first.from) : true;
  for (let n = first.number; n <= last.number; n++) {
    const line = state.doc.line(n);
    const cls = `cm-callout cm-callout-${c.type}${n === first.number ? " cm-callout-first" : ""}${n === last.number || (!open && !active) ? " cm-callout-last" : ""}`;
    out.push(Decoration.line({ class: cls }).range(line.from));
  }
  if (active) return;
  out.push(Decoration.replace({ widget: new CalloutTitleWidget(c, open) }).range(first.from, first.to));
  if (!open) {
    if (last.number > first.number) out.push(hide.range(first.to, last.to));
    return;
  }
  for (let n = first.number + 1; n <= last.number; n++) {
    const line = state.doc.line(n);
    const mark = /^ {0,3}> ?/.exec(line.text);
    if (mark) out.push(hide.range(line.from, line.from + mark[0].length));
  }
}

interface Draw { state: EditorState; ctx: RichContext | null; dark: boolean; toggled: readonly number[]; stamp: number }

/** The decorations of one top-level block. */
function draw(d: Draw, node: SyntaxNode, { from, to }: Block, out: Range<Decoration>[]) {
  const { state, ctx } = d;
  const active = state.selection.ranges.some((r) => r.from <= to && r.to >= from);
  switch (node.name) {
    case "Table":
      if (!active) out.push(replaceBlock(new TableWidget(state.sliceDoc(from, to), state.readOnly)).range(from, to));
      return;
    case "FencedCode": {
      const info = node.getChild("CodeInfo");
      const lang = info ? state.sliceDoc(info.from, info.to).trim().toLowerCase() : "";
      if (lang === "mermaid" && !active) {
        const text = node.getChild("CodeText");
        out.push(replaceBlock(new MermaidWidget(text ? state.sliceDoc(text.from, text.to) : "", d.dark)).range(from, to));
        return;
      }
      const firstLine = state.doc.lineAt(from).number, lastLine = state.doc.lineAt(to).number;
      for (let n = firstLine; n <= lastLine; n++) {
        const cls = `cm-rich-fence${n === firstLine ? " cm-rich-fence-first" : ""}${n === lastLine ? " cm-rich-fence-last" : ""}`;
        out.push(Decoration.line({ class: cls, attributes: n === firstLine && lang ? { "data-lang": lang } : {} }).range(state.doc.line(n).from));
      }
      return;
    }
    case "BlockMath":
      if (!active) {
        const marks = node.getChildren("BlockMathMark");
        const inner = marks.length === 2 ? state.sliceDoc(marks[0].to, marks[1].from) : state.sliceDoc(node.from + 2, node.to);
        out.push(replaceBlock(new MathWidget(inner.trim(), true)).range(from, to));
      }
      return;
    case "Blockquote":
      callout(state, from, to, active, d.toggled, out);
      return;
    case "Paragraph": {
      if (active || !ctx || to - from > LONE_MAX || state.sliceDoc(node.from, node.from + 2) !== "![") return;
      const source = state.sliceDoc(from, to);
      const embed = parseEmbed(source);
      if (!embed) return;
      out.push(replaceBlock(embed.kind === "picture"
        ? new PictureWidget(source, ctx.pictureUrl(embed.src, embed.wiki), embed.alt, embed.width, true)
        : new EmbedWidget(embed.target, embed.heading, ctx, d.stamp)).range(from, to));
    }
  }
}

const drawing = (state: EditorState, toggled: readonly number[], stamp: number): Draw =>
  ({ state, ctx: state.facet(richContext), dark: currentTheme() !== "emerald-light", toggled, stamp });

/** Every block decoration of the page. */
function full(state: EditorState, toggled: readonly number[], stamp: number): Blocks {
  const d = drawing(state, toggled, stamp);
  const out: Range<Decoration>[] = [];
  const found = scan(state, 0, () => false);
  for (const { node, block } of found) if (KINDS.has(node.name)) draw(d, node, block, out);
  const blocks = found.map((f) => f.block);
  return { deco: Decoration.set(out, true), blocks, toggled, stamp, active: activeBlocks(state, blocks) };
}

/** Redraw the blocks in the ranges `dirty` (positions in the new page); `blocks` and `deco` are already mapped to it. */
function redraw(d: Draw, blocks: readonly Block[], deco: DecorationSet, dirty: [number, number][]): { blocks: readonly Block[]; deco: DecorationSet } {
  // Merged, then done from the last range back, so the indexes of earlier ranges stay valid.
  dirty.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const r of dirty) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  let list = blocks;
  const add: Range<Decoration>[] = [];
  const cleared: [number, number][] = [];
  for (const [lo, hi] of merged.reverse()) {
    const i0 = firstEnding(list, lo);
    const start = Math.min(lo, list[i0]?.from ?? lo);
    let j = i0;
    // Rescan until a block past the range is one the page already had, at the same place.
    const fresh = scan(d.state, start, (b) => {
      if (b.from <= hi) return false;
      while (j < list.length && list[j].from < b.from) j++;
      const old = list[j];
      return !!old && old.from === b.from && old.to === b.to && old.name === b.name;
    });
    const end = Math.max(hi, fresh.length ? fresh[fresh.length - 1].block.to : hi);
    let k = i0;
    while (k < list.length && list[k].from <= end) k++;
    // An old block may reach past the rescanned ones (into lines that are blank now): its marks go too.
    const clearTo = Math.max(end, k > i0 ? list[k - 1].to : end);
    for (const { node, block } of fresh) if (KINDS.has(node.name)) draw(d, node, block, add);
    list = [...list.slice(0, i0), ...fresh.map((f) => f.block), ...list.slice(k)];
    cleared.push([Math.min(start, fresh[0]?.block.from ?? start), clearTo]);
  }
  for (const [from, to] of cleared) deco = deco.update({ filterFrom: from, filterTo: to, filter: (f) => f < from || f > to });
  return { blocks: list, deco: deco.update({ add, sort: true }) };
}

const mapBlock = (b: Block, changes: ChangeDesc): Block => ({ name: b.name, from: changes.mapPos(b.from, 1), to: Math.max(changes.mapPos(b.from, 1), changes.mapPos(b.to, -1)) });

function update(value: Blocks, tr: Transaction): Blocks {
  let { toggled, stamp } = value;
  let everything = tr.reconfigured || (!tr.docChanged && syntaxTree(tr.startState) !== syntaxTree(tr.state));
  const dirty: [number, number][] = [];
  if (tr.docChanged && toggled.length) {
    toggled = toggled.map((p) => tr.changes.mapPos(p, 1, MapMode.TrackDel)).filter((p): p is number => p !== null);
  }
  for (const e of tr.effects) {
    if (e.is(toggleCallout)) {
      toggled = toggled.includes(e.value) ? toggled.filter((p) => p !== e.value) : [...toggled, e.value];
      dirty.push([e.value, e.value]);
    } else if (e.is(richRefresh)) { stamp++; everything = true; }
  }
  if (everything) return full(tr.state, toggled, stamp);
  if (!tr.docChanged && !dirty.length) {
    if (!tr.selection) return value;
    const active = activeBlocks(tr.state, value.blocks);
    if (sameBlocks(active, value.active)) return value;
  }
  const blocks = tr.docChanged ? value.blocks.map((b) => mapBlock(b, tr.changes)) : value.blocks;
  const deco = tr.docChanged ? value.deco.map(tr.changes) : value.deco;
  if (tr.docChanged) tr.changes.iterChangedRanges((_fa, _ta, from, to) => { dirty.push([from, to]); });
  // Blocks the cursor left show their widgets again; blocks it entered show their source.
  for (const b of value.active) {
    const m = tr.docChanged ? mapBlock(b, tr.changes) : b;
    dirty.push([m.from, m.to]);
  }
  for (const r of tr.state.selection.ranges) dirty.push([r.from, r.to]);
  const done = redraw(drawing(tr.state, toggled, stamp), blocks, deco, dirty);
  return { ...done, toggled, stamp, active: activeBlocks(tr.state, done.blocks) };
}

export const richBlocks = StateField.define<Blocks>({
  create: (state) => full(state, [], 0),
  update,
  provide: (field) => EditorView.decorations.from(field, (v) => v.deco),
});

/** Every block decoration of the page drawn from scratch, for tests. */
export const buildBlocks = (state: EditorState, toggled: readonly number[] = [], stamp = 0) => full(state, toggled, stamp).deco;

/** The ranges the block field replaced, so the inline half leaves them alone. */
export function replacedBlocks(state: EditorState): DecorationSet {
  return state.field(richBlocks, false)?.deco ?? Decoration.none;
}
