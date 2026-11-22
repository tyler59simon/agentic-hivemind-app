// The large file viewer (NS-6B): a file too big for the editor, or not text, shown a window of lines at a time. It opens at
// once and indexes in the background; lines, searches and the end of a growing log are asked of Rust as they are needed.
import { ArrowDown, ArrowUp, Copy } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FileRef } from "../../documents/keys";
import { bigfileLines, bigfileSearch, type BigHit, type BigLine } from "../../lib/bigfile";
import { classify } from "../../lib/errors";
import { toast } from "../../ui/toast";
import { ROW, useWindowed } from "./virtual";
import { useBigFile } from "./useBigFile";

/** Lines asked for at a time. */
const CHUNK = 100;
/** Chunks kept; the oldest go when there are more. */
const KEEP = 60;
/** The most lines Copy lines copies. */
const COPY_LIMIT = 20_000;

/** A JavaScript pattern for what the search box holds, to mark matches in the lines on screen; null when it is not valid. */
export function markPattern(pattern: string, regex: boolean, caseSensitive: boolean): RegExp | null {
  if (!pattern) return null;
  try {
    return new RegExp(regex ? pattern : pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), caseSensitive ? "gu" : "giu");
  } catch {
    return null;
  }
}

/** `text` split into plain and marked pieces. `current` is the match of the search's current hit. */
export function pieces(text: string, mark: RegExp | null, current?: { start: number; end: number }): { text: string; on: "" | "all" | "now" }[] {
  if (!mark) return [{ text, on: "" }];
  const out: { text: string; on: "" | "all" | "now" }[] = [];
  let at = 0;
  mark.lastIndex = 0;
  for (let m = mark.exec(text); m; m = mark.exec(text)) {
    if (m[0] === "") { mark.lastIndex++; continue; }
    if (m.index > at) out.push({ text: text.slice(at, m.index), on: "" });
    out.push({ text: m[0], on: current && m.index === current.start ? "now" : "all" });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push({ text: text.slice(at), on: "" });
  return out.length ? out : [{ text, on: "" }];
}

const size = (bytes: number) => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`);

export function BigFileView({ file }: { file: FileRef }) {
  const big = useBigFile(file);
  const rows = Math.max(big.lines, 0);
  const win = useWindowed(rows);
  const [, redraw] = useState(0);
  const chunks = useRef(new Map<number, BigLine[]>());
  const asked = useRef(new Set<number>());
  const [follow, setFollow] = useState(false);
  const [jump, setJump] = useState("");
  const [pattern, setPattern] = useState("");
  const [regex, setRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [hit, setHit] = useState<BigHit | null>(null);
  const [note, setNote] = useState("");
  const [searching, setSearching] = useState(false);
  const [sel, setSel] = useState<{ from: number; to: number } | null>(null);
  const search = useRef<HTMLInputElement>(null);

  // New lines at the end: the last chunk (or any that was short) may have more now.
  useEffect(() => {
    for (const [c, lines] of chunks.current) if (lines.length < CHUNK) { chunks.current.delete(c); asked.current.delete(c); }
    redraw((n) => n + 1);
  }, [big.lines, big.grew]);
  // What the open call gave is the first chunk.
  useEffect(() => {
    chunks.current.clear();
    asked.current.clear();
    if (big.first) chunks.current.set(0, big.first.lines.slice(0, CHUNK));
    setHit(null);
    setSel(null);
    redraw((n) => n + 1);
  }, [big.first]);
  // The file was truncated or replaced: nothing read before is the file any more.
  useEffect(() => {
    if (!big.resets) return;
    chunks.current.clear();
    asked.current.clear();
    setHit(null);
    setSel(null);
    redraw((n) => n + 1);
  }, [big.resets]);

  const { first, count } = win;
  useEffect(() => {
    if (!big.handle || rows === 0) return;
    const handle = big.handle;
    for (let c = Math.floor(first / CHUNK); c <= Math.floor((first + count) / CHUNK); c++) {
      if (chunks.current.has(c) || asked.current.has(c)) continue;
      asked.current.add(c);
      bigfileLines(handle, c * CHUNK, CHUNK).then((got) => {
        if (got.lines.length) chunks.current.set(c, got.lines);
        asked.current.delete(c);
        if (chunks.current.size > KEEP) {
          const farthest = [...chunks.current.keys()].sort((a, b) => Math.abs(b - c) - Math.abs(a - c))[0];
          if (farthest !== undefined) chunks.current.delete(farthest);
        }
        redraw((n) => n + 1);
      }, () => asked.current.delete(c));
    }
  }, [big.handle, first, count, rows, big.resets]);

  // Follow: stay at the end as the file grows.
  useEffect(() => { if (follow) win.toEnd(); }, [follow, big.lines, big.grew]); // eslint-disable-line react-hooks/exhaustive-deps
  const onScroll = () => {
    const el = win.scroller.ref.current;
    win.scroller.onScroll();
    // The user scrolling away from the end stops following; a scroll the code made does not.
    if (follow && el && Math.abs(el.scrollTop - win.moved.current) > 2 && el.scrollTop + el.clientHeight < win.space - 3 * ROW) setFollow(false);
  };

  const goTo = useCallback((line: number) => win.scrollTo(Math.max(0, line - 2)), [win]);
  const jumpTo = () => {
    const n = parseInt(jump.replace(/[,_\s]/g, ""), 10);
    if (Number.isNaN(n) || n < 1) { setNote("Type a line number"); return; }
    setFollow(false);
    setNote(n > rows ? `The file has ${rows.toLocaleString()} lines so far` : "");
    goTo(Math.min(n, rows) - 1);
  };

  const find = async (forward: boolean) => {
    if (!big.handle || !pattern) return;
    const mark = markPattern(pattern, regex, caseSensitive);
    if (regex && !mark) { setNote("This is not a valid pattern"); return; }
    setSearching(true);
    setNote("");
    try {
      // From the current match; else from the top of the view.
      const line = hit ? hit.line : win.first;
      const col = hit ? (forward ? hit.end : hit.start) : 0;
      const found = await bigfileSearch(big.handle, pattern, regex, caseSensitive, line, col, forward);
      if (found.cancelled) return;
      setHit(found.hit);
      if (found.hit) {
        setFollow(false);
        goTo(found.hit.line);
        setNote(`Line ${(found.hit.line + 1).toLocaleString()}${found.wrapped ? ` (went on from the ${forward ? "start" : "end"})` : ""}`);
      } else setNote("No matches");
    } catch (e) {
      setNote(classify(e).message);
    } finally {
      setSearching(false);
    }
  };

  const copyLines = async () => {
    if (!big.handle || !sel) return;
    const [from, to] = [Math.min(sel.from, sel.to), Math.max(sel.from, sel.to)];
    const wanted = Math.min(to - from + 1, COPY_LIMIT);
    const text: string[] = [];
    try {
      for (let at = from; at < from + wanted; at += 500) text.push(...(await bigfileLines(big.handle, at, Math.min(500, from + wanted - at))).lines.map((l) => l.text));
      await navigator.clipboard.writeText(text.join("\n"));
      toast(`Copied ${text.length.toLocaleString()} ${text.length === 1 ? "line" : "lines"}${wanted < to - from + 1 ? ` (the first ${COPY_LIMIT.toLocaleString()})` : ""}`);
    } catch (e) {
      toast(classify(e).message, "error");
    }
  };

  const mark = useMemo(() => markPattern(pattern, regex, caseSensitive), [pattern, regex, caseSensitive]);
  if (big.error) return <div className="center"><div className="card"><p className="error">{big.error}</p></div></div>;
  if (!big.handle) return <div className="center muted">Opening {file.path}…</div>;

  const shown: React.ReactNode[] = [];
  for (let n = first; n < first + count; n++) {
    const line = chunks.current.get(Math.floor(n / CHUNK))?.[n % CHUNK];
    const selected = sel && n >= Math.min(sel.from, sel.to) && n <= Math.max(sel.from, sel.to);
    shown.push(
      <div key={n} className={`bigfile-row${selected ? " selected" : ""}`} style={{ height: ROW }} data-line={n + 1}>
        <button className="bigfile-no" aria-label={`Select line ${n + 1}`} onClick={(e) => setSel(e.shiftKey && sel ? { from: sel.from, to: n } : { from: n, to: n })}>{(n + 1).toLocaleString()}</button>
        <span className="bigfile-text">
          {line
            ? pieces(line.text, mark, hit && hit.line === n ? hit : undefined).map((p, i) => (p.on ? <mark key={i} className={p.on === "now" ? "now" : ""}>{p.text}</mark> : <span key={i}>{p.text}</span>))
            : <span className="muted">…</span>}
          {line?.cut && <span className="muted"> … the line goes on</span>}
        </span>
      </div>,
    );
  }
  const percent = big.size ? Math.min(100, Math.floor((big.scanned / big.size) * 100)) : 100;
  return (
    <div className="bigfile-page">
      <div className="bigfile-bar" role="toolbar" aria-label="Large file tools">
        <input aria-label="Jump to line" className="bigfile-jump" inputMode="numeric" placeholder="Go to line" value={jump} onChange={(e) => setJump(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") jumpTo(); }} />
        <span className="power-sep" />
        <input ref={search} aria-label="Search" className="bigfile-find" placeholder="Search" value={pattern} onChange={(e) => { setPattern(e.target.value); setHit(null); }}
          onKeyDown={(e) => { if (e.key === "Enter") void find(!e.shiftKey); }} />
        <button className={`chip${regex ? " on" : ""}`} aria-pressed={regex} aria-label="Regular expression" title="Regular expression" onClick={() => { setRegex(!regex); setHit(null); }}>.*</button>
        <button className={`chip${caseSensitive ? " on" : ""}`} aria-pressed={caseSensitive} aria-label="Match case" title="Match case" onClick={() => { setCaseSensitive(!caseSensitive); setHit(null); }}>Aa</button>
        <button className="icon-button" aria-label="Previous match" title="Previous match (Shift+Enter)" disabled={!pattern || searching} onClick={() => void find(false)}><ArrowUp size="1.1em" aria-hidden /></button>
        <button className="icon-button" aria-label="Next match" title="Next match (Enter)" disabled={!pattern || searching} onClick={() => void find(true)}><ArrowDown size="1.1em" aria-hidden /></button>
        <span className="power-sep" />
        <button className={`chip${follow ? " on" : ""}`} aria-pressed={follow} aria-label="Follow" title="Stay at the end as the file grows" onClick={() => setFollow(!follow)}>Follow</button>
        <button className="icon-button" aria-label="Copy lines" title="Copy the selected lines (click a line number; Shift-click for a range)" disabled={!sel} onClick={() => void copyLines()}><Copy size="1.1em" aria-hidden /><span className="small">Copy lines</span></button>
        <span className="fill" />
        <span className="muted small" role="status">{note}</span>
      </div>
      {!big.indexed && (
        <div className="bigfile-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label="Indexing">
          <div style={{ width: `${percent}%` }} />
        </div>
      )}
      <div className="bigfile" ref={win.scroller.ref} onScroll={onScroll} tabIndex={0} aria-label="File lines" role="region"
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") { e.preventDefault(); search.current?.focus(); search.current?.select(); }
          else if (e.key === "F3") { e.preventDefault(); void find(!e.shiftKey); }
        }}>
        <div className="bigfile-space" style={{ height: win.space }}>
          <div className="bigfile-rows" style={{ transform: `translateY(${win.offset}px)` }}>{shown}</div>
        </div>
      </div>
      <div className="file-status" role="status">
        <span>{big.lines.toLocaleString()} {big.indexed ? "" : "so far "}{big.lines === 1 ? "line" : "lines"}</span>
        <span className="power-sep" />
        <span>{size(big.size)}</span>
        <span className="power-sep" />
        <span>{big.encoding}{big.bom ? " with BOM" : ""}</span>
        {big.binary && <><span className="power-sep" /><span>Not a text file: unreadable bytes are shown as dots</span></>}
        {!big.indexed && <><span className="power-sep" /><span>Indexing {percent}%</span></>}
        <span className="fill" />
        <span className="muted">Line {(first + 1).toLocaleString()}</span>
      </div>
    </div>
  );
}
