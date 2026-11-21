// NS-3C: formulas in table cells. The parser and evaluator work on a grid of text; no `eval` is involved.
import { describe, expect, it } from "vitest";
import { columnLabel, isFormula, parseFormula, plainNumber, Sheet, showCell, showResult, type Grid } from "./formulas";

interface Merge { row: number; col: number; rows?: number; cols?: number }

/** A grid of cell texts; a merge covers a block of positions with the cell at its top left. */
function grid(rows: string[][], merges: Merge[] = []): Grid {
  const origin = (r: number, c: number): [number, number] => {
    const m = merges.find((x) => r >= x.row && r < x.row + (x.rows ?? 1) && c >= x.col && c < x.col + (x.cols ?? 1));
    return m ? [m.row, m.col] : [r, c];
  };
  return { rows: rows.length, cols: Math.max(...rows.map((r) => r.length)), origin, text: (r, c) => rows[r]?.[c] ?? "" };
}

/** The value of `formula` placed in a new column at the end of the first row of `rows`. */
const calc = (formula: string, rows: string[][] = [[]], merges: Merge[] = []) => {
  const cells = rows.map((r) => [...r]);
  const col = cells[0].length;
  cells[0].push(formula);
  return showCell(new Sheet(grid(cells, merges)), 0, col);
};

describe("the parser", () => {
  it("reads numbers, operators with their precedence, parentheses and unary minus", () => {
    expect(calc("=1+2*3")).toBe("7");
    expect(calc("=(1+2)*3")).toBe("9");
    expect(calc("=-4+10/4")).toBe("-1.5");
    expect(calc("=2 - -3")).toBe("5");
    expect(calc("=2*-(1+1)")).toBe("-4");
    expect(calc("=.5+1.25")).toBe("1.75");
    expect(calc("=+3")).toBe("3");
  });

  it("works out a tree for a reference, a range and a call", () => {
    expect(parseFormula("=SUM(A1:B2, 3)")).toEqual({
      k: "call", name: "SUM", args: [{ k: "range", a: { row: 0, col: 0 }, b: { row: 1, col: 1 } }, { k: "num", v: 3 }],
    });
    expect(parseFormula("=a1")).toEqual({ k: "ref", at: { row: 0, col: 0 } });
    expect(parseFormula("=AA10")).toEqual({ k: "ref", at: { row: 9, col: 26 } });
  });

  it("does not parse what is not a formula of this language", () => {
    for (const bad of ["=", "=1+", "=(1", "=1)", "=SUM(", "=SUM()", "=1 2", "=A1B2", "=foo", "=1;2", "=eval('1')", "=A1:", "=A1:5", "=\"x\"", "=1+*2"]) {
      expect(parseFormula(bad), bad).toBeNull();
    }
  });

  it("knows which text is a formula, which is a number, and column letters", () => {
    expect(isFormula("=1")).toBe(true);
    expect(isFormula(" =1")).toBe(false);
    expect(plainNumber(" 12.5 ")).toBe(12.5);
    expect(plainNumber("-3")).toBe(-3);
    expect(plainNumber("12 apples")).toBeNull();
    expect(plainNumber("")).toBeNull();
    expect([0, 25, 26, 27, 701, 702].map(columnLabel)).toEqual(["A", "Z", "AA", "AB", "ZZ", "AAA"]);
  });
});

