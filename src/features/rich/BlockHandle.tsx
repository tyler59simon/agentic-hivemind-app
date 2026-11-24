// The block grip of the .hmdoc editor (moved out of NS-3B's Rich editor when Rich mode for Markdown was deleted, CON-19).
import type { Editor } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import { useEffect, useRef, useState } from "react";
import { moveTopBlock } from "./editing";


/** A grip beside the block under the pointer: drag it to move the block, click it to select the block. Pointer
 *  events, because Tauri's file drop handler keeps HTML drag and drop from reaching the page. */
export function BlockHandle({ editor, wrap }: { editor: Editor; wrap: React.RefObject<HTMLDivElement | null> }) {
  const [hover, setHover] = useState<{ index: number; top: number } | null>(null);
  const [drop, setDrop] = useState<number | null>(null);
  const drag = useRef<{ from: number; moved: boolean } | null>(null);

  const blocks = () => {
    const out: { index: number; rect: DOMRect }[] = [];
    let pos = 0;
    editor.state.doc.forEach((node, _o, index) => {
      const dom = editor.view.nodeDOM(pos);
      if (dom instanceof HTMLElement) out.push({ index, rect: dom.getBoundingClientRect() });
      pos += node.nodeSize;
    });
    return out;
  };
  const origin = () => wrap.current?.getBoundingClientRect() ?? new DOMRect();

  useEffect(() => {
    const dom = editor.view.dom;
    const move = (e: PointerEvent) => {
      if (drag.current) return;
      const hit = blocks().find((b) => e.clientY >= b.rect.top && e.clientY <= b.rect.bottom);
      setHover(hit ? { index: hit.index, top: hit.rect.top - origin().top } : null);
    };
    dom.addEventListener("pointermove", move);
    return () => dom.removeEventListener("pointermove", move);
  }, [editor]); // eslint-disable-line react-hooks/exhaustive-deps

  const target = (y: number) => {
    const list = blocks();
    const below = list.find((b) => y < b.rect.top + b.rect.height / 2);
    return below ? below.index : list.length;
  };

  if (!hover) return null;
  return (
    <>
      <button type="button" className="rich-grip" style={{ top: hover.top }} aria-label="Move block (drag), select block (click)" title="Drag to move, click to select (Alt+Shift+Up or Down moves too)"
        onPointerDown={(e) => {
          e.preventDefault();
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          drag.current = { from: hover.index, moved: false };
        }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          drag.current.moved = true;
          const to = target(e.clientY);
          const list = blocks();
          const rect = to < list.length ? list[to].rect : list[list.length - 1]?.rect;
          if (rect) setDrop((to < list.length ? rect.top : rect.bottom) - origin().top);
        }}
        onPointerUp={(e) => {
          const d = drag.current;
          drag.current = null;
          setDrop(null);
          if (!d) return;
          if (!d.moved) {
            let pos = 0;
            for (let i = 0; i < d.from; i++) pos += editor.state.doc.child(i).nodeSize;
            editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, pos)));
            editor.commands.focus();
            return;
          }
          moveTopBlock(editor.view, d.from, target(e.clientY));
          editor.commands.focus();
        }}
        onPointerCancel={() => { drag.current = null; setDrop(null); }}>
        ⋮⋮
      </button>
      {drop !== null && <div className="rich-drop-line" style={{ top: drop }} />}
    </>
  );
}
