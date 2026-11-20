import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { MAX_SOURCE, mermaidSource, skipReason } from "./Mermaid";

describe("skipReason", () => {
  it("draws ordinary diagrams", () => {
    expect(skipReason("flowchart LR\n  a --> b")).toBeNull();
  });
  it("keeps the source of diagrams Mermaid would replace with an error picture or stall on", () => {
    expect(skipReason("flowchart LR\n" + "a".repeat(MAX_SOURCE))).toMatch(/too long/);
    expect(skipReason('flowchart LR\n  a@{ img: "https://example.com/x.png" }')).toMatch(/images/);
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
