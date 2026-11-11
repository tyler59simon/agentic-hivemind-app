// The architecture canvas: which boxes and arrows a level shows, and where they go. Pure, so it is tested without a DOM.
import { Graph, layout } from "@dagrejs/dagre";
import type { ArchElement, ArchModel } from "../../lib/architecture";

/** The levels the canvas draws itself. (Deployment is shown from the suite's own picture.) */
export type Level = "context" | "containers";
const VIEW_TYPE: Record<Level, string> = { context: "context", containers: "container" };

export interface CanvasNode {
  id: string; name: string; kind: ArchElement["type"]; technology?: string; description?: string;
  external: boolean;
  /** Inside the system boundary the level opens up. */
  inside: boolean;
}
export interface CanvasEdge { id: string; from: string; to: string; label: string }
export interface CanvasGraph { nodes: CanvasNode[]; edges: CanvasEdge[]; boundary: { id: string; name: string } | null }

/** What a level shows. The model's own view decides when it has one; otherwise the level is read off the element types. */
export function canvasGraph(model: ArchModel | null, level: Level): CanvasGraph | null {
  const elements = model?.elements ?? [];
  if (!elements.length) return null;
  const byId = new Map(elements.map((e) => [e.id, e]));
  const view = (model?.views ?? []).find((v) => v.type === VIEW_TYPE[level] && v.element_ids?.length);
  let ids: string[];
  let boundaryId: string | undefined;
  if (view) {
    ids = view.element_ids!;
    boundaryId = view.boundary_id;
  } else if (level === "context") {
    ids = elements.filter((e) => e.type === "person" || e.type === "software_system").map((e) => e.id);
  } else {
    boundaryId = elements.find((e) => e.type === "software_system" && !e.external)?.id;
    ids = elements.filter((e) => e.type === "person" || e.type === "container" || (e.type === "software_system" && e.id !== boundaryId)).map((e) => e.id);
  }
  const boundary = boundaryId ? byId.get(boundaryId) : undefined;
  const shown = [...new Set(ids)].filter((id) => id !== boundaryId && byId.has(id));
  if (!shown.length) return null;
  const nodes = shown.map((id): CanvasNode => {
    const e = byId.get(id)!;
    return { id, name: e.name, kind: e.type, technology: e.technology, description: e.description, external: !!e.external, inside: !!boundary && e.parent_id === boundary.id };
  });

  const has = new Set(shown);
  const between = (model?.relationships ?? []).filter((r) => has.has(r.source_id) && has.has(r.destination_id) && r.source_id !== r.destination_id);
  const wanted = new Set(view?.relationship_ids ?? []);
  const listed = between.filter((r) => wanted.has(r.id));
  // One arrow per direction between two boxes; several relationships share it and its label.
  const edges = new Map<string, CanvasEdge>();
  for (const r of listed.length ? listed : between) {
    const key = `${r.source_id}->${r.destination_id}`;
    const label = r.description ?? "";
    const have = edges.get(key);
    if (!have) edges.set(key, { id: key, from: r.source_id, to: r.destination_id, label });
    else if (label && !have.label.split("; ").includes(label)) have.label = have.label ? `${have.label}; ${label}` : label;
  }
  return { nodes, edges: [...edges.values()], boundary: boundary ? { id: boundary.id, name: boundary.name } : null };
}

export const NODE_SIZE = { width: 116, height: 90 };
const MARGIN = 20;

export interface Box { x: number; y: number; width: number; height: number }
export interface Laid {
  nodes: (CanvasNode & Box)[];
  edges: (CanvasEdge & { points: { x: number; y: number }[] })[];
  boundary: (Box & { name: string }) | null;
  width: number; height: number;
}

/** Left-to-right positions for the boxes, with the boundary drawn around the ones inside it. `x` and `y` are top-left corners. */
export function layoutGraph(graph: CanvasGraph): Laid {
  const g = new Graph({ compound: true });
  g.setGraph({ rankdir: "LR", nodesep: 26, ranksep: 48, marginx: MARGIN, marginy: MARGIN });
  g.setDefaultEdgeLabel(() => ({}));
  const cluster = graph.boundary && graph.nodes.some((n) => n.inside) ? `boundary:${graph.boundary.id}` : null;
  if (cluster) g.setNode(cluster, {});
  for (const n of graph.nodes) {
    g.setNode(n.id, { ...NODE_SIZE });
    if (cluster && n.inside) g.setParent(n.id, cluster);
  }
  for (const e of graph.edges) g.setEdge(e.from, e.to);
  layout(g);
  const box = (id: string): Box => {
    const n = g.node(id);
    return { x: n.x - n.width / 2, y: n.y - n.height / 2, width: n.width, height: n.height };
  };
  const size = g.graph();
  return {
    nodes: graph.nodes.map((n) => ({ ...n, ...box(n.id) })),
    edges: graph.edges.map((e) => ({ ...e, points: g.edge(e.from, e.to).points })),
    boundary: cluster ? { ...box(cluster), name: graph.boundary!.name } : null,
    width: size.width ?? 0, height: size.height ?? 0,
  };
}

/** The zoom that shows the whole drawing in a viewport, never enlarging past 100%. */
export function fitScale(drawing: { width: number; height: number }, viewport: { width: number; height: number }): number {
  if (!drawing.width || !drawing.height || !viewport.width || !viewport.height) return 1;
  return Math.max(0.2, Math.min(1, viewport.width / drawing.width, viewport.height / drawing.height));
}
