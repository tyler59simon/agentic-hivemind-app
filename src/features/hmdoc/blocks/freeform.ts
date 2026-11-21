// Free-positioned blocks (NS-3D): a `freeform` block holds `frame` nodes `{ x, y, w, h, z }`, each holding normal blocks but
// no `freeform`. A frame moves by its handle and resizes by its corner, snapped to 8 px, and the block grows to fit its
// lowest frame. The stored `height` is what the block draws at; every change of a frame writes it again.
import { Node, type Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, TextSelection, type Transaction } from "@tiptap/pm/state";
import { blockHeight, frontZ, GRID, MIN_BLOCK_H, moved, newFrame, resized, type Frame } from "./layout";

const NUMBERS = ["x", "y", "w", "h", "z"] as const;

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

      // One drag is one change: the frame follows the pointer by its style, and the page changes when the pointer is let go.
      let drag: { pointer: number; x: number; y: number; from: Frame; now: Frame; size: boolean } | null = null;
      const track = (el: HTMLElement, size: boolean) => {
        el.addEventListener("pointerdown", (e) => {
          if (!editor.isEditable || e.button !== 0 || (e.target as HTMLElement).closest(".hm-frame-remove")) return;
          e.preventDefault();
          e.stopPropagation();
          const from = frameOf(node);
          drag = { pointer: e.pointerId, x: e.clientX, y: e.clientY, from, now: from, size };
          el.setPointerCapture?.(e.pointerId);
        });
        el.addEventListener("pointermove", (e) => {
          if (!drag || drag.pointer !== e.pointerId) return;
          const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
          drag.now = size ? resized(drag.from, dx, dy) : moved(drag.from, dx, dy);
          show(drag.now);
        });
        const end = (keep: boolean) => (e: PointerEvent) => {
          if (!drag || drag.pointer !== e.pointerId) return;
          const done = drag;
          drag = null;
          el.releasePointerCapture?.(e.pointerId);
          const pos = at();
          if (keep && pos !== undefined && JSON.stringify(done.now) !== JSON.stringify(done.from)) setFrame(editor, pos, done.now, true);
          else draw();
        };
        el.addEventListener("pointerup", end(true));
        el.addEventListener("pointercancel", end(false));
      };
      track(handle, false);
      track(corner, true);
      handle.addEventListener("keydown", (e) => {
        const pos = at();
        const step = { ArrowLeft: [-GRID, 0], ArrowRight: [GRID, 0], ArrowUp: [0, -GRID], ArrowDown: [0, GRID] }[e.key];
        if (!step || pos === undefined || !editor.isEditable) return;
        e.preventDefault();
        const from = frameOf(node);
        setFrame(editor, pos, e.shiftKey ? resized(from, step[0], step[1]) : moved(from, step[0], step[1]), true);
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
  const next = newFrame(frames);
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
  const frame = newFrame([]);
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
