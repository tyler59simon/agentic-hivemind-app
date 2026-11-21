// @vitest-environment jsdom
// NS-3D UI pass: what a real mouse did to free-positioned blocks. A drag must always end in exactly one change to the
// document or in the style put back, and frames stay inside the block's width.
import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";
import { hmdocExtensions } from "../schema";
import { addFrame, canvasWidth, insertFreeform, setFrame } from "./freeform";
import { blockHeight, MIN_FRAME_W, moved, newFrame, resized } from "./layout";

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

const p = () => ({ type: "paragraph" });
const frame = (x: number, y: number, w: number, h: number, z: number) => ({ type: "frame", attrs: { x, y, w, h, z }, content: [p()] });
const doc = (...blocks: unknown[]) => ({ type: "doc", content: blocks });
const free = (height: number, ...frames: unknown[]) => ({ type: "freeform", attrs: { height }, content: frames });
const framesOf = (editor: Editor) => { const out: Record<string, number>[] = []; editor.state.doc.firstChild!.forEach((f) => out.push({ ...f.attrs })); return out; };
const heightOf = (editor: Editor) => editor.state.doc.firstChild!.attrs.height;
const FRAME = 1;

const point = (type: string, x: number, y: number, extra: { pointerType?: string; buttons?: number } = {}) =>
  Object.assign(new MouseEvent(type, { clientX: x, clientY: y, button: 0, buttons: extra.buttons ?? (type === "pointerup" ? 0 : 1), bubbles: true }), { pointerId: 1, pointerType: extra.pointerType });
const handle = (editor: Editor, i: number) => editor.view.dom.querySelectorAll(".hm-frame-handle")[i] as HTMLElement;
const corner = (editor: Editor, i: number) => editor.view.dom.querySelectorAll(".hm-frame-corner")[i] as HTMLElement;
const styleOf = (editor: Editor, i: number) => (editor.view.dom.querySelectorAll(".hm-frame")[i] as HTMLElement).style;
const twoFrames = () => make(doc(free(240, frame(120, 80, 320, 96, 1), frame(16, 184, 320, 96, 2))));
const changes = (editor: Editor) => { const n = { count: 0 }; editor.on("transaction", ({ transaction }) => { if (transaction.docChanged) n.count++; }); return n; };

