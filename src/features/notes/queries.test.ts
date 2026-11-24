// NS-7B: the query definition, the form that makes it, and running it over the folder notebooks. `doc query` and the Living
// Memory notebooks it served were retired by CON-18, so a query naming one finds nothing.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls: { cmd: string; args: Record<string, unknown> }[] = [];
let folderRows: unknown[] = [];
let indexFails = false;
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: Record<string, unknown>) => {
    calls.push({ cmd, args });
    if (cmd === "index_query") {
      if (indexFails) throw "The index is being rebuilt";
      return folderRows;
    }
    return null;
  }),
}));

const { compareValues, forIndex, formOf, newSpec, parseSpec, parseSpecText, runQuery, sortRows, specOf, columnsOf, valueOf } = await import("./queries");
type QueryRow = import("./queries").QueryRow;

const row = (notebook: string, path: string, props: Record<string, string | string[]> = {}, title = path): QueryRow => ({ notebook, path, title, hash: "h", props });

beforeEach(() => { calls.length = 0; folderRows = []; indexFails = false; });
afterEach(() => vi.clearAllMocks());

describe("the query definition", () => {
  it("reads a version 1 query and gives the missing parts their defaults", () => {
    const parsed = parseSpec({ version: 1, where: [{ prop: " status ", op: "eq", value: "active" }, { prop: "n", op: "gt", value: 3 }, { prop: "due", op: "missing", value: "ignored" }], sort: [{ prop: "due" }], from: { folder: "/Projects/", tag: "#Work" }, extra: 1 });
    expect(parsed).toEqual({ ok: true, spec: {
      version: 1, from: { notebooks: [], folder: "Projects", tag: "work" },
      where: [{ prop: "status", op: "eq", value: "active" }, { prop: "n", op: "gt", value: "3" }, { prop: "due", op: "missing" }],
      sort: [{ prop: "due", dir: "asc" }], view: "table", columns: [], groupBy: null, limit: 500,
    } });
  });

  it("says plainly what is wrong with a query that is not one", () => {
    const error = (v: unknown) => { const r = parseSpec(v); return r.ok ? "" : r.error; };
    expect(error(null)).toMatch(/JSON object/);
    expect(error({})).toMatch(/version/);
    expect(error({ version: 2 })).toMatch(/version/);
    expect(error({ version: 1, where: [{ prop: "a", op: "like", value: "x" }] })).toMatch(/condition is/);
    expect(error({ version: 1, where: [{ prop: "a", op: "eq" }] })).toMatch(/needs a value/);
    expect(error({ version: 1, where: Array(11).fill({ prop: "a", op: "exists" }) })).toMatch(/at most 10/);
    expect(error({ version: 1, sort: [{ prop: "a", dir: "up" }] })).toMatch(/sort key/);
    expect(error({ version: 1, view: "cards" })).toMatch(/table or board/);
    expect(error({ version: 1, view: "board" })).toMatch(/groupBy/);
    expect(error({ version: 1, limit: 0 })).toMatch(/limit/);
    expect(error({ version: 1, limit: 1001 })).toMatch(/limit/);
    expect(error({ version: 1, from: { notebooks: [1] } })).toMatch(/notebook ids/);
    expect(parseSpecText("{ not json").ok).toBe(false);
    expect(parseSpecText('{"version":1,"view":"board","groupBy":"status"}')).toMatchObject({ ok: true, spec: { view: "board", groupBy: "status" } });
  });
});

describe("the form", () => {
  it("makes the JSON a page or a saved view holds, and reads it back", () => {
    const form = { ...formOf(newSpec()), notebooks: ["nb-1", "lm:demo:plans"], folder: " Projects ", tag: "#Work",
      where: [{ prop: "status", op: "eq" as const, value: "active" }, { prop: "", op: "eq" as const, value: "dropped" }, { prop: "due", op: "exists" as const, value: "stale text" }],
      sort: [{ prop: "due", dir: "desc" as const }, { prop: " ", dir: "asc" as const }], view: "board" as const, columns: "status, due,, owner ", groupBy: "status", limit: "20" };
    const made = specOf(form);
    expect(made).toEqual({ ok: true, spec: {
      version: 1, from: { notebooks: ["nb-1", "lm:demo:plans"], folder: "Projects", tag: "work" },
      where: [{ prop: "status", op: "eq", value: "active" }, { prop: "due", op: "exists" }],
      sort: [{ prop: "due", dir: "desc" }], view: "board", columns: ["status", "due", "owner"], groupBy: "status", limit: 20,
    } });
    if (!made.ok) return;
    expect(specOf(formOf(made.spec))).toEqual(made);
    // A board without a column property and a limit that is not a number are refused with a message, not made.
    expect(specOf({ ...form, groupBy: "" })).toMatchObject({ ok: false });
    expect(specOf({ ...form, limit: "many" })).toMatchObject({ ok: false });
  });
});

