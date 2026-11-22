// NS-7B: the query definition, the form that makes it, its translation for Living Memory's `doc query`, and running it over
// both kinds of notebook.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls: { cmd: string; args: Record<string, unknown> }[] = [];
let folderRows: unknown[] = [];
let lmPages: unknown[] = [];
let lmFails = false;
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: Record<string, unknown>) => {
    calls.push({ cmd, args });
    if (cmd === "index_query") return folderRows;
    if (cmd === "lm_body") {
      if (lmFails) return { exit_code: 1, error: { code: "invalid", message: "Unknown query fields: x" }, result: null };
      return { exit_code: 0, error: null, result: { ok: true, pages: lmPages } };
    }
    return null;
  }),
}));

const { compareValues, forIndex, formOf, newSpec, parseSpec, parseSpecText, runQuery, sortRows, specOf, toLmPayload, columnsOf, valueOf } = await import("./queries");
type QueryRow = import("./queries").QueryRow;

const row = (notebook: string, path: string, props: Record<string, string | string[]> = {}, title = path): QueryRow => ({ notebook, path, title, hash: "h", props, lm: notebook.startsWith("lm:") });

beforeEach(() => { calls.length = 0; folderRows = []; lmPages = []; lmFails = false; });
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

describe("the same query for Living Memory", () => {
  it("renames the keys and operators, makes a folder a range over path and a tag the tags property", () => {
    const spec = parseSpec({ version: 1, from: { notebooks: ["lm:demo:plans", "nb-1"], folder: "Projects", tag: "work" },
      where: [{ prop: "status", op: "ne", value: "done" }, { prop: "n", op: "ge", value: 2 }, { prop: "due", op: "missing" }, { prop: "title", op: "contains", value: "plan" }],
      sort: [{ prop: "due", dir: "desc" }, { prop: "title" }], limit: 40 });
    expect(spec.ok && toLmPayload(spec.spec)).toEqual({
      where: [
        { key: "status", op: "!=", value: "done" }, { key: "n", op: ">=", value: "2" }, { key: "due", op: "missing" }, { key: "title", op: "contains", value: "plan" },
        { key: "path", op: ">=", value: "Projects/" }, { key: "path", op: "<", value: "Projects0" }, { key: "tags", op: "=", value: "work" },
      ],
      sort: [{ key: "due", order: "desc" }, { key: "title", order: "asc" }], limit: 40, notebook: "plans",
    });
  });

  it("names no notebook when several or none are chosen, and keeps Living Memory's own limits", () => {
    const two = parseSpec({ version: 1, from: { notebooks: ["lm:demo:a1", "lm:demo:b2"] } });
    const none = parseSpec({ version: 1 });
    expect(two.ok && "notebook" in toLmPayload(two.spec)).toBe(false);
    expect(none.ok && toLmPayload(none.spec)).toEqual({ where: [], sort: [], limit: 500 });
    // Ten conditions, a folder (two) and a tag stay under Living Memory's 20.
    const most = parseSpec({ version: 1, from: { folder: "f", tag: "t" }, where: Array(10).fill({ prop: "a", op: "exists" }) });
    expect(most.ok && toLmPayload(most.spec).where.length).toBe(13);
  });

  it("sends the index only the folder notebooks", () => {
    const spec = parseSpec({ version: 1, from: { notebooks: ["nb-1", "lm:demo:plans"] }, where: [{ prop: "a", op: "eq", value: "b" }] });
    expect(spec.ok && forIndex(spec.spec)).toEqual({ from: { notebooks: ["nb-1"], folder: null, tag: null }, where: [{ prop: "a", op: "eq", value: "b" }], sort: [], limit: 500 });
  });
});

