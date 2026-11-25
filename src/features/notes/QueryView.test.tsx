// @vitest-environment jsdom
// NS-7B: a query block of a page drawn as a table or a board; a table cell edits a property in place; dragging a card to
// another column writes that property to the card's page against the hash the board was drawn from.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const calls: { cmd: string; args: Record<string, unknown> }[] = [];
const files = new Map<string, string>();
const sha = (raw: string) => `sha-${raw}`;
/** What the index has: the pages as they were when they were indexed. */
let indexed: { notebook: string; path: string; title: string; sha256: string; mtimeMs: number; props: Record<string, string | string[]> }[] = [];
const page = (path: string, status: string, extra = "") => `---\nstatus: ${status}${extra}\n---\n# ${path}\n`;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: Record<string, unknown>) => {
    calls.push({ cmd, args });
    switch (cmd) {
      case "notebooks_list": return [{ id: "nb-1", path: "C:\\one", title: "Main", added: "" }];
      case "index_query": return indexed;
      case "file_read": {
        const raw = files.get(args.path as string);
        if (raw === undefined) throw new Error("not found");
        return { text: raw, sha256: sha(raw), size: raw.length, mtimeMs: 1, format: { encoding: "UTF-8", bom: false, eol: "lf" }, readOnly: null, binary: false };
      }
      case "file_save": {
        const raw = files.get(args.path as string)!;
        if (sha(raw) !== (args.pre as { sha256: string }).sha256) return { status: "stale", sha256: sha(raw) };
        files.set(args.path as string, args.text as string);
        return { status: "saved", sha256: sha(args.text as string), size: 1, mtimeMs: 2 };
      }
    }
    return null;
  }),
}));

const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { QueryBlock } = await import("./QueryView");
const { PageView } = await import("./PageView");
const { useConnection } = await import("../../lib/connection");
const { useToasts } = await import("../../ui/toast");
const { useWorkspace } = await import("../../workspace/store");
const { useApp } = await import("../../store");
const docs = await import("../../documents/store");

let root: Root | null = null;
const settle = async () => { for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 30)); }); };
const BOARD = JSON.stringify({ version: 1, view: "board", groupBy: "status", columns: ["owner"], from: { notebooks: ["nb-1"] } });
const TABLE = JSON.stringify({ version: 1, view: "table", columns: ["status", "owner"], sort: [{ prop: "title" }] });

async function render(node: React.ReactNode) {
  useConnection.setState({ commands: [], api: 2, capabilities: undefined });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>));
  await settle();
}

/** A drag from one element to another, with the data transfer a browser would give. */
async function drag(from: Element, to: Element) {
  const data: Record<string, string> = {};
  const transfer = { setData: (k: string, v: string) => { data[k] = v; }, getData: (k: string) => data[k] ?? "", effectAllowed: "" };
  const fire = async (el: Element, type: string) => act(async () => { const e = new Event(type, { bubbles: true, cancelable: true }); Object.defineProperty(e, "dataTransfer", { value: transfer }); el.dispatchEvent(e); });
  await fire(from, "dragstart");
  await fire(to, "dragover");
  await fire(to, "drop");
  await settle();
}
const column = (name: string) => document.querySelector<HTMLElement>(`.board-column[aria-label='${name}']`)!;
const cards = (name: string) => [...column(name).querySelectorAll(".board-card .link")].map((c) => c.textContent);

beforeEach(() => {
  calls.length = 0;
  files.clear();
  files.set("A.md", page("A", "todo", "\nowner: ana"));
  files.set("B.md", page("B", "doing"));
  files.set("C.md", page("C", "todo"));
  indexed = ["A", "B", "C"].map((n) => ({ notebook: "nb-1", path: `${n}.md`, title: n, sha256: sha(files.get(`${n}.md`)!), mtimeMs: 1, props: { status: files.get(`${n}.md`)!.includes("doing") ? "doing" : "todo", ...(n === "A" ? { owner: "ana" } : {}) } }));
  useToasts.setState({ items: [] });
  useWorkspace.setState({ panes: [{ id: "p0", tabs: [], active: null }], focused: "p0", dirty: {}, reveal: null });
  useApp.setState({ route: { page: "notes" }, back: [] });
  docs.useDocuments.setState({ docs: {}, refs: {} });
});
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.innerHTML = ""; });

describe("a query block", () => {
  it("is a table with the chosen columns, the page title opening the page", async () => {
    await render(<QueryBlock source={TABLE} />);
    expect([...document.querySelectorAll("thead th")].map((h) => h.textContent)).toEqual(["Page", "status", "owner", "Notebook"]);
    expect([...document.querySelectorAll("tbody tr")].map((r) => [...r.querySelectorAll("td")].map((c) => c.textContent))).toEqual([
      ["A", "todo", "ana", "Main"], ["B", "doing", "-", "Main"], ["C", "todo", "-", "Main"],
    ]);
    expect(calls.find((c) => c.cmd === "index_query")!.args).toEqual({ query: { from: { notebooks: [], folder: null, tag: null }, where: [], sort: [{ prop: "title", dir: "asc" }], limit: 500 } });
  });

  it("says what is wrong with a block that is not a query, and shows the block", async () => {
    await render(<QueryBlock source={'{ "version": 1, "view": "cards" }'} />);
    expect(document.querySelector(".query-block")!.textContent).toContain("This query block is not valid: \"view\" is table or board");
    expect(document.querySelector(".query-block pre")!.textContent).toContain("cards");
    expect(calls.some((c) => c.cmd === "index_query")).toBe(false);
  });

  it("is drawn by a page's Reading view for a fenced block named query", async () => {
    await render(<PageView text={`# Page\n\n\`\`\`query\n${TABLE}\n\`\`\`\n\n\`\`\`js\nplain()\n\`\`\`\n`} tabId="t" onLink={() => {}} />);
    expect(document.querySelectorAll(".query-table")).toHaveLength(1);
    expect(document.querySelector("pre code.language-js")).not.toBeNull();
  });
});

