// NS-3A: the toolbar's and the slash menu's Markdown edits.
import { EditorSelection, EditorState, type TransactionSpec } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import * as C from "./commands";
import { SLASH_ITEMS } from "./slash";

/** Apply `run` to `doc` with the selection `[from, to]`; returns the text with `|` at the cursor or `[`..`]` around the
 *  selection. */
function apply(doc: string, from: number, to: number, run: (s: EditorState) => TransactionSpec): string {
  const state = EditorState.create({ doc, selection: EditorSelection.single(from, to), extensions: [EditorState.allowMultipleSelections.of(true)] });
  const next = state.update(run(state)).state;
  const r = next.selection.main;
  const text = next.doc.toString();
  return r.empty ? `${text.slice(0, r.from)}|${text.slice(r.from)}` : `${text.slice(0, r.from)}[${text.slice(r.from, r.to)}]${text.slice(r.to)}`;
}

describe("toolbar commands", () => {
  it("wrap and unwrap a selection, or leave the cursor inside an empty pair", () => {
    expect(apply("a word b", 2, 6, (s) => C.toggleWrap(s, "**"))).toBe("a **[word]** b");
    expect(apply("a **word** b", 4, 8, (s) => C.toggleWrap(s, "**"))).toBe("a [word] b");
    expect(apply("a **word** b", 2, 10, (s) => C.toggleWrap(s, "**"))).toBe("a [word] b");
    expect(apply("ab", 1, 1, (s) => C.toggleWrap(s, "=="))).toBe("a==|==b");
  });

  it("toggle list, task and quote prefixes on every selected line, replacing another prefix", () => {
    expect(apply("one\ntwo", 0, 7, (s) => C.toggleLinePrefix(s, "bullet"))).toBe("- [one\n- two]");
    expect(apply("- one\n- two", 0, 11, (s) => C.toggleLinePrefix(s, "bullet"))).toBe("[one\ntwo]");
    expect(apply("- one\n- two", 0, 11, (s) => C.toggleLinePrefix(s, "number"))).toBe("1. [one\n2. two]");
    expect(apply("  - one", 4, 4, (s) => C.toggleLinePrefix(s, "task"))).toBe("  - [ ] |one");
    expect(apply("- [x] done", 0, 0, (s) => C.toggleLinePrefix(s, "task"))).toBe("|done");
    expect(apply("said", 0, 0, (s) => C.toggleLinePrefix(s, "quote"))).toBe("> |said");
  });

  it("set and clear headings", () => {
    expect(apply("Title", 0, 0, (s) => C.setHeading(s, 2))).toBe("## |Title");
    expect(apply("## Title", 3, 3, (s) => C.setHeading(s, 2))).toBe("|Title");
    expect(apply("# Title", 0, 0, (s) => C.setHeading(s, 3))).toBe("### |Title");
  });

  it("insert blocks on their own lines, with blank lines around them", () => {
    expect(apply("text", 2, 2, C.insertRule)).toBe("text\n\n---|");
    expect(apply("a\n\nb", 2, 2, (s) => C.insertBlock(s, "X"))).toBe("a\n\nX|\n\nb");
    expect(apply("a\n\n\n\nb", 2, 2, (s) => C.insertBlock(s, "X"))).toBe("a\n\nX|\n\n\nb");
    expect(apply("", 0, 0, (s) => C.insertCallout(s))).toBe("> [!note] Title\n> |");
    const table = EditorState.create({ doc: "x\ny" });
    const withTable = table.update(C.insertTable(table)).state;
    expect(withTable.doc.toString()).toBe("x\n\n| Column 1 | Column 2 |\n| -------- | -------- |\n|          |          |\n\ny");
    expect(withTable.selection.main.head).toBe(5);
  });

  it("make links, code and math from the selection", () => {
    // The selected part is shown in brackets: "url" is selected after the label.
    expect(apply("see docs here", 4, 8, C.insertLink)).toBe("see [docs]([url]) here");
    expect(apply("x", 1, 1, C.insertLink)).toBe("x[|](url)");
    expect(apply("a b", 2, 3, C.toggleCode)).toBe("a `[b]`");
    expect(apply("one\ntwo", 0, 7, C.toggleCode)).toBe("```\n[one\ntwo]\n```");
    expect(apply("e = mc2", 4, 7, C.insertMath)).toBe("e = $[mc2]$");
    expect(apply("", 0, 0, C.insertMath)).toBe("$$\n|\n$$");
  });
});

describe("slash menu", () => {
  it("offers each block once, and every item makes a change", () => {
    const labels = SLASH_ITEMS.map((i) => i.label);
    expect(new Set(labels).size).toBe(labels.length);
    for (const item of SLASH_ITEMS) {
      const state = EditorState.create({ doc: "line" });
      expect(state.update(item.run(state)).state.doc.toString(), item.label).not.toBe("line");
    }
  });
});
