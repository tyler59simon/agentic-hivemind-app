// @vitest-environment jsdom
// NS-3B: the Rich editor in a page. Switching to Rich changes nothing; an edit changes only its block; Undo, moves,
// copies and deletes follow the ownership rule (NS-0 review, C5); typing, pasting and saving behave as in Live.
import type { Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import { CellSelection } from "@tiptap/pm/tables";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RichContext } from "../editor/rich/context";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));

const { default: RichEditor } = await import("./RichEditor");
const { moveTopBlock } = await import("./editing");
const { parse } = await import("./markdown");

let root: Root | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

function context(over: Partial<RichContext> = {}): RichContext {
  return {
    pictureUrl: () => null, readEmbed: async () => null, renderEmbed: () => () => {}, openPage: vi.fn(), openHref: vi.fn(), fail: vi.fn(),
    ...over,
  };
}

async function mount(text: string, extra: { readOnly?: boolean; ctx?: RichContext } = {}) {
  const changes: string[] = [];
  const onSave = vi.fn();
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  const render = async (t: string, readOnly = extra.readOnly ?? false) => {
    await act(async () => root!.render(<RichEditor text={t} readOnly={readOnly} onChange={(x) => changes.push(x)} onSave={onSave} ctx={extra.ctx ?? context()} />));
  };
  await render(text);
  const editor = (el.querySelector(".rich-doc") as HTMLElement & { editor: Editor }).editor;
  return { editor, changes, onSave, render, el };
}

const kids = (doc: PMNode) => { const out: PMNode[] = []; doc.forEach((n) => out.push(n)); return out; };
/** Where the text of top-level block `i` ends. */
function endOf(doc: PMNode, i: number) {
  let pos = 0;
  for (let k = 0; k < i; k++) pos += doc.child(k).nodeSize;
  return pos + doc.child(i).nodeSize - 1;
}
const slices = (text: string) => parse(text).children.map((c) => text.slice(c.position!.start.offset!, c.position!.end.offset!));

const PAGE = "# Title\n\nFirst *paragraph*  \nwith a break.\n\n* one\n* two\n\n> [!tip] Tip\n> body\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n$$\nx^2\n$$\n\nLast [[Page|alias]] ==mark== %%note%%.\n";

describe("switching modes", () => {
  it("opening a page in Rich writes nothing, and its blocks are editable nodes", async () => {
    const { editor, changes } = await mount(PAGE);
    expect(changes).toEqual([]);
    expect(kids(editor.state.doc).map((n) => n.type.name)).toEqual(["heading", "paragraph", "bulletList", "callout", "table", "mathBlock", "paragraph"]);
    // Selecting and moving around is not an edit.
    await act(async () => { editor.commands.setTextSelection(5); editor.commands.selectAll(); });
    expect(changes).toEqual([]);
  });

  it("no node loses its identity in a transaction that does not change it", async () => {
    const { editor } = await mount(PAGE);
    const before = kids(editor.state.doc);
    await act(async () => { editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 3))); });
    kids(editor.state.doc).forEach((n, i) => expect(n).toBe(before[i]));
    await act(async () => { editor.view.dispatch(editor.state.tr.insertText("x", endOf(editor.state.doc, 1))); });
    kids(editor.state.doc).forEach((n, i) => { if (i !== 1) expect(n, `block ${i}`).toBe(before[i]); });
  });
});

