// @vitest-environment jsdom
// NS-3D: embeds pasted as HTML (copied from another page, or from a web page that imitates one). An embed carries its
// attributes as JSON in `data-attrs`, so what comes in is untrusted: a path that climbs out of the notebook, or a number
// the rules refuse, must never reach the page, which would then reopen read-only.
import { Editor } from "@tiptap/core";
import { DOMSerializer } from "@tiptap/pm/model";
import { afterEach, describe, expect, it } from "vitest";
import { hmdocExtensions, hmdocSchema } from "../schema";
import { readContent } from "../validate";

Range.prototype.getClientRects = function () { return [] as unknown as DOMRectList; };
Range.prototype.getBoundingClientRect = function () { return new DOMRect(); };

const editors: Editor[] = [];
function make() {
  const el = document.createElement("div");
  document.body.append(el);
  const editor = new Editor({ element: el, extensions: hmdocExtensions(), content: { type: "doc", content: [{ type: "paragraph" }] } as never });
  editors.push(editor);
  return editor;
}
afterEach(() => { editors.splice(0).forEach((e) => e.destroy()); document.body.innerHTML = ""; });

const paste = (editor: Editor, html: string) => {
  editor.commands.selectAll();
  editor.view.pasteHTML(html, Object.assign(new Event("paste"), { clipboardData: { getData: () => "", files: [] } }) as unknown as ClipboardEvent);
};
const embed = (type: string, attrs: Record<string, unknown>) => `<div data-rich="${type}" data-attrs='${JSON.stringify(attrs).replace(/'/g, "&#39;")}'></div>`;
const types = (editor: Editor) => { const out: string[] = []; editor.state.doc.forEach((n) => out.push(n.type.name)); return out; };
const verdict = (editor: Editor) => { const r = readContent(editor.state.doc.toJSON()); return r.ok ? "ok" : r.reason; };

describe("a pasted embed", () => {
  it("is kept when its attributes pass the rules", () => {
    const editor = make();
    paste(editor, embed("pdfPage", { file: "docs/Spec.pdf", page: 2, title: "" }) + embed("gallery", { images: ["a.png"], columns: 2, title: "" }));
    expect(types(editor)).toEqual(["pdfPage", "gallery"]);
    expect(verdict(editor)).toBe("ok");
  });

  it("is left out when a path climbs out of the notebook, is absolute, hidden or a Windows path", () => {
    for (const file of ["../Spec.pdf", "/Spec.pdf", "C:/Spec.pdf", ".git/Spec.pdf", "docs/../../Spec.pdf", "docs\\Spec.pdf"]) {
      const editor = make();
      paste(editor, `<p>before</p>${embed("pdfPage", { file, page: 1, title: "" })}<p>after</p>`);
      expect(types(editor), file).toEqual(["paragraph", "paragraph"]);
      expect(verdict(editor), file).toBe("ok");
    }
  });

  it("is left out when a number or a list is not what the rules take", () => {
    const editor = make();
    paste(editor, [
      embed("pdfPage", { file: "a.pdf", page: 0, title: "" }),
      embed("gallery", { images: [], columns: 3, title: "" }),
      embed("gallery", { images: ["a.png", "../b.png"], columns: 3, title: "" }),
      embed("excalidraw", { scene: "a.json", preview: "a.png", title: "" }),
      embed("codeRange", { file: "a.ts", from: 5, to: 2, sha256: "a".repeat(64), text: "x", language: "", title: "" }),
      embed("noteCard", { ref: "", title: "x" }),
      embed("diagram", { system: "Not A Slug", path: "d.svg", title: "" }),
    ].join(""));
    expect(types(editor).filter((t) => t !== "paragraph")).toEqual([]);
    expect(verdict(editor)).toBe("ok");
  });

  it("an embed copied inside the editor (its own HTML) pastes whole", () => {
    const schema = hmdocSchema();
    const node = schema.nodes.codeRange.create({ file: "a.ts", from: 1, to: 2, sha256: "a".repeat(64), text: "x\ny", language: "ts", title: "T" });
    const holder = document.createElement("div");
    holder.append(DOMSerializer.fromSchema(schema).serializeNode(node, { document }));
    const editor = make();
    paste(editor, holder.innerHTML);
    expect(types(editor)).toEqual(["codeRange"]);
    expect(editor.state.doc.firstChild!.attrs).toEqual(node.attrs);
  });

  it("a free-positioned block pasted keeps its frames, with numbers the rules take", () => {
    const editor = make();
    paste(editor, '<div data-freeform="240"><div data-frame="16,16,160,64,1"><p>kept</p></div><div data-frame="x,-4,0,2.5,y"><p>fixed</p></div></div>');
    expect(types(editor)).toEqual(["freeform"]);
    const frames: Record<string, unknown>[] = [];
    editor.state.doc.firstChild!.forEach((f) => frames.push(f.attrs));
    expect(frames[0]).toEqual({ x: 16, y: 16, w: 160, h: 64, z: 1 });
    // What the rules refuse is the default, so the page opens again.
    expect(frames[1]).toEqual({ x: 16, y: 16, w: 320, h: 96, z: 1 });
    expect(verdict(editor)).toBe("ok");
  });

  it("a free-positioned block pasted inside another's frame is left out", () => {
    const editor = make();
    paste(editor, '<div data-freeform="240"><div data-frame="16,16,160,64,1"><p>outer</p><div data-freeform="240"><div data-frame="0,0,50,50,1"><p>inner</p></div></div></div></div>');
    expect(types(editor)).toEqual(["freeform"]);
    expect(editor.state.doc.textContent).toBe("outer");
    expect(verdict(editor)).toBe("ok");
  });
});
