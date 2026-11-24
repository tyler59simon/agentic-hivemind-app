// @vitest-environment jsdom
// DESK-6: the tab strip works from the keyboard. One tab is in the Tab order; arrows move the focus along the strip without
// opening a tab, Enter opens the focused one, Delete closes it.
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

let root: Root | null = null;
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.innerHTML = ""; });

const page = (id: string, path: string) => ({ id, kind: "file" as const, file: { notebook: "nb", path }, mode: "live" as const });
const tabs = () => [...document.querySelectorAll<HTMLElement>("[role=tab]")];
const press = async (key: string) => {
  await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); });
};

describe("the tab strip from the keyboard", () => {
  it("moves the focus with arrows, opens with Enter and closes with Delete", async () => {
    useWorkspace.setState({ panes: [{ id: "p0", tabs: [page("a", "A.md"), page("b", "B.md"), page("c", "C.md")], active: "a" }], focused: "p0", dirty: {}, reveal: null });
    const el = document.createElement("div");
    document.body.append(el);
    root = createRoot(el);
    await act(async () => root!.render(<QueryClientProvider client={new QueryClient()}><Workspace /></QueryClientProvider>));
    expect(tabs().map((t) => t.tabIndex)).toEqual([0, -1, -1]);
    expect(document.querySelector("[role=tablist]")!.getAttribute("aria-label")).toBe("Open notes and pages");
    expect(document.querySelector("[role=tabpanel]")).not.toBeNull();
    // Buttons inside a tab are not extra Tab stops.
    expect([...tabs()[0].querySelectorAll("button")].every((b) => b.tabIndex === -1)).toBe(true);
    tabs()[0].focus();
    await press("ArrowRight");
    expect(document.activeElement).toBe(tabs()[1]);
    expect(useWorkspace.getState().panes[0].active).toBe("a");
    await press("ArrowLeft");
    await press("ArrowLeft");
    expect(document.activeElement).toBe(tabs()[2]);
    await press("Home");
    expect(document.activeElement).toBe(tabs()[0]);
    await press("End");
    await press("Enter");
    expect(useWorkspace.getState().panes[0].active).toBe("c");
    await press("Delete");
    expect(useWorkspace.getState().panes[0].tabs.map((t) => t.id)).toEqual(["a", "b"]);
  });
});
