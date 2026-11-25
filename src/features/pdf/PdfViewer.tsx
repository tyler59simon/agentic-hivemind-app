// Virtualized multi-page PDF viewer & offline interactive annotator/page-organizer built on `pdfjs-dist` (zero iframes).
// Annotations and form overlays use PDF.js viewport transforms (`convertToPdfPoint` / `convertToViewportPoint`) so
// coordinates stay exact across rotated pages, non-default crop boxes, and zoom levels.
import type { PDFDocumentProxy, PageViewport, RenderTask } from "pdfjs-dist";
import {
  ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Eraser, FilePlus, Files, Highlighter, ImagePlus,
  Layers, Minus, Move, PenTool, Plus, Redo2, RotateCcw, RotateCw, Search, Slash, Square, StickyNote, Strikethrough,
  Trash2, Type, Underline, Undo2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FileRef } from "../../documents/keys";
import { classify } from "../../lib/errors";
import { scrollBehavior } from "../../lib/motion";
import { fileName, folderOf } from "../../lib/notebooks";
import { isLoose } from "../../lib/opens";
import { createPdfBytes, pdfRange, pickPdfForMerge } from "../../lib/pdf";
import { loadPdfjs, openPdfJsDocument } from "../../lib/pdfjs";
import { toast } from "../../ui/toast";
import { extractPdfPageSpecs, type PdfAnnotation, type PdfFormFieldInfo, type PdfPageSpec, type PdfPoint, type PdfRect } from "./pdfWriter";
import { SignatureModal } from "./SignatureModal";
import {
  addPdfAnnotation, deletePdfPage, insertBlankPdfPage, mergePdfBytes, pdfKey, redoPdf, removePdfAnnotation,
  reorderPdfPages, rotatePdfPage, setPdfFormValue, undoPdf, updatePdfAnnotation, type PdfSession,
} from "./store";
import {
  annotationBounds, arrowHeadSvgPoints, centeredBoxOnPage, extractNestedOutline, findSpanMatches,
  resizeAnnotationBox, translateAnnotation, type OutlineItem, type SearchMatch,
} from "./viewerModel";

type Tool = "select" | "highlight" | "underline" | "strikeout" | "note" | "textbox" | "whiteout" | "ink" | "rect" | "line" | "arrow";
type Corner = "nw" | "ne" | "sw" | "se";

const COLORS = ["#fef08a", "#bbf7d0", "#bfdbfe", "#fecaca", "#dc2626", "#1a73e8", "#111827"];
const RANGE_CHUNK = 256 * 1024;
/** Sliding window around `activePage`: canvases further than this are released to prevent unbounded RAM growth. */
const RENDER_WINDOW = 6;

export interface PdfViewerProps {
  file: FileRef;
  session: PdfSession;
  editing: boolean;
}

interface CoordMapper {
  width: number;
  height: number;
  pageWidthPt: number;
  pageHeightPt: number;
  toPdf: (vx: number, vy: number) => PdfPoint;
  toView: (px: number, py: number) => { x: number; y: number };
}

function makeMapperFromViewport(vp: PageViewport, scale: number): CoordMapper {
  return {
    width: Math.floor(vp.width),
    height: Math.floor(vp.height),
    pageWidthPt: vp.width / Math.max(0.01, scale),
    pageHeightPt: vp.height / Math.max(0.01, scale),
    toPdf: (vx, vy) => {
      const [x, y] = vp.convertToPdfPoint(vx, vy);
      return { x, y };
    },
    toView: (px, py) => {
      const [x, y] = vp.convertToViewportPoint(px, py);
      return { x, y };
    },
  };
}

/** Synthetic coordinate mapper for an unsaved blank US Letter page (612 x 792 pt) at any rotation/scale. */
function makeBlankMapper(scale: number, rotation: 0 | 90 | 180 | 270): CoordMapper {
  const pw = 612, ph = 792;
  const rot = rotation % 180 !== 0;
  const width = Math.floor((rot ? ph : pw) * scale);
  const height = Math.floor((rot ? pw : ph) * scale);
  return {
    width,
    height,
    pageWidthPt: rot ? ph : pw,
    pageHeightPt: rot ? pw : ph,
    toPdf: (vx, vy) => {
      const ux = vx / scale, uy = vy / scale;
      switch (rotation) {
        case 90: return { x: uy, y: ux };
        case 180: return { x: pw - ux, y: uy };
        case 270: return { x: pw - uy, y: ph - ux };
        default: return { x: ux, y: ph - uy };
      }
    },
    toView: (px, py) => {
      switch (rotation) {
        case 90: return { x: py * scale, y: px * scale };
        case 180: return { x: (pw - px) * scale, y: py * scale };
        case 270: return { x: (ph - py) * scale, y: (pw - px) * scale };
        default: return { x: px * scale, y: (ph - py) * scale };
      }
    },
  };
}

function pdfRectToViewBox(rect: PdfRect, mapper: CoordMapper) {
  const a = mapper.toView(rect.x, rect.y);
  const b = mapper.toView(rect.x + rect.width, rect.y + rect.height);
  const left = Math.min(a.x, b.x);
  const top = Math.min(a.y, b.y);
  return { left, top, width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) };
}

function viewBoxToPdfRect(x1: number, y1: number, x2: number, y2: number, mapper: CoordMapper): PdfRect {
  const p1 = mapper.toPdf(x1, y1);
  const p2 = mapper.toPdf(x2, y2);
  return {
    x: Math.min(p1.x, p2.x),
    y: Math.min(p1.y, p2.y),
    width: Math.abs(p2.x - p1.x),
    height: Math.abs(p2.y - p1.y),
  };
}

