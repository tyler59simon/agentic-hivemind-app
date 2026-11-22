// @vitest-environment jsdom
// NS-6A: the Compare tab with two open files, and the picker that opens it. Rust is a small model of the file commands; a copy must edit the open
// document of the other side and never write a file.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// Mounting an editor and loading a grammar is slow on a busy machine.
vi.setConfig({ testTimeout: 30_000 });
Range.prototype.getClientRects = function () { return [] as unknown as DOMRectList; };
Range.prototype.getBoundingClientRect = function () { return new DOMRect(); };

const files = new Map<string, string>();
const locked = new Set<string>();
const sent: string[] = [];
const drafts = new Map<string, unknown>();
const sha = (t: string) => `sha-${t}`;
let dialog: { notebook: string; path: string }[] = [];
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, a: Record<string, unknown>) => {
    sent.push(cmd);
    const path = a?.path as string;
    switch (cmd) {
      case "file_read":
        if (!files.has(path)) throw new Error(`${path} not found`);
        return { text: files.get(path), sha256: sha(files.get(path)!), size: 1, mtimeMs: 1, format: { encoding: "UTF-8", bom: false, eol: "lf" }, readOnly: locked.has(path) ? "This file is read-only on disk" : null, binary: false };
      case "file_save": files.set(path, a.text as string); return { status: "saved", sha256: sha(a.text as string), size: 1, mtimeMs: 2 };
      case "open_dialog": return dialog;
      case "draft_put": drafts.set(a.key as string, a.value); return null;
      case "draft_get": return drafts.get(a.key as string) ?? null;
      case "draft_delete": drafts.delete(a.key as string); return null;
    }
    return null;
  }),
}));

const { CompareTab } = await import("./Compare");
const docs = await import("../../documents/store");
const { startDocumentSync } = await import("../../documents/sync");
const { useWorkspace } = await import("../../workspace/store");
const { ComparePicker, useComparePicker } = await import("./ComparePicker");
const { useApp } = await import("../../store");

const ref = (path: string) => ({ notebook: "nb-1", path });
let root: Root | null = null;
let stop = () => {};
let el: HTMLElement;

async function mount(left: string, right: string) {
  useWorkspace.getState().openTab({ kind: "compare", compare: { left: ref(left), right: ref(right) } });
  const tab = useWorkspace.getState().panes[0].tabs[0];
  el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => { root!.render(<CompareTab tab={tab} />); });
  await settle();
}
const settle = () => act(async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); });
const button = (text: string) => [...el.querySelectorAll("button")].find((b) => b.textContent?.includes(text)) as HTMLButtonElement;
const click = async (text: string) => { await act(async () => { button(text).click(); }); await settle(); };
const status = () => el.querySelector('[role="status"]')?.textContent;
const text = (path: string) => docs.useDocuments.getState().docs[docs.keyOf(ref(path))]?.text;