describe("editing", () => {
  it("typing in one block changes only that block, in the page's own style", async () => {
    const { editor, changes } = await mount(PAGE);
    await act(async () => { editor.view.dispatch(editor.state.tr.insertText(" more", endOf(editor.state.doc, 1))); });
    const out = changes[changes.length - 1];
    const [a, b] = [slices(PAGE), slices(out)];
    expect(b.length).toBe(a.length);
    b.forEach((s, i) => { if (i !== 1) expect(s).toBe(a[i]); });
    // The edited paragraph keeps its emphasis marker and its two-space break.
    expect(b[1]).toBe("First *paragraph*  \nwith a break. more");
  });

  it("Undo after an edit gives the page back byte for byte", async () => {
    const { editor, changes } = await mount(PAGE);
    await act(async () => { editor.view.dispatch(editor.state.tr.insertText("!", endOf(editor.state.doc, 0))); });
    expect(changes[changes.length - 1]).not.toBe(PAGE);
    await act(async () => { editor.commands.undo(); });
    expect(changes[changes.length - 1]).toBe(PAGE);
  });

  it("a moved block keeps its source; the text between blocks follows the original neighbours only", async () => {
    const page = "Alpha *one*\n\n\n_Beta_ two\n\nGamma\n";
    const { editor, changes } = await mount(page);
    await act(async () => { moveTopBlock(editor.view, 0, 2); });
    expect(changes[changes.length - 1]).toBe("_Beta_ two\n\nAlpha *one*\n\nGamma\n");
  });

  it("a copied block is written anew; the original keeps its slice", async () => {
    const page = "*a* one\n\n_b_ two\n";
    const { editor, changes } = await mount(page);
    await act(async () => { editor.view.dispatch(editor.state.tr.insert(editor.state.doc.content.size, editor.state.doc.child(1))); });
    const out = changes[changes.length - 1];
    expect(out.startsWith("*a* one\n\n_b_ two\n\n")).toBe(true);
    expect(parse(out).children).toHaveLength(3);
    expect(out.endsWith("b* two\n") || out.endsWith("b_ two\n")).toBe(true);
  });

  it("deleting a block joins its neighbours with a blank line; the first block's leading text stays", async () => {
    const page = "\n\nOne\n\n\n\nTwo\n\nThree\n\n\n";
    const { editor, changes } = await mount(page);
    const one = editor.state.doc.child(0).nodeSize;
    await act(async () => { editor.view.dispatch(editor.state.tr.delete(one, one + editor.state.doc.child(1).nodeSize)); });
    expect(changes[changes.length - 1]).toBe("\n\nOne\n\nThree\n\n\n");
  });

  it("editing the first block drops the text before it; the last block keeps the text after it", async () => {
    const page = "\n\nOne\n\nTwo\n\n\n";
    const { editor, changes } = await mount(page);
    await act(async () => { editor.view.dispatch(editor.state.tr.insertText("!", endOf(editor.state.doc, 0))); });
    expect(changes[changes.length - 1]).toBe("One!\n\nTwo\n\n\n");
    await act(async () => { editor.view.dispatch(editor.state.tr.insertText("?", endOf(editor.state.doc, 1))); });
    expect(changes[changes.length - 1]).toBe("One!\n\nTwo?\n\n\n");
  });

  it("equal blocks spelled differently each keep their own spelling when swapped", async () => {
    const page = "*same*\n\n_same_\n";
    const { editor, changes } = await mount(page);
    await act(async () => { moveTopBlock(editor.view, 1, 0); });
    expect(changes[changes.length - 1]).toBe("_same_\n\n*same*\n");
  });

  it("typing [[Page]], ![[Page]] and $x$ makes a link, an embed and math", async () => {
    const { editor, changes } = await mount("Text\n");
    const type = (text: string) => {
      const { from, to } = editor.state.selection;
      const handled = editor.view.someProp("handleTextInput", (f) => f(editor.view, from, to, text, () => editor.state.tr));
      if (!handled) editor.view.dispatch(editor.state.tr.insertText(text, from, to));
    };
    await act(async () => {
      editor.commands.setTextSelection(endOf(editor.state.doc, 0));
      for (const ch of " [[Page]] and ![[Other]] and $x$") type(ch);
    });
    const names: string[] = [];
    editor.state.doc.descendants((n) => { names.push(n.type.name); return true; });
    expect(names).toEqual(expect.arrayContaining(["wikiLink", "embed", "mathInline"]));
    expect(changes[changes.length - 1]).toBe("Text [[Page]] and ![[Other]] and $x$\n");
  });

  it("Ctrl+S saves", async () => {
    const { editor, onSave } = await mount("Text\n");
    await act(async () => { editor.commands.keyboardShortcut("Mod-s"); });
    expect(onSave).toHaveBeenCalledTimes(1);
  });
});

