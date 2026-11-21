// @vitest-environment jsdom
// NS-3A: which blocks the rich editor renders, and that a block under the cursor shows its source.
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState, type Extension } from "@codemirror/state";
import { describe, expect, it, vi } from "vitest";
import { buildBlocks, richBlocks } from "./blocks";
import { richContext, richRefresh, type RichContext } from "./context";
import { richLanguage } from "./index";
import { toggleCallout } from "./widgets";

function ctx(over: Partial<RichContext> = {}): RichContext {
  return {
    pictureUrl: vi.fn((src: string, wiki: boolean) => `http://hmfile.localhost/g/${wiki ? "wiki/" : ""}${src}`),
    readEmbed: vi.fn(async () => null), renderEmbed: vi.fn(() => () => {}), openPage: vi.fn(), openHref: vi.fn(), fail: vi.fn(),
    ...over,
  };
}

function stateOf(doc: string, cursor = doc.length, rich: RichContext | null = ctx()) {
  const state = EditorState.create({ doc, selection: { anchor: cursor }, extensions: [richLanguage(), ...(rich ? [richContext.of(rich)] : []), richBlocks] });
  ensureSyntaxTree(state, state.doc.length, 5000);
  // The field was built when the state was made; a no-op refresh rebuilds it on the complete tree.
  return state.update({ effects: richRefresh.of(null) }).state;
}

/** The block decorations, as `Widget@from-to` or `line:class@from`. */
function shown(state: EditorState): string[] {
  const out: string[] = [];
  state.field(richBlocks).deco.between(0, state.doc.length, (from, to, d) => {
    const w = d.spec.widget;
    if (w) out.push(`${w.constructor.name}@${from}-${to}`);
    else if (d.spec.class) out.push(`line:${d.spec.class}@${from}`);
    else out.push(`hide@${from}-${to}`);
  });
  return out;
}

const TABLE = "| a | b |\n|---|---|\n| 1 | 2 |";

const CHUNK = `## Section

Some text with **bold** and a [link](https://example.com).

${TABLE}

> [!note] Callout
> body

$$
x^2
$$

`;

