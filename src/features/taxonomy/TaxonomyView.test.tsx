// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useConnection } from "../../lib/connection";
import { useApp } from "../../store";
import { useWorkspace } from "../../workspace/store";
import { useNotesSearch } from "../search/store";
import { TaxonomyView } from "./TaxonomyView";

const mocks = vi.hoisted(() => ({
  taxonomy: vi.fn(),
  list: vi.fn(),
  indexTags: vi.fn(),
  indexSearch: vi.fn(),
  listNotebooks: vi.fn(),
}));

vi.mock("../../lib/lm", async (orig) => {
  const actual = await orig<typeof import("../../lib/lm")>();
  return { ...actual, taxonomy: mocks.taxonomy, list: mocks.list };
});
vi.mock("../../lib/noteindex", async (orig) => {
  const actual = await orig<typeof import("../../lib/noteindex")>();
  return {
    ...actual,
    indexTags: mocks.indexTags,
    indexSearch: mocks.indexSearch,
    tagsQuery: () => ({ queryKey: [actual.INDEX_KEY, "tags"], queryFn: mocks.indexTags }),
  };
});
vi.mock("../../lib/notebooks", async (orig) => {
  const actual = await orig<typeof import("../../lib/notebooks")>();
  return { ...actual, notebooksQuery: () => ({ queryKey: ["notebooks"], queryFn: mocks.listNotebooks }) };
});
vi.mock("./NoteTypesSection", () => ({ NoteTypesSection: () => null }));

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

let host: HTMLDivElement | null = null;
let root: Root | null = null;

function mount() {
  host = document.createElement("div");
  document.body.appendChild(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root = createRoot(host);
  act(() => { root!.render(<QueryClientProvider client={client}><TaxonomyView /></QueryClientProvider>); });
}

describe("TaxonomyView (unified Tags view)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useConnection.setState({ commands: ["taxonomy", "search"], api: 2, capabilities: undefined });
    useApp.setState({ route: { page: "notes", view: "tags" }, domain: "sandbox" });
    useWorkspace.setState({ panes: [{ id: "p1", tabs: [], active: null }], focused: "p1" });
    useNotesSearch.setState({ query: "", open: false });
    mocks.taxonomy.mockResolvedValue({ tags: ["technology/rust", "concern/bug"], facets: ["concern", "technology"] });
    mocks.list.mockResolvedValue({
      total: 1,
      notes: [{ ref: "sandbox:n1", id: "n1", domain: "sandbox", title: "SQLite Search", type: "decision", status: "active", tags: ["technology/rust"], updated: "2026-11-23" }],
    });
    mocks.indexTags.mockResolvedValue([{ tag: "technology/rust", count: 1 }, { tag: "q4-plan", count: 2 }]);
    mocks.listNotebooks.mockResolvedValue([{ id: "nb1", path: "C:/nb", title: "Work", added: "2026-11-20" }]);
    mocks.indexSearch.mockResolvedValue({
      hits: [{ notebook: "nb1", path: "Docs/Architecture.md", kind: "md", title: "Architecture", titleMarked: "Architecture", mtimeMs: 1, snippet: "" }],
      ms: 1, state: "idle",
    });
  });

  afterEach(() => {
    act(() => { root?.unmount(); });
    host?.remove();
    host = null;
    root = null;
  });

  it("merges overlapping counts, shows Page tags, filters tags, and lists matching notes and pages on click", async () => {
    mount();
    await flush();
    await flush();

    // Overlapping taxonomy + page tag shows combined count; free-form tag appears under Page tags.
    expect(host!.textContent).toContain("technology/rust");
    expect(host!.textContent).toContain("1 note · 1 page");
    expect(host!.textContent).toContain("Page tags");
    expect(host!.textContent).toContain("#q4-plan");
    expect(host!.textContent).toContain("2 pages");

    // Click technology/rust -> shows both the memory note and the notebook page.
    const rustBtn = [...host!.querySelectorAll("button")].find((b) => b.textContent?.includes("technology/rust"))!;
    act(() => { rustBtn.click(); });
    await flush();
    await flush();

    expect(host!.textContent).toContain("SQLite Search");
    expect(host!.textContent).toContain("Architecture");
    expect(host!.textContent).toContain("Work · Docs");

    // Open in search populates the unified search bar with the selected tag.
    const searchBtn = [...host!.querySelectorAll("button")].find((b) => b.textContent === "Open in search")!;
    act(() => { searchBtn.click(); });
    expect(useNotesSearch.getState().filters.tag).toBe("technology/rust");
    expect(useNotesSearch.getState().open).toBe(true);

    // Filter input narrows visible tags.
    const filterInput = host!.querySelector<HTMLInputElement>('input[aria-label="Filter tags"]')!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(filterInput, "q4");
      filterInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(host!.textContent).toContain("#q4-plan");
    expect(host!.textContent).not.toContain("concern/bug");
  });

  it("has the page title as h1, its sections as h2 and the results groups as h3, with no level skipped", async () => {
    mount();
    await flush();
    await flush();
    const rustBtn = [...host!.querySelectorAll("button")].find((b) => b.textContent?.includes("technology/rust"))!;
    act(() => { rustBtn.click(); });
    await flush();
    await flush();
    const headings = [...host!.querySelectorAll("h1, h2, h3, h4, h5, h6")].map((h) => [Number(h.tagName[1]), h.textContent!.replace(/\s+/g, " ").trim()] as const);
    expect(headings[0]).toEqual([1, "Tags"]);
    const levels = headings.map(([level]) => level);
    levels.forEach((level, i) => { if (i) expect(level).toBeLessThanOrEqual(levels[i - 1] + 1); });
    const titles = (level: number) => headings.filter(([l]) => l === level).map(([, t]) => t);
    expect(titles(2)).toEqual(expect.arrayContaining(["concern 1", "technology 1", "Page tags 1"]));
    expect(titles(2).some((t) => t.startsWith("Tagged technology/rust"))).toBe(true);
    expect(titles(3)).toEqual(["Memory notes 1", "Pages 1"]);
    expect(levels).not.toContain(4);
  });
});
