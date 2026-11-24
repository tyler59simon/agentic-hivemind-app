// @vitest-environment jsdom
// The editing parts the .hmdoc editor took from NS-3B's Rich editor (toolbar, slash menu, typing rules, block moves,
// paste, pictures being saved), tested here since Rich mode for Markdown was deleted (CON-19). The cases come from
// the Rich editor's tests and the Codex reviews of 2392f6b, b0afec0 and ad6c5c5.
import type { Editor } from "@tiptap/core";
import { CellSelection } from "@tiptap/pm/tables";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RichContext } from "../editor/rich/context";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
// Scrolling a selection into view measures text through ranges, which jsdom does not lay out.
Range.prototype.getClientRects = function () { return [] as unknown as DOMRectList; };
Range.prototype.getBoundingClientRect = function () { return new DOMRect(); };

const { default: HmdocEditor } = await import("./HmdocEditor");
const { moveTopBlock } = await import("../rich/editing");
const { stringifyEnvelope } = await import("./envelope");

let root: Root | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

function context(over: Partial<RichContext> = {}): RichContext {
  return { pictureUrl: () => null, readEmbed: async () => null, renderEmbed: () => () => {}, openPage: vi.fn(), openHref: vi.fn(), fail: vi.fn(), ...over };
}

const p = (text: string) => ({ type: "paragraph", content: text ? [{ type: "text", text }] : [] });
const cell = (text: string, type = "tableCell") => ({ type, content: [p(text)] });
const fileOf = (content: unknown[]) => stringifyEnvelope({ schemaVersion: 1, format: "hivemind-rich", meta: {}, content: { type: "doc", content } } as never);
const table = (align: (string | null)[], rows: string[][]) => ({
  type: "table", attrs: { id: "t1", align },
  content: rows.map((r, i) => ({ type: "tableRow", content: r.map((t) => cell(t, i === 0 ? "tableHeader" : "tableCell")) })),
});

async function mount(text: string, ctx: RichContext = context()) {
  const changes: string[] = [];
  const onSave = vi.fn();
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  const invalid = (reason: string): ReactNode => <div className="invalid">{reason}</div>;
  await act(async () => root!.render(
    <HmdocEditor text={text} version={1} readOnly={false} onChange={(x) => changes.push(x)} onSave={onSave} ctx={ctx} pictures={[]} invalid={invalid} />,
  ));
  const editor = (el.querySelector(".rich-doc") as HTMLElement & { editor: Editor }).editor;
  return { el, editor, changes, onSave };
}

