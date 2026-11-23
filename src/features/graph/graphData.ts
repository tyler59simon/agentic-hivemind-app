// Shapes the unified graph (Living Memory notes + folder notebook pages) for drawing: building cross-links,
// filtering, finding a node's neighbourhood, and laying out with ForceAtlas2.
import Graph from "graphology";
import forceAtlas2 from "graphology-layout-forceatlas2";
import type { FileRef } from "../../documents/keys";
import type { LinkGraph, NoteType, Status } from "../../lib/lm";
import { pageTitle } from "../../lib/notebooks";
import { byType } from "../../lib/note";
import type { IndexGraph, PageKind } from "../../lib/noteindex";
import { buildEnv } from "../links/env";
import { resolveLink, resolveWritten } from "../links/resolve";

export const TYPE_COLORS: Record<NoteType, string> = {
  knowledge: "#94a3b8", decision: "#3b82f6", preference: "#a855f7", context: "#64748b", status: "#14b8a6",
  bug: "#ef4444", plan: "#22c55e", risk: "#f59e0b", research: "#06b6d4", policy: "#eab308", map: "#f97316", runbook: "#ec4899",
  brief: "#6366f1",
};
/** Distinct colour for folder notebook pages (separate from all 13 memory note types). */
export const PAGE_COLOR = "#84cc16";
/** Custom note types share one neutral colour. */
export const typeColor = (type: NoteType) => byType(TYPE_COLORS, type) ?? "#999";

/** Collision-free graph node id for a folder notebook page (NUL cannot appear in ALM domains or file paths). */
export const pageNodeId = (ref: FileRef) => `page\0${ref.notebook}\0${ref.path}`;

export interface UnifiedNoteNode {
  id: string;
  kind: "note";
  ref: string;
  domain: string;
  title: string;
  noteType: NoteType;
  status: Status;
  tags: string[];
}

export interface UnifiedPageNode {
  id: string;
  kind: "page";
  file: FileRef;
  notebookTitle: string;
  pageKind: PageKind;
  title: string;
  tags: string[];
}

export type UnifiedNode = UnifiedNoteNode | UnifiedPageNode;
export interface UnifiedEdge { from: string; to: string; kind: "link" | "supersedes" }
export interface UnifiedGraph { nodes: UnifiedNode[]; edges: UnifiedEdge[] }

export const nodeColor = (node: UnifiedNode) => (node.kind === "page" ? PAGE_COLOR : typeColor(node.noteType));

export interface BuildGraphInput {
  memory?: LinkGraph | null;
  pages?: IndexGraph | null;
  notebooks?: { id: string; title: string }[];
}

