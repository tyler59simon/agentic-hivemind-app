// @vitest-environment jsdom
// NS-6A in a mounted file tab: the status line's menus, the line tools bar and the language picker.
import { language } from "@codemirror/language";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// Mounting an editor and loading a grammar is slow on a busy machine.
vi.setConfig({ testTimeout: 30_000 });
Range.prototype.getClientRects = function () { return [] as unknown as DOMRectList; };
Range.prototype.getBoundingClientRect = function () { return new DOMRect(); };

interface Served { text: string; format?: { encoding: string; bom: boolean; eol: string; confidence?: string }; readOnly?: string; chooseEol?: boolean; convertible?: boolean }
const files = new Map<string, Served>();
const sent: { cmd: string; args: Record<string, unknown> }[] = [];
const drafts = new Map<string, unknown>();
const utf8 = { encoding: "UTF-8", bom: false, eol: "lf", confidence: "valid" };
const sha = (f: Served) => `sha-${f.text}-${f.format?.encoding}-${f.format?.eol}`;
const loaded = (f: Served) => ({ text: f.text, sha256: sha(f), size: f.text.length, mtimeMs: 1, format: f.format ?? utf8, readOnly: f.readOnly ?? null, binary: false, convertible: !!f.convertible, chooseEol: !!f.chooseEol });
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, a: Record<string, unknown>) => {
    sent.push({ cmd, args: a });
    const path = a?.path as string;
    switch (cmd) {
      case "notebooks_list": return [{ id: "nb-1", path: "C:\\nb", title: "Notebook", added: "" }];
      case "notebook_tree": return { entries: [...files.keys()].map((p) => ({ path: p, kind: "page" })), truncated: false };
      case "file_read": return loaded(files.get(path)!);
      case "file_reopen": {
        // Reading the same bytes as another encoding gives other text.
        const f = files.get(path)!;
        return loaded({ ...f, text: `${f.text} (as ${a.encoding})`, format: { encoding: a.encoding as string, bom: false, eol: f.format?.eol ?? "lf", confidence: "valid" }, readOnly: undefined, convertible: false });
      }
      case "file_save": {
        const f = files.get(path)!;
        if (sha(f) !== (a.pre as { sha256: string }).sha256) return { status: "stale", sha256: sha(f) };
        const next: Served = { text: a.text as string, format: a.format as Served["format"] };
        files.set(path, next);
        return { status: "saved", sha256: sha(next), size: 1, mtimeMs: 2 };
      }
      case "asset_base": return "http://hmfile.localhost/g/";
      case "draft_put": drafts.set(a.key as string, a.value); return null;
      case "draft_get": return drafts.get(a.key as string) ?? null;
      case "draft_delete": drafts.delete(a.key as string); return null;
    }
    return null;
  }),
}));

const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { EditorView } = await import("@codemirror/view");
const { FileTab } = await import("./FileTab");
const { useWorkspace } = await import("../../workspace/store");
const { useApp } = await import("../../store");
const docs = await import("../../documents/store");
const { startDocumentSync } = await import("../../documents/sync");

const ref = (path: string) => ({ notebook: "nb-1", path });
const ws = () => useWorkspace.getState();
let root: Root | null = null;
let stop = () => {};
let el: HTMLElement;

async function show(path: string, mode: "source" | "live" = "source") {
  ws().openTab({ kind: "file", file: ref(path), mode });
  el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  const node: ReactNode = <QueryClientProvider client={new QueryClient()}><FileTab tab={ws().panes[0].tabs[0]} /></QueryClientProvider>;
  await act(async () => { root!.render(node); });
  await settle();
}
const rerender = async () => {
  await act(async () => { root!.render(<QueryClientProvider client={new QueryClient()}><FileTab tab={ws().panes[0].tabs[0]} /></QueryClientProvider>); });
  await settle();
};
const settle = () => act(async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0)); });
const doc = (path: string) => docs.useDocuments.getState().docs[docs.keyOf(ref(path))];
const view = () => EditorView.findFromDOM(el.querySelector<HTMLElement>(".cm-content")!)!;
const status = () => el.querySelector(".file-status")!;
// Each status button is named by the value it shows, then what it is: "UTF-8, encoding" (WCAG 2.5.3).
const menuButton = (label: string) => [...status().querySelectorAll<HTMLButtonElement>("button.menu-button")]
  .find((b) => b.getAttribute("aria-label")?.endsWith(`, ${label.toLowerCase()}`)) ?? null as unknown as HTMLButtonElement;