describe("paste and copy", () => {
  const paste = (editor: Editor, data: { text?: string; html?: string; files?: File[] }) => {
    const clipboardData = { getData: (t: string) => (t === "text/plain" ? data.text ?? "" : t === "text/html" ? data.html ?? "" : ""), files: data.files ?? [], types: [] };
    const event = Object.assign(new Event("paste"), { clipboardData }) as unknown as ClipboardEvent;
    return editor.view.someProp("handlePaste", (f) => f(editor.view, event, editor.state.doc.slice(0, 0)));
  };

  it("pasted Markdown becomes blocks and marks", async () => {
    const { editor, changes } = await mount("Start\n");
    await act(async () => {
      editor.commands.setTextSelection(endOf(editor.state.doc, 0));
      paste(editor, { text: "\n\n## Pasted\n\n- **a**\n- b" });
    });
    expect(kids(editor.state.doc).map((n) => n.type.name)).toEqual(expect.arrayContaining(["heading", "bulletList"]));
    expect(changes[changes.length - 1]).toContain("## Pasted");
    expect(changes[changes.length - 1]).toContain("**a**");
  });

  it("a pasted picture is attached and linked where it was pasted", async () => {
    const attach = vi.fn(async (_bytes: Uint8Array, name: string) => `![${name}](attachments/${encodeURI(name)})`);
    const { editor, changes } = await mount("Before after\n", { ctx: context({ attach }) });
    await act(async () => {
      editor.commands.setTextSelection(1 + "Before ".length);
      // jsdom's File has no arrayBuffer.
      const file = Object.assign(new File([new Uint8Array([1, 2, 3])], "shot.png", { type: "image/png" }), { arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer });
      expect(paste(editor, { files: [file] })).toBe(true);
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(attach).toHaveBeenCalledTimes(1);
    expect(changes[changes.length - 1]).toMatch(/^Before !\[Pasted image \d{14}\.png\]\(attachments\/Pasted%20image%20\d{14}\.png\)after\n$/);
  });

  it("copied content goes on the clipboard as Markdown", async () => {
    const { editor } = await mount("Some **bold** text\n\n- item\n");
    const slice = editor.state.doc.slice(0, editor.state.doc.content.size);
    const text = editor.view.someProp("clipboardTextSerializer", (f) => f(slice, editor.view));
    expect(text).toBe("Some **bold** text\n\n- item");
  });
});

describe("the page around the editor", () => {
  it("text changed elsewhere rebuilds the document without writing it back", async () => {
    const { editor, changes, render } = await mount("One\n");
    await render("Two\n\nThree\n");
    expect(kids(editor.state.doc).map((n) => n.textContent)).toEqual(["Two", "Three"]);
    expect(changes).toEqual([]);
  });

  it("a read-only page cannot be edited", async () => {
    const { editor } = await mount("One\n", { readOnly: true });
    expect(editor.isEditable).toBe(false);
  });

  it("the slash menu lists blocks and turns the line into the one picked", async () => {
    const { editor, el, changes } = await mount("Text\n\n");
    await act(async () => {
      editor.commands.setTextSelection(endOf(editor.state.doc, 0));
      editor.commands.splitBlock();
      editor.commands.insertContent("/head");
    });
    const options = [...el.querySelectorAll(".rich-slash [role=option]")].map((o) => o.textContent);
    expect(options[0]).toContain("Heading 1");
    await act(async () => { editor.view.someProp("handleKeyDown", (f) => f(editor.view, new KeyboardEvent("keydown", { key: "ArrowDown" }))); });
    await act(async () => { editor.view.someProp("handleKeyDown", (f) => f(editor.view, new KeyboardEvent("keydown", { key: "Enter" }))); });
    await act(async () => { editor.commands.insertContent("Sub"); });
    expect(changes[changes.length - 1]).toBe("Text\n\n## Sub\n");
  });
});

describe("Codex review of 2392f6b", () => {
  const posOf = (editor: Editor, type: string) => {
    let at = -1;
    editor.state.doc.descendants((n, pos) => { if (at < 0 && n.type.name === type) at = pos; return at < 0; });
    return at;
  };
  /** Where the text `text` starts. */
  const textAt = (editor: Editor, text: string) => {
    let at = -1;
    editor.state.doc.descendants((n, pos) => { if (at < 0 && n.isText && n.text!.includes(text)) at = pos + n.text!.indexOf(text); return at < 0; });
    return at;
  };
  const press = (editor: Editor, init: KeyboardEventInit) => editor.view.someProp("handleKeyDown", (f) => f(editor.view, new KeyboardEvent("keydown", init)));
  const paste = (editor: Editor, text: string) => {
    const clipboardData = { getData: (t: string) => (t === "text/plain" ? text : ""), files: [], types: [] };
    const event = Object.assign(new Event("paste"), { clipboardData }) as unknown as ClipboardEvent;
    return editor.view.someProp("handlePaste", (f) => f(editor.view, event, editor.state.doc.slice(0, 0)));
  };

  it("shows the toolbar as soon as Rich opens (R1-8)", async () => {
    const { el } = await mount("Text\n");
    expect(el.querySelector(".rich-toolbar")).not.toBeNull();
  });

  it("pastes plain text into a code block as code (R1-7)", async () => {
    const { editor } = await mount("```\ncode\n```\n");
    await act(async () => { editor.commands.setTextSelection(2); });
    expect(paste(editor, "- option\n- second")).toBeFalsy();
  });

  it.each([
    ["Delete column", ["right"]],
    ["Add column right", ["left", null, "right"]],
  ] as const)("%s keeps each column's alignment (R1-10)", async (label, align) => {
    const { editor, el, changes } = await mount("| a | b |\n|:--|--:|\n| 1 | 2 |\n");
    await act(async () => { editor.commands.setTextSelection(textAt(editor, "a")); });
    const button = el.querySelector(`[aria-label="${label}"]`)!;
    await act(async () => { button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
    const table = parse(changes[changes.length - 1]).children[0] as { type: string; align: unknown[] };
    expect(table.type).toBe("table");
    expect(table.align).toEqual(align);
  });

  it("locks and unlocks source boxes with the page (R1-11)", async () => {
    const { el, render } = await mount("<div>x</div>\n");
    const content = () => el.querySelector(".rich-raw .cm-content")!.getAttribute("contenteditable");
    expect(content()).toBe("true");
    await render("<div>x</div>\n", true);
    expect(content()).toBe("false");
    await render("<div>x</div>\n", false);
    expect(content()).toBe("true");
  });

  it("closes an open popover when the text is reloaded (R1-12)", async () => {
    const { editor, el, render } = await mount("See [[Old]] here.\n");
    const pos = posOf(editor, "wikiLink");
    await act(async () => { editor.view.someProp("handleDoubleClickOn", (f) => f(editor.view, pos, editor.state.doc.nodeAt(pos)!, pos, new MouseEvent("dblclick"), true)); });
    expect(el.querySelector(".rich-popover")).not.toBeNull();
    await render("[[Other]] first.\n");
    expect(el.querySelector(".rich-popover")).toBeNull();
  });

  it("opens only the current target of a wiki link after it changes (R1-13)", async () => {
    const openPage = vi.fn();
    const { editor, el } = await mount("See [[Old]] here.\n", { ctx: context({ openPage }) });
    const pos = posOf(editor, "wikiLink");
    await act(async () => { editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...editor.state.doc.nodeAt(pos)!.attrs, value: "New" })); });
    el.querySelector(".rich-wikilink")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, ctrlKey: true }));
    expect(openPage).toHaveBeenCalledTimes(1);
    expect(openPage).toHaveBeenCalledWith("New", false);
  });

  it("Undo while a picture is saving cancels its link and keeps earlier edits (R1-14)", async () => {
    let finish: (link: string) => void = () => {};
    const attach = vi.fn(() => new Promise<string>((r) => { finish = r; }));
    const fail = vi.fn();
    const { editor, changes } = await mount("Start\n", { ctx: context({ attach, fail }) });
    await act(async () => { editor.commands.setTextSelection(endOf(editor.state.doc, 0)); editor.commands.insertContent("x"); });
    await act(async () => {
      const file = Object.assign(new File([new Uint8Array([1])], "shot.png", { type: "image/png" }), { arrayBuffer: async () => new Uint8Array([1]).buffer });
      const clipboardData = { getData: () => "", files: [file], types: [] };
      editor.view.someProp("handlePaste", (f) => f(editor.view, Object.assign(new Event("paste"), { clipboardData }) as unknown as ClipboardEvent, editor.state.doc.slice(0, 0)));
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    await act(async () => { expect(press(editor, { key: "z", ctrlKey: true })).toBe(true); });
    await act(async () => { finish("![shot](shot.png)"); await new Promise((r) => setTimeout(r, 0)); });
    expect(changes[changes.length - 1]).toBe("Startx\n");
    expect(fail).not.toHaveBeenCalled();
  });
});

