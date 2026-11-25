// @vitest-environment jsdom
// NS-4A / NS-4B / CON-11: the unified top-bar search box mounted for real: typing opens the panel with Memory notes first,
// then This notebook and Other notebooks (Living Memory pages were retired by CON-18); supports project scoping, archive/type/tag filters,
// Meaning search, keyboard navigation, and opening notes or pages directly in the workspace.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const calls: { cmd: string; args: Record<string, unknown> }[] = [];
let meaningState = "ready";
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
        const meaning = args.meaning ? meaningState : "off";
        if (f.notebook === "nb-1") return { hits: [hit("nb-1", "Projects/Plan.md", "Plan", `the ${MARK("plan")} for the quarter`), hit("nb-1", "Inbox.md", "Inbox")], ms: 1, state: "idle", meaning };
        if (f.excludeNotebook === "nb-1" || !f.notebook) return { hits: [hit("nb-2", "Plan.md", "Plan notes")], ms: 1, state: "idle", meaning };
        return { hits: [], ms: 1, state: "idle", meaning };
      }
      case "lm": {
        const argv = args.argv as string[];
        if (argv[0] === "taxonomy") return { exit_code: 0, error: null, result: { tags: ["concern/decision", "project/pay"] } };
        if (argv[0] === "projects") return { exit_code: 0, error: null, result: { ok: true, projects: [{ slug: "pay", name: "Paystream", status: "active", repos: [], aliases: [], description: "", charter: null, created: "", updated: "", tag: "project/pay", tag_registered: true }], warnings: [] } };
        if (argv[0] === "search" && argv[1].startsWith("--")) return { exit_code: 0, error: null, result: { mode: "list", domains: ["demo"], total: 1, offset: 0, notes: [{ ref: "demo:2", id: "2", domain: "demo", title: "Old archived plan", type: "plan", status: "archived", tags: ["plan"], created: "2026-10-01", updated: "2026-10-02", revision: "r", path: "", summary: "Retired plan" }] } };
        if (argv[0] === "search") return { exit_code: 0, error: null, result: { mode: "lexical", domains: ["demo"], fallback: false, results: [{ id: "demo:1", domain: "demo", title: "Plan decision", type: "decision", snippet: "we plan", updated: "2026-11-20", tags: ["project/pay"], status: "active", score: 1, rank: 1, engine: "lexical", revision: "r", sourceField: "body", sourceScope: "active", relevance: 1 }] } };
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

const settle = async () => { for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 200)); }); };
const input = () => document.querySelector<HTMLInputElement>("input[role='combobox']")!;
const setValue = async (e: Element, v: string) => {
  const proto = e instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  await act(async () => { Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(e, v); e.dispatchEvent(new Event(e instanceof HTMLSelectElement ? "change" : "input", { bubbles: true })); });
};
const press = async (key: string, mods: { ctrlKey?: boolean } = {}) => act(async () => { input().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...mods })); });
const searchedLm = () => calls.some((c) => { const argv = (c.args?.argv ?? []) as string[]; return c.cmd === "lm" && argv[0] === "search" && !argv[1].startsWith("--"); });
const noteSearches = () => calls.filter((c) => { const argv = (c.args?.argv ?? []) as string[]; return c.cmd === "lm" && argv[0] === "search" && !argv[1].startsWith("--"); });
const groupTitles = () => [...document.querySelectorAll(".search-group h3")].map((h) => h.textContent);
const rows = () => [...document.querySelectorAll<HTMLElement>("[role=option]")];
const activeRow = () => rows().findIndex((r) => r.getAttribute("aria-selected") === "true");

async function mount() {
  useConnection.setState({ commands: ["doc", "search", "taxonomy", "projects"], api: 4, capabilities: { docs: { version: 1, max_page_bytes: 1 } } });
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
  meaningState = "ready";
  useNotesSearch.setState({ query: "", filters: NO_FILTERS, meaning: false, open: false, focusTick: 0 });
  useApp.setState({ domain: "demo", project: null });
  useWorkspace.setState({
    panes: [{ id: "p1", tabs: [{ id: "t1", kind: "file", file: { notebook: "nb-1", path: "Inbox.md" }, mode: "live", title: "Inbox" }], active: "t1" }], focused: "p1",
    openTab: ((tab: Record<string, unknown>, opts?: { split?: boolean }) => { opened.push({ tab, split: !!opts?.split }); }) as never,
  });
});
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.innerHTML = ""; });

