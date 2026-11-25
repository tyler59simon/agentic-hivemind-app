// Lazy-loaded Draw.io (.drawio / .dio) visual board editor mirroring CanvasEditor's session & undo architecture.
import { useEffect, useMemo, useRef, useState } from "react";
import { joinsRun, type Run } from "../../lib/nudge";
import { DrawioBoard } from "./DrawioBoard";
import type { DrawioDoc } from "./model";
import { parseDrawio, writeDrawio, type ParsedDrawio } from "./xml";

export interface DrawioEditorProps {
  text: string;
  readOnly: boolean;
  fileName: string;
  onChange(text: string): void;
  onInvalid?(reason: string): void;
}

const DEPTH = 200;

export default function DrawioEditor(props: DrawioEditorProps) {
  const parsed = useMemo<ParsedDrawio>(() => parseDrawio(props.text), [props.text]);
  const latest = useRef(props);
  latest.current = props;
  const known = useRef(props.text);
  const past = useRef<string[]>([]);
  const future = useRef<string[]>([]);
  /** The last commit when it was a keyboard move or resize (see `joinsRun`). */
  const run = useRef<Run>(null);
  const [, bump] = useState(0);

  useEffect(() => {
    if (!parsed.ok) latest.current.onInvalid?.(parsed.reason);
  }, [parsed]);

  useEffect(() => {
    if (props.text === known.current) return;
    known.current = props.text;
    past.current = [];
    future.current = [];
    run.current = null;
    bump((n) => n + 1);
  }, [props.text]);

  if (!parsed.ok) return <div className="center muted">{parsed.reason}</div>;

  const give = (text: string) => {
    known.current = text;
    latest.current.onChange(text);
    bump((n) => n + 1);
  };

  const commit = (next: DrawioDoc, group?: string) => {
    const before = latest.current.text;
    const text = writeDrawio(next);
    if (text === before) return;
    if (!(joinsRun(run, group) && past.current.length > 0)) {
      past.current.push(before);
      if (past.current.length > DEPTH) past.current.shift();
    }
    future.current = [];
    give(text);
  };

  const undo = () => {
    run.current = null;
    const back = past.current.pop();
    if (back === undefined) return;
    future.current.push(latest.current.text);
    give(back);
  };

  const redo = () => {
    run.current = null;
    const again = future.current.pop();
    if (again === undefined) return;
    past.current.push(latest.current.text);
    give(again);
  };

  const synced = props.text === known.current;
  return (
    <div className="canvas-editor drawio-editor">
      <DrawioBoard
        doc={parsed.doc}
        readOnly={props.readOnly}
        fileName={props.fileName}
        onCommit={commit}
        onUndo={undo}
        onRedo={redo}
        canUndo={synced && past.current.length > 0}
        canRedo={synced && future.current.length > 0}
      />
    </div>
  );
}
