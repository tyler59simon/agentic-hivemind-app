// How a board draws one card (NS-7C): plain DOM, memoized, so panning and zooming (which move the whole world) and changes to
// other cards never draw it again. Every card reads what it needs from `BoardEnv`; its own props are the card, whether it is
// selected and whether it is being edited. A card never writes the board by itself: it asks `env.api`.
import { createContext, memo, useContext, useEffect, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { read as readNote } from "../../../lib/lm";
import { cardLines } from "../../hmdoc/blocks/embedViews";
import { isPicture } from "../../editor/rich/parse";
import type { RichContext } from "../../editor/rich/context";
import { PageView, type Pictures } from "../../notes/PageView";
import { colourOf, type CanvasNode } from "../model";

/** What a card asks of its board. */
export interface NodeApi {
  /** End an edit: `patch` is what the card now holds, or null to give the edit up. */
  finish(id: string, patch: Partial<CanvasNode> | null): void;
  follow(target: string, split: boolean): void;
  openFile(path: string): void;
  openUrl(url: string): void;
  openNote(ref: string): void;
}

export interface BoardEnv {
  readOnly: boolean;
  ctx: RichContext;
  pictures: Pictures;
  /** The notebook's files in lower case, to tell a file card whose file is gone; empty until the tree is known. */
  known: ReadonlySet<string>;
  api: NodeApi;
}

export const EnvContext = createContext<BoardEnv | null>(null);
const useEnv = () => useContext(EnvContext)!;

/** The prefix of the URL a link card stores for a Memory note. */
export const MEM_PREFIX = "hivemind:mem:";
export const memoryRef = (url: string | undefined): string | null => (url?.startsWith(MEM_PREFIX) && url.length > MEM_PREFIX.length ? url.slice(MEM_PREFIX.length) : null);
/** Whether a link may be opened in the system browser: the web and mail only, never another scheme. */
export const isWebUrl = (url: string) => /^(https?:|mailto:)/i.test(url.trim());

const baseName = (path: string) => path.split("/").pop() ?? path;
const PDF = /\.pdf$/i;

/** The classes and custom properties that draw a card's or edge's colour (App.css, `.canvas-c`). */
export function colourStyle(color: unknown): { className: string; style?: CSSProperties } {
  const c = colourOf(color);
  if (!c) return { className: "" };
  if (c.kind === "preset") return { className: `canvas-c canvas-c-${c.name}` };
  return { className: "canvas-c", style: { "--canvas-c": c.value, "--canvas-bg": `color-mix(in srgb, ${c.value} 18%, transparent)` } as CSSProperties };
}

/** An input that ends its edit on Enter or when it loses focus, and gives it up on Escape. */
function EditLine({ value, label, onDone, className }: { value: string; label: string; onDone: (value: string | null) => void; className?: string }) {
  return (
    <input className={className ?? "canvas-edit-line"} autoFocus defaultValue={value} aria-label={label}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={(e) => onDone(e.currentTarget.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") { e.preventDefault(); onDone(e.currentTarget.value); }
        else if (e.key === "Escape") { e.preventDefault(); onDone(null); }
      }} />
  );
}

function TextBody({ node, editing }: { node: CanvasNode; editing: boolean }) {
  const env = useEnv();
  const text = node.text ?? "";
  if (editing) {
    // Ctrl+Enter or leaving the card ends the edit; Escape gives it up. Keys typed here are the card's, not the board's.
    const keys = (e: KeyboardEvent<HTMLTextAreaElement>) => {
      e.stopPropagation();
      if (e.key === "Escape") { e.preventDefault(); env.api.finish(node.id, null); }
      else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); env.api.finish(node.id, { text: e.currentTarget.value }); }
    };
    return <textarea className="canvas-edit" autoFocus defaultValue={text} aria-label="Card text" onBlur={(e) => env.api.finish(node.id, { text: e.currentTarget.value })} onKeyDown={keys} />;
  }
  return <div className="canvas-text">{text.trim() ? <PageView text={text} tabId={`canvas-${node.id}`} onLink={env.api.follow} pictures={env.pictures} nested /> : <p className="muted">Double-click to write</p>}</div>;
}

function GroupBody({ node, editing }: { node: CanvasNode; editing: boolean }) {
  const env = useEnv();
  return (
    <div className="canvas-group-label">
      {editing ? <EditLine value={node.label ?? ""} label="Group label" onDone={(v) => env.api.finish(node.id, v === null ? null : { label: v || undefined })} />
        : <span>{node.label || (env.readOnly ? "" : "Group")}</span>}
    </div>
  );
}