describe("the unified top-bar search box (CON-11)", () => {
  it("is quiet until there is something to search, then shows Memory notes first followed by notebook groups", async () => {
    await mount();
    await act(async () => input().focus());
    expect(document.querySelector(".search-panel")).not.toBeNull();
    expect(rows()).toHaveLength(0);
    expect(calls.some((c) => c.cmd === "index_search")).toBe(false);
    await setValue(input(), "plan");
    await settle();
    expect(groupTitles()).toEqual(["Memory notes", "This notebook", "Other notebooks"]);
    expect(rows().map((r) => r.querySelector(".search-title")?.textContent)).toEqual([
      "Plan decision · Paystream · decision", "Plan · Projects", "Inbox", "Plan notes · Work",
    ]);
    expect(document.querySelector(".search-panel mark")?.textContent).toBe("Plan");
    expect(document.body.textContent).not.toContain("Show all in Memory");
    const asked = calls.filter((c) => c.cmd === "index_search").map((c) => c.args.filters);
    expect(asked).toEqual(expect.arrayContaining([expect.objectContaining({ notebook: "nb-1" }), expect.objectContaining({ excludeNotebook: "nb-1" })]));
  });

  it("closes when the keyboard moves the focus out of the box and its panel, and stays open while it moves inside", async () => {
    await mount();
    const outside = document.createElement("button");
    document.body.append(outside);
    await act(async () => input().focus());
    await act(async () => document.querySelector<HTMLElement>(".search-panel select, .search-panel button")!.focus());
    expect(document.querySelector(".search-panel")).not.toBeNull();
    await act(async () => outside.focus());
    expect(document.querySelector(".search-panel")).toBeNull();
  });

  it("has no Living Memory pages group even when Living Memory reports pages, and never asks it for them (CON-18)", async () => {
    await mount();
    await act(async () => input().focus());
    await setValue(input(), "plan");
    await settle();
    expect(groupTitles()).not.toContain("Living Memory pages");
    expect(calls.some((c) => c.cmd === "lm" && (c.args.argv as string[]).includes("--pages"))).toBe(false);
    expect(calls.some((c) => c.cmd === "lm" && (c.args.argv as string[])[0] === "doc")).toBe(false);
  });

  it("the arrow keys move over the rows, Enter opens the one marked, and the panel closes", async () => {
    await mount();
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
    expect(opened).toEqual([{ tab: expect.objectContaining({ kind: "file", file: { notebook: "nb-1", path: "Projects/Plan.md" } }), split: false }]);
    expect(document.querySelector(".search-panel")).toBeNull();
  });

  it("Ctrl+Enter opens beside, a memory note opens as a note, and a folder page opens as a notebook page", async () => {
    await mount();
    await act(async () => input().focus());
    await setValue(input(), "plan");
    await settle();
    await press("End");   // End belongs to the text cursor: the rows do not move
    expect(activeRow()).toBe(0);
    await press("Enter");
    expect(opened[0]).toMatchObject({ split: false, tab: { kind: "note", ref: "demo:1" } });
    expect(useApp.getState().domain).toBe("demo");
    await act(async () => input().focus());
    await setValue(input(), "plan ");
    await settle();
    for (let i = 0; i < 3; i++) await press("ArrowDown");
    await press("Enter", { ctrlKey: true });
    expect(opened[1]).toMatchObject({ split: true, tab: { kind: "file", file: { notebook: "nb-2", path: "Plan.md" } } });
  });

  it("Escape closes the panel first and leaves the box after that", async () => {
    await mount();
    await act(async () => input().focus());
    await setValue(input(), "plan");
    await settle();
    await press("Escape");
    expect(document.querySelector(".search-panel")).toBeNull();
    expect(input().value).toBe("plan");
  });

  it("browses archived Memory notes with an empty query when Status is Archive", async () => {
    await mount();
    await act(async () => { useNotesSearch.getState().byStatus("archived"); });
    await settle();
    expect(groupTitles()).toEqual(["Memory notes"]);
    expect(rows()[0].querySelector(".search-title")?.textContent).toBe("Old archived plan · Unassigned · plan · archived");
    expect(calls.some((c) => c.cmd === "index_search")).toBe(false);
  });

  it("scopes Memory notes to the picked project and widens them with All memory", async () => {
    useApp.setState({ domain: "demo", project: "pay" });
    await mount();
    await settle();
    await act(async () => input().focus());
    await setValue(input(), "plan");
    await settle();
    const searchCall = noteSearches().pop();
    expect(searchCall?.args.argv).toContain("tag=project/pay");
    const scopeBtn = [...document.querySelectorAll<HTMLButtonElement>(".search-filters button")].find((b) => b.textContent === "Paystream")!;
    calls.length = 0;
    await act(async () => { scopeBtn.click(); });
    await settle();
    const wideCall = noteSearches().pop();
    expect(wideCall?.args.argv).not.toContain("tag=project/pay");
  });

  it("page-only filters narrow to pages, while a tag searches both pages and memory notes", async () => {
    await mount();
    await act(async () => { useNotesSearch.getState().byTag("plan"); });
    await settle();
    expect(document.querySelector<HTMLSelectElement>("select[aria-label='Tag']")!.value).toBe("plan");
    expect(calls.some((c) => c.cmd === "index_search" && (c.args.filters as { tag?: string }).tag === "plan")).toBe(true);
    calls.length = 0;
    await setValue(document.querySelector("select[aria-label='Kind']")!, "hmdoc");
    await settle();
    expect(searchedLm()).toBe(false);
    expect(calls.filter((c) => c.cmd === "index_search").some((c) => (c.args.filters as { kind?: string }).kind === "hmdoc")).toBe(true);
  });
});

