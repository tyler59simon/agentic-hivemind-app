// @vitest-environment jsdom
// A drawn diagram is one image with a name (DESK-A11Y A3). Mermaid is mocked and returns SVG the way it does: with its own
// role and aria-roledescription, and with a title and description when the source has accTitle and accDescr.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoNewAxeViolations } from "../test/axe";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const PLAIN = '<svg id="mermaid-1" role="graphics-document document" aria-roledescription="flowchart-v2" viewBox="0 0 10 10"><g><text>a</text></g></svg>';
const TITLED = '<svg id="mermaid-2" role="graphics-document document" aria-roledescription="sequence" aria-labelledby="chart-title-mermaid-2" aria-describedby="chart-desc-mermaid-2" viewBox="0 0 10 10"><desc id="chart-desc-mermaid-2">Two services talk.</desc><title id="chart-title-mermaid-2">Login flow</title><g><text>a</text></g></svg>';
vi.mock("mermaid", () => ({
  default: { initialize: () => {}, render: async (_id: string, src: string) => ({ svg: src.includes("accTitle") ? TITLED : PLAIN }) },
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

const { Mermaid } = await import("./Mermaid");

let root: Root | null = null;
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.innerHTML = ""; });

const draw = async (source: string) => {
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<Mermaid source={source} />));
  await act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); });
  return el;
};

describe("a Mermaid diagram", () => {
  it("is an image named by its kind when the source has no accTitle", async () => {
    const el = await draw("flowchart LR\n  a --> b");
    const svg = el.querySelector("svg")!;
    expect(svg.getAttribute("role")).toBe("img");
    expect(svg.getAttribute("aria-label")).toBe("Flowchart diagram");
    expect(svg.hasAttribute("aria-roledescription")).toBe(false);
    await expectNoNewAxeViolations(el, []);
  });

  it("is named by its accTitle and described by its accDescr when it has them", async () => {
    const el = await draw("sequenceDiagram\n  accTitle: Login flow\n  accDescr: Two services talk.\n  A->>B: hi");
    const svg = el.querySelector("svg")!;
    expect(svg.getAttribute("role")).toBe("img");
    expect(svg.hasAttribute("aria-label")).toBe(false);
    expect(el.querySelector(`#${svg.getAttribute("aria-labelledby")}`)!.textContent).toBe("Login flow");
    expect(el.querySelector(`#${svg.getAttribute("aria-describedby")}`)!.textContent).toBe("Two services talk.");
    await expectNoNewAxeViolations(el, []);
  });
});
