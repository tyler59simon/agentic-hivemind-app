// @vitest-environment jsdom
// CON-13: the Views sub-view over the views Living Memory keeps: both kinds listed, a query view opened into the form and run, saved
// (add), changed (update) and deleted through Living Memory, an invalid form refused, and a note view opened as its dashboard.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Stored { kind: "note" | "query"; [key: string]: unknown }
const calls: { cmd: string; args: Record<string, unknown> }[] = [];
let stored: Stored[] = [];
const NOTE_ID = "3a562a09-2b34-4a43-8901-c7a1801168e6";
const ok = (result: unknown) => ({ exit_code: 0, result, error: null });
const lm = (argv: string[], body?: string) => {
  if (argv[0] !== "views") return { exit_code: 1, result: null, error: { code: "invalid", message: "not mocked" } };
  if (argv[1] === "--all-domains") return ok({ ok: true, views: stored });
  if (argv[1] === "render") return ok({ ok: true, model: { id: NOTE_ID, domain: "demo", title: "Hook plan", type: "plan", status: "active", updated: "", revision: "r", summary: "", important: null, items: [], sections: [], counts: { open: 0, done: 0, total: 0 }, superseded_by: null } });
  if (argv[1] === "remove") { stored = stored.filter((v) => v.id !== argv[2]); return ok({ ok: true, kind: "query", id: argv[2], status: "removed", operation_id: "op-remove" }); }
  const title = argv[argv.indexOf("--title") + 1];
  if (argv[1] === "add") {
    stored = [...stored, { kind: "query", id: "q-0000000" + stored.length, title, spec: JSON.parse(body!), added: "" }];
    return ok({ ok: true, kind: "query", id: stored[stored.length - 1].id, title, status: "added", operation_id: "op-add" });
  }
  stored = stored.map((v) => (v.id === argv[2] ? { ...v, title: argv.includes("--title") ? title : v.title, spec: JSON.parse(body!) } : v));
  return ok({ ok: true, kind: "query", id: argv[2], title, status: "updated", operation_id: "op-update" });
};
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: Record<string, unknown>) => {
    calls.push({ cmd, args });
    switch (cmd) {
      case "notebooks_list": return [{ id: "nb-1", path: "C:\\one", title: "Main", added: "" }];
      case "lm": return lm(args.argv as string[]);
      case "lm_body": return lm(args.argv as string[], args.body as string);
      case "index_query": return [{ notebook: "nb-1", path: "Plan.md", title: "Plan", sha256: "s", mtimeMs: 1, props: { status: "active" } }];
    }
    return null;
  }),
}));

const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { ViewsPage } = await import("./ViewsPage");
const { useConnection } = await import("../../lib/connection");
const { useApp } = await import("../../store");

let root: Root | null = null;
let copied = "";
const settle = async () => { for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 30)); }); };
const set = async (el: Element, value: string) => {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  await act(async () => { Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value); el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true })); });
};
const byLabel = (label: string) => document.querySelector<HTMLInputElement | HTMLSelectElement>(`[aria-label='${label}']`)!;
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim().startsWith(text))!;
const rowsText = () => [...document.querySelectorAll(".views-list li")].map((li) => li.textContent);
const written = () => calls.filter((c) => c.cmd === "lm_body" || (c.cmd === "lm" && (c.args.argv as string[])[1] === "remove"));

async function mount(version = 2) {
  useConnection.setState({ commands: ["views"], api: 2, capabilities: { views: { version, kinds: ["note", "query"] } } });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<QueryClientProvider client={client}><ViewsPage /></QueryClientProvider>));
  await settle();
}

beforeEach(() => {
  calls.length = 0;
  copied = "";
  stored = [
    { kind: "note", note: NOTE_ID, domain: "demo", title: "Hook plan", note_title: "Hook plan", path: "x.html", fresh: true, artifact_url: null, artifact_current: false, exists: true },
    { kind: "query", id: "q-aaaaaaaa", title: "Active", spec: { version: 1, where: [{ prop: "status", op: "eq", value: "active" }], sort: [{ prop: "due", dir: "desc" }], view: "table", columns: ["status"], limit: 500 }, added: "" },
    { kind: "query", id: "q-bbbbbbbb", title: "Broken", spec: { version: 2 }, added: "" },
  ];
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t: string) => { copied = t; } } });
  useApp.setState({ route: { page: "notes", view: "views" }, back: [] });
});
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.innerHTML = ""; });

