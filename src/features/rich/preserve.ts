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

const LIST = new Set(["bulletList", "orderedList"]);
const markerOf = (n: PMNode, o: Original) => (n.type.name === "bulletList" ? n.attrs.marker ?? o.style.bullet : n.attrs.marker ?? o.style.bulletOrdered);
const otherMarker = (n: PMNode, marker: string) => (n.type.name === "bulletList" ? (marker === "-" ? "*" : "-") : marker === "." ? ")" : ".");

/** Answers of the checks below, by their text: typing in one block asks the same questions about its neighbours. */
const answers = new Map<string, boolean>();
function remember(key: string, ask: () => boolean): boolean {
  const hit = answers.get(key);
  if (hit !== undefined) return hit;
  if (answers.size > 256) answers.clear();
  const answer = ask();
  answers.set(key, answer);
  return answer;
}

/** Whether `a`, `gap` and `b` read as the two blocks `a` and `b`. */
const separates = (a: string, gap: string, b: string) => remember(`s\u0000${a}\u0000${gap}\u0000${b}`, () => {
  const blocks = parse(a + gap + b).children;
  return blocks.length === 2 && blocks[0].position!.end.offset === a.length;
});

/** Whether a block's text ends where it is, rather than running on into what follows (an unclosed fence or `$$`). */
const endsAlone = (text: string) => remember(`e\u0000${text}`, () => parse(`${text}\n\nx`).children.length === 2);

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
  const rewrite = (p: Step, attrs: Record<string, unknown> = {}) => {
    p.owns = false;
    if (Object.keys(attrs).length) p.n = p.n.type.create({ ...p.n.attrs, ...attrs }, p.n.content, p.n.marks);
  };
  plan.forEach((p, i) => {
    // Display math that ran to the end of the page is closed once something follows it; a fence that did is written
    // anew, which closes it (Codex review of 2392f6b, R1-4).
    if (i < plan.length - 1) {
      if (p.n.type.name === "mathBlock" && !p.n.attrs.closed) rewrite(p, { closed: true });
      else if (p.owns && p.id === last && !endsAlone(source(p))) rewrite(p);
    }
    // Two lists of the same kind and marker side by side read as one list, unless they were neighbours in the page
    // (then they already differed): the later one takes the other marker (R1-3).
    const q = plan[i - 1];
    if (q && LIST.has(p.n.type.name) && q.n.type.name === p.n.type.name && markerOf(q.n, o) === markerOf(p.n, o)
      && !(q.id !== null && p.id !== null && p.id === q.id + 1)) {
      rewrite(p, { marker: otherMarker(p.n, markerOf(p.n, o)) });
    }
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
      // blank line where the page had a line break (R1-2), and a list takes in an indented block written after it.
      const check = original ? !(p.owns && prev.step.owns) && !/\n[ \t]*\n/.test(gap) : LIST.has(prev.step.n.type.name);
      if (check && !separates(prev.text, gap, text)) {
        gap = "\n\n";
        if (p.owns && !separates(prev.text, gap, text)) {
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
