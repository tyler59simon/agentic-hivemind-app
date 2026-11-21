// Formulas in table cells (NS-3C). A cell whose text starts with `=` holds a formula; the stored text is the formula.
// Numbers, `+ - * /`, parentheses, unary minus, A1 references and ranges within the table, and SUM, AVG, MIN, MAX and
// COUNT over ranges and lists. A small tokenizer, parser and evaluator: nothing here evaluates text as code.

export type ErrorCode = "#REF!" | "#CYCLE!" | "#VALUE!" | "#DIV/0!";
export type Result = { value: number } | { error: ErrorCode };

/** The table as a grid of the cells the reader sees: a merged cell covers several positions and is one cell. */
export interface Grid {
  rows: number;
  cols: number;
  /** The text of the cell covering (row, col). */
  text(row: number, col: number): string;
  /** The top-left position of the cell covering (row, col). */
  origin(row: number, col: number): [number, number];
}

export const isFormula = (text: string) => text.startsWith("=");

const NUMBER = /^[+-]?(\d+(\.\d*)?|\.\d+)$/;

/** A plain cell's value: a number, or null for text and blank cells (which the functions skip). */
export function plainNumber(text: string): number | null {
  const t = text.trim();
  return NUMBER.test(t) ? Number(t) : null;
}

// ---- Tokens ----

type Token = { t: "num"; v: number } | { t: "ref"; row: number; col: number } | { t: "name"; v: string } | { t: "op"; v: string };

class Syntax extends Error {}

/** A column's letters: A for the first, Z for the 26th, then AA. */
export function columnLabel(index: number): string {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    out = String.fromCharCode(65 + ((n - 1) % 26)) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

const letters = (s: string) => [...s.toUpperCase()].reduce((n, c) => n * 26 + (c.charCodeAt(0) - 64), 0) - 1;

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t") { i++; continue; }
    if ("+-*/(),:".includes(c)) { out.push({ t: "op", v: c }); i++; continue; }
    const num = /^(\d+(\.\d*)?|\.\d+)/.exec(src.slice(i));
    if (num) { out.push({ t: "num", v: Number(num[0]) }); i += num[0].length; continue; }
    const word = /^[A-Za-z][A-Za-z0-9]*/.exec(src.slice(i));
    if (!word) throw new Syntax();
    const w = word[0];
    const ref = /^([A-Za-z]{1,3})(\d+)$/.exec(w);
    if (ref) out.push({ t: "ref", col: letters(ref[1]), row: Number(ref[2]) - 1 });
    else if (/^[A-Za-z]+$/.test(w)) out.push({ t: "name", v: w.toUpperCase() });
    else throw new Syntax();
    i += w.length;
  }
  return out;
}

// ---- Syntax tree ----

type Cell = { row: number; col: number };
export type Expr =
  | { k: "num"; v: number }
  | { k: "ref"; at: Cell }
  | { k: "range"; a: Cell; b: Cell }
  | { k: "neg"; e: Expr }
  | { k: "bin"; op: "+" | "-" | "*" | "/"; l: Expr; r: Expr }
  | { k: "call"; name: string; args: Expr[] };

