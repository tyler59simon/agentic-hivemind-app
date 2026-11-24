// @vitest-environment jsdom
// The workspace's Ctrl+E (Reading and back) leaves a key an editor already used alone (Codex review of 2392f6b, R1-9),
// and sends an editing mode (Live or Source) to Reading for notes and pages alike (CONR-16).
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

// jsdom has no scrolling; the tab strip scrolls its active tab into view.
Element.prototype.scrollIntoView = () => {};

const { Workspace } = await import("./Workspace");
const { useWorkspace } = await import("./store");

async function press(tab: Record<string, unknown>, used = false) {
  useWorkspace.setState({
    panes: [{ id: "p0", tabs: [{ id: "t1", ...tab } as never], active: "t1" }],
    focused: "p0", dirty: {}, reveal: null,
  });
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  await act(async () => root.render(<QueryClientProvider client={new QueryClient()}><Workspace /></QueryClientProvider>));
  const e = new KeyboardEvent("keydown", { key: "e", ctrlKey: true, cancelable: true });
  if (used) e.preventDefault();
  await act(async () => { window.dispatchEvent(e); });
  const mode = useWorkspace.getState().panes[0].tabs[0].mode;
  await act(async () => root.unmount());
  return mode;
}

const page = { kind: "file", file: { notebook: "nb", path: "Page.md" } };
const note = { kind: "note", ref: "d:1" };

describe("Ctrl+E in the workspace", () => {
  it.each([[false, "reading"], [true, "live"]] as const)("an editor that used the key: %s, mode after: %s", async (used, mode) => {
    expect(await press({ ...page, mode: "live" }, used)).toBe(mode);
  });
  it.each([
    [page, "source", "reading"], [page, "reading", "live"], [page, undefined, "reading"],
    [note, "source", "reading"], [note, "live", "reading"], [note, "reading", "live"], [note, undefined, "live"],
  ] as const)("%o in %s goes to %s", async (tab, from, to) => {
    expect(await press({ ...tab, mode: from })).toBe(to);
  });
});