describe("UI-1: a drag always ends in one change or a full revert", () => {
  it("a pointer let go somewhere else than on the handle still ends the drag in one change", () => {
    const editor = twoFrames();
    const n = changes(editor);
    handle(editor, 0).dispatchEvent(point("pointerdown", 300, 100));
    for (let i = 1; i <= 10; i++) handle(editor, 0).dispatchEvent(point("pointermove", 300 - i * 10.4, 100));
    expect(styleOf(editor, 0).left).toBe("16px");
    document.body.dispatchEvent(point("pointerup", 196, 100));
    expect(n.count).toBe(1);
    expect(framesOf(editor)[0]).toMatchObject({ x: 16, y: 80, w: 320, h: 96 });
    expect(styleOf(editor, 0).left).toBe("16px");
  });

  it("a drag whose end was never seen is given up when the next one starts, and does not follow it", () => {
    const editor = twoFrames();
    const n = changes(editor);
    handle(editor, 0).dispatchEvent(point("pointerdown", 300, 100));
    handle(editor, 0).dispatchEvent(point("pointermove", 200, 100));
    expect(styleOf(editor, 0).left).toBe("24px");
    // No pointerup. The next drag, on the other frame:
    corner(editor, 1).dispatchEvent(point("pointerdown", 400, 300));
    expect(styleOf(editor, 0).left).toBe("120px");
    corner(editor, 1).dispatchEvent(point("pointermove", 442, 342));
    corner(editor, 1).dispatchEvent(point("pointerup", 442, 342));
    expect(n.count).toBe(1);
    expect(framesOf(editor)[0]).toMatchObject({ x: 120, y: 80 });
    expect(framesOf(editor)[1]).toMatchObject({ x: 16, y: 184, w: 360, h: 136 });
    expect(styleOf(editor, 0).left).toBe("120px");
    expect(styleOf(editor, 1).width).toBe("360px");
  });

  it("a button let go outside the window ends the drag: the next move with no button is the end", () => {
    const editor = twoFrames();
    const n = changes(editor);
    handle(editor, 0).dispatchEvent(point("pointerdown", 300, 100));
    handle(editor, 0).dispatchEvent(point("pointermove", 196, 100));
    window.dispatchEvent(point("pointermove", 100, 100, { pointerType: "mouse", buttons: 0 }));
    expect(n.count).toBe(1);
    expect(framesOf(editor)[0].x).toBe(16);
    // A later move changes nothing.
    window.dispatchEvent(point("pointermove", 10, 10, { pointerType: "mouse", buttons: 1 }));
    expect(framesOf(editor)[0].x).toBe(16);
    expect(styleOf(editor, 0).left).toBe("16px");
  });

  it("a cancelled drag puts the style back", () => {
    const editor = twoFrames();
    handle(editor, 0).dispatchEvent(point("pointerdown", 300, 100));
    handle(editor, 0).dispatchEvent(point("pointermove", 200, 100));
    window.dispatchEvent(point("pointercancel", 200, 100));
    expect(styleOf(editor, 0).left).toBe("120px");
    expect(framesOf(editor)[0].x).toBe(120);
  });

  it("a frame that changed under the drag is not overwritten by it, and is drawn as the document has it", () => {
    const editor = twoFrames();
    handle(editor, 0).dispatchEvent(point("pointerdown", 300, 100));
    setFrame(editor, FRAME, { x: 200 });
    handle(editor, 0).dispatchEvent(point("pointermove", 196, 100));
    document.body.dispatchEvent(point("pointerup", 196, 100));
    expect(framesOf(editor)[0].x).toBe(200);
    expect(styleOf(editor, 0).left).toBe("200px");
  });

  it("a view drawn again in the middle of a drag does not lose it: the drag ends in the document", () => {
    const editor = twoFrames();
    const n = changes(editor);
    handle(editor, 0).dispatchEvent(point("pointerdown", 300, 100));
    handle(editor, 0).dispatchEvent(point("pointermove", 196, 100));
    // Every node view is made again, as when the page's picture grant arrives.
    const same = editor.state.doc.toJSON();
    editor.commands.setContent(same);
    n.count = 0;
    expect(handle(editor, 0).isConnected).toBe(true);
    handle(editor, 0).dispatchEvent(point("pointerup", 196, 100));
    expect(n.count).toBe(1);
    expect(framesOf(editor)[0].x).toBe(16);
    expect(styleOf(editor, 0).left).toBe("16px");
  });

  it("the sequence of the UI pass: insert, add a frame, move, move, resize", () => {
    const editor = make(doc(p()));
    insertFreeform(editor);
    addFrame(editor, 0);
    const n = changes(editor);
    handle(editor, 0).dispatchEvent(point("pointerdown", 0, 0));
    handle(editor, 0).dispatchEvent(point("pointermove", 100, 60));
    handle(editor, 0).dispatchEvent(point("pointerup", 100, 60));
    expect(framesOf(editor)[0]).toMatchObject({ x: 120, y: 80 });
    handle(editor, 0).dispatchEvent(point("pointerdown", 500, 200));
    for (let i = 1; i <= 10; i++) handle(editor, 0).dispatchEvent(point("pointermove", 500 - i * 10.4, 200));
    handle(editor, 0).dispatchEvent(point("pointerup", 396, 200));
    expect(framesOf(editor)[0]).toMatchObject({ x: 16, y: 80 });
    corner(editor, 1).dispatchEvent(point("pointerdown", 0, 0));
    corner(editor, 1).dispatchEvent(point("pointermove", 42, 42));
    corner(editor, 1).dispatchEvent(point("pointerup", 42, 42));
    expect(framesOf(editor)[1]).toMatchObject({ w: 360, h: 136 });
    expect(n.count).toBe(3);
    expect(styleOf(editor, 0).left).toBe("16px");
    expect(styleOf(editor, 1).width).toBe("360px");
  });
});

describe("UI-2: frames stay inside the block", () => {
  const canvasOf = (editor: Editor, width: number) => {
    const canvas = editor.view.dom.querySelector(".hm-freeform-canvas") as HTMLElement;
    Object.defineProperty(canvas, "clientWidth", { value: width, configurable: true });
  };

  it("a move stops at the canvas's right edge", () => {
    const editor = make(doc(free(240, frame(120, 80, 320, 96, 1))));
    canvasOf(editor, 460);
    handle(editor, 0).dispatchEvent(point("pointerdown", 0, 0));
    handle(editor, 0).dispatchEvent(point("pointermove", 300, 0));
    handle(editor, 0).dispatchEvent(point("pointerup", 300, 0));
    expect(framesOf(editor)[0].x).toBe(136);
    expect(framesOf(editor)[0].x + framesOf(editor)[0].w).toBeLessThanOrEqual(460);
  });

  it("a resize stops at the canvas's right edge", () => {
    const editor = make(doc(free(240, frame(120, 80, 200, 96, 1))));
    canvasOf(editor, 460);
    corner(editor, 0).dispatchEvent(point("pointerdown", 0, 0));
    corner(editor, 0).dispatchEvent(point("pointermove", 400, 0));
    corner(editor, 0).dispatchEvent(point("pointerup", 400, 0));
    expect(framesOf(editor)[0].w).toBe(336);
  });

  it("the arrow keys stop at the edge too", () => {
    const editor = make(doc(free(240, frame(130, 16, 320, 96, 1))));
    canvasOf(editor, 460);
    for (let i = 0; i < 5; i++) handle(editor, 0).dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    expect(framesOf(editor)[0].x).toBe(136);
  });

  it("a new frame is no wider than the canvas, and the block keeps 32 px below the lowest frame", () => {
    const editor = make(doc(free(240, frame(16, 16, 160, 200, 1))));
    canvasOf(editor, 200);
    addFrame(editor, 0);
    expect(framesOf(editor)[1]).toMatchObject({ x: 16, w: 184 });
    expect(heightOf(editor)).toBe(framesOf(editor)[1].y + framesOf(editor)[1].h + 32);
  });

  it("a frame wider than a narrow pane goes to its left edge instead of being stuck", () => {
    const editor = make(doc(free(240, frame(100, 16, 320, 96, 1))));
    canvasOf(editor, 300);
    handle(editor, 0).dispatchEvent(point("pointerdown", 0, 0));
    handle(editor, 0).dispatchEvent(point("pointermove", 8, 0));
    handle(editor, 0).dispatchEvent(point("pointerup", 8, 0));
    expect(framesOf(editor)[0].x).toBe(0);
  });

  it("the geometry: a move and a resize with the width known, a new frame, the margin", () => {
    const frameA = { x: 16, y: 16, w: 160, h: 64, z: 1 };
    expect(moved({ ...frameA, w: 320 }, 500, 0, 460).x).toBe(136);
    expect(moved({ ...frameA, w: 500 }, 40, 0, 460).x).toBe(0);
    expect(moved(frameA, 500, 0).x).toBe(520);
    expect(resized({ ...frameA, x: 120, w: 320 }, 300, 0, 460).w).toBe(336);
    expect(resized({ ...frameA, x: 440, w: 100 }, 300, 0, 460).w).toBe(MIN_FRAME_W);
    expect(newFrame([], 200)).toEqual({ x: 16, y: 16, w: 184, h: 96, z: 1 });
    expect(newFrame([], 470).w).toBe(320);
    expect(blockHeight([{ y: 300, h: 100 }])).toBe(432);
  });
});