function uid(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Sample RGB hex from a rendered canvas at CSS pixel `(vx, vy)`, defaulting to `#ffffff`. */
function sampleCanvasBg(canvas: HTMLCanvasElement | null, vx: number, vy: number, cssW: number, cssH: number): string {
  if (!canvas || canvas.width < 2 || canvas.height < 2) return "#ffffff";
  try {
    const ctx = canvas.getContext("2d");
    if (!ctx) return "#ffffff";
    const x = Math.min(canvas.width - 1, Math.max(0, Math.round((vx / Math.max(1, cssW)) * canvas.width)));
    const y = Math.min(canvas.height - 1, Math.max(0, Math.round((vy / Math.max(1, cssH)) * canvas.height)));
    const d = ctx.getImageData(x, y, 1, 1).data;
    if (d[3] === 0) return "#ffffff";
    return `#${[d[0], d[1], d[2]].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
  } catch {
    return "#ffffff";
  }
}

type AnnGesture =
  | { kind: "move"; ann: PdfAnnotation; startPdf: PdfPoint; last: PdfAnnotation }
  | { kind: "resize"; ann: PdfAnnotation; corner: Corner; startBox: { left: number; top: number; width: number; height: number }; sx: number; sy: number; last: PdfAnnotation }
  | { kind: "endpoint"; ann: Extract<PdfAnnotation, { kind: "shape" }>; end: "p1" | "p2"; last: PdfAnnotation };

interface PageCardProps {
  spec: PdfPageSpec;
  index: number;
  inWindow: boolean;
  baseDoc: PDFDocumentProxy | null;
  mergedDocs: (PDFDocumentProxy | null)[];
  scale: number;
  editing: boolean;
  tool: Tool;
  color: string;
  selectedAnn: string | null;
  annotations: PdfAnnotation[];
  formFields: PdfFormFieldInfo[];
  formValues: Record<string, string | boolean | string[]>;
  matchedSpans: ReadonlySet<number>;
  activeMatchSpans: ReadonlySet<number>;
  onSelectAnn: (id: string | null) => void;
  onPageSize: (pageId: string, w: number, h: number) => void;
  onAddAnn: (ann: PdfAnnotation) => void;
  onUpdateAnn: (id: string, patch: Partial<PdfAnnotation>) => void;
  onDeleteAnn: (id: string) => void;
  onFormChange: (name: string, val: string | boolean | string[]) => void;
}

function PdfPageCard({
  spec, index, inWindow, baseDoc, mergedDocs, scale, editing, tool, color, selectedAnn,
  annotations, formFields, formValues, matchedSpans, activeMatchSpans,
  onSelectAnn, onPageSize, onAddAnn, onUpdateAnn, onDeleteAnn, onFormChange,
}: PageCardProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const renderTaskRef = useRef<RenderTask | null>(null);
  const renderChainRef = useRef<Promise<void>>(Promise.resolve());
  const [mapper, setMapper] = useState<CoordMapper>(() => makeBlankMapper(scale, spec.rotation));
  const [textItems, setTextItems] = useState<{ str: string; left: number; top: number; height: number }[]>([]);
  const [draftInk, setDraftInk] = useState<{ x: number; y: number }[] | null>(null);
  const [draftBox, setDraftBox] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const [dragPreview, setDragPreview] = useState<PdfAnnotation | null>(null);
  const annGesture = useRef<AnnGesture | null>(null);
  const latestRef = useRef({ mapper, onUpdateAnn });
  latestRef.current = { mapper, onUpdateAnn };

  const srcDoc = spec.source === "base" ? baseDoc : spec.source === "merged" && spec.mergedIndex !== undefined ? mergedDocs[spec.mergedIndex] ?? null : null;

  useEffect(() => {
    // Sliding-window eviction: release canvas memory and text DOM spans when scrolled far off-screen.
    if (!inWindow) {
      renderTaskRef.current?.cancel();
      const c = canvasRef.current;
      if (c && (c.width > 0 || c.height > 0)) {
        c.width = 0;
        c.height = 0;
      }
      setTextItems((prev) => (prev.length ? [] : prev));
      return;
    }
    if (spec.source === "blank") {
      renderTaskRef.current?.cancel();
      const next = makeBlankMapper(scale, spec.rotation);
      setMapper(next);
      onPageSize(spec.id, next.pageWidthPt, next.pageHeightPt);
      setTextItems([]);
      const c = canvasRef.current;
      if (c) {
        c.width = next.width;
        c.height = next.height;
        c.style.width = `${next.width}px`;
        c.style.height = `${next.height}px`;
        const ctx = c.getContext("2d");
        if (ctx) { ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, next.width, next.height); }
      }
      return;
    }
    if (!srcDoc || spec.sourcePageIndex === undefined) return;
    let cancelled = false;
    renderTaskRef.current?.cancel();
    renderChainRef.current = renderChainRef.current.catch(() => {}).then(async () => {
      if (cancelled) return;
      try {
        const page = await srcDoc.getPage(spec.sourcePageIndex! + 1);
        if (cancelled) return;
        const totalRot = (page.rotate + spec.rotation) % 360;
        const vp = page.getViewport({ scale, rotation: totalRot });
        const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
        const renderVp = page.getViewport({ scale: scale * dpr, rotation: totalRot });
        const nextMapper = makeMapperFromViewport(vp, scale);
        setMapper(nextMapper);
        onPageSize(spec.id, nextMapper.pageWidthPt, nextMapper.pageHeightPt);
        const c = canvasRef.current;
        if (c && !cancelled) {
          c.width = Math.floor(renderVp.width);
          c.height = Math.floor(renderVp.height);
          c.style.width = `${Math.floor(vp.width)}px`;
          c.style.height = `${Math.floor(vp.height)}px`;
          const task = page.render({ canvas: c, viewport: renderVp });
          renderTaskRef.current = task;
          try {
            await task.promise;
          } finally {
            if (renderTaskRef.current === task) renderTaskRef.current = null;
          }
        }
        if (cancelled) return;
        const tc = await page.getTextContent();
        if (cancelled) return;
        const spans: { str: string; left: number; top: number; height: number }[] = [];
        for (const item of tc.items) {
          if (!("str" in item) || !item.str) continue;
          const tx = vp.transform;
          const m = item.transform;
          const x = tx[0] * m[4] + tx[2] * m[5] + tx[4];
          const y = tx[1] * m[4] + tx[3] * m[5] + tx[5];
          const h = Math.max(8, Math.hypot(m[2], m[3]) * scale);
          spans.push({ str: item.str, left: x, top: y - h, height: h });
        }
        setTextItems(spans);
      } catch {
        // Cancelled renders and transient page errors are handled cleanly.
      }
    });
    return () => {
      cancelled = true;
      renderTaskRef.current?.cancel();
    };
  }, [inWindow, srcDoc, spec.id, spec.source, spec.sourcePageIndex, spec.rotation, scale, onPageSize]);

  const viewPosFromClient = (clientX: number, clientY: number) => {
    const r = wrapRef.current!.getBoundingClientRect();
    return {
      x: Math.min(r.width, Math.max(0, clientX - r.left)),
      y: Math.min(r.height, Math.max(0, clientY - r.top)),
    };
  };

  // Window-level pointer handling for dragging/resizing selected pre-save annotations.
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const g = annGesture.current;
      if (!g || !wrapRef.current) return;
      const curMapper = latestRef.current.mapper;
      const vp = viewPosFromClient(e.clientX, e.clientY);
      if (g.kind === "move") {
        const curPdf = curMapper.toPdf(vp.x, vp.y);
        const moved = translateAnnotation(g.ann, curPdf.x - g.startPdf.x, curPdf.y - g.startPdf.y);
        g.last = moved;
        setDragPreview(moved);
      } else if (g.kind === "resize") {
        const dx = e.clientX - g.sx;
        const dy = e.clientY - g.sy;
        let { left, top, width, height } = g.startBox;
        if (g.corner.includes("e")) width = Math.max(20, width + dx);
        if (g.corner.includes("s")) height = Math.max(16, height + dy);
        if (g.corner.includes("w")) {
          const nextW = Math.max(20, width - dx);
          left = left + (width - nextW);
          width = nextW;
        }
        if (g.corner.includes("n")) {
          const nextH = Math.max(16, height - dy);
          top = top + (height - nextH);
          height = nextH;
        }
        const pdfRect = viewBoxToPdfRect(left, top, left + width, top + height, curMapper);
        const resized = resizeAnnotationBox(g.ann, pdfRect);
        g.last = resized;
        setDragPreview(resized);
      } else if (g.kind === "endpoint") {
        const pt = curMapper.toPdf(vp.x, vp.y);
        const next: Extract<PdfAnnotation, { kind: "shape" }> = g.end === "p1"
          ? { ...g.ann, x1: pt.x, y1: pt.y }
          : { ...g.ann, x2: pt.x, y2: pt.y };
        g.last = next;
        setDragPreview(next);
      }
    };
    const onUp = () => {
      const g = annGesture.current;
      if (!g) return;
      annGesture.current = null;
      setDragPreview(null);
      if (g.last !== g.ann) {
        latestRef.current.onUpdateAnn(g.ann.id, g.last);
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

  const startMoveAnn = (ann: PdfAnnotation, e: React.PointerEvent) => {
    if (!editing || e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    onSelectAnn(ann.id);
    const vp = viewPosFromClient(e.clientX, e.clientY);
    annGesture.current = { kind: "move", ann, startPdf: mapper.toPdf(vp.x, vp.y), last: ann };
  };

  const startResizeAnn = (ann: PdfAnnotation, corner: Corner, e: React.PointerEvent) => {
    if (!editing || e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    onSelectAnn(ann.id);
    const startBox = pdfRectToViewBox(annotationBounds(ann), mapper);
    annGesture.current = { kind: "resize", ann, corner, startBox, sx: e.clientX, sy: e.clientY, last: ann };
  };

  const startEndpointAnn = (ann: Extract<PdfAnnotation, { kind: "shape" }>, end: "p1" | "p2", e: React.PointerEvent) => {
    if (!editing || e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    onSelectAnn(ann.id);
    annGesture.current = { kind: "endpoint", ann, end, last: ann };
  };

  const onOverlayDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest(".pdf-ann-interactive, .pdf-ann-hit, .pdf-ann-handle, input, textarea, select, button")) return;
    if (editing && tool === "select") {
      onSelectAnn(null);
      return;
    }
    if (!editing || tool === "select") return;
    e.preventDefault();
    const vp = viewPosFromClient(e.clientX, e.clientY);
    if (tool === "note") {
      const pt = mapper.toPdf(vp.x, vp.y);
      const id = uid("note");
      onAddAnn({ id, pageId: spec.id, kind: "note", x: pt.x, y: pt.y, text: "Note", color: "#fef08a" });
      onSelectAnn(id);
    } else if (tool === "textbox") {
      const rect = viewBoxToPdfRect(vp.x, vp.y, vp.x + 170 * scale, vp.y + 42 * scale, mapper);
      const id = uid("txt");
      onAddAnn({
        id,
        pageId: spec.id,
        kind: "textbox",
        x: rect.x,
        y: rect.y,
        width: Math.max(40, rect.width),
        height: Math.max(20, rect.height),
        text: "Text",
        fontSize: 13,
        color: color === "#fef08a" ? "#111827" : color,
      });
      onSelectAnn(id);
    } else if (tool === "ink") {
      setDraftInk([vp]);
    } else {
      setDraftBox({ x1: vp.x, y1: vp.y, x2: vp.x, y2: vp.y });
    }
  };

  const onOverlayMove = (e: React.PointerEvent) => {
    if (draftInk) setDraftInk((pts) => (pts ? [...pts, viewPosFromClient(e.clientX, e.clientY)] : null));
    else if (draftBox) {
      const p = viewPosFromClient(e.clientX, e.clientY);
      setDraftBox((b) => (b ? { ...b, x2: p.x, y2: p.y } : null));
    }
  };

  const onOverlayUp = () => {
    if (draftInk) {
      if (draftInk.length >= 2) {
        const pdfPts = draftInk.map((pt) => mapper.toPdf(pt.x, pt.y));
        const id = uid("ink");
        onAddAnn({ id, pageId: spec.id, kind: "ink", points: pdfPts, color: color === "#fef08a" ? "#dc2626" : color, width: 2.5 });
        onSelectAnn(id);
      }
      setDraftInk(null);
    } else if (draftBox) {
      const vw = Math.abs(draftBox.x2 - draftBox.x1);
      const vh = Math.abs(draftBox.y2 - draftBox.y1);
      if (vw > 4 || vh > 4) {
        const pdfRect = viewBoxToPdfRect(draftBox.x1, draftBox.y1, draftBox.x2, draftBox.y2, mapper);
        if (tool === "highlight" || tool === "underline" || tool === "strikeout") {
          const rect: PdfRect = {
            x: pdfRect.x,
            y: pdfRect.y,
            width: Math.max(6, pdfRect.width),
            height: Math.max(8, pdfRect.height),
          };
          const id = uid(tool);
          onAddAnn({ id, pageId: spec.id, kind: tool, rects: [rect], color });
          onSelectAnn(id);
        } else if (tool === "whiteout") {
          const bgColor = sampleCanvasBg(canvasRef.current, Math.min(draftBox.x1, draftBox.x2), Math.min(draftBox.y1, draftBox.y2), mapper.width, mapper.height);
          const id = uid("wo");
          onAddAnn({
            id,
            pageId: spec.id,
            kind: "whiteout",
            x: pdfRect.x,
            y: pdfRect.y,
            width: Math.max(24, pdfRect.width),
            height: Math.max(14, pdfRect.height),
            bgColor,
            text: "",
            fontSize: 12,
            color: "#111827",
          });
          onSelectAnn(id);
        } else if (tool === "rect" || tool === "line" || tool === "arrow") {
          const p1 = mapper.toPdf(draftBox.x1, draftBox.y1);
          const p2 = mapper.toPdf(draftBox.x2, draftBox.y2);
          const id = uid("shp");
          onAddAnn({ id, pageId: spec.id, kind: "shape", shape: tool, x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, color: color === "#fef08a" ? "#dc2626" : color, width: 2 });
          onSelectAnn(id);
        }
      }
      setDraftBox(null);
    }
  };

  const renderedAnns = useMemo(
    () => (dragPreview ? annotations.map((a) => (a.id === dragPreview.id ? dragPreview : a)) : annotations),
    [annotations, dragPreview],
  );
  const canSelectVectors = editing && tool === "select";
  const selectedVectorAnn = canSelectVectors
    ? renderedAnns.find((a) => a.id === selectedAnn && (a.kind === "highlight" || a.kind === "underline" || a.kind === "strikeout" || a.kind === "ink" || a.kind === "shape")) ?? null
    : null;

  return (
    <div
      ref={wrapRef}
      data-pdf-page={index + 1}
      data-pdf-index={index}
      className="pdf-page-card"
      style={{ width: mapper.width, height: mapper.height }}
      onPointerDown={onOverlayDown}
      onPointerMove={onOverlayMove}
      onPointerUp={onOverlayUp}
    >
      <canvas ref={canvasRef} className="pdf-page-canvas" />

      {/* Selectable text & full-document search highlight layer */}
      <div className="pdf-text-layer" style={{ pointerEvents: editing && tool !== "select" ? "none" : "auto" }}>
        {textItems.map((it, idx) => {
          const isActive = activeMatchSpans.has(idx);
          const isHit = isActive || matchedSpans.has(idx);
          return (
            <span
              key={idx}
              className={isActive ? "pdf-text-span hit active" : isHit ? "pdf-text-span hit" : "pdf-text-span"}
              style={{ left: it.left, top: it.top, fontSize: it.height }}
            >
              {it.str}
            </span>
          );
        })}
      </div>

      {/* Vector annotations (projected from PDF user-space points through current viewport transform) */}
      <svg className="pdf-ann-svg" viewBox={`0 0 ${Math.max(1, mapper.width)} ${Math.max(1, mapper.height)}`}>
        {renderedAnns.map((ann) => {
          const hitProps = canSelectVectors
            ? { className: "pdf-ann-hit", onPointerDown: (e: React.PointerEvent<SVGElement>) => startMoveAnn(ann, e) }
            : {};
          if (ann.kind === "highlight") {
            return ann.rects.map((r, i) => {
              const b = pdfRectToViewBox(r, mapper);
              return <rect key={`${ann.id}-${i}`} {...hitProps} x={b.left} y={b.top} width={b.width} height={b.height} fill={ann.color} fillOpacity={0.35} />;
            });
          }
          if (ann.kind === "underline") {
            return ann.rects.map((r, i) => {
              const p1 = mapper.toView(r.x, r.y);
              const p2 = mapper.toView(r.x + r.width, r.y);
              return (
                <g key={`${ann.id}-${i}`}>
                  {canSelectVectors && <line {...hitProps} x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke="transparent" strokeWidth={12} />}
                  <line x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke={ann.color} strokeWidth={Math.max(1.5, 1.5 * scale)} />
                </g>
              );
            });
          }
          if (ann.kind === "strikeout") {
            return ann.rects.map((r, i) => {
              const p1 = mapper.toView(r.x, r.y + r.height / 2);
              const p2 = mapper.toView(r.x + r.width, r.y + r.height / 2);
              return (
                <g key={`${ann.id}-${i}`}>
                  {canSelectVectors && <line {...hitProps} x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke="transparent" strokeWidth={12} />}
                  <line x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke={ann.color} strokeWidth={Math.max(1.5, 1.5 * scale)} />
                </g>
              );
            });
          }
          if (ann.kind === "ink") {
            const pts = ann.points.map((p) => { const v = mapper.toView(p.x, p.y); return `${v.x},${v.y}`; }).join(" ");
            return (
              <g key={ann.id}>
                {canSelectVectors && <polyline {...hitProps} points={pts} fill="none" stroke="transparent" strokeWidth={Math.max(12, ann.width * scale + 8)} />}
                <polyline points={pts} fill="none" stroke={ann.color} strokeWidth={ann.width * scale} strokeLinecap="round" strokeLinejoin="round" />
              </g>
            );
          }
          if (ann.kind === "shape") {
            const p1 = mapper.toView(ann.x1, ann.y1);
            const p2 = mapper.toView(ann.x2, ann.y2);
            if (ann.shape === "rect") {
              const rx = Math.min(p1.x, p2.x), ry = Math.min(p1.y, p2.y), rw = Math.abs(p2.x - p1.x), rh = Math.abs(p2.y - p1.y);
              return (
                <g key={ann.id}>
                  {canSelectVectors && <rect {...hitProps} x={rx} y={ry} width={rw} height={rh} fill="none" stroke="transparent" strokeWidth={12} />}
                  <rect x={rx} y={ry} width={rw} height={rh} fill="none" stroke={ann.color} strokeWidth={ann.width * scale} />
                </g>
              );
            }
            const headSize = Math.max(8, ann.width * 4) * scale;
            return (
              <g key={ann.id}>
                {canSelectVectors && <line {...hitProps} x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke="transparent" strokeWidth={12} />}
                <line x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke={ann.color} strokeWidth={ann.width * scale} />
                {ann.shape === "arrow" && <polygon points={arrowHeadSvgPoints(p1.x, p1.y, p2.x, p2.y, headSize)} fill={ann.color} />}
              </g>
            );
          }
          return null;
        })}
        {draftInk && <polyline points={draftInk.map((p) => `${p.x},${p.y}`).join(" ")} fill="none" stroke={color === "#fef08a" ? "#dc2626" : color} strokeWidth={2.5 * scale} />}
        {draftBox && (tool === "line" || tool === "arrow" ? (
          <g>
            <line
              x1={draftBox.x1}
              y1={draftBox.y1}
              x2={draftBox.x2}
              y2={draftBox.y2}
              stroke={color === "#fef08a" ? "#dc2626" : color}
              strokeWidth={2 * scale}
              strokeDasharray="6 4"
            />
            {tool === "arrow" && (
              <polygon
                points={arrowHeadSvgPoints(draftBox.x1, draftBox.y1, draftBox.x2, draftBox.y2, 10 * scale)}
                fill={color === "#fef08a" ? "#dc2626" : color}
              />
            )}
          </g>
        ) : (
          <rect
            x={Math.min(draftBox.x1, draftBox.x2)}
            y={Math.min(draftBox.y1, draftBox.y2)}
            width={Math.abs(draftBox.x2 - draftBox.x1)}
            height={Math.abs(draftBox.y2 - draftBox.y1)}
            fill={tool === "whiteout" ? "#ffffff" : color}
            fillOpacity={tool === "whiteout" ? 0.9 : 0.25}
            stroke="var(--accent)"
            strokeWidth={1.5}
            strokeDasharray="6 4"
          />
        ))}
      </svg>

      {/* Selection frame, resize/endpoint handles, and delete button for selected vector annotation */}
      {selectedVectorAnn && (() => {
        if (selectedVectorAnn.kind === "shape" && selectedVectorAnn.shape !== "rect") {
          const p1 = mapper.toView(selectedVectorAnn.x1, selectedVectorAnn.y1);
          const p2 = mapper.toView(selectedVectorAnn.x2, selectedVectorAnn.y2);
          return (
            <>
              <div className="pdf-ann-handle" style={{ left: p1.x - 5, top: p1.y - 5 }} title="Drag start point" onPointerDown={(e) => startEndpointAnn(selectedVectorAnn, "p1", e)} />
              <div className="pdf-ann-handle" style={{ left: p2.x - 5, top: p2.y - 5 }} title="Drag end point" onPointerDown={(e) => startEndpointAnn(selectedVectorAnn, "p2", e)} />
              <button
                type="button"
                className="pdf-ann-del"
                style={{ left: Math.max(p1.x, p2.x) + 4, top: Math.min(p1.y, p2.y) - 10, right: "auto", zIndex: 5 }}
                onClick={() => { onDeleteAnn(selectedVectorAnn.id); onSelectAnn(null); }}
                title="Remove annotation"
              >×</button>
            </>
          );
        }
        const box = pdfRectToViewBox(annotationBounds(selectedVectorAnn), mapper);
        const resizable = selectedVectorAnn.kind !== "ink";
        return (
          <div
            className="pdf-ann-interactive pdf-ann-selected-frame"
            style={{ left: box.left, top: box.top, width: Math.max(16, box.width), height: Math.max(12, box.height) }}
            onPointerDown={(e) => startMoveAnn(selectedVectorAnn, e)}
          >
            {resizable && (["nw", "ne", "sw", "se"] as const).map((c) => (
              <div key={c} className={`pdf-ann-handle pdf-ann-corner-${c}`} onPointerDown={(e) => startResizeAnn(selectedVectorAnn, c, e)} />
            ))}
            <button type="button" className="pdf-ann-del" onClick={() => { onDeleteAnn(selectedVectorAnn.id); onSelectAnn(null); }} title="Remove annotation">×</button>
          </div>
        );
      })()}

      {/* Interactive overlay annotations (notes, textboxes, whiteout-replace, images/signatures) */}
      {renderedAnns.map((ann) => {
        if (ann.kind === "note") {
          const pos = mapper.toView(ann.x, ann.y);
          return (
            <div
              key={ann.id}
              className={`pdf-ann-interactive pdf-note-box${selectedAnn === ann.id ? " on" : ""}`}
              style={{ left: pos.x, top: pos.y, background: ann.color }}
              onClick={() => onSelectAnn(ann.id)}
            >
              {editing ? (
                <>
                  <div className="pdf-ann-grip" title="Drag to move" onPointerDown={(e) => startMoveAnn(ann, e)}>
                    <Move size="0.75em" aria-hidden />
                  </div>
                  <textarea value={ann.text} rows={2} onChange={(e) => onUpdateAnn(ann.id, { text: e.target.value })} />
                  <button type="button" className="pdf-ann-del" onClick={() => { onDeleteAnn(ann.id); onSelectAnn(null); }} title="Remove note">×</button>
                </>
              ) : (
                <span>{ann.text}</span>
              )}
            </div>
          );
        }
        if (ann.kind === "textbox" || ann.kind === "whiteout") {
          const box = pdfRectToViewBox(ann, mapper);
          const isSel = selectedAnn === ann.id;
          return (
            <div
              key={ann.id}
              className={`pdf-ann-interactive ${ann.kind === "whiteout" ? "pdf-whiteout-box" : "pdf-text-box"}${isSel ? " on" : ""}`}
              style={{
                left: box.left,
                top: box.top,
                width: Math.max(36, box.width),
                height: Math.max(24, box.height),
                background: ann.kind === "whiteout" ? ann.bgColor : "transparent",
                color: ann.color,
                fontSize: ann.fontSize * scale,
              }}
              onClick={() => onSelectAnn(ann.id)}
            >
              {editing ? (
                <>
                  <div className="pdf-ann-grip" title="Drag to move" onPointerDown={(e) => startMoveAnn(ann, e)}>
                    <Move size="0.75em" aria-hidden />
                  </div>
                  <textarea
                    value={ann.text}
                    placeholder={ann.kind === "whiteout" ? "Replacement text…" : "Type text…"}
                    style={{ color: ann.color, fontSize: ann.fontSize * scale }}
                    onChange={(e) => onUpdateAnn(ann.id, { text: e.target.value })}
                  />
                  {isSel && (["nw", "ne", "sw", "se"] as const).map((c) => (
                    <div key={c} className={`pdf-ann-handle pdf-ann-corner-${c}`} onPointerDown={(e) => startResizeAnn(ann, c, e)} />
                  ))}
                  <button type="button" className="pdf-ann-del" onClick={() => { onDeleteAnn(ann.id); onSelectAnn(null); }} title="Remove">×</button>
                </>
              ) : (
                <span>{ann.text}</span>
              )}
            </div>
          );
        }
        if (ann.kind === "image") {
          const box = pdfRectToViewBox(ann, mapper);
          const isSel = selectedAnn === ann.id;
          return (
            <div
              key={ann.id}
              className={`pdf-ann-interactive pdf-img-stamp${isSel ? " on" : ""}`}
              style={{ left: box.left, top: box.top, width: Math.max(24, box.width), height: Math.max(16, box.height), cursor: editing ? "move" : undefined }}
              onPointerDown={(e) => { if (editing) startMoveAnn(ann, e); }}
            >
              <img src={ann.dataUrl} alt="Stamped image" draggable={false} />
              {editing && isSel && (["nw", "ne", "sw", "se"] as const).map((c) => (
                <div key={c} className={`pdf-ann-handle pdf-ann-corner-${c}`} onPointerDown={(e) => startResizeAnn(ann, c, e)} />
              ))}
              {editing && <button type="button" className="pdf-ann-del" onClick={() => { onDeleteAnn(ann.id); onSelectAnn(null); }} title="Remove image">×</button>}
            </div>
          );
        }
        return null;
      })}

      {/* Interactive AcroForm fields overlay in Edit mode */}
      {editing && spec.source === "base" && formFields.map((field) => {
        const val = field.name in formValues ? formValues[field.name] : field.value;
        const box = pdfRectToViewBox(field.rect, mapper);
        const style = {
          left: box.left,
          top: box.top,
          width: Math.max(18, box.width),
          height: Math.max(16, box.height),
        };
        if (field.kind === "checkbox") {
          return (
            <input
              key={field.name}
              type="checkbox"
              aria-label={field.name}
              className="pdf-form-field pdf-form-check"
              style={style}
              checked={Boolean(val)}
              onChange={(e) => onFormChange(field.name, e.target.checked)}
            />
          );
        }
        if (field.kind === "optionList" && field.options?.length) {
          const selected = Array.isArray(val) ? val : val ? [String(val)] : [];
          return (
            <select
              key={field.name}
              multiple
              aria-label={field.name}
              className="pdf-form-field pdf-form-list"
              style={{ ...style, height: Math.max(48, box.height) }}
              value={selected}
              onChange={(e) => onFormChange(field.name, Array.from(e.target.selectedOptions, (o) => o.value))}
            >
              {field.options.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
            </select>
          );
        }
        if ((field.kind === "dropdown" || field.kind === "radio") && field.options?.length) {
          return (
            <select
              key={field.name}
              aria-label={field.name}
              className="pdf-form-field"
              style={style}
              value={String(val ?? "")}
              onChange={(e) => onFormChange(field.name, e.target.value)}
            >
              <option value="" />
              {field.options.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
            </select>
          );
        }
        return (
          <input
            key={field.name}
            type="text"
            aria-label={field.name}
            className="pdf-form-field"
            style={style}
            value={String(val ?? "")}
            onChange={(e) => onFormChange(field.name, e.target.value)}
          />
        );
      })}

      <span className="pdf-page-badge">{index + 1}</span>
    </div>
  );
}

export default function PdfViewer({ file, session, editing }: PdfViewerProps) {
  const key = pdfKey(file);
  const scrollRef = useRef<HTMLDivElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const jumpSuppressUntil = useRef(0);
  const pageSizesRef = useRef<Map<string, { w: number; h: number }>>(new Map());
  const textCacheRef = useRef<Map<string, string[]>>(new Map());
  const [baseDoc, setBaseDoc] = useState<PDFDocumentProxy | null>(null);
  const [mergedDocs, setMergedDocs] = useState<(PDFDocumentProxy | null)[]>([]);
  const [outline, setOutline] = useState<OutlineItem[]>([]);
  const [needPassword, setNeedPassword] = useState(false);
  const [password, setPassword] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [scale, setScale] = useState(1.1);
  const [activePage, setActivePage] = useState(0);
  const [sidebar, setSidebar] = useState<"thumbs" | "outline" | null>("thumbs");
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchMatches, setSearchMatches] = useState<SearchMatch[]>([]);
  const [matchCursor, setMatchCursor] = useState(0);
  const [tool, setTool] = useState<Tool>("select");
  const [color, setColor] = useState("#fef08a");
  const [selectedAnn, setSelectedAnn] = useState<string | null>(null);
  const [showSig, setShowSig] = useState(false);
  // Keyed by `spec.id` so page reorders, insertions, and deletions never shift checkboxes.
  const [selectedPageIds, setSelectedPageIds] = useState<Set<string>>(new Set());

  const recordPageSize = useCallback((pageId: string, w: number, h: number) => {
    pageSizesRef.current.set(pageId, { w, h });
  }, []);

  const loadBase = useCallback(async (pwd?: string) => {
    setLoadError(null);
    textCacheRef.current.clear();
    try {
      let task;
      if (session.baseBytes) {
        task = await openPdfJsDocument({
          data: session.baseBytes.slice(),
          useWasm: false,
          enableXfa: false,
          ...(pwd ? { password: pwd } : {}),
        });
      } else if (session.tooLarge && session.stamp && session.stamp.size > 0) {
        const pdfjs = await loadPdfjs();
        const totalSize = session.stamp.size;
        const firstChunk = await pdfRange(file.notebook, file.path, 0, Math.min(RANGE_CHUNK, totalSize));
        const transport = new pdfjs.PDFDataRangeTransport(totalSize, firstChunk);
        transport.requestDataRange = (begin: number, end: number) => {
          void pdfRange(file.notebook, file.path, begin, Math.max(0, end - begin))
            .then((chunk) => transport.onDataRange(begin, chunk))
            .catch(() => { transport.abort(); });
        };
        task = await openPdfJsDocument({
          range: transport,
          rangeChunkSize: RANGE_CHUNK,
          useWasm: false,
          enableXfa: false,
          ...(pwd ? { password: pwd } : {}),
        });
      } else {
        return;
      }

      const doc = await task.promise;
      setNeedPassword(false);
      setBaseDoc(doc);
      setOutline(await extractNestedOutline(doc));
      return () => { void task.destroy(); };
    } catch (e) {
      const name = (e as { name?: string })?.name ?? "";
      if (name === "PasswordException") {
        setNeedPassword(true);
      } else {
        setLoadError(classify(e).message);
      }
    }
  }, [session.baseBytes, session.tooLarge, session.stamp, file.notebook, file.path]);

  useEffect(() => {
    let cleanup: (() => void) | undefined;
    let disposed = false;
    void loadBase().then((fn) => {
      if (disposed) fn?.();
      else cleanup = fn;
    });
    return () => { disposed = true; cleanup?.(); };
  }, [loadBase]);

  useEffect(() => {
    if (!session.mergedSources.length) { setMergedDocs([]); return; }
    let live = true;
    const tasks: { destroy(): Promise<void> }[] = [];
    void (async () => {
      const loaded: (PDFDocumentProxy | null)[] = [];
      for (const bytes of session.mergedSources) {
        const task = await openPdfJsDocument({ data: bytes.slice(), useWasm: false, enableXfa: false });
        if (!live) { void task.destroy(); return; }
        tasks.push(task);
        loaded.push(await task.promise.catch(() => null));
      }
      if (live) setMergedDocs(loaded);
    })();
    return () => { live = false; tasks.forEach((t) => void t.destroy()); };
  }, [session.mergedSources]);

  const pages: PdfPageSpec[] = useMemo(() => {
    if (session.edits.pages.length) return session.edits.pages;
    if (!baseDoc) return [];
    return Array.from({ length: baseDoc.numPages }, (_, i) => ({ id: `base-${i}`, source: "base" as const, sourcePageIndex: i, rotation: 0 as const }));
  }, [session.edits.pages, baseDoc]);

  // Keep `activePage` clamped and prune deleted page IDs from `selectedPageIds`.
  useEffect(() => {
    if (pages.length && activePage >= pages.length) setActivePage(pages.length - 1);
    setSelectedPageIds((prev) => {
      if (!prev.size) return prev;
      const valid = new Set(pages.map((p) => p.id));
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (valid.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [pages, activePage]);

  // Container-level IntersectionObserver keeping `activePage` synced to whichever page is most visible on scroll.
  useEffect(() => {
    const container = scrollRef.current;
    if (!container || typeof IntersectionObserver === "undefined" || !pages.length) return;
    const ratios = new Map<number, number>();
    const obs = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const idx = Number((entry.target as HTMLElement).dataset.pdfIndex);
          if (!Number.isFinite(idx)) continue;
          if (entry.isIntersecting) ratios.set(idx, entry.intersectionRatio);
          else ratios.delete(idx);
        }
        if (Date.now() < jumpSuppressUntil.current) return;
        let bestIdx = -1;
        let bestRatio = 0;
        for (const [idx, r] of ratios) {
          if (r > bestRatio || (r === bestRatio && (bestIdx < 0 || idx < bestIdx))) {
            bestIdx = idx;
            bestRatio = r;
          }
        }
        if (bestIdx >= 0) setActivePage(bestIdx);
      },
      { root: container, threshold: [0, 0.25, 0.5, 0.75, 1] },
    );
    const cards = container.querySelectorAll<HTMLElement>("[data-pdf-index]");
    cards.forEach((el) => obs.observe(el));
    return () => obs.disconnect();
  }, [pages, baseDoc]);

  const jumpToPage = useCallback((idx: number) => {
    const clamped = Math.min(Math.max(0, idx), Math.max(0, pages.length - 1));
    jumpSuppressUntil.current = Date.now() + 450;
    setActivePage(clamped);
    scrollRef.current?.querySelector(`[data-pdf-page="${clamped + 1}"]`)?.scrollIntoView({ behavior: scrollBehavior(), block: "start" });
  }, [pages.length]);

  // Full-document asynchronous text search across all pages (including unrendered pages).
  useEffect(() => {
    const q = searchQuery.trim();
    if (!q || !pages.length) {
      setSearchMatches([]);
      setMatchCursor(0);
      return;
    }
    let cancelled = false;
    void (async () => {
      const found: SearchMatch[] = [];
      for (let idx = 0; idx < pages.length; idx++) {
        if (cancelled) return;
        const spec = pages[idx];
        let spans = textCacheRef.current.get(spec.id);
        if (!spans) {
          if (spec.source === "blank") {
            spans = [];
          } else {
            const doc = spec.source === "base" ? baseDoc : spec.mergedIndex !== undefined ? mergedDocs[spec.mergedIndex] ?? null : null;
            if (doc && spec.sourcePageIndex !== undefined) {
              try {
                const page = await doc.getPage(spec.sourcePageIndex + 1);
                if (cancelled) return;
                const tc = await page.getTextContent();
                spans = [];
                for (const item of tc.items) {
                  if ("str" in item && item.str) spans.push(item.str);
                }
              } catch {
                spans = [];
              }
            } else {
              spans = [];
            }
          }
          textCacheRef.current.set(spec.id, spans);
        }
        const hits = findSpanMatches(spans, q);
        for (const spanIndices of hits) {
          found.push({ pageIndex: idx, pageId: spec.id, spanIndices });
        }
      }
      if (cancelled) return;
      setSearchMatches(found);
      setMatchCursor(0);
      if (found.length) jumpToPage(found[0].pageIndex);
    })();
    return () => { cancelled = true; };
  }, [searchQuery, pages, baseDoc, mergedDocs, jumpToPage]);

  const stepMatch = (delta: number) => {
    if (!searchMatches.length) return;
    const next = (matchCursor + delta + searchMatches.length) % searchMatches.length;
    setMatchCursor(next);
    jumpToPage(searchMatches[next].pageIndex);
  };

  const matchMaps = useMemo(() => {
    const allByPage = new Map<string, Set<number>>();
    const activeByPage = new Map<string, Set<number>>();
    searchMatches.forEach((m, i) => {
      let set = allByPage.get(m.pageId);
      if (!set) { set = new Set(); allByPage.set(m.pageId, set); }
      for (const s of m.spanIndices) set.add(s);
      if (i === matchCursor) {
        activeByPage.set(m.pageId, new Set(m.spanIndices));
      }
    });
    return { allByPage, activeByPage };
  }, [searchMatches, matchCursor]);

  const handleColorPick = (hex: string) => {
    setColor(hex);
    if (editing && selectedAnn) {
      const target = session.edits.annotations.find((a) => a.id === selectedAnn);
      if (target && target.kind !== "image") {
        updatePdfAnnotation(key, target.id, { color: hex });
      }
    }
  };

  const handleInsertImage = async (f: File) => {
    if (!/^image\/(png|jpeg|jpg)$/i.test(f.type)) {
      toast("PDF stamps support PNG and JPEG images", "warn");
      return;
    }
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error("Could not read image"));
      reader.readAsDataURL(f);
    });
    const targetPage = pages[activePage] ?? pages[0];
    if (!targetPage) return;
    const sz = pageSizesRef.current.get(targetPage.id) ?? { w: 612, h: 792 };
    const pos = centeredBoxOnPage(sz.w, sz.h, 180, 120);
    const id = uid("img");
    addPdfAnnotation(key, { id, pageId: targetPage.id, kind: "image", x: pos.x, y: pos.y, width: 180, height: 120, dataUrl });
    setSelectedAnn(id);
    setTool("select");
  };

  const handleMergePdf = async () => {
    try {
      const bytes = await pickPdfForMerge();
      if (!bytes) return;
      const count = await mergePdfBytes(key, bytes);
      toast(`Appended ${count} ${count === 1 ? "page" : "pages"} from the selected PDF. Press Ctrl+S to save.`);
    } catch (e) {
      toast(classify(e).message, "error");
    }
  };

  const handleExtractPages = async () => {
    if (!session.baseBytes) return;
    if (isLoose(file)) {
      toast("Extracting pages is available for PDFs inside a folder notebook.", "warn");
      return;
    }
    const specs = selectedPageIds.size
      ? pages.filter((p) => selectedPageIds.has(p.id))
      : pages[activePage] ? [pages[activePage]] : [];
    if (!specs.length) {
      toast("Select at least one page to extract.", "warn");
      return;
    }
    try {
      const extracted = await extractPdfPageSpecs(session.baseBytes, session.mergedSources, specs, session.edits.annotations);
      const folder = folderOf(file.path);
      const stem = fileName(file.path).replace(/\.pdf$/i, "");
      const outName = `${stem} (extracted ${Date.now().toString(36).slice(-4)}).pdf`;
      const outPath = folder ? `${folder}/${outName}` : outName;
      await createPdfBytes(file.notebook, outPath, extracted);
      toast(`Extracted ${specs.length} ${specs.length === 1 ? "page" : "pages"} to ${outName}`);
    } catch (e) {
      toast(classify(e).message, "error");
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const inInput = !!(e.target as HTMLElement)?.closest?.("input, textarea, select");
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
      e.preventDefault();
      setSearchOpen(true);
    } else if (editing && !inInput && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) redoPdf(key);
      else undoPdf(key);
    } else if (editing && !inInput && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
      e.preventDefault();
      redoPdf(key);
    } else if (editing && !inInput && selectedAnn && (e.key === "Delete" || e.key === "Backspace")) {
      e.preventDefault();
      removePdfAnnotation(key, selectedAnn);
      setSelectedAnn(null);
    }
  };

  if (needPassword) {
    return (
      <div className="center">
        <div className="card">
          <h3>Password-protected PDF</h3>
          <p className="muted small">Enter the document password to view this PDF. Password-protected PDFs open read-only.</p>
          <input type="password" value={password} placeholder="Password" onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void loadBase(password); }} />
          <div className="actions">
            <button type="button" className="primary" onClick={() => void loadBase(password)}>Unlock</button>
          </div>
        </div>
      </div>
    );
  }

  if (loadError) {
    return <div className="center"><div className="card"><p className="error">{loadError}</p></div></div>;
  }

  const activeSpec = pages[activePage];
  const emptySet: ReadonlySet<number> = new Set();

  return (
    <div className="pdf-shell" tabIndex={0} onKeyDown={onKeyDown}>
      <div className="pdf-toolbar" role="toolbar" aria-label="PDF controls">
        <button type="button" className={sidebar === "thumbs" ? "on" : ""} onClick={() => setSidebar(sidebar === "thumbs" ? null : "thumbs")} title="Pages">
          <Layers size="1em" aria-hidden /> Pages
        </button>
        {outline.length > 0 && (
          <button type="button" className={sidebar === "outline" ? "on" : ""} onClick={() => setSidebar(sidebar === "outline" ? null : "outline")}>Outline</button>
        )}
        <span className="canvas-sep" aria-hidden />
        <button type="button" onClick={() => jumpToPage(activePage - 1)} disabled={activePage <= 0} aria-label="Previous page"><ChevronLeft size="1em" aria-hidden /></button>
        <span className="small muted">{pages.length ? `${activePage + 1} / ${pages.length}` : "-"}</span>
        <button type="button" onClick={() => jumpToPage(activePage + 1)} disabled={activePage >= pages.length - 1} aria-label="Next page"><ChevronRight size="1em" aria-hidden /></button>
        <span className="canvas-sep" aria-hidden />
        <button type="button" onClick={() => setScale((s) => Math.max(0.4, +(s - 0.15).toFixed(2)))} aria-label="Zoom out"><Minus size="1em" aria-hidden /></button>
        <span className="small">{Math.round(scale * 100)}%</span>
        <button type="button" onClick={() => setScale((s) => Math.min(3, +(s + 0.15).toFixed(2)))} aria-label="Zoom in"><Plus size="1em" aria-hidden /></button>
        <span className="canvas-sep" aria-hidden />
        <button type="button" className={searchOpen ? "on" : ""} onClick={() => setSearchOpen(!searchOpen)} title="Find in PDF (Ctrl+F)">
          <Search size="1em" aria-hidden /> Find
        </button>
        {searchOpen && (
          <>
            <input
              className="pdf-search-input"
              autoFocus
              value={searchQuery}
              placeholder="Search text…"
              aria-label="Search PDF text"
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); stepMatch(e.shiftKey ? -1 : 1); }
                else if (e.key === "Escape") { e.preventDefault(); setSearchOpen(false); }
              }}
            />
            {searchQuery.trim() && (
              <>
                <span className="small muted" role="status">
                  {searchMatches.length ? `${matchCursor + 1} / ${searchMatches.length}` : "0 matches"}
                </span>
                <button type="button" disabled={!searchMatches.length} onClick={() => stepMatch(-1)} aria-label="Previous match" title="Previous match (Shift+Enter)">
                  <ChevronLeft size="0.9em" aria-hidden />
                </button>
                <button type="button" disabled={!searchMatches.length} onClick={() => stepMatch(1)} aria-label="Next match" title="Next match (Enter)">
                  <ChevronRight size="0.9em" aria-hidden />
                </button>
              </>
            )}
          </>
        )}
      </div>

      {editing && (
        <div className="pdf-toolbar pdf-edit-bar" role="toolbar" aria-label="PDF editing tools">
          <button type="button" onClick={() => undoPdf(key)} disabled={!session.past.length} title="Undo (Ctrl+Z)"><Undo2 size="1em" aria-hidden /></button>
          <button type="button" onClick={() => redoPdf(key)} disabled={!session.future.length} title="Redo (Ctrl+Y)"><Redo2 size="1em" aria-hidden /></button>
          <span className="canvas-sep" aria-hidden />
          <button type="button" className={tool === "select" ? "on" : ""} onClick={() => setTool("select")}>Select</button>
          <button type="button" className={tool === "highlight" ? "on" : ""} onClick={() => setTool("highlight")} title="Highlight"><Highlighter size="1em" aria-hidden /></button>
          <button type="button" className={tool === "underline" ? "on" : ""} onClick={() => setTool("underline")} title="Underline"><Underline size="1em" aria-hidden /></button>
          <button type="button" className={tool === "strikeout" ? "on" : ""} onClick={() => setTool("strikeout")} title="Strikethrough"><Strikethrough size="1em" aria-hidden /></button>
          <button type="button" className={tool === "note" ? "on" : ""} onClick={() => setTool("note")} title="Sticky note"><StickyNote size="1em" aria-hidden /></button>
          <button type="button" className={tool === "textbox" ? "on" : ""} onClick={() => setTool("textbox")} title="Text box"><Type size="1em" aria-hidden /></button>
          <button type="button" className={tool === "whiteout" ? "on" : ""} onClick={() => setTool("whiteout")} title="Whiteout and replace text"><Eraser size="1em" aria-hidden /> Whiteout</button>
          <button type="button" className={tool === "ink" ? "on" : ""} onClick={() => setTool("ink")} title="Freehand draw"><PenTool size="1em" aria-hidden /></button>
          <button type="button" className={tool === "rect" ? "on" : ""} onClick={() => setTool("rect")} title="Rectangle"><Square size="1em" aria-hidden /></button>
          <button type="button" className={tool === "line" ? "on" : ""} onClick={() => setTool("line")} title="Line"><Slash size="1em" aria-hidden /> Line</button>
          <button type="button" className={tool === "arrow" ? "on" : ""} onClick={() => setTool("arrow")}>Arrow</button>
          <button type="button" onClick={() => setShowSig(true)}>Signature</button>
          <button type="button" onClick={() => imageInput.current?.click()} title="Insert image"><ImagePlus size="1em" aria-hidden /></button>
          <input ref={imageInput} type="file" accept="image/png,image/jpeg" hidden
            onChange={(ev) => { const f = ev.target.files?.[0]; ev.target.value = ""; if (f) void handleInsertImage(f); }} />
          <span className="canvas-sep" aria-hidden />
          {COLORS.map((hex) => (
            <button key={hex} type="button" className={`canvas-swatch${color === hex ? " on" : ""}`} style={{ background: hex }} title={`Color ${hex}`} onClick={() => handleColorPick(hex)} />
          ))}
          <span className="canvas-sep" aria-hidden />
          {activeSpec && (
            <>
              <button type="button" onClick={() => rotatePdfPage(key, activeSpec.id, 270)} title="Rotate page left"><RotateCcw size="1em" aria-hidden /></button>
              <button type="button" onClick={() => rotatePdfPage(key, activeSpec.id, 90)} title="Rotate page right"><RotateCw size="1em" aria-hidden /></button>
            </>
          )}
          <button type="button" onClick={() => insertBlankPdfPage(key, activePage)} title="Insert blank page"><FilePlus size="1em" aria-hidden /> +Page</button>
          <button type="button" onClick={() => void handleMergePdf()} title="Merge another PDF"><Files size="1em" aria-hidden /> Merge PDF…</button>
          <button type="button" onClick={() => void handleExtractPages()} title="Extract selected/current pages to a new PDF">Extract…</button>
        </div>
      )}

      <div className="pdf-body">
        {sidebar && (
          <aside className="pdf-sidebar" aria-label={sidebar === "outline" ? "Outline" : "Pages"}>
            {sidebar === "outline" ? (
              <ul className="pdf-outline">
                {outline.map((item, i) => (
                  <li key={i} style={{ paddingLeft: `${item.depth * 0.75}rem` }}>
                    <button type="button" className="link" onClick={() => jumpToPage(item.pageIndex)}>{item.title}</button>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="pdf-thumbs">
                {pages.map((p, idx) => (
                  <div key={p.id} className={`pdf-thumb-row${idx === activePage ? " on" : ""}`}>
                    {editing && (
                      <input
                        type="checkbox"
                        aria-label={`Select page ${idx + 1}`}
                        checked={selectedPageIds.has(p.id)}
                        onChange={(e) => setSelectedPageIds((prev) => {
                          const next = new Set(prev);
                          if (e.target.checked) next.add(p.id); else next.delete(p.id);
                          return next;
                        })}
                      />
                    )}
                    <button type="button" className="pdf-thumb-btn" onClick={() => jumpToPage(idx)}>
                      Page {idx + 1}{p.source === "blank" ? " (blank)" : p.source === "merged" ? " (merged)" : ""}
                      {p.rotation ? ` · ${p.rotation}°` : ""}
                    </button>
                    {editing && (
                      <div className="pdf-thumb-ops">
                        <button type="button" disabled={idx === 0} onClick={() => reorderPdfPages(key, idx, idx - 1)} title="Move up"><ArrowUp size="0.85em" aria-hidden /></button>
                        <button type="button" disabled={idx === pages.length - 1} onClick={() => reorderPdfPages(key, idx, idx + 1)} title="Move down"><ArrowDown size="0.85em" aria-hidden /></button>
                        <button type="button" disabled={pages.length <= 1} onClick={() => deletePdfPage(key, p.id)} title="Delete page"><Trash2 size="0.85em" aria-hidden /></button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </aside>
        )}

        <div className="pdf-pages-scroll" ref={scrollRef}>
          {!baseDoc && !loadError ? (
            <div className="center muted">Loading PDF pages…</div>
          ) : (
            pages.map((spec, idx) => (
              <PdfPageCard
                key={spec.id}
                spec={spec}
                index={idx}
                inWindow={Math.abs(idx - activePage) <= RENDER_WINDOW}
                baseDoc={baseDoc}
                mergedDocs={mergedDocs}
                scale={scale}
                editing={editing}
                tool={tool}
                color={color}
                selectedAnn={selectedAnn}
                annotations={session.edits.annotations.filter((a) => a.pageId === spec.id)}
                formFields={spec.source === "base" ? session.formFields.filter((f) => f.pageIndex === spec.sourcePageIndex) : []}
                formValues={session.edits.formValues}
                matchedSpans={matchMaps.allByPage.get(spec.id) ?? emptySet}
                activeMatchSpans={matchMaps.activeByPage.get(spec.id) ?? emptySet}
                onSelectAnn={setSelectedAnn}
                onPageSize={recordPageSize}
                onAddAnn={(ann) => addPdfAnnotation(key, ann)}
                onUpdateAnn={(id, patch) => updatePdfAnnotation(key, id, patch)}
                onDeleteAnn={(id) => removePdfAnnotation(key, id)}
                onFormChange={(name, val) => setPdfFormValue(key, name, val)}
              />
            ))
          )}
        </div>
      </div>

      {showSig && (
        <SignatureModal
          onClose={() => setShowSig(false)}
          onApply={(dataUrl) => {
            setShowSig(false);
            const targetPage = pages[activePage] ?? pages[0];
            if (!targetPage) return;
            const sz = pageSizesRef.current.get(targetPage.id) ?? { w: 612, h: 792 };
            const pos = centeredBoxOnPage(sz.w, sz.h, 170, 70);
            const id = uid("sig");
            addPdfAnnotation(key, { id, pageId: targetPage.id, kind: "image", x: pos.x, y: pos.y, width: 170, height: 70, dataUrl });
            setSelectedAnn(id);
            setTool("select");
            toast("Signature placed on page. Drag to reposition or press Ctrl+S to save.");
          }}
        />
      )}
    </div>
  );
}
