// What "the same Markdown" means for Rich mode (NS-3B): two mdast trees are equal when their canonical forms are.
// The canonical form drops positions, writes inline content as runs of text with a set of marks (the editor cannot
// tell `***a***` nested one way from the other), drops empty paragraphs, pads short table rows, and reads a `raw`
// node as the node it was parsed as.
import type { Nodes, PhrasingContent } from "mdast";

type Canon = unknown;
type Run = { t?: string; a?: Canon; m: string };

const MARK: Record<string, string> = { emphasis: "em", strong: "strong", delete: "del", highlight: "hl" };

function runs(children: readonly PhrasingContent[], marks: string[], out: Run[]): Run[] {
  for (const child of children) {
    const c = child as Nodes & { value?: string; children?: PhrasingContent[] };
    if (c.type === "text") push(out, { t: c.value!, m: key(marks) });
    else if (c.type === "inlineCode") push(out, { t: c.value!, m: key([...marks, "code"]) });
    else if (c.type in MARK) runs(c.children!, [...marks, MARK[c.type]], out);
    else if (c.type === "link") runs(c.children!, [...marks, `link(${c.url}|${c.title ?? ""})`], out);
    else out.push({ a: canon(c), m: key(marks) });
  }
  return out;
}

const key = (marks: string[]) => [...new Set(marks)].sort().join(" ");

function push(out: Run[], run: Run) {
  if (!run.t) return;
  const last = out[out.length - 1];
  if (last && last.t !== undefined && last.m === run.m) last.t += run.t;
  else out.push(run);
}

const PHRASING_PARENTS = new Set(["paragraph", "heading", "tableCell"]);

/** The canonical form of any mdast node. */
export function canon(node: Nodes | null | undefined): Canon {
  if (!node) return null;
  const n = node as Nodes & Record<string, unknown>;
  if (n.type === "raw") return n.original ? canon(n.original as Nodes) : { raw: n.value };
  if (PHRASING_PARENTS.has(n.type)) {
    return { type: n.type, ...(n.type === "heading" ? { depth: n.depth } : {}), runs: runs((n as { children: PhrasingContent[] }).children, [], []) };
  }
  if (n.type === "table") {
    const rows = (n.children as Nodes[]);
    const width = Math.max(0, ...rows.map((r) => (r as { children: unknown[] }).children.length));
    const align = Array.from({ length: width }, (_, i) => (n.align as (string | null)[] | undefined)?.[i] ?? null);
    return {
      type: "table", align,
      rows: rows.map((r) => {
        const cells = ((r as { children: Nodes[] }).children).map(canon);
        while (cells.length < width) cells.push({ type: "tableCell", runs: [] });
        return cells;
      }),
    };
  }
  const out: Record<string, Canon> = {};
  // Keys in a fixed order: parsers and the editor build nodes with their fields in different orders.
  for (const [k, v] of Object.entries(n).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (k === "position" || k === "data" || v === undefined) continue;
    if (k === "children") {
      out.children = (v as Nodes[])
        .filter((c) => !(c.type === "paragraph" && (c as { children: unknown[] }).children.length === 0))
        .map(canon);
    } else out[k] = v;
  }
  // A list's start is meaningful only when it is ordered; `checked` is null on plain items either way.
  if (n.type === "list" && !n.ordered) delete out.start;
  if (n.type === "listItem" && out.checked === undefined) out.checked = null;
  return out;
}

/** Whether two mdast nodes say the same thing. */
export const sameMarkdown = (a: Nodes | null | undefined, b: Nodes | null | undefined) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
