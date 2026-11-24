// Pure immutable Draw.io diagram model, nested container geometry resolution, edge routing, and mutations.
import { parseStyle, updateStyle } from "./style";

export interface DrawioPoint { x: number; y: number }
export interface DrawioRect { x: number; y: number; width: number; height: number }

export interface DrawioGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
  relative?: boolean;
  sourcePoint?: DrawioPoint;
  targetPoint?: DrawioPoint;
  points?: DrawioPoint[];
}

export interface DrawioCell {
  id: string;
  parent: string;
  value: string;
  style: string;
  vertex: boolean;
  edge: boolean;
  source?: string;
  target?: string;
  geometry?: DrawioGeometry;
  /** Unknown `<mxCell>` attributes preserved verbatim on save. */
  extraAttrs: Record<string, string>;
  /** Unknown `<mxCell>` child XML preserved verbatim on save. */
  extraChildrenXml?: string;
}

export interface DrawioPage {
  id: string;
  name: string;
  compressed: boolean;
  diagramAttrs: Record<string, string>;
  modelAttrs: Record<string, string>;
  cells: DrawioCell[];
}

export interface DrawioDoc {
  fileAttrs: Record<string, string>;
  pages: DrawioPage[];
}

export interface DrawioView { x: number; y: number; k: number }

const GRID = 8;
const snap = (n: number) => Math.round(n / GRID) * GRID;

/** Resolve absolute world rects for every vertex cell by accumulating parent offsets (with cycle guard). */
export function absoluteRects(cells: DrawioCell[]): Map<string, DrawioRect> {
  const byId = new Map(cells.map((c) => [c.id, c]));
  const cache = new Map<string, DrawioRect>();
  const visiting = new Set<string>();

  const resolve = (id: string): DrawioRect | null => {
    const cached = cache.get(id);
    if (cached) return cached;
    if (visiting.has(id)) return null;
    const cell = byId.get(id);
    if (!cell || !cell.vertex || !cell.geometry) return null;
    visiting.add(id);
    let ox = 0;
    let oy = 0;
    if (cell.parent && cell.parent !== "0" && cell.parent !== "1") {
      const pRect = resolve(cell.parent);
      if (pRect) { ox = pRect.x; oy = pRect.y; }
    }
    visiting.delete(id);
    const rect: DrawioRect = {
      x: ox + cell.geometry.x,
      y: oy + cell.geometry.y,
      width: cell.geometry.width,
      height: cell.geometry.height,
    };
    cache.set(id, rect);
    return rect;
  };

  for (const c of cells) {
    if (c.vertex && c.geometry) resolve(c.id);
  }
  return cache;
}

/** All descendant cell ids of `roots` (not including `roots` themselves). */
export function descendantIds(cells: DrawioCell[], roots: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of cells) {
      if (!out.has(c.id) && (roots.has(c.parent) || out.has(c.parent))) {
        out.add(c.id);
        grew = true;
      }
    }
  }
  return out;
}

/** Return the boundary point on `rect` for a normalized `(nx, ny)` port, or toward `other` when null. */
function portPoint(rect: DrawioRect, nx: number | null, ny: number | null, other: DrawioPoint): DrawioPoint {
  if (nx !== null && ny !== null) {
    return { x: rect.x + rect.width * nx, y: rect.y + rect.height * ny };
  }
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const dx = other.x - cx;
  const dy = other.y - cy;
  if (Math.abs(dx) < 0.001 && Math.abs(dy) < 0.001) return { x: cx, y: cy };
  const hw = rect.width / 2;
  const hh = rect.height / 2;
  const tx = Math.abs(dx) > 0.001 ? hw / Math.abs(dx) : Infinity;
  const ty = Math.abs(dy) > 0.001 ? hh / Math.abs(dy) : Infinity;
  const t = Math.min(tx, ty);
  return { x: cx + dx * t, y: cy + dy * t };
}

