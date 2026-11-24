// @vitest-environment jsdom
// DESK-6: the notebook tree works from the keyboard: one row in the Tab order, arrows to move and to open and close
// sections, Enter to open a page, F2 to rename, Shift+F10 for the row's menu with Move to….
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
Element.prototype.scrollIntoView = () => {};

const { NotebookTree } = await import("./NotebookTree");
const { useWorkspace } = await import("../../workspace/store");

let root: Root | null = null;
const notebook = { id: "nb-1", path: "C:\\notes", title: "Notes", added: "" };
const entries = [{ path: "Projects", kind: "dir", size: 0, mtimeMs: 0 }, { path: "Projects/Plan.md", kind: "page", size: 5, mtimeMs: 0 }, { path: "Inbox.md", kind: "page", size: 5, mtimeMs: 0 }];

async function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["notebook-tree", notebook.id], { entries, truncated: false });
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<QueryClientProvider client={client}><NotebookTree notebook={notebook} onSettings={() => {}} /></QueryClientProvider>));
}
const rowOf = (path: string) => document.querySelector<HTMLElement>(`[role=treeitem][data-tree-path="${path}"]`);
const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)));
async function press(key: string, init: KeyboardEventInit = {}) {
  await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init })); });
  await act(async () => { await frame(); });
}
const tabs = () => useWorkspace.getState().panes[0].tabs;

beforeEach(() => {
  localStorage.clear();
  useWorkspace.setState({ panes: [{ id: "p", tabs: [], active: null }], focused: "p", dirty: {} });
});
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.innerHTML = ""; });

describe("the notebook tree from the keyboard", () => {
  it("has one row in the Tab order, with its level and place for screen readers", async () => {
    await mount();
    const rows = [...document.querySelectorAll<HTMLElement>("[role=treeitem]")];
    expect(rows.map((r) => r.tabIndex)).toEqual([0, -1]);
    expect(rows.map((r) => [r.getAttribute("aria-level"), r.getAttribute("aria-posinset"), r.getAttribute("aria-setsize")])).toEqual([["1", "1", "2"], ["1", "2", "2"]]);
  });

  it("opens a section with Right, moves into it, goes back with Left, and opens a page with Enter", async () => {
    await mount();
    rowOf("Projects")!.focus();
    await press("ArrowRight");
    expect(rowOf("Projects")!.getAttribute("aria-expanded")).toBe("true");
    await press("ArrowRight");
    expect(document.activeElement).toBe(rowOf("Projects/Plan.md"));
    expect(rowOf("Projects/Plan.md")!.getAttribute("aria-level")).toBe("2");
    await press("Enter");
    expect(tabs().map((t) => t.file?.path)).toEqual(["Projects/Plan.md"]);
    await press("ArrowLeft");
    expect(document.activeElement).toBe(rowOf("Projects"));
    await press("ArrowLeft");
    expect(rowOf("Projects")!.getAttribute("aria-expanded")).toBe("false");
    await press("ArrowDown");
    expect(document.activeElement).toBe(rowOf("Inbox.md"));
  });

  it("F2 renames, and Shift+F10 opens the row's menu with Move to…", async () => {
    await mount();
    rowOf("Inbox.md")!.focus();
    await press("F2");
    expect((document.activeElement as HTMLInputElement).value).toBe("Inbox");
    await press("Escape");
    expect(document.activeElement).toBe(rowOf("Inbox.md"));
    await press("F10", { shiftKey: true });
    const items = [...document.querySelectorAll("[role=menuitem]")].map((i) => i.textContent);
    expect(items).toContain("Move to…");
    expect(document.activeElement?.getAttribute("role")).toBe("menuitem");
    await act(async () => { ([...document.querySelectorAll<HTMLElement>("[role=menuitem]")].find((i) => i.textContent === "Move to…"))!.click(); });
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.getAttribute("aria-label")).toBe("Move Inbox");
    expect([...dialog.querySelectorAll("option")].map((o) => o.textContent)).toEqual(["Projects"]);
  });
});
