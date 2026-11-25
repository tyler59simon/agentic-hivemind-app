// @vitest-environment jsdom
// The architecture drawing without sight (DESK-A11Y A3): its boxes are buttons a keyboard reaches, its arrows are hidden from a
// screen reader, and a Relations list gives every arrow with its whole label.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArchModel } from "../../lib/architecture";
import { expectNoNewAxeViolations } from "../../test/axe";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));

const { ArchitectureCanvas } = await import("./ArchitectureCanvas");

const LONG = "Authorizes the payment and records the receipt";
const model: ArchModel = {
  elements: [
    { id: "customer", name: "Customer", type: "person" },
    { id: "api", name: "API", type: "container", technology: "Python" },
    { id: "pay", name: "Payment Provider", type: "software_system", external: true },
  ],
  relationships: [
    { id: "r1", source_id: "customer", destination_id: "api", description: "Submits request" },
    { id: "r2", source_id: "api", destination_id: "pay", description: LONG },
    { id: "r3", source_id: "pay", destination_id: "customer" },
  ],
  views: [{ id: "c", type: "container", title: "Container", element_ids: ["customer", "api", "pay"], relationship_ids: ["r1", "r2", "r3"] }],
};

let root: Root | null = null;
let el: HTMLElement;
beforeEach(async () => {
  el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(
    <QueryClientProvider client={new QueryClient()}>
      <ArchitectureCanvas slug="s" model={model} diagrams={[]} version={null} selected={null} onSelect={() => {}} />
    </QueryClientProvider>,
  ));
});
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.innerHTML = ""; });
const relations = () => el.querySelector('section[aria-label="Relations"]');
const toggle = () => [...el.querySelectorAll("button")].find((b) => b.textContent === "Relations")!;

describe("the architecture canvas", () => {
  it("is a named group of buttons, one per box, and its arrows are hidden from a screen reader", () => {
    const svg = el.querySelector("svg.canvas-svg")!;
    expect(svg.getAttribute("role")).toBe("group");
    expect(svg.getAttribute("aria-label")).toBe("Containers diagram");
    expect([...svg.querySelectorAll("button.canvas-node")].map((b) => b.querySelector("strong")!.textContent)).toEqual(["Customer", "API", "Payment Provider"]);
    const edges = [...svg.querySelectorAll("g.canvas-edge")];
    expect(edges).toHaveLength(3);
    expect(edges.every((g) => g.getAttribute("aria-hidden") === "true")).toBe(true);
  });

  it("lists each relation from source to target with its whole label, behind a Relations button", async () => {
    expect(relations()).toBeNull();
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    await act(async () => toggle().click());
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect([...relations()!.querySelectorAll("li")].map((li) => li.textContent)).toEqual([
      "Customer to API: Submits request", `API to Payment Provider: ${LONG}`, "Payment Provider to Customer",
    ]);
    expect(relations()!.id).toBe(toggle().getAttribute("aria-controls"));
    await act(async () => toggle().click());
    expect(relations()).toBeNull();
  });

  it("has no axe violations, with the list shown or not", async () => {
    await expectNoNewAxeViolations(el, []);
    await act(async () => toggle().click());
    await expectNoNewAxeViolations(el, []);
  });
});
