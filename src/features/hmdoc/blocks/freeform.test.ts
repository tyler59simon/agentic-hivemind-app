// @vitest-environment jsdom
// NS-3D: free-positioned blocks in an editor: frames move and resize by their handle and corner, snapped to 8 px, one
// change (one Undo step) a gesture; the block grows to fit; a block never goes inside a frame.
import { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { afterEach, describe, expect, it } from "vitest";
import { hmdocExtensions } from "../schema";
import { addFrame, inFrame, insertFreeform, putFreeformInFrame, removeFrame, setFrame } from "./freeform";

Range.prototype.getClientRects = function () { return [] as unknown as DOMRectList; };
Range.prototype.getBoundingClientRect = function () { return new DOMRect(); };

const editors: Editor[] = [];
function make(content: unknown) {
  const el = document.createElement("div");
  document.body.append(el);
  const editor = new Editor({ element: el, extensions: hmdocExtensions(), content: content as never });
  editors.push(editor);
  return editor;
}
afterEach(() => { editors.splice(0).forEach((e) => e.destroy()); document.body.innerHTML = ""; });

const p = (text = "") => ({ type: "paragraph", content: text ? [{ type: "text", text }] : [] });
const frame = (x: number, y: number, w = 160, h = 64, z = 1, ...blocks: unknown[]) => ({ type: "frame", attrs: { x, y, w, h, z }, content: blocks.length ? blocks : [p("f")] });
const doc = (...blocks: unknown[]) => ({ type: "doc", content: blocks });
const free = (height: number, ...frames: unknown[]) => ({ type: "freeform", attrs: { height }, content: frames });
const framesOf = (editor: Editor) => { const out: Record<string, number>[] = []; editor.state.doc.firstChild!.forEach((f) => out.push({ ...f.attrs })); return out; };
const heightOf = (editor: Editor) => editor.state.doc.firstChild!.attrs.height;
/** Position of the first frame (the block opens at 0, the frame inside it at 1). */
const FRAME = 1;

describe("moving and resizing a frame", () => {
  it("setFrame writes the frame and the block's height in one transaction (one Undo step)", () => {
    const editor = make(doc(free(240, frame(16, 16))));
    let steps = 0;
    editor.on("transaction", ({ transaction }) => { if (transaction.docChanged) steps++; });
    expect(setFrame(editor, FRAME, { x: 40, y: 400 })).toBe(true);
    expect(steps).toBe(1);
    expect(framesOf(editor)[0]).toMatchObject({ x: 40, y: 400, w: 160, h: 64 });
    // The block grew to hold the frame, with its margin.
    expect(heightOf(editor)).toBe(400 + 64 + 16);
    // Moving it back up shrinks the block to its minimum.
    setFrame(editor, FRAME, { y: 16 });
    expect(heightOf(editor)).toBe(240);
  });

  it("one Undo takes back the frame and the block's height together", () => {
    const editor = make(doc(free(240, frame(16, 16))));
    setFrame(editor, FRAME, { y: 400 });
    expect(heightOf(editor)).toBe(480);
    editor.commands.undo();
    expect(framesOf(editor)[0].y).toBe(16);
    expect(heightOf(editor)).toBe(240);
  });

  it("brings the frame in front of the others when asked", () => {
    const editor = make(doc(free(240, frame(16, 16, 160, 64, 1), frame(100, 16, 160, 64, 3))));
    setFrame(editor, FRAME, { x: 24 }, true);
    expect(framesOf(editor).map((f) => f.z)).toEqual([4, 3]);
    // One already on top keeps its z.
    setFrame(editor, FRAME, { x: 32 }, true);
    expect(framesOf(editor).map((f) => f.z)).toEqual([4, 3]);
  });

  it("only acts on a frame of a block", () => {
    const editor = make(doc(p("text"), free(240, frame(16, 16))));
    expect(setFrame(editor, 0, { x: 8 })).toBe(false);
  });

  it("a frame is drawn at its stored place and size", () => {
    const editor = make(doc(free(300, frame(24, 40, 200, 80, 2))));
    const dom = editor.view.dom.querySelector(".hm-frame") as HTMLElement;
    expect([dom.style.left, dom.style.top, dom.style.width, dom.style.height, dom.style.zIndex]).toEqual(["24px", "40px", "200px", "80px", "2"]);
    expect((editor.view.dom.querySelector(".hm-freeform") as HTMLElement).style.height).toBe("300px");
  });

  it("dragging the handle moves the frame by the pointer, snapped to 8 px, and writes it when the pointer is let go", () => {
    const editor = make(doc(free(240, frame(16, 16))));
    const handle = editor.view.dom.querySelector(".hm-frame-handle") as HTMLElement;
    const dom = editor.view.dom.querySelector(".hm-frame") as HTMLElement;
    let steps = 0;
    editor.on("transaction", ({ transaction }) => { if (transaction.docChanged) steps++; });
    const fire = (type: string, x: number, y: number) => handle.dispatchEvent(Object.assign(new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true }), { pointerId: 1 }));
    fire("pointerdown", 100, 100);
    fire("pointermove", 113, 107);
    // While dragging the frame follows the pointer and the page is unchanged.
    expect(dom.style.left).toBe("32px");
    expect(dom.style.top).toBe("24px");
    expect(steps).toBe(0);
    fire("pointermove", 123, 131);
    fire("pointerup", 123, 131);
    expect(steps).toBe(1);
    expect(framesOf(editor)[0]).toMatchObject({ x: 40, y: 48, w: 160, h: 64 });
  });

  it("dragging the corner resizes it, never below the minimum", () => {
    const editor = make(doc(free(240, frame(16, 16))));
    const corner = editor.view.dom.querySelector(".hm-frame-corner") as HTMLElement;
    const fire = (type: string, x: number, y: number) => corner.dispatchEvent(Object.assign(new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true }), { pointerId: 2 }));
    fire("pointerdown", 0, 0);
    fire("pointermove", 45, 21);
    fire("pointerup", 45, 21);
    expect(framesOf(editor)[0]).toMatchObject({ w: 208, h: 88 });
    fire("pointerdown", 0, 0);
    fire("pointermove", -1000, -1000);
    fire("pointerup", -1000, -1000);
    expect(framesOf(editor)[0]).toMatchObject({ w: 64, h: 32 });
  });

  it("a drag that goes nowhere, or is cancelled, writes nothing", () => {
    const editor = make(doc(free(240, frame(16, 16))));
    const handle = editor.view.dom.querySelector(".hm-frame-handle") as HTMLElement;
    let steps = 0;
    editor.on("transaction", ({ transaction }) => { if (transaction.docChanged) steps++; });
    const fire = (type: string, x: number, y: number) => handle.dispatchEvent(Object.assign(new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true }), { pointerId: 3 }));
    fire("pointerdown", 10, 10);
    fire("pointermove", 12, 11);
    fire("pointerup", 12, 11);
    fire("pointerdown", 10, 10);
    fire("pointermove", 90, 90);
    fire("pointercancel", 90, 90);
    expect(steps).toBe(0);
    expect((editor.view.dom.querySelector(".hm-frame") as HTMLElement).style.left).toBe("16px");
  });

  it("a read-only page cannot be dragged", () => {
    const editor = make(doc(free(240, frame(16, 16))));
    editor.setEditable(false);
    const handle = editor.view.dom.querySelector(".hm-frame-handle") as HTMLElement;
    const fire = (type: string, x: number, y: number) => handle.dispatchEvent(Object.assign(new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true }), { pointerId: 4 }));
    fire("pointerdown", 0, 0);
    fire("pointermove", 80, 80);
    fire("pointerup", 80, 80);
    expect(framesOf(editor)[0]).toMatchObject({ x: 16, y: 16 });
  });

  it("the arrow keys on the handle move the frame by one grid step, with Shift they resize it", () => {
    const editor = make(doc(free(240, frame(16, 16))));
    const handle = editor.view.dom.querySelector(".hm-frame-handle") as HTMLElement;
    const key = (k: string, shift = false) => handle.dispatchEvent(new KeyboardEvent("keydown", { key: k, shiftKey: shift, bubbles: true, cancelable: true }));
    key("ArrowRight");
    key("ArrowDown");
    expect(framesOf(editor)[0]).toMatchObject({ x: 24, y: 24 });
    key("ArrowRight", true);
    expect(framesOf(editor)[0]).toMatchObject({ w: 168 });
    key("ArrowLeft");
    key("ArrowLeft");
    key("ArrowLeft");
    expect(framesOf(editor)[0].x).toBe(0);
  });
});

