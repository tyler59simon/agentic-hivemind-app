// Virtualized multi-page PDF viewer & offline interactive annotator/page-organizer built on `pdfjs-dist` (zero iframes).
// Annotations and form overlays use PDF.js viewport transforms (`convertToPdfPoint` / `convertToViewportPoint`) so
// coordinates stay exact across rotated pages, non-default crop boxes, and zoom levels.
import type { PDFDocumentProxy, PageViewport, RenderTask } from "pdfjs-dist";
import {
  ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Eraser, FilePlus, Files, Highlighter, ImagePlus,
  Layers, Minus, PenTool, Plus, Redo2, RotateCcw, RotateCw, Search, Square, StickyNote, Strikethrough,
  Trash2, Type, Underline, Undo2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FileRef } from "../../documents/keys";
import { classify } from "../../lib/errors";
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

type Tool = "select" | "highlight" | "underline" | "strikeout" | "note" | "textbox" | "whiteout" | "ink" | "rect" | "arrow" | "line";

const COLORS = ["#fef08a", "#bbf7d0", "#bfdbfe", "#fecaca", "#dc2626", "#1a73e8", "#111827"];
const RANGE_CHUNK = 256 * 1024;

interface OutlineItem { title: string; pageIndex: number }

export interface PdfViewerProps {
  file: FileRef;
  session: PdfSession;
  editing: boolean;
}

interface CoordMapper {
  width: number;
  height: number;
  toPdf: (vx: number, vy: number) => PdfPoint;
  toView: (px: number, py: number) => { x: number; y: number };
}

