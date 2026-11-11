import { describe, expect, it } from "vitest";
import type { ArchModel } from "../../lib/architecture";
import { canvasGraph, fitScale, layoutGraph, NODE_SIZE } from "./canvas";

// The shape the Architecture Suite writes (see its examples/starter-systems/order-platform).
const model: ArchModel = {
  system: { name: "Order Platform" },
  elements: [
    { id: "order-platform", name: "Order Platform", type: "software_system" },
    { id: "customer", name: "Customer", type: "person" },
    { id: "payment-provider", name: "Payment Provider", type: "software_system", external: true },
    { id: "api", name: "API", type: "container", parent_id: "order-platform", technology: "Python HTTPS" },
    { id: "request-controller", name: "Request Controller", type: "component", parent_id: "api" },
    { id: "worker", name: "Worker", type: "container", parent_id: "order-platform", technology: "Go" },
    { id: "order-queue", name: "Order Queue", type: "container", parent_id: "order-platform", technology: "SQS" },
  ],
  relationships: [
    { id: "system-context-r1", source_id: "customer", destination_id: "order-platform", description: "Submits request" },
    { id: "system-context-r2", source_id: "order-platform", destination_id: "payment-provider", description: "Authorizes payment" },
    { id: "containers-r1", source_id: "customer", destination_id: "api", description: "Submits request" },
    { id: "containers-r2", source_id: "api", destination_id: "payment-provider", description: "Authorizes payment" },
    { id: "containers-r3", source_id: "api", destination_id: "order-queue", description: "Queues accepted work" },
    { id: "containers-r4", source_id: "order-queue", destination_id: "worker", description: "Delivers work" },
    { id: "component-api-r3", source_id: "request-controller", destination_id: "order-queue", description: "Queues accepted work" },
  ],
  views: [
    { id: "system-context", type: "context", title: "Context", element_ids: ["order-platform", "customer", "payment-provider"], relationship_ids: ["system-context-r1", "system-context-r2"] },
    { id: "containers", type: "container", title: "Container", boundary_id: "order-platform",
      element_ids: ["order-platform", "customer", "payment-provider", "api", "worker", "order-queue"],
      relationship_ids: ["containers-r1", "containers-r2", "containers-r3", "containers-r4"] },
  ],
};
const ids = (list: { id: string }[]) => list.map((x) => x.id);

describe("architecture canvas", () => {
  it("draws the context view as the system among its neighbours, with no boundary", () => {
    const g = canvasGraph(model, "context")!;
    expect(ids(g.nodes)).toEqual(["order-platform", "customer", "payment-provider"]);
    expect(ids(g.edges)).toEqual(["customer->order-platform", "order-platform->payment-provider"]);
    expect(g.boundary).toBeNull();
  });

  it("opens the system up at the containers level: the boundary is a frame, not a box", () => {
    const g = canvasGraph(model, "containers")!;
    expect(ids(g.nodes)).toEqual(["customer", "payment-provider", "api", "worker", "order-queue"]);
    expect(g.boundary).toEqual({ id: "order-platform", name: "Order Platform" });
    expect(g.nodes.filter((n) => n.inside).map((n) => n.id)).toEqual(["api", "worker", "order-queue"]);
    expect(g.nodes.find((n) => n.id === "payment-provider")).toMatchObject({ external: true, inside: false });
    expect(ids(g.edges)).toEqual(["customer->api", "api->payment-provider", "api->order-queue", "order-queue->worker"]);
  });

  it("reads the levels off the element types when the model has no views", () => {
    const bare = { ...model, views: [] };
    expect(ids(canvasGraph(bare, "context")!.nodes)).toEqual(["order-platform", "customer", "payment-provider"]);
    const containers = canvasGraph(bare, "containers")!;
    expect(ids(containers.nodes)).toEqual(["customer", "payment-provider", "api", "worker", "order-queue"]);
    expect(containers.boundary?.id).toBe("order-platform");
    // Arrows fall back to every relationship between the boxes shown.
    expect(ids(containers.edges)).toEqual(["customer->api", "api->payment-provider", "api->order-queue", "order-queue->worker"]);
  });

  it("merges parallel relationships into one arrow and ignores unknown ids", () => {
    const twice: ArchModel = {
      elements: [{ id: "a", name: "A", type: "container" }, { id: "b", name: "B", type: "container" }],
      relationships: [
        { id: "r1", source_id: "a", destination_id: "b", description: "Reads" },
        { id: "r2", source_id: "a", destination_id: "b", description: "Writes" },
        { id: "r3", source_id: "a", destination_id: "b", description: "Reads" },
        { id: "r4", source_id: "a", destination_id: "ghost" },
        { id: "r5", source_id: "a", destination_id: "a" },
      ],
    };
    expect(canvasGraph(twice, "containers")!.edges).toEqual([{ id: "a->b", from: "a", to: "b", label: "Reads; Writes" }]);
    expect(canvasGraph(null, "context")).toBeNull();
    expect(canvasGraph({ elements: [] }, "context")).toBeNull();
  });

  it("lays boxes out left to right along the flow, with the boundary around its containers", () => {
    const laid = layoutGraph(canvasGraph(model, "containers")!);
    const at = (id: string) => laid.nodes.find((n) => n.id === id)!;
    expect(at("customer").x).toBeLessThan(at("api").x);
    expect(at("api").x).toBeLessThan(at("order-queue").x);
    expect(at("order-queue").x).toBeLessThan(at("worker").x);
    expect(at("api")).toMatchObject(NODE_SIZE);
    const b = laid.boundary!;
    for (const id of ["api", "worker", "order-queue"]) {
      const n = at(id);
      expect(n.x).toBeGreaterThanOrEqual(b.x);
      expect(n.y).toBeGreaterThanOrEqual(b.y);
      expect(n.x + n.width).toBeLessThanOrEqual(b.x + b.width);
      expect(n.y + n.height).toBeLessThanOrEqual(b.y + b.height);
    }
    expect(at("customer").x + NODE_SIZE.width).toBeLessThanOrEqual(b.x);
    expect(laid.edges.every((e) => e.points.length >= 2)).toBe(true);
    expect(laid.width).toBeGreaterThan(0);
    expect(layoutGraph(canvasGraph(model, "context")!).boundary).toBeNull();
  });

  it("fits a drawing into the viewport without enlarging it", () => {
    expect(fitScale({ width: 2000, height: 500 }, { width: 1000, height: 600 })).toBe(0.5);
    expect(fitScale({ width: 400, height: 200 }, { width: 1000, height: 600 })).toBe(1);
    expect(fitScale({ width: 0, height: 0 }, { width: 1000, height: 600 })).toBe(1);
    expect(fitScale({ width: 100000, height: 10 }, { width: 100, height: 100 })).toBe(0.2);
  });
});