/** Compute the ordered polyline points for an edge cell in absolute world coordinates. */
export function edgePoints(cell: DrawioCell, rects: Map<string, DrawioRect>): DrawioPoint[] {
  const st = parseStyle(cell.style);
  const srcRect = cell.source ? rects.get(cell.source) : undefined;
  const tgtRect = cell.target ? rects.get(cell.target) : undefined;
  const mid = cell.geometry?.points ?? [];

  const srcCenter = srcRect
    ? { x: srcRect.x + srcRect.width / 2, y: srcRect.y + srcRect.height / 2 }
    : cell.geometry?.sourcePoint ?? { x: 0, y: 0 };
  const tgtCenter = tgtRect
    ? { x: tgtRect.x + tgtRect.width / 2, y: tgtRect.y + tgtRect.height / 2 }
    : cell.geometry?.targetPoint ?? { x: srcCenter.x + 120, y: srcCenter.y };

  const towardFromSrc = mid[0] ?? tgtCenter;
  const towardFromTgt = mid[mid.length - 1] ?? srcCenter;
  const start = srcRect ? portPoint(srcRect, st.exitX, st.exitY, towardFromSrc) : srcCenter;
  const end = tgtRect ? portPoint(tgtRect, st.entryX, st.entryY, towardFromTgt) : tgtCenter;

  if (mid.length > 0) return [start, ...mid, end];
  if (st.edgeStyle && /orthogonal|elbow/i.test(st.edgeStyle)) {
    const mx = (start.x + end.x) / 2;
    return [start, { x: mx, y: start.y }, { x: mx, y: end.y }, end];
  }
  return [start, end];
}

/** Midpoint of a polyline, used to position inline edge labels. */
export function polylineMidpoint(pts: DrawioPoint[]): DrawioPoint {
  if (!pts.length) return { x: 0, y: 0 };
  if (pts.length === 1) return pts[0];
  let total = 0;
  const segs: number[] = [];
  for (let i = 1; i < pts.length; i++) {
    const len = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    segs.push(len);
    total += len;
  }
  let want = total / 2;
  for (let i = 0; i < segs.length; i++) {
    if (want <= segs[i] || i === segs.length - 1) {
      const t = segs[i] > 0 ? want / segs[i] : 0.5;
      return { x: pts[i].x + (pts[i + 1].x - pts[i].x) * t, y: pts[i].y + (pts[i + 1].y - pts[i].y) * t };
    }
    want -= segs[i];
  }
  return pts[0];
}

/** Fit every vertex cell of a page comfortably into a viewport of `width` x `height`. */
export function fitView(cells: DrawioCell[], width: number, height: number): DrawioView {
  const rects = [...absoluteRects(cells).values()];
  if (!rects.length || width <= 0 || height <= 0) return { x: 40, y: 40, k: 1 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.width);
    maxY = Math.max(maxY, r.y + r.height);
  }
  const w = Math.max(1, maxX - minX);
  const h = Math.max(1, maxY - minY);
  const pad = 64;
  const k = Math.min(1.5, Math.max(0.1, Math.min((width - pad) / w, (height - pad) / h)));
  return { x: (width - w * k) / 2 - minX * k, y: (height - h * k) / 2 - minY * k, k };
}

function updatePage(doc: DrawioDoc, pageIndex: number, fn: (page: DrawioPage) => DrawioPage): DrawioDoc {
  return { ...doc, pages: doc.pages.map((p, i) => (i === pageIndex ? fn(p) : p)) };
}

function nextCellId(cells: DrawioCell[], prefix = "c"): string {
  const used = new Set(cells.map((c) => c.id));
  for (let n = 1; n < 100_000; n++) {
    const id = `${prefix}-${n}`;
    if (!used.has(id)) return id;
  }
  return `${prefix}-${Date.now().toString(36)}`;
}

