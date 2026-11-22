// The editor of a `.canvas` file (NS-7C), loaded lazily like the `.hmdoc` editor. The board is drawn from the document
// session's text and writes the whole file back through `onChange` after each gesture, so saving, drafts, history, the hash
// precondition and the changed-on-disk banner work as for every page. Opening or looking at a board never writes it.
//
// Undo and redo live here: each gesture is one entry holding the text before it, and an undo hands that text back to the
// session. Text that changed from outside (a reload, a merge, the source tab) empties both lists.
import { useEffect, useMemo, useRef, useState } from "react";
import type { RichContext } from "../editor/rich/context";
import type { Pictures } from "../notes/PageView";
import { CanvasBoard } from "./CanvasBoard";
import { parseCanvas, reuse, writeCanvas, type Canvas, type Parsed } from "./model";

export interface CanvasEditorProps {
  text: string;
  readOnly: boolean;
  onChange(text: string): void;
  ctx: RichContext;
  pictures: Pictures;
  /** The id of the board's notebook, for pages dragged onto it. */
  notebook: string;
  onOpenFile(path: string): void;
}

/** How many steps of undo a board keeps. */
const DEPTH = 200;

export default function CanvasEditor(props: CanvasEditorProps) {
  // The cards the new text has in common with the last are kept as the same objects, so a change draws only what it changed.
  const shown = useRef<Canvas | null>(null);
  const parsed = useMemo<Parsed>(() => {
    const p = parseCanvas(props.text);
    if (!p.ok) return p;
    const canvas = shown.current ? reuse(shown.current, p.canvas) : p.canvas;
    shown.current = canvas;
    return { ok: true, canvas };
  }, [props.text]);
  const latest = useRef(props);
  latest.current = props;
  /** The text this editor last wrote, or saw. Any other text came from outside. */
  const known = useRef(props.text);
  const past = useRef<string[]>([]);
  const future = useRef<string[]>([]);
  const [, bump] = useState(0);

  useEffect(() => {
    if (props.text === known.current) return;
    known.current = props.text;
    past.current = [];
    future.current = [];
    bump((n) => n + 1);
  }, [props.text]);

  if (!parsed.ok) return <div className="center muted">{parsed.reason}</div>;

  const give = (text: string) => { known.current = text; latest.current.onChange(text); bump((n) => n + 1); };
  const commit = (next: Canvas) => {
    const before = latest.current.text, text = writeCanvas(next);
    if (text === before) return;
    past.current.push(before);
    if (past.current.length > DEPTH) past.current.shift();
    future.current = [];
    give(text);
  };
  const undo = () => {
    const back = past.current.pop();
    if (back === undefined) return;
    future.current.push(latest.current.text);
    give(back);
  };
  const redo = () => {
    const again = future.current.pop();
    if (again === undefined) return;
    past.current.push(latest.current.text);
    give(again);
  };
  const synced = props.text === known.current;
  return (
    <div className="canvas-editor">
      <CanvasBoard canvas={parsed.canvas} readOnly={props.readOnly} ctx={props.ctx} pictures={props.pictures} notebook={props.notebook}
        onCommit={commit} onUndo={undo} onRedo={redo} canUndo={synced && past.current.length > 0} canRedo={synced && future.current.length > 0}
        onOpenFile={props.onOpenFile} />
    </div>
  );
}