describe("the Views sub-view", () => {
  it("lists both kinds, and opening a query view fills the form and runs it", async () => {
    await mount();
    expect(rowsText()).toEqual(["Hook plan Note", "Active Query", "Broken Query"]);
    await act(async () => button("Active").click());
    await settle();
    expect(useApp.getState().route).toEqual({ page: "notes", view: "views", ref: "q-aaaaaaaa" });
    expect(byLabel("Property 1").value).toBe("status");
    expect(byLabel("Value 1").value).toBe("active");
    expect(byLabel("Sort direction 1").value).toBe("desc");
    expect(byLabel("View name").value).toBe("Active");
    expect(calls.filter((c) => c.cmd === "index_query").slice(-1)[0].args).toEqual({ query: { from: { notebooks: [], folder: null, tag: null }, where: [{ prop: "status", op: "eq", value: "active" }], sort: [{ prop: "due", dir: "desc" }], limit: 500 } });
    expect(document.querySelector(".query-table tbody")!.textContent).toContain("Plan");
  });

  it("opens a note view as its dashboard", async () => {
    await mount();
    await act(async () => button("Hook plan").click());
    await settle();
    expect(useApp.getState().route).toMatchObject({ ref: `demo:${NOTE_ID}` });
    expect(document.querySelector(".views-editor h1")!.textContent).toBe("Hook plan");
    expect(button("Open HTML")).toBeTruthy();
    expect(document.querySelector(".query-save")).toBeNull();
  });

  it("opens the view a route names", async () => {
    useApp.setState({ route: { page: "notes", view: "views", ref: "q-aaaaaaaa" } });
    await mount();
    expect(byLabel("View name").value).toBe("Active");
  });

  it("says why a stored query is not one, and keeps the form as it was", async () => {
    await mount();
    await act(async () => button("Broken").click());
    expect(document.querySelector(".views-editor")!.textContent).toContain("Broken is not a valid view");
  });

  it("saves what the form holds as a new view through Living Memory, and opens it", async () => {
    await mount();
    await act(async () => button("New view").click());
    await act(async () => button("Add a condition").click());
    await set(byLabel("Property 1"), "owner");
    await set(byLabel("Condition 1"), "contains");
    await set(byLabel("Value 1"), "ana");
    await set(byLabel("View"), "board");
    await set(byLabel("Group cards by"), "owner");
    await set(byLabel("View name"), "Ana's cards");
    await act(async () => button("Save view").click());
    await settle();
    const [add] = written();
    expect(add.args.argv).toEqual(["views", "add", "--title", "Ana's cards"]);
    expect(add.args.flag).toBe("--spec-file");
    expect(JSON.parse(add.args.body as string)).toMatchObject({ version: 1, view: "board", groupBy: "owner", where: [{ prop: "owner", op: "contains", value: "ana" }] });
    expect(rowsText()).toContain("Ana's cards Query");
    expect(useApp.getState().route).toEqual({ page: "notes", view: "views", ref: "q-00000003" });
  });

  it("updates the opened view when it is saved again, and does not add a copy", async () => {
    await mount();
    await act(async () => button("Active").click());
    await settle();
    await set(byLabel("Value 1"), "paused");
    await set(byLabel("View name"), "Paused");
    await act(async () => button("Save view").click());
    await settle();
    const [update, ...rest] = written();
    expect(rest).toEqual([]);
    expect(update.args.argv).toEqual(["views", "update", "q-aaaaaaaa", "--title", "Paused"]);
    expect(JSON.parse(update.args.body as string)).toMatchObject({ where: [{ prop: "status", op: "eq", value: "paused" }] });
    expect(rowsText()).toEqual(["Hook plan Note", "Paused Query", "Broken Query"]);
  });

  it("does not offer to save a form that is not a query, and says what is wrong", async () => {
    await mount();
    await act(async () => button("New view").click());
    await set(byLabel("View"), "board");
    expect(document.querySelector(".views-editor")!.textContent).toContain("A board needs \"groupBy\"");
    await set(byLabel("View name"), "x");
    expect(button("Save view").disabled).toBe(true);
    expect(written()).toEqual([]);
  });

  it("does not offer to save when Living Memory has no query views", async () => {
    await mount(1);
    await act(async () => button("New view").click());
    await set(byLabel("View name"), "x");
    expect(button("Save view").disabled).toBe(true);
  });

  it("deletes the opened view, and copies the query as a block for a page", async () => {
    await mount();
    await act(async () => button("Active").click());
    await settle();
    await act(async () => button("Copy as page block").click());
    expect(copied.startsWith("```query\n{")).toBe(true);
    expect(JSON.parse(copied.slice("```query\n".length, -"\n```\n".length))).toMatchObject({ version: 1, where: [{ prop: "status", op: "eq", value: "active" }] });
    await act(async () => button("Delete view").click());
    await settle();
    expect(written()[0].args.argv).toEqual(["views", "remove", "q-aaaaaaaa"]);
    expect(rowsText()).toEqual(["Hook plan Note", "Broken Query"]);
    expect(useApp.getState().route).toEqual({ page: "notes", view: "views" });
    expect(byLabel("View name").value).toBe("");
  });
});