describe("adding and removing frames", () => {
  it("a new frame goes below the lowest, in front, holds a paragraph, and the block grows", () => {
    const editor = make(doc(free(240, frame(16, 16, 160, 200, 1))));
    expect(addFrame(editor, 0)).toBe(true);
    const frames = framesOf(editor);
    expect(frames).toHaveLength(2);
    expect(frames[1]).toMatchObject({ x: 16, y: 224, w: 320, h: 96, z: 2 });
    expect(heightOf(editor)).toBe(224 + 96 + 16);
    expect(editor.state.doc.firstChild!.child(1).firstChild!.type.name).toBe("paragraph");
    expect(editor.state.selection.$from.parent.type.name).toBe("paragraph");
    expect(inFrame(editor)).toBe(true);
  });

  it("the Add a frame button adds one", () => {
    const editor = make(doc(free(240, frame(16, 16))));
    (editor.view.dom.querySelector(".hm-freeform-bar button") as HTMLElement).click();
    expect(framesOf(editor)).toHaveLength(2);
  });

  it("removing a frame shrinks the block, and removing the last one removes the block", () => {
    const editor = make(doc(free(700, frame(16, 16), frame(16, 500, 160, 100)), p("after")));
    const second = FRAME + editor.state.doc.firstChild!.child(0).nodeSize;
    expect(removeFrame(editor, second)).toBe(true);
    expect(framesOf(editor)).toHaveLength(1);
    expect(heightOf(editor)).toBe(240);
    expect(removeFrame(editor, FRAME)).toBe(true);
    expect(editor.state.doc.childCount).toBe(1);
    expect(editor.state.doc.firstChild!.type.name).toBe("paragraph");
  });
});

