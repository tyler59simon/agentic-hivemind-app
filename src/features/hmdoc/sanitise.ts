// HTML pasted or dropped into a rich page (NS-3C). Tiptap reads an attribute that has no parse rule from the element's
// attribute of the same name, so `<table align="center">` would give a table an `align` the file format refuses, and the
// page would reopen read-only. The pasted slice is cleaned by the validator's own rules: a value the rules refuse becomes
// the attribute's default, and a text colour that is not in the palette is not a text colour. An embed (NS-3D) has no
// default that is a real value (an empty path names nothing, and page 1 is not the page that was asked for), so a pasted
// embed with an attribute the rules refuse is left out, as is a free-positioned block pasted inside a frame.
import { Fragment, Slice, type Mark, type MarkType, type Node as PMNode, type NodeType } from "@tiptap/pm/model";
import { isEmbed } from "./blocks/embeds";
import { attrAccepts, nodeProblem } from "./rules";

/** `attrs` with every value the rules refuse replaced by its default; the same object when none was. */
function fix(type: NodeType | MarkType, attrs: Record<string, unknown>): Record<string, unknown> {
  const known = (type.spec.attrs ?? {}) as Record<string, { default?: unknown }>;
  let out = attrs;
  for (const key of Object.keys(attrs)) {
    if (attrAccepts(type.name, key, attrs[key])) continue;
    if (out === attrs) out = { ...attrs };
    out[key] = known[key]?.default ?? null;
  }
  return out;
}

function fixMarks(marks: readonly Mark[]): readonly Mark[] {
  let changed = false;
  const out: Mark[] = [];
  for (const m of marks) {
    const attrs = fix(m.type, m.attrs);
    if (attrs === m.attrs) { out.push(m); continue; }
    changed = true;
    if (m.type.name !== "textColor") out.push(m.type.create(attrs));
  }
  return changed ? out : marks;
}

/** Set when a node was left out: the slice's open depths may then not fit what is left. */
let dropped = false;

function fixNode(node: PMNode, inFrame: boolean): PMNode | null {
  const marks = fixMarks(node.marks);
  if (node.isText) return marks === node.marks ? node : node.mark(marks);
  const name = node.type.name;
  if (name === "freeform" && inFrame) { dropped = true; return null; }
  const attrs = fix(node.type, node.attrs);
  // An embed with a value the rules refuse is left out, not given the default: page 1 of a PDF is not the page that was
  // asked for, and an empty path names nothing.
  if ((isEmbed(name) && attrs !== node.attrs) || nodeProblem(name, attrs)) { dropped = true; return null; }
  const content = fixFragment(node.content, inFrame || name === "frame");
  if (attrs === node.attrs && content === node.content && marks === node.marks) return node;
  if (content === node.content) return node.type.create(attrs, content, marks);
  // Something inside was left out: a column or frame left empty gets a paragraph, and one that cannot be filled goes too.
  const made = node.type.createAndFill(attrs, content, marks);
  if (!made) dropped = true;
  return made;
}

function fixFragment(fragment: Fragment, inFrame: boolean): Fragment {
  const out: PMNode[] = [];
  let changed = false;
  fragment.forEach((n) => {
    const fixed = fixNode(n, inFrame);
    if (fixed !== n) changed = true;
    if (fixed) out.push(fixed);
  });
  return changed ? Fragment.from(out) : fragment;
}

/** How many levels deep the first (or last) node of `fragment` can be open: down to its first or last child while it has one. */
function depthOf(fragment: Fragment, last: boolean): number {
  let depth = 0;
  let node = last ? fragment.lastChild : fragment.firstChild;
  while (node && !node.isLeaf && node.childCount) { depth++; node = last ? node.lastChild : node.firstChild; }
  return depth;
}

/** `slice` with no attribute value the file format refuses. */
export function sanitiseSlice(slice: Slice): Slice {
  dropped = false;
  const content = fixFragment(slice.content, false);
  if (content === slice.content) return slice;
  if (!dropped) return new Slice(content, slice.openStart, slice.openEnd);
  return new Slice(content, Math.min(slice.openStart, depthOf(content, false)), Math.min(slice.openEnd, depthOf(content, true)));
}