describe("the Meaning toggle (NS-4B)", () => {
  const toggle = () => [...document.querySelectorAll<HTMLButtonElement>(".search-filters button")].find((b) => b.textContent === "Meaning")!;
  const asked = () => calls.filter((c) => c.cmd === "index_search").map((c) => c.args);

  it("is off at first, and turning it on asks the index for meaning, for this notebook and the others", async () => {
    await mount();
    await act(async () => input().focus());
    await setValue(input(), "plan");
    await settle();
    expect(toggle().getAttribute("aria-pressed")).toBe("false");
    expect(asked().every((a) => !("meaning" in a))).toBe(true);
    expect(document.querySelector(".semantic-hint")).toBeNull();
    calls.length = 0;
    await act(async () => { toggle().click(); });
    await settle();
    expect(toggle().getAttribute("aria-pressed")).toBe("true");
    expect(asked().length).toBeGreaterThanOrEqual(2);
    expect(asked().every((a) => a.meaning === true)).toBe(true);
    expect(groupTitles()).toContain("This notebook");
    expect(document.querySelector(".semantic-hint")).toBeNull();
  });

  it("says the model is missing, with a button that copies the install command, while the pages are still found by words", async () => {
    meaningState = "missing";
    const written: string[] = [];
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async (t: string) => { written.push(t); } }, configurable: true });
    await mount();
    await act(async () => input().focus());
    await setValue(input(), "plan");
    await act(async () => { toggle().click(); });
    await settle();
    const hint = document.querySelector(".semantic-hint")!;
    expect(hint.textContent).toContain("Semantic search needs the Living Memory model. Run alm semantic install.");
    expect(hint.querySelector("code")?.textContent).toBe("alm semantic install");
    expect(groupTitles()).toContain("This notebook");
    await act(async () => { [...hint.querySelectorAll("button")].find((b) => b.textContent === "Copy command")!.click(); });
    expect(written).toEqual(["alm semantic install"]);
  });

  it("says the pages are still being read while the vectors are made", async () => {
    meaningState = "building";
    await mount();
    await act(async () => input().focus());
    await setValue(input(), "plan");
    await act(async () => { toggle().click(); });
    await settle();
    expect(document.querySelector(".search-panel")!.textContent).toContain("Meaning search is still reading your pages");
    expect(document.querySelector(".semantic-hint")).toBeNull();
  });
});
