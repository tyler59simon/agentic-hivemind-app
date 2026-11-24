// @vitest-environment jsdom
// CON-15: the People pane sets the location up (one notebook at a time), lists people with open and overdue counts, and lists
// the owners that have no page. The rail's Open items section reads the same grouping.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const calls: { cmd: string; args: Record<string, unknown> }[] = [];
let metas: Record<string, Record<string, unknown>> = {};
let notebooks: { id: string; path: string; title: string; added: string }[] = [];
const task = (line: number, text: string, due: string | null = null) => ({ notebook: "nb-1", path: "Plan.md", title: "Plan", line, done: false, text, due, owner: null, priority: null, sha256: "h" });
const tasks = [
  task(1, "ship it (due: 2000-01-01, owner: Dana)", "2000-01-01"),
  task(2, "review (due: 2999-01-01, owner: dana lee)", "2999-01-01"),
  task(3, "plan (owner: Sam Okafor)"),
  task(4, "call (owner: sam okafor)"),
  task(5, "no owner"),
];
const people = [{ notebook: "nb-1", path: "People/Dana Lee.md", title: "Dana Lee", sha256: "h", mtimeMs: 1, props: { aliases: ["Dana"], role: "Lead" } }];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: Record<string, unknown>) => {
    calls.push({ cmd, args });
    switch (cmd) {
      case "notebooks_list": return notebooks;
      case "notebook_meta_get": return metas[args.id as string] ?? {};
      case "notebook_meta_set": {
        const cur = { ...(metas[args.id as string] ?? {}) };
        for (const [k, v] of Object.entries(args.patch as Record<string, unknown>)) { if (v === null) delete cur[k]; else cur[k] = v; }
        metas[args.id as string] = cur;
        return cur;
      }
      case "index_query": return people;
      case "index_tasks": return tasks;
      case "file_create": return { sha256: "n", size: 1, mtimeMs: 1 };
    }
    return null;
  }),
}));

const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { PeoplePane } = await import("./PeoplePane");
const { PersonItems } = await import("./PersonItems");
const { useConnection } = await import("../../lib/connection");
const { useWorkspace } = await import("../../workspace/store");

let root: Root | null = null;
const settle = async () => { for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 20)); }); };
async function mount(node: React.ReactNode) {
  useConnection.setState({ commands: [], api: 2, capabilities: undefined });
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root!.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>));
  await settle();
  return el;
}
const click = async (el: Element) => { await act(async () => { (el as HTMLElement).click(); }); await settle(); };
const button = (label: string) => [...document.querySelectorAll("button")].find((b) => b.textContent?.includes(label))!;
async function type(el: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  calls.length = 0;
  metas = {};
  notebooks = [{ id: "nb-1", path: "C:\\one", title: "Main", added: "" }, { id: "nb-2", path: "C:\\two", title: "Other", added: "" }];
  useWorkspace.setState({ panes: [{ id: "p0", tabs: [], active: null }], focused: "p0", dirty: {}, reveal: null });
});
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.innerHTML = ""; });

describe("the People pane", () => {
  it("asks for a notebook and folder when not set up, and saves the sidecar key", async () => {
    const el = await mount(<PeoplePane onAdd={vi.fn()} />);
    expect(el.querySelector("form")).not.toBeNull();
    expect(el.querySelector<HTMLInputElement>("input")!.value).toBe("People");
    await click(button("Save"));
    expect(calls.filter((c) => c.cmd === "notebook_meta_set").map((c) => [c.args.id, c.args.patch])).toEqual([["nb-1", { people: { folder: "People" } }]]);
    expect(metas["nb-1"]).toEqual({ people: { folder: "People" } });
  });

  it("moves People to another notebook and clears the key on the first", async () => {
    metas = { "nb-1": { people: { folder: "People" }, daily: { folder: "Daily" } } };
    const el = await mount(<PeoplePane onAdd={vi.fn()} />);
    await click(button("Change location"));
    const select = el.querySelector("select")!;
    await act(async () => { select.value = "nb-2"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    await type(el.querySelector<HTMLInputElement>("input")!, "Team/");
    await click(button("Save"));
    expect(metas["nb-2"]).toEqual({ people: { folder: "Team" } });
    expect(metas["nb-1"]).toEqual({ daily: { folder: "Daily" } });
  });

  it("says to add a notebook when there is none, and offers the add action", async () => {
    notebooks = [];
    const onAdd = vi.fn();
    const el = await mount(<PeoplePane onAdd={onAdd} />);
    expect(el.textContent).toContain("Add a notebook first");
    await click(button("Add a notebook"));
    expect(onAdd).toHaveBeenCalled();
  });

  it("lists people with their open and overdue counts, and the owners without a page", async () => {
    metas = { "nb-1": { people: { folder: "People" } } };
    const el = await mount(<PeoplePane onAdd={vi.fn()} />);
    const rows = [...el.querySelectorAll(".people-list")][0].querySelectorAll("li");
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("Dana Lee");
    expect(rows[0].textContent).toContain("Lead");
    expect(rows[0].textContent).toContain("2 open");
    expect(rows[0].textContent).toContain("1 overdue");
    const without = [...el.querySelectorAll(".people-list")][1].querySelectorAll("li");
    expect(without).toHaveLength(1);
    expect(without[0].textContent).toContain("Sam Okafor");
    expect(without[0].textContent).toContain("2 open");
  });

  it("creates a page for an owner without one, and opens it", async () => {
    metas = { "nb-1": { people: { folder: "People" } } };
    const el = await mount(<PeoplePane onAdd={vi.fn()} />);
    await click([...el.querySelectorAll(".people-list")][1].querySelector("button")!);
    expect(calls.find((c) => c.cmd === "file_create")!.args).toMatchObject({ notebook: "nb-1", path: "People/Sam Okafor.md" });
    expect(useWorkspace.getState().panes[0].tabs[0].file).toEqual({ notebook: "nb-1", path: "People/Sam Okafor.md" });
  });

  it("asks for a name for a new person", async () => {
    metas = { "nb-1": { people: { folder: "People" } } };
    await mount(<PeoplePane onAdd={vi.fn()} />);
    await click(button("New person"));
    await type(document.querySelector<HTMLInputElement>("[role=dialog] input")!, "Pat Quinn");
    await click(button("Create page"));
    expect(calls.find((c) => c.cmd === "file_create")!.args).toMatchObject({ path: "People/Pat Quinn.md" });
  });
});

describe("the Open items section of a person's page", () => {
  it("lists the open tasks that name the person, with due date and source", async () => {
    metas = { "nb-1": { people: { folder: "People" } } };
    const el = await mount(<PersonItems file={{ notebook: "nb-1", path: "People/Dana Lee.md" }} />);
    expect(el.querySelector("h2")?.textContent).toBe("Open items");
    const rows = [...el.querySelectorAll("li")];
    expect(rows.map((r) => r.querySelector("span")?.textContent)).toEqual(["ship it", "review"]);
    expect(rows[0].textContent).toContain("2000-01-01");
    expect(rows[0].textContent).toContain("Plan");
  });

  it("shows nothing on a page outside the People folder", async () => {
    metas = { "nb-1": { people: { folder: "People" } } };
    const el = await mount(<PersonItems file={{ notebook: "nb-1", path: "Plan.md" }} />);
    expect(el.textContent).toBe("");
  });
});
