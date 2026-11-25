// @vitest-environment jsdom
// DESK-12: the memory notes tree is a tree for assistive technology and the keyboard: levels and set sizes, one row in the
// Tab order, arrows to move and to open and close branches, Enter to open a note.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { NoteRow } from "../../lib/lm";
import { expectNoNewAxeViolations } from "../../test/axe";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
Element.prototype.scrollIntoView = () => {};

const { MemoryTree, memoryNodes } = await import("./MemoryTree");
const { useWorkspace } = await import("../../workspace/store");
const { regions } = await import("../../shell/regions");

const note = (ref: string, title: string, type: string): NoteRow => {
  const [domain, id] = ref.split(":");
  return { ref, domain, id, title, type, tags: [], status: "active", created: "", updated: "", revision: "r", path: "" };
};
const plan = note("a:1", "Ship it", "plan");
const second = note("a:2", "Next step", "plan");
const fact = note("a:3", "A fact", "knowledge");
const groups = [
  { slug: "work", name: "Work", types: [{ type: "knowledge", notes: [fact] }, { type: "plan", notes: [plan, second] }] },
  { slug: null, name: "Unassigned", types: [{ type: "plan", notes: [note("b:1", "Loose", "plan")] }] },
];
const tree = (over: Partial<Parameters<typeof MemoryTree>[0]["tree"]> = {}) => ({
  enabled: true, groups, expanded: undefined, loading: false, error: null, retry: () => {}, ...over,
}) as Parameters<typeof MemoryTree>[0]["tree"];

let root: Root | null = null;
async function mount(over = {}) {
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<MemoryTree tree={tree(over)} />));
}
const items = () => [...document.querySelectorAll<HTMLElement>("[role=treeitem]")];
const names = () => items().map((r) => r.textContent);
const rowOf = (name: string) => items().find((r) => r.textContent === name)!;
const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)));
async function press(key: string, init: KeyboardEventInit = {}) {
  await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init })); });
  await act(async () => { await frame(); });
}
const tabs = () => useWorkspace.getState().panes[0].tabs;

beforeEach(() => useWorkspace.setState({ panes: [{ id: "p", tabs: [], active: null }], focused: "p", dirty: {} }));
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.innerHTML = ""; });

