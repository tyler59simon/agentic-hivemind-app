import { history, undo } from "@codemirror/commands";
import { EditorSelection, EditorState, type Transaction } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import {
  joinLines, LINE_TOOLS, lineTool, removeDuplicates, runLineTool, sortLines, spacesToTabs, tabsToSpaces, titleCase, trimTrailing, type Target,
} from "./lineTools";

/** An editor stand-in: a state that takes the transactions tools dispatch. */
function editor(doc: string, selection?: { anchor: number; head?: number }[], readOnly = false): Target {
  const target: Target = {
    state: EditorState.create({
      doc,
      selection: selection ? EditorSelection.create(selection.map((s) => EditorSelection.range(s.anchor, s.head ?? s.anchor))) : undefined,
      extensions: [history(), EditorState.allowMultipleSelections.of(true), EditorState.readOnly.of(readOnly)],
    }),
    dispatch: (tr: Transaction) => { target.state = tr.state; },
  };
  return target;
}
const run = (id: string, doc: string, selection?: { anchor: number; head?: number }[]) => {
  const t = editor(doc, selection);
  const changed = runLineTool(t, lineTool(id)!);
  return { changed, text: t.state.doc.toString(), target: t };
};

describe("the transforms", () => {
  it("sorts four ways", () => {
    const lines = ["banana", "Apple", "cherry", "apple", "10", "9", ""];
    expect(sortLines(lines, "ascending")).toEqual(["", "10", "9", "Apple", "apple", "banana", "cherry"]);
    expect(sortLines(lines, "descending")).toEqual(["cherry", "banana", "apple", "Apple", "9", "10", ""]);
    // Ignoring case: Apple and apple tie and keep their old order.
    expect(sortLines(lines, "insensitive")).toEqual(["", "10", "9", "Apple", "apple", "banana", "cherry"]);
    expect(sortLines(["b", "B", "a", "A"], "insensitive")).toEqual(["a", "A", "b", "B"]);
    // By number: 9 before 10, and lines with no number stay at the end in their order.
    expect(sortLines(["10 ten", "x second", "9 nine", "  -3 minus", "w first", "2.5 half"], "numeric")).toEqual(["  -3 minus", "2.5 half", "9 nine", "10 ten", "x second", "w first"]);
  });

  it("compares letters outside ASCII sensibly when ignoring case", () => {
    expect(sortLines(["Éclair", "zèbre", "école", "Zebra"], "insensitive")).toEqual(["zèbre", "Zebra", "école", "Éclair"].sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1)));
    expect(sortLines(["Ωmega", "ωmega", "alpha"], "insensitive")).toEqual(["alpha", "Ωmega", "ωmega"]);
  });

  it("removes duplicates keeping the first of each, blank lines included", () => {
    expect(removeDuplicates(["a", "", "b", "a", "", "c", "b"])).toEqual(["a", "", "b", "c"]);
    expect(removeDuplicates(["a", "A"])).toEqual(["a", "A"]);
    expect(removeDuplicates([])).toEqual([]);
  });

  it("trims spaces and tabs at line ends only", () => {
    expect(trimTrailing(["a  ", "\tb\t \t", "  c", "", "   "])).toEqual(["a", "\tb", "  c", "", ""]);
  });

  it("joins lines with one space and no blank pieces", () => {
    expect(joinLines(["a  ", "  b", "", "   ", "c"])).toBe("a b c");
    expect(joinLines(["  indented", "next"])).toBe("  indented next");
    expect(joinLines([""])).toBe("");
  });

  it("changes tabs to spaces by tab stop and back for indentation", () => {
    expect(tabsToSpaces(["\tx", "ab\tc", "\t\ty", "none"], 4)).toEqual(["    x", "ab  c", "        y", "none"]);
    expect(spacesToTabs(["    x", "      y", "  z", "a    b"], 4)).toEqual(["\tx", "\t  y", "  z", "a    b"]);
    const original = ["\tone", "\t\ttwo", "three"];
    expect(spacesToTabs(tabsToSpaces(original, 4), 4)).toEqual(original);
  });

  it("makes title case from the first letter of each word, outside ASCII too", () => {
    expect(titleCase("hELLO wORLD")).toBe("Hello World");
    expect(titleCase("o'neil's école élève")).toBe("O'neil's École Élève");
    expect(titleCase("3rd place, über-cool")).toBe("3rd Place, Über-Cool");
    expect(titleCase("")).toBe("");
  });
});