describe("the evaluator", () => {
  const data = [["", "10", "x"], ["2", "", "4"], ["6", "7.5", ""]];

  it("sums, averages, counts and finds the smallest and largest over ranges and lists", () => {
    expect(calc("=SUM(A2:A3)", data)).toBe("8");
    expect(calc("=SUM(A2:C3)", data)).toBe("19.5");
    expect(calc("=AVG(A2:A3, 10)", data)).toBe("6");
    expect(calc("=MIN(A2:C3)", data)).toBe("2");
    expect(calc("=MAX(B1, A2, 1+1)", data)).toBe("10");
    expect(calc("=COUNT(A1:C3)", data)).toBe("5");
    expect(calc("=sum(a2:a3)", data)).toBe("8");
    expect(calc("=SUM(A2:A3)+B1*2", data)).toBe("28");
  });

  it("skips blank and text cells in the functions, and finds them a #VALUE! in arithmetic", () => {
    expect(calc("=SUM(B1:C1)", data)).toBe("10");
    expect(calc("=B2+1", data)).toBe("#VALUE!");
    expect(calc("=C1*2", data)).toBe("#VALUE!");
    expect(calc("=B1+A2", data)).toBe("12");
  });

  it("an empty selection sums to 0, has no average, and a smallest of 0", () => {
    expect(calc("=SUM(B2:B2)", data)).toBe("0");
    expect(calc("=COUNT(B2:B2)", data)).toBe("0");
    expect(calc("=MIN(B2:B2)", data)).toBe("0");
    expect(calc("=MAX(B2:B2)", data)).toBe("0");
    expect(calc("=AVG(B2:B2)", data)).toBe("#DIV/0!");
  });

  it("every error has its own value", () => {
    expect(calc("=1/0", data)).toBe("#DIV/0!");
    expect(calc("=A2/(A3-6)", data)).toBe("#DIV/0!");
    expect(calc("=Z9", data)).toBe("#REF!");
    expect(calc("=A0", data)).toBe("#REF!");
    expect(calc("=SUM(A2:A99)", data)).toBe("#REF!");
    expect(calc("=SUM(A2:A3", data)).toBe("#VALUE!");
    expect(calc("=NOPE(1)", data)).toBe("#VALUE!");
    expect(calc("=A2:A3", data)).toBe("#VALUE!");
    expect(calc("=1e999+1", data)).toBe("#VALUE!");
  });

  it("an error in a cell reaches every formula that reads it", () => {
    const g = grid([["=1/0", "=A1+1", "=SUM(A1:B1)", "=COUNT(A1)"]]);
    const sheet = new Sheet(g);
    expect([0, 1, 2, 3].map((c) => showCell(sheet, 0, c))).toEqual(["#DIV/0!", "#DIV/0!", "#DIV/0!", "#DIV/0!"]);
  });

  it("a formula reads another formula's value, whatever the order", () => {
    const sheet = new Sheet(grid([["=B1*2", "=C1+1", "4"]]));
    expect(showCell(sheet, 0, 0)).toBe("10");
    expect(showCell(sheet, 0, 1)).toBe("5");
    expect(showCell(sheet, 0, 2)).toBeNull();
  });

  it("finds cycles: a cell that reads itself, two that read each other, and a longer ring", () => {
    const sheet = new Sheet(grid([["=A1+1", "=C1", "=B1", "=A2"], ["=A1", "=SUM(A1:D1)", "1", "2"]]));
    expect(showCell(sheet, 0, 0)).toBe("#CYCLE!");
    expect(showCell(sheet, 0, 1)).toBe("#CYCLE!");
    expect(showCell(sheet, 0, 2)).toBe("#CYCLE!");
    // Reading a cell in a cycle is an error too, while a cell beside the ring is untouched.
    expect(showCell(sheet, 1, 0)).toBe("#CYCLE!");
    expect(showCell(sheet, 1, 1)).toBe("#CYCLE!");
    const clear = new Sheet(grid([["=B1", "=C1", "3", "=A1+B1"]]));
    expect([0, 1, 3].map((c) => showCell(clear, 0, c))).toEqual(["3", "3", "6"]);
  });

  it("a reference to a covered cell reads the merged cell, and a range counts a merged cell once", () => {
    const rows = [["5", "", "=B1+1"], ["", "", "=SUM(A1:B2)"], ["", "", "=SUM(A1:A2)"]];
    // A1:B2 is one merged cell holding 5.
    const merges = [{ row: 0, col: 0, rows: 2, cols: 2 }];
    const sheet = new Sheet(grid(rows, merges));
    expect(showCell(sheet, 0, 2)).toBe("6");
    expect(showCell(sheet, 1, 2)).toBe("5");
    expect(showCell(sheet, 2, 2)).toBe("5");
    // Asking for a covered position gives the merged cell's own value.
    expect(showCell(new Sheet(grid([["=2+3", ""]], [{ row: 0, col: 0, cols: 2 }])), 0, 1)).toBe("5");
  });

  it("shows results without floating point noise", () => {
    expect(showResult({ value: 0.1 + 0.2 })).toBe("0.3");
    expect(showResult({ value: 1 / 3 })).toBe("0.333333333333");
    expect(showResult({ value: 42 })).toBe("42");
    expect(showResult({ error: "#REF!" })).toBe("#REF!");
  });
});

