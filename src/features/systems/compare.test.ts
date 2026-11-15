import { describe, expect, it } from "vitest";
import type { ArchElement, ArchModel, ArchRelationship } from "../../lib/architecture";
import { canvasGraph } from "./canvas";
import { changeCount, diffModels, edgeKey } from "./compare";

const el = (id: string, over: Partial<ArchElement> = {}): ArchElement => ({ id, name: id.toUpperCase(), type: "container", ...over });
const rel = (id: string, source_id: string, destination_id: string, over: Partial<ArchRelationship> = {}): ArchRelationship => ({ id, source_id, destination_id, ...over });

describe("model comparison", () => {
  it("finds added, removed and changed elements", () => {
    const base: ArchModel = { elements: [el("a"), el("b", { technology: "Go" }), el("c")] };
    const head: ArchModel = { elements: [el("a"), el("b", { technology: "Rust" }), el("d")] };
    expect(diffModels(base, head)).toMatchObject({ added: ["d"], changed: ["b"], removed: [{ id: "c", name: "C" }] });
  });

  it("treats a missing field and an empty one alike", () => {
    const base: ArchModel = { elements: [el("a", { description: undefined, external: undefined })] };
    const head: ArchModel = { elements: [el("a", { description: "", external: false })] };
    expect(changeCount(diffModels(base, head))).toBe(0);
  });

  it("compares relationships by their ends", () => {
    const people = [el("a"), el("b"), el("c"), el("d")];
    const base: ArchModel = { elements: people, relationships: [rel("r1", "a", "b", { description: "x" }), rel("r2", "a", "c"), rel("r3", "c", "d", { description: "one" }),
      rel("r4", "b", "d", { description: "p" }), rel("r5", "b", "d", { description: "q" })] };
    const head: ArchModel = { elements: people, relationships: [rel("r7", "a", "b", { description: "x" }), rel("r8", "d", "a"), rel("r9", "c", "d", { description: "two" }),
      rel("r11", "b", "d", { description: "q" }), rel("r10", "b", "d", { description: "p" })] };
    const diff = diffModels(base, head);
    expect(diff.addedEdges).toEqual(["d->a"]);
    expect(diff.removedEdges).toEqual([{ key: "a->c", from: "A", to: "C" }]);
    expect(diff.changedEdges).toEqual(["c->d"]);
  });

  it("edge keys are the canvas's edge ids", () => {
    const model: ArchModel = {
      elements: [el("sys", { type: "software_system" }), el("api", { parent_id: "sys" }), el("db", { parent_id: "sys" }), el("user", { type: "person" })],
      relationships: [rel("r1", "user", "api", { description: "Uses" }), rel("r2", "api", "db"), rel("r3", "api", "db", { description: "Reads" })],
    };
    const graph = canvasGraph(model, "containers")!;
    expect(graph.edges.length).toBe(2);
    const keys = new Set((model.relationships ?? []).map(edgeKey));
    for (const e of graph.edges) expect(keys.has(e.id)).toBe(true);
  });

  it("null models compare as empty", () => {
    const model: ArchModel = { elements: [el("a"), el("b")], relationships: [rel("r1", "a", "b")] };
    expect(diffModels(null, model)).toMatchObject({ added: ["a", "b"], addedEdges: ["a->b"], removed: [] });
    expect(changeCount(diffModels(model, model))).toBe(0);
    expect(changeCount(diffModels(null, null))).toBe(0);
  });
});
