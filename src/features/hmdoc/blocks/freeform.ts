// Free-positioned blocks (NS-3D): a `freeform` block holds `frame` nodes `{ x, y, w, h, z }`, each holding normal blocks but
// no `freeform`. A frame moves by its handle and resizes by its corner, snapped to 8 px, and the block grows to fit its
// lowest frame. The stored `height` is what the block draws at; every change of a frame writes it again.
import { Node, type Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, TextSelection, type Transaction } from "@tiptap/pm/state";
import { blockHeight, frontZ, GRID, MIN_BLOCK_H, moved, newFrame, resized, type Frame } from "./layout";

const NUMBERS = ["x", "y", "w", "h", "z"] as const;

/** The width frames may use in a block's canvas, or undefined when it has none (not laid out). The layout width is
 *  fractional when the pane's is, and `clientWidth` rounds it up: a frame that fits the rounded width overflows the real one
 *  by a fraction of a pixel and the block shows a scrollbar, so the width is the floor of the measured box. */
export function canvasWidth(canvas: Element | null | undefined): number | undefined {
  if (!canvas) return undefined;
  const box = Math.floor(canvas.getBoundingClientRect().width);
  return box > 0 ? box : (canvas as HTMLElement).clientWidth || undefined;
}

/** Gives up the drag in progress, in whichever frame it is: only one drag can be going on, and a new one first lets go of
 *  one whose end was never seen. */
let giveUp: (() => void) | null = null;

/** A frame's attributes as a `Frame`. */
const frameOf = (node: PMNode): Frame => ({ x: node.attrs.x, y: node.attrs.y, w: node.attrs.w, h: node.attrs.h, z: node.attrs.z });

export const Freeform = Node.create({
  name: "freeform",
  group: "block",
  content: "frame+",
  defining: true,
  isolating: true,
  addAttributes: () => ({ height: { default: MIN_BLOCK_H, rendered: false } }),
  parseHTML: () => [{ tag: "div[data-freeform]", getAttrs: (el) => ({ height: Number((el as HTMLElement).dataset.freeform) }) }],
  renderHTML: ({ node }) => ["div", { "data-freeform": String(node.attrs.height), class: "hm-freeform" }, 0],
  addProseMirrorPlugins: () => [new Plugin({ filterTransaction: (tr) => !tr.docChanged || !putFreeformInFrame(tr) })],
  addNodeView() {
    return ({ node: first, getPos, editor }) => {
      let node = first;
      const dom = document.createElement("div");
      const bar = document.createElement("div");
      const add = document.createElement("button");
      const canvas = document.createElement("div");
      bar.className = "hm-freeform-bar";
      bar.contentEditable = "false";
      add.type = "button";
      add.textContent = "Add a frame";
      add.title = "Add a frame to this block";
      bar.append(add);
      canvas.className = "hm-freeform-canvas";
      dom.append(bar, canvas);
      const draw = () => {
        dom.className = `hm-freeform${editor.isEditable ? "" : " readonly"}`;
        dom.style.height = `${node.attrs.height}px`;
      };
      draw();
      add.addEventListener("mousedown", (e) => e.preventDefault());
      add.addEventListener("click", () => {
        const pos = typeof getPos === "function" ? getPos() : undefined;
        if (pos !== undefined && editor.isEditable) addFrame(editor, pos);
      });
      return {
        dom,
        contentDOM: canvas,
        update(next) {
          if (next.type !== node.type) return false;
          node = next;
          draw();
          return true;
        },
        stopEvent: (e) => bar.contains(e.target as globalThis.Node),
        ignoreMutation: (m) => !canvas.contains((m as MutationRecord).target),
      };
    };
  },
});