const lineTools = () => [...el.querySelectorAll<HTMLButtonElement>("button.menu-button")].find((b) => b.textContent === "Lines")!;
const items = () => [...status().querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
const item = (text: string) => items().find((b) => b.textContent === text)!;
const clickIn = async (node: HTMLElement | undefined) => { await act(async () => { node!.click(); }); await settle(); };

describe("a file tab with power editing", () => {
  beforeEach(() => {
    files.clear(); drafts.clear(); sent.length = 0;
    useWorkspace.setState({ panes: [{ id: "p0", tabs: [], active: null }], focused: "p0", dirty: {}, reveal: null });
    useApp.setState({ route: { page: "notes" }, back: [] });
    docs.useDocuments.setState({ docs: {}, refs: {}, held: [] });
    stop = startDocumentSync();
  });
  afterEach(async () => {
    await act(async () => root?.unmount());
    root = null;
    document.body.innerHTML = "";
    stop();
  });

  it("shows the line tools and macros above a text file and above Markdown source, not above Live", async () => {
    files.set("a.txt", { text: "b\na\n" });
    await show("a.txt");
    expect(el.querySelector(".power-bar")).not.toBeNull();
    await act(async () => root!.unmount());
    document.body.innerHTML = "";
    useWorkspace.setState({ panes: [{ id: "p0", tabs: [], active: null }] });
    files.set("p.md", { text: "# Title\n" });
    await show("p.md", "source");
    expect(el.querySelector(".power-bar")).not.toBeNull();
    ws().updateTab(ws().panes[0].tabs[0].id, { mode: "live" });
    await rerender();
    expect(el.querySelector(".power-bar")).toBeNull();
    // Several selections follow: on in source, off in Live.
    expect(view().state.facet((await import("@codemirror/state")).EditorState.allowMultipleSelections)).toBe(false);
  });

  it("runs a line tool from the menu as one edit of the page", async () => {
    files.set("a.txt", { text: "c\nb\na\n" });
    await show("a.txt");
    await clickIn(lineTools());
    const sort = [...el.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) => b.textContent === "Sort ascending")!;
    await clickIn(sort);
    expect(view().state.doc.toString()).toBe("a\nb\nc\n");
    expect(doc("a.txt")).toMatchObject({ status: "dirty", text: "a\nb\nc\n" });
  });

  it("does not offer the line tools on a read-only file", async () => {
    files.set("a.txt", { text: "b\na\n", readOnly: "This file is read-only on disk" });
    await show("a.txt");
    await clickIn(lineTools());
    const sort = [...el.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) => b.textContent === "Sort ascending")!;
    expect(sort.disabled).toBe(true);
  });

  describe("the status line", () => {
    it("names the encoding, line endings, indentation, language and size, each one a menu but the size", async () => {
      files.set("code.py", { text: "def f():\n    return 1\n", format: { encoding: "windows-1252", bom: false, eol: "crlf", confidence: "guess" } });
      await show("code.py");
      expect(status().textContent).toBe("Western (Windows-1252) (guessed) · CRLF · 4 spaces · Python · 22 bytes");
      for (const label of ["Encoding", "Line endings", "Indentation", "Language"]) expect(menuButton(label), label).not.toBeNull();
    });

    it("reopens the file in another encoding while it is clean", async () => {
      files.set("a.txt", { text: "caf\u00e9", format: { encoding: "windows-1252", bom: false, eol: "lf", confidence: "guess" } });
      await show("a.txt");
      await clickIn(menuButton("Encoding"));
      expect(item("Central European (ISO-8859-2)").disabled).toBe(false);
      await clickIn(item("Central European (ISO-8859-2)"));
      expect(sent.filter((c) => c.cmd === "file_reopen")).toEqual([{ cmd: "file_reopen", args: { notebook: "nb-1", path: "a.txt", encoding: "ISO-8859-2" } }]);
      expect(doc("a.txt")).toMatchObject({ status: "clean", text: "caf\u00e9 (as ISO-8859-2)" });
      expect(status().textContent).toContain("Central European (ISO-8859-2)");
    });

    it("refuses to reopen while there are unsaved edits, and says why", async () => {
      files.set("a.txt", { text: "one", format: { encoding: "windows-1252", bom: false, eol: "lf", confidence: "guess" } });
      await show("a.txt");
      await act(async () => { docs.edit(docs.keyOf(ref("a.txt")), "one typed"); });
      await clickIn(menuButton("Encoding"));
      expect(item("Western (Windows-1252)").disabled).toBe(true);
      expect(status().textContent).toContain("Save or discard your edits to reopen the file in another encoding.");
      expect(sent.some((c) => c.cmd === "file_reopen")).toBe(false);
    });

    it("converts the encoding for the next save, which the page then writes", async () => {
      files.set("a.txt", { text: "caf\u00e9\n", format: { encoding: "windows-1252", bom: false, eol: "lf", confidence: "guess" } });
      await show("a.txt");
      await clickIn(menuButton("Encoding"));
      await clickIn([...status().querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].filter((b) => b.textContent === "UTF-8 with BOM").pop());
      expect(doc("a.txt")).toMatchObject({ status: "dirty", text: "caf\u00e9\n" });
      expect(status().textContent).toContain("UTF-8 with BOM (not saved yet)");
      expect(el.textContent).toContain("Saving writes this file as UTF-8 with BOM.");
      await act(async () => { await docs.save(docs.keyOf(ref("a.txt"))); });
      expect(files.get("a.txt")!.format).toMatchObject({ encoding: "UTF-8", bom: true, eol: "lf" });
      expect(doc("a.txt").status).toBe("clean");
    });

    it("changes the line endings for the next save", async () => {
      files.set("a.txt", { text: "one\ntwo\n" });
      await show("a.txt");
      await clickIn(menuButton("Line endings"));
      await clickIn(item("CRLF"));
      expect(doc("a.txt").status).toBe("dirty");
      expect(status().textContent).toContain("CRLF (not saved yet)");
      await act(async () => { await docs.save(docs.keyOf(ref("a.txt"))); });
      expect(files.get("a.txt")!.format!.eol).toBe("crlf");
    });

    it("lets the user choose a line ending for a mixed file, which makes it editable", async () => {
      files.set("m.txt", { text: "one\ntwo\n", format: { encoding: "UTF-8", bom: false, eol: "mixed", confidence: "valid" }, readOnly: "This file mixes line-ending styles", chooseEol: true });
      await show("m.txt");
      expect(doc("m.txt").status).toBe("readOnly");
      expect(el.textContent).toContain("Read-only: This file mixes line-ending styles.");
      await clickIn(menuButton("Line endings"));
      expect(item("Use LF and edit").disabled).toBe(false);
      await clickIn(item("Use CRLF and edit"));
      expect(doc("m.txt")).toMatchObject({ status: "dirty", base: { readOnly: null, format: { eol: "crlf" } } });
      expect(view().state.readOnly).toBe(false);
      expect(el.textContent).not.toContain("Read-only:");
    });

    it("the banner of a mixed file offers the same choice", async () => {
      files.set("m.txt", { text: "one\ntwo\n", format: { encoding: "UTF-8", bom: false, eol: "mixed", confidence: "valid" }, readOnly: "This file mixes line-ending styles", chooseEol: true });
      await show("m.txt");
      const lf = [...el.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Use LF and edit")!;
      await clickIn(lf);
      expect(doc("m.txt")).toMatchObject({ status: "dirty", base: { format: { eol: "lf" } } });
    });

    it("offers no encoding choices for a file that is read-only for another reason", async () => {
      files.set("r.txt", { text: "x", readOnly: "This file is read-only on disk" });
      await show("r.txt");
      await clickIn(menuButton("Line endings"));
      expect(items().every((b) => b.disabled)).toBe(true);
    });
  });

  describe("the language", () => {
    const languageOf = () => view().state.facet(language)?.name ?? null;

    it("comes from the file extension, and shows in the editor once its grammar has loaded", async () => {
      files.set("data.json", { text: '{"a": 1}\n' });
      await show("data.json");
      await settle();
      await vi.waitFor(() => expect(languageOf()).toBe("json"));
      expect(status().textContent).toContain("JSON");
    });

    it("a file with no known extension is plain text", async () => {
      files.set("notes.zzz", { text: "just words\n" });
      await show("notes.zzz");
      expect(languageOf()).toBeNull();
      expect(status().textContent).toContain("Plain text");
    });

    it("can be chosen from the picker, and put back to the file's own", async () => {
      files.set("notes.zzz", { text: "x = 1\n" });
      await show("notes.zzz");
      await clickIn(menuButton("Language"));
      await clickIn(item("Python"));
      await rerender();
      expect(ws().panes[0].tabs[0].language).toBe("Python");
      await vi.waitFor(() => expect(languageOf()).toBe("python"));
      expect(status().textContent).toContain("Python");
      await clickIn(menuButton("Language"));
      await clickIn(item("Plain text"));
      await rerender();
      await vi.waitFor(() => expect(languageOf()).toBeNull());
      await clickIn(menuButton("Language"));
      await clickIn(item("Choose from the file name"));
      await rerender();
      expect(ws().panes[0].tabs[0].language).toBeUndefined();
    });

    it("Markdown shows its own name and has no picker", async () => {
      files.set("p.md", { text: "# T\n" });
      await show("p.md", "source");
      expect(status().textContent).toContain("Markdown");
      expect(menuButton("Language")).toBeNull();
    });
  });
});
