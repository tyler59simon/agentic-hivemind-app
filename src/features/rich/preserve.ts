// Writing a Rich document back to its page (NS-3B) so that only edited blocks change. A top-level block gives back its
// original source when it is the first block carrying its `srcId` and is still equal to the block read there; the
// original text between two blocks comes back only between a block and the one that followed it in the page; the
// text before the first block and after the last only around the original first and last blocks (NS-0 review, C5).
import type { Node as PMNode } from "@tiptap/pm/model";
import type { Original } from "./fromMarkdown";
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

/** The page's Markdown for `doc`. */
export function serialize(doc: PMNode, o: Original): string {
  const blocks: PMNode[] = [];
  doc.forEach((n) => { if (!isEmptyParagraph(n)) blocks.push(n); });
  if (!blocks.length) return o.nodes.length ? "" : o.source;
  const seen = new Set<number>();
  // Who owns which slice, and which original block each emitted block is (null for new blocks and copies).
  const plan = blocks.map((n) => {
    const id = typeof n.attrs.srcId === "number" && n.attrs.srcId < o.nodes.length ? (n.attrs.srcId as number) : null;
    const first = id !== null && !seen.has(id);
    if (id !== null) seen.add(id);
    const owns = first && n.eq(o.nodes[id!]);
    return { n, id: first ? id : null, owns };
  });
  // Two lists of the same kind and marker written next to each other would read as one list: a new list takes the
  // other marker.
  for (let i = 0; i < plan.length; i++) {
    const p = plan[i];
    if (p.owns || !LIST.has(p.n.type.name)) continue;
    const marker = markerOf(p.n, o);
    const clash = [plan[i - 1], plan[i + 1]].some((q) => q && q.n.type.name === p.n.type.name && markerOf(q.n, o) === marker && !(q.id !== null && p.id !== null && Math.abs(q.id - p.id) === 1));
    if (clash) p.n = p.n.type.create({ ...p.n.attrs, marker: otherMarker(p.n, marker) }, p.n.content, p.n.marks);
  }
  let out = "";
  let prev: number | null = null;
  plan.forEach((p, i) => {
    const text = p.owns ? o.source.slice(o.slices[p.id!].from, o.slices[p.id!].to) : blockText(p.n, o);
    if (i === 0) out += p.owns && p.id === 0 ? o.gaps[0] : "";
    else out += p.id !== null && prev === p.id - 1 ? o.gaps[p.id] : "\n\n";
    out += text;
    prev = p.id;
  });
  const last = plan[plan.length - 1];
  out += last.id === o.nodes.length - 1 ? o.suffix : o.source.endsWith("\n") || !o.source ? "\n" : "";
  return out;
}
