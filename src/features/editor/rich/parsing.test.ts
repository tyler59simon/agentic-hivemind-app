// NS-3A: the extra Markdown syntax, the table model and the small parsers the rich editor and the reading view share.
import { markdownLanguage } from "@codemirror/lang-markdown";
import { GFM, parser as baseParser, type MarkdownParser } from "@lezer/markdown";
import { describe, expect, it } from "vitest";
import { attachmentLink, footnoteDefs, footnoteRefs, parseCallout, parseEmbed, pastedName, relativePath, section, splitSize, withWidth } from "./parse";
import { richSyntax } from "./syntax";
import * as T from "./tables";

const parser = baseParser.configure([GFM, richSyntax]);
/** Every node of `text` named `name`, as its source. */
function nodes(text: string, name: string): string[] {
  const out: string[] = [];
  parser.parse(text).iterate({ enter: (n) => { if (n.name === name) out.push(text.slice(n.from, n.to)); } });
  return out;
}

describe("rich syntax", () => {
  it("finds highlights, comments and math outside code", () => {
    expect(nodes("a ==b c== d", "Highlight")).toEqual(["==b c=="]);
    expect(nodes("a %% note %% b", "Comment")).toEqual(["%% note %%"]);
    expect(nodes("area $\\pi r^2$ here", "InlineMath")).toEqual(["$\\pi r^2$"]);
    expect(nodes("$$\nx^2\n$$\n\nafter", "BlockMath")).toEqual(["$$\nx^2\n$$"]);
    expect(nodes("$$ a + b $$", "BlockMath")).toEqual(["$$ a + b $$"]);
    expect(nodes("`==x==` and `$y$` and `%%z%%`", "Highlight")).toEqual([]);
    expect(nodes("`$y$`", "InlineMath")).toEqual([]);
    expect(nodes("```\n$$\nx\n$$\n```", "BlockMath")).toEqual([]);
  });

  it("keeps prices and escaped dollars as text", () => {
    expect(nodes("costs $5 and $6 today", "InlineMath")).toEqual([]);
    expect(nodes("from $ 5 to 6 $", "InlineMath")).toEqual([]);
    expect(nodes("\\$x$ is not math", "InlineMath")).toEqual([]);
    expect(nodes("a == b and c == d", "Highlight")).toEqual([]);
  });

  it("an unclosed $$ block runs to the end of the page, like a fence", () => {
    expect(nodes("$$\nx\ny", "BlockMath")).toEqual(["$$\nx\ny"]);
  });

  it("plugs into CodeMirror's GFM language", () => {
    const lang = (markdownLanguage.parser as MarkdownParser).configure([richSyntax]);
    expect(lang.parse("==a==").toString()).toContain("Highlight");
  });
});

