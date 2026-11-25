// Native offline Draw.io interactive canvas board (zero iframes).
// Renders nested containers, shapes, embedded data:image SVG/PNG icons, arrows, waypoints, and multi-page tabs.
import { ArrowDownToLine, ArrowUpToLine, Download, Maximize2, Minus, Plus, Redo2, Trash2, Undo2 } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { classify } from "../../lib/errors";
import { nudgeOf } from "../../lib/nudge";
import { toast } from "../../ui/toast";
import { saveCopy } from "../notes/actions";
import { labelToPlainText, sanitizeDrawioLabel } from "./label";
import {
  absoluteRects, addEdge, addPage, addShape, deleteCells, deletePage, edgePoints, fitView, moveCells, polylineMidpoint,
  renamePage, reorderCells, resizeCell, setCellLabel, setCellStyle,
  type DrawioCell, type DrawioDoc, type DrawioPoint, type DrawioRect, type DrawioView, type NewShapePreset,
} from "./model";
import { parseStyle, type ParsedStyle } from "./style";

export interface DrawioBoardProps {
  doc: DrawioDoc;
  readOnly: boolean;
  fileName: string;
  /** The document after one gesture or edit. `group` names a run of the same keyboard move or resize, which the history folds into
   *  one step when the presses come close together. */
  onCommit(next: DrawioDoc, group?: string): void;
  onUndo(): void;
  onRedo(): void;
  canUndo: boolean;
  canRedo: boolean;
}

type Gesture =
  | { kind: "pan"; sx: number; sy: number; from: DrawioView }
  | { kind: "move"; sx: number; sy: number; ids: Set<string>; base: DrawioDoc; last: DrawioDoc | null }
  | { kind: "resize"; sx: number; sy: number; id: string; corner: string; base: DrawioDoc; last: DrawioDoc | null }
  | { kind: "link"; from: string };

const SWATCHES = ["#edf6ff", "#eaf6ec", "#fff3e6", "#f3e8ff", "#fef2f2", "#f8f9fa", "#ffffff"];
const STROKES = ["#438dd5", "#2e7d32", "#e65100", "#7c3aed", "#dc2626", "#5f6368", "#1f2937"];
const STEP = 1.25;
/** The first line of a cell's label as plain text, for its accessible name and the cells list. */
const cellName = (cell: DrawioCell) => {
  const line = labelToPlainText(cell.value, parseStyle(cell.style).html).split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
  return line.length > 80 ? `${line.slice(0, 80)}...` : line || "no label";
};
const clampK = (k: number) => Math.min(8, Math.max(0.1, k));

/** Draw the SVG shape body of a vertex cell inside its local `(0..w, 0..h)` box. */
function ShapeGraphic({ w, h, st }: { w: number; h: number; st: ParsedStyle }) {
  if (st.shape === "text" || st.shape === "group") return null;
  if (st.shape === "image") {
    return st.image
      ? <img className="drawio-icon-img" src={st.image} alt="" draggable={false} />
      : <div className="drawio-image-fallback">Image</div>;
  }
  const fill = st.fillColor ?? "#ffffff";
  const stroke = st.strokeColor ?? "#5f6368";
  const sw = st.strokeWidth;
  const dash = st.dashed ? "6 4" : undefined;
  const pad = sw;
  const iw = Math.max(1, w - pad * 2);
  const ih = Math.max(1, h - pad * 2);

  if (st.shape === "ellipse") {
    return (
      <svg className="drawio-shape-svg" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden>
        <ellipse cx={w / 2} cy={h / 2} rx={iw / 2} ry={ih / 2} fill={fill} stroke={stroke} strokeWidth={sw} strokeDasharray={dash} />
      </svg>
    );
  }
  if (st.shape === "diamond") {
    const pts = `${w / 2},${pad} ${w - pad},${h / 2} ${w / 2},${h - pad} ${pad},${h / 2}`;
    return (
      <svg className="drawio-shape-svg" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden>
        <polygon points={pts} fill={fill} stroke={stroke} strokeWidth={sw} strokeDasharray={dash} />
      </svg>
    );
  }
  if (st.shape === "hexagon") {
    const inset = Math.min(iw * 0.2, 24);
    const pts = `${pad + inset},${pad} ${w - pad - inset},${pad} ${w - pad},${h / 2} ${w - pad - inset},${h - pad} ${pad + inset},${h - pad} ${pad},${h / 2}`;
    return (
      <svg className="drawio-shape-svg" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden>
        <polygon points={pts} fill={fill} stroke={stroke} strokeWidth={sw} strokeDasharray={dash} />
      </svg>
    );
  }
  if (st.shape === "cylinder") {
    const ry = Math.min(14, ih * 0.16);
    const body = `M ${pad} ${pad + ry} L ${pad} ${h - pad - ry} A ${iw / 2} ${ry} 0 0 0 ${w - pad} ${h - pad - ry} L ${w - pad} ${pad + ry} A ${iw / 2} ${ry} 0 0 0 ${pad} ${pad + ry} Z`;
    const cap = `M ${pad} ${pad + ry} A ${iw / 2} ${ry} 0 0 0 ${w - pad} ${pad + ry}`;
    return (
      <svg className="drawio-shape-svg" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden>
        <path d={body} fill={fill} stroke={stroke} strokeWidth={sw} strokeDasharray={dash} />
        <path d={cap} fill="none" stroke={stroke} strokeWidth={sw} />
      </svg>
    );
  }
  if (st.shape === "cloud") {
    return (
      <svg className="drawio-shape-svg" width={w} height={h} viewBox="0 0 100 64" preserveAspectRatio="none" aria-hidden>
        <path d="M 25 54 H 78 C 89 54 96 46 96 36 C 96 27 89 20 80 19 C 78 9 68 3 56 4 C 46 5 38 11 35 19 C 28 16 19 20 17 28 C 9 29 4 35 4 42 C 4 49 12 54 25 54 Z"
          fill={fill} stroke={stroke} strokeWidth={sw} strokeDasharray={dash} vectorEffect="non-scaling-stroke" />
      </svg>
    );
  }
  const rx = st.shape === "rounded" ? Math.min(iw, ih) * (st.arcSize / 100) : 0;
  return (
    <svg className="drawio-shape-svg" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden>
      <rect x={pad} y={pad} width={iw} height={ih} rx={rx} ry={rx} fill={fill} stroke={stroke} strokeWidth={sw} strokeDasharray={dash} />
      {st.shape === "swimlane" && <line x1={pad} y1={Math.min(28, ih)} x2={w - pad} y2={Math.min(28, ih)} stroke={stroke} strokeWidth={sw} />}
    </svg>
  );
}

