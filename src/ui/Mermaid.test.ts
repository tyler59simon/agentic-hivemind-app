import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { mermaidSource } from "./Mermaid";

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
