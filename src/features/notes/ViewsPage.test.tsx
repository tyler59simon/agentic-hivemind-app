// @vitest-environment jsdom
// NS-7B: the Views sub-view: the saved views of a folder notebook, opening one into the form and running it, saving what the
// form holds under a name, deleting it, and copying it as a block for a page.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const calls: { cmd: string; args: Record<string, unknown> }[] = [];
let views: { name: string; spec: unknown }[] = [];
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: Record<string, unknown>) => {
    calls.push({ cmd, args });
    switch (cmd) {
      case "notebooks_list": return [{ id: "nb-1", path: "C:\\one", title: "Main", added: "" }, { id: "nb-2", path: "C:\\two", title: "Work", added: "" }];
      case "query_views": return args.notebook === "nb-1" ? views : [];
      case "query_view_save": views = [...views.filter((v) => v.name !== args.name), { name: args.name as string, spec: args.spec }]; return null;
      case "query_view_delete": views = views.filter((v) => v.name !== args.name); return null;
      case "index_query": return [{ notebook: "nb-1", path: "Plan.md", title: "Plan", sha256: "s", mtimeMs: 1, props: { status: "active" } }];
    }
    return null;
  }),
}));

const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { ViewsPage } = await import("./ViewsPage");
const { useConnection } = await import("../../lib/connection");

let root: Root | null = null;
let copied = "";
const settle = async () => { for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 30)); }); };
const set = async (el: Element, value: string) => {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  await act(async () => { Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value); el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true })); });
};
const byLabel = (label: string) => document.querySelector<HTMLInputElement | HTMLSelectElement>(`[aria-label='${label}']`)!;
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim().startsWith(text))!;

beforeEach(async () => {
  calls.length = 0;
  copied = "";
  views = [{ name: "Active", spec: { version: 1, where: [{ prop: "status", op: "eq", value: "active" }], sort: [{ prop: "due", dir: "desc" }], view: "table", columns: ["status"] } }, { name: "Broken", spec: { version: 2 } }];
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t: string) => { copied = t; } } });
  useConnection.setState({ commands: [], api: 2, capabilities: undefined });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<QueryClientProvider client={client}><ViewsPage /></QueryClientProvider>));
  await settle();
});
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.innerHTML = ""; });

describe("the Views sub-view", () => {
  it("lists the saved views with their notebook, and opening one fills the form and runs it", async () => {
    expect([...document.querySelectorAll(".views-list li")].map((li) => li.textContent)).toEqual(["Active Main", "Broken Main"]);
    await act(async () => button("Active").click());
    await settle();
    expect(byLabel("Property 1").value).toBe("status");
    expect(byLabel("Value 1").value).toBe("active");
    expect(byLabel("Sort direction 1").value).toBe("desc");
    expect(byLabel("View name").value).toBe("Active");
    expect(calls.filter((c) => c.cmd === "index_query").slice(-1)[0].args).toEqual({ query: { from: { notebooks: [], folder: null, tag: null }, where: [{ prop: "status", op: "eq", value: "active" }], sort: [{ prop: "due", dir: "desc" }], limit: 500 } });
    expect(document.querySelector(".query-table tbody")!.textContent).toContain("Plan");
  });

  it("says why a view in a file is not one, and keeps the form as it was", async () => {
    await act(async () => button("Broken").click());
    expect(document.querySelector(".views-editor")!.textContent).toContain("Broken is not a valid view");
  });

  it("saves what the form holds under a name in the chosen notebook, and lists it", async () => {
    await act(async () => button("New view").click());
    await act(async () => button("Add a condition").click());
    await set(byLabel("Property 1"), "owner");
    await set(byLabel("Condition 1"), "contains");
    await set(byLabel("Value 1"), "ana");
    await set(byLabel("View"), "board");
    await set(byLabel("Group cards by"), "owner");
    await set(byLabel("View name"), "Ana's cards");
    await set(byLabel("Save in"), "nb-2");
    await act(async () => button("Save view").click());
    await settle();
    const saved = calls.find((c) => c.cmd === "query_view_save")!.args;
    expect(saved).toMatchObject({ notebook: "nb-2", name: "Ana's cards", spec: { version: 1, view: "board", groupBy: "owner", where: [{ prop: "owner", op: "contains", value: "ana" }] } });
  });

  it("does not offer to save a form that is not a query, and says what is wrong", async () => {
    await act(async () => button("New view").click());
    await set(byLabel("View"), "board");
    expect(document.querySelector(".views-editor")!.textContent).toContain("A board needs \"groupBy\"");
    await set(byLabel("View name"), "x");
    expect(button("Save view").disabled).toBe(true);
    expect(calls.some((c) => c.cmd === "query_view_save")).toBe(false);
  });

  it("deletes the opened view, and copies the query as a block for a page", async () => {
    await act(async () => button("Active").click());
    await settle();
    await act(async () => button("Copy as page block").click());
    expect(copied.startsWith("```query\n{")).toBe(true);
    expect(JSON.parse(copied.slice("```query\n".length, -"\n```\n".length))).toMatchObject({ version: 1, where: [{ prop: "status", op: "eq", value: "active" }] });
    await act(async () => button("Delete view").click());
    await settle();
    expect(calls.find((c) => c.cmd === "query_view_delete")!.args).toEqual({ notebook: "nb-1", name: "Active" });
    expect([...document.querySelectorAll(".views-list li")].map((li) => li.textContent)).toEqual(["Broken Main"]);
  });
});
