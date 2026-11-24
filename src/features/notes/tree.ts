// The notebook tree as data: folders are sections, Markdown files are pages, a folder `X/` beside `X.md` holds the
// subpages of X. Pure, so ordering, nesting and drop rules are tested without a webview.
import { fileName, folderOf, type Entry, type EntryKind, type NotebookMeta } from "../../lib/notebooks";

export interface Node {
  path: string;
  name: string;
  kind: EntryKind;
  /** Sections and pages with subpages. */
  children: Node[];
}

const low = (s: string) => s.toLowerCase();
const PAGE = /\.(md|markdown|hmdoc)$/i;
const RICH = /\.hmdoc$/i;

/** Sort one folder's children: the sidecar's order first, then folders, then by name. */
function sorted(nodes: Node[], order: string[] | undefined): Node[] {
  const rank = new Map((order ?? []).map((name, i) => [low(name), i]));
  return nodes.sort((a, b) => {
    const ra = rank.get(low(a.name)) ?? Infinity, rb = rank.get(low(b.name)) ?? Infinity;
    if (ra !== rb) return ra - rb;
    const fa = a.kind === "dir" ? 0 : 1, fb = b.kind === "dir" ? 0 : 1;
    if (fa !== fb) return fa - fb;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  });
}

export function buildTree(entries: Entry[], meta?: NotebookMeta): Node[] {
  const byFolder = new Map<string, Node[]>();
  const nodes = new Map<string, Node>();
  for (const e of entries) {
    const node: Node = { path: e.path, name: fileName(e.path), kind: e.kind, children: [] };
    nodes.set(low(e.path), node);
    const folder = low(folderOf(e.path));
    byFolder.set(folder, [...(byFolder.get(folder) ?? []), node]);
  }
  const build = (folder: string): Node[] => {
    const here = byFolder.get(low(folder)) ?? [];
    // A folder named like a page holds that page's subpages; when `Plan.md` and `Plan.hmdoc` both exist the folder is the
    // Markdown page's, whatever order they are listed in (R1-15).
    const pages = new Map<string, Node>();
    for (const n of here.filter((x) => x.kind === "page")) {
      const key = low(n.name.replace(PAGE, ""));
      const had = pages.get(key);
      // The later page wins between two of a kind, as it always did; a rich page never takes the folder from a Markdown one.
      if (!had || !(RICH.test(n.name) && !RICH.test(had.name))) pages.set(key, n);
    }
    const out: Node[] = [];
    for (const node of here) {
      if (node.kind === "dir") {
        const owner = pages.get(low(node.name));
        node.children = build(node.path);
        // A folder named like a page beside it holds that page's subpages.
        if (owner) { owner.children.push(...node.children); continue; }
      }
      out.push(node);
    }
    for (const node of out) if (node.kind === "page" && node.children.length) sorted(node.children, meta?.order?.[node.path.replace(PAGE, "")]);
    return sorted(out, meta?.order?.[folder]);
  };
  return build("");
}

/** What a tree row shows: a page without its extension, anything else by its name. */
export const nodeLabel = (node: Node) => (node.kind === "page" ? node.name.replace(PAGE, "") : node.name);

/** A row on screen. `parent` is the path of the row it sits under (null at the top), and `posinset` and `setsize` are its
 *  place among its siblings, from 1, for screen readers (DESK-6). */
export interface Row { node: Node; depth: number; open: boolean; parent: string | null; posinset: number; setsize: number }

/** The rows on screen: every node whose ancestors are all open. */
export function visibleRows(tree: Node[], open: Set<string>): Row[] {
  const rows: Row[] = [];
  const walk = (nodes: Node[], depth: number, parent: string | null) => {
    nodes.forEach((node, i) => {
      const isOpen = open.has(low(node.path));
      rows.push({ node, depth, open: isOpen, parent, posinset: i + 1, setsize: nodes.length });
      if (isOpen && node.children.length) walk(node.children, depth + 1, node.path);
    });
  };
  walk(tree, 0, null);
  return rows;
}

export type TreeMove = { focus: number } | { expand: string } | { collapse: string } | null;

/** What an arrow key, Home or End does on row `at` (WAI-ARIA tree pattern): move up or down, Right opens a closed branch or
 *  goes to its first child, Left closes an open branch or goes to the parent. */
export function treeMove(rows: Row[], at: number, key: string): TreeMove {
  const row = rows[at];
  if (!row) return rows.length ? { focus: 0 } : null;
  const branch = row.node.kind === "dir" || row.node.children.length > 0;
  switch (key) {
    case "ArrowDown": return at + 1 < rows.length ? { focus: at + 1 } : null;
    case "ArrowUp": return at > 0 ? { focus: at - 1 } : null;
    case "Home": return { focus: 0 };
    case "End": return { focus: rows.length - 1 };
    case "ArrowRight":
      if (!branch) return null;
      if (!row.open) return { expand: row.node.path };
      return rows[at + 1]?.parent === row.node.path ? { focus: at + 1 } : null;
    case "ArrowLeft": {
      if (branch && row.open) return { collapse: row.node.path };
      const parent = row.parent === null ? -1 : rows.findIndex((r) => r.node.path === row.parent);
      return parent >= 0 ? { focus: parent } : null;
    }
    default: return null;
  }
}

/** Where a dragged path goes when dropped on `target`: into a section, under a page as a subpage, or null when the
 *  move makes no sense (onto itself, into its own subtree, or where it already is). */
export function dropTarget(dragged: string, target: Node | null): string | null {
  const name = fileName(dragged);
  let folder: string;
  if (!target) folder = "";
  else if (target.kind === "dir") folder = target.path;
  else if (target.kind === "page") folder = target.path.replace(PAGE, "");
  else folder = folderOf(target.path);
  const from = low(dragged), into = low(folder);
  if (into === from || into.startsWith(`${from}/`) || into === `${from.replace(PAGE, "")}`) return null;
  if (into === low(folderOf(dragged))) return null;
  return folder ? `${folder}/${name}` : name;
}

/** The folders a section or page's subpages live in, opened so a revealed page is visible. */
export function ancestors(path: string): string[] {
  const parts = path.split("/");
  const out: string[] = [];
  for (let i = 1; i < parts.length; i++) {
    const folder = parts.slice(0, i).join("/");
    out.push(folder, `${folder}.md`, `${folder}.hmdoc`);
  }
  return out.map(low);
}

const OPEN_KEY = "hivemind.notes.open";

/** Which sections are expanded, per notebook (kept on this device). */
export function loadOpen(notebook: string): Set<string> {
  try {
    const all = JSON.parse(localStorage.getItem(OPEN_KEY) ?? "{}") as Record<string, string[]>;
    return new Set(all[notebook] ?? []);
  } catch {
    return new Set();
  }
}

export function saveOpen(notebook: string, open: Set<string>) {
  try {
    const all = JSON.parse(localStorage.getItem(OPEN_KEY) ?? "{}") as Record<string, string[]>;
    all[notebook] = [...open];
    localStorage.setItem(OPEN_KEY, JSON.stringify(all));
  } catch {
    // Storage is a convenience; the tree works without it.
  }
}
