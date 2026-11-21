// @vitest-environment jsdom
// NS-3C: HTML pasted into a rich page. Tiptap reads attributes that have no parse rule from the element, so pasted HTML
// can hold values the file format refuses; the page would then reopen read-only. What the editor writes must always be a
// file the validator accepts.
import { Editor } from "@tiptap/core";
import { DOMSerializer } from "@tiptap/pm/model";
import { afterEach, describe, expect, it } from "vitest";
import { hmdocExtensions, hmdocSchema, attrsOf } from "./schema";
import { readContent } from "./validate";

Range.prototype.getClientRects = function () { return [] as unknown as DOMRectList; };
Range.prototype.getBoundingClientRect = function () { return new DOMRect(); };

const editors: Editor[] = [];
function make(content: unknown = { type: "doc", content: [{ type: "paragraph" }] }) {
  const el = document.createElement("div");
  document.body.append(el);
  const editor = new Editor({ element: el, extensions: hmdocExtensions(), content: content as never });
  editors.push(editor);
  return editor;
}
afterEach(() => { editors.splice(0).forEach((e) => e.destroy()); document.body.innerHTML = ""; });

const paste = (editor: Editor, html: string) => {
  editor.commands.selectAll();
  editor.view.pasteHTML(html, Object.assign(new Event("paste"), { clipboardData: { getData: () => "", files: [] } }) as unknown as ClipboardEvent);
};
/** The page's JSON as the file would hold it, and whether the validator accepts it. */
const verdict = (editor: Editor) => {
  const r = readContent(editor.state.doc.toJSON());
  return r.ok ? "ok" : r.reason;
};

describe("pasted HTML", () => {
  it("a table with an align attribute keeps the table, not the string", () => {
    const editor = make();
    paste(editor, '<table align="center"><tr><td>a</td></tr></table>');
    const table = editor.state.doc.firstChild!;
    expect(table.type.name).toBe("table");
    expect(table.attrs.align).toEqual([]);
    expect(table.textContent).toBe("a");
    expect(verdict(editor)).toBe("ok");
  });

  it("a table id from any id attribute is a string or nothing, and never a number", () => {
    for (const id of ["7", "", "plain"]) {
      const editor = make();
      paste(editor, `<table id="${id}"><tr><td>a</td></tr></table>`);
      expect(verdict(editor), id).toBe("ok");
      expect(typeof editor.state.doc.firstChild!.attrs.id).toBe("string");
    }
  });

  it("colours outside the palette become the default, or no text colour", () => {
    const editor = make();
    paste(editor, '<p><span data-text-color="#ff0000">a</span><span data-text-color="blue">b</span><mark data-color="teal">c</mark></p><table><tr><td data-bg="#fff">d</td></tr></table>');
    expect(verdict(editor)).toBe("ok");
    const marks = (i: number) => editor.state.doc.firstChild!.child(i).marks.map((m) => [m.type.name, m.attrs.color]);
    expect(marks(0)).toEqual([]);
    expect(marks(1)).toEqual([["textColor", "blue"]]);
    expect(marks(2)).toEqual([["highlight", "yellow"]]);
    expect(editor.state.doc.child(1).textContent).toBe("d");
  });

  it("a callout with a long icon, an ordered list that starts nowhere and a toggle with odd state are all accepted", () => {
    const editor = make();
    paste(editor, '<div data-callout="note, really" icon="a very long icon"><div data-callout-title>T</div><p>b</p></div><ol start="x"><li><p>i</p></li></ol>');
    expect(verdict(editor)).toBe("ok");
  });

  it("good values pass through unchanged", () => {
    const editor = make();
    paste(editor, '<p><span data-text-color="green">a</span></p><table><tr><th data-bg="pink" colspan="1">h</th></tr></table>');
    expect(editor.state.doc.firstChild!.firstChild!.marks[0].attrs.color).toBe("green");
    expect(editor.state.doc.child(1).firstChild!.firstChild!.attrs.background).toBe("pink");
  });
});

