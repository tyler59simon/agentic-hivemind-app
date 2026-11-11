// Pure shaping of an Architecture Suite model for drawing.
import type { ArchElement, ArchModel } from "../../lib/architecture";

/** The system's own containers (or, when the model has none, its software systems), in model order. */
export function ownContainers(model: ArchModel | null): ArchElement[] {
  const elements = model?.elements ?? [];
  const containers = elements.filter((e) => e.type === "container" && !e.external);
  return containers.length ? containers : elements.filter((e) => e.type === "software_system" && !e.external);
}

/** A few containers in the order data flows through them, for a one-line diagram.
 *  `linked[i]` says whether the model has a relationship from `nodes[i]` to `nodes[i + 1]`. */
export function chain(model: ArchModel | null, max = 3): { nodes: ArchElement[]; linked: boolean[] } {
  const all = ownContainers(model);
  const ids = new Set(all.map((e) => e.id));
  const edges = (model?.relationships ?? []).filter((r) => ids.has(r.source_id) && ids.has(r.destination_id) && r.source_id !== r.destination_id);
  const flows = (from: string, to: string) => edges.some((r) => r.source_id === from && r.destination_id === to);
  const left = [...all];
  const nodes: ArchElement[] = [];
  while (left.length && nodes.length < max) {
    const last = nodes[nodes.length - 1];
    // Follow the flow from the last box; otherwise start where nothing remaining flows in.
    const next = (last && left.find((e) => flows(last.id, e.id)))
      ?? left.find((e) => !left.some((o) => o !== e && flows(o.id, e.id)))
      ?? left[0];
    nodes.push(next);
    left.splice(left.indexOf(next), 1);
  }
  return { nodes, linked: nodes.slice(1).map((n, i) => flows(nodes[i].id, n.id)) };
}