describe("editing a table cell", () => {
  async function edit(row: number, col: number, value: string) {
    await act(async () => document.querySelectorAll<HTMLButtonElement>("tbody tr")[row].querySelectorAll("td")[col].querySelector<HTMLButtonElement>("button.cell")!.click());
    const input = document.querySelector<HTMLInputElement>("tbody input")!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    await settle();
  }

  it("writes that property alone, against the hash the table was drawn from", async () => {
    await render(<QueryBlock source={TABLE} />);
    const before = files.get("B.md")!;
    await edit(1, 1, "done");
    expect(files.get("B.md")).toBe(before.replace("status: doing", "status: done"));
    expect(calls.find((c) => c.cmd === "file_save")!.args).toMatchObject({ path: "B.md", pre: { sha256: sha(before) } });
  });

  it("adds a property a page lacks, and clears one when its cell is emptied", async () => {
    await render(<QueryBlock source={TABLE} />);
    await edit(1, 2, "bo");
    expect(files.get("B.md")).toBe(page("B", "doing", "\nowner: bo"));
    await edit(0, 2, "");
    expect(files.get("A.md")).toBe(page("A", "todo"));
  });

  it("refuses a page that changed since the table was drawn, and says so", async () => {
    await render(<QueryBlock source={TABLE} />);
    files.set("B.md", page("B", "doing", "\nowner: someone"));
    await edit(1, 1, "done");
    expect(files.get("B.md")).toBe(page("B", "doing", "\nowner: someone"));
    expect(calls.some((c) => c.cmd === "file_save")).toBe(false);
    expect(useToasts.getState().items.map((t) => t.text)).toEqual([expect.stringMatching(/B\.md changed since it was read/)]);
  });
});

describe("dragging a card on a board", () => {
  it("groups the cards by the property, with a column for pages that have none", async () => {
    await render(<QueryBlock source={BOARD} />);
    expect(cards("todo")).toEqual(["A", "C"]);
    expect(cards("doing")).toEqual(["B"]);
    expect(column("No status").querySelectorAll(".board-card")).toHaveLength(0);
    expect(column("todo").textContent).toContain("owner ana");
  });

  it("writes the column's value to the card's page against the hash the board was drawn from", async () => {
    await render(<QueryBlock source={BOARD} />);
    const before = files.get("A.md")!;
    await drag(column("todo").querySelector("[aria-label='Card A']")!, column("doing"));
    expect(files.get("A.md")).toBe(before.replace("status: todo", "status: doing"));
    expect(calls.find((c) => c.cmd === "file_save")!.args).toMatchObject({ path: "A.md", pre: { sha256: sha(before) } });
    expect(cards("doing")).toContain("A");
  });

  it("moves a card from the column list on the card, with no drag, by the same write", async () => {
    await render(<QueryBlock source={BOARD} />);
    const before = files.get("A.md")!;
    const select = column("todo").querySelector<HTMLSelectElement>("select[aria-label='Column of A']")!;
    expect([...select.options].map((o) => o.textContent)).toEqual(["todo", "doing", "No status"]);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, "doing");
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settle();
    expect(files.get("A.md")).toBe(before.replace("status: todo", "status: doing"));
    expect(cards("doing")).toContain("A");
  });

  it("takes the property away when a card is dropped in the column for no value", async () => {
    await render(<QueryBlock source={BOARD} />);
    await drag(column("doing").querySelector("[aria-label='Card B']")!, column("No status"));
    expect(files.get("B.md")).toBe("---\n---\n# B\n");
  });

  it("refuses a drop on a page that changed, puts the card back and says why", async () => {
    await render(<QueryBlock source={BOARD} />);
    const changed = page("C", "todo", "\nowner: someone");
    files.set("C.md", changed);
    await drag(column("todo").querySelector("[aria-label='Card C']")!, column("doing"));
    expect(files.get("C.md")).toBe(changed);
    expect(calls.some((c) => c.cmd === "file_save")).toBe(false);
    expect(useToasts.getState().items.map((t) => t.text)).toEqual([expect.stringMatching(/C\.md changed since it was read/)]);
    expect(cards("todo")).toContain("C");
  });

  it("does not move a card whose property holds several values", async () => {
    indexed[2].props.status = ["todo", "later"];
    await render(<QueryBlock source={BOARD} />);
    await drag(column("todo").querySelector("[aria-label='Card C']")!, column("doing"));
    expect(calls.some((c) => c.cmd === "file_save")).toBe(false);
    expect(useToasts.getState().items.map((t) => t.text)).toEqual([expect.stringMatching(/several values for status/)]);
  });
});