describe("every attribute of every node and mark", () => {
  const schema = hmdocSchema();
  const p = (...c: unknown[]) => ({ type: "paragraph", content: c });
  const t = (text: string, marks?: unknown[]) => ({ type: "text", text, ...(marks ? { marks } : {}) });
  const cell = (type: string, text: string) => ({ type, content: [p(t(text))] });
  /** A page that holds every node type and mark type of the schema. */
  const kitchen = {
    type: "doc", content: [
      { type: "heading", attrs: { level: 2 }, content: [t("H")] },
      p(t("b", [{ type: "bold" }]), t("i", [{ type: "italic" }]), t("s", [{ type: "strike" }]), t("c", [{ type: "code" }]), t("l", [{ type: "link", attrs: { href: "https://x.y", title: "t" } }]),
        t("h", [{ type: "highlight", attrs: { color: "blue" } }]), t("t", [{ type: "textColor", attrs: { color: "red" } }]), { type: "hardBreak" },
        { type: "image", attrs: { src: "a.png", alt: "a", title: "t" } }, { type: "mathInline", attrs: { value: "x", dollars: 1 } }, { type: "wikiLink", attrs: { value: "P" } },
        { type: "embed", attrs: { value: "P" } }, { type: "footnoteRef", attrs: { identifier: "1", label: "1" } }, { type: "rawInline", attrs: { value: "<b>", kind: "html" } }),
      { type: "blockquote", content: [p(t("q"))] },
      { type: "bulletList", content: [{ type: "listItem", content: [p(t("a"))] }, { type: "taskItem", attrs: { checked: true }, content: [p(t("b"))] }] },
      { type: "orderedList", attrs: { start: 3 }, content: [{ type: "listItem", content: [p(t("a"))] }] },
      { type: "codeBlock", attrs: { language: "js" }, content: [t("let a;")] },
      { type: "horizontalRule" },
      { type: "mathBlock", attrs: { value: "\nx\n", closed: true } },
      { type: "rawBlock", attrs: { value: "<div>", kind: "html" } },
      { type: "footnoteDef", attrs: { identifier: "1", label: "1" }, content: [p(t("f"))] },
      { type: "callout", attrs: { marker: "[!tip]-", icon: "★" }, content: [{ type: "calloutTitle", content: [t("T")] }, p(t("body"))] },
      { type: "toggle", attrs: { open: false }, content: [{ type: "toggleSummary", content: [t("S")] }, p(t("body"))] },
      { type: "columns", content: [{ type: "column", content: [p(t("l"))] }, { type: "column", content: [p(t("r"))] }] },
      { type: "table", attrs: { id: "t1", align: ["left", null] }, content: [
        { type: "tableRow", content: [cell("tableHeader", "a"), { type: "tableHeader", attrs: { colwidth: [100], background: "green" }, content: [p(t("b"))] }] },
        { type: "tableRow", content: [cell("tableCell", "c"), { type: "tableCell", attrs: { background: "red" }, content: [p(t("d"))] }] },
      ] },
    ],
  };

  it("the page used here holds every node type and mark type, and is a valid page", () => {
    const seen = new Set<string>();
    const walk = (n: { type: string; content?: unknown[]; marks?: { type: string }[] }) => { seen.add(n.type); n.marks?.forEach((m) => seen.add(`mark:${m.type}`)); (n.content as typeof n[] | undefined)?.forEach(walk); };
    walk(kitchen);
    const expected = [...Object.keys(schema.nodes), ...Object.keys(schema.marks).map((m) => `mark:${m}`)];
    expect(expected.filter((e) => !seen.has(e))).toEqual([]);
    const r = readContent(kitchen);
    expect(r.ok ? "ok" : r.reason).toBe("ok");
  });

  const names = [...new Set([...Object.values({ ...schema.nodes, ...schema.marks }).flatMap((t) => Object.keys(attrsOf(t)))])];
  const attributeNames = [...names, ...names.map((n) => `data-${n}`), "data-bg", "data-color", "data-text-color", "data-callout", "data-toggle", "data-checked", "data-colwidth", "start", "icon"];
  const hostile: unknown[] = ["center", "#ff0000", "0", "99999", "-1", "abc", "", "5", "true", "[1,2]", 5, [1, 2], {}, null, true];

  for (const value of hostile) {
    it(`HTML whose every attribute is ${JSON.stringify(value)} is pasted as a page the validator accepts`, () => {
      const holder = document.createElement("div");
      holder.append(DOMSerializer.fromSchema(schema).serializeFragment(schema.nodeFromJSON(kitchen).content, { document }));
      holder.querySelectorAll("*").forEach((el) => {
        const own = el.getAttribute("data-attrs");
        for (const name of attributeNames) el.setAttribute(name, String(value));
        // Atoms carry their attributes as JSON.
        if (own !== null) el.setAttribute("data-attrs", JSON.stringify(Object.fromEntries(names.map((n) => [n, value]))));
        if (el.hasAttribute("data-rich")) el.setAttribute("data-rich", el.getAttribute("data-rich")!);
      });
      const editor = make();
      paste(editor, holder.innerHTML);
      expect(verdict(editor)).toBe("ok");
    });
  }

  it("the same HTML as it was made is pasted whole", () => {
    const holder = document.createElement("div");
    holder.append(DOMSerializer.fromSchema(schema).serializeFragment(schema.nodeFromJSON(kitchen).content, { document }));
    const editor = make();
    paste(editor, holder.innerHTML);
    expect(verdict(editor)).toBe("ok");
    const types = new Set<string>();
    editor.state.doc.descendants((n) => { types.add(n.type.name); return true; });
    for (const kept of ["heading", "callout", "toggle", "columns", "table", "tableHeader", "orderedList", "taskItem", "mathBlock"]) expect(types.has(kept), kept).toBe(true);
  });
});
