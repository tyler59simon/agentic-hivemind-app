// Virtualized multi-page PDF viewer & offline interactive annotator/page-organizer built on `pdfjs-dist` (zero iframes).
import type { PDFDocumentProxy } from "pdfjs-dist";
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
import { createPdfBytes, pickPdfForMerge } from "../../lib/pdf";
import { loadPdfjs } from "../../lib/pdfjs";
import { toast } from "../../ui/toast";
import { extractPdfPages, type NormPoint, type NormRect, type PdfAnnotation, type PdfFormFieldInfo, type PdfPageSpec } from "./pdfWriter";
import { SignatureModal } from "./SignatureModal";
import {
  addPdfAnnotation, deletePdfPage, insertBlankPdfPage, mergePdfBytes, pdfKey, redoPdf, removePdfAnnotation,
  reorderPdfPages, rotatePdfPage, setPdfFormValue, undoPdf, updatePdfAnnotation, type PdfSession,
} from "./store";

type Tool = "select" | "highlight" | "underline" | "strikeout" | "note" | "textbox" | "whiteout" | "ink" | "rect" | "arrow" | "line";

const COLORS = ["#fef08a", "#bbf7d0", "#bfdbfe", "#fecaca", "#dc2626", "#1a73e8", "#111827"];

interface OutlineItem { title: string; pageIndex: number }

export interface PdfViewerProps {
  file: FileRef;
  session: PdfSession;
  editing: boolean;
  /** Optional `hmfile` URL for >64 MB read-only PDFs that stay on disk. */
  streamUrl?: string;
}