function FileBody({ node }: { node: CanvasNode }) {
  const env = useEnv();
  const path = (node.file ?? "").replace(/\\/g, "/");
  const url = isPicture(path) ? env.ctx.notebook?.url(path) ?? null : null;
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  const gone = env.known.size > 0 && !env.known.has(path.toLowerCase());
  if (isPicture(path) && url && !failed) {
    // A picture loads through the notebook's `hmfile` grant, like the pictures of a page.
    return <img className="canvas-picture" src={url} alt={baseName(path)} loading="lazy" draggable={false} onError={() => setFailed(true)} />;
  }
  const kind = isPicture(path) ? "Picture" : PDF.test(path) ? "PDF" : "Page";
  return (
    <div className="canvas-file">
      <span className="canvas-kind muted">{kind}</span>
      <strong className="canvas-title">{baseName(path).replace(/\.(md|markdown|hmdoc)$/i, "")}</strong>
      <span className="muted small canvas-path">{path}{node.subpath ? ` ${node.subpath}` : ""}</span>
      {(gone || failed) && <span className="rich-missing small">{isPicture(path) && !gone ? "Picture not found" : "Not found in this notebook"}</span>}
    </div>
  );
}

function hostOf(url: string): string {
  try { return new URL(url).host || url; } catch { return url; }
}

/** A link card: its host and address, never the page. Opening it in the browser is a click on its button. */
function LinkBody({ node, editing }: { node: CanvasNode; editing: boolean }) {
  const env = useEnv();
  const url = node.url ?? "";
  if (editing) return <div className="canvas-link"><EditLine value={url} label="Link address" onDone={(v) => env.api.finish(node.id, v === null ? null : { url: v.trim() })} /></div>;
  return (
    <div className="canvas-link">
      <strong className="canvas-title">{hostOf(url) || "Link"}</strong>
      <span className="muted small canvas-path">{url || "Double-click to add an address"}</span>
      {!url ? null : isWebUrl(url)
        ? <button type="button" className="link canvas-open" title={`Open ${url} in your browser`} onClick={() => env.api.openUrl(url)}>Open in browser</button>
        : <span className="muted small">This address is not opened from here.</span>}
    </div>
  );
}

/** A Memory note placed on the board: a link card whose address is `hivemind:mem:<ref>`, drawn from the note (NS-3D's card). */
function MemoryBody({ reference }: { reference: string }) {
  const env = useEnv();
  const [note, setNote] = useState<{ title: string; kind: string; lines: string[] } | "missing" | null>(null);
  useEffect(() => {
    let gone = false;
    setNote(null);
    // A ref that starts with `-` would be an option to the command that reads the note, so it is never asked about.
    if (reference.trim().startsWith("-")) { setNote("missing"); return; }
    readNote(reference).then((n) => { if (!gone) setNote({ title: n.title, kind: `${n.type} · ${n.status}`, lines: cardLines(n.body) }); }, () => { if (!gone) setNote("missing"); });
    return () => { gone = true; };
  }, [reference]);
  return (
    <div className="canvas-memory">
      <button type="button" className="link canvas-title" title="Open this note" onClick={() => env.api.openNote(reference)}>{note && note !== "missing" ? note.title : reference}</button>
      {note === null && <span className="muted small">Loading…</span>}
      {note === "missing" && <span className="rich-missing small">This note is not available: Living Memory is not connected, or the note was removed.</span>}
      {note && note !== "missing" && <><span className="muted small">{note.kind}</span>{note.lines.map((l, i) => <p key={i} className="muted">{l}</p>)}</>}
    </div>
  );
}

/** A card of a type this board does not draw (a later version of the format): named, kept as it is. */
const UnknownBody = ({ node }: { node: CanvasNode }) => <div className="canvas-file"><span className="canvas-kind muted">{node.type}</span><span className="muted small">This kind of card is kept but not drawn here.</span></div>;

const CORNERS = ["nw", "ne", "sw", "se"] as const;
const SIDE_HANDLES = ["top", "right", "bottom", "left"] as const;

export interface NodeViewProps { node: CanvasNode; selected: boolean; editing: boolean; handles: boolean }

export const NodeView = memo(function NodeView({ node, selected, editing, handles }: NodeViewProps) {
  const env = useEnv();
  const { className, style } = colourStyle(node.color);
  let body: ReactNode;
  const mem = node.type === "link" ? memoryRef(node.url) : null;
  switch (node.type) {
    case "text": body = <TextBody node={node} editing={editing} />; break;
    case "file": body = <FileBody node={node} />; break;
    case "link": body = mem && !editing ? <MemoryBody reference={mem} /> : <LinkBody node={node} editing={editing} />; break;
    case "group": body = <GroupBody node={node} editing={editing} />; break;
    default: body = <UnknownBody node={node} />;
  }
  return (
    <div className={`canvas-node canvas-${node.type} ${className} ${selected ? "on" : ""}`} data-node-id={node.id}
      style={{ ...style, left: node.x, top: node.y, width: node.width, height: node.height }}>
      {body}
      {!env.readOnly && SIDE_HANDLES.map((s) => <span key={s} className={`canvas-handle canvas-handle-${s}`} data-handle={s} title="Drag to another card to join them" />)}
      {handles && !env.readOnly && CORNERS.map((c) => <span key={c} className={`canvas-corner canvas-corner-${c}`} data-resize={c} />)}
    </div>
  );
});