describe("the memory notes tree", () => {
  it("is a named tree whose rows say their level and place, with one row in the Tab order", async () => {
    await mount({ expanded: "work" });
    expect(document.querySelector("[role=tree]")!.getAttribute("aria-label")).toBe("Memory notes");
    // Work is open (it is the picked project) but its types are closed.
    expect(names()).toEqual(["Work", "knowledge", "plan", "Unassigned"]);
    expect(items().map((r) => [r.getAttribute("aria-level"), r.getAttribute("aria-posinset"), r.getAttribute("aria-setsize")]))
      .toEqual([["1", "1", "2"], ["2", "1", "2"], ["2", "2", "2"], ["1", "2", "2"]]);
    expect(items().map((r) => r.getAttribute("aria-expanded"))).toEqual(["true", "false", "false", "false"]);
    expect(items().map((r) => r.tabIndex)).toEqual([0, -1, -1, -1]);
  });

  it("opens a branch with Right, moves into it, and gives its notes the third level and the set size", async () => {
    await mount({ expanded: "work" });
    rowOf("plan").focus();
    await press("ArrowRight");
    expect(rowOf("plan").getAttribute("aria-expanded")).toBe("true");
    await press("ArrowRight");
    expect(document.activeElement).toBe(rowOf("Ship it"));
    expect(rowOf("Ship it").getAttribute("aria-level")).toBe("3");
    expect(rowOf("Next step").getAttribute("aria-posinset")).toBe("2");
    expect(rowOf("Next step").getAttribute("aria-setsize")).toBe("2");
    expect(rowOf("Ship it").hasAttribute("aria-expanded")).toBe(false);
    // Only the focused row is in the Tab order.
    expect(items().filter((r) => r.tabIndex === 0)).toEqual([rowOf("Ship it")]);
    await press("ArrowDown");
    expect(document.activeElement).toBe(rowOf("Next step"));
    await press("Home");
    expect(document.activeElement).toBe(rowOf("Work"));
    await press("End");
    expect(document.activeElement).toBe(rowOf("Unassigned"));
  });

  it("goes to the parent and closes a branch with Left", async () => {
    await mount({ expanded: "work" });
    rowOf("plan").focus();
    await press("ArrowRight");
    await press("ArrowRight");
    await press("ArrowLeft");
    expect(document.activeElement).toBe(rowOf("plan"));
    await press("ArrowLeft");
    expect(rowOf("plan").getAttribute("aria-expanded")).toBe("false");
    expect(names()).not.toContain("Ship it");
    await press("ArrowLeft");
    expect(document.activeElement).toBe(rowOf("Work"));
    await press("ArrowLeft");
    expect(names()).toEqual(["Work", "Unassigned"]);
  });

  it("opens a note with Enter, in a split with Ctrl+Enter, and marks the open note selected", async () => {
    await mount({ expanded: "work" });
    rowOf("plan").focus();
    await press("ArrowRight");
    await press("ArrowRight");
    await press("Enter");
    expect(tabs().map((t) => t.ref)).toEqual(["a:1"]);
    expect(rowOf("Ship it").getAttribute("aria-selected")).toBe("true");
    expect(rowOf("Ship it").classList.contains("on")).toBe(true);
    expect(rowOf("Next step").getAttribute("aria-selected")).toBe("false");
    await press("ArrowDown");
    await press("Enter", { ctrlKey: true });
    expect(useWorkspace.getState().panes.length).toBe(2);
  });

  it("toggles a branch with Enter and with a click, and opens a note with a click", async () => {
    await mount({ expanded: "work" });
    rowOf("Unassigned").focus();
    await press("Enter");
    expect(rowOf("Unassigned").getAttribute("aria-expanded")).toBe("true");
    await act(async () => rowOf("Unassigned").click());
    expect(rowOf("Unassigned").getAttribute("aria-expanded")).toBe("false");
    await act(async () => rowOf("plan").click());
    await act(async () => rowOf("Ship it").click());
    expect(tabs().map((t) => t.ref)).toEqual(["a:1"]);
  });

  it("starts with the open note's branches open and the Tab stop on its row", async () => {
    useWorkspace.getState().openNote(second.ref, { title: second.title });
    await mount();
    expect(names()).toEqual(["Work", "knowledge", "plan", "Ship it", "Next step", "Unassigned"]);
    expect(items().filter((r) => r.tabIndex === 0)).toEqual([rowOf("Next step")]);
  });

  it("is the stop F6 lands on in the tree region: the row in the Tab order", async () => {
    const el = document.createElement("div");
    el.innerHTML = '<div class="shell"><nav class="notebooks"></nav></div>';
    document.body.append(el);
    root = createRoot(el.querySelector("nav")!);
    await act(async () => root!.render(<MemoryTree tree={tree({ expanded: "work" })} />));
    const region = regions().find((r) => r.box.matches("nav.notebooks"))!;
    expect(region.target).toBe(rowOf("Work"));
    expect(region.target!.tabIndex).toBe(0);
  });

  it("gives a note listed under two projects a row in each", () => {
    const both = [{ slug: "a", name: "A", types: [{ type: "plan", notes: [plan] }] }, { slug: "b", name: "B", types: [{ type: "plan", notes: [plan] }] }];
    const { nodes } = memoryNodes(both);
    const paths = nodes.flatMap((g) => g.children.flatMap((t) => t.children.map((n) => n.path)));
    expect(new Set(paths).size).toBe(2);
  });

  it("passes axe with branches open", async () => {
    await mount({ expanded: "work" });
    rowOf("plan").focus();
    await press("ArrowRight");
    await expectNoNewAxeViolations(document.body, []);
  });
});