describe("the Compare tab", () => {
  beforeEach(() => {
    files.clear(); locked.clear(); drafts.clear(); sent.length = 0;
    files.set("a.txt", "one\ntwo\nthree\nfour\n");
    files.set("b.txt", "one\n2\nthree\nfour\nfive\n");
    useWorkspace.setState({ panes: [{ id: "p0", tabs: [], active: null }], focused: "p0", dirty: {}, reveal: null });
    docs.useDocuments.setState({ docs: {}, refs: {}, held: [] });
    stop = startDocumentSync();
  });
  afterEach(async () => {
    await act(async () => root?.unmount());
    root = null;
    document.body.innerHTML = "";
    stop();
  });

  it("opens both files and counts the changes", async () => {
    await mount("a.txt", "b.txt");
    expect(status()).toBe("2 changes");
    expect(el.querySelectorAll(".cm-mergeView .cm-editor")).toHaveLength(2);
    expect(el.textContent).toContain("a.txt");
    expect(el.textContent).toContain("b.txt");
  });

  it("pads the shorter side with fixed-height gaps and does not rely on measuring", async () => {
    files.set("a.txt", "one\ntwo\nthree\nfour\napple\nfive\nsix\ncherry\n");
    files.set("b.txt", "apple\nbanana\nplum\ncherry\n");
    await mount("a.txt", "b.txt");
    const sides = [...el.querySelectorAll<HTMLElement>(".cm-mergeViewEditor")];
    const gaps = (side: HTMLElement) => [...side.querySelectorAll<HTMLElement>(".cm-compare-gap")].map((g) => g.style.height);
    // Left has 8 lines and right 4: the right side is padded by 4 lines in all, and the left needs nothing.
    expect(gaps(sides[0])).toEqual([]);
    expect(gaps(sides[1]).reduce((sum, h) => sum + parseInt(h, 10), 0)).toBe(4 * 20);
    // The merge view's own spacers are not used.
    expect(el.querySelector(".cm-merge-spacer, .cm-spacer")).toBeNull();
  });

  it("moves to the next and previous change, wrapping round", async () => {
    await mount("a.txt", "b.txt");
    await click("Next");
    expect(status()).toBe("Change 1 of 2");
    await click("Next");
    expect(status()).toBe("Change 2 of 2");
    await click("Next");
    expect(status()).toBe("Change 1 of 2");
    await click("Previous");
    expect(status()).toBe("Change 2 of 2");
    await click("Previous");
    expect(status()).toBe("Change 1 of 2");
  });

  it("starts from the last change when going back first", async () => {
    await mount("a.txt", "b.txt");
    await click("Previous");
    expect(status()).toBe("Change 2 of 2");
  });

  it("ignores whitespace on request", async () => {
    files.set("a.txt", "a\n  b\nc\n");
    files.set("b.txt", "a\nb\nc\n");
    await mount("a.txt", "b.txt");
    expect(status()).toBe("1 change");
    await act(async () => { (el.querySelector('input[type="checkbox"]') as HTMLInputElement).click(); });
    await settle();
    expect(status()).toBe("The files differ only in whitespace.");
    expect(button("Next").disabled).toBe(true);
    await act(async () => { (el.querySelector('input[type="checkbox"]') as HTMLInputElement).click(); });
    await settle();
    expect(status()).toBe("1 change");
  });

  it("copies a change to the right through the open document, unsaved, without writing a file", async () => {
    await mount("a.txt", "b.txt");
    await click("Next");
    await click("Copy to right");
    expect(text("b.txt")).toBe("one\ntwo\nthree\nfour\nfive\n");
    expect(text("a.txt")).toBe("one\ntwo\nthree\nfour\n");
    expect(docs.useDocuments.getState().docs[docs.keyOf(ref("b.txt"))].status).toBe("dirty");
    expect(files.get("b.txt")).toBe("one\n2\nthree\nfour\nfive\n");
    expect(sent).not.toContain("file_save");
    // The change that was copied is gone; the one that is left is the current one.
    expect(status()).toBe("Change 1 of 1");
    // The tab shows the unsaved dot, and a save button for the file that changed.
    expect(useWorkspace.getState().dirty[useWorkspace.getState().panes[0].tabs[0].id]).toBe(true);
    expect(button("Save b.txt")).toBeTruthy();
  });

  it("copies a change to the left", async () => {
    await mount("a.txt", "b.txt");
    await click("Next");
    await click("Next");
    await click("Copy to left");
    // The second change is the added line "five".
    expect(text("a.txt")).toBe("one\ntwo\nthree\nfour\nfive\n");
    expect(text("b.txt")).toBe("one\n2\nthree\nfour\nfive\n");
  });

  it("undoes a copy, and refuses to undo over text that changed since", async () => {
    await mount("a.txt", "b.txt");
    await click("Next");
    await click("Copy to right");
    expect(button("Undo copy").disabled).toBe(false);
    await click("Undo copy");
    expect(text("b.txt")).toBe("one\n2\nthree\nfour\nfive\n");
    expect(status()).toBe("Change 1 of 2");
    expect(button("Undo copy").disabled).toBe(true);
    // A second copy, then the file is edited elsewhere: undo leaves that text alone.
    await click("Next");
    await click("Copy to right");
    act(() => docs.edit(docs.keyOf(ref("b.txt")), "typed elsewhere\n"));
    await settle();
    await click("Undo copy");
    expect(text("b.txt")).toBe("typed elsewhere\n");
  });

  it("will not copy into a read-only file", async () => {
    locked.add("b.txt");
    await mount("a.txt", "b.txt");
    await click("Next");
    expect(button("Copy to right").disabled).toBe(true);
    expect(button("Copy to left").disabled).toBe(false);
    await click("Copy to left");
    expect(text("a.txt")).toBe("one\n2\nthree\nfour\n");
  });

  it("follows a file edited in another tab", async () => {
    await mount("a.txt", "b.txt");
    act(() => docs.edit(docs.keyOf(ref("a.txt")), "one\n2\nthree\nfour\nfive\n"));
    await settle();
    expect(status()).toBe("The files are the same.");
  });

  it("holds both documents while the tab is open and lets them go when it closes", async () => {
    await mount("a.txt", "b.txt");
    expect(Object.keys(docs.useDocuments.getState().docs)).toHaveLength(2);
    await act(async () => { useWorkspace.setState({ panes: [{ id: "p0", tabs: [], active: null }] }); });
    await settle();
    expect(Object.keys(docs.useDocuments.getState().docs)).toHaveLength(0);
  });
});