describe("tables", () => {
  const source = "| Name | Size |\n|:-----|-----:|\n| a | 1 |\n| b \\| c | `x \\| y` |";

  it("parse cells, alignment and escaped pipes, inline code included", () => {
    const m = T.parseTable(source)!;
    expect(m.header).toEqual(["Name", "Size"]);
    expect(m.align).toEqual(["left", "right"]);
    expect(m.rows).toEqual([["a", "1"], ["b \\| c", "`x \\| y`"]]);
  });

  it("write back padded, aligned and still escaped, and parse back to the same model", () => {
    const m = T.parseTable(source)!;
    const text = T.writeTable(m);
    expect(text).toBe([
      "| Name   |     Size |",
      "| :----- | -------: |",
      "| a      |        1 |",
      "| b \\| c | `x \\| y` |",
    ].join("\n"));
    expect(T.parseTable(text)).toEqual(m);
  });

  it("escape a pipe typed into a cell, keep escapes already there, and turn line breaks into <br>", () => {
    expect(T.escapeCell("a | b")).toBe("a \\| b");
    expect(T.escapeCell("a \\| b")).toBe("a \\| b");
    expect(T.escapeCell("one\ntwo")).toBe("one<br>two");
    const m = T.setCell(T.parseTable("| a |\n|---|\n| x |")!, 0, 0, "p|q");
    expect(T.writeTable(m)).toBe("| a    |\n| ---- |\n| p\\|q |");
  });

  it("line up wide characters by display width and centre aligned columns", () => {
    const text = T.writeTable({ header: ["名前", "x"], align: ["center", null], rows: [["a", "b"]] });
    expect(text.split("\n")).toEqual(["| 名前 | x   |", "| :--: | --- |", "|  a   | b   |"]);
  });

  it("pad short rows and cut long ones to the header, as GFM reads them", () => {
    expect(T.parseTable("| a | b |\n|---|---|\n| 1 |\n| 1 | 2 | 3 |")!.rows).toEqual([["1", ""], ["1", "2"]]);
    expect(T.parseTable("| a | b |\n| not | delimiter |")).toBeNull();
  });

  it("insert, move, align and delete columns and rows", () => {
    let m = T.parseTable("| a | b |\n|---|---|\n| 1 | 2 |")!;
    m = T.insertColumn(m, 1);
    expect(m.header).toEqual(["a", "", "b"]);
    m = T.moveColumn(m, 2, -1);
    expect(m.header).toEqual(["a", "b", ""]);
    expect(m.rows[0]).toEqual(["1", "2", ""]);
    m = T.alignColumn(m, 0, "right");
    m = T.deleteColumn(m, 2);
    expect(m).toEqual({ header: ["a", "b"], align: ["right", null], rows: [["1", "2"]] });
    m = T.insertRow(m, 0);
    expect(m.rows).toEqual([["", ""], ["1", "2"]]);
    m = T.moveRow(m, 0, 1);
    expect(m.rows).toEqual([["1", "2"], ["", ""]]);
    m = T.deleteRow(m, 1);
    expect(m.rows).toEqual([["1", "2"]]);
    expect(T.deleteColumn(T.deleteColumn(m, 0), 0).header).toEqual(["b"]);
    expect(T.moveRow(m, 0, -1)).toBe(m);
  });
});

