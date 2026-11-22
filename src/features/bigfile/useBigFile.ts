// A file open in the large file viewer: opens the handle when a view mounts, keeps what the index reports, and closes the
// handle when the view goes (NS-6B).
import { useEffect, useState } from "react";
import type { FileRef } from "../../documents/keys";
import { bigfileClose, bigfileOpen, onBigfile, type BigLines, type BigProgress } from "../../lib/bigfile";

export interface BigFile {
  /** Null while opening, or when it could not be opened (`error`). */
  handle: string | null;
  error: string | null;
  size: number;
  encoding: string;
  bom: boolean;
  binary: boolean;
  /** Lines the index knows so far. */
  lines: number;
  /** Bytes indexed so far. */
  scanned: number;
  indexed: boolean;
  /** The first lines, as the open call gave them. */
  first: BigLines | null;
  /** Counts the times the file grew, and the times it was truncated or replaced. */
  grew: number;
  resets: number;
}

const EMPTY: BigFile = { handle: null, error: null, size: 0, encoding: "", bom: false, binary: false, lines: 0, scanned: 0, indexed: false, first: null, grew: 0, resets: 0 };

export function useBigFile(file: FileRef): BigFile {
  const [state, setState] = useState<BigFile>(EMPTY);
  useEffect(() => {
    let handle: string | null = null;
    let gone = false;
    let stop = () => {};
    setState(EMPTY);
    // Events can arrive before `bigfileOpen` returns, so they are matched to the handle once it is known.
    const early: { event: "progress" | "grew"; p: BigProgress }[] = [];
    const apply = (event: "progress" | "grew", p: BigProgress) =>
      setState((s) => ({
        ...s, size: p.size, lines: p.lines, scanned: p.scanned, indexed: p.done,
        ...(p.encoding === undefined ? {} : { encoding: p.encoding, bom: p.bom, binary: p.binary }),
        grew: s.grew + (event === "grew" ? 1 : 0), resets: s.resets + (p.reset ? 1 : 0),
      }));
    onBigfile((event, p) => {
      if (handle === null) early.push({ event, p });
      else if (p.handle === handle) apply(event, p);
    }).then((off) => { if (gone) off(); else stop = off; });
    bigfileOpen(file.notebook, file.path).then(
      (opened) => {
        if (gone) { void bigfileClose(opened.handle); return; }
        handle = opened.handle;
        setState({ ...EMPTY, handle, size: opened.size, encoding: opened.encoding, bom: opened.bom, binary: opened.binary, lines: opened.first.total, indexed: opened.first.indexed, first: opened.first });
        for (const e of early) if (e.p.handle === handle) apply(e.event, e.p);
      },
      (e) => { if (!gone) setState({ ...EMPTY, error: String(e) }); },
    );
    return () => {
      gone = true;
      stop();
      if (handle) void bigfileClose(handle);
    };
  }, [file.notebook, file.path]);
  return state;
}
