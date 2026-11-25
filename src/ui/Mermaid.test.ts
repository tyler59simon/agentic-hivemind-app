import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { diagramName, labelDiagram, MAX_SOURCE, mermaidSource, skipReason } from "./Mermaid";

describe("skipReason", () => {
  it("draws ordinary diagrams", () => {
    expect(skipReason("flowchart LR\n  a --> b")).toBeNull();
  });
  it("keeps the source of diagrams Mermaid would replace with an error picture or stall on", () => {
    expect(skipReason("flowchart LR\n" + "a".repeat(MAX_SOURCE))).toMatch(/too long/);
    expect(skipReason('flowchart LR\n  a@{ img: "https://example.com/x.png" }')).toMatch(/images/);
    expect(skipReason('flowchart LR\n  a@{ "img": "https://example.com/x.png" }')).toMatch(/images/);
    expect(skipReason('flowchart LR\n  a["<img src=https://example.com/x.png>"]')).toMatch(/images/);
  });
});

describe("mermaidSource", () => {
  it("returns the source of a mermaid code block without the trailing newline", () => {
    const code = createElement("code", { className: "language-mermaid" }, "flowchart LR\n  a --> b\n");
    expect(mermaidSource(code)).toBe("flowchart LR\n  a --> b");
  });
  it("leaves other code blocks alone", () => {
    expect(mermaidSource(createElement("code", { className: "language-python" }, "x = 1\n"))).toBeNull();
    expect(mermaidSource(createElement("code", { className: "language-mermaidx" }, "a"))).toBeNull();
    expect(mermaidSource(createElement("code", {}, "plain\n"))).toBeNull();
    expect(mermaidSource("text")).toBeNull();
  });
});

describe("diagramName", () => {
  it("names the diagram by its first keyword, after front matter, comments and directives", () => {
    expect(diagramName("flowchart LR\n  a --> b")).toBe("Flowchart diagram");
    expect(diagramName("graph TD\n a-->b")).toBe("Flowchart diagram");
    expect(diagramName("sequenceDiagram\n  A->>B: hi")).toBe("Sequence diagram");
    expect(diagramName("classDiagram\n  A <|-- B")).toBe("Class diagram");
    expect(diagramName("stateDiagram-v2\n  [*] --> A")).toBe("State diagram");
    expect(diagramName("---\ntitle: T\n---\n%% a comment\n%%{init: {}}%%\n\nerDiagram\n  A ||--o{ B : has")).toBe("Entity relationship diagram");
    expect(diagramName("pie title Pets\n  \"Dogs\": 2")).toBe("Pie chart");
    expect(diagramName("quadrantChart\n  x-axis a")).toBe("Quadrant chart diagram");
    expect(diagramName("")).toBe("Diagram");
  });
});

describe("labelDiagram", () => {
  const src = "flowchart LR\n  a --> b";
  it("makes the SVG one image named by the kind of diagram, dropping Mermaid's own role and role description", () => {
    const svg = '<svg id="m1" role="graphics-document document" aria-roledescription="flowchart-v2" viewBox="0 0 1 1"><g/></svg>';
    expect(labelDiagram(svg, src)).toBe('<svg role="img" aria-label="Flowchart diagram" id="m1" viewBox="0 0 1 1"><g/></svg>');
  });
  it("keeps the name Mermaid made from accTitle, and its description", () => {
    const svg = '<svg id="m1" role="graphics-document document" aria-labelledby="chart-title-m1" aria-describedby="chart-desc-m1"><desc id="chart-desc-m1">d</desc><title id="chart-title-m1">T</title></svg>';
    const out = labelDiagram(svg, src);
    expect(out).toContain('role="img"');
    expect(out).not.toContain("aria-label=");
    expect(out).toContain('aria-labelledby="chart-title-m1"');
    expect(out).toContain('aria-describedby="chart-desc-m1"');
  });
  it("leaves anything that is not an SVG alone", () => {
    expect(labelDiagram("<p>x</p>", src)).toBe("<p>x</p>");
  });
});
