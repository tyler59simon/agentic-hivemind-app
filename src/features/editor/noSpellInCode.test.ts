// What noSpellInCode marks (DESK-8), read from the decorations of `build` with a stub view whose visible ranges the test
// controls, since jsdom lays nothing out.
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { EditorState } from "@codemirror/state";
import { beforeAll, describe, expect, it } from "vitest";
import { build } from "./noSpellInCode";

// A page with the languages loaded, as the rich editor has them: the code of a fence is a JavaScript tree mounted in the Markdown one.
beforeAll(async () => { await languages.find((l) => l.name === "JavaScript")!.load(); });

/** What `build` marks: the numbers of the lines it turned off, and the text of each marked span. */
function marked(doc: string, ranges?: [number, number][]) {
  const state = EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage, codeLanguages: languages })] });
  ensureSyntaxTree(state, doc.length, 5000);
  const started = performance.now();
  const set = build({ state, visibleRanges: (ranges ?? [[0, doc.length]]).map(([from, to]) => ({ from, to })) });
  const ms = performance.now() - started;
  const lines: number[] = [], spans: string[] = [];
  set.between(0, doc.length, (from, to) => { if (from === to) lines.push(state.doc.lineAt(from).number); else spans.push(doc.slice(from, to)); });
  return { lines, spans, ms };
}

describe("wikilinks", () => {
  it("a [[ in a code fence is code, and a ]] in the prose after it does not make the prose a link (Codex review, R1 C2)", () => {
    const { spans, lines } = marked("```js\nlet a = [[1, 2\n```\nplain prose words]] and more\n");
    expect(lines).toEqual([1, 2, 3]);
    expect(spans).toEqual([]);
  });

  it("a link never runs over a line break", () => {
    expect(marked("an open [[Page\nand a close]] here").spans).toEqual([]);
  });

  it("a link in inline code is code", () => {
    expect(marked("`[[Code Page]]` and [[Real Page]]").spans).toEqual(["`[[Code Page]]`", "Real Page"]);
  });

  it("marks the page name only, up to a # or a |", () => {
    expect(marked("[[A Page#Head]] [[B Page|alias]] [[C Page]] [[ ]] [[]]").spans).toEqual(["A Page", "B Page", "C Page"]);
  });

  it("a link whose end lies past the visible range still gets its page name, cut to the range (C3)", () => {
    const doc = "start [[Some Page]] end of a long wrapped line";
    expect(marked(doc, [[0, doc.indexOf("]]")]]).spans).toEqual(["Some Page"]);
    expect(marked(doc, [[0, doc.indexOf("Page")]]).spans).toEqual(["Some "]);
    expect(marked(doc, [[doc.indexOf("Some") + 2, doc.length]]).spans).toEqual(["me Page"]);
  });

  it("takes a long run of brackets in linear time, in prose and in a fence (R1)", () => {
    const run = "[".repeat(18_000);
    for (const doc of [`word ${run}\n`, `word ${"[[ ".repeat(6_000)}\n`, `\`\`\`\n${run}\n\`\`\`\n`, `[[a ${run} b]]\n`]) {
      expect(marked(doc).ms).toBeLessThan(50);
    }
  });
});

describe("a long code block", () => {
  it("marks only the visible lines of a fence, not the whole block (T1, 8ace9de)", () => {
    const body = Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`);
    const doc = ["```", ...body, "```"].join("\n");
    const at = (n: number) => doc.split("\n").slice(0, n - 1).join("\n").length + (n > 1 ? 1 : 0);   // start of line n
    const { lines } = marked(doc, [[at(1001), at(1011) - 1], [at(2000), at(2003) - 1]]);
    expect(lines).toEqual([1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008, 1009, 1010, 2000, 2001, 2002]);
  });
});
