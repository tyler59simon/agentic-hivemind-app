// @vitest-environment jsdom
// NS-3A: the rich editor in a real CodeMirror view: the table grid writes the table back, pictures pasted or dropped
// become links where they landed, and drops on the window go to the page, the terminal or a new tab.
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn(async (_cmd: string, _args?: unknown) => undefined as unknown);
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args?: unknown) => invoke(cmd, args) }));

import { registerDropTarget, routeDrop } from "../../notes/drops";
import { attachAt, dropPictures, pastedPictures } from "./attach";
import { richContext, type RichContext } from "./context";
import { richEditing, richLanguage, richPreview } from "./index";

// CodeMirror measures text through ranges, which jsdom does not lay out.
Range.prototype.getClientRects = function () { return [] as unknown as DOMRectList; };
Range.prototype.getBoundingClientRect = function () { return new DOMRect(); };

function ctx(over: Partial<RichContext> = {}): RichContext {
  return {
    pictureUrl: () => null, readEmbed: async () => null, renderEmbed: () => () => {}, openPage: vi.fn(), openHref: vi.fn(), fail: vi.fn(),
    ...over,
  };
}

let views: EditorView[] = [];
afterEach(() => { views.forEach((v) => v.destroy()); views = []; document.body.innerHTML = ""; invoke.mockClear(); });

function editor(doc: string, rich: RichContext, cursor = doc.length) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({ parent, state: EditorState.create({ doc, selection: { anchor: cursor }, extensions: [richLanguage(), ...richEditing(rich), richPreview] }) });
  ensureSyntaxTree(view.state, view.state.doc.length, 5000);
  view.dispatch({ effects: [] });
  views.push(view);
  return view;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("the table grid", () => {
  it("writes a typed cell back as the padded table, keeping the focused input", () => {
    const view = editor("Intro\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nEnd", ctx(), 0);
    const cell = view.dom.querySelector<HTMLInputElement>('input[data-row="0"][data-col="1"]')!;
    expect(cell.value).toBe("2");
    cell.focus();
    cell.value = "two | three";
    cell.dispatchEvent(new Event("input"));
    expect(view.state.doc.toString()).toBe("Intro\n\n| a   | b            |\n| --- | ------------ |\n| 1   | two \\| three |\n\nEnd");
    const again = view.dom.querySelector<HTMLInputElement>('input[data-row="0"][data-col="1"]')!;
    expect(again).toBe(cell);
    expect(again.value).toBe("two | three");
    expect(document.activeElement).toBe(cell);
  });

  it("adds a row with Enter and leaves the grid with Escape, showing the source", () => {
    const view = editor("| a |\n|---|\n| 1 |\n\nEnd", ctx());
    const cell = view.dom.querySelector<HTMLInputElement>('input[data-row="0"]')!;
    cell.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(view.state.doc.toString()).toBe("| a   |\n| --- |\n| 1   |\n|     |\n\nEnd");
    const added = view.dom.querySelector<HTMLInputElement>('input[data-row="1"]')!;
    added.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(view.state.selection.main.head).toBe(0);
    expect(view.dom.querySelector(".cm-rich-table")).toBeNull();
  });

  it("does not write when the page is read-only", () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({ parent, state: EditorState.create({ doc: "| a |\n|---|\n| 1 |\n\nx", selection: { anchor: 20 }, extensions: [richLanguage(), ...richEditing(ctx()), richPreview, EditorState.readOnly.of(true)] }) });
    views.push(view);
    const cell = view.dom.querySelector<HTMLInputElement>('input[data-row="0"]')!;
    expect(cell.readOnly).toBe(true);
    cell.value = "changed";
    cell.dispatchEvent(new Event("input"));
    expect(view.state.doc.toString()).toBe("| a |\n|---|\n| 1 |\n\nx");
  });
});