// The picker (its own describe, so one file mounts both) ----------------------------------------------------------
let pickerRoot: Root | null = null;
const file = (id: string, path: string) => ({ id, kind: "file" as const, file: { notebook: "nb-1", path }, mode: "source" as const });
const last = <T,>(list: T[]) => list[list.length - 1];
const select = (n: number) => document.querySelectorAll<HTMLSelectElement>(".modal select")[n];
const pick = async (node: HTMLSelectElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(node, value);
    node.dispatchEvent(new Event("change", { bubbles: true }));
  });
};
const modalButton = (text: string) => [...document.querySelectorAll<HTMLButtonElement>(".modal button")].find((b) => b.textContent === text)!;

describe("the compare picker", () => {
  beforeEach(async () => {
    dialog = [];
    useApp.setState({ route: { page: "notes" }, back: [] });
    useWorkspace.setState({ panes: [{ id: "p0", tabs: [file("t1", "a.txt"), file("t2", "b.txt"), file("t3", "c.log")], active: "t1" }], focused: "p0", dirty: {} });
    const el = document.createElement("div");
    document.body.append(el);
    pickerRoot = createRoot(el);
    await act(async () => pickerRoot!.render(<ComparePicker />));
  });
  afterEach(async () => { await act(async () => pickerRoot?.unmount()); pickerRoot = null; document.body.innerHTML = ""; useComparePicker.getState().hide(); });

    it("starts with the file it was asked from on the left and offers the open files", async () => {
      await act(async () => useComparePicker.getState().show({ notebook: "nb-1", path: "b.txt" }));
      expect(select(0).value).toBe("file:nb-1:b.txt");
      expect([...select(0).options].map((o) => o.textContent)).toEqual(["Choose a file", "a.txt", "b.txt", "c.log"]);
      // The right side starts on another open file, so Compare is ready.
      expect(select(1).value).toBe("file:nb-1:a.txt");
      expect(modalButton("Compare").disabled).toBe(false);
    });

    it("opens the pair as a compare tab, once", async () => {
      await act(async () => useComparePicker.getState().show({ notebook: "nb-1", path: "a.txt" }));
      await pick(select(1), "file:nb-1:c.log");
      await act(async () => { modalButton("Compare").click(); });
      const tabs = useWorkspace.getState().panes[0].tabs;
      expect(tabs.filter((t) => t.kind === "compare")).toHaveLength(1);
      expect(last(tabs)).toMatchObject({ kind: "compare", compare: { left: { path: "a.txt" }, right: { path: "c.log" } }, title: "a.txt vs c.log" });
      expect(document.querySelector(".modal")).toBeNull();
      // The same pair again shows the tab that is there.
      await act(async () => useComparePicker.getState().show({ notebook: "nb-1", path: "a.txt" }));
      await pick(select(1), "file:nb-1:c.log");
      await act(async () => { modalButton("Compare").click(); });
      expect(useWorkspace.getState().panes[0].tabs.filter((t) => t.kind === "compare")).toHaveLength(1);
    });

    it("refuses the same file on both sides", async () => {
      await act(async () => useComparePicker.getState().show({ notebook: "nb-1", path: "a.txt" }));
      await pick(select(1), "file:nb-1:a.txt");
      expect(modalButton("Compare").disabled).toBe(true);
      expect(document.querySelector(".modal .error")?.textContent).toBe("Pick two different files.");
    });

    it("takes a file from disk through the open dialog", async () => {
      dialog = [{ notebook: "@abc", path: "other.txt" }];
      await act(async () => useComparePicker.getState().show({ notebook: "nb-1", path: "a.txt" }));
      await act(async () => { document.querySelectorAll<HTMLButtonElement>(".modal button")[2].click(); });
      await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
      expect(select(1).value).toBe("file:@abc:other.txt");
      await act(async () => { modalButton("Compare").click(); });
      expect(last(useWorkspace.getState().panes[0].tabs)).toMatchObject({ kind: "compare", compare: { right: { notebook: "@abc", path: "other.txt" } } });
    });

    it("a comparison is not kept over a restart, and follows a renamed file", () => {
      useWorkspace.getState().openTab({ kind: "compare", compare: { left: { notebook: "nb-1", path: "a.txt" }, right: { notebook: "nb-1", path: "b.txt" } } });
      const stored = JSON.parse(JSON.stringify((useWorkspace as unknown as { persist: { getOptions: () => { partialize: (s: unknown) => { panes: { tabs: { kind: string }[] }[] } } } }).persist.getOptions().partialize(useWorkspace.getState())));
      expect(stored.panes[0].tabs.map((t: { kind: string }) => t.kind)).toEqual(["file", "file", "file"]);
      useWorkspace.getState().retargetFile("nb-1", "b.txt", "renamed.txt");
      expect(last(useWorkspace.getState().panes[0].tabs)).toMatchObject({ kind: "compare", compare: { right: { path: "renamed.txt" }, left: { path: "a.txt" } } });
    });
});