function arrowHeadPoints(from: DrawioPoint, to: DrawioPoint, size = 10): string {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const spread = 0.42;
  const x1 = to.x - size * Math.cos(angle - spread);
  const y1 = to.y - size * Math.sin(angle - spread);
  const x2 = to.x - size * Math.cos(angle + spread);
  const y2 = to.y - size * Math.sin(angle + spread);
  return `${to.x},${to.y} ${x1},${y1} ${x2},${y2}`;
}

/** Export the current page's vertices and edges as a standalone SVG string. */
function exportPageSvg(cells: DrawioCell[], rects: Map<string, DrawioRect>): string {
  const all = [...rects.values()];
  let minX = 0, minY = 0, maxX = 800, maxY = 500;
  if (all.length) {
    minX = Math.min(...all.map((r) => r.x)) - 24;
    minY = Math.min(...all.map((r) => r.y)) - 24;
    maxX = Math.max(...all.map((r) => r.x + r.width)) + 24;
    maxY = Math.max(...all.map((r) => r.y + r.height)) + 24;
  }
  const w = Math.max(100, Math.round(maxX - minX));
  const h = Math.max(100, Math.round(maxY - minY));
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const parts: string[] = [];
  for (const c of cells) {
    if (c.vertex) {
      const r = rects.get(c.id);
      if (!r) continue;
      const st = parseStyle(c.style);
      const x = r.x - minX, y = r.y - minY;
      if (st.shape !== "text" && st.shape !== "group" && st.shape !== "image") {
        const fill = st.fillColor ?? "#ffffff";
        const stroke = st.strokeColor ?? "#5f6368";
        const dash = st.dashed ? ' stroke-dasharray="6 4"' : "";
        const rx = st.shape === "rounded" ? Math.min(r.width, r.height) * (st.arcSize / 100) : 0;
        parts.push(`<rect x="${x}" y="${y}" width="${r.width}" height="${r.height}" rx="${rx}" fill="${esc(fill)}" stroke="${esc(stroke)}" stroke-width="${st.strokeWidth}"${dash} />`);
      } else if (st.shape === "image" && st.image) {
        parts.push(`<image x="${x}" y="${y}" width="${r.width}" height="${r.height}" href="${esc(st.image)}" />`);
      }
      const txt = labelToPlainText(c.value, st.html).trim();
      if (txt) {
        const tx = st.align === "left" ? x + 6 : st.align === "right" ? x + r.width - 6 : x + r.width / 2;
        const anchor = st.align === "left" ? "start" : st.align === "right" ? "end" : "middle";
        const lines = txt.split("\n");
        const startY = st.verticalAlign === "top" ? y + st.fontSize + 4 : y + r.height / 2 - ((lines.length - 1) * st.fontSize * 1.2) / 2 + st.fontSize * 0.35;
        lines.forEach((line, idx) => {
          parts.push(`<text x="${tx}" y="${startY + idx * st.fontSize * 1.2}" text-anchor="${anchor}" font-size="${st.fontSize}" font-family="${esc(st.fontFamily ?? "sans-serif")}" fill="${esc(st.fontColor ?? "#1f2937")}">${esc(line)}</text>`);
        });
      }
    } else if (c.edge) {
      const pts = edgePoints(c, rects);
      if (pts.length < 2) continue;
      const st = parseStyle(c.style);
      const stroke = st.strokeColor ?? "#526580";
      const dash = st.dashed ? ' stroke-dasharray="6 4"' : "";
      const poly = pts.map((p) => `${p.x - minX},${p.y - minY}`).join(" ");
      parts.push(`<polyline points="${poly}" fill="none" stroke="${esc(stroke)}" stroke-width="${st.strokeWidth}"${dash} />`);
      if (st.endArrow !== "none") {
        const a = pts[pts.length - 2], b = pts[pts.length - 1];
        const shifted = arrowHeadPoints({ x: a.x - minX, y: a.y - minY }, { x: b.x - minX, y: b.y - minY });
        parts.push(`<polygon points="${shifted}" fill="${esc(stroke)}" />`);
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#ffffff" />${parts.join("")}</svg>`;
}

/** Every shape of the page with the arrows that join it ("A to B: label"), and a form that joins two shapes: the way to read, pick
 *  and make connections without the drawing and without dragging from a handle to another shape (WCAG 2.5.7). */
function CellsPanel({ cells, readOnly, onPick, onConnect }: { cells: DrawioCell[]; readOnly: boolean; onPick(id: string): void; onConnect(from: string, to: string): void }) {
  const shapes = cells.filter((c) => c.vertex);
  const names = new Map(shapes.map((c) => [c.id, cellName(c)]));
  const arrows = cells.filter((c) => c.edge && c.source && c.target && names.has(c.source) && names.has(c.target));
  const sentence = (e: DrawioCell) => `${names.get(e.source!)} to ${names.get(e.target!)}${e.value ? `: ${labelToPlainText(e.value, parseStyle(e.style).html).trim()}` : ""}`;
  const [from, setFrom] = useState(""), [to, setTo] = useState("");
  const pick = (value: string, set: (v: string) => void, label: string) => (
    <label>{label}
      <select value={value} onChange={(e) => set(e.target.value)}>
        <option value="">Choose a shape</option>
        {shapes.map((c) => <option key={c.id} value={c.id}>{names.get(c.id)}</option>)}
      </select>
    </label>
  );
  return (
    <div className="canvas-panel" role="group" aria-label="Cells">
      {shapes.length
        ? (
          <ul>
            {shapes.map((c) => {
              const mine = arrows.filter((e) => e.source === c.id || e.target === c.id);
              return (
                <li key={c.id}>
                  <button type="button" className="link-row" onClick={() => onPick(c.id)}>{names.get(c.id)}</button>
                  {mine.length > 0 && <ul aria-label={`Connections of ${names.get(c.id)}`}>{mine.map((e) => <li key={e.id}><button type="button" className="link-row" onClick={() => onPick(e.id)}>{sentence(e)}</button></li>)}</ul>}
                </li>
              );
            })}
          </ul>
        )
        : <p className="muted small">No shapes on this page.</p>}
      {!readOnly && shapes.length > 1 && (
        <form className="canvas-connect" onSubmit={(e) => { e.preventDefault(); if (from && to && from !== to) onConnect(from, to); }}>
          {pick(from, setFrom, "From")}
          {pick(to, setTo, "To")}
          <button type="submit" disabled={!from || !to || from === to}>Connect</button>
        </form>
      )}
    </div>
  );
}

export function DrawioBoard(props: DrawioBoardProps) {
  const { doc, readOnly } = props;
  const root = useRef<HTMLDivElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const [pageIndex, setPageIndex] = useState(0);
  const safeIndex = Math.min(pageIndex, Math.max(0, doc.pages.length - 1));
  const [view, setView] = useState<DrawioView>({ x: 0, y: 0, k: 1 });
  const [preview, setPreview] = useState<DrawioDoc | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [renamingPage, setRenamingPage] = useState<number | null>(null);
  const [pageDraft, setPageDraft] = useState("");
  const [joining, setJoining] = useState<{ from: DrawioPoint; to: DrawioPoint } | null>(null);
  const [panel, setPanel] = useState(false);
  // The cell the Tab key stops on (a roving tabindex: the arrow keys move between cells), where focus goes once an edit or a
  // delete has finished and its element is gone, and whether a pointer press is under way (focus it gives a cell must not change
  // the selection the press makes itself).
  const [stop, setStop] = useState<string | null>(null);
  const focusAfter = useRef<string | null>(null);
  const pressing = useRef(false);
  const panelId = useId(), hintId = useId();
  const gesture = useRef<Gesture | null>(null);

  const shown = preview ?? doc;
  const page = shown.pages[safeIndex] ?? shown.pages[0];
  const rects = useMemo(() => absoluteRects(page.cells), [page.cells]);
  const selectedSet = useMemo(() => new Set(selected.filter((id) => page.cells.some((c) => c.id === id))), [selected, page.cells]);
  const singleCell = selectedSet.size === 1 ? page.cells.find((c) => selectedSet.has(c.id)) ?? null : null;

  // The keyboard walks the shapes in reading order: top to bottom, then left to right.
  const order = useMemo(() => page.cells
    .filter((c) => c.vertex && rects.has(c.id))
    .sort((a, b) => rects.get(a.id)!.y - rects.get(b.id)!.y || rects.get(a.id)!.x - rects.get(b.id)!.x || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)), [page.cells, rects]);
  const tabStop = singleCell?.vertex ? singleCell.id : stop && order.some((c) => c.id === stop) ? stop : order[0]?.id ?? null;

  const latest = useRef({ view, doc, pageIndex: safeIndex, selectedSet, readOnly, props, rects, page, order, stop });
  latest.current = { view, doc, pageIndex: safeIndex, selectedSet, readOnly, props, rects, page, order, stop };

  useLayoutEffect(() => {
    const box = root.current?.getBoundingClientRect();
    if (box) setView(fitView(page.cells, box.width, box.height));
  }, [safeIndex]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    gesture.current = null;
    setPreview(null);
    setJoining(null);
  }, [doc]);

  const toCanvas = (clientX: number, clientY: number): DrawioPoint => {
    const box = root.current?.getBoundingClientRect();
    const v = latest.current.view;
    return { x: (clientX - (box?.left ?? 0) - v.x) / v.k, y: (clientY - (box?.top ?? 0) - v.y) / v.k };
  };

  const centre = (): DrawioPoint => {
    const box = root.current?.getBoundingClientRect();
    return toCanvas(box ? box.left + box.width / 2 : 200, box ? box.top + box.height / 2 : 160);
  };

  const zoomAt = (factor: number, clientX?: number, clientY?: number) => {
    const box = root.current?.getBoundingClientRect();
    const cx = clientX !== undefined && box ? clientX - box.left : (box?.width ?? 0) / 2;
    const cy = clientY !== undefined && box ? clientY - box.top : (box?.height ?? 0) / 2;
    setView((v) => {
      const k = clampK(v.k * factor);
      const r = k / v.k;
      return { x: cx - (cx - v.x) * r, y: cy - (cy - v.y) * r, k };
    });
  };

  const doFit = () => {
    const box = root.current?.getBoundingClientRect();
    if (box) setView(fitView(latest.current.page.cells, box.width, box.height));
  };

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if ((e.target as HTMLElement).closest?.(".canvas-panel-host")) return;
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * 0.002), e.clientX, e.clientY);
      else setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const g = gesture.current;
      if (!g) return;
      const L = latest.current;
      if (g.kind === "pan") {
        setView({ ...g.from, x: g.from.x + (e.clientX - g.sx), y: g.from.y + (e.clientY - g.sy) });
      } else if (g.kind === "move") {
        const dx = (e.clientX - g.sx) / L.view.k;
        const dy = (e.clientY - g.sy) / L.view.k;
        const next = moveCells(g.base, L.pageIndex, g.ids, dx, dy);
        g.last = next;
        setPreview(next);
      } else if (g.kind === "resize") {
        const dx = (e.clientX - g.sx) / L.view.k;
        const dy = (e.clientY - g.sy) / L.view.k;
        const next = resizeCell(g.base, L.pageIndex, g.id, g.corner, dx, dy);
        g.last = next;
        setPreview(next);
      } else if (g.kind === "link") {
        const r = L.rects.get(g.from);
        if (r) setJoining({ from: { x: r.x + r.width / 2, y: r.y + r.height / 2 }, to: toCanvas(e.clientX, e.clientY) });
      }
    };
    const onUp = (e: PointerEvent) => {
      pressing.current = false;
      const g = gesture.current;
      if (!g) return;
      gesture.current = null;
      const L = latest.current;
      if ((g.kind === "move" || g.kind === "resize") && g.last) {
        setPreview(null);
        L.props.onCommit(g.last);
      } else if (g.kind === "link") {
        setJoining(null);
        const hit = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest<HTMLElement>("[data-drawio-cell]");
        const targetId = hit?.dataset.drawioCell;
        if (targetId && targetId !== g.from && !L.readOnly) {
          const added = addEdge(L.doc, L.pageIndex, g.from, targetId);
          L.props.onCommit(added.doc);
          setSelected([added.id]);
        }
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, []);

  const commit = (next: DrawioDoc, group?: string) => { if (!readOnly) props.onCommit(next, group); };

  /** Pan just far enough to bring a shape the keyboard reached into the pane. */
  const reveal = (r: DrawioRect) => {
    const pane = root.current?.getBoundingClientRect();
    if (!pane?.width) return;
    setView((v) => {
      const m = 48, l = r.x * v.k + v.x, t = r.y * v.k + v.y, right = l + r.width * v.k, bottom = t + r.height * v.k;
      let { x, y } = v;
      if (right > pane.width - m) x -= right - (pane.width - m);
      if (l + (x - v.x) < m) x += m - (l + (x - v.x));
      if (bottom > pane.height - m) y -= bottom - (pane.height - m);
      if (t + (y - v.y) < m) y += m - (t + (y - v.y));
      return x === v.x && y === v.y ? v : { ...v, x, y };
    });
  };
  /** Focus a shape (or the shell) without the browser scrolling the pane; the view is moved by `reveal` instead. */
  const focusOn = (id: string) => {
    const shell = shellRef.current;
    // An arrow (picked from the cells list) has no element of its own to focus, so the shell takes it.
    const el = [...(shell?.querySelectorAll<HTMLElement>("[data-drawio-cell]") ?? [])].find((n) => n.dataset.drawioCell === id) ?? shell;
    el?.focus({ preventScroll: true });
    const r = latest.current.rects.get(id);
    if (r) reveal(r);
  };
  /** Select one shape and put the keyboard on it. */
  const goTo = (id: string) => { setSelected([id]); setStop(id); focusOn(id); };

  // Focus that waits for what ended an edit or removed a shape: the textarea or the shape is gone once the board has drawn again.
  useLayoutEffect(() => {
    const id = focusAfter.current;
    if (!id || editing) return;
    focusAfter.current = null;
    focusOn(id);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  const startEdit = (cell: DrawioCell) => {
    if (readOnly) return;
    const st = parseStyle(cell.style);
    setEditing(cell.id);
    setEditText(labelToPlainText(cell.value, st.html));
  };

  const finishEdit = (save: boolean, byKey = false) => {
    const id = editing;
    if (byKey && id) focusAfter.current = id;
    setEditing(null);
    if (!save || !id) return;
    const cell = page.cells.find((c) => c.id === id);
    if (!cell) return;
    const st = parseStyle(cell.style);
    const nextVal = st.html ? editText.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>") : editText;
    if (nextVal !== cell.value) commit(setCellLabel(doc, safeIndex, id, nextVal));
  };

  const insertPreset = (preset: NewShapePreset) => {
    if (readOnly) return;
    const made = addShape(doc, safeIndex, preset, centre());
    commit(made.doc);
    setSelected([made.id]);
  };

  /** A keyboard move or resize (Ctrl+Arrow, Ctrl+Shift+Arrow): the same model change as a drag, as one commit. */
  const nudge = (ids: string[], by: NonNullable<ReturnType<typeof nudgeOf>>) => {
    const L = latest.current;
    if (L.readOnly) return;
    const cells = ids.map((id) => L.page.cells.find((c) => c.id === id)).filter((c): c is DrawioCell => !!c?.vertex);
    if (!cells.length) return;
    if (by.kind === "move") {
      commit(moveCells(L.doc, L.pageIndex, new Set(cells.map((c) => c.id)), by.dx, by.dy), "key-move");
      const r = L.rects.get(cells[0].id);
      if (r) reveal({ ...r, x: r.x + by.dx, y: r.y + by.dy });
    } else if (cells.length === 1) {
      commit(resizeCell(L.doc, L.pageIndex, cells[0].id, "se", by.dx, by.dy), "key-resize");
      const r = L.rects.get(cells[0].id);
      if (r) reveal({ ...r, width: r.width + by.dx, height: r.height + by.dy });
    }
  };

  /** A shape has the keyboard focus, however it got it (Tab, an arrow key, a click): it is the Tab stop, it is selected, and it is
   *  brought into view. The browser's own scrolling of the pane is undone: the board moves by its transform. */
  const gotFocus = (e: React.FocusEvent) => {
    const el = e.target as HTMLElement;
    const id = el.getAttribute("data-drawio-cell");
    if (!id) return;
    if (root.current) { root.current.scrollLeft = 0; root.current.scrollTop = 0; }
    setStop(id);
    if (pressing.current) return;
    if (!selectedSet.has(id)) setSelected([id]);
    const r = rects.get(id);
    if (r) reveal(r);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (t?.closest?.("input, textarea, select, .canvas-panel-host")) return;
    // What acts on a shape is for the shape or the shell having focus, not for a toolbar button.
    const focused = t.hasAttribute?.("data-drawio-cell") ? t.dataset.drawioCell : undefined;
    const direct = t === e.currentTarget || !!focused;
    const nudged = direct ? nudgeOf(e) : null;
    const walk: Record<string, number> = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 };
    if (nudged) {
      e.preventDefault();
      nudge(selectedSet.size ? [...selectedSet] : focused ? [focused] : [], nudged);
    } else if (direct && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && (e.key in walk || e.key === "Home" || e.key === "End")) {
      // Arrow keys move between shapes in reading order (down and right go on, up and left go back); Home and End go to the ends.
      e.preventDefault();
      if (!order.length) return;
      const here = order.findIndex((c) => c.id === (focused ?? (singleCell?.vertex ? singleCell.id : stop)));
      const to = e.key === "Home" ? 0 : e.key === "End" ? order.length - 1 : Math.min(order.length - 1, Math.max(0, here < 0 ? 0 : here + walk[e.key]));
      goTo(order[to].id);
    } else if (direct && (e.key === "Enter" || e.key === "F2") && !readOnly) {
      const cell = page.cells.find((c) => c.id === (focused ?? (selectedSet.size === 1 ? [...selectedSet][0] : undefined)));
      if (cell) { e.preventDefault(); startEdit(cell); }
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) props.onRedo();
      else props.onUndo();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
      e.preventDefault();
      props.onRedo();
    } else if ((e.key === "Delete" || e.key === "Backspace") && selectedSet.size && !readOnly) {
      e.preventDefault();
      removeSelected();
    } else if (e.key === "Escape") {
      // Used here, so not for focus mode too. A gesture under way is cancelled (its preview goes and a release commits nothing);
      // with none, Escape clears the selection, and with neither it is left to the shell.
      if (gesture.current) { e.preventDefault(); gesture.current = null; setPreview(null); setJoining(null); }
      else if (selected.length) { e.preventDefault(); setSelected([]); }
    }
  };

  /** Delete the selection, and keep the keyboard where it was: on the shape after the first one removed in reading order, else the
   *  one before, else the shell. */
  function removeSelected() {
    const first = order.findIndex((c) => selectedSet.has(c.id));
    const rest = order.filter((c) => !selectedSet.has(c.id));
    const next = first < 0 ? undefined : rest.find((c) => order.indexOf(c) > first) ?? rest[rest.length - 1];
    focusAfter.current = next?.id ?? "shell";
    commit(deleteCells(doc, safeIndex, selectedSet));
    setSelected([]);
  }

  const vertices = page.cells.filter((c) => c.vertex && rects.has(c.id));
  const edges = page.cells.filter((c) => c.edge);
  const singleStyle = singleCell ? parseStyle(singleCell.style) : null;

  return (
    <div ref={shellRef} className="drawio-shell" onKeyDown={onKeyDown} onFocus={gotFocus} tabIndex={tabStop ? -1 : 0}>
      {/* An application, not a plain group: the board takes the arrow keys itself (they walk the shapes, with Ctrl they move and
          resize one), which a screen reader must pass through instead of using for its own reading. */}
      <div
        ref={root}
        className="canvas-board drawio-board"
        role="application"
        aria-label={`Diagram board, page ${page.name}`}
        aria-describedby={hintId}
        style={{ "--k": view.k } as CSSProperties}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          if ((e.target as HTMLElement).closest(".canvas-tools, .canvas-panel-host, .drawio-node, .drawio-edge-hit, .drawio-edge-label")) return;
          pressing.current = true;
          shellRef.current?.focus({ preventScroll: true });
          setSelected([]);
          gesture.current = { kind: "pan", sx: e.clientX, sy: e.clientY, from: view };
        }}
      >
        <p id={hintId} className="visually-hidden">
          Arrow keys move between shapes in reading order. Enter or F2 edits the label. Ctrl or Cmd with an arrow key moves the shape,
          and with Shift as well resizes it. Delete removes it.
        </p>
        {/* The toolbar and the style bar stack in this box, so the style bar sits below however many rows the toolbar wraps to. */}
        <div className="drawio-tools">
        <div className="canvas-tools" role="toolbar" aria-label="Draw.io toolbar">
          {!readOnly && (
            <>
              <button type="button" onClick={() => insertPreset("rect")}>+ Box</button>
              <button type="button" onClick={() => insertPreset("rounded")}>+ Rounded</button>
              <button type="button" onClick={() => insertPreset("container")}>+ Container</button>
              <button type="button" onClick={() => insertPreset("cylinder")}>+ Cylinder</button>
              <button type="button" onClick={() => insertPreset("diamond")}>+ Diamond</button>
              <button type="button" onClick={() => insertPreset("ellipse")}>+ Ellipse</button>
              <button type="button" onClick={() => insertPreset("text")}>+ Text</button>
              <span className="canvas-sep" aria-hidden />
              <button type="button" disabled={!props.canUndo} onClick={props.onUndo} title="Undo (Ctrl+Z)" aria-label="Undo"><Undo2 size="1em" aria-hidden /></button>
              <button type="button" disabled={!props.canRedo} onClick={props.onRedo} title="Redo (Ctrl+Y)" aria-label="Redo"><Redo2 size="1em" aria-hidden /></button>
              <span className="canvas-sep" aria-hidden />
            </>
          )}
          <button type="button" title="Zoom out" aria-label="Zoom out" onClick={() => zoomAt(1 / STEP)}><Minus size="1em" aria-hidden /></button>
          <span className="canvas-zoom">{Math.round(view.k * 100)}%</span>
          <button type="button" title="Zoom in" aria-label="Zoom in" onClick={() => zoomAt(STEP)}><Plus size="1em" aria-hidden /></button>
          <button type="button" title="Fit to view" aria-label="Fit to view" onClick={doFit}><Maximize2 size="1em" aria-hidden /></button>
          {/* The arrows are drawn in an SVG a screen reader skips and a keyboard cannot select. This is the list of every shape
              with its connections, and the way to join two shapes without dragging from a handle. */}
          <button type="button" aria-expanded={panel} aria-controls={panelId} onClick={() => setPanel((v) => !v)}>Cells</button>
          <span className="canvas-sep" aria-hidden />
          <button
            type="button"
            title="Export current page as SVG"
            onClick={() => {
              const svg = exportPageSvg(page.cells, rects);
              const name = `${props.fileName.replace(/\.(drawio|dio)$/i, "")}.svg`;
              void saveCopy(svg, name).catch((err) => toast(classify(err).message, "error"));
            }}
          >
            <Download size="0.95em" aria-hidden /> Export SVG
          </button>
        </div>

        {!readOnly && selectedSet.size > 0 && (
          <div className="canvas-tools drawio-inspector" role="toolbar" aria-label="Selection style">
            <span className="muted small">Fill:</span>
            {SWATCHES.map((hex) => (
              <button key={`f-${hex}`} type="button" className="canvas-swatch" style={{ background: hex }} title={`Fill ${hex}`}
                onClick={() => commit(setCellStyle(doc, safeIndex, selectedSet, { fillColor: hex }))} />
            ))}
            <span className="canvas-sep" aria-hidden />
            <span className="muted small">Stroke:</span>
            {STROKES.map((hex) => (
              <button key={`s-${hex}`} type="button" className="canvas-swatch" style={{ background: hex }} title={`Stroke ${hex}`}
                onClick={() => commit(setCellStyle(doc, safeIndex, selectedSet, { strokeColor: hex }))} />
            ))}
            <span className="canvas-sep" aria-hidden />
            <button type="button" className={singleStyle?.dashed ? "on" : ""} onClick={() => commit(setCellStyle(doc, safeIndex, selectedSet, { dashed: singleStyle?.dashed ? "0" : "1" }))}>Dashed</button>
            {singleCell?.edge && (
              <button type="button" onClick={() => commit(setCellStyle(doc, safeIndex, selectedSet, { endArrow: singleStyle?.endArrow === "none" ? "block" : "none" }))}>
                {singleStyle?.endArrow === "none" ? "Arrow: Off" : "Arrow: On"}
              </button>
            )}
            <button type="button" title="Bring to front" aria-label="Bring to front" onClick={() => commit(reorderCells(doc, safeIndex, selectedSet, "front"))}><ArrowUpToLine size="1em" aria-hidden /></button>
            <button type="button" title="Send to back" aria-label="Send to back" onClick={() => commit(reorderCells(doc, safeIndex, selectedSet, "back"))}><ArrowDownToLine size="1em" aria-hidden /></button>
            <button type="button" className="danger-text" title="Delete selected" aria-label="Delete selected" onClick={removeSelected}>
              <Trash2 size="1em" aria-hidden />
            </button>
          </div>
        )}
        </div>

        {panel && (
          <div id={panelId} className="canvas-panel-host">
            <CellsPanel cells={page.cells} readOnly={readOnly} onPick={goTo}
              onConnect={(from, to) => { const added = addEdge(doc, safeIndex, from, to); commit(added.doc); setSelected([added.id]); }} />
          </div>
        )}

        <div className="canvas-world" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
          {vertices.map((cell) => {
            const r = rects.get(cell.id)!;
            const st = parseStyle(cell.style);
            const isSel = selectedSet.has(cell.id);
            const isEdit = editing === cell.id;
            const safeHtml = sanitizeDrawioLabel(cell.value, st.html);
            const textAlign: CSSProperties["justifyContent"] = st.align === "left" ? "flex-start" : st.align === "right" ? "flex-end" : "center";
            const vAlign: CSSProperties["alignItems"] = st.verticalAlign === "top" ? "flex-start" : st.verticalAlign === "bottom" ? "flex-end" : "center";
            return (
              <div
                key={cell.id}
                data-drawio-cell={cell.id}
                role="group"
                aria-label={`${st.shape === "text" ? "Text" : "Shape"}: ${cellName(cell)}`}
                tabIndex={tabStop === cell.id ? 0 : -1}
                className={`drawio-node${isSel ? " on" : ""}${st.shape === "text" ? " drawio-text-node" : ""}`}
                style={{ left: r.x, top: r.y, width: r.width, height: r.height, opacity: st.opacity }}
                onPointerDown={(e) => {
                  if (e.button !== 0 || isEdit) return;
                  if ((e.target as HTMLElement).closest(".canvas-corner, .canvas-handle")) return;
                  pressing.current = true;
                  e.stopPropagation();
                  const nextSel = e.shiftKey
                    ? (isSel ? selected.filter((id) => id !== cell.id) : [...selected, cell.id])
                    : (isSel ? selected : [cell.id]);
                  setSelected(nextSel);
                  if (!readOnly) {
                    gesture.current = { kind: "move", sx: e.clientX, sy: e.clientY, ids: new Set(nextSel), base: doc, last: null };
                  }
                }}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  startEdit(cell);
                }}
              >
                <ShapeGraphic w={r.width} h={r.height} st={st} />
                {isEdit ? (
                  <textarea
                    className="drawio-label-input"
                    aria-label="Shape label"
                    autoFocus
                    value={editText}
                    onChange={(e) => setEditText(e.target.value)}
                    onBlur={() => finishEdit(true)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") { e.preventDefault(); finishEdit(false, true); }
                      else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); finishEdit(true, true); }
                    }}
                  />
                ) : safeHtml ? (
                  <div
                    className="drawio-label"
                    style={{
                      fontSize: st.fontSize,
                      fontFamily: st.fontFamily ?? undefined,
                      fontWeight: st.fontBold ? 700 : undefined,
                      fontStyle: st.fontItalic ? "italic" : undefined,
                      textDecoration: st.fontUnderline ? "underline" : undefined,
                      color: st.fontColor ?? "#1f2937",
                      justifyContent: textAlign,
                      alignItems: vAlign,
                      textAlign: st.align,
                      background: st.labelBackgroundColor ?? undefined,
                    }}
                    dangerouslySetInnerHTML={{ __html: safeHtml }}
                  />
                ) : null}
                {isSel && !readOnly && selectedSet.size === 1 && (
                  <>
                    {(["nw", "ne", "sw", "se"] as const).map((corner) => (
                      <div
                        key={corner}
                        className={`canvas-corner canvas-corner-${corner}`}
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          gesture.current = { kind: "resize", sx: e.clientX, sy: e.clientY, id: cell.id, corner, base: doc, last: null };
                        }}
                      />
                    ))}
                    {(["top", "right", "bottom", "left"] as const).map((side) => (
                      <div
                        key={side}
                        className={`canvas-handle canvas-handle-${side}`}
                        title="Drag to connect arrow"
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          gesture.current = { kind: "link", from: cell.id };
                        }}
                      />
                    ))}
                  </>
                )}
              </div>
            );
          })}

          <svg className="canvas-edges drawio-edges" width="1" height="1" overflow="visible" aria-hidden="true">
            {edges.map((edge) => {
              const pts = edgePoints(edge, rects);
              if (pts.length < 2) return null;
              const st = parseStyle(edge.style);
              const isSel = selectedSet.has(edge.id);
              const stroke = isSel ? "var(--selected)" : (st.strokeColor ?? "#526580");
              const pointsAttr = pts.map((p) => `${p.x},${p.y}`).join(" ");
              const dash = st.dashed ? "6 4" : undefined;
              const a = pts[pts.length - 2], b = pts[pts.length - 1];
              const s0 = pts[1], s1 = pts[0];
              return (
                <g key={edge.id} className={isSel ? "canvas-edge on" : "canvas-edge"}>
                  <polyline
                    className="canvas-edge-hit drawio-edge-hit"
                    points={pointsAttr}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      setSelected([edge.id]);
                    }}
                    onDoubleClick={(e) => { e.stopPropagation(); startEdit(edge); }}
                  />
                  <polyline points={pointsAttr} fill="none" stroke={stroke} strokeWidth={isSel ? st.strokeWidth + 1 : st.strokeWidth} strokeDasharray={dash} />
                  {st.endArrow !== "none" && <polygon points={arrowHeadPoints(a, b)} fill={stroke} />}
                  {st.startArrow !== "none" && <polygon points={arrowHeadPoints(s0, s1)} fill={stroke} />}
                </g>
              );
            })}
            {joining && <line className="canvas-joining" x1={joining.from.x} y1={joining.from.y} x2={joining.to.x} y2={joining.to.y} />}
          </svg>

          {edges.map((edge) => {
            const pts = edgePoints(edge, rects);
            if (pts.length < 2) return null;
            const st = parseStyle(edge.style);
            const isEdit = editing === edge.id;
            const html = sanitizeDrawioLabel(edge.value, st.html);
            if (!html && !isEdit) return null;
            const mid = polylineMidpoint(pts);
            return (
              <div
                key={`lbl-${edge.id}`}
                className={`canvas-edge-label drawio-edge-label${selectedSet.has(edge.id) ? " on" : ""}`}
                style={{ left: mid.x, top: mid.y, fontSize: st.fontSize }}
                onClick={(e) => { e.stopPropagation(); setSelected([edge.id]); }}
                onDoubleClick={(e) => { e.stopPropagation(); startEdit(edge); }}
              >
                {isEdit ? (
                  <input
                    autoFocus
                    aria-label="Arrow label"
                    value={editText}
                    onChange={(e) => setEditText(e.target.value)}
                    onBlur={() => finishEdit(true)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") finishEdit(true, true);
                      else if (e.key === "Escape") { e.preventDefault(); finishEdit(false, true); }
                    }}
                  />
                ) : (
                  <span dangerouslySetInnerHTML={{ __html: html }} />
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Not a tab list: the tabs sit beside a rename field and a delete button, which a tab list may not hold, and there is no
          panel per page. A button for each page that says which one is shown. */}
      <div className="drawio-pages" role="group" aria-label="Diagram pages">
        {doc.pages.map((p, i) => (
          <div key={p.id} className={`drawio-page-tab${i === safeIndex ? " on" : ""}`}>
            {renamingPage === i ? (
              <input
                autoFocus
                className="drawio-page-rename"
                aria-label="Page name"
                value={pageDraft}
                onChange={(e) => setPageDraft(e.target.value)}
                onBlur={() => { setRenamingPage(null); commit(renamePage(doc, i, pageDraft)); }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { setRenamingPage(null); commit(renamePage(doc, i, pageDraft)); }
                  else if (e.key === "Escape") { e.preventDefault(); setRenamingPage(null); }
                }}
              />
            ) : (
              <button
                type="button"
                aria-pressed={i === safeIndex}
                title={readOnly ? undefined : "Double-click or press F2 to rename"}
                onClick={() => { setPageIndex(i); setSelected([]); }}
                onDoubleClick={() => { if (!readOnly) { setRenamingPage(i); setPageDraft(p.name); } }}
                onKeyDown={(e) => { if (e.key === "F2" && !readOnly) { e.preventDefault(); setRenamingPage(i); setPageDraft(p.name); } }}
              >
                {p.name}
              </button>
            )}
            {!readOnly && doc.pages.length > 1 && i === safeIndex && (
              <button
                type="button"
                className="drawio-page-del"
                title={`Delete page ${p.name}`}
                aria-label={`Delete page ${p.name}`}
                onClick={() => { commit(deletePage(doc, i)); setPageIndex(Math.max(0, i - 1)); }}
              >
                ×
              </button>
            )}
          </div>
        ))}
        {!readOnly && (
          <button
            type="button"
            className="drawio-page-add"
            title="Add diagram page"
            onClick={() => {
              const added = addPage(doc);
              commit(added.doc);
              setPageIndex(added.index);
            }}
          >
            + Page
          </button>
        )}
      </div>
    </div>
  );
}
