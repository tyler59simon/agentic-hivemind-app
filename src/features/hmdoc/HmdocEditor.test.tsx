// @vitest-environment jsdom
// NS-3C: the editor of a `.hmdoc` page. Opening writes nothing; an edit writes the whole file in the stable order; a file
// the editor cannot hold shows its reason instead; settings and view state are part of the file.
import type { Editor } from "@tiptap/core";
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
const { addColumn, insertColumns, removeColumn } = await import("./blocks/columns");
const { insertToggle } = await import("./blocks/toggle");
const { stringifyEnvelope } = await import("./envelope");
const { hmdocSchema } = await import("./schema");

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
const envelope = (content: unknown[], meta: Record<string, unknown> = {}) => ({ schemaVersion: 1, format: "hivemind-rich", meta, content: { type: "doc", content } });
const fileOf = (content: unknown[], meta: Record<string, unknown> = {}) => stringifyEnvelope(envelope(content, meta) as never);

async function mount(text: string, extra: { readOnly?: boolean; ctx?: RichContext; pictures?: string[] } = {}) {
  const changes: string[] = [];
  const onSave = vi.fn();
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  const invalid = vi.fn((reason: string): ReactNode => <div className="invalid">{reason}</div>);
  const render = async (t: string, version = 1, readOnly = extra.readOnly ?? false) => {
    await act(async () => root!.render(
      <HmdocEditor text={t} version={version} readOnly={readOnly} onChange={(x) => changes.push(x)} onSave={onSave} ctx={extra.ctx ?? context()} pictures={extra.pictures ?? []} invalid={invalid} />,
    ));
  };
  await render(text);
  const find = () => el.querySelector(".rich-doc") as (HTMLElement & { editor: Editor }) | null;
  return { el, changes, onSave, render, invalid, editor: () => find()!.editor, mounted: () => !!find() };
}

/** Where the text of top-level block `i` ends. */
function endOf(editor: Editor, i: number) {
  let pos = 0;
  for (let k = 0; k < i; k++) pos += editor.state.doc.child(k).nodeSize;
  return pos + editor.state.doc.child(i).nodeSize - 1;
}
const parsed = (text: string) => JSON.parse(text) as ReturnType<typeof envelope>;
const click = async (el: Element | null) => { await act(async () => { (el as HTMLElement).click(); }); };
const byText = (root: ParentNode, selector: string, text: string) => [...root.querySelectorAll(selector)].find((e) => e.textContent?.trim() === text) ?? null;

