import { describe, expect, it } from "vitest";
import type { ArchElement, ArchModel, ArchRelationship } from "../../lib/architecture";
import { chain, ownContainers } from "./diagram";

const el = (id: string, over: Partial<ArchElement> = {}): ArchElement => ({ id, name: id, type: "container", ...over });
const rel = (source_id: string, destination_id: string): ArchRelationship => ({ id: `${source_id}-${destination_id}`, source_id, destination_id });
const names = (model: ArchModel | null, max?: number) => chain(model, max).nodes.map((n) => n.id);

describe("architecture diagram shaping", () => {
  const model: ArchModel = {
    elements: [el("delivery"), el("ingestion"), el("decisioning"), el("producer", { type: "software_system", external: true }), el("user", { type: "person" })],
    relationships: [rel("producer", "ingestion"), rel("ingestion", "decisioning"), rel("decisioning", "delivery")],
  };

  it("keeps only the system's own containers", () => {
    expect(ownContainers(model).map((e) => e.id)).toEqual(["delivery", "ingestion", "decisioning"]);
    expect(ownContainers({ elements: [el("pay", { type: "software_system" }), el("ext", { type: "software_system", external: true })] }).map((e) => e.id)).toEqual(["pay"]);
    expect(ownContainers(null)).toEqual([]);
  });

  it("orders boxes along the flow and reports which neighbours are linked", () => {
    expect(names(model)).toEqual(["ingestion", "decisioning", "delivery"]);
    expect(chain(model).linked).toEqual([true, true]);
  });

  it("stops at the limit and tolerates unrelated or cyclic containers", () => {
    expect(names(model, 2)).toEqual(["ingestion", "decisioning"]);
    const loose: ArchModel = { elements: [el("a"), el("b"), el("c")], relationships: [rel("a", "b"), rel("b", "a")] };
    expect(names(loose)).toEqual(["c", "a", "b"]);
    expect(chain(loose).linked).toEqual([false, true]);
    expect(chain(null)).toEqual({ nodes: [], linked: [] });
  });
});