/** Where the text of top-level block `i` ends. */
function endOf(editor: Editor, i: number) {
  let pos = 0;
  for (let k = 0; k < i; k++) pos += editor.state.doc.child(k).nodeSize;
  return pos + editor.state.doc.child(i).nodeSize - 1;
}
const texts = (editor: Editor) => { const out: string[] = []; editor.state.doc.forEach((n) => out.push(n.textContent)); return out; };
const press = (editor: Editor, init: KeyboardEventInit) => editor.view.someProp("handleKeyDown", (f) => f(editor.view, new KeyboardEvent("keydown", init)));
const pasteText = (editor: Editor, text: string) => {
  const clipboardData = { getData: (t: string) => (t === "text/plain" ? text : ""), files: [], types: [] };
  const event = Object.assign(new Event("paste"), { clipboardData }) as unknown as ClipboardEvent;
  return editor.view.someProp("handlePaste", (f) => f(editor.view, event, editor.state.doc.slice(0, 0)));
};
const pastePicture = (editor: Editor) => {
  const file = Object.assign(new File([new Uint8Array([1])], "shot.png", { type: "image/png" }), { arrayBuffer: async () => new Uint8Array([1]).buffer });
  const clipboardData = { getData: () => "", files: [file], types: [] };
  editor.view.someProp("handlePaste", (f) => f(editor.view, Object.assign(new Event("paste"), { clipboardData }) as unknown as ClipboardEvent, editor.state.doc.slice(0, 0)));
};
const mousedown = async (el: HTMLElement, label: string) => {
  await act(async () => { el.querySelector(`[aria-label="${label}"]`)!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
};
const cells = (editor: Editor) => {
  const out: number[] = [];
  editor.state.doc.descendants((n, pos) => { if (n.type.name === "tableCell" || n.type.name === "tableHeader") out.push(pos); return true; });
  return out;
};

describe("editing", () => {
  it("shows the toolbar as soon as the page opens (R1-8), and Ctrl+S saves", async () => {
    const { el, editor, onSave } = await mount(fileOf([p("Text")]));
    expect(el.querySelector(".rich-toolbar")).not.toBeNull();
    await act(async () => { editor.commands.keyboardShortcut("Mod-s"); });
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("moves a top-level block", async () => {
    const { editor } = await mount(fileOf([p("Alpha"), p("Beta"), p("Gamma")]));
    await act(async () => { moveTopBlock(editor.view, 0, 2); });
    expect(texts(editor)).toEqual(["Beta", "Alpha", "Gamma"]);
    await act(async () => { moveTopBlock(editor.view, 2, 0); });
    expect(texts(editor)).toEqual(["Gamma", "Beta", "Alpha"]);
  });

  it("typing [[Page]], ![[Page]] and $x$ makes a link, an embed and math", async () => {
    const { editor } = await mount(fileOf([p("Text")]));
    const type = (text: string) => {
      const { from, to } = editor.state.selection;
      const handled = editor.view.someProp("handleTextInput", (f) => f(editor.view, from, to, text, () => editor.state.tr));
      if (!handled) editor.view.dispatch(editor.state.tr.insertText(text, from, to));
    };
    await act(async () => {
      editor.commands.setTextSelection(endOf(editor, 0));
      for (const ch of " [[Page]] and ![[Other]] and $x$") type(ch);
    });
    const names: string[] = [];
    editor.state.doc.descendants((n) => { names.push(n.type.name); return true; });
    expect(names).toEqual(expect.arrayContaining(["wikiLink", "embed", "mathInline"]));
  });

  it("the slash menu lists blocks and turns the line into the one picked", async () => {
    const { editor, el } = await mount(fileOf([p("Text")]));
    await act(async () => {
      editor.commands.setTextSelection(endOf(editor, 0));
      editor.commands.splitBlock();
      editor.commands.insertContent("/head");
    });
    const options = [...el.querySelectorAll(".rich-slash [role=option]")].map((o) => o.textContent);
    expect(options[0]).toContain("Heading 1");
    await act(async () => { press(editor, { key: "ArrowDown" }); });
    await act(async () => { press(editor, { key: "Enter" }); });
    await act(async () => { editor.commands.insertContent("Sub"); });
    const last = editor.state.doc.lastChild!;
    expect([last.type.name, last.attrs.level, last.textContent]).toEqual(["heading", 2, "Sub"]);
  });

  it("pastes plain text into a code block as code (R1-7)", async () => {
    const { editor } = await mount(fileOf([{ type: "codeBlock", content: [{ type: "text", text: "code" }] }]));
    await act(async () => { editor.commands.setTextSelection(2); });
    expect(pasteText(editor, "- option\n- second")).toBeFalsy();
  });
});

describe("table columns keep their alignment", () => {
  it.each([
    ["Delete column", ["right"]],
    ["Add column right", ["left", null, "right"]],
  ] as const)("%s (R1-10)", async (label, align) => {
    const { editor, el } = await mount(fileOf([table(["left", "right"], [["a", "b"], ["1", "2"]])]));
    await act(async () => { editor.commands.setTextSelection(cells(editor)[0] + 2); });
    await mousedown(el, label);
    expect(editor.state.doc.child(0).attrs.align).toEqual(align);
  });

  it.each([
    ["Delete column", ["right"]],
    ["Add column right", ["left", "center", null, "right"]],
  ] as const)("%s acts on every selected column (R2-5)", async (label, align) => {
    const { editor, el } = await mount(fileOf([table(["left", "center", "right"], [["a", "b", "c"], ["1", "2", "3"]])]));
    const [first, second] = cells(editor);
    await act(async () => { editor.view.dispatch(editor.state.tr.setSelection(CellSelection.create(editor.state.doc, first, second))); });
    await mousedown(el, label);
    expect(editor.state.doc.child(0).attrs.align).toEqual(align);
  });

  it("a last column that cannot be deleted keeps its alignment (R2-7)", async () => {
    const { editor, el, changes } = await mount(fileOf([table(["right"], [["a"], ["1"]])]));
    await act(async () => { editor.commands.setTextSelection(cells(editor)[0] + 2); });
    await mousedown(el, "Delete column");
    expect(changes).toEqual([]);
    expect(editor.state.doc.child(0).attrs.align).toEqual(["right"]);
  });

  it("alignments move when a column is added to a table with a merged header (R3-4)", async () => {
    // A header cell spanning two columns, as an HTML paste makes.
    const merged = { type: "table", attrs: { id: "t1", align: ["left", "center", "right"] }, content: [
      { type: "tableRow", content: [{ ...cell("a", "tableHeader"), attrs: { colspan: 2 } }, cell("c", "tableHeader")] },
      { type: "tableRow", content: [cell("1"), cell("2"), cell("3")] },
    ] };
    const { editor, el } = await mount(fileOf([merged]));
    let last = -1;
    editor.state.doc.descendants((n, pos) => { if (n.isText && n.text === "3") last = pos; return true; });
    await act(async () => { editor.commands.setTextSelection(last); });
    await mousedown(el, "Add column right");
    expect(editor.state.doc.child(0).attrs.align).toEqual(["left", "center", "right", null]);
  });
});

describe("a picture being saved", () => {
  it("Undo while it saves cancels its link and keeps earlier edits (R1-14)", async () => {
    let finish: (link: string) => void = () => {};
    const attach = vi.fn(() => new Promise<string>((r) => { finish = r; }));
    const fail = vi.fn();
    const { editor } = await mount(fileOf([p("Start")]), context({ attach, fail }));
    await act(async () => { editor.commands.setTextSelection(endOf(editor, 0)); editor.commands.insertContent("x"); });
    await act(async () => { pastePicture(editor); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    await act(async () => { expect(press(editor, { key: "z", ctrlKey: true })).toBe(true); });
    await act(async () => { finish("![shot](shot.png)"); await new Promise((r) => setTimeout(r, 0)); });
    expect(texts(editor)).toEqual(["Startx"]);
    const names: string[] = [];
    editor.state.doc.descendants((n) => { names.push(n.type.name); return true; });
    expect(names).not.toContain("image");
    expect(fail).not.toHaveBeenCalled();
  });

  it("a picture cancelled by Undo is dropped also when the page closed meanwhile (R2-8)", async () => {
    let finish: (link: string) => void = () => {};
    const attach = vi.fn(() => new Promise<string>((r) => { finish = r; }));
    const fail = vi.fn();
    const { editor } = await mount(fileOf([p("Start")]), context({ attach, fail }));
    await act(async () => { editor.commands.setTextSelection(endOf(editor, 0)); pastePicture(editor); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    await act(async () => { press(editor, { key: "z", ctrlKey: true }); });
    await act(async () => root?.unmount());
    root = null;
    await act(async () => { finish("![shot](shot.png)"); await new Promise((r) => setTimeout(r, 0)); });
    expect(fail).not.toHaveBeenCalled();
  });
});