describe("the query for the index", () => {
  it("sends the index only the folder notebooks", () => {
    const spec = parseSpec({ version: 1, from: { notebooks: ["nb-1", "lm:demo:plans"] }, where: [{ prop: "a", op: "eq", value: "b" }] });
    expect(spec.ok && forIndex(spec.spec)).toEqual({ from: { notebooks: ["nb-1"], folder: null, tag: null }, where: [{ prop: "a", op: "eq", value: "b" }], sort: [], limit: 500 });
  });
});

describe("sorting and running", () => {
  it("orders numbers by value and text by lower case, numbers first, and a row without the key last", () => {
    expect(["b", "10", "A", "9", "a"].sort(compareValues)).toEqual(["9", "10", "A", "a", "b"]);
    const rows = [row("nb-1", "a", { p: "10" }), row("nb-1", "b"), row("nb-2", "c", { p: "9" }), row("nb-1", "d", { p: "text" })];
    expect(sortRows(rows, [{ prop: "p", dir: "asc" }]).map((r) => r.path)).toEqual(["c", "a", "d", "b"]);
    expect(sortRows(rows, [{ prop: "p", dir: "desc" }]).map((r) => r.path)).toEqual(["d", "a", "c", "b"]);
    // The last key is applied first, so the first key decides and the later ones break its ties.
    const tied = [row("nb-1", "x", { s: "a", n: "1" }), row("nb-1", "y", { s: "a", n: "2" }), row("nb-1", "z", { s: "0", n: "9" })];
    expect(sortRows(tied, [{ prop: "s", dir: "asc" }, { prop: "n", dir: "desc" }]).map((r) => r.path)).toEqual(["z", "y", "x"]);
    expect(valueOf(row("nb-1", "p", { l: ["first", "second"] }, "T"), "l")).toBe("first");
    expect(valueOf(row("nb-1", "p", {}, "T"), "title")).toBe("T");
  });

  it("asks the index and keeps its rows in one order within the limit", async () => {
    folderRows = [{ notebook: "nb-1", path: "C.md", title: "C", sha256: "sha-c", mtimeMs: 1, props: { n: "30" } }, { notebook: "nb-1", path: "A.md", title: "A", sha256: "sha-a", mtimeMs: 1, props: { n: "5" } },
      { notebook: "nb-2", path: "B.md", title: "B", sha256: "sha-b", mtimeMs: 1, props: { n: "7" } }, { notebook: "nb-2", path: "D.md", title: "D", sha256: "sha-d", mtimeMs: 1, props: { n: "100" } }];
    const spec = parseSpec({ version: 1, sort: [{ prop: "n", dir: "asc" }], limit: 3 });
    const got = await runQuery(spec.ok ? spec.spec : newSpec());
    expect(got.rows.map((r) => [r.notebook, r.path, r.hash])).toEqual([["nb-1", "A.md", "sha-a"], ["nb-2", "B.md", "sha-b"], ["nb-1", "C.md", "sha-c"]]);
    expect(got.problems).toEqual([]);
    expect(calls.map((c) => c.cmd)).toEqual(["index_query"]);
  });

  it("never sends a doc command, and a query that names only a retired Living Memory notebook finds nothing without asking the index", async () => {
    const got = await runQuery({ ...newSpec(), from: { notebooks: ["lm:d:plans"], folder: null, tag: null } });
    expect(got).toEqual({ rows: [], problems: [] });
    expect(calls).toEqual([]);
    // Named beside a folder notebook, the retired name is dropped and the folder notebook still answers.
    await runQuery({ ...newSpec(), from: { notebooks: ["nb-1", "lm:d:plans"], folder: null, tag: null } });
    expect(calls.map((c) => [c.cmd, (c.args.query as { from: { notebooks: string[] } }).from.notebooks])).toEqual([["index_query", ["nb-1"]]]);
  });

  it("says when the index could not answer", async () => {
    indexFails = true;
    const got = await runQuery(newSpec());
    expect(got.rows).toEqual([]);
    expect(got.problems).toEqual(["The index is being rebuilt"]);
  });
});

describe("the columns of a table", () => {
  it("are the chosen ones, else the properties the query asks about", () => {
    expect(columnsOf({ ...newSpec(), columns: ["a", "b"] })).toEqual(["a", "b"]);
    const asked = parseSpec({ version: 1, where: [{ prop: "status", op: "exists" }, { prop: "title", op: "contains", value: "x" }], sort: [{ prop: "due" }, { prop: "status" }], view: "board", groupBy: "owner" });
    expect(asked.ok && columnsOf(asked.spec)).toEqual(["status", "due", "owner"]);
  });
});
