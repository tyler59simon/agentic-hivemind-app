// @vitest-environment jsdom
// NS-4A: the Notes page's search box mounted for real: typing opens the panel with the groups, the arrow keys move, Enter
// opens, Ctrl+Enter opens beside, Escape closes, a filter narrows the search, and the Living Memory group needs the capability.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const calls: { cmd: string; args: Record<string, unknown> }[] = [];
const MARK = (s: string) => `\u0001${s}\u0002`;
const hit = (notebook: string, path: string, title: string, snippet = "") => ({ notebook, path, kind: "md", title, titleMarked: MARK(title), mtimeMs: 1, snippet });
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: Record<string, unknown>) => {
    calls.push({ cmd, args });
    switch (cmd) {
      case "notebooks_list": return [{ id: "nb-1", path: "C:\\one", title: "Main", added: "" }, { id: "nb-2", path: "C:\\two", title: "Work", added: "" }];
      case "index_tags": return [{ tag: "plan", count: 2 }];
      case "index_search": {
        const f = args.filters as { notebook?: string; excludeNotebook?: string; tag?: string };
        if (f.notebook === "nb-1") return { hits: [hit("nb-1", "Projects/Plan.md", "Plan", `the ${MARK("plan")} for the quarter`), hit("nb-1", "Inbox.md", "Inbox")], ms: 1, state: "idle" };
        if (f.excludeNotebook === "nb-1" || !f.notebook) return { hits: [hit("nb-2", "Plan.md", "Plan notes")], ms: 1, state: "idle" };
        return { hits: [], ms: 1, state: "idle" };
      }
      case "lm": {
        const argv = args.argv as string[];
        if (argv[0] === "doc" && argv[1] === "search") return { exit_code: 0, error: null, result: { ok: true, pages: [{ origin: "lm", domain: "demo", notebook: "plans", notebook_title: "Release plans", title: "Roadmap.md", path: "Roadmap.md", heading: null, snippet: "the plan page", line_start: 1, line_end: 2, revision: "r", score: 1, relevance: 1 }] } };
        if (argv[0] === "doc" && argv[1] === "notebooks") return { exit_code: 0, error: null, result: { notebooks: [{ domain: "demo", notebook: "plans", title: "Release plans", visibility: "searchable", private: false, revision: "r", pages: 1, assets: 0, asset_bytes: 0, proposals: 0, updated: "" }] } };
        if (argv[0] === "search") return { exit_code: 0, error: null, result: { mode: "lexical", domains: ["demo"], fallback: false, results: [{ id: "demo:1", domain: "demo", title: "Plan decision", type: "decision", snippet: "we plan", updated: "", tags: [], status: "active", score: 1, rank: 1, engine: "lexical", revision: "r", sourceField: "body", sourceScope: "active" }] } };
        return { exit_code: 0, error: null, result: {} };
      }
    }
    return null;
  }),
}));

const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { NotesSearchBox } = await import("./NotesSearch");
const { useNotesSearch, NO_FILTERS } = await import("./store");
const { useWorkspace } = await import("../../workspace/store");
const { useConnection } = await import("../../lib/connection");
const { useApp } = await import("../../store");

let root: Root | null = null;
const opened: { tab: Record<string, unknown>; split: boolean }[] = [];

function Box() {
  const ref = useRef<HTMLInputElement>(null);
  return <NotesSearchBox inputRef={ref} />;
}

// Updates made inside an async act() are rendered when it ends, so the debounce, the queries it starts and their answers
// each need a turn of their own.
const settle = async () => { for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 200)); }); };
const input = () => document.querySelector<HTMLInputElement>("input[aria-label='Search pages']")!;
const setValue = async (e: Element, v: string) => {
  const proto = e instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  await act(async () => { Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(e, v); e.dispatchEvent(new Event(e instanceof HTMLSelectElement ? "change" : "input", { bubbles: true })); });
};
const press = async (key: string, mods: { ctrlKey?: boolean } = {}) => act(async () => { input().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...mods })); });
/** Whether Living Memory was asked to search notes or notebook pages. */
const searchedLm = () => calls.some((c) => c.cmd === "lm" && ((c.args.argv as string[])[0] === "search" || ((c.args.argv as string[])[0] === "doc" && (c.args.argv as string[])[1] === "search")));
const groupTitles = () => [...document.querySelectorAll(".search-group h3")].map((h) => h.textContent);
const rows = () => [...document.querySelectorAll<HTMLElement>("[role=option]")];
const activeRow = () => rows().findIndex((r) => r.getAttribute("aria-selected") === "true");

async function mount(lmSearch: boolean) {
  useConnection.setState({ commands: ["doc", "search"], api: 2, capabilities: lmSearch ? { docs: { version: 1, max_page_bytes: 1, max_asset_bytes: 1, search: true } } : { docs: { version: 1, max_page_bytes: 1, max_asset_bytes: 1 } } });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  (globalThis as { __qc?: unknown }).__qc = client;
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<QueryClientProvider client={client}><Box /></QueryClientProvider>));
}