/** Move selected vertices by `(dx, dy)`. Skips children whose ancestor is also selected so nothing double-moves. */
export function moveCells(doc: DrawioDoc, pageIndex: number, ids: ReadonlySet<string>, dx: number, dy: number): DrawioDoc {
  const page = doc.pages[pageIndex];
  if (!page || (!dx && !dy)) return doc;
  const desc = descendantIds(page.cells, ids);
  return updatePage(doc, pageIndex, (p) => ({
    ...p,
    cells: p.cells.map((c) => {
      if (!ids.has(c.id) || desc.has(c.id) || !c.vertex || !c.geometry) return c;
      return { ...c, geometry: { ...c.geometry, x: Math.round(c.geometry.x + dx), y: Math.round(c.geometry.y + dy) } };
    }),
  }));
}

/** Resize a vertex cell from a corner (`nw`, `ne`, `sw`, `se`), snapping to an 8px grid. */
export function resizeCell(doc: DrawioDoc, pageIndex: number, id: string, corner: string, dx: number, dy: number): DrawioDoc {
  return updatePage(doc, pageIndex, (p) => ({
    ...p,
    cells: p.cells.map((c) => {
      if (c.id !== id || !c.geometry) return c;
      let { x, y, width, height } = c.geometry;
      if (corner.includes("e")) width = Math.max(24, snap(width + dx));
      if (corner.includes("s")) height = Math.max(16, snap(height + dy));
      if (corner.includes("w")) {
        const nextW = Math.max(24, snap(width - dx));
        x = x + (width - nextW);
        width = nextW;
      }
      if (corner.includes("n")) {
        const nextH = Math.max(16, snap(height - dy));
        y = y + (height - nextH);
        height = nextH;
      }
      return { ...c, geometry: { ...c.geometry, x, y, width, height } };
    }),
  }));
}

export function setCellLabel(doc: DrawioDoc, pageIndex: number, id: string, value: string): DrawioDoc {
  return updatePage(doc, pageIndex, (p) => ({
    ...p,
    cells: p.cells.map((c) => (c.id === id ? { ...c, value } : c)),
  }));
}

export function setCellStyle(doc: DrawioDoc, pageIndex: number, ids: ReadonlySet<string>, patch: Record<string, string | null | undefined>): DrawioDoc {
  return updatePage(doc, pageIndex, (p) => ({
    ...p,
    cells: p.cells.map((c) => (ids.has(c.id) ? { ...c, style: updateStyle(c.style, patch) } : c)),
  }));
}

export type NewShapePreset = "rect" | "rounded" | "container" | "cylinder" | "diamond" | "ellipse" | "text";

const PRESET_STYLES: Record<NewShapePreset, { style: string; width: number; height: number; value: string }> = {
  rect: { style: "whiteSpace=wrap;html=1;fillColor=#edf6ff;strokeColor=#438dd5;", width: 160, height: 72, value: "Box" },
  rounded: { style: "rounded=1;whiteSpace=wrap;html=1;fillColor=#edf6ff;strokeColor=#438dd5;", width: 160, height: 72, value: "Service" },
  container: { style: "rounded=1;whiteSpace=wrap;html=1;fillColor=#f8f9fa;strokeColor=#5f6368;dashed=1;verticalAlign=top;align=left;spacing=8;", width: 320, height: 200, value: "Group" },
  cylinder: { style: "shape=cylinder3;whiteSpace=wrap;html=1;boundedLbl=1;backgroundOutline=1;size=10;fillColor=#eaf6ec;strokeColor=#2e7d32;", width: 120, height: 96, value: "Database" },
  diamond: { style: "rhombus;whiteSpace=wrap;html=1;fillColor=#fff3e6;strokeColor=#e65100;", width: 120, height: 96, value: "Decision" },
  ellipse: { style: "ellipse;whiteSpace=wrap;html=1;fillColor=#f3e8ff;strokeColor=#7c3aed;", width: 140, height: 80, value: "Node" },
  text: { style: "text;html=1;align=left;verticalAlign=top;fontSize=14;", width: 160, height: 32, value: "Label" },
};