describe("Codex review of b0afec0", () => {
  const cells = (editor: Editor) => {
    const out: number[] = [];
    editor.state.doc.descendants((n, pos) => { if (n.type.name === "tableCell" || n.type.name === "tableHeader") out.push(pos); return true; });
    return out;
  };
  const click = async (el: HTMLElement, label: string) => {
    await act(async () => { el.querySelector(`[aria-label="${label}"]`)!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
  };

  it.each([
    ["Delete column", ["right"]],
    ["Add column right", ["left", "center", null, "right"]],
  ] as const)("%s acts on every selected column's alignment (R2-5)", async (label, align) => {
    const { editor, el, changes } = await mount("| a | b | c |\n|:--|:-:|--:|\n| 1 | 2 | 3 |\n");
    const [first, second] = cells(editor);
    await act(async () => { editor.view.dispatch(editor.state.tr.setSelection(CellSelection.create(editor.state.doc, first, second))); });
    await click(el, label);
    const table = parse(changes[changes.length - 1]).children[0] as { align: unknown[] };
    expect(table.align).toEqual(align);
  });

  it("keeps the alignment of a last column that cannot be deleted (R2-7)", async () => {
    const { editor, el, changes } = await mount("| a |\n|--:|\n| 1 |\n");
    await act(async () => { editor.commands.setTextSelection(cells(editor)[0] + 2); });
    await click(el, "Delete column");
    expect(changes).toEqual([]);
  });

  it("drops a picture cancelled by Undo also when the page closed meanwhile (R2-8)", async () => {
    let finish: (link: string) => void = () => {};
    const attach = vi.fn(() => new Promise<string>((r) => { finish = r; }));
    const fail = vi.fn();
    const { editor } = await mount("Start\n", { ctx: context({ attach, fail }) });
    await act(async () => {
      editor.commands.setTextSelection(endOf(editor.state.doc, 0));
      const file = Object.assign(new File([new Uint8Array([1])], "shot.png", { type: "image/png" }), { arrayBuffer: async () => new Uint8Array([1]).buffer });
      const clipboardData = { getData: () => "", files: [file], types: [] };
      editor.view.someProp("handlePaste", (f) => f(editor.view, Object.assign(new Event("paste"), { clipboardData }) as unknown as ClipboardEvent, editor.state.doc.slice(0, 0)));
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    await act(async () => { editor.view.someProp("handleKeyDown", (f) => f(editor.view, new KeyboardEvent("keydown", { key: "z", ctrlKey: true }))); });
    await act(async () => root?.unmount());
    root = null;
    await act(async () => { finish("![shot](shot.png)"); await new Promise((r) => setTimeout(r, 0)); });
    expect(fail).not.toHaveBeenCalled();
  });
});

describe("Codex review of ad6c5c5", () => {
  it("moves alignments when a column is added to a table with a merged header (R3-4)", async () => {
    const { editor, el } = await mount("| a | b | c |\n|:--|:-:|--:|\n| 1 | 2 | 3 |\n");
    // A header cell spanning two columns, as an HTML paste makes.
    const { schema } = editor;
    const cell = (type: "tableHeader" | "tableCell", text: string, colspan = 1) => schema.nodes[type].create({ colspan }, schema.nodes.paragraph.create(null, schema.text(text)));
    const old = editor.state.doc.child(0);
    const merged = schema.nodes.table.create(old.attrs, [
      schema.nodes.tableRow.create(null, [cell("tableHeader", "a", 2), cell("tableHeader", "c")]),
      schema.nodes.tableRow.create(null, [cell("tableCell", "1"), cell("tableCell", "2"), cell("tableCell", "3")]),
    ]);
    await act(async () => { editor.view.dispatch(editor.state.tr.replaceWith(0, old.nodeSize, merged)); });
    let last = -1;
    editor.state.doc.descendants((n, pos) => { if (n.isText && n.text === "3") last = pos; return true; });
    await act(async () => { editor.commands.setTextSelection(last); });
    await act(async () => { el.querySelector('[aria-label="Add column right"]')!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
    expect(editor.state.doc.child(0).attrs.align).toEqual(["left", "center", "right", null]);
  });
});