beforeEach(() => {
  calls.length = 0;
  opened.length = 0;
  useNotesSearch.setState({ query: "", filters: NO_FILTERS, open: false, focusTick: 0 });
  useApp.setState({ domain: "demo" });
  // A page of notebook nb-1 is the one being read.
  useWorkspace.setState({
    panes: [{ id: "p1", tabs: [{ id: "t1", kind: "file", file: { notebook: "nb-1", path: "Inbox.md" }, mode: "live", title: "Inbox" }], active: "t1" }], focused: "p1",
    openTab: ((tab: Record<string, unknown>, opts?: { split?: boolean }) => { opened.push({ tab, split: !!opts?.split }); }) as never,
  });
});
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.innerHTML = ""; });

describe("the Notes page's search box", () => {
  it("is quiet until there is something to search, then shows the four groups with this notebook first", async () => {
    await mount(true);
    await act(async () => input().focus());
    expect(document.querySelector(".search-panel")).not.toBeNull();
    expect(rows()).toHaveLength(0);
    expect(calls.some((c) => c.cmd === "index_search")).toBe(false);
    await setValue(input(), "plan");
    await settle();
    expect(groupTitles()).toEqual(["This notebook", "Other notebooks", "Living Memory pages", "Memory notes"]);
    expect(rows().map((r) => r.querySelector(".search-title")?.textContent)).toEqual(["Plan · Projects", "Inbox", "Plan notes · Work", "Roadmap.md · Release plans", "Plan decision · demo · decision"]);
    // The match is marked, as an element and never as markup.
    expect(document.querySelector(".search-panel mark")?.textContent).toBe("Plan");
    // This notebook and the others were asked apart.
    const asked = calls.filter((c) => c.cmd === "index_search").map((c) => c.args.filters);
    expect(asked).toEqual(expect.arrayContaining([expect.objectContaining({ notebook: "nb-1" }), expect.objectContaining({ excludeNotebook: "nb-1" })]));
  });

  it("has no Living Memory group when Living Memory cannot search pages, and never asks it", async () => {
    await mount(false);
    await act(async () => input().focus());
    await setValue(input(), "plan");
    await settle();
    expect(groupTitles()).toEqual(["This notebook", "Other notebooks", "Memory notes"]);
    expect(calls.some((c) => c.cmd === "lm" && (c.args.argv as string[])[0] === "doc" && (c.args.argv as string[])[1] === "search")).toBe(false);
  });

  it("the arrow keys move over the rows, Enter opens the one marked, and the panel closes", async () => {
    await mount(true);
    await act(async () => input().focus());
    await setValue(input(), "plan");
    await settle();
    expect(activeRow()).toBe(0);
    await press("ArrowDown");
    await press("ArrowDown");
    expect(activeRow()).toBe(2);
    await press("ArrowUp");
    expect(activeRow()).toBe(1);
    await press("Enter");
    expect(opened).toEqual([{ tab: expect.objectContaining({ kind: "file", file: { notebook: "nb-1", path: "Inbox.md" } }), split: false }]);
    expect(document.querySelector(".search-panel")).toBeNull();
  });

  it("Ctrl+Enter opens beside, a Living Memory page opens as a notebook page, and a memory note opens as a note", async () => {
    await mount(true);
    await act(async () => input().focus());
    await setValue(input(), "plan");
    await settle();
    await press("End");   // End belongs to the text cursor: the rows do not move
    expect(activeRow()).toBe(0);
    for (let i = 0; i < 3; i++) await press("ArrowDown");
    await press("Enter", { ctrlKey: true });
    expect(opened[0]).toMatchObject({ split: true, tab: { kind: "file", file: { notebook: "lm:demo:plans", path: "Roadmap.md" } } });
    await act(async () => input().focus());
    await setValue(input(), "plan ");
    await settle();
    await press("ArrowDown"); await press("ArrowDown"); await press("ArrowDown"); await press("ArrowDown");
    await press("Enter");
    expect(opened[1]).toMatchObject({ split: false, tab: { kind: "note", ref: "demo:1" } });
    expect(useApp.getState().domain).toBe("demo");
  });

  it("Escape closes the panel first and leaves the box after that", async () => {
    await mount(true);
    await act(async () => input().focus());
    await setValue(input(), "plan");
    await settle();
    await press("Escape");
    expect(document.querySelector(".search-panel")).toBeNull();
    expect(input().value).toBe("plan");
  });

  it("a filter narrows the search to pages, and a tag chosen in the Tags pane opens the panel with it", async () => {
    await mount(true);
    await act(async () => { useNotesSearch.getState().byTag("plan"); });
    await settle();
    expect(document.querySelector<HTMLSelectElement>("select[aria-label='Tag']")!.value).toBe("plan");
    const asked = calls.filter((c) => c.cmd === "index_search").map((c) => c.args);
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((a) => (a.filters as { tag?: string }).tag === "plan" && a.query === "")).toBe(true);
    // Filters apply to the pages of folder notebooks only, so the other sources are not asked.
    expect(searchedLm()).toBe(false);
    expect(groupTitles()).toEqual(["This notebook", "Other notebooks"]);
    await setValue(document.querySelector("select[aria-label='Kind']")!, "hmdoc");
    await settle();
    expect(calls.filter((c) => c.cmd === "index_search").some((c) => (c.args.filters as { kind?: string }).kind === "hmdoc")).toBe(true);
  });
});