describe("UI-8: a frame stopped at the edge is still on the 8 px grid", () => {
  const frameA = { x: 16, y: 16, w: 160, h: 64, z: 1 };
  it("a move is stopped at the largest multiple of 8 that fits", () => {
    // 470 - 360 = 110: not on the grid, so 104.
    expect(moved({ ...frameA, w: 360 }, 1000, 0, 470).x).toBe(104);
    expect(moved({ ...frameA, w: 360 }, 1000, 0, 470).x % 8).toBe(0);
  });

  it("a resize is stopped at the largest multiple of 8 that fits", () => {
    // 470 - 16 = 454: not on the grid, so 448.
    expect(resized({ ...frameA, w: 160 }, 1000, 0, 470).w).toBe(448);
  });

  it("a new frame's width is on the grid too", () => {
    expect(newFrame([], 205).w).toBe(184);
    expect(newFrame([], 205).w % 8).toBe(0);
  });

  it("through the editor: what is stored after dragging to the edge is on the grid", () => {
    const editor = make(doc(free(240, frame(16, 16, 360, 96, 1))));
    Object.defineProperty(editor.view.dom.querySelector(".hm-freeform-canvas"), "clientWidth", { value: 470, configurable: true });
    handle(editor, 0).dispatchEvent(point("pointerdown", 0, 0));
    handle(editor, 0).dispatchEvent(point("pointermove", 900, 0));
    handle(editor, 0).dispatchEvent(point("pointerup", 900, 0));
    expect(framesOf(editor)[0].x).toBe(104);
    corner(editor, 0).dispatchEvent(point("pointerdown", 0, 0));
    corner(editor, 0).dispatchEvent(point("pointermove", 900, 0));
    corner(editor, 0).dispatchEvent(point("pointerup", 900, 0));
    expect(framesOf(editor)[0].w).toBe(360);
  });
});

describe("UI-7: no scrollbar from a fraction of a pixel", () => {
  const boxOf = (width: number, client: number) => ({ getBoundingClientRect: () => ({ width }), clientWidth: client }) as unknown as Element;

  it("the width frames may use is the floor of the measured box, not the rounded client width", () => {
    // A pane 469.6 px wide: clientWidth rounds to 470, and a frame ending at 470 would overflow by 0.4 px.
    expect(canvasWidth(boxOf(469.6, 470))).toBe(469);
    expect(canvasWidth(boxOf(470, 470))).toBe(470);
  });

  it("falls back to the client width when the box is not measured, and to none without a canvas", () => {
    expect(canvasWidth(boxOf(0, 460))).toBe(460);
    expect(canvasWidth(boxOf(0, 0))).toBeUndefined();
    expect(canvasWidth(null)).toBeUndefined();
  });

  it("a frame dragged to the edge of a fractional canvas ends inside it", () => {
    const editor = make(doc(free(240, frame(16, 16, 360, 96, 1))));
    const canvas = editor.view.dom.querySelector(".hm-freeform-canvas") as HTMLElement;
    canvas.getBoundingClientRect = () => ({ width: 469.6 }) as DOMRect;
    Object.defineProperty(canvas, "clientWidth", { value: 470, configurable: true });
    handle(editor, 0).dispatchEvent(point("pointerdown", 0, 0));
    handle(editor, 0).dispatchEvent(point("pointermove", 900, 0));
    handle(editor, 0).dispatchEvent(point("pointerup", 900, 0));
    const f = framesOf(editor)[0];
    expect(f.x + f.w).toBeLessThanOrEqual(469.6);
    expect(f.x + f.w).toBe(464);
  });
});
