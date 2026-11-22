// @vitest-environment jsdom
// Closing one of two tabs that show the same page or Memory note loses nothing (they share one document or editing
// session), so it asks nothing; closing the last tab with unsaved edits still asks "Discard unsaved changes?".
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("../features/editor/NoteTab", () => ({ NoteTab: () => null }));
vi.mock("../features/editor/NewNote", () => ({ NewNote: () => null }));
vi.mock("../features/notes/FileTab", () => ({ FileTab: () => null, saveFileTab: vi.fn() }));
vi.mock("../features/notes/NewFileTab", () => ({ NewFileTab: () => null }));
Element.prototype.scrollIntoView = () => {};

const { Workspace } = await import("./Workspace");
const { useWorkspace } = await import("./store");

type Tab = Parameters<ReturnType<typeof useWorkspace.getState>["openTab"]>[0] & { id: string };
const page = (id: string, path: string): Tab => ({ id, kind: "file", file: { notebook: "nb", path }, mode: "live" });
const note = (id: string, ref: string, mode: "live" | "reading"): Tab => ({ id, kind: "note", ref, mode });

let root: Root | null = null;
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.innerHTML = ""; });

/** The workspace with `tabs` in one pane, every one of them showing unsaved edits. */
async function show(tabs: Tab[]) {
  useWorkspace.setState({ panes: [{ id: "p0", tabs, active: tabs[0].id }], focused: "p0", dirty: Object.fromEntries(tabs.map((t) => [t.id, true])), reveal: null });
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<QueryClientProvider client={new QueryClient()}><Workspace /></QueryClientProvider>));
  return el;
}
const closeTab = async (el: HTMLElement, index: number) => { await act(async () => el.querySelectorAll<HTMLButtonElement>(".tab-close")[index].click()); };
const asks = () => !!document.body.querySelector('[role="dialog"][aria-label="Discard unsaved changes?"]');
const ids = () => useWorkspace.getState().panes[0].tabs.map((t) => t.id);

describe("closing a tab that has unsaved edits", () => {
  it("one of two tabs on the same page closes at once, and the last one asks", async () => {
    const el = await show([page("a", "Day.md"), page("b", "Day.md")]);
    await closeTab(el, 0);
    expect(asks()).toBe(false);
    expect(ids()).toEqual(["b"]);
    await closeTab(el, 0);
    expect(asks()).toBe(true);
    expect(ids()).toEqual(["b"]);
  });

  it("a tab on another page still asks, even with a twin of some other page open", async () => {
    const el = await show([page("a", "Day.md"), page("b", "Other.md"), page("c", "Other.md")]);
    await closeTab(el, 0);
    expect(asks()).toBe(true);
    expect(ids()).toEqual(["a", "b", "c"]);
  });

  it("one of two tabs on the same Memory note closes at once, and the last one asks", async () => {
    const el = await show([note("a", "demo:abc", "live"), note("b", "demo:abc", "reading")]);
    await closeTab(el, 0);
    expect(asks()).toBe(false);
    expect(ids()).toEqual(["b"]);
    // The tab that is left is the only view of the note, so closing it asks.
    await closeTab(el, 0);
    expect(asks()).toBe(true);
  });

  it("a page's twin in the large file viewer still counts: the document stays open there", async () => {
    const el = await show([page("a", "Log.txt"), { ...page("b", "Log.txt"), mode: "bigfile" }]);
    await closeTab(el, 0);
    expect(asks()).toBe(false);
    expect(ids()).toEqual(["b"]);
  });

  it("a note and a page of the same name are not twins", async () => {
    const el = await show([note("a", "demo:abc", "live"), { id: "b", kind: "file", file: { notebook: "demo", path: "abc" } }]);
    await closeTab(el, 0);
    expect(asks()).toBe(true);
  });
});