describe("long chains of formulas", () => {
  const isError = (r: string | null) => !!r && r.startsWith("#");

  it("a running total over 5,000 rows works out, whichever cell is asked for first", () => {
    const n = 5000;
    // Column A holds 1 to n; column B is the running total: B1 is A1, and each row adds its A to the row above.
    const rows = Array.from({ length: n }, (_, i) => [String(i + 1), i === 0 ? "=A1" : `=B${i}+A${i + 1}`]);
    const sheet = new Sheet(grid(rows));
    expect(() => showCell(sheet, n - 1, 1)).not.toThrow();
    expect(showCell(sheet, n - 1, 1)).toBe(String((n * (n + 1)) / 2));
    expect(showCell(sheet, 0, 1)).toBe("1");
    expect(showCell(sheet, 99, 1)).toBe("5050");
    // And a total that reads the rows below it, worked out from the bottom.
    const up = Array.from({ length: 3000 }, (_, i) => [i === 2999 ? "=0" : `=A${i + 2}+1`]);
    expect(showCell(new Sheet(grid(up)), 0, 0)).toBe("2999");
  });

  it("formulas that read the cell above and the cell beside it across a few thousand rows work out", () => {
    const n = 3000;
    const rows = Array.from({ length: n }, (_, i) => [i === 0 ? "=1" : `=A${i}+1`, i === 0 ? "=A1" : `=C${i}+A${i + 1}`, i === 0 ? "=B1" : `=B${i + 1}`]);
    const sheet = new Sheet(grid(rows));
    expect(() => showCell(sheet, n - 1, 2)).not.toThrow();
    expect(showCell(sheet, n - 1, 0)).toBe(String(n));
    expect(showCell(sheet, n - 1, 2)).toBe(String((n * (n + 1)) / 2));
  });

  it("a chain built to defeat the order the sheet works in gives an error value, never an exception", () => {
    // Each formula reads the one before it in the chain, which starts at a constant. The sheet works its formulas out in
    // reading order and then in reverse, so the rows are laid out against both: the first rows hold the far end of the
    // chain (in increasing order, so reading order never finds a known cell within reach), the last 301 hold its start.
    const n = 3000;
    const rowOf = (k: number) => (k >= 301 ? k - 301 : n - 301 + k);
    const rows = Array.from({ length: n }, () => [""]);
    for (let k = 0; k < n; k++) rows[rowOf(k)][0] = k === 0 ? "=1" : `=A${rowOf(k - 1) + 1}+1`;
    const sheet = new Sheet(grid(rows));
    let shown: string | null = null;
    expect(() => { shown = showCell(sheet, rowOf(n - 1), 0); }).not.toThrow();
    expect(isError(shown)).toBe(true);
    // The cells within reach of the start are fine, and asking again gives the same answer.
    expect(showCell(sheet, rowOf(10), 0)).toBe("11");
    expect(showCell(sheet, rowOf(300), 0)).toBe("301");
    expect(showCell(sheet, rowOf(n - 1), 0)).toBe(shown);
  });

  it("a formula too long or too deeply nested to walk is an error value, and the sheet goes on", () => {
    const deep = `=${"(".repeat(50_000)}1${")".repeat(50_000)}`;
    const long = `=1${"+1".repeat(6000)}`;
    const sheet = new Sheet(grid([[deep, long, "=1+1"]]));
    expect(() => showCell(sheet, 0, 0)).not.toThrow();
    expect(showCell(sheet, 0, 0)).toBe("#VALUE!");
    expect(showCell(sheet, 0, 1)).toBe("#VALUE!");
    expect(showCell(sheet, 0, 2)).toBe("2");
    const wide = new Sheet(grid([[`=1${"+1".repeat(3000)}`]]));
    expect(() => showCell(wide, 0, 0)).not.toThrow();
  });
});
