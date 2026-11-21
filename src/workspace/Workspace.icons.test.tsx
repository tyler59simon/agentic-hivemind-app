// @vitest-environment jsdom
// NS-3C UI-2: a rich page and a Markdown page of the same name have the same title, so the tab strip tells them apart by
// an icon on the rich page's tab.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("../features/editor/NoteTab", () => ({ NoteTab: () => null }));
vi.mock("../features/editor/NewNote", () => ({ NewNote: () => null }));
vi.mock("../features/notes/FileTab", () => ({ FileTab: () => null, saveFileTab: vi.fn() }));
vi.mock("../features/notes/NewFileTab", () => ({ NewFileTab: () => null }));
Element.prototype.scrollIntoView = () => {};

const { Workspace } = await import("./Workspace");
const { useWorkspace } = await import("./store");

describe("tabs of rich pages", () => {
  it("show an icon, and a Markdown page of the same name does not", async () => {
    useWorkspace.setState({
      panes: [{ id: "p0", tabs: [
        { id: "t1", kind: "file", file: { notebook: "nb", path: "Plan.md" }, mode: "live" },
        { id: "t2", kind: "file", file: { notebook: "nb", path: "Plan.hmdoc" }, mode: "source" },
      ], active: "t2" }],
      focused: "p0", dirty: {}, reveal: null,
    });
    const el = document.createElement("div");
    document.body.append(el);
    const root = createRoot(el);
    await act(async () => root.render(<QueryClientProvider client={new QueryClient()}><Workspace /></QueryClientProvider>));
    const pills = [...el.querySelectorAll('.note-tab-pill[title="Plan"]')];
    expect(pills.map((p) => p.querySelector(".tab-label")?.textContent)).toEqual(["Plan", "Plan"]);
    expect(pills.map((p) => !!p.querySelector("svg.tab-icon"))).toEqual([false, true]);
    await act(async () => root.unmount());
  });
});
