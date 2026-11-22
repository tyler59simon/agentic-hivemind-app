import { Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { alignment, chunkAt, chunksOf, copyHunk, ignoreWhitespaceDiff, openFiles, stepChunk, type Side } from "./hunks";

/** Copy every change from `from` into the other side, one at a time as the tab does, and return what the other side
 *  holds at the end. It must equal the source. */
function copyAll(a: string, b: string, from: Side, ignore = false) {
  let left = a, right = b;
  for (let guard = 0; guard < 50; guard++) {
    const chunk = chunksOf(left, right, ignore)[0];
    if (!chunk) break;
    const done = copyHunk(chunk, from, left, right);
    if (done.to === "b") right = done.text;
    else left = done.text;
  }
  return { left, right };
}

describe("the changes between two texts", () => {
  it("finds replaced, added and deleted lines as separate changes", () => {
    const chunks = chunksOf("one\ntwo\nthree\nfour\n", "one\n2\nthree\nfour\nfive\n", false);
    expect(chunks).toHaveLength(2);
    // The first replaces "two" by "2".
    expect([chunks[0].fromA, chunks[0].toA, chunks[0].fromB, chunks[0].toB]).toEqual([4, 8, 4, 6]);
    expect(chunksOf("a\nb\nc\n", "a\nc\n", false)).toHaveLength(1);
    expect(chunksOf("same\n", "same\n", false)).toHaveLength(0);
  });

  it("can ignore whitespace: lines that differ only in it are the same line", () => {
    expect(chunksOf("a\n  b\nc\n", "a\nb\nc\n", false)).toHaveLength(1);
    expect(chunksOf("a\n  b\nc\n", "a\nb\nc\n", true)).toHaveLength(0);
    expect(chunksOf("x  y\n\ttabbed\n", "x y\n    tabbed\n", true)).toHaveLength(0);
    expect(chunksOf("ab\n", "a b\n", true)).toHaveLength(0);
    // A real change between lines that only differ in whitespace is still found, on the right lines.
    const chunks = chunksOf("a\n  b\nc\nd\n", "a\nb\nX\nd\n", true);
    expect(chunks).toHaveLength(1);
    expect([chunks[0].fromA, chunks[0].toA, chunks[0].fromB, chunks[0].toB]).toEqual([6, 8, 4, 6]);
  });

  it("falls back to the exact diff when there are too many distinct lines to compare", () => {
    const many = Array.from({ length: 70_000 }, (_, i) => `line ${i}`).join("\n");
    expect(ignoreWhitespaceDiff(many, `${many}\nextra`).length).toBeGreaterThan(0);
  });

  it("reports whitespace-only insertions and deletions of blank lines as unchanged when ignoring it", () => {
    expect(chunksOf("a\nb\n", "a\n\n   \nb\n", true)).toHaveLength(1);
    expect(chunksOf("a\n\nb\n", "a\nb\n", true)).toHaveLength(1);
  });
});

describe("copying a change across", () => {
  const cases: [string, string][] = [
    ["one\ntwo\nthree\n", "one\n2\nthree\n"],
    ["one\ntwo\nthree\n", "one\nthree\n"],
    ["one\nthree\n", "one\ntwo\nthree\n"],
    ["a\nb", "a\nB"],
    ["a\nb\n", "a\nb"],
    ["", "new\nlines\n"],
    ["old\nlines\n", ""],
    ["start\nmiddle\nend\n", "begin\nmiddle\nfinish\nextra\n"],
    ["x\n", "x\ny\nz"],
  ];

  it("turns one side into the other, in either direction, one change at a time", () => {
    for (const [a, b] of cases) {
      expect(copyAll(a, b, "a").right, `${JSON.stringify([a, b])} to the right`).toBe(a);
      expect(copyAll(a, b, "b").left, `${JSON.stringify([a, b])} to the left`).toBe(b);
    }
  });

  it("changes only the chosen change", () => {
    const a = "one\ntwo\nthree\nfour\n", b = "1\ntwo\n3\nfour\n";
    const [first, second] = chunksOf(a, b, false);
    expect(copyHunk(first, "a", a, b)).toEqual({ to: "b", text: "one\ntwo\n3\nfour\n" });
    expect(copyHunk(second, "a", a, b)).toEqual({ to: "b", text: "1\ntwo\nthree\nfour\n" });
    expect(copyHunk(first, "b", a, b)).toEqual({ to: "a", text: "1\ntwo\nthree\nfour\n" });
  });

  it("works when whitespace is ignored", () => {
    const a = "a\n  b\nc\n", b = "a\nb\nX\n";
    // Only the real difference is copied: the line that differs in whitespace keeps the right side's spacing.
    expect(copyAll(a, b, "a", true).right).toBe("a\nb\nc\n");
  });
});

describe("moving between changes", () => {
  it("wraps round in both directions and starts at either end", () => {
    expect(stepChunk(0, null, 1)).toBeNull();
    expect(stepChunk(3, null, 1)).toBe(0);
    expect(stepChunk(3, null, -1)).toBe(2);
    expect(stepChunk(3, 0, 1)).toBe(1);
    expect(stepChunk(3, 2, 1)).toBe(0);
    expect(stepChunk(3, 0, -1)).toBe(2);
    expect(stepChunk(3, 7, 1)).toBe(0);
  });

  it("finds the change a position is in, or the next one", () => {
    const chunks = chunksOf("a\nb\nc\nd\ne\n", "a\nB\nc\nd\nE\n", false);
    expect(chunkAt(chunks, "a", 0)).toBe(0);
    expect(chunkAt(chunks, "a", 2)).toBe(0);
    expect(chunkAt(chunks, "a", 5)).toBe(1);
    expect(chunkAt(chunks, "b", 8)).toBe(1);
    expect(chunkAt(chunks, "b", 99)).toBe(1);
    expect(chunkAt([], "a", 0)).toBeNull();
  });
});

describe("the files to pick from", () => {
  it("lists each open file once, in tab order, and no other kind of tab", () => {
    const tab = (id: string, kind: string, path?: string, title?: string) => ({ id, kind, file: path ? { notebook: "nb-1", path } : undefined, title }) as never;
    const list = openFiles([
      { tabs: [tab("1", "file", "a.txt"), tab("2", "note"), tab("3", "file", "b.md", "B page")] },
      { tabs: [tab("4", "file", "a.txt"), tab("5", "new-file"), tab("6", "file", "dir/c.log")] },
    ]);
    expect(list.map((c) => c.label)).toEqual(["a.txt", "B page", "c.log"]);
    expect(list.map((c) => c.ref.path)).toEqual(["a.txt", "b.md", "dir/c.log"]);
  });
});

/** The rows each line of a side lands on, with the gaps in: the model of what the view draws. */
function rowsOf(text: string, gaps: ReturnType<typeof alignment>, side: "a" | "b") {
  const doc = Text.of(text.split("\n"));
  const mine = gaps.filter((g) => g.side === side);
  const rows: number[] = [];
  let row = 0;
  for (let n = 1; n <= doc.lines; n++) {
    for (const g of mine) if (!g.below && g.pos === doc.line(n).from) row += g.lines;
    rows.push(row++);
  }
  for (const g of mine) if (g.below) row += g.lines;
  return { rows, total: row };
}

/** Every line outside a change, in order, on each side. */
function unchangedLines(a: string, b: string, ignore = false) {
  const chunks = chunksOf(a, b, ignore);
  const da = Text.of(a.split("\n")), db = Text.of(b.split("\n"));
  const outside = (doc: Text, n: number, side: "a" | "b") => !chunks.some((c) => {
    const from = side === "a" ? c.fromA : c.fromB, to = side === "a" ? c.toA : c.toB;
    return to > from && doc.line(n).from >= from && doc.line(n).from < to;
  });
  const la = Array.from({ length: da.lines }, (_, i) => i + 1).filter((n) => outside(da, n, "a"));
  const lb = Array.from({ length: db.lines }, (_, i) => i + 1).filter((n) => outside(db, n, "b"));
  return { chunks, la, lb };
}

describe("keeping the two sides line for line", () => {
  const eight = "one\ntwo\nthree\nfour\napple\nfive\nsix\ncherry\n";
  const four = "apple\nbanana\nplum\ncherry\n";

  it("pads the shorter side so that each unchanged line has the same row on both", () => {
    const check = (a: string, b: string, ignore = false) => {
      const { chunks, la, lb } = unchangedLines(a, b, ignore);
      const gaps = alignment(chunks, Text.of(a.split("\n")), Text.of(b.split("\n")));
      const ra = rowsOf(a, gaps, "a"), rb = rowsOf(b, gaps, "b");
      expect(la.length, "twins").toBe(lb.length);
      la.forEach((n, i) => expect(ra.rows[n - 1], `line ${n} of ${JSON.stringify(a)} against line ${lb[i]} of ${JSON.stringify(b)}`).toBe(rb.rows[lb[i] - 1]));
      expect(ra.total, "the sides end on the same row").toBe(rb.total);
      return gaps;
    };
    // The case that was reported: "cherry" ends both files and must sit on one row.
    const gaps = check(eight, four);
    expect(gaps.some((g) => g.side === "b" && g.lines > 0)).toBe(true);
    for (const [a, b] of [
      ["one\ntwo\nthree\n", "one\n2\nthree\n"], ["one\ntwo\nthree\n", "one\nthree\n"], ["one\nthree\n", "one\ntwo\nthree\n"],
      ["a\nb", "a\nB"], ["a\nb\n", "a\nb"], ["", "new\nlines\n"], ["old\nlines\n", ""], ["x\n", "x\ny\nz"],
      ["start\nmiddle\nend\n", "begin\nmiddle\nfinish\nextra\n"], [four, eight],
      ["a\nb\nc\nd\ne\nf\n", "a\nX\nY\nZ\nd\ne\nf\n"], ["a\nb\nc\nd\ne\n", "a\ne\n"], ["keep\n", "keep\nmore\nand more"],
    ]) check(a, b);
    check("a\n  b\nc\nd\n", "a\nb\nX\nY\nZ\nd\n", true);
  });

  it("gives equal files no gaps, and sizes a gap by the lines one side lacks", () => {
    expect(alignment(chunksOf("same\n", "same\n", false), Text.of(["same", ""]), Text.of(["same", ""]))).toEqual([]);
    const a = "x\ny\nz\n", b = "x\nz\n";
    expect(alignment(chunksOf(a, b, false), Text.of(a.split("\n")), Text.of(b.split("\n")))).toEqual([{ side: "b", pos: 2, lines: 1, below: false }]);
    // Three lines changed into one: the side with one gets two lines of gap.
    const c = "a\nb\nc\nd\n", d = "a\nQ\nd\n";
    expect(alignment(chunksOf(c, d, false), Text.of(c.split("\n")), Text.of(d.split("\n")))).toEqual([{ side: "b", pos: 4, lines: 1, below: false }]);
    const e = "a\nb\nc\nd\ne\n", f = "a\nQ\ne\n";
    expect(alignment(chunksOf(e, f, false), Text.of(e.split("\n")), Text.of(f.split("\n")))).toEqual([{ side: "b", pos: 4, lines: 2, below: false }]);
  });

  it("scales to a large pair of files", () => {
    const base = Array.from({ length: 20_000 }, (_, i) => `line ${i}`);
    const other = base.filter((_, i) => i % 7 !== 0 && i % 11 !== 3).concat(["tail"]);
    const a = `${base.join("\n")}\n`, b = `${other.join("\n")}\n`;
    const started = performance.now();
    const gaps = alignment(chunksOf(a, b, false), Text.of(a.split("\n")), Text.of(b.split("\n")));
    expect(gaps.length).toBeGreaterThan(0);
    expect(performance.now() - started).toBeLessThan(30_000);
    // Even when the diff gives up on detail and reports big changes, both sides end on the same row.
    expect(rowsOf(a, gaps, "a").total).toBe(rowsOf(b, gaps, "b").total);
  }, 60_000);
});