/** The formula text after `=` as a tree. Throws when it does not parse. */
function parse(src: string): Expr {
  const tokens = tokenize(src);
  let i = 0;
  const peek = () => tokens[i];
  const op = (v: string) => { const t = tokens[i]; if (t?.t === "op" && t.v === v) { i++; return true; } return false; };
  const expr = (): Expr => {
    let left = term();
    for (;;) {
      const t = peek();
      if (t?.t === "op" && (t.v === "+" || t.v === "-")) { i++; left = { k: "bin", op: t.v, l: left, r: term() }; } else return left;
    }
  };
  const term = (): Expr => {
    let left = unary();
    for (;;) {
      const t = peek();
      if (t?.t === "op" && (t.v === "*" || t.v === "/")) { i++; left = { k: "bin", op: t.v, l: left, r: unary() }; } else return left;
    }
  };
  const unary = (): Expr => {
    if (op("-")) return { k: "neg", e: unary() };
    if (op("+")) return unary();
    return primary();
  };
  const primary = (): Expr => {
    const t = tokens[i++];
    if (!t) throw new Syntax();
    if (t.t === "num") return { k: "num", v: t.v };
    if (t.t === "ref") {
      const a = { row: t.row, col: t.col };
      if (op(":")) {
        const end = tokens[i++];
        if (end?.t !== "ref") throw new Syntax();
        return { k: "range", a, b: { row: end.row, col: end.col } };
      }
      return { k: "ref", at: a };
    }
    if (t.t === "name") {
      if (!op("(")) throw new Syntax();
      const args = [expr()];
      while (op(",")) args.push(expr());
      if (!op(")")) throw new Syntax();
      return { k: "call", name: t.v, args };
    }
    if (t.v === "(") {
      const e = expr();
      if (!op(")")) throw new Syntax();
      return e;
    }
    throw new Syntax();
  };
  const tree = expr();
  if (i < tokens.length) throw new Syntax();
  return tree;
}

/** The formula `text` (starting with `=`) as a tree, or null when it does not parse. */
export function parseFormula(text: string): Expr | null {
  try { return parse(text.slice(1)); } catch { return null; }
}

// ---- Evaluation ----

const error = (code: ErrorCode): Result => ({ error: code });
const finite = (n: number): Result => (Number.isFinite(n) ? { value: n } : error("#VALUE!"));

/** How many formulas may read one another in a chain before the rest of the chain is an error. Each link is a few stack
 *  frames, so the limit keeps a long chain from overflowing the stack. */
const MAX_DEPTH = 300;
/** The longest formula worked out: a longer one is far past anything typed, and its tree would be too deep to walk. */
const MAX_FORMULA = 10_000;

/** One table's values, worked out on demand and kept. Looking a value up never throws: whatever cannot be worked out is
 *  an error value. */
export class Sheet {
  private done = new Map<string, Result | null>();
  private open = new Set<string>();
  /** Each formula's tree, read once: a value that is worked out again (see `capped`) is not parsed again. */
  private trees = new Map<string, Expr | null>();
  private depth = 0;
  /** How many times a chain hit the depth limit. A value worked out while that happened is not kept: it says where the
   *  lookup began, not what the cell holds. */
  private capped = 0;
  private warmed = false;
  constructor(private grid: Grid) {}

  /** The value of the formula cell at (row, col), or null when that cell holds no formula. */
  at(row: number, col: number): Result | null {
    // The first lookup works out every formula in reading order, and then in the opposite order. A formula usually reads
    // cells above and to the left of it (a running total reads the one before), so each is one step from values already
    // known, where asking for the last of a long column first would walk the whole chain at once; a total that reads the
    // rows below it is the same in reverse.
    if (!this.warmed) {
      this.warmed = true;
      const cells = this.grid.rows * this.grid.cols;
      for (const forward of [true, false]) {
        for (let i = 0; i < cells; i++) {
          const n = forward ? i : cells - 1 - i;
          const r = Math.floor(n / this.grid.cols), c = n % this.grid.cols;
          const [or, oc] = this.grid.origin(r, c);
          if (or === r && oc === c) this.resolve(r, c);
        }
      }
    }
    return this.resolve(row, col);
  }

  private resolve(row: number, col: number): Result | null {
    const [r, c] = this.grid.origin(row, col);
    const key = `${r},${c}`;
    if (this.done.has(key)) return this.done.get(key) ?? null;
    const text = this.grid.text(r, c);
    if (!isFormula(text)) { this.done.set(key, null); return null; }
    if (this.open.has(key)) return error("#CYCLE!");
    this.open.add(key);
    this.depth++;
    const before = this.capped;
    let result: Result;
    try {
      if (this.depth > MAX_DEPTH) this.capped++;
      let tree = this.trees.get(key);
      if (tree === undefined) {
        tree = text.length > MAX_FORMULA ? null : parseFormula(text);
        this.trees.set(key, tree);
      }
      if (this.depth > MAX_DEPTH) tree = null;
      result = tree ? this.eval(tree) : error("#VALUE!");
    } catch {
      // A tree too deep to walk (a stack overflow) is an error like any other.
      result = error("#VALUE!");
    } finally {
      this.depth--;
      this.open.delete(key);
    }
    if (this.capped === before) this.done.set(key, result);
    return result;
  }