describe("the tools on an editor", () => {
  it("sort the whole file when nothing is selected and keep a trailing newline", () => {
    expect(run("sort-asc", "c\nb\na\n").text).toBe("a\nb\nc\n");
    expect(run("sort-desc", "a\nb\nc").text).toBe("c\nb\na");
    // Blank lines sort first; the trailing newline is not a line, so it stays at the end.
    expect(run("sort-asc", "c\n\nb\n\n\n").text).toBe("\n\n\nb\nc\n");
  });

  it("sort only the lines a selection touches, whole lines, and leave the rest", () => {
    // Lines: d, c, b, a; the selection runs from the start of "c" to the end of "b".
    const doc = "d\nc\nb\na\n";
    expect(run("sort-asc", doc, [{ anchor: 2, head: 5 }]).text).toBe("d\nb\nc\na\n");
    // A selection that ends at the start of a line does not include that line.
    expect(run("sort-asc", doc, [{ anchor: 0, head: 4 }]).text).toBe("c\nd\nb\na\n");
    // Two separate selections are sorted on their own.
    expect(run("sort-asc", "b\na\nz\ny\n", [{ anchor: 0, head: 3 }, { anchor: 4, head: 7 }]).text).toBe("a\nb\ny\nz\n");
  });

  it("do nothing on an empty file, and say so when nothing would change", () => {
    for (const tool of LINE_TOOLS.filter((t) => t.plan)) {
      expect(run(tool.id, "").changed, tool.id).toBe(false);
    }
    expect(run("sort-asc", "a\nb\n").changed).toBe(false);
    expect(run("trim", "clean\n").changed).toBe(false);
    expect(run("dedupe", "only\n").changed).toBe(false);
  });

  it("remove duplicate lines and trim trailing spaces, in the file or in a selection", () => {
    expect(run("dedupe", "a\nb\na\n\nb\n\n").text).toBe("a\nb\n\n");
    expect(run("trim", "a  \n  b \t\n\nc\n").text).toBe("a\n  b\n\nc\n");
    // Only the selected lines are trimmed.
    expect(run("trim", "a  \nb  \nc  \n", [{ anchor: 4, head: 6 }]).text).toBe("a  \nb\nc  \n");
  });

  it("join the whole selection, or a cursor's line with the next", () => {
    expect(run("join", "a\n  b\nc\nd\n", [{ anchor: 0, head: 8 }]).text).toBe("a b c\nd\n");
    expect(run("join", "a\nb\nc\n", [{ anchor: 0 }]).text).toBe("a b\nc\n");
    // Cursors on the last line have no next line.
    expect(run("join", "a\nb", [{ anchor: 3 }]).changed).toBe(false);
    // Two cursors on separate pairs.
    expect(run("join", "a\nb\nc\nd\n", [{ anchor: 0 }, { anchor: 4 }]).text).toBe("a b\nc d\n");
  });

  it("change case of the selection, or of every line with no selection", () => {
    expect(run("upper", "straße\nécole\n").text).toBe("STRASSE\nÉCOLE\n");
    expect(run("lower", "ÉCOLE İ\n").text).toBe("école i̇\n");
    expect(run("title", "hELLO wORLD\nfoo bar\n").text).toBe("Hello World\nFoo Bar\n");
    // Exactly the selected characters.
    expect(run("upper", "abc def\nghi\n", [{ anchor: 2, head: 9 }]).text).toBe("abC DEF\nGhi\n");
    // Several ranges.
    expect(run("upper", "ab cd ef", [{ anchor: 0, head: 2 }, { anchor: 6, head: 8 }]).text).toBe("AB cd EF");
  });

  it("change tabs and indentation, per line, leaving cursors where they were", () => {
    const t = editor("\ta\n\t\tb\nplain\n", [{ anchor: 2 }]);
    expect(runLineTool(t, lineTool("tabs-to-spaces")!)).toBe(true);
    expect(t.state.doc.toString()).toBe("    a\n        b\nplain\n");
    expect(runLineTool(t, lineTool("spaces-to-tabs")!)).toBe(true);
    expect(t.state.doc.toString()).toBe("\ta\n\t\tb\nplain\n");
  });

  it("duplicate and move lines", () => {
    expect(run("duplicate", "a\nb\n", [{ anchor: 0 }]).text).toBe("a\na\nb\n");
    expect(run("move-down", "a\nb\nc\n", [{ anchor: 0 }]).text).toBe("b\na\nc\n");
    expect(run("move-up", "a\nb\nc\n", [{ anchor: 2 }]).text).toBe("b\na\nc\n");
    expect(run("move-up", "a\nb\n", [{ anchor: 0 }]).changed).toBe(false);
  });

  it("never change a read-only file", () => {
    const t = editor("b\na\n", undefined, true);
    for (const tool of LINE_TOOLS) expect(runLineTool(t, tool), tool.id).toBe(false);
    expect(t.state.doc.toString()).toBe("b\na\n");
  });

  it("each run is one undo step", () => {
    const samples: Record<string, [string, { anchor: number; head?: number }[]?]> = {
      "sort-asc": ["c\nb\na\n"], "sort-desc": ["a\nb\nc\n"], "sort-insensitive": ["b\nA\na\n"], "sort-numeric": ["10\n9\n"],
      dedupe: ["a\na\nb\n"], trim: ["a  \nb  \n"], join: ["a\nb\nc\n", [{ anchor: 0, head: 5 }]], upper: ["abc\ndef\n"], lower: ["ABC\nDEF\n"], title: ["abc def\nghi\n"],
      "tabs-to-spaces": ["\ta\n\tb\n"], "spaces-to-tabs": ["    a\n    b\n"], duplicate: ["a\n", [{ anchor: 0 }]], "move-down": ["a\nb\n", [{ anchor: 0 }]], "move-up": ["a\nb\n", [{ anchor: 2 }]],
    };
    expect(Object.keys(samples).sort()).toEqual(LINE_TOOLS.map((t) => t.id).sort());
    for (const [id, [doc, selection]] of Object.entries(samples)) {
      const t = editor(doc, selection);
      expect(runLineTool(t, lineTool(id)!), id).toBe(true);
      expect(t.state.doc.toString(), id).not.toBe(doc);
      expect(undo(t), id).toBe(true);
      expect(t.state.doc.toString(), id).toBe(doc);
    }
  });
});

