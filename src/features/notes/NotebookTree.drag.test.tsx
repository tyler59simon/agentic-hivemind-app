// @vitest-environment jsdom
// NS-7C: a tree row let go outside the tree is offered to a canvas board and to nothing else; a drop over the tree is the
// tree's own move and never reaches a board; a section is never offered.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const invoke = vi.fn(async () => null);
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const { NotebookTree } = await import("./NotebookTree");
const { registerBoard } = await import("../canvas/treeDrop");

const notebook = { id: "nb-1", path: "C:\\nb", title: "Notebook", added: "" };
let root: Root | null = null;
let under: Element | null = null;
let stop = () => {};
const taken: { notebook: string; path: string }[] = [];

const point = (type: string, x: number, y: number) =>
  Object.assign(new MouseEvent(type, { clientX: x, clientY: y, button: 0, buttons: type === "pointerup" ? 0 : 1, bubbles: true }), { pointerId: 1 });
const fire = (el: Element | Window, e: Event) => act(async () => { el.dispatchEvent(e); });
const row = (path: string) => document.querySelector(`[data-tree-path="${path}"]`)!;

/** Press on the row `path`, move away from it and let go over `target`. */
async function dragRow(path: string, target: Element) {
  under = target;
  await fire(row(path), point("pointerdown", 5, 5));
  await fire(window, point("pointermove", 200, 200));
  await fire(window, point("pointerup", 200, 200));
}

beforeEach(async () => {
  invoke.mockClear();
  taken.length = 0;
  (document as { elementFromPoint?: unknown }).elementFromPoint = () => under;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["notebook-tree", notebook.id], {
    entries: [{ path: "Plan.md", kind: "page", size: 1, mtimeMs: 1 }, { path: "Folder", kind: "dir", size: 0, mtimeMs: 1 }, { path: "pic.png", kind: "other", size: 1, mtimeMs: 1 }],
    truncated: false,
  });
  client.setQueryData(["notebook-meta", notebook.id], {});
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<QueryClientProvider client={client}><NotebookTree notebook={notebook} onSettings={() => {}} /></QueryClientProvider>));
});
afterEach(async () => {
  stop();
  stop = () => {};
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  delete (document as { elementFromPoint?: unknown }).elementFromPoint;
});

describe("a tree row dragged out of the tree", () => {
  const board = () => {
    const el = document.createElement("div");
    document.body.append(el);
    stop = registerBoard(el, (file) => { taken.push(file); });
    return el;
  };

  it("goes to the board it is let go over, with its notebook and path", async () => {
    await dragRow("Plan.md", board());
    expect(taken).toEqual([{ notebook: "nb-1", path: "Plan.md" }]);
    await dragRow("pic.png", board().appendChild(document.createElement("span")));
    expect(taken[taken.length - 1]).toEqual({ notebook: "nb-1", path: "pic.png" });
  });

  it("goes nowhere when let go over anything that is not a board, and moves nothing", async () => {
    board();
    const elsewhere = document.createElement("div");
    document.body.append(elsewhere);
    await dragRow("Plan.md", elsewhere);
    expect(taken).toEqual([]);
    expect(invoke).not.toHaveBeenCalledWith("file_rename", expect.anything());
  });

  it("is not offered to a board when let go over the tree itself, which is the tree's own move", async () => {
    board();
    await dragRow("Plan.md", row("Folder"));
    expect(taken).toEqual([]);
  });

  it("is not offered for a section", async () => {
    await dragRow("Folder", board());
    expect(taken).toEqual([]);
  });

  it("is not offered when the board is gone", async () => {
    const el = board();
    stop();
    await dragRow("Plan.md", el);
    expect(taken).toEqual([]);
  });
});