export function addShape(doc: DrawioDoc, pageIndex: number, preset: NewShapePreset, at: DrawioPoint): { doc: DrawioDoc; id: string } {
  const page = doc.pages[pageIndex];
  const spec = PRESET_STYLES[preset];
  const id = nextCellId(page.cells, "n");
  const cell: DrawioCell = {
    id,
    parent: "1",
    value: spec.value,
    style: spec.style,
    vertex: true,
    edge: false,
    geometry: { x: snap(at.x - spec.width / 2), y: snap(at.y - spec.height / 2), width: spec.width, height: spec.height },
    extraAttrs: {},
  };
  return {
    id,
    doc: updatePage(doc, pageIndex, (p) => ({ ...p, cells: [...p.cells, cell] })),
  };
}

export function addEdge(doc: DrawioDoc, pageIndex: number, source: string, target: string): { doc: DrawioDoc; id: string } {
  const page = doc.pages[pageIndex];
  const id = nextCellId(page.cells, "e");
  const cell: DrawioCell = {
    id,
    parent: "1",
    value: "",
    style: "edgeStyle=orthogonalEdgeStyle;rounded=0;endArrow=block;strokeColor=#526580;html=1;",
    vertex: false,
    edge: true,
    source,
    target,
    geometry: { x: 0, y: 0, width: 0, height: 0, relative: true },
    extraAttrs: {},
  };
  return {
    id,
    doc: updatePage(doc, pageIndex, (p) => ({ ...p, cells: [...p.cells, cell] })),
  };
}

/** Delete cells, their nested descendants, and any edges attached to removed vertices. */
export function deleteCells(doc: DrawioDoc, pageIndex: number, ids: ReadonlySet<string>): DrawioDoc {
  const page = doc.pages[pageIndex];
  if (!page || !ids.size) return doc;
  const doomed = new Set([...ids, ...descendantIds(page.cells, ids)]);
  doomed.delete("0");
  doomed.delete("1");
  return updatePage(doc, pageIndex, (p) => ({
    ...p,
    cells: p.cells.filter((c) => !doomed.has(c.id) && !(c.edge && ((c.source && doomed.has(c.source)) || (c.target && doomed.has(c.target))))),
  }));
}

/** Bring selected cells to front or send behind other siblings. */
export function reorderCells(doc: DrawioDoc, pageIndex: number, ids: ReadonlySet<string>, direction: "front" | "back"): DrawioDoc {
  return updatePage(doc, pageIndex, (p) => {
    const roots = p.cells.filter((c) => c.id === "0" || c.id === "1");
    const rest = p.cells.filter((c) => c.id !== "0" && c.id !== "1");
    const picked = rest.filter((c) => ids.has(c.id));
    const others = rest.filter((c) => !ids.has(c.id));
    return { ...p, cells: direction === "front" ? [...roots, ...others, ...picked] : [...roots, ...picked, ...others] };
  });
}

export function addPage(doc: DrawioDoc, name?: string): { doc: DrawioDoc; index: number } {
  const index = doc.pages.length;
  const id = `page-${index + 1}-${Date.now().toString(36)}`;
  const page: DrawioPage = {
    id,
    name: name ?? `Page-${index + 1}`,
    compressed: false,
    diagramAttrs: {},
    modelAttrs: { dx: "1200", dy: "800", grid: "1", gridSize: "10", guides: "1", tooltips: "1", connect: "1", arrows: "1", fold: "1", page: "1", pageScale: "1", pageWidth: "1169", pageHeight: "827" },
    cells: [
      { id: "0", parent: "", value: "", style: "", vertex: false, edge: false, extraAttrs: {} },
      { id: "1", parent: "0", value: "", style: "", vertex: false, edge: false, extraAttrs: {} },
    ],
  };
  return { doc: { ...doc, pages: [...doc.pages, page] }, index };
}

export function renamePage(doc: DrawioDoc, pageIndex: number, name: string): DrawioDoc {
  const clean = name.trim();
  if (!clean) return doc;
  return updatePage(doc, pageIndex, (p) => ({ ...p, name: clean }));
}

export function deletePage(doc: DrawioDoc, pageIndex: number): DrawioDoc {
  if (doc.pages.length <= 1) return doc;
  return { ...doc, pages: doc.pages.filter((_, i) => i !== pageIndex) };
}
