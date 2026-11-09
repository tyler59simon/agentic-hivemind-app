import { describe, expect, it } from "vitest";
import type { LinkGraph } from "../../lib/lm";
import { filterGraph, neighborhood, toGraphology } from "./graphData";

const node = (ref: string, extra: Partial<LinkGraph["nodes"][0]> = {}) =>
  ({ ref, id: ref.split(":")[1], domain: ref.split(":")[0], title: ref, type: "knowledge", status: "active", tags: [], ...extra }) as LinkGraph["nodes"][0];

const g: LinkGraph = {
  domains: ["d", "e"],
  nodes: [node("d:a"), node("d:b", { type: "bug", tags: ["concern/bug"] }), node("d:c", { status: "archived" }), node("e:x"), node("d:lone")],
  edges: [{ from: "d:a", to: "d:b", kind: "link" }, { from: "d:b", to: "d:c", kind: "supersedes" }, { from: "e:x", to: "d:a", kind: "link" }],
  unresolved: [{ from: "d:a", target: "Nowhere" }],
};

describe("graph data", () => {
  it("filters by domain, type, tag and status, keeping only edges between kept notes", () => {
    const active = filterGraph(g, {});
    expect(active.nodes.map((n) => n.ref)).toEqual(["d:a", "d:b", "e:x", "d:lone"]);
    expect(active.edges).toHaveLength(2);
    expect(filterGraph(g, { includeRetired: true }).edges).toHaveLength(3);
    expect(filterGraph(g, { domain: "d" }).edges).toEqual([{ from: "d:a", to: "d:b", kind: "link" }]);
    expect(filterGraph(g, { types: ["bug"] }).nodes.map((n) => n.ref)).toEqual(["d:b"]);
    expect(filterGraph(g, { tag: "concern/bug" }).nodes.map((n) => n.ref)).toEqual(["d:b"]);
  });

  it("finds a neighbourhood in both directions", () => {
    expect(neighborhood(g, "d:a", 1).nodes.map((n) => n.ref).sort()).toEqual(["d:a", "d:b", "e:x"]);
    expect(neighborhood(g, "d:a", 2).nodes.map((n) => n.ref).sort()).toEqual(["d:a", "d:b", "d:c", "e:x"]);
    expect(neighborhood(g, "d:lone", 2).nodes.map((n) => n.ref)).toEqual(["d:lone"]);
  });

  it("builds a laid-out graphology graph sized by degree", () => {
    const graph = toGraphology(g);
    expect(graph.order).toBe(5);
    expect(graph.size).toBe(3);
    expect(graph.getNodeAttribute("d:b", "size")).toBeGreaterThan(graph.getNodeAttribute("d:lone", "size"));
    const { x, y } = graph.getNodeAttributes("d:a");
    expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true);
  });
});