describe("attaching pictures", () => {
  it("puts a placeholder at once and swaps it for the link, wherever typing moved it", async () => {
    let finish!: (link: string) => void;
    const view = editor("Hello world", ctx());
    const pending = attachAt(view, ctx(), 5, ["shot.png"], () => new Promise((r) => { finish = r; }));
    expect(view.state.doc.toString()).toMatch(/^Hello!\[Attaching shot\.png \(\d+\)…\]\(\) world$/);
    view.dispatch({ changes: { from: 0, insert: "Oh. " } });
    finish("![shot.png](attachments/shot.png)");
    await pending;
    expect(view.state.doc.toString()).toBe("Oh. Hello![shot.png](attachments/shot.png) world");
  });

  it("removes the placeholder and says why when saving fails, and adds no link when the user deleted it", async () => {
    const fail = vi.fn();
    const view = editor("Text", ctx({ fail }));
    await attachAt(view, ctx({ fail }), 4, ["a.png"], async () => { throw new Error("disk full"); });
    expect(view.state.doc.toString()).toBe("Text");
    expect(fail).toHaveBeenCalledWith("a.png was not attached: disk full");
    let finish!: (link: string) => void;
    const pending = attachAt(view, ctx({ fail }), 4, ["b.png"], () => new Promise((r) => { finish = r; }));
    view.dispatch({ changes: { from: 4, to: view.state.doc.length } });
    finish("![b.png](b.png)");
    await pending;
    expect(view.state.doc.toString()).toBe("Text");
    expect(fail).toHaveBeenLastCalledWith("b.png was attached, but its placeholder was removed, so the page has no link to it.");
  });

  it("names clipboard pictures by the time and skips other files", () => {
    const files = [new File(["x"], "image.png", { type: "image/png" }), new File(["y"], "a.txt", { type: "text/plain" }), new File(["z"], "p.jpg", { type: "image/jpeg" })];
    const got = pastedPictures({ files } as unknown as DataTransfer, new Date(2026, 0, 2, 3, 4, 5));
    expect(got.map((p) => p.name)).toEqual(["Pasted image 20260102030405.png", "Pasted image 20260102030406.jpg"]);
  });

  it("attaches only the pictures of a drop, at the drop point, and leaves the rest to open", async () => {
    const attachDropped = vi.fn(async (_t: string, i: number, name: string) => `![${name}](${i})`);
    const rich = ctx({ attachDropped });
    const view = editor("Line one", rich);
    view.posAtCoords = () => 4;
    const taken = dropPictures(view, rich, { token: "t", names: ["a.png", "notes.txt", "b.JPG"], x: 1, y: 1 });
    expect(taken).toEqual([0, 2]);
    await flush();
    await flush();
    expect(attachDropped.mock.calls.map((c) => c[1])).toEqual([0, 2]);
    expect(view.state.doc.toString()).toBe("Line\n![a.png](0)\n![b.JPG](2) one");
    expect(dropPictures(view, ctx(), { token: "t", names: ["a.png"], x: 1, y: 1 })).toEqual([]);
  });
});

describe("routing a drop", () => {
  it("leaves a drop on a terminal to the terminal, gives a page its pictures and opens the rest", async () => {
    const term = document.createElement("div");
    term.className = "xterm";
    const page = document.createElement("div");
    document.body.append(term, page);
    const handler = vi.fn(async () => [0]);
    const stop = registerDropTarget(page, handler);
    const at = (el: Element) => { document.elementFromPoint = () => el; };

    at(term);
    await routeDrop({ token: "a", names: ["x.png"], x: 10, y: 10 }, 1);
    expect(invoke).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();

    at(page);
    await routeDrop({ token: "b", names: ["x.png", "y.txt"], x: 20, y: 40 }, 2);
    expect(handler).toHaveBeenCalledWith({ token: "b", names: ["x.png", "y.txt"], x: 10, y: 20 });
    expect(invoke).toHaveBeenCalledWith("open_dropped", { token: "b", indexes: [1] });

    stop();
    invoke.mockClear();
    await routeDrop({ token: "c", names: ["x.png"], x: 1, y: 1 }, 1);
    expect(invoke).toHaveBeenCalledWith("open_dropped", { token: "c", indexes: [0] });
  });

  it("opens every file when the page's handler fails", async () => {
    const page = document.createElement("div");
    document.body.append(page);
    const stop = registerDropTarget(page, async () => { throw new Error("no"); });
    document.elementFromPoint = () => page;
    await routeDrop({ token: "d", names: ["x.png"], x: 1, y: 1 }, 1);
    expect(invoke).toHaveBeenCalledWith("open_dropped", { token: "d", indexes: [0] });
    stop();
  });
});

describe("links", () => {
  it("Ctrl+click on a link opens it through the page", () => {
    const openHref = vi.fn();
    const view = editor("See [docs](https://example.com/x) now\n\nend", ctx({ openHref }));
    const link = view.dom.querySelector<HTMLElement>("[data-href]")!;
    expect(link.dataset.href).toBe("https://example.com/x");
    link.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, ctrlKey: true }));
    expect(openHref).toHaveBeenCalledWith("https://example.com/x", false);
  });

  it("keeps the rich context out of an editor that has none", () => {
    const state = EditorState.create({ doc: "x", extensions: [richLanguage()] });
    expect(state.facet(richContext)).toBeNull();
  });
});