describe("opening a page", () => {
  it("shows the page and writes nothing, whatever order its keys are in", async () => {
    const shuffled = JSON.stringify({ content: { content: [p("Hello")], type: "doc" }, meta: { width: "wide" }, format: "hivemind-rich", schemaVersion: 1 });
    const { editor, changes, el } = await mount(shuffled);
    expect(changes).toEqual([]);
    expect(editor().state.doc.textContent).toBe("Hello");
    expect(el.querySelector(".hmdoc-editor")!.className).toContain("hmdoc-width-wide");
    await act(async () => { editor().commands.setTextSelection(3); editor().commands.selectAll(); });
    expect(changes).toEqual([]);
  });

  it("an edit writes the whole file in the stable order, and only the edit changes", async () => {
    const shuffled = JSON.stringify({ content: { content: [p("One"), p("Two")], type: "doc" }, meta: { title: "T" }, format: "hivemind-rich", schemaVersion: 1 });
    const { editor, changes } = await mount(shuffled);
    await act(async () => { editor().view.dispatch(editor().state.tr.insertText("!", endOf(editor(), 1))); });
    expect(changes).toHaveLength(1);
    const out = parsed(changes[0]);
    expect(out.content.content.map((b) => (b as { content: { text: string }[] }).content[0].text)).toEqual(["One", "Two!"]);
    expect(out.meta).toEqual({ title: "T" });
    expect(changes[0].startsWith('{\n  "content": {')).toBe(true);
    expect(changes[0].endsWith("}\n")).toBe(true);
    // The text reopens to the same text.
    const again = await mount(changes[0]);
    expect(again.changes).toEqual([]);
  });

  it("Undo gives the document back, and the file written for it", async () => {
    const text = fileOf([p("One")]);
    const { editor, changes } = await mount(text);
    await act(async () => { editor().view.dispatch(editor().state.tr.insertText("!", endOf(editor(), 0))); });
    await act(async () => { editor().commands.undo(); });
    expect(changes[changes.length - 1]).toBe(text);
  });

  it("tables read from the file get ids without writing, and the first edit saves them", async () => {
    const text = fileOf([{ type: "table", content: [{ type: "tableRow", content: [cell("a", "tableHeader")] }, { type: "tableRow", content: [cell("b")] }] }, p("x")]);
    const { editor, changes } = await mount(text);
    expect(changes).toEqual([]);
    const id = editor().state.doc.child(0).attrs.id;
    expect(id).toMatch(/^t/);
    await act(async () => { editor().view.dispatch(editor().state.tr.insertText("!", endOf(editor(), 1))); });
    expect((parsed(changes[0]).content.content[0] as { attrs: { id: string } }).attrs.id).toBe(id);
  });

  it("a file the editor cannot hold shows the reason instead, and loads no editor", async () => {
    const newer = JSON.stringify({ schemaVersion: 2, format: "hivemind-rich", meta: {}, content: { type: "doc", content: [] } });
    const m = await mount(newer);
    expect(m.mounted()).toBe(false);
    expect(m.el.querySelector(".invalid")!.textContent).toContain("Made by a newer Hivemind");
    const unknown = await mount(fileOf([{ type: "sparkline" }]));
    expect(unknown.el.querySelector(".invalid")!.textContent).toContain('unknown node "sparkline"');
  });

  it("text that changed elsewhere rebuilds the document, and a read-only page takes no edits", async () => {
    const m = await mount(fileOf([p("Before")]));
    await m.render(fileOf([p("After")], { title: "New" }), 2);
    expect(m.editor().state.doc.textContent).toBe("After");
    expect(m.changes).toEqual([]);
    await m.render(fileOf([p("After")], { title: "New" }), 2, true);
    expect(m.editor().isEditable).toBe(false);
    await m.render("{ broken", 3);
    expect(m.mounted()).toBe(false);
    expect(m.el.querySelector(".invalid")!.textContent).toContain("not valid JSON");
    await m.render(fileOf([p("Back")]), 4);
    expect(m.editor().state.doc.textContent).toBe("Back");
  });
});