  /** The value of a cell: a number, null (text or blank), or an error. */
  private cell(at: Cell): Result | null {
    if (at.row < 0 || at.col < 0 || at.row >= this.grid.rows || at.col >= this.grid.cols) return error("#REF!");
    const formula = this.resolve(at.row, at.col);
    if (formula) return formula;
    const n = plainNumber(this.grid.text(...this.grid.origin(at.row, at.col)));
    return n === null ? null : { value: n };
  }

  /** The cells of a range, each merged cell once. */
  private range(a: Cell, b: Cell): Cell[] | Result {
    const [r0, r1] = [Math.min(a.row, b.row), Math.max(a.row, b.row)];
    const [c0, c1] = [Math.min(a.col, b.col), Math.max(a.col, b.col)];
    if (r0 < 0 || c0 < 0 || r1 >= this.grid.rows || c1 >= this.grid.cols) return error("#REF!");
    const seen = new Set<string>();
    const out: Cell[] = [];
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const [or, oc] = this.grid.origin(r, c);
        const key = `${or},${oc}`;
        if (!seen.has(key)) { seen.add(key); out.push({ row: or, col: oc }); }
      }
    }
    return out;
  }

  private numbers(args: Expr[]): number[] | Result {
    const out: number[] = [];
    for (const arg of args) {
      const cells = arg.k === "range" ? this.range(arg.a, arg.b) : arg.k === "ref" ? [arg.at] : null;
      if (!cells) {
        const r = this.eval(arg);
        if ("error" in r) return r;
        out.push(r.value);
        continue;
      }
      if (!Array.isArray(cells)) return cells;
      for (const at of cells) {
        const v = this.cell(at);
        if (v === null) continue;
        if ("error" in v) return v;
        out.push(v.value);
      }
    }
    return out;
  }

  private eval(e: Expr): Result {
    switch (e.k) {
      case "num": return { value: e.v };
      case "ref": {
        const v = this.cell(e.at);
        return v ?? error("#VALUE!");
      }
      case "range": return error("#VALUE!");
      case "neg": {
        const v = this.eval(e.e);
        return "error" in v ? v : { value: -v.value };
      }
      case "bin": {
        const l = this.eval(e.l);
        if ("error" in l) return l;
        const r = this.eval(e.r);
        if ("error" in r) return r;
        switch (e.op) {
          case "+": return finite(l.value + r.value);
          case "-": return finite(l.value - r.value);
          case "*": return finite(l.value * r.value);
          case "/": return r.value === 0 ? error("#DIV/0!") : finite(l.value / r.value);
        }
        break;
      }
      case "call": {
        const nums = this.numbers(e.args);
        if (!Array.isArray(nums)) return nums;
        switch (e.name) {
          case "SUM": return finite(nums.reduce((a, b) => a + b, 0));
          case "AVG": return nums.length ? finite(nums.reduce((a, b) => a + b, 0) / nums.length) : error("#DIV/0!");
          case "MIN": return { value: nums.length ? nums.reduce((a, b) => Math.min(a, b)) : 0 };
          case "MAX": return { value: nums.length ? nums.reduce((a, b) => Math.max(a, b)) : 0 };
          case "COUNT": return { value: nums.length };
          default: return error("#VALUE!");
        }
      }
    }
    return error("#VALUE!");
  }
}

/** A result as a cell shows it: a number without floating point noise, or the error. */
export function showResult(r: Result): string {
  if ("error" in r) return r.error;
  return Number.isInteger(r.value) ? String(r.value) : String(Number(r.value.toPrecision(12)));
}

/** The value a cell shows: a formula's result, else null (the cell shows its own text). */
export function showCell(sheet: Sheet, row: number, col: number): string | null {
  const r = sheet.at(row, col);
  return r ? showResult(r) : null;
}