export const FrameBlock = Node.create({
  name: "frame",
  content: "block+",
  defining: true,
  isolating: true,
  addAttributes: () => ({
    x: { default: GRID * 2, rendered: false }, y: { default: GRID * 2, rendered: false },
    w: { default: 320, rendered: false }, h: { default: 96, rendered: false }, z: { default: 1, rendered: false },
  }),
  parseHTML: () => [{
    tag: "div[data-frame]",
    getAttrs: (el) => {
      const parts = ((el as HTMLElement).dataset.frame ?? "").split(",").map(Number);
      return Object.fromEntries(NUMBERS.map((k, i) => [k, parts[i]]));
    },
  }],
  renderHTML: ({ node }) => ["div", { "data-frame": NUMBERS.map((k) => node.attrs[k]).join(","), class: "hm-frame" }, 0],
  addNodeView() {
    return ({ node: first, getPos, editor }) => {
      let node = first;
      const dom = document.createElement("div");
      const handle = document.createElement("div");
      const remove = document.createElement("button");
      const content = document.createElement("div");
      const corner = document.createElement("div");
      handle.className = "hm-frame-handle";
      handle.contentEditable = "false";
      handle.tabIndex = 0;
      handle.setAttribute("role", "button");
      handle.setAttribute("aria-label", "Move this frame: drag it, or use the arrow keys (with Shift to resize)");
      handle.textContent = "⠿";
      remove.type = "button";
      remove.className = "hm-frame-remove";
      remove.textContent = "×";
      remove.title = "Remove this frame";
      remove.setAttribute("aria-label", "Remove this frame");
      handle.append(remove);
      content.className = "hm-frame-content";
      corner.className = "hm-frame-corner";
      corner.contentEditable = "false";
      corner.title = "Resize";
      dom.append(handle, content, corner);
      const show = (f: Frame) => {
        dom.style.left = `${f.x}px`;
        dom.style.top = `${f.y}px`;
        dom.style.width = `${f.w}px`;
        dom.style.height = `${f.h}px`;
        dom.style.zIndex = String(f.z);
      };
      const draw = () => {
        dom.className = `hm-frame${editor.isEditable ? "" : " readonly"}`;
        show(frameOf(node));
      };
      draw();
      const at = () => (typeof getPos === "function" ? getPos() : undefined);

      /** The width the frame may use: its block's canvas, when it has one (a block not laid out has none). */
      const widthOf = () => canvasWidth(dom.parentElement);

      // One drag is one change: the frame follows the pointer by its style, and the page changes when the pointer is let
      // go. The drag follows the window, not the handle, and starts from the frame as the document holds it, so a pointer
      // released elsewhere, a view drawn again meanwhile (the drag then ends in the document alone) or a drag that never ended cannot leave the frame drawn where the
      // document does not have it: every drag ends in one change to the document or in the style put back.
      let drag: { pointer: number; x: number; y: number; pos: number; from: Frame; now: Frame; size: boolean; width: number | undefined; stop: () => void } | null = null;
      const abandon = () => finish(false);
      const finish = (keep: boolean) => {
        const done = drag;
        if (!done) return;
        drag = null;
        done.stop();
        if (giveUp === abandon) giveUp = null;
        const current = editor.state.doc.nodeAt(done.pos);
        const intact = current?.type.name === "frame" && JSON.stringify(frameOf(current)) === JSON.stringify(done.from);
        if (keep && intact && JSON.stringify(done.now) !== JSON.stringify(done.from)) setFrame(editor, done.pos, done.now, true);
        // Whatever happened, the style is the document's again.
        draw();
      };
      const track = (el: HTMLElement, size: boolean) => {
        el.addEventListener("pointerdown", (e) => {
          if (!editor.isEditable || e.button !== 0 || (e.target as HTMLElement).closest(".hm-frame-remove")) return;
          const pos = at();
          const current = pos === undefined ? null : editor.state.doc.nodeAt(pos);
          if (pos === undefined || current?.type.name !== "frame") return;
          e.preventDefault();
          e.stopPropagation();
          // A drag whose end was never seen, in this frame or another, is given up before this one starts.
          giveUp?.();
          const from = frameOf(current);
          const pointer = e.pointerId;
          const onMove = (m: PointerEvent) => {
            if (!drag || m.pointerId !== pointer) return;
            // The button was let go outside the window: that is the end of the drag.
            if (m.buttons === 0 && m.pointerType === "mouse") { finish(true); return; }
            const dx = m.clientX - drag.x, dy = m.clientY - drag.y;
            drag.now = size ? resized(from, dx, dy, drag.width) : moved(from, dx, dy, drag.width);
            show(drag.now);
          };
          const onUp = (u: PointerEvent) => { if (u.pointerId === pointer) finish(true); };
          const onCancel = (u: PointerEvent) => { if (u.pointerId === pointer) finish(false); };
          const onBlur = () => finish(false);
          window.addEventListener("pointermove", onMove, true);
          window.addEventListener("pointerup", onUp, true);
          window.addEventListener("pointercancel", onCancel, true);
          window.addEventListener("blur", onBlur);
          const stop = () => {
            window.removeEventListener("pointermove", onMove, true);
            window.removeEventListener("pointerup", onUp, true);
            window.removeEventListener("pointercancel", onCancel, true);
            window.removeEventListener("blur", onBlur);
            try { el.releasePointerCapture?.(pointer); } catch { /* the capture was already gone */ }
          };
          giveUp = abandon;
          drag = { pointer, x: e.clientX, y: e.clientY, pos, from, now: from, size, width: widthOf(), stop };
          try { el.setPointerCapture?.(pointer); } catch { /* the window listeners carry the drag */ }
        });
      };
      track(handle, false);
      track(corner, true);
      handle.addEventListener("keydown", (e) => {
        const pos = at();
        const step = { ArrowLeft: [-GRID, 0], ArrowRight: [GRID, 0], ArrowUp: [0, -GRID], ArrowDown: [0, GRID] }[e.key];
        if (!step || pos === undefined || !editor.isEditable) return;
        e.preventDefault();
        const from = frameOf(node);
        setFrame(editor, pos, e.shiftKey ? resized(from, step[0], step[1], widthOf()) : moved(from, step[0], step[1], widthOf()), true);
      });
      remove.addEventListener("mousedown", (e) => e.preventDefault());
      remove.addEventListener("click", () => {
        const pos = at();
        if (pos !== undefined && editor.isEditable) removeFrame(editor, pos);
      });
      return {
        dom,
        contentDOM: content,
        update(next) {
          if (next.type !== node.type) return false;
          node = next;
          draw();
          return true;
        },
        stopEvent: (e) => handle.contains(e.target as globalThis.Node) || corner.contains(e.target as globalThis.Node),
        ignoreMutation: (m) => !content.contains((m as MutationRecord).target),
      };
    };
  },
});