function makeMapperFromViewport(vp: PageViewport): CoordMapper {
  return {
    width: Math.floor(vp.width),
    height: Math.floor(vp.height),
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

interface PageCardProps {
  spec: PdfPageSpec;
  index: number;
  baseDoc: PDFDocumentProxy | null;
  mergedDocs: (PDFDocumentProxy | null)[];
  scale: number;
  editing: boolean;
  tool: Tool;
  color: string;
  annotations: PdfAnnotation[];
  formFields: PdfFormFieldInfo[];
  formValues: Record<string, string | boolean | string[]>;
  searchQuery: string;
  onAddAnn: (ann: PdfAnnotation) => void;
  onUpdateAnn: (id: string, patch: Partial<PdfAnnotation>) => void;
  onDeleteAnn: (id: string) => void;
  onFormChange: (name: string, val: string | boolean | string[]) => void;
}

function PdfPageCard({
  spec, index, baseDoc, mergedDocs, scale, editing, tool, color, annotations, formFields, formValues, searchQuery,
  onAddAnn, onUpdateAnn, onDeleteAnn, onFormChange,
}: PageCardProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const renderTaskRef = useRef<RenderTask | null>(null);
  const renderChainRef = useRef<Promise<void>>(Promise.resolve());
  const [visible, setVisible] = useState(index < 3);
  const [mapper, setMapper] = useState<CoordMapper>(() => makeBlankMapper(scale, spec.rotation));
  const [textItems, setTextItems] = useState<{ str: string; left: number; top: number; height: number }[]>([]);
  const [draftInk, setDraftInk] = useState<{ x: number; y: number }[] | null>(null);
  const [draftBox, setDraftBox] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const [selectedAnn, setSelectedAnn] = useState<string | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof IntersectionObserver === "undefined") { setVisible(true); return; }
    const obs = new IntersectionObserver(
      (entries) => { if (entries.some((e) => e.isIntersecting)) setVisible(true); },
      { rootMargin: "400px 0px" },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  const srcDoc = spec.source === "base" ? baseDoc : spec.source === "merged" && spec.mergedIndex !== undefined ? mergedDocs[spec.mergedIndex] ?? null : null;

  useEffect(() => {
    if (!visible) return;
    if (spec.source === "blank") {
      renderTaskRef.current?.cancel();
      const next = makeBlankMapper(scale, spec.rotation);
      setMapper(next);
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
    // Cancel any in-flight render on this canvas and wait for it to settle before reusing the canvas.
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
        setMapper(makeMapperFromViewport(vp));
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
  }, [visible, srcDoc, spec.source, spec.sourcePageIndex, spec.rotation, scale]);

  const viewPos = (e: React.PointerEvent) => {
    const r = wrapRef.current!.getBoundingClientRect();
    return {
      x: Math.min(r.width, Math.max(0, e.clientX - r.left)),
      y: Math.min(r.height, Math.max(0, e.clientY - r.top)),
    };
  };

  const onOverlayDown = (e: React.PointerEvent) => {
    if (!editing || tool === "select" || e.button !== 0) return;
    if ((e.target as HTMLElement).closest(".pdf-ann-interactive, input, textarea, select, button")) return;
    e.preventDefault();
    const vp = viewPos(e);
    if (tool === "note") {
      const pt = mapper.toPdf(vp.x, vp.y);
      const id = uid("note");
      onAddAnn({ id, pageId: spec.id, kind: "note", x: pt.x, y: pt.y, text: "Note", color: "#fef08a" });
      setSelectedAnn(id);
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
      setSelectedAnn(id);
    } else if (tool === "ink") {
      setDraftInk([vp]);
    } else {
      setDraftBox({ x1: vp.x, y1: vp.y, x2: vp.x, y2: vp.y });
    }
  };

  const onOverlayMove = (e: React.PointerEvent) => {
    if (draftInk) setDraftInk((pts) => (pts ? [...pts, viewPos(e)] : null));
    else if (draftBox) {
      const p = viewPos(e);
      setDraftBox((b) => (b ? { ...b, x2: p.x, y2: p.y } : null));
    }
  };

  const onOverlayUp = () => {
    if (draftInk) {
      if (draftInk.length >= 2) {
        const pdfPts = draftInk.map((pt) => mapper.toPdf(pt.x, pt.y));
        onAddAnn({ id: uid("ink"), pageId: spec.id, kind: "ink", points: pdfPts, color: color === "#fef08a" ? "#dc2626" : color, width: 2.5 });
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
          onAddAnn({ id: uid(tool), pageId: spec.id, kind: tool, rects: [rect], color });
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
          setSelectedAnn(id);
        } else if (tool === "rect" || tool === "line" || tool === "arrow") {
          const p1 = mapper.toPdf(draftBox.x1, draftBox.y1);
          const p2 = mapper.toPdf(draftBox.x2, draftBox.y2);
          onAddAnn({ id: uid("shp"), pageId: spec.id, kind: "shape", shape: tool, x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, color: color === "#fef08a" ? "#dc2626" : color, width: 2 });
        }
      }
      setDraftBox(null);
    }
  };

  const q = searchQuery.trim().toLowerCase();

  return (
    <div
      ref={wrapRef}
      data-pdf-page={index + 1}
      className="pdf-page-card"
      style={{ width: mapper.width, height: mapper.height }}
      onPointerDown={onOverlayDown}
      onPointerMove={onOverlayMove}
      onPointerUp={onOverlayUp}
    >
      <canvas ref={canvasRef} className="pdf-page-canvas" />

      {/* Selectable text & search highlight layer */}
      <div className="pdf-text-layer" style={{ pointerEvents: editing && tool !== "select" ? "none" : "auto" }}>
        {textItems.map((it, idx) => {
          const hit = q.length > 0 && it.str.toLowerCase().includes(q);
          return (
            <span
              key={idx}
              className={hit ? "pdf-text-span hit" : "pdf-text-span"}
              style={{ left: it.left, top: it.top, fontSize: it.height }}
            >
              {it.str}
            </span>
          );
        })}
      </div>

      {/* Vector annotations (projected from PDF user-space points through current viewport transform) */}
      <svg className="pdf-ann-svg" viewBox={`0 0 ${Math.max(1, mapper.width)} ${Math.max(1, mapper.height)}`}>
        {annotations.map((ann) => {
          if (ann.kind === "highlight") {
            return ann.rects.map((r, i) => {
              const b = pdfRectToViewBox(r, mapper);
              return <rect key={`${ann.id}-${i}`} x={b.left} y={b.top} width={b.width} height={b.height} fill={ann.color} fillOpacity={0.35} />;
            });
          }
          if (ann.kind === "underline") {
            return ann.rects.map((r, i) => {
              const p1 = mapper.toView(r.x, r.y);
              const p2 = mapper.toView(r.x + r.width, r.y);
              return <line key={`${ann.id}-${i}`} x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke={ann.color} strokeWidth={Math.max(1.5, 1.5 * scale)} />;
            });
          }
          if (ann.kind === "strikeout") {
            return ann.rects.map((r, i) => {
              const p1 = mapper.toView(r.x, r.y + r.height / 2);
              const p2 = mapper.toView(r.x + r.width, r.y + r.height / 2);
              return <line key={`${ann.id}-${i}`} x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke={ann.color} strokeWidth={Math.max(1.5, 1.5 * scale)} />;
            });
          }
          if (ann.kind === "ink") {
            const pts = ann.points.map((p) => { const v = mapper.toView(p.x, p.y); return `${v.x},${v.y}`; }).join(" ");
            return <polyline key={ann.id} points={pts} fill="none" stroke={ann.color} strokeWidth={ann.width * scale} strokeLinecap="round" strokeLinejoin="round" />;
          }
          if (ann.kind === "shape") {
            const p1 = mapper.toView(ann.x1, ann.y1);
            const p2 = mapper.toView(ann.x2, ann.y2);
            if (ann.shape === "rect") {
              return <rect key={ann.id} x={Math.min(p1.x, p2.x)} y={Math.min(p1.y, p2.y)} width={Math.abs(p2.x - p1.x)} height={Math.abs(p2.y - p1.y)} fill="none" stroke={ann.color} strokeWidth={ann.width * scale} />;
            }
            return <line key={ann.id} x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke={ann.color} strokeWidth={ann.width * scale} />;
          }
          return null;
        })}
        {draftInk && <polyline points={draftInk.map((p) => `${p.x},${p.y}`).join(" ")} fill="none" stroke={color === "#fef08a" ? "#dc2626" : color} strokeWidth={2.5 * scale} />}
        {draftBox && (
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
        )}
      </svg>

      {/* Interactive overlay annotations (notes, textboxes, whiteout-replace, images/signatures) */}
      {annotations.map((ann) => {
        if (ann.kind === "note") {
          const pos = mapper.toView(ann.x, ann.y);
          return (
            <div key={ann.id} className="pdf-ann-interactive pdf-note-box" style={{ left: pos.x, top: pos.y, background: ann.color }}>
              {editing ? (
                <>
                  <textarea value={ann.text} rows={2} onChange={(e) => onUpdateAnn(ann.id, { text: e.target.value })} />
                  <button type="button" className="pdf-ann-del" onClick={() => onDeleteAnn(ann.id)} title="Remove note">×</button>
                </>
              ) : (
                <span>{ann.text}</span>
              )}
            </div>
          );
        }
        if (ann.kind === "textbox" || ann.kind === "whiteout") {
          const box = pdfRectToViewBox(ann, mapper);
          return (
            <div
              key={ann.id}
              className={`pdf-ann-interactive ${ann.kind === "whiteout" ? "pdf-whiteout-box" : "pdf-text-box"}${selectedAnn === ann.id ? " on" : ""}`}
              style={{
                left: box.left,
                top: box.top,
                width: Math.max(36, box.width),
                minHeight: Math.max(20, box.height),
                background: ann.kind === "whiteout" ? ann.bgColor : "transparent",
                color: ann.color,
                fontSize: ann.fontSize * scale,
              }}
              onClick={() => setSelectedAnn(ann.id)}
            >
              {editing ? (
                <>
                  <textarea
                    value={ann.text}
                    placeholder={ann.kind === "whiteout" ? "Replacement text…" : "Type text…"}
                    style={{ color: ann.color, fontSize: ann.fontSize * scale }}
                    onChange={(e) => onUpdateAnn(ann.id, { text: e.target.value })}
                  />
                  <button type="button" className="pdf-ann-del" onClick={() => onDeleteAnn(ann.id)} title="Remove">×</button>
                </>
              ) : (
                <span>{ann.text}</span>
              )}
            </div>
          );
        }
        if (ann.kind === "image") {
          const box = pdfRectToViewBox(ann, mapper);
          return (
            <div
              key={ann.id}
              className="pdf-ann-interactive pdf-img-stamp"
              style={{ left: box.left, top: box.top, width: Math.max(24, box.width), height: Math.max(16, box.height) }}
            >
              <img src={ann.dataUrl} alt="Stamped image" draggable={false} />
              {editing && <button type="button" className="pdf-ann-del" onClick={() => onDeleteAnn(ann.id)} title="Remove image">×</button>}
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
  const [tool, setTool] = useState<Tool>("select");
  const [color, setColor] = useState("#fef08a");
  const [showSig, setShowSig] = useState(false);
  const [selectedPages, setSelectedPages] = useState<Set<number>>(new Set());

  const loadBase = useCallback(async (pwd?: string) => {
    setLoadError(null);
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
        // Large (>64 MB) read-only PDFs stream via bounded `pdf_range` IPC chunks instead of `hmfile`'s 50 MB cap.
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
      // Extract outline bookmarks if present
      const rawOutline = await doc.getOutline().catch(() => null);
      if (rawOutline?.length) {
        const items: OutlineItem[] = [];
        for (const entry of rawOutline) {
          let idx = 0;
          if (typeof entry.dest === "string") {
            const dest = await doc.getDestination(entry.dest).catch(() => null);
            if (dest?.[0]) idx = await doc.getPageIndex(dest[0]).catch(() => 0);
          } else if (Array.isArray(entry.dest) && entry.dest[0]) {
            idx = await doc.getPageIndex(entry.dest[0]).catch(() => 0);
          }
          items.push({ title: entry.title, pageIndex: idx });
        }
        setOutline(items);
      } else {
        setOutline([]);
      }
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

  const jumpToPage = (idx: number) => {
    const clamped = Math.min(Math.max(0, idx), Math.max(0, pages.length - 1));
    setActivePage(clamped);
    scrollRef.current?.querySelector(`[data-pdf-page="${clamped + 1}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" });
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
    addPdfAnnotation(key, { id: uid("img"), pageId: targetPage.id, kind: "image", x: 90, y: 540, width: 180, height: 120, dataUrl });
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
    const indices = selectedPages.size
      ? [...selectedPages].sort((a, b) => a - b)
      : [activePage];
    const specs = indices.map((i) => pages[i]).filter((p): p is PdfPageSpec => !!p);
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
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
      e.preventDefault();
      setSearchOpen(true);
    } else if (editing && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
      if ((e.target as HTMLElement)?.closest?.("input, textarea")) return;
      e.preventDefault();
      if (e.shiftKey) redoPdf(key);
      else undoPdf(key);
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
        <span className="small muted">{pages.length ? `${activePage + 1} / ${pages.length}` : "—"}</span>
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
          <input
            className="pdf-search-input"
            autoFocus
            value={searchQuery}
            placeholder="Search text…"
            aria-label="Search PDF text"
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        )}
      </div>

      {editing && (
        <div className="pdf-toolbar pdf-edit-bar" role="toolbar" aria-label="PDF editing tools">
          <button type="button" onClick={() => undoPdf(key)} disabled={!session.past.length} title="Undo (Ctrl+Z)"><Undo2 size="1em" aria-hidden /></button>
          <button type="button" onClick={() => redoPdf(key)} disabled={!session.future.length} title="Redo"><Redo2 size="1em" aria-hidden /></button>
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
          <button type="button" className={tool === "arrow" ? "on" : ""} onClick={() => setTool("arrow")}>Arrow</button>
          <button type="button" onClick={() => setShowSig(true)}>Signature</button>
          <button type="button" onClick={() => imageInput.current?.click()} title="Insert image"><ImagePlus size="1em" aria-hidden /></button>
          <input ref={imageInput} type="file" accept="image/png,image/jpeg" hidden
            onChange={(ev) => { const f = ev.target.files?.[0]; ev.target.value = ""; if (f) void handleInsertImage(f); }} />
          <span className="canvas-sep" aria-hidden />
          {COLORS.map((hex) => (
            <button key={hex} type="button" className={`canvas-swatch${color === hex ? " on" : ""}`} style={{ background: hex }} title={`Color ${hex}`} onClick={() => setColor(hex)} />
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
          <aside className="pdf-sidebar">
            {sidebar === "outline" ? (
              <ul className="pdf-outline">
                {outline.map((item, i) => (
                  <li key={i}><button type="button" className="link" onClick={() => jumpToPage(item.pageIndex)}>{item.title}</button></li>
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
                        checked={selectedPages.has(idx)}
                        onChange={(e) => setSelectedPages((prev) => {
                          const next = new Set(prev);
                          if (e.target.checked) next.add(idx); else next.delete(idx);
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
                baseDoc={baseDoc}
                mergedDocs={mergedDocs}
                scale={scale}
                editing={editing}
                tool={tool}
                color={color}
                annotations={session.edits.annotations.filter((a) => a.pageId === spec.id)}
                formFields={spec.source === "base" ? session.formFields.filter((f) => f.pageIndex === spec.sourcePageIndex) : []}
                formValues={session.edits.formValues}
                searchQuery={searchQuery}
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
            addPdfAnnotation(key, { id: uid("sig"), pageId: targetPage.id, kind: "image", x: 330, y: 120, width: 170, height: 70, dataUrl });
            toast("Signature placed on page. Press Ctrl+S to save.");
          }}
        />
      )}
    </div>
  );
}
