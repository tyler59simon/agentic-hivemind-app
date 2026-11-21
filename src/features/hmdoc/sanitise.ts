// HTML pasted or dropped into a rich page (NS-3C). Tiptap reads an attribute that has no parse rule from the element's
// attribute of the same name, so `<table align="center">` would give a table an `align` the file format refuses, and the
// page would reopen read-only. The pasted slice is cleaned by the validator's own rules: a value the rules refuse becomes
// the attribute's default, and a text colour that is not in the palette is not a text colour.
import { Fragment, Slice, type Mark, type MarkType, type Node as PMNode, type NodeType } from "@tiptap/pm/model";
import { attrAccepts } from "./rules";

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

function fixNode(node: PMNode): PMNode {
  const marks = fixMarks(node.marks);
  if (node.isText) return marks === node.marks ? node : node.mark(marks);
  const attrs = fix(node.type, node.attrs);
  const content = fixFragment(node.content);
  if (attrs === node.attrs && content === node.content && marks === node.marks) return node;
  return node.type.create(attrs, content, marks);
}

function fixFragment(fragment: Fragment): Fragment {
  const out: PMNode[] = [];
  let changed = false;
  fragment.forEach((n) => {
    const fixed = fixNode(n);
    if (fixed !== n) changed = true;
    out.push(fixed);
  });
  return changed ? Fragment.from(out) : fragment;
}

/** `slice` with no attribute value the file format refuses. */
export function sanitiseSlice(slice: Slice): Slice {
  const content = fixFragment(slice.content);
  return content === slice.content ? slice : new Slice(content, slice.openStart, slice.openEnd);
}