/** The frame at `pos` with these attributes, and the block's height written again for the frames as they are then;
 *  `front` brings the frame in front of the others. One transaction, so Undo takes one step. */
export function setFrame(editor: Editor, pos: number, to: Partial<Frame>, front = false): boolean {
  const { doc } = editor.state;
  const frame = doc.nodeAt(pos);
  if (frame?.type.name !== "frame") return false;
  const $pos = doc.resolve(pos);
  const block = $pos.parent;
  if (block.type.name !== "freeform") return false;
  const index = $pos.index();
  const frames: Frame[] = [];
  block.forEach((f) => frames.push(frameOf(f)));
  const next = { ...frames[index], ...to };
  if (front) next.z = frontZ(next.z, frames.filter((_, i) => i !== index).map((f) => f.z));
  frames[index] = next;
  const tr = editor.state.tr.setNodeMarkup(pos, undefined, { ...frame.attrs, ...next });
  tr.setNodeMarkup($pos.before(), undefined, { ...block.attrs, height: blockHeight(frames) });
  editor.view.dispatch(tr);
  return true;
}

/** A frame after the last one of the block at `blockPos`, with an empty paragraph and the cursor in it. */
export function addFrame(editor: Editor, blockPos: number): boolean {
  const { doc, schema } = editor.state;
  const block = doc.nodeAt(blockPos);
  if (block?.type.name !== "freeform") return false;
  const frames: Frame[] = [];
  block.forEach((f) => frames.push(frameOf(f)));
  const canvas = (editor.view.nodeDOM(blockPos) as HTMLElement | null)?.querySelector?.(".hm-freeform-canvas");
  const next = newFrame(frames, canvasWidth(canvas));
  const at = blockPos + block.nodeSize - 1;
  const tr = editor.state.tr.insert(at, schema.nodes.frame.create(next, schema.nodes.paragraph.create()));
  tr.setNodeMarkup(blockPos, undefined, { ...block.attrs, height: blockHeight([...frames, next]) });
  // The cursor goes into the new frame's paragraph: frame, paragraph, text.
  tr.setSelection(TextSelection.near(tr.doc.resolve(at + 2)));
  editor.view.dispatch(tr.scrollIntoView());
  editor.commands.focus();
  return true;
}

