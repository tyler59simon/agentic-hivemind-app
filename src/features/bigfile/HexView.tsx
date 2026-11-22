// The hex view (NS-6B): any file as offset, hex bytes and a text column, read a window at a time. Jump to an offset, and
// search for bytes typed as hex or as text.
import { ArrowDown, ArrowUp } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { FileRef } from "../../documents/keys";
import { bigfileBytes, bigfileFindBytes, parseHex, parseOffset } from "../../lib/bigfile";
import { classify } from "../../lib/errors";
import { ROW, useWindowed } from "./virtual";
import { useBigFile } from "./useBigFile";

/** Bytes in a row. */
export const PER_ROW = 16;
/** Bytes asked for at a time, and the chunks kept. */
const CHUNK = 4096;
const KEEP = 40;

/** A byte as two hex digits. */
export const hex2 = (b: number) => b.toString(16).padStart(2, "0");
/** The text column's character for a byte: printable ASCII, else a dot. */
export const ascii = (b: number) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".");

export function HexView({ file }: { file: FileRef }) {
  const big = useBigFile(file);
  const rows = Math.ceil(big.size / PER_ROW);
  const win = useWindowed(rows);
  const [, redraw] = useState(0);
  const chunks = useRef(new Map<number, number[]>());
  const asked = useRef(new Set<number>());
  const [jump, setJump] = useState("");
  const [pattern, setPattern] = useState("");
  const [asText, setAsText] = useState(false);
  const [mark, setMark] = useState<{ from: number; len: number } | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  // A file that grew or was replaced has other bytes at its end, or everywhere.
  useEffect(() => {
    chunks.current.clear();
    asked.current.clear();
    setMark(null);
    redraw((n) => n + 1);
  }, [big.handle, big.grew, big.resets]);

  const { first, count } = win;
  const perChunk = CHUNK / PER_ROW;
  useEffect(() => {
    if (!big.handle || rows === 0) return;
    const handle = big.handle;
    for (let c = Math.floor(first / perChunk); c <= Math.floor((first + count) / perChunk); c++) {
      if (chunks.current.has(c) || asked.current.has(c)) continue;
      asked.current.add(c);
      bigfileBytes(handle, c * CHUNK, CHUNK).then((bytes) => {
        chunks.current.set(c, bytes);
        asked.current.delete(c);
        if (chunks.current.size > KEEP) {
          const farthest = [...chunks.current.keys()].sort((a, b) => Math.abs(b - c) - Math.abs(a - c))[0];
          if (farthest !== undefined) chunks.current.delete(farthest);
        }
        redraw((n) => n + 1);
      }, () => asked.current.delete(c));
    }
  }, [big.handle, first, count, rows, big.grew, big.resets, perChunk]);

  const goTo = (offset: number) => win.scrollTo(Math.max(0, Math.floor(offset / PER_ROW) - 2));
  const jumpTo = () => {
    const offset = parseOffset(jump);
    if (offset === null) { setNote("Type an offset: 0x1f40 or 8000"); return; }
    setNote(offset >= big.size ? `The file is ${big.size.toLocaleString()} bytes` : "");
    goTo(Math.min(offset, Math.max(0, big.size - 1)));
  };

  const find = async (forward: boolean) => {
    if (!big.handle || !pattern) return;
    const needle = asText ? [...new TextEncoder().encode(pattern)] : parseHex(pattern);
    if (!needle) { setNote("Type bytes as hex, such as de ad be ef"); return; }
    setBusy(true);
    setNote("");
    try {
      // From just after the current match (or before it, going back); else from the top of the view.
      const at = mark ? (forward ? mark.from + 1 : mark.from) : first * PER_ROW;
      const [found, wrapped] = await bigfileFindBytes(big.handle, needle, at, forward);
      if (found === null) { setMark(null); setNote("No matches"); return; }
      setMark({ from: found, len: needle.length });
      goTo(found);
      setNote(`Offset 0x${found.toString(16)}${wrapped ? ` (went on from the ${forward ? "start" : "end"})` : ""}`);
    } catch (e) {
      setNote(classify(e).message);
    } finally {
      setBusy(false);
    }
  };

  if (big.error) return <div className="center"><div className="card"><p className="error">{big.error}</p></div></div>;
  if (!big.handle) return <div className="center muted">Opening {file.path}…</div>;

  const width = big.size > 0xffffffff ? 12 : 8;
  const shown: React.ReactNode[] = [];
  for (let r = first; r < first + count; r++) {
    const offset = r * PER_ROW;
    const chunk = chunks.current.get(Math.floor(offset / CHUNK));
    const bytes = chunk ? chunk.slice(offset % CHUNK, (offset % CHUNK) + Math.min(PER_ROW, big.size - offset)) : null;
    const cells: React.ReactNode[] = [];
    const chars: React.ReactNode[] = [];
    for (let i = 0; i < PER_ROW; i++) {
      const at = offset + i;
      const b = bytes?.[i];
      const marked = mark && at >= mark.from && at < mark.from + mark.len;
      cells.push(<span key={i} className={`hex-byte${marked ? " now" : ""}${i === 7 ? " gap" : ""}`}>{b === undefined ? (bytes ? "  " : "··") : hex2(b)}</span>);
      chars.push(<span key={i} className={marked ? "now" : ""}>{b === undefined ? " " : ascii(b)}</span>);
    }
    shown.push(
      <div key={r} className="hex-row" style={{ height: ROW }} data-offset={offset}>
        <span className="hex-offset">{offset.toString(16).padStart(width, "0")}</span>
        <span className="hex-bytes">{cells}</span>
        <span className="hex-text">{chars}</span>
      </div>,
    );
  }
  return (
    <div className="bigfile-page">
      <div className="bigfile-bar" role="toolbar" aria-label="Hex view tools">
        <input aria-label="Jump to offset" className="bigfile-jump" placeholder="Go to offset" value={jump} onChange={(e) => setJump(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") jumpTo(); }} />
        <span className="power-sep" />
        <input aria-label="Search bytes" className="bigfile-find" placeholder={asText ? "Search text" : "Search bytes (de ad be ef)"} value={pattern}
          onChange={(e) => { setPattern(e.target.value); setMark(null); }} onKeyDown={(e) => { if (e.key === "Enter") void find(!e.shiftKey); }} />
        <button className={`chip${asText ? " on" : ""}`} aria-pressed={asText} aria-label="Search for text" title="Search for text instead of hex bytes" onClick={() => { setAsText(!asText); setMark(null); }}>Text</button>
        <button className="icon-button" aria-label="Previous match" title="Previous match (Shift+Enter)" disabled={!pattern || busy} onClick={() => void find(false)}><ArrowUp size="1.1em" aria-hidden /></button>
        <button className="icon-button" aria-label="Next match" title="Next match (Enter)" disabled={!pattern || busy} onClick={() => void find(true)}><ArrowDown size="1.1em" aria-hidden /></button>
        <span className="fill" />
        <span className="muted small" role="status">{note}</span>
      </div>
      <div className="bigfile hex" ref={win.scroller.ref} onScroll={win.scroller.onScroll} tabIndex={0} aria-label="File bytes" role="region">
        <div className="bigfile-space" style={{ height: win.space }}>
          <div className="bigfile-rows" style={{ transform: `translateY(${win.offset}px)` }}>{shown}</div>
        </div>
      </div>
      <div className="file-status" role="status">
        <span>{big.size.toLocaleString()} bytes</span>
        <span className="fill" />
        <span className="muted">Offset 0x{(first * PER_ROW).toString(16)}</span>
      </div>
    </div>
  );
}