describe("sorting and merging the two answers", () => {
  it("orders numbers by value and text by lower case, numbers first, and a row without the key last", () => {
    expect(["b", "10", "A", "9", "a"].sort(compareValues)).toEqual(["9", "10", "A", "a", "b"]);
    const rows = [row("nb-1", "a", { p: "10" }), row("nb-1", "b"), row("lm:d:nb", "c", { p: "9" }), row("nb-1", "d", { p: "text" })];
    expect(sortRows(rows, [{ prop: "p", dir: "asc" }]).map((r) => r.path)).toEqual(["c", "a", "d", "b"]);
    expect(sortRows(rows, [{ prop: "p", dir: "desc" }]).map((r) => r.path)).toEqual(["d", "a", "c", "b"]);
    // The last key is applied first, so the first key decides and the later ones break its ties.
    const tied = [row("nb-1", "x", { s: "a", n: "1" }), row("nb-1", "y", { s: "a", n: "2" }), row("nb-1", "z", { s: "0", n: "9" })];
    expect(sortRows(tied, [{ prop: "s", dir: "asc" }, { prop: "n", dir: "desc" }]).map((r) => r.path)).toEqual(["z", "y", "x"]);
    expect(valueOf(row("nb-1", "p", { l: ["first", "second"] }, "T"), "l")).toBe("first");
    expect(valueOf(row("nb-1", "p", {}, "T"), "title")).toBe("T");
  });

  it("asks the index and Living Memory, and merges their rows in one order within the limit", async () => {
    folderRows = [{ notebook: "nb-1", path: "A.md", title: "A", sha256: "sha-a", mtimeMs: 1, props: { n: "5" } }, { notebook: "nb-1", path: "C.md", title: "C", sha256: "sha-c", mtimeMs: 1, props: { n: "30" } }];
    lmPages = [{ domain: "d", notebook: "plans", path: "B.md", title: "B", revision: "rev-b", properties: { n: "7" } }, { domain: "d", notebook: "plans", path: "D.md", title: "D", revision: "rev-d", properties: { n: "100" } }];
    const spec = parseSpec({ version: 1, sort: [{ prop: "n", dir: "asc" }], limit: 3 });
    const got = await runQuery(spec.ok ? spec.spec : newSpec(), true);
    expect(got.rows.map((r) => [r.notebook, r.path, r.hash, r.lm])).toEqual([["nb-1", "A.md", "sha-a", false], ["lm:d:plans", "B.md", "rev-b", true], ["nb-1", "C.md", "sha-c", false]]);
    expect(got.problems).toEqual([]);
    const lm = calls.find((c) => c.cmd === "lm_body")!;
    expect(lm.args).toMatchObject({ flag: "--payload-file" });
    expect(lm.args.argv).toEqual(["doc", "query", "--all-domains", "--include-private", "--actor", "viewer"]);
    expect(JSON.parse(lm.args.body as string)).toEqual({ where: [], sort: [{ key: "n", order: "asc" }], limit: 3 });
  });

  it("asks only the kind of notebook the query names, and only when Living Memory can answer", async () => {
    await runQuery({ ...newSpec(), from: { notebooks: ["nb-1"], folder: null, tag: null } }, true);
    expect(calls.map((c) => c.cmd)).toEqual(["index_query"]);
    calls.length = 0;
    await runQuery({ ...newSpec(), from: { notebooks: ["lm:d:plans"], folder: null, tag: null } }, true);
    expect(calls.map((c) => c.cmd)).toEqual(["lm_body"]);
    calls.length = 0;
    await runQuery(newSpec(), false);
    expect(calls.map((c) => c.cmd)).toEqual(["index_query"]);
  });

  it("filters the answer to the chosen Living Memory notebooks when it was asked for several", async () => {
    lmPages = [{ domain: "d", notebook: "a1", path: "x.md", title: "x", revision: "r", properties: {} }, { domain: "d", notebook: "c3", path: "y.md", title: "y", revision: "r", properties: {} }];
    const got = await runQuery({ ...newSpec(), from: { notebooks: ["lm:d:a1", "lm:d:b2"], folder: null, tag: null } }, true);
    expect(got.rows.map((r) => r.notebook)).toEqual(["lm:d:a1"]);
  });

  it("keeps the answer of the source that works and says which one failed", async () => {
    folderRows = [{ notebook: "nb-1", path: "A.md", title: "A", sha256: "s", mtimeMs: 1, props: {} }];
    lmFails = true;
    const got = await runQuery(newSpec(), true);
    expect(got.rows.map((r) => r.path)).toEqual(["A.md"]);
    expect(got.problems).toEqual(["Living Memory notebooks: Unknown query fields: x"]);
  });
});

describe("the columns of a table", () => {
  it("are the chosen ones, else the properties the query asks about", () => {
    expect(columnsOf({ ...newSpec(), columns: ["a", "b"] })).toEqual(["a", "b"]);
    const asked = parseSpec({ version: 1, where: [{ prop: "status", op: "exists" }, { prop: "title", op: "contains", value: "x" }], sort: [{ prop: "due" }, { prop: "status" }], view: "board", groupBy: "owner" });
    expect(asked.ok && columnsOf(asked.spec)).toEqual(["status", "due", "owner"]);
  });
});
