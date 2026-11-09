// Shapes the `links` graph for drawing: filters, a note's neighbourhood, colours by type.
import Graph from "graphology";
import forceAtlas2 from "graphology-layout-forceatlas2";
import type { LinkGraph, NoteType } from "../../lib/lm";

export const TYPE_COLORS: Record<NoteType, string> = {
  knowledge: "#94a3b8", decision: "#3b82f6", preference: "#a855f7", context: "#64748b", status: "#14b8a6",
  bug: "#ef4444", plan: "#22c55e", risk: "#f59e0b", research: "#06b6d4", policy: "#eab308", map: "#f97316", runbook: "#ec4899",
};

export interface GraphFilter { domain?: string; types?: NoteType[]; tag?: string; includeRetired?: boolean }

/** Nodes passing the filter, and the edges between them. */
export function filterGraph(g: LinkGraph, f: GraphFilter): LinkGraph {
  const nodes = g.nodes.filter((n) =>
    (!f.domain || n.domain === f.domain) &&
    (!f.types?.length || f.types.includes(n.type)) &&
    (!f.tag || n.tags.includes(f.tag)) &&
    (f.includeRetired || n.status === "active"));
  const keep = new Set(nodes.map((n) => n.ref));
  return { ...g, nodes, edges: g.edges.filter((e) => keep.has(e.from) && keep.has(e.to)), unresolved: g.unresolved.filter((u) => keep.has(u.from)) };
}

/** Notes within `depth` links of `focus`, in either direction. */
export function neighborhood(g: LinkGraph, focus: string, depth: number): LinkGraph {
  const near = new Set([focus]);
  let frontier = [focus];
  for (let d = 0; d < depth; d++) {
    const next: string[] = [];
    for (const e of g.edges) {
      for (const [a, b] of [[e.from, e.to], [e.to, e.from]]) {
        if (frontier.includes(a) && !near.has(b)) { near.add(b); next.push(b); }
      }
    }
    frontier = next;
  }
  return { ...g, nodes: g.nodes.filter((n) => near.has(n.ref)), edges: g.edges.filter((e) => near.has(e.from) && near.has(e.to)), unresolved: [] };
}

/** A stable pseudo-random start position, so layouts look the same between refreshes. */
function seed(text: string): number {
  let h = 2166136261;
  for (const ch of text) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return ((h >>> 0) % 10000) / 10000;
}

/** A graphology graph with sizes by degree and a force-directed layout. */
export function toGraphology(g: LinkGraph): Graph {
  const graph = new Graph({ multi: false, type: "directed" });
  for (const n of g.nodes) {
    const a = seed(n.ref) * Math.PI * 2, r = 10 + seed(n.ref + "r") * 90;
    graph.addNode(n.ref, { label: n.title, x: Math.cos(a) * r, y: Math.sin(a) * r, size: 5, color: TYPE_COLORS[n.type] ?? "#999", type_: n.type, status: n.status });
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
