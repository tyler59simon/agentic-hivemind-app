// Shared pan/zoom viewport for SVG and Mermaid previews (no iframes).
// Drag background to pan, Ctrl+wheel to zoom toward the pointer, wheel alone to pan.
import { Maximize2, Minus, Plus, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

export type Backdrop = "checker" | "light" | "dark";

export interface PanZoomViewportProps {
  children: ReactNode;
  /** Initial backdrop when `showBackdropToggle` is enabled. */
  defaultBackdrop?: Backdrop;
  showBackdropToggle?: boolean;
  /** Short status text shown in the overlay bar (e.g. dimensions). */
  info?: string;
  /** Extra action buttons placed at the right end of the toolbar. */
  actions?: ReactNode;
  /** Changing this key re-fits the content to the viewport. */
  fitKey?: string | number;
  className?: string;
}

const MIN_K = 0.1;
const MAX_K = 16;
const STEP = 1.25;
const clamp = (k: number) => Math.min(MAX_K, Math.max(MIN_K, k));

export function PanZoomViewport({
  children,
  defaultBackdrop = "checker",
  showBackdropToggle = false,
  info,
  actions,
  fitKey,
  className = "",
}: PanZoomViewportProps) {
  const root = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const [backdrop, setBackdrop] = useState<Backdrop>(defaultBackdrop);
  const latest = useRef(view);
  latest.current = view;
  const drag = useRef<{ sx: number; sy: number; vx: number; vy: number } | null>(null);

  const fit = useCallback(() => {
    const box = root.current?.getBoundingClientRect();
    const inner = content.current;
    if (!box || !inner || box.width <= 0 || box.height <= 0) {
      setView({ x: 0, y: 0, k: 1 });
      return;
    }
    const w = inner.scrollWidth || inner.offsetWidth;
    const h = inner.scrollHeight || inner.offsetHeight;
    if (w <= 0 || h <= 0) {
      setView({ x: 0, y: 0, k: 1 });
      return;
    }
    const pad = 48;
    const k = clamp(Math.min((box.width - pad) / w, (box.height - pad) / h, 1));
    setView({ x: (box.width - w * k) / 2, y: (box.height - h * k) / 2, k });
  }, []);

  useLayoutEffect(() => {
    fit();
  }, [fit, fitKey]);

  const zoomAt = useCallback((factor: number, clientX?: number, clientY?: number) => {
    const box = root.current?.getBoundingClientRect();
    const cx = clientX !== undefined && box ? clientX - box.left : (box?.width ?? 0) / 2;
    const cy = clientY !== undefined && box ? clientY - box.top : (box?.height ?? 0) / 2;
    setView((v) => {
      const k = clamp(v.k * factor);
      const r = k / v.k;
      return { x: cx - (cx - v.x) * r, y: cy - (cy - v.y) * r, k };
    });
  }, []);

  const reset = useCallback(() => {
    const box = root.current?.getBoundingClientRect();
    const inner = content.current;
    if (!box || !inner) { setView({ x: 0, y: 0, k: 1 }); return; }
    const w = inner.scrollWidth || inner.offsetWidth;
    const h = inner.scrollHeight || inner.offsetHeight;
    setView({ x: (box.width - w) / 2, y: (box.height - h) / 2, k: 1 });
  }, []);

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const factor = Math.exp(-e.deltaY * 0.002);
        zoomAt(factor, e.clientX, e.clientY);
      } else {
        setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      setView((v) => ({ ...v, x: d.vx + (e.clientX - d.sx), y: d.vy + (e.clientY - d.sy) }));
    };
    const onUp = () => { drag.current = null; };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, []);

  return (
    <div
      ref={root}
      className={`panzoom-viewport ${showBackdropToggle ? `panzoom-bg-${backdrop}` : ""} ${className}`.trim()}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        if ((e.target as HTMLElement).closest(".panzoom-tools, a, button")) return;
        drag.current = { sx: e.clientX, sy: e.clientY, vx: latest.current.x, vy: latest.current.y };
      }}
    >
      <div className="panzoom-tools" role="toolbar" aria-label="Viewport controls">
        <button type="button" title="Zoom out" aria-label="Zoom out" onClick={() => zoomAt(1 / STEP)}><Minus size="1em" aria-hidden /></button>
        <button type="button" className="panzoom-zoom" title="Reset to 100%" onClick={reset}>{Math.round(view.k * 100)}%</button>
        <button type="button" title="Zoom in" aria-label="Zoom in" onClick={() => zoomAt(STEP)}><Plus size="1em" aria-hidden /></button>
        <button type="button" title="Fit to view" aria-label="Fit to view" onClick={fit}><Maximize2 size="1em" aria-hidden /></button>
        <button type="button" title="Reset view" aria-label="Reset view" onClick={reset}><RotateCcw size="1em" aria-hidden /></button>
        {showBackdropToggle && (
          <>
            <span className="canvas-sep" aria-hidden />
            {(["checker", "light", "dark"] as const).map((b) => (
              <button key={b} type="button" className={backdrop === b ? "on" : ""} onClick={() => setBackdrop(b)}>
                {b === "checker" ? "Checker" : b === "light" ? "Light" : "Dark"}
              </button>
            ))}
          </>
        )}
        {info && (
          <>
            <span className="canvas-sep" aria-hidden />
            <span className="muted small panzoom-info">{info}</span>
          </>
        )}
        {actions && (
          <>
            <span className="canvas-sep" aria-hidden />
            {actions}
          </>
        )}
      </div>
      <div className="panzoom-world" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
        <div ref={content} className="panzoom-content">{children}</div>
      </div>
    </div>
  );
}