function uid(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Sample RGB hex from a rendered canvas at normalized `(nx, ny)`, defaulting to `#ffffff`. */
function sampleCanvasBg(canvas: HTMLCanvasElement | null, nx: number, ny: number): string {
  if (!canvas || canvas.width < 2 || canvas.height < 2) return "#ffffff";
  try {
    const ctx = canvas.getContext("2d");
    if (!ctx) return "#ffffff";
    const x = Math.min(canvas.width - 1, Math.max(0, Math.round(nx * canvas.width)));
    const y = Math.min(canvas.height - 1, Math.max(0, Math.round(ny * canvas.height)));
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
  const [visible, setVisible] = useState(index < 3);
  const [dims, setDims] = useState({ width: Math.round(612 * scale), height: Math.round(792 * scale) });
  const [textItems, setTextItems] = useState<{ str: string; left: number; top: number; height: number }[]>([]);
  const [draftInk, setDraftInk] = useState<NormPoint[] | null>(null);
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
      const rot = spec.rotation % 180 !== 0;
      const w = Math.round((rot ? 792 : 612) * scale);
      const h = Math.round((rot ? 612 : 792) * scale);
      setDims({ width: w, height: h });
      setTextItems([]);
      const c = canvasRef.current;
      if (c) {
        c.width = w;
        c.height = h;
        const ctx = c.getContext("2d");
        if (ctx) { ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, w, h); }
      }
      return;
    }
    if (!srcDoc || spec.sourcePageIndex === undefined) return;
    let cancelled = false;
    void (async () => {
      try {
        const page = await srcDoc.getPage(spec.sourcePageIndex! + 1);
        if (cancelled) return;
        const totalRot = (page.rotate + spec.rotation) % 360;
        const vp = page.getViewport({ scale, rotation: totalRot });
        const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
        const renderVp = page.getViewport({ scale: scale * dpr, rotation: totalRot });
        setDims({ width: Math.floor(vp.width), height: Math.floor(vp.height) });
        const c = canvasRef.current;
        if (c) {
          c.width = Math.floor(renderVp.width);
          c.height = Math.floor(renderVp.height);
          c.style.width = `${Math.floor(vp.width)}px`;
          c.style.height = `${Math.floor(vp.height)}px`;
          await page.render({ canvas: c, viewport: renderVp }).promise;
        }
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
        // Render error handled gracefully; blank canvas stays.
      }
    })();
    return () => { cancelled = true; };
  }, [visible, srcDoc, spec.source, spec.sourcePageIndex, spec.rotation, scale]);

  const normPos = (e: React.PointerEvent): NormPoint => {
    const r = wrapRef.current!.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - r.left) / Math.max(1, r.width))),
      y: Math.min(1, Math.max(0, (e.clientY - r.top) / Math.max(1, r.height))),
    };
  };

  const onOverlayDown = (e: React.PointerEvent) => {
    if (!editing || tool === "select" || e.button !== 0) return;
    if ((e.target as HTMLElement).closest(".pdf-ann-interactive, input, textarea, select, button")) return;
    e.preventDefault();
    const p = normPos(e);
    if (tool === "note") {
      const id = uid("note");
      onAddAnn({ id, pageId: spec.id, kind: "note", x: p.x, y: p.y, text: "Note", color: "#fef08a" });
      setSelectedAnn(id);
    } else if (tool === "textbox") {
      const id = uid("txt");
      onAddAnn({ id, pageId: spec.id, kind: "textbox", x: p.x, y: p.y, width: 0.28, height: 0.06, text: "Text", fontSize: 13, color: color === "#fef08a" ? "#111827" : color });
      setSelectedAnn(id);
    } else if (tool === "ink") {
      setDraftInk([p]);
    } else {
      setDraftBox({ x1: p.x, y1: p.y, x2: p.x, y2: p.y });
    }
  };

  const onOverlayMove = (e: React.PointerEvent) => {
    if (draftInk) setDraftInk((pts) => (pts ? [...pts, normPos(e)] : null));
    else if (draftBox) {
      const p = normPos(e);
      setDraftBox((b) => (b ? { ...b, x2: p.x, y2: p.y } : null));
    }
  };

  const onOverlayUp = () => {
    if (draftInk) {
      if (draftInk.length >= 2) {
        onAddAnn({ id: uid("ink"), pageId: spec.id, kind: "ink", points: draftInk, color: color === "#fef08a" ? "#dc2626" : color, width: 2.5 });
      }
      setDraftInk(null);
    } else if (draftBox) {
      const x = Math.min(draftBox.x1, draftBox.x2);
      const y = Math.min(draftBox.y1, draftBox.y2);
      const w = Math.abs(draftBox.x2 - draftBox.x1);
      const h = Math.abs(draftBox.y2 - draftBox.y1);
      if (w > 0.008 || h > 0.006) {
        if (tool === "highlight" || tool === "underline" || tool === "strikeout") {
          const rect: NormRect = { x, y, width: Math.max(0.01, w), height: Math.max(0.012, h) };
          onAddAnn({ id: uid(tool), pageId: spec.id, kind: tool, rects: [rect], color });
        } else if (tool === "whiteout") {
          const bgColor = sampleCanvasBg(canvasRef.current, x, y);
          const id = uid("wo");
          onAddAnn({ id, pageId: spec.id, kind: "whiteout", x, y, width: Math.max(0.05, w), height: Math.max(0.025, h), bgColor, text: "", fontSize: 12, color: "#111827" });
          setSelectedAnn(id);
        } else if (tool === "rect" || tool === "line" || tool === "arrow") {
          onAddAnn({ id: uid("shp"), pageId: spec.id, kind: "shape", shape: tool, x1: draftBox.x1, y1: draftBox.y1, x2: draftBox.x2, y2: draftBox.y2, color: color === "#fef08a" ? "#dc2626" : color, width: 2 });
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
      style={{ width: dims.width, height: dims.height }}
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

      {/* Vector annotations (highlights, underlines, strikeouts, ink, shapes) */}
      <svg className="pdf-ann-svg" viewBox="0 0 1000 1000" preserveAspectRatio="none">
        {annotations.map((ann) => {
          if (ann.kind === "highlight") {
            return ann.rects.map((r, i) => (
              <rect key={`${ann.id}-${i}`} x={r.x * 1000} y={r.y * 1000} width={r.width * 1000} height={r.height * 1000} fill={ann.color} fillOpacity={0.35} />
            ));
          }
          if (ann.kind === "underline") {
            return ann.rects.map((r, i) => (
              <line key={`${ann.id}-${i}`} x1={r.x * 1000} y1={(r.y + r.height) * 1000} x2={(r.x + r.width) * 1000} y2={(r.y + r.height) * 1000} stroke={ann.color} strokeWidth={3} />
            ));
          }
          if (ann.kind === "strikeout") {
            return ann.rects.map((r, i) => (
              <line key={`${ann.id}-${i}`} x1={r.x * 1000} y1={(r.y + r.height / 2) * 1000} x2={(r.x + r.width) * 1000} y2={(r.y + r.height / 2) * 1000} stroke={ann.color} strokeWidth={3} />
            ));
          }
          if (ann.kind === "ink") {
            return <polyline key={ann.id} points={ann.points.map((p) => `${p.x * 1000},${p.y * 1000}`).join(" ")} fill="none" stroke={ann.color} strokeWidth={ann.width * 1.5} strokeLinecap="round" strokeLinejoin="round" />;
          }
          if (ann.kind === "shape") {
            if (ann.shape === "rect") {
              return <rect key={ann.id} x={Math.min(ann.x1, ann.x2) * 1000} y={Math.min(ann.y1, ann.y2) * 1000} width={Math.abs(ann.x2 - ann.x1) * 1000} height={Math.abs(ann.y2 - ann.y1) * 1000} fill="none" stroke={ann.color} strokeWidth={ann.width * 1.5} />;
            }
            return <line key={ann.id} x1={ann.x1 * 1000} y1={ann.y1 * 1000} x2={ann.x2 * 1000} y2={ann.y2 * 1000} stroke={ann.color} strokeWidth={ann.width * 1.5} />;
          }
          return null;
        })}
        {draftInk && <polyline points={draftInk.map((p) => `${p.x * 1000},${p.y * 1000}`).join(" ")} fill="none" stroke={color === "#fef08a" ? "#dc2626" : color} strokeWidth={3} />}
        {draftBox && (
          <rect
            x={Math.min(draftBox.x1, draftBox.x2) * 1000}
            y={Math.min(draftBox.y1, draftBox.y2) * 1000}
            width={Math.abs(draftBox.x2 - draftBox.x1) * 1000}
            height={Math.abs(draftBox.y2 - draftBox.y1) * 1000}
            fill={tool === "whiteout" ? "#ffffff" : color}
            fillOpacity={tool === "whiteout" ? 0.9 : 0.25}
            stroke="var(--accent)"
            strokeWidth={2}
            strokeDasharray="6 4"
          />
        )}
      </svg>

      {/* Interactive overlay annotations (notes, textboxes, whiteout-replace, images/signatures) */}
      {annotations.map((ann) => {
        if (ann.kind === "note") {
          return (
            <div key={ann.id} className="pdf-ann-interactive pdf-note-box" style={{ left: `${ann.x * 100}%`, top: `${ann.y * 100}%`, background: ann.color }}>
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
          return (
            <div
              key={ann.id}
              className={`pdf-ann-interactive ${ann.kind === "whiteout" ? "pdf-whiteout-box" : "pdf-text-box"}${selectedAnn === ann.id ? " on" : ""}`}
              style={{
                left: `${ann.x * 100}%`,
                top: `${ann.y * 100}%`,
                width: `${ann.width * 100}%`,
                minHeight: `${ann.height * 100}%`,
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
          return (
            <div
              key={ann.id}
              className="pdf-ann-interactive pdf-img-stamp"
              style={{ left: `${ann.x * 100}%`, top: `${ann.y * 100}%`, width: `${ann.width * 100}%`, height: `${ann.height * 100}%` }}
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
        const val = formValues[field.name] ?? field.value;
        const style = {
          left: `${field.rect.x * 100}%`,
          top: `${field.rect.y * 100}%`,
          width: `${Math.max(0.03, field.rect.width) * 100}%`,
          height: `${Math.max(0.02, field.rect.height) * 100}%`,
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

export default function PdfViewer({ file, session, editing, streamUrl }: PdfViewerProps) {
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
      const pdfjs = await loadPdfjs();
      const src = session.baseBytes
        ? { data: session.baseBytes.slice(), useWasm: false, enableXfa: false, ...(pwd ? { password: pwd } : {}) }
        : streamUrl
          ? { url: streamUrl, useWasm: false, enableXfa: false, ...(pwd ? { password: pwd } : {}) }
          : null;
      if (!src) return;
      const task = pdfjs.getDocument(src);
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
  }, [session.baseBytes, streamUrl]);

  useEffect(() => {
    let cleanup: (() => void) | undefined;
    void loadBase().then((fn) => { cleanup = fn; });
    return () => { cleanup?.(); };
  }, [loadBase]);

  useEffect(() => {
    if (!session.mergedSources.length) { setMergedDocs([]); return; }
    let live = true;
    const tasks: { destroy(): Promise<void> }[] = [];
    void (async () => {
      const pdfjs = await loadPdfjs();
      const loaded: (PDFDocumentProxy | null)[] = [];
      for (const bytes of session.mergedSources) {
        const task = pdfjs.getDocument({ data: bytes.slice(), useWasm: false, enableXfa: false });
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
    addPdfAnnotation(key, { id: uid("img"), pageId: targetPage.id, kind: "image", x: 0.15, y: 0.15, width: 0.3, height: 0.18, dataUrl });
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
    const baseIndices = indices
      .map((i) => pages[i])
      .filter((p): p is PdfPageSpec => !!p && p.source === "base" && p.sourcePageIndex !== undefined)
      .map((p) => p.sourcePageIndex!);
    if (!baseIndices.length) {
      toast("Save merged/blank pages first before extracting them.", "warn");
      return;
    }
    try {
      const extracted = await extractPdfPages(session.baseBytes, baseIndices);
      const folder = folderOf(file.path);
      const stem = fileName(file.path).replace(/\.pdf$/i, "");
      const outName = `${stem} (extracted ${Date.now().toString(36).slice(-4)}).pdf`;
      const outPath = folder ? `${folder}/${outName}` : outName;
      await createPdfBytes(file.notebook, outPath, extracted);
      toast(`Extracted ${baseIndices.length} ${baseIndices.length === 1 ? "page" : "pages"} to ${outName}`);
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
            addPdfAnnotation(key, { id: uid("sig"), pageId: targetPage.id, kind: "image", x: 0.55, y: 0.72, width: 0.28, height: 0.1, dataUrl });
            toast("Signature placed on page. Press Ctrl+S to save.");
          }}
        />
      )}
    </div>
  );
}
