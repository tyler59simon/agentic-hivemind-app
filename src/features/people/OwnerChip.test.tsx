// @vitest-environment jsdom
// CON-15: an owner chip opens the owner's People page, confirms before it creates one, and sends the user to the People
// setup when People is not set up.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const calls: { cmd: string; args: Record<string, unknown> }[] = [];
let meta: Record<string, unknown> = {};
const indexed = [{ notebook: "nb-1", path: "People/Dana Lee.md", title: "Dana Lee", sha256: "h", mtimeMs: 1, props: { aliases: ["Dana"] } }];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: Record<string, unknown>) => {
    calls.push({ cmd, args });
    switch (cmd) {
      case "notebooks_list": return [{ id: "nb-1", path: "C:\\one", title: "Main", added: "" }];
      case "notebook_meta_get": return meta;
      case "index_query": return indexed;
      case "file_create": return { sha256: "n", size: 1, mtimeMs: 1 };
    }
    return null;
  }),
}));

const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { OwnerChip } = await import("./OwnerChip");
const { useWorkspace } = await import("../../workspace/store");
const { useApp } = await import("../../store");

let root: Root | null = null;
const settle = async () => { for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 20)); }); };
async function mount(owner: string) {
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root!.render(<QueryClientProvider client={client}><OwnerChip owner={owner} /></QueryClientProvider>));
  await settle();
  return el;
}
const click = async (el: Element) => { await act(async () => { (el as HTMLElement).click(); }); await settle(); };
const buttonNamed = (label: string) => [...document.querySelectorAll("button")].find((b) => b.textContent === label)!;
const opened = () => useWorkspace.getState().panes[0].tabs.map((t) => t.file);

beforeEach(() => {
  calls.length = 0;
  meta = { people: { folder: "People" } };
  useWorkspace.setState({ panes: [{ id: "p0", tabs: [], active: null }], focused: "p0", dirty: {}, reveal: null });
  useApp.setState({ route: { page: "home" }, back: [] });
});
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.innerHTML = ""; });

describe("an owner chip", () => {
  it("opens the page of the person the owner names, by title or alias", async () => {
    const el = await mount("dana");
    await click(el.querySelector("button")!);
    expect(opened()).toEqual([{ notebook: "nb-1", path: "People/Dana Lee.md" }]);
    expect(calls.some((c) => c.cmd === "file_create")).toBe(false);
  });

  it("asks before it creates a page, then writes the exact path and opens it", async () => {
    const el = await mount("Sam Okafor");
    await click(el.querySelector("button")!);
    expect(document.body.textContent).toContain("Create a page for Sam Okafor in People?");
    expect(calls.some((c) => c.cmd === "file_create")).toBe(false);
    await click(buttonNamed("Create page"));
    const made = calls.find((c) => c.cmd === "file_create")!;
    expect(made.args).toMatchObject({ notebook: "nb-1", path: "People/Sam Okafor.md" });
    expect(made.args.text).toContain("# Sam Okafor");
    expect(opened()).toEqual([{ notebook: "nb-1", path: "People/Sam Okafor.md" }]);
  });

  it("creates nothing when the question is declined", async () => {
    const el = await mount("Sam Okafor");
    await click(el.querySelector("button")!);
    await click(buttonNamed("Cancel"));
    expect(calls.some((c) => c.cmd === "file_create")).toBe(false);
    expect(opened()).toEqual([]);
  });

  it("goes to the People setup when People is not set up", async () => {
    meta = {};
    const el = await mount("Sam Okafor");
    await click(el.querySelector("button")!);
    expect(useApp.getState().route).toMatchObject({ page: "notes", view: "people" });
    expect(document.querySelector("[role=dialog]")).toBeNull();
  });
});