describe("embeds, widths, callouts and footnotes", () => {
  it("read pictures in both syntaxes, with widths, and page embeds with headings", () => {
    expect(parseEmbed("![A cat|300](img/cat%201.png)")).toEqual({ kind: "picture", src: "img/cat%201.png", alt: "A cat", wiki: false, width: 300 });
    expect(parseEmbed("![](<my pic.png> \"t\")")).toEqual({ kind: "picture", src: "my pic.png", alt: "", wiki: false });
    expect(parseEmbed("![[cat.png|200x100]]")).toEqual({ kind: "picture", src: "cat.png", alt: "", wiki: true, width: 200, height: 100 });
    expect(parseEmbed("![[Plan#Goals|label]]")).toEqual({ kind: "page", target: "Plan", heading: "Goals", label: "label" });
    expect(parseEmbed("![[Plan]] and more")).toBeNull();
    expect(splitSize("photo")).toEqual({ text: "photo" });
  });

  it("write a width into the syntax the picture used, keeping everything else", () => {
    expect(withWidth("![cat](cat.png \"Title\")", 240)).toBe("![cat|240](cat.png \"Title\")");
    expect(withWidth("![cat|100](cat.png)", 240.4)).toBe("![cat|240](cat.png)");
    expect(withWidth("![cat|100](cat.png)", null)).toBe("![cat](cat.png)");
    expect(withWidth("![[cat.png|100]]", 50)).toBe("![[cat.png|50]]");
    expect(withWidth("  ![[cat.png]]\n", 50)).toBe("  ![[cat.png|50]]\n");
  });

  it("read callouts with their aliases, folds and default titles", () => {
    expect(parseCallout("> [!warning]- Careful")).toEqual({ type: "warning", label: "warning", fold: "-", title: "Careful" });
    expect(parseCallout("> [!TIP]")).toEqual({ type: "tip", label: "tip", fold: "", title: "Tip" });
    expect(parseCallout(">[!faq]+ Why?")?.type).toBe("question");
    expect(parseCallout("> [!custom] X")?.type).toBe("note");
    expect(parseCallout("> plain quote")).toBeNull();
  });

  it("find footnote references and multi-line definitions", () => {
    expect(footnoteRefs("A[^1] and B[^note].").map((r) => r.id)).toEqual(["1", "note"]);
    expect(footnoteRefs("[^1]: a definition")).toEqual([]);
    const defs = footnoteDefs(["text", "[^1]: First", "    more of it", "[^b]: Second", "", "  not a continuation"]);
    expect(defs.get("1")).toBe("First more of it");
    expect(defs.get("b")).toBe("Second");
  });

  it("cut a page to the section an embed names", () => {
    const text = "# Plan\nintro\n## Goals\none\n### Sub\ntwo\n## Risks\nthree";
    expect(section(text, "goals")).toBe("## Goals\none\n### Sub\ntwo");
    expect(section(text)).toBe(text);
    expect(section(text, "Missing")).toBeNull();
  });

  it("name pasted pictures and link attachments from the page's folder", () => {
    expect(pastedName(new Date(2026, 10, 21, 9, 5, 7))).toBe("Pasted image 20261121090507.png");
    expect(relativePath("Plans/Q1", "attachments/a b.png")).toBe("../../attachments/a b.png");
    expect(relativePath("Plans", "Plans/img/x.png")).toBe("img/x.png");
    expect(relativePath("", "assets/1a2b3c4d-x.png")).toBe("assets/1a2b3c4d-x.png");
    expect(attachmentLink("../attachments/a b.png", "a b.png")).toBe("![a b.png](../attachments/a%20b.png)");
    expect(attachmentLink("doc.pdf", "[doc].pdf")).toBe("[doc.pdf](doc.pdf)");
  });
});

describe("Codex review of 398b956", () => {
  it("encodes parentheses in attachment links, so the destination ends where it should", () => {
    expect(attachmentLink("attachments/Screen ).png", "Screen ).png")).toBe("![Screen ).png](attachments/Screen%20%29.png)");
    expect(attachmentLink("a (1).png", "a (1).png")).toBe("![a (1).png](a%20%281%29.png)");
  });

  it("pads table columns only up to a width, so one long cell does not pad every row", () => {
    const long = "x".repeat(T.PAD_MAX + 1000);
    const rows = Array.from({ length: 50 }, (_, i) => [String(i)]);
    const text = T.writeTable({ header: ["h"], align: [null], rows: [[long], ...rows] });
    expect(text.length).toBeLessThan(long.length + 50 * 20);
    expect(T.parseTable(text)?.rows[0][0]).toBe(long);
    expect(T.writeTable({ header: ["a", "b"], align: [null, null], rows: [["1", "22"]] })).toBe("| a   | b   |\n| --- | --- |\n| 1   | 22  |");
  });

  it("finds an embedded section by the headings Markdown parses", () => {
    const page = "Intro\n\n```\n# Setup\nnot a heading\n```\n\nSetup\n=====\n\nReal setup.\n\n```\n# Other\n```\n\nstill setup\n\n# Next\n\nno";
    expect(section(page, "Setup")).toBe("Setup\n=====\n\nReal setup.\n\n```\n# Other\n```\n\nstill setup");
    expect(section(page, "Other")).toBeNull();
    expect(section("## A ##\n\nx\n\n## B\n\ny", "A")).toBe("## A ##\n\nx");
    // A Setext title over two lines is matched whole (Codex re-review of 87a0a1f).
    const setext = "Long\ntitle\n=====\n\nx\n\n# Next";
    expect(section(setext, "Long title")).toBe("Long\ntitle\n=====\n\nx");
    expect(section(setext, "Long")).toBeNull();
  });
});