describe("inserting a free-positioned block", () => {
  it("puts one frame with an empty paragraph in place of an empty paragraph, and the cursor in it", () => {
    const editor = make(doc(p()));
    expect(insertFreeform(editor)).toBe(true);
    expect(editor.state.doc.childCount).toBe(1);
    expect(editor.state.doc.firstChild!.type.name).toBe("freeform");
    expect(framesOf(editor)).toEqual([{ x: 16, y: 16, w: 320, h: 96, z: 1 }]);
    expect(heightOf(editor)).toBe(240);
    expect(inFrame(editor)).toBe(true);
  });

  it("goes after the block holding the cursor otherwise", () => {
    const editor = make(doc(p("text")));
    editor.commands.setTextSelection(2);
    insertFreeform(editor);
    expect(editor.state.doc.child(1).type.name).toBe("freeform");
  });

  it("is refused inside a frame", () => {
    const editor = make(doc(free(240, frame(16, 16))));
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 3)));
    expect(inFrame(editor)).toBe(true);
    expect(insertFreeform(editor)).toBe(false);
    expect(editor.state.doc.childCount).toBe(1);
  });
});

describe("no block inside a frame", () => {
  const inner = () => editorSchema().nodes.freeform.create({ height: 240 }, [editorSchema().nodes.frame.create({ x: 0, y: 0, w: 99, h: 99, z: 1 }, [editorSchema().nodes.paragraph.create()])]);
  const editorSchema = () => editors[0].state.schema;

  it("a transaction that puts one in a frame is refused, wherever it comes from", () => {
    const editor = make(doc(free(240, frame(16, 16))));
    const before = editor.state.doc;
    // At the end of the frame's content, directly in the frame.
    editor.view.dispatch(editor.state.tr.insert(editor.state.doc.firstChild!.child(0).nodeSize, inner()));
    expect(editor.state.doc.eq(before)).toBe(true);
    // In a column inside the frame.
    const nested = make(doc(free(240, frame(16, 16, 160, 64, 1, { type: "columns", content: [{ type: "column", content: [p("a")] }, { type: "column", content: [p("b")] }] }))));
    const target = (() => { let pos = -1; nested.state.doc.descendants((n, at) => { if (n.type.name === "column" && pos < 0) pos = at + 1; return true; }); return pos; })();
    const kept = nested.state.doc;
    nested.view.dispatch(nested.state.tr.insert(target, nested.state.schema.nodes.freeform.create({ height: 240 }, [nested.state.schema.nodes.frame.create({ x: 0, y: 0, w: 99, h: 99, z: 1 }, [nested.state.schema.nodes.paragraph.create()])])));
    expect(nested.state.doc.eq(kept)).toBe(true);
  });

  it("a block beside a frame, in a column of the page or after the block is allowed", () => {
    const editor = make(doc(free(240, frame(16, 16))));
    editor.view.dispatch(editor.state.tr.insert(editor.state.doc.content.size, inner()));
    expect(editor.state.doc.childCount).toBe(2);
  });

  it("the check looks at what the transaction changed", () => {
    const editor = make(doc(free(240, frame(16, 16)), p("x")));
    expect(putFreeformInFrame(editor.state.tr.insertText("y", editor.state.doc.content.size - 1))).toBe(false);
    expect(putFreeformInFrame(editor.state.tr.insert(editor.state.doc.firstChild!.child(0).nodeSize, inner()))).toBe(true);
  });
});