describe("rich blocks", () => {
  it("draws a table as a grid until the cursor enters it", () => {
    const doc = `Intro\n\n${TABLE}\n\nEnd`;
    expect(shown(stateOf(doc))).toEqual([`TableWidget@7-${7 + TABLE.length}`]);
    expect(shown(stateOf(doc, 10))).toEqual([]);
  });

  it("leaves table syntax inside a fence or a quote alone", () => {
    const fenced = stateOf("```\n" + TABLE + "\n```\n\nx");
    expect(shown(fenced).some((s) => s.startsWith("TableWidget"))).toBe(false);
    expect(shown(stateOf("> | a | b |\n> |---|---|\n> | 1 | 2 |\n\nx")).some((s) => s.startsWith("TableWidget"))).toBe(false);
  });

  it("draws Mermaid fences and $$ blocks, and marks other fences' lines", () => {
    const doc = "```mermaid\nflowchart LR\n  A --> B\n```\n\n$$\nx^2\n$$\n\n```ts\nlet a = 1;\n```\n\nend";
    const s = shown(stateOf(doc));
    expect(s[0]).toBe("MermaidWidget@0-37");
    expect(s[1]).toBe("MathWidget@39-48");
    expect(s.slice(2)).toEqual([
      "line:cm-rich-fence cm-rich-fence-first@50", "line:cm-rich-fence@56", "line:cm-rich-fence cm-rich-fence-last@67",
    ]);
  });

  it("draws a callout's title and hides its quote marks; a folded one hides its body until unfolded", () => {
    const doc = "> [!warning]- Careful\n> body line\n> more\n\nend";
    const folded = stateOf(doc);
    expect(shown(folded)).toEqual([
      "line:cm-callout cm-callout-warning cm-callout-first cm-callout-last@0",
      "CalloutTitleWidget@0-21",
      "hide@21-40",
      "line:cm-callout cm-callout-warning cm-callout-last@22",
      "line:cm-callout cm-callout-warning cm-callout-last@34",
    ]);
    const open = folded.update({ effects: toggleCallout.of(0) }).state;
    expect(shown(open)).toEqual([
      "line:cm-callout cm-callout-warning cm-callout-first@0",
      "CalloutTitleWidget@0-21",
      "line:cm-callout cm-callout-warning@22",
      "hide@22-24",
      "line:cm-callout cm-callout-warning cm-callout-last@34",
      "hide@34-36",
    ]);
    // A plain quote is not a callout.
    expect(shown(stateOf("> just a quote\n\nend"))).toEqual([]);
  });

  it("draws a paragraph that is only a picture or an embed, and asks the page for the picture's URL", () => {
    const rich = ctx();
    const doc = "![cat|200](img/cat.png)\n\n![[photo.jpg]]\n\n![[Plan#Goals]]\n\nSee ![x](x.png) inline.";
    expect(shown(stateOf(doc, doc.length, rich))).toEqual(["PictureWidget@0-23", "PictureWidget@25-39", "EmbedWidget@41-56"]);
    expect(rich.pictureUrl).toHaveBeenCalledWith("img/cat.png", false);
    expect(rich.pictureUrl).toHaveBeenCalledWith("photo.jpg", true);
  });

  it("draws no pictures or embeds without a page context (memory notes never have one)", () => {
    expect(shown(stateOf("![cat](cat.png)\n\nend", 20, null))).toEqual([]);
  });

  it("keeps its decorations while the cursor moves inside the same block, and redraws when it leaves", () => {
    const doc = `${TABLE}\n\nText here\n\nmore`;
    const inside = stateOf(doc, 2);
    const moved = inside.update({ selection: EditorSelection.cursor(4) }).state;
    expect(moved.field(richBlocks)).toBe(inside.field(richBlocks));
    const left = moved.update({ selection: EditorSelection.cursor(doc.length) }).state;
    expect(shown(left)).toEqual([`TableWidget@0-${TABLE.length}`]);
  });

  it("redraws after edits exactly as a full redraw would, including a fence that swallows the blocks after it", () => {
    const doc = `# Page

${TABLE}

> [!note]- Folded
> body

$$
x
$$

![p](p.png)

Text

${TABLE}
`;
    let state = stateOf(doc, 0);
    const edits: [number, number, string][] = [
      [8, 8, "```\n"], [8, 12, ""], [0, 0, "intro\n\n"], [30, 31, ""], [doc.length - 3, doc.length - 3, "| 3 | 4 |\n"],
      [20, 20, "\n\n"], [0, 8, ""], [40, 40, "$$"], [5, 60, ""],
    ];
    for (const [from, to, insert] of edits) {
      const len = state.doc.length;
      const a = Math.min(from, len), b = Math.min(to, len);
      state = state.update({ changes: { from: a, to: b, insert }, selection: { anchor: Math.min(len, 1) } }).state;
      const field = shown(state);
      const fresh: string[] = [];
      buildBlocks(state, state.field(richBlocks).toggled, state.field(richBlocks).stamp).between(0, state.doc.length, (f, t, d) => {
        const w = d.spec.widget;
        fresh.push(w ? `${w.constructor.name}@${f}-${t}` : d.spec.class ? `line:${d.spec.class}@${f}` : `hide@${f}-${t}`);
      });
      expect(field).toEqual(fresh);
    }
  });

  it("matches a full redraw after 300 random edits and cursor moves", () => {
    const pieces = ["```\n", "```mermaid\n", "| x | y |\n|---|---|\n", "> [!tip]- T\n> b\n", "$$\n", "\n", "\n\n", "text ", "![a](a.png)\n", "![[P]]\n", ">", "|"];
    let seed = 7;
    const rand = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    let state = stateOf(`# Start\n\n${TABLE}\n\n> [!note] N\n> x\n\nend\n`, 0);
    for (let i = 0; i < 300; i++) {
      const len = state.doc.length;
      const from = rand(len + 1), to = Math.min(len, from + (rand(3) === 0 ? rand(12) : 0));
      const insert = rand(4) === 0 ? "" : pieces[rand(pieces.length)];
      const after = state.update({ changes: { from, to, insert } }).state;
      state = after.update({ selection: { anchor: rand(after.doc.length + 1) }, effects: rand(10) === 0 ? toggleCallout.of(rand(after.doc.length + 1)) : [] }).state;
      const fresh: string[] = [];
      buildBlocks(state, state.field(richBlocks).toggled, state.field(richBlocks).stamp).between(0, state.doc.length, (f, t, d) => {
        const w = d.spec.widget;
        fresh.push(w ? `${w.constructor.name}@${f}-${t}` : d.spec.class ? `line:${d.spec.class}@${f}` : `hide@${f}-${t}`);
      });
      expect(shown(state), `after edit ${i}`).toEqual(fresh);
    }
  });

  it("redraws only the blocks around an edit", () => {
    // Deterministic stand-in for the timing check below: an edit in the middle of a long page keeps every other block's
    // widget (Codex review of 398b956, P2).
    let state = stateOf(CHUNK.repeat(150), 0);
    const widgets = (s: EditorState) => {
      const out: unknown[] = [];
      s.field(richBlocks).deco.between(0, s.doc.length, (_f, _t, d) => { if (d.spec.widget) out.push(d.spec.widget); });
      return out;
    };
    const before = new Set(widgets(state));
    state = state.update({ changes: { from: Math.floor(state.doc.length / 2), insert: "x" } }).state;
    const after = widgets(state);
    expect(after.length).toBe(before.size);
    expect(after.filter((w) => !before.has(w)).length).toBeLessThanOrEqual(2);
  });

  // Timing depends on the machine and on what else runs, so it runs only when asked: VITE_RICH_BENCH=1 npx vitest run blocks.
  it.skipIf(!import.meta.env.VITE_RICH_BENCH)("adds little to typing on a 1 MB page", () => {
    const chunk = CHUNK;
    const doc = chunk.repeat(Math.ceil(1_000_000 / chunk.length)).slice(0, 999_000);
    const median = (extensions: Extension) => {
      let state = EditorState.create({ doc, extensions });
      ensureSyntaxTree(state, state.doc.length, 10000);
      const runs: number[] = [];
      for (let i = 0; i < 25; i++) {
        const start = performance.now();
        state = state.update({ changes: { from: 500_000, insert: "x" }, selection: { anchor: 500_001 } }).state;
        runs.push(performance.now() - start);
      }
      return runs.sort((a, b) => a - b)[12];
    };
    const plain = median(markdown({ base: markdownLanguage }));
    const rich = median([richLanguage(), richContext.of(ctx()), richBlocks]);
    // CodeMirror's own reparse is the same either way; the block field may add a few milliseconds, not a redraw.
    expect(rich - plain).toBeLessThan(8);
  });
});
