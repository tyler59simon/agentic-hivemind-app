// Writing a Rich document back to its page (NS-3B) so that only edited blocks change. A top-level block gives back its
// original source when it is the first block carrying its `srcId` and is still equal to the block read there; the
// original text between two blocks comes back only between a block and the one that followed it in the page; the
// text before the first block and after the last only around the original first and last blocks (NS-0 review, C5).
// Each of those is kept only while it still reads as the same blocks where it now stands.
import type { Node as PMNode } from "@tiptap/pm/model";
import type { Original } from "./fromMarkdown";
import { parse } from "./markdown";
import { isEmptyParagraph, writeBlock } from "./toMarkdown";

/** What one block was written as, by node: blocks are immutable, so a block typed once is not written again. */
const written = new WeakMap<PMNode, { original: Original; text: string }>();

function blockText(n: PMNode, o: Original): string {
  const hit = written.get(n);
  if (hit && hit.original === o) return hit.text;
  const text = writeBlock(n, o.style, o.definitions);
  written.set(n, { original: o, text });
  return text;
}

/** A block with other attributes, made once per block and attributes so that its written text is remembered too. */
const variants = new WeakMap<PMNode, Map<string, PMNode>>();
function variant(n: PMNode, attrs: Record<string, unknown>): PMNode {
  const key = JSON.stringify(attrs);
  let byAttrs = variants.get(n);
  if (!byAttrs) variants.set(n, (byAttrs = new Map()));
  let out = byAttrs.get(key);
  if (!out) byAttrs.set(key, (out = n.type.create({ ...n.attrs, ...attrs }, n.content, n.marks)));
  return out;
}

/** Answers about where blocks end, by the blocks asked about: typing in one block asks again only about its own
 *  boundaries (Codex review of b0afec0, R2-6). Kept with the blocks, so they go with them. */
const parted = new WeakMap<PMNode, WeakMap<PMNode, Map<string, boolean>>>();
const alone = new WeakMap<PMNode, boolean>();

/** Whether `a`, `gap` and `b` (the texts of blocks `an` and `bn`) read as two blocks. A block's text is its source or
 *  its rewrite, so `how` says which each is. */
function separates(an: PMNode, a: string, gap: string, bn: PMNode, b: string, how: string): boolean {
  let byB = parted.get(an);
  if (!byB) parted.set(an, (byB = new WeakMap()));
  let byGap = byB.get(bn);
  if (!byGap) byB.set(bn, (byGap = new Map()));
  const key = `${how}${gap}`;
  let answer = byGap.get(key);
  if (answer === undefined) {
    const blocks = parse(a + gap + b).children;
    answer = blocks.length === 2 && blocks[0].position!.end.offset === a.length;
    byGap.set(key, answer);
  }
  return answer;
}

/** Whether a block's text ends where it is, rather than running on into what follows (an unclosed fence or `$$`). */
function endsAlone(n: PMNode, text: string): boolean {
  let answer = alone.get(n);
  if (answer === undefined) alone.set(n, (answer = parse(`${text}\n\nx`).children.length === 2));
  return answer;
}

const LIST = new Set(["bulletList", "orderedList"]);
/** Blocks after which an indented block can be read as part of them. */
const TAKES_IN = new Set([...LIST, "rawBlock"]);
const markerOf = (n: PMNode, o: Original) => (n.type.name === "bulletList" ? n.attrs.marker ?? o.style.bullet : n.attrs.marker ?? o.style.bulletOrdered);
const otherMarker = (n: PMNode, marker: string) => (n.type.name === "bulletList" ? (marker === "-" ? "*" : "-") : marker === "." ? ")" : ".");

interface Step { n: PMNode; id: number | null; owns: boolean }

/** The page's Markdown for `doc`. */
export function serialize(doc: PMNode, o: Original): string {
  const blocks: PMNode[] = [];
  doc.forEach((n) => { if (!isEmptyParagraph(n)) blocks.push(n); });
  if (!blocks.length) return o.nodes.length ? "" : o.source;
  const seen = new Set<number>();
  // Who owns which slice, and which original block each emitted block is (null for new blocks and copies).
  const plan: Step[] = blocks.map((n) => {
    const id = typeof n.attrs.srcId === "number" && n.attrs.srcId < o.nodes.length ? (n.attrs.srcId as number) : null;
    const first = id !== null && !seen.has(id);
    if (id !== null) seen.add(id);
    return { n, id: first ? id : null, owns: first && n.eq(o.nodes[id!]) };
  });
  const last = o.nodes.length - 1;
  const source = (p: Step) => o.source.slice(o.slices[p.id!].from, o.slices[p.id!].to);
  const rewrite = (p: Step, attrs?: Record<string, unknown>) => {
    p.owns = false;
    if (attrs) p.n = variant(p.n, attrs);
  };
  // Two lists of the same kind and marker side by side read as one list: one of them takes the other marker, the
  // new one where there is one, so a list that kept its source keeps it (Codex reviews of 2392f6b, R1-3, and
  // b0afec0, R2-P1). The check is on the markers as written, so a marker changed here is checked against the next list.
  const sameList = (a: Step | undefined, b: Step | undefined) => !!a && !!b && LIST.has(a.n.type.name) && a.n.type.name === b.n.type.name && markerOf(a.n, o) === markerOf(b.n, o);
  plan.forEach((p, i) => {
    // Display math that ran to the end of the page is closed once something follows it; a fence that did is written
    // anew, which closes it (R1-4).
    if (i < plan.length - 1) {
      if (p.n.type.name === "mathBlock" && !p.n.attrs.closed) rewrite(p, { closed: true });
      else if (p.owns && p.id === last && !endsAlone(p.n, source(p))) rewrite(p);
    }
    const q = plan[i - 1];
    if (!sameList(q, p)) return;
    const flip = (s: Step) => rewrite(s, { marker: otherMarker(s.n, markerOf(s.n, o)) });
    if (q.id === null && p.id !== null) {
      flip(q);
      if (!sameList(plan[i - 2], q)) return;
      flip(q);
    }
    flip(p);
  });
  let out = "";
  let prev: { step: Step; text: string } | null = null;
  plan.forEach((p, i) => {
    let text = p.owns ? source(p) : blockText(p.n, o);
    if (i === 0 || !prev) out += p.owns && p.id === 0 ? o.gaps[0] : "";
    else {
      const original = p.id !== null && prev.step.id === p.id - 1;
      let gap = original ? o.gaps[p.id!] : "\n\n";
      // The text between two blocks comes back only while it still parts them: a block that changed type may need a
      // blank line where the page had a line break (R1-2), and a list or a source box takes in an indented block
      // written after it (R2-3).
      const check = original
        ? !(p.owns && prev.step.owns) && !/\n[ \t]*\n/.test(gap)
        : TAKES_IN.has(prev.step.n.type.name) || /^[ \t]/.test(text);
      const how = `${prev.step.owns ? 1 : 0}${p.owns ? 1 : 0}`;
      if (check && !separates(prev.step.n, prev.text, gap, p.n, text, how)) {
        gap = "\n\n";
        if (p.owns && !separates(prev.step.n, prev.text, gap, p.n, text, how)) {
          rewrite(p);
          text = blockText(p.n, o);
        }
      }
      out += gap;
    }
    out += text;
    prev = { step: p, text };
  });
  const end = plan[plan.length - 1];
  out += end.id === last ? o.suffix : o.source.endsWith("\n") || !o.source ? "\n" : "";
  return out;
}
