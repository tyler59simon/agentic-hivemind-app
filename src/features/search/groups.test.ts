// NS-4A / CON-11: result grouping for the unified top-bar search box, and the arrow keys' walk over it.
import { describe, expect, it } from "vitest";
import type { SearchHit } from "../../lib/lm";
import { MARK_CLOSE, MARK_OPEN, marked, type IndexHit } from "../../lib/noteindex";
import { buildGroups, flatRows, isRelatedNote, isRelevantPage, moveActive, type GroupInput } from "./groups";

const page = (notebook: string, path: string, title = path): IndexHit => ({ notebook, path, kind: "md", title, titleMarked: `${MARK_OPEN}${title}${MARK_CLOSE}`, mtimeMs: 1, snippet: "a snippet" });
const note = (id: string, over: Partial<SearchHit> = {}): SearchHit => ({
  id, domain: "demo", title: `Note ${id}`, type: "knowledge", status: "active", tags: [], snippet: "words", ...over,
} as SearchHit);

const input = (over: Partial<GroupInput> = {}): GroupInput => ({
  current: "nb-1", titles: new Map([["nb-1", "Main"], ["nb-2", "Work"]]),
  here: [page("nb-1", "Projects/Plan.md", "Plan")], other: [page("nb-2", "Plan.md", "Plan")],
  memory: [note("demo:1")], ...over,
});

describe("buildGroups", () => {
  it("makes three groups in one fixed order (Memory notes first), each in the order its own source gave, and none for Living Memory pages (CON-18)", () => {
    const groups = buildGroups(input({ here: [page("nb-1", "B.md"), page("nb-1", "A.md")] }));
    expect(groups.map((g) => g.id)).toEqual(["memory", "here", "other"]);
    expect(groups.map((g) => g.title)).toEqual(["Memory notes", "This notebook", "Other notebooks"]);
    expect(groups[1].rows.map((r) => r.title)).toEqual(["B.md", "A.md"]);
  });

  it("describes each row by its origin/project and says where it opens", () => {
    const [memory, here, other] = buildGroups(input({
      projectNames: new Map([["project/pay", "Paystream"]]),
      memory: [note("1", { tags: ["project/pay"], status: "archived" })],
    }));
    expect(memory.rows[0]).toMatchObject({ detail: "Paystream · knowledge · archived", open: { note: { ref: "demo:1", domain: "demo", title: "Note 1" } } });
    expect(here.rows[0]).toMatchObject({ detail: "Projects", open: { page: { notebook: "nb-1", path: "Projects/Plan.md" } }, snippet: "a snippet" });
    expect(other.rows[0]).toMatchObject({ detail: "Work", open: { page: { notebook: "nb-2", path: "Plan.md" } } });
  });

  it("isRelevantPage and isRelatedNote apply the floor of 0.45 and the relevance rule", () => {
    expect([isRelevantPage({ relevance: 1 }), isRelevantPage({ relevance: 0 }), isRelevantPage({ relevance: 0, similarity: 0.45 }), isRelevantPage({ relevance: 0, similarity: 0.44 }), isRelevantPage({})]).toEqual([true, false, true, false, true]);
    expect([isRelatedNote({ similarity: 0.45, relevance: 0 }), isRelatedNote({ similarity: 0.44, relevance: 1 }), isRelatedNote({ relevance: 0.1 }), isRelatedNote({ relevance: 0 }), isRelatedNote({})]).toEqual([true, false, true, false, true]);
  });

  it("leaves out a group with nothing in it, and calls the pages 'Notebooks' when no page is being read", () => {
    expect(buildGroups(input({ here: [], memory: [] })).map((g) => g.id)).toEqual(["other"]);
    expect(buildGroups(input({ current: undefined, here: [], memory: [] }))[0].title).toBe("Notebooks");
    expect(buildGroups(input({ here: [], other: [], memory: [] }))).toEqual([]);
  });

  it("never merges or reorders across groups: memory notes stay ahead of notebook pages", () => {
    const rows = flatRows(buildGroups(input({ memory: [note("a"), note("b")] })));
    expect(rows.map((r) => r.group)).toEqual(["memory", "memory", "here", "other"]);
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
