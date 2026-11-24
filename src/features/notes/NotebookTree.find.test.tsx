// @vitest-environment jsdom
// NS-6B: a notebook's menu and a folder's context menu start Find in files on that notebook or folder.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));

const { NotebookTree } = await import("./NotebookTree");
const { useWorkspace } = await import("../../workspace/store");

let root: Root | null = null;
const notebook = { id: "nb-1", path: "C:\\notes", title: "Notes", added: "" };
const entries = [{ path: "Projects", kind: "dir", size: 0, mtimeMs: 0 }, { path: "Projects/Plan.md", kind: "page", size: 5, mtimeMs: 0 }, { path: "Inbox.md", kind: "page", size: 5, mtimeMs: 0 }];

async function mount(nb = notebook) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["notebook-tree", nb.id], { entries, truncated: false });
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<QueryClientProvider client={client}><NotebookTree notebook={nb} onSettings={() => {}} /></QueryClientProvider>));
}
const find = () => useWorkspace.getState().panes[0].tabs.filter((t) => t.kind === "find");
const menuTexts = () => [...document.querySelectorAll("[role=menuitem]")].map((i) => i.textContent);

beforeEach(() => { useWorkspace.setState({ panes: [{ id: "p", tabs: [], active: null }], focused: "p", dirty: {} }); });
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

describe("find in files from the notebook tree", () => {
  it("is in the notebook's menu and opens the find tab", async () => {
    await mount();
    await act(async () => { (document.querySelector("[aria-label='Notebook actions']") as HTMLElement).click(); });
    expect(menuTexts()).toContain("Find in files…");
    await act(async () => { ([...document.querySelectorAll("[role=menuitem]")].find((i) => i.textContent === "Find in files…") as HTMLElement).click(); });
    expect(find()).toHaveLength(1);
  });

  it("is in a folder's context menu but not a page's", async () => {
    await mount();
    const rowOf = (name: string) => [...document.querySelectorAll("[role=treeitem], .tree-row, li")].find((r) => r.textContent?.trim().startsWith(name)) as HTMLElement;
    await act(async () => { rowOf("Projects").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 })); });
    expect(menuTexts()).toContain("Find in files…");
    await act(async () => { ([...document.querySelectorAll("[role=menuitem]")].find((i) => i.textContent === "Find in files…") as HTMLElement).click(); });
    expect(find()).toHaveLength(1);
    // A page's menu has no such item.
    await act(async () => { rowOf("Inbox").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 })); });
    expect(menuTexts()).not.toContain("Find in files…");
  });
});