/** The frame at `pos` goes; the last frame of a block takes the block with it. */
export function removeFrame(editor: Editor, pos: number): boolean {
  const { doc } = editor.state;
  const frame = doc.nodeAt(pos);
  const $pos = doc.resolve(pos);
  const block = $pos.parent;
  if (frame?.type.name !== "frame" || block.type.name !== "freeform") return false;
  const blockPos = $pos.before();
  if (block.childCount === 1) {
    editor.view.dispatch(editor.state.tr.delete(blockPos, blockPos + block.nodeSize));
    return true;
  }
  const rest: Frame[] = [];
  block.forEach((f, _o, i) => { if (i !== $pos.index()) rest.push(frameOf(f)); });
  const tr = editor.state.tr.delete(pos, pos + frame.nodeSize);
  tr.setNodeMarkup(blockPos, undefined, { ...block.attrs, height: blockHeight(rest) });
  editor.view.dispatch(tr);
  return true;
}

/** Whether the cursor is inside a frame, where no free-positioned block may go. */
export function inFrame(editor: Editor): boolean {
  const { $from } = editor.state.selection;
  for (let d = $from.depth; d > 0; d--) if ($from.node(d).type.name === "frame") return true;
  return false;
}

/** A free-positioned block with one frame in place of the empty paragraph holding the cursor, else after the block that
 *  holds it. Refused inside a frame. */
export function insertFreeform(editor: Editor): boolean {
  if (inFrame(editor)) return false;
  const { schema } = editor.state;
  const frame = newFrame([], canvasWidth(editor.view.dom));
  const node = schema.nodes.freeform.create({ height: blockHeight([frame]) }, [schema.nodes.frame.create(frame, schema.nodes.paragraph.create())]);
  const { $from } = editor.state.selection;
  const empty = $from.parent.type.name === "paragraph" && $from.parent.content.size === 0 && $from.depth >= 1;
  const tr = editor.state.tr;
  const pos = empty ? $from.before() : $from.after();
  if (empty) tr.replaceWith(pos, $from.after(), node);
  else tr.insert(pos, node);
  // The cursor goes into the first frame: freeform, frame, paragraph.
  tr.setSelection(TextSelection.near(tr.doc.resolve(pos + 3)));
  editor.view.dispatch(tr.scrollIntoView());
  editor.commands.focus();
  return true;
}

/** Whether this transaction left a free-positioned block inside a frame, in the ranges it changed. Checked on the changed
 *  ranges only, so typing in a long page does not walk the page. */
export function putFreeformInFrame(tr: Transaction): boolean {
  let found = false;
  tr.mapping.maps.forEach((map, i) => {
    const rest = tr.mapping.slice(i + 1);
    map.forEach((_a, _b, from, to) => {
      if (found) return;
      const start = rest.map(from, -1), end = rest.map(to, 1);
      tr.doc.nodesBetween(Math.max(0, start), Math.min(tr.doc.content.size, end), (node, pos) => {
        if (found) return false;
        if (node.type.name !== "freeform") return true;
        const $pos = tr.doc.resolve(pos);
        for (let d = $pos.depth; d > 0; d--) if ($pos.node(d).type.name === "frame") { found = true; return false; }
        return true;
      });
    });
  });
  return found;
}

/** Whether a node holds a free-positioned block (for a slice or a document read from a file). */
export function holdsFreeform(node: PMNode): boolean {
  let found = false;
  node.descendants((n) => { if (n.type.name === "freeform") found = true; return !found; });
  return found;
}