describe("rich blocks", () => {
  it("colours: text colour and highlight colour are marks by palette name", async () => {
    const { editor, changes, el } = await mount(fileOf([p("colour me")]));
    await act(async () => { editor().commands.setTextSelection({ from: 1, to: 7 }); });
    await act(async () => { editor().chain().setMark("textColor", { color: "red" }).setMark("highlight", { color: "blue" }).run(); });
    const marks = (parsed(changes[changes.length - 1]).content.content[0] as { content: { marks: { type: string; attrs: { color: string } }[] }[] }).content[0].marks;
    expect(marks.map((m) => [m.type, m.attrs.color]).sort()).toEqual([["highlight", "blue"], ["textColor", "red"]]);
    expect(el.querySelector("span.hm-tc-red")!.textContent).toBe("colour");
    expect(el.querySelector("mark.hm-hl-blue")).toBeTruthy();
    expect(changes[changes.length - 1]).not.toMatch(/#[0-9a-f]{3,6}/i);
  });

  it("columns: two to four, with one added or removed at a time, and no content lost on removal", async () => {
    const { editor, changes } = await mount(fileOf([p("x")]));
    await act(async () => { insertColumns(editor(), 2); });
    const columns = () => editor().state.doc.firstChild!.type.name === "columns" ? editor().state.doc.firstChild! : editor().state.doc.child(1);
    expect(columns().childCount).toBe(2);
    await act(async () => { addColumn(editor()); addColumn(editor()); addColumn(editor()); });
    expect(columns().childCount).toBe(4);
    expect(addColumn(editor())).toBe(false);
    // Write in the third column, then remove it: its text joins the second.
    const starts = () => { const out: number[] = []; editor().state.doc.descendants((n, pos) => { if (n.type.name === "column") out.push(pos); return true; }); return out; };
    await act(async () => { editor().commands.setTextSelection(starts()[2] + 2); editor().commands.insertContent("kept"); });
    await act(async () => { removeColumn(editor()); });
    expect(columns().childCount).toBe(3);
    expect(columns().textContent).toContain("kept");
    await act(async () => { removeColumn(editor()); removeColumn(editor()); });
    expect(columns().childCount).toBe(2);
    expect(removeColumn(editor())).toBe(false);
    expect(changes.length).toBeGreaterThan(0);
    expect(hmdocSchema().nodeFromJSON(parsed(changes[changes.length - 1]).content).check()).toBeUndefined();
  });

  it("a toggle opens and closes from its caret, and the state is saved", async () => {
    const { editor, changes, el } = await mount(fileOf([p("x")]));
    await act(async () => { insertToggle(editor()); });
    const toggle = () => el.querySelector(".hm-toggle")!;
    expect(toggle().className).toContain("open");
    await click(toggle().querySelector(".hm-toggle-caret"));
    expect(toggle().className).toContain("closed");
    const saved = parsed(changes[changes.length - 1]).content.content as { type: string; attrs: { open: boolean } }[];
    expect(saved.find((b) => b.type === "toggle")!.attrs.open).toBe(false);
    await click(toggle().querySelector(".hm-toggle-caret"));
    expect(toggle().className).toContain("open");
  });

  it("a callout draws its own icon and offers a choice of icons", async () => {
    const callout = { type: "callout", attrs: { marker: "[!tip]", icon: "★" }, content: [{ type: "calloutTitle", content: [{ type: "text", text: "Hint" }] }, p("Body")] };
    const { editor, changes, el } = await mount(fileOf([callout]));
    expect(el.querySelector(".rich-callout-chip")!.textContent).toContain("★");
    const choice = byText(el, ".rich-callout-menu button", "⚑");
    expect(choice).toBeTruthy();
    await click(choice);
    expect((parsed(changes[changes.length - 1]).content.content[0] as { attrs: { icon: string } }).attrs.icon).toBe("⚑");
    await click(byText(el, ".rich-callout-menu button", "Type's own icon"));
    expect(editor().state.doc.firstChild!.attrs.icon).toBeNull();
  });
});

describe("page settings and table views", () => {
  it("the width and cover are part of the file, and the cover is drawn through the page's pictures", async () => {
    const ctx = context({ pictureUrl: (src, wiki) => (wiki && src === "assets/cover.png" ? "http://pictures/cover.png" : null) });
    const { el, changes } = await mount(fileOf([p("x")]), { ctx, pictures: ["assets/cover.png", "assets/other.png"] });
    expect(el.querySelector(".hmdoc-cover img")).toBeNull();
    await click(byText(el, "button", "Add a cover image"));
    const dialog = el.ownerDocument.querySelector('[role="dialog"][aria-label="Page settings"]')!;
    const select = (label: string) => dialog.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
    const choose = async (s: HTMLSelectElement, value: string) => {
      await act(async () => {
        const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
        set.call(s, value);
        s.dispatchEvent(new Event("change", { bubbles: true }));
      });
    };
    await choose(select("Page width"), "full");
    expect(parsed(changes[changes.length - 1]).meta).toEqual({ width: "full" });
    await choose(select("Cover image"), "assets/cover.png");
    expect(parsed(changes[changes.length - 1]).meta).toEqual({ width: "full", cover: "assets/cover.png" });
    expect(el.querySelector(".hmdoc-cover img")!.getAttribute("src")).toBe("http://pictures/cover.png");
    expect(el.querySelector(".hmdoc-editor")!.className).toContain("hmdoc-width-full");
    // Normal width and no cover are not written.
    await choose(select("Page width"), "normal");
    await choose(select("Cover image"), "");
    expect(parsed(changes[changes.length - 1]).meta).toEqual({});
  });

  it("a picture pasted on the cover strip becomes the cover through the page's attachments", async () => {
    const attachPath = vi.fn(async () => "assets/pasted.png");
    const { el, changes } = await mount(fileOf([p("x")]), { ctx: context({ attachPath }) });
    // jsdom has no File.arrayBuffer.
    const file = { name: "pasted.png", type: "image/png", arrayBuffer: async () => new ArrayBuffer(3) };
    const event = new Event("paste", { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown };
    event.clipboardData = { files: [file], getData: () => "" };
    await act(async () => { el.querySelector(".hmdoc-cover")!.dispatchEvent(event); await new Promise((r) => setTimeout(r, 0)); });
    expect(attachPath).toHaveBeenCalledOnce();
    expect(parsed(changes[changes.length - 1]).meta).toEqual({ cover: "assets/pasted.png" });
  });

  it("a table's sort is saved in the page's views, never in its rows, and cleared again", async () => {
    const table = { type: "table", attrs: { id: "t1" }, content: [
      { type: "tableRow", content: [cell("Name", "tableHeader"), cell("Qty", "tableHeader")] },
      { type: "tableRow", content: [cell("b"), cell("2")] }, { type: "tableRow", content: [cell("a"), cell("1")] },
    ] };
    const { editor, changes, el } = await mount(fileOf([table, p("after")]));
    // The cursor in the first body cell.
    let inside = 0;
    editor().state.doc.descendants((n, pos) => { if (!inside && n.type.name === "tableCell") inside = pos + 2; return true; });
    await act(async () => { editor().commands.setTextSelection(inside); });
    await click(el.querySelector('[aria-label="Table options"]'));
    await click(byText(el, '[role="menuitem"]', "Sort and filter…"));
    const dialog = el.ownerDocument.querySelector('[role="dialog"][aria-label="Sort and filter"]')!;
    const set = (label: string, value: string) => act(async () => {
      const s = dialog.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(s, value);
      s.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect([...dialog.querySelectorAll<HTMLOptionElement>('select[aria-label="Sort column"] option')].map((o) => o.textContent)).toEqual(["A (Name)", "B (Qty)"]);
    const rowsBefore = JSON.stringify(editor().state.doc.firstChild!.toJSON());
    await set("Sort column", "1");
    await set("Sort order", "asc");
    await click(byText(dialog, "button", "Apply"));
    const saved = parsed(changes[changes.length - 1]);
    expect(saved.meta).toEqual({ views: { t1: { sort: { column: 1, dir: "asc" } } } });
    expect(saved.content.content[0]).toEqual(editor().state.doc.firstChild!.toJSON());
    expect(JSON.stringify(editor().state.doc.firstChild!.toJSON())).toBe(rowsBefore);
    expect([...el.querySelectorAll(".hm-sorted tbody tr")].map((r) => r.textContent)).toEqual(["NameQty", "a1", "b2"]);
    // Clear it.
    await click(el.querySelector('[aria-label="Table options"]'));
    await click(byText(el, '[role="menuitem"]', "Sort and filter…"));
    const again = el.ownerDocument.querySelector('[role="dialog"][aria-label="Sort and filter"]')!;
    await click(byText(again, "button", "Clear sort and filter"));
    expect(parsed(changes[changes.length - 1]).meta).toEqual({});
    expect(el.querySelector(".hm-sorted")).toBeNull();
  });

  it("settings of a table that is gone are dropped from the file on the next write", async () => {
    const text = fileOf([p("x")], { views: { gone: { sort: { column: 0, dir: "asc" } } } });
    const { editor, changes } = await mount(text);
    expect(changes).toEqual([]);
    await act(async () => { editor().view.dispatch(editor().state.tr.insertText("!", endOf(editor(), 0))); });
    expect(parsed(changes[0]).meta).toEqual({});
  });
});

describe("Codex review of 9dda8ae", () => {
  const sortedPage = (cells: unknown[] = [cell("b"), cell("2")]) => fileOf([
    { type: "table", attrs: { id: "t1" }, content: [
      { type: "tableRow", content: [cell("Name", "tableHeader"), cell("Qty", "tableHeader")] },
      { type: "tableRow", content: cells }, { type: "tableRow", content: [cell("a"), cell("1")] },
    ] },
    p("after"),
  ], { views: { t1: { sort: { column: 1, dir: "asc" } } } });

  it("R1-1: text that changed without a new version (another pane typing) is read again, not taken from the old parse", async () => {
    const m = await mount(fileOf([p("A")]));
    await m.render(fileOf([p("B")]), 1);
    expect(m.editor().state.doc.textContent).toBe("B");
    expect(m.changes).toEqual([]);
    await act(async () => { m.editor().view.dispatch(m.editor().state.tr.insertText("!", endOf(m.editor(), 0))); });
    const written = parsed(m.changes[m.changes.length - 1]).content.content as { content: { text: string }[] }[];
    expect(written[0].content[0].text).toBe("B!");
    // And once more, as the other pane goes on typing.
    await m.render(fileOf([p("B!?")]), 1);
    expect(m.editor().state.doc.textContent).toBe("B!?");
  });

  it("R1-5: the sorted copy has its own Clear sort, which works with the selection outside the table", async () => {
    const m = await mount(sortedPage());
    expect(m.el.querySelector(".hm-sorted")).toBeTruthy();
    await act(async () => { m.editor().commands.setTextSelection(m.editor().state.doc.content.size - 2); });
    expect(m.editor().isActive("table")).toBe(false);
    await click(byText(m.el, ".hm-sorted-bar button", "Clear sort"));
    expect(m.el.querySelector(".hm-sorted")).toBeNull();
    expect(parsed(m.changes[m.changes.length - 1]).meta).toEqual({});
  });

  it("R1-5: Clear sort keeps the filter, and Sort and filter opens the dialog from the copy", async () => {
    const text = fileOf([{ type: "table", attrs: { id: "t1" }, content: [{ type: "tableRow", content: [cell("a", "tableHeader")] }, { type: "tableRow", content: [cell("x")] }] }, p("after")],
      { views: { t1: { sort: { column: 0, dir: "asc" }, filter: { column: 0, op: "filled", value: "" } } } });
    const m = await mount(text);
    await click(byText(m.el, ".hm-sorted-bar button", "Sort and filter…"));
    expect(m.el.ownerDocument.querySelector('[role="dialog"][aria-label="Sort and filter"]')).toBeTruthy();
    await click(byText(m.el.ownerDocument, '[role="dialog"] button', "Cancel"));
    await click(byText(m.el, ".hm-sorted-bar button", "Clear sort"));
    expect(parsed(m.changes[m.changes.length - 1]).meta).toEqual({ views: { t1: { filter: { column: 0, op: "filled", value: "" } } } });
  });

  it("R1-7: the dialog offers neither sort nor filter for a table with a cell that spans rows", async () => {
    const text = fileOf([{ type: "table", attrs: { id: "t1" }, content: [
      { type: "tableRow", content: [{ type: "tableCell", attrs: { rowspan: 2 }, content: [p("a")] }, cell("keep")] },
      { type: "tableRow", content: [cell("hide")] },
    ] }, p("after")], { views: { t1: { filter: { column: 1, op: "contains", value: "keep" } } } });
    const m = await mount(text);
    expect(m.el.querySelectorAll("tr.hm-row-hidden")).toHaveLength(0);
    let inside = 0;
    m.editor().state.doc.descendants((n, pos) => { if (!inside && n.type.name === "tableCell") inside = pos + 2; return true; });
    await act(async () => { m.editor().commands.setTextSelection(inside); });
    await click(m.el.querySelector('[aria-label="Table options"]'));
    await click(byText(m.el, '[role="menuitem"]', "Sort and filter…"));
    const dialog = m.el.ownerDocument.querySelector('[role="dialog"][aria-label="Sort and filter"]')!;
    expect(dialog.querySelector<HTMLSelectElement>('select[aria-label="Filter"]')!.disabled).toBe(true);
    expect(dialog.querySelector<HTMLSelectElement>('select[aria-label="Sort order"]')!.disabled).toBe(true);
    expect(dialog.textContent).toContain("Sorting and filtering are not available");
  });

  it("R1-8: the sort and filter dialog lists every column of the table, not the cells of its first row", async () => {
    const text = fileOf([{ type: "table", attrs: { id: "t1" }, content: [
      { type: "tableRow", content: [{ type: "tableHeader", attrs: { colspan: 2 }, content: [p("wide")] }, cell("c", "tableHeader")] },
      { type: "tableRow", content: [cell("1"), cell("2"), cell("3")] },
    ] }, p("after")], { views: { t1: { sort: { column: 2, dir: "asc" } } } });
    const m = await mount(text);
    await click(byText(m.el, ".hm-sorted-bar button", "Sort and filter…"));
    const dialog = m.el.ownerDocument.querySelector('[role="dialog"][aria-label="Sort and filter"]')!;
    expect([...dialog.querySelectorAll('select[aria-label="Sort column"] option')].map((o) => o.textContent)).toEqual(["A (wide)", "B", "C (c)"]);
  });

  it("R1-10: the sorted copy shows pictures and links as the page does, and cannot be edited", async () => {
    const ctx = context({ pictureUrl: (src) => (src === "a.png" ? "http://pictures/a.png" : null) });
    const rich = { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "image", attrs: { src: "a.png", alt: "cat", title: null } }, { type: "wikiLink", attrs: { value: "Other page" } }] }] };
    const m = await mount(sortedPage([rich, cell("2")]), { ctx });
    const copy = m.el.querySelector(".hm-sorted")!;
    expect(copy.querySelector(".rich-image img")!.getAttribute("src")).toBe("http://pictures/a.png");
    expect(copy.querySelector(".rich-wikilink")!.textContent).toBe("Other page");
    expect(copy.querySelector(".hm-copy")!.getAttribute("contenteditable")).toBe("false");
  });

  it("R1-11: a change that would take the written page past 5,000,000 characters is refused, and the page stays editable", async () => {
    const ctx = context();
    const text = fileOf([p("x".repeat(4_999_000))]);
    expect(text.length).toBeLessThan(5_000_000);
    const m = await mount(text, { ctx });
    const e = () => m.editor();
    await act(async () => { e().view.dispatch(e().state.tr.insertText("small", 3)); });
    expect(m.changes).toHaveLength(1);
    const before = e().state.doc;
    await act(async () => { e().view.dispatch(e().state.tr.insertText("y".repeat(2000), 3)); });
    expect(e().state.doc).toBe(before);
    expect(m.changes).toHaveLength(1);
    expect(ctx.fail).toHaveBeenCalledWith(expect.stringContaining("5,000,000"));
    expect(m.mounted()).toBe(true);
    // Still editable, and Undo still has its history.
    await act(async () => { e().view.dispatch(e().state.tr.insertText("!", 3)); });
    expect(m.changes).toHaveLength(2);
    await act(async () => { e().commands.undo(); e().commands.undo(); });
    expect(m.changes[m.changes.length - 1]).toBe(text);
  });

  it("R2-3: a refused change leaves the cursor where it was, not where the last accepted change left it", async () => {
    const ctx = context();
    const m = await mount(fileOf([p("x".repeat(4_999_000))]), { ctx });
    const e = () => m.editor();
    const original = e().state.doc;
    await act(async () => { e().view.dispatch(e().state.tr.insertText("small", 3)); });
    expect(m.changes).toHaveLength(1);
    expect(e().state.doc.eq(original)).toBe(false);
    // The cursor moves on with no edit, then a change that cannot be taken is made elsewhere.
    await act(async () => { e().commands.setTextSelection(1000); });
    expect(e().state.selection.from).toBe(1000);
    const before = e().state.doc;
    await act(async () => { e().view.dispatch(e().state.tr.insertText("y".repeat(2000), 500)); });
    expect(e().state.doc).toBe(before);
    expect(ctx.fail).toHaveBeenCalled();
    expect(e().state.selection.from).toBe(1000);
    // R3-3: the refused state is not kept as the one before.
    expect((e().storage as unknown as Record<string, { state: unknown }>).hmdocBeforeState.state).toBeNull();
    // Undo works as before: R3-4, the page is the one before the accepted change, not merely different text.
    await act(async () => { e().commands.undo(); });
    expect(e().state.doc.eq(original)).toBe(true);
  });

  it("R1-12: Markdown pasted as plain text is cleaned like pasted HTML", async () => {
    const sanitise = await import("./sanitise");
    const spy = vi.spyOn(sanitise, "sanitiseSlice");
    const m = await mount(fileOf([p("")]));
    const clipboardData = { getData: (t: string) => (t === "text/plain" ? "- one\n- two" : ""), files: [] };
    await act(async () => {
      const event = Object.assign(new Event("paste"), { clipboardData }) as unknown as ClipboardEvent;
      m.editor().view.someProp("handlePaste", (f) => f(m.editor().view, event, m.editor().state.doc.slice(0, 0)));
    });
    expect(spy).toHaveBeenCalled();
    expect(m.editor().state.doc.firstChild!.type.name).toBe("bulletList");
    spy.mockRestore();
  });

  it("R1-17: a cover that finishes attaching after the width changed does not bring the old width back", async () => {
    let finish: (path: string) => void = () => {};
    const attachPath = vi.fn(() => new Promise<string>((resolve) => { finish = resolve; }));
    const m = await mount(fileOf([p("x")]), { ctx: context({ attachPath }) });
    await click(byText(m.el, "button", "Add a cover image"));
    const dialog = m.el.ownerDocument.querySelector('[role="dialog"][aria-label="Page settings"]')!;
    const input = dialog.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = { name: "new.png", type: "image/png", arrayBuffer: async () => new ArrayBuffer(3) };
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
    const width = dialog.querySelector<HTMLSelectElement>('select[aria-label="Page width"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(width, "full");
      width.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(parsed(m.changes[m.changes.length - 1]).meta).toEqual({ width: "full" });
    await act(async () => { finish("assets/new.png"); await new Promise((r) => setTimeout(r, 0)); });
    expect(parsed(m.changes[m.changes.length - 1]).meta).toEqual({ width: "full", cover: "assets/new.png" });
  });
});

describe("UI pass of NS-3C", () => {
  const aligned = (views?: Record<string, unknown>) => fileOf([{ type: "table", attrs: { id: "t1", align: ["left", "right", "center"] }, content: [
    { type: "tableRow", content: [cell("a", "tableHeader"), cell("b", "tableHeader"), cell("c", "tableHeader")] },
    { type: "tableRow", content: [cell("1"), cell("2"), cell("3")] },
    { type: "tableRow", content: [cell("0"), cell("9"), cell("8")] },
  ] }, p("after")], views ? { views } : {});

  it("UI-1: the outline's request moves the cursor to the heading of that order and scrolls to it", async () => {
    const heading = (text: string) => ({ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text }] });
    const columns = { type: "columns", content: [{ type: "column", content: [heading("Second")] }, { type: "column", content: [p("x")] }] };
    const text = fileOf([heading("First"), p("body"), columns, heading("Third")]);
    const m = await mount(text);
    const withReveal = async (line: number, at: number) => {
      await act(async () => root!.render(
        <HmdocEditor text={text} version={1} readOnly={false} onChange={() => {}} onSave={() => {}} ctx={context()} pictures={[]} invalid={() => null} reveal={{ line, at }} />,
      ));
    };
    const headingAt = (n: number) => { let seen = -1, found = -1; m.editor().state.doc.descendants((node, pos) => { if (node.type.name === "heading" && ++seen === n) found = pos; return found < 0; }); return found; };
    // jsdom has no scrolling: the heading's element is asked to scroll to the middle, clear of the sticky toolbar.
    const scrolled: [Element, unknown][] = [];
    const original = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
    Element.prototype.scrollIntoView = function (this: Element, arg?: unknown) { scrolled.push([this, arg]); };
    try {
      await withReveal(2, 1);
      expect(m.editor().state.selection.from).toBe(headingAt(2) + 1);
      expect(scrolled).toEqual([[m.editor().view.nodeDOM(headingAt(2)), { block: "center" }]]);
      scrolled.length = 0;
      await withReveal(1, 2);
      expect(m.editor().state.selection.from).toBe(headingAt(1) + 1);
      expect(scrolled).toEqual([[m.editor().view.nodeDOM(headingAt(1)), { block: "center" }]]);
    } finally {
      if (original) Object.defineProperty(Element.prototype, "scrollIntoView", original); else delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
    expect(m.editor().state.selection.$from.parent.textContent).toBe("Second");
    expect(m.changes).toEqual([]);
  });

  it("UI-3: a table draws each column's alignment, and so does its sorted copy", async () => {
    const m = await mount(aligned());
    const cells = (root: ParentNode, row: number) => [...root.querySelectorAll("tr")[row].children].map((c) => c.className);
    expect(cells(m.el, 1).map((c) => /hm-align-(\w+)/.exec(c)?.[1])).toEqual(["left", "right", "center"]);
    expect(cells(m.el, 0).map((c) => /hm-align-(\w+)/.exec(c)?.[1])).toEqual(["left", "right", "center"]);
    await act(async () => root!.unmount());
    document.body.innerHTML = "";
    const sorted = await mount(aligned({ t1: { sort: { column: 1, dir: "asc" } } }));
    const copy = sorted.el.querySelector(".hm-sorted")!;
    expect([...copy.querySelectorAll("tbody tr")].map((r) => r.children[0].textContent)).toEqual(["a", "1", "0"]);
    expect([...copy.querySelectorAll("tbody tr")[1].children].map((c) => /hm-align-(\w+)/.exec(c.className)?.[1])).toEqual(["left", "right", "center"]);
  });

  it("UI-5: the sort and filter dialog says that sorting changes only how the table is shown", async () => {
    const m = await mount(aligned({ t1: { sort: { column: 1, dir: "asc" } } }));
    await click(byText(m.el, ".hm-sorted-bar button", "Sort and filter…"));
    const dialog = m.el.ownerDocument.querySelector('[role="dialog"][aria-label="Sort and filter"]')!;
    expect(dialog.textContent).toContain("Sorting and filtering change only how the table is shown. The rows keep their saved order, and the settings are saved with the page.");
    expect(dialog.textContent).not.toContain("never reordered");
  });
});