/** Combine Living Memory's link graph and the folder notebooks' indexed pages and links into one graph. */
export function buildUnifiedGraph({ memory, pages, notebooks = [] }: BuildGraphInput): UnifiedGraph {
  const nodes: UnifiedNode[] = [];
  const nodeIds = new Set<string>();
  const edges: UnifiedEdge[] = [];
  const seen = new Set<string>();

  const addEdge = (from: string, to: string, kind: "link" | "supersedes") => {
    if (from === to || !nodeIds.has(from) || !nodeIds.has(to)) return;
    const key = `${from}\0${to}\0${kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ from, to, kind });
  };

  const memoryNodes = memory?.nodes ?? [];
  for (const n of memoryNodes) {
    nodes.push({ id: n.ref, kind: "note", ref: n.ref, domain: n.domain, title: n.title, noteType: n.type, status: n.status, tags: n.tags });
    nodeIds.add(n.ref);
  }

  const registered = new Map(notebooks.map((nb) => [nb.id, nb.title]));
  const validPages = (pages?.pages ?? []).filter((p) => registered.has(p.notebook));
  const byTitle = new Map<string, UnifiedPageNode[]>();
  for (const p of validPages) {
    const file: FileRef = { notebook: p.notebook, path: p.path };
    const id = pageNodeId(file);
    const node: UnifiedPageNode = {
      id, kind: "page", file, notebookTitle: registered.get(p.notebook)!, pageKind: p.kind,
      title: p.title || pageTitle(p.path), tags: p.tags,
    };
    nodes.push(node);
    nodeIds.add(id);
    const key = node.title.trim().toLowerCase();
    if (key) {
      const list = byTitle.get(key);
      if (list) list.push(node); else byTitle.set(key, [node]);
    }
  }

  for (const e of memory?.edges ?? []) addEdge(e.from, e.to, e.kind);

  const env = buildEnv(
    notebooks,
    validPages,
    memoryNodes.map((n) => ({ ref: n.ref, title: n.title, domain: n.domain })),
  );

  for (const link of pages?.links ?? []) {
    const from: FileRef = { notebook: link.notebook, path: link.path };
    const fromId = pageNodeId(from);
    if (!nodeIds.has(fromId)) continue;
    const res = resolveWritten({ raw: link.raw, kind: link.kind }, from, env);
    if ("ref" in res) addEdge(fromId, pageNodeId(res.ref), "link");
    else if ("note" in res) addEdge(fromId, res.note.ref, "link");
  }

  if (validPages.length) {
    const pageOnlyEnv = { ...env, memory: [] };
    for (const u of memory?.unresolved ?? []) {
      if (!nodeIds.has(u.from)) continue;
      const hit = resolveLink(u.target, { notebook: "", path: "" }, pageOnlyEnv);
      if ("ref" in hit) {
        addEdge(u.from, pageNodeId(hit.ref), "link");
        continue;
      }
      const titleHits = byTitle.get(u.target.trim().toLowerCase());
      if (titleHits?.length === 1) addEdge(u.from, titleHits[0].id, "link");
    }
  }

  return { nodes, edges };
}

export interface GraphFilter {
  showNotes?: boolean;
  showPages?: boolean;
  projectTag?: string;
  notebook?: string;
  types?: NoteType[];
  tag?: string;
  includeRetired?: boolean;
}

/** Nodes passing the filter, and the edges between them. */
export function filterGraph(g: UnifiedGraph, f: GraphFilter): UnifiedGraph {
  const showNotes = f.showNotes ?? true;
  const showPages = f.showPages ?? true;
  const tag = f.tag?.trim().replace(/^#/, "").toLowerCase() ?? "";
  const typeFiltered = !!f.types?.length;

  const nodes = g.nodes.filter((n) => {
    if (n.kind === "note") {
      return showNotes
        && (!f.projectTag || n.tags.includes(f.projectTag))
        && (!typeFiltered || f.types!.includes(n.noteType))
        && (!tag || n.tags.some((t) => t.toLowerCase() === tag))
        && (f.includeRetired || n.status === "active");
    }
    return showPages
      && !typeFiltered
      && (!f.notebook || n.file.notebook === f.notebook)
      && (!tag || n.tags.some((t) => t.toLowerCase() === tag));
  });
  const keep = new Set(nodes.map((n) => n.id));
  return { nodes, edges: g.edges.filter((e) => keep.has(e.from) && keep.has(e.to)) };
}

/** Nodes within `depth` links of `focus`, in either direction. */
export function neighborhood(g: UnifiedGraph, focus: string, depth: number): UnifiedGraph {
  const near = new Set([focus]);
  let frontier = new Set([focus]);
  for (let d = 0; d < depth && frontier.size; d++) {
    const next = new Set<string>();
    for (const e of g.edges) {
      if (frontier.has(e.from) && !near.has(e.to)) { near.add(e.to); next.add(e.to); }
      if (frontier.has(e.to) && !near.has(e.from)) { near.add(e.from); next.add(e.from); }
    }
    frontier = next;
  }
  return {
    nodes: g.nodes.filter((n) => near.has(n.id)),
    edges: g.edges.filter((e) => near.has(e.from) && near.has(e.to)),
  };
}

/** A stable pseudo-random start position, so layouts look the same between refreshes. */
function seed(text: string): number {
  let h = 2166136261;
  for (const ch of text) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return ((h >>> 0) % 10000) / 10000;
}

/** A graphology graph with sizes by degree and a force-directed layout. */
export function toGraphology(g: UnifiedGraph): Graph {
  const graph = new Graph({ multi: false, type: "directed" });
  for (const n of g.nodes) {
    const a = seed(n.id) * Math.PI * 2, r = 10 + seed(n.id + "r") * 90;
    graph.addNode(n.id, {
      label: n.title, x: Math.cos(a) * r, y: Math.sin(a) * r, size: 5,
      color: nodeColor(n), kind: n.kind, status: n.kind === "note" ? n.status : "active",
    });
  }
  for (const e of g.edges) {
    if (graph.hasNode(e.from) && graph.hasNode(e.to) && !graph.hasEdge(e.from, e.to)) graph.addEdge(e.from, e.to, { kind: e.kind });
  }
  graph.forEachNode((node) => graph.setNodeAttribute(node, "size", 5 + Math.min(12, Math.sqrt(graph.degree(node)) * 3)));
  if (graph.order > 1) {
    forceAtlas2.assign(graph, {
      iterations: graph.order > 1000 ? 60 : 150,
      settings: { ...forceAtlas2.inferSettings(graph), barnesHutOptimize: graph.order > 400 },
    });
  }
  return graph;
}
