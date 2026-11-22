// NS-4A: result grouping for the Notes page's search box, and the arrow keys' walk over it.
import { describe, expect, it } from "vitest";
import type { DocSearchHit, SearchHit } from "../../lib/lm";
import { MARK_CLOSE, MARK_OPEN, marked, type IndexHit } from "../../lib/noteindex";
import { buildGroups, flatRows, moveActive, type GroupInput } from "./groups";

const page = (notebook: string, path: string, title = path): IndexHit => ({ notebook, path, kind: "md", title, titleMarked: `${MARK_OPEN}${title}${MARK_CLOSE}`, mtimeMs: 1, snippet: "a snippet" });
const lmHit = (domain: string, notebook: string, path: string): DocSearchHit => ({
  domain, notebook, notebook_title: `${notebook} title`, title: path, path, heading: "Part", snippet: "in a page", line_start: 3, line_end: 4, revision: "r", score: 1, relevance: 1,
});
const note = (id: string): SearchHit => ({ id, domain: "demo", title: `Note ${id}`, type: "knowledge", snippet: "words" } as SearchHit);

const input = (over: Partial<GroupInput> = {}): GroupInput => ({
  current: "nb-1", titles: new Map([["nb-1", "Main"], ["nb-2", "Work"]]),
  here: [page("nb-1", "Projects/Plan.md", "Plan")], other: [page("nb-2", "Plan.md", "Plan")],
  lmSearch: true, lm: [lmHit("demo", "plans", "Roadmap.md")], lmNotebooks: [{ domain: "demo", notebook: "plans" }],
  memory: [note("demo:1")], ...over,
});

describe("buildGroups", () => {
  it("makes four groups in a fixed order, each in the order its own source gave", () => {
    const groups = buildGroups(input({ here: [page("nb-1", "B.md"), page("nb-1", "A.md")] }));
    expect(groups.map((g) => g.id)).toEqual(["here", "other", "lm", "memory"]);
    expect(groups.map((g) => g.title)).toEqual(["This notebook", "Other notebooks", "Living Memory pages", "Memory notes"]);
    expect(groups[0].rows.map((r) => r.title)).toEqual(["B.md", "A.md"]);
  });

  it("describes each row by its notebook and folder, and says where it opens", () => {
    const [here, other, lm, memory] = buildGroups(input());
    expect(here.rows[0]).toMatchObject({ detail: "Projects", open: { page: { notebook: "nb-1", path: "Projects/Plan.md" } }, snippet: "a snippet" });
    expect(other.rows[0]).toMatchObject({ detail: "Work", open: { page: { notebook: "nb-2", path: "Plan.md" } } });
    expect(lm.rows[0]).toMatchObject({ detail: "plans title · Part", open: { lm: { domain: "demo", notebook: "plans", path: "Roadmap.md" } } });
    expect(memory.rows[0]).toMatchObject({ detail: "demo · knowledge", open: { note: { ref: "demo:1", domain: "demo", title: "Note demo:1" } } });
  });

  it("has no Living Memory group without the docs.search capability, whatever it was handed", () => {
    const groups = buildGroups(input({ lmSearch: false }));
    expect(groups.map((g) => g.id)).toEqual(["here", "other", "memory"]);
  });

  it("shows only the Living Memory notebooks Hivemind lists, since those are the ones a tab can open", () => {
    const groups = buildGroups(input({ lm: [lmHit("demo", "plans", "A.md"), lmHit("demo", "hidden-one", "B.md"), lmHit("elsewhere", "plans", "C.md")] }));
    expect(groups.find((g) => g.id === "lm")!.rows.map((r) => r.title)).toEqual(["A.md"]);
    expect(buildGroups(input({ lmNotebooks: [] })).some((g) => g.id === "lm")).toBe(false);
  });

  it("leaves out a group with nothing in it, and calls the pages 'Notebooks' when no page is being read", () => {
    expect(buildGroups(input({ here: [], lm: [], memory: [] })).map((g) => g.id)).toEqual(["other"]);
    expect(buildGroups(input({ current: undefined, here: [] }))[0].title).toBe("Notebooks");
    expect(buildGroups(input({ here: [], other: [], lm: [], memory: [] }))).toEqual([]);
  });

  it("never merges or reorders across groups: a better memory note stays under the pages", () => {
    const rows = flatRows(buildGroups(input({ memory: [note("a"), note("b")] })));
    expect(rows.map((r) => r.group)).toEqual(["here", "other", "lm", "memory", "memory"]);
  });
});

describe("moveActive", () => {
  it("walks the rows with the arrow keys and stops at both ends", () => {
    expect(moveActive(0, "ArrowDown", 3)).toBe(1);
    expect(moveActive(2, "ArrowDown", 3)).toBe(2);
    expect(moveActive(0, "ArrowUp", 3)).toBe(0);
    expect(moveActive(2, "ArrowUp", 3)).toBe(1);
    expect(moveActive(1, "Home", 3)).toBe(0);
    expect(moveActive(1, "End", 3)).toBe(2);
    expect(moveActive(1, "a", 3)).toBe(1);
  });
  it("has no row to stand on in an empty list", () => {
    expect(moveActive(0, "ArrowDown", 0)).toBe(-1);
  });
});

describe("marked", () => {
  it("splits a title or snippet at the index's marks", () => {
    expect(marked(`a ${MARK_OPEN}match${MARK_CLOSE} here`)).toEqual([{ text: "a ", on: false }, { text: "match", on: true }, { text: " here", on: false }]);
    expect(marked("<b>no marks</b> & <script>")).toEqual([{ text: "<b>no marks</b> & <script>", on: false }]);
    expect(marked("")).toEqual([]);
  });
});
