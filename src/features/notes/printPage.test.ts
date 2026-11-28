// @vitest-environment jsdom
// DOCOS-1A: what Export to PDF waits for before it prints, and the name it suggests. The print rules are checked in
// print.css.test.ts.
import { afterEach, describe, expect, it, vi } from "vitest";
import { pdfName, stillDrawing, whenRendered } from "./printPage";

const box = (html: string) => {
  const el = document.createElement("div");
  el.innerHTML = html;
  return el;
};

describe("stillDrawing", () => {
  it("names what has not drawn yet and is null once everything has", () => {
    expect(stillDrawing(box('<div class="page-embed"><p class="muted">Loading…</p></div>'))).toBe("an embedded page");
    expect(stillDrawing(box('<p class="muted pad">Running the query…</p>'))).toBe("a query");
    expect(stillDrawing(box('<pre><code class="language-mermaid">graph TD</code></pre>'))).toBe("a diagram");
    expect(stillDrawing(box('<span class="math-inline">x^2</span>'))).toBe("math");
    expect(stillDrawing(box('<div class="mermaid-diagram"><svg></svg></div><span class="math-inline"><span class="katex"></span></span><p class="muted">No page is named X.</p>'))).toBeNull();
  });

  it("does not wait for TeX that KaTeX draws as an error (Codex review of f38e4c3, P2)", () => {
    expect(stillDrawing(box('<span class="math-inline"><span class="katex-error">x^</span></span>'))).toBeNull();
  });

  it("does not wait for a diagram that cannot be drawn, which shows a note after its source", () => {
    expect(stillDrawing(box('<pre><code class="language-mermaid">nonsense</code></pre><p class="muted">Diagram did not render.</p>'))).toBeNull();
  });

  it("waits for a picture that has not loaded", () => {
    const el = box('<img src="http://hmfile.localhost/g1/a.png">');
    Object.defineProperty(el.querySelector("img")!, "complete", { value: false });
    expect(stillDrawing(el)).toBe("a picture");
  });
});

describe("whenRendered", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("resolves once the page has drawn", async () => {
    vi.useFakeTimers();
    const el = box('<span class="math-inline">x</span>');
    const done = vi.fn();
    void whenRendered(el).then(done);
    await vi.advanceTimersByTimeAsync(300);
    expect(done).not.toHaveBeenCalled();
    el.querySelector(".math-inline")!.innerHTML = '<span class="katex"></span>';
    await vi.advanceTimersByTimeAsync(200);
    expect(done).toHaveBeenCalled();
  });

  it("gives up with the reason after the limit", async () => {
    vi.useFakeTimers();
    const result = whenRendered(box('<pre><code class="language-mermaid">graph TD</code></pre>'), 1000).catch((e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(1100);
    expect(await result).toBe("The page did not finish drawing (a diagram), so it was not exported");
  });
});

describe("pdfName", () => {
  it("is the page's file name with .pdf in place of its Markdown extension", () => {
    expect(pdfName("Plan.md")).toBe("Plan.pdf");
    expect(pdfName("Notes/Daily.MARKDOWN")).toBe("Daily.pdf");
    expect(pdfName("a.b.md")).toBe("a.b.pdf");
  });
});