describe("a large file", () => {
  // 200,000 lines, about 5 MB; the bounds are generous because the test machine is slow.
  const lines = Array.from({ length: 200_000 }, (_, i) => `${(i * 7919) % 100_003} line ${i % 5000} ${i % 3 ? "  " : ""}`);
  const doc = `${lines.join("\n")}\n`;
  // One state for every tool: a state does not change when a tool runs on it, and building one is a good part of the time.
  const base = editor(doc).state;
  const on = (selection?: { anchor: number; head?: number }[]): Target => {
    const t = editor("");
    t.state = selection ? base.update({ selection: EditorSelection.create(selection.map((r) => EditorSelection.range(r.anchor, r.head ?? r.anchor))) }).state : base;
    return t;
  };
  const times: Record<string, number> = {};

  it("stays responsive for every tool", () => {
    for (const tool of LINE_TOOLS.filter((t) => t.plan)) {
      const t = on();
      const started = performance.now();
      runLineTool(t, tool);
      times[tool.id] = Math.round(performance.now() - started);
      expect(performance.now() - started, `${tool.id} took ${times[tool.id]} ms`).toBeLessThan(20_000);
    }
    // Select all, then join everything into one line.
    const all = on([{ anchor: 0, head: doc.length }]);
    const started = performance.now();
    runLineTool(all, lineTool("join")!);
    times["join, whole file selected"] = Math.round(performance.now() - started);
    expect(performance.now() - started).toBeLessThan(20_000);
    expect(all.state.doc.lines).toBe(2);
    console.info(`line tools on 200,000 lines (ms): ${JSON.stringify(times)}`);
  }, 120_000);

  it("sorts the whole file correctly", () => {
    const t = on();
    runLineTool(t, lineTool("sort-asc")!);
    const out = t.state.doc.toString();
    expect(out.endsWith("\n")).toBe(true);
    const sorted = out.slice(0, -1).split("\n");
    expect(sorted).toEqual(lines.slice().sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    expect(undo(t)).toBe(true);
    expect(t.state.doc.toString()).toBe(doc);
  }, 120_000);
});
