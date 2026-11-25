// Pure helpers for PdfViewer: nested outline extraction, cross-span full-document search,
// PDF user-space annotation transforms (move/resize), arrowhead geometry, and page placement.
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { PdfAnnotation, PdfRect } from "./pdfWriter";

export interface OutlineItem {
  title: string;
  pageIndex: number;
  depth: number;
}

export interface SearchMatch {
  pageIndex: number;
  pageId: string;
  spanIndices: number[];
}

interface RawOutlineNode {
  title: string;
  dest?: string | unknown[] | null;
  items?: RawOutlineNode[];
}

const MAX_OUTLINE_DEPTH = 12;

/** Recursively extract nested PDF outline bookmarks into a flat indented list with resolved 0-based page indices. */
export async function extractNestedOutline(doc: PDFDocumentProxy): Promise<OutlineItem[]> {
  const raw = (await doc.getOutline().catch(() => null)) as RawOutlineNode[] | null;
  if (!raw?.length) return [];
  const out: OutlineItem[] = [];

  const resolvePage = async (dest: RawOutlineNode["dest"]): Promise<number> => {
    try {
      let arr: unknown[] | null = null;
      if (typeof dest === "string") {
        arr = (await doc.getDestination(dest)) as unknown[] | null;
      } else if (Array.isArray(dest)) {
        arr = dest;
      }
      if (arr?.[0]) {
        return await doc.getPageIndex(arr[0] as Parameters<PDFDocumentProxy["getPageIndex"]>[0]);
      }
    } catch {
      // Unresolvable destination falls back to page 0.
    }
    return 0;
  };

  const walk = async (nodes: RawOutlineNode[], depth: number) => {
    if (depth > MAX_OUTLINE_DEPTH) return;
    for (const node of nodes) {
      const pageIndex = await resolvePage(node.dest);
      out.push({ title: node.title || "(untitled)", pageIndex, depth });
      if (node.items?.length) {
        await walk(node.items, depth + 1);
      }
    }
  };

  await walk(raw, 0);
  return out;
}

/** Find all case-insensitive occurrences of `query` across a page's `textItems` strings, including matches that span
 *  multiple adjacent items. Returns the list of covered span indices for each match. */
export function findSpanMatches(spans: readonly string[], query: string): number[][] {
  const q = query.trim().toLowerCase();
  if (!q || !spans.length) return [];
  const ranges: { idx: number; start: number; end: number }[] = [];
  let joined = "";
  for (let i = 0; i < spans.length; i++) {
    const s = spans[i];
    if (!s) continue;
    if (joined.length > 0 && !joined.endsWith(" ") && !s.startsWith(" ")) {
      joined += " ";
    }
    const start = joined.length;
    joined += s;
    ranges.push({ idx: i, start, end: joined.length });
  }
  const low = joined.toLowerCase();
  const out: number[][] = [];
  let pos = 0;
  while (pos <= low.length - q.length) {
    const hit = low.indexOf(q, pos);
    if (hit < 0) break;
    const hitEnd = hit + q.length;
    const covered: number[] = [];
    for (const r of ranges) {
      if (r.end > hit && r.start < hitEnd) covered.push(r.idx);
      else if (r.start >= hitEnd) break;
    }
    if (covered.length) out.push(covered);
    pos = hit + Math.max(1, q.length);
  }
  return out;
}

/** Translate any annotation by `(dx, dy)` in PDF user-space points. */
export function translateAnnotation(ann: PdfAnnotation, dx: number, dy: number): PdfAnnotation {
  if (!dx && !dy) return ann;
  switch (ann.kind) {
    case "highlight":
    case "underline":
    case "strikeout":
      return { ...ann, rects: ann.rects.map((r) => ({ ...r, x: r.x + dx, y: r.y + dy })) };
    case "note":
      return { ...ann, x: ann.x + dx, y: ann.y + dy };
    case "textbox":
    case "whiteout":
    case "image":
      return { ...ann, x: ann.x + dx, y: ann.y + dy };
    case "ink":
      return { ...ann, points: ann.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) };
    case "shape":
      return { ...ann, x1: ann.x1 + dx, y1: ann.y1 + dy, x2: ann.x2 + dx, y2: ann.y2 + dy };
  }
}

/** Return the PDF-space bounding rect of an annotation for selection framing and resizing. */
export function annotationBounds(ann: PdfAnnotation): PdfRect {
  switch (ann.kind) {
    case "highlight":
    case "underline":
    case "strikeout": {
      if (!ann.rects.length) return { x: 0, y: 0, width: 0, height: 0 };
      const minX = Math.min(...ann.rects.map((r) => r.x));
      const minY = Math.min(...ann.rects.map((r) => r.y));
      const maxX = Math.max(...ann.rects.map((r) => r.x + r.width));
      const maxY = Math.max(...ann.rects.map((r) => r.y + r.height));
      return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    }
    case "note":
      return { x: ann.x, y: ann.y - 40, width: 160, height: 40 };
    case "textbox":
    case "whiteout":
    case "image":
      return { x: ann.x, y: ann.y, width: ann.width, height: ann.height };
    case "ink": {
      if (!ann.points.length) return { x: 0, y: 0, width: 0, height: 0 };
      const minX = Math.min(...ann.points.map((p) => p.x));
      const minY = Math.min(...ann.points.map((p) => p.y));
      const maxX = Math.max(...ann.points.map((p) => p.x));
      const maxY = Math.max(...ann.points.map((p) => p.y));
      return { x: minX, y: minY, width: Math.max(8, maxX - minX), height: Math.max(8, maxY - minY) };
    }
    case "shape": {
      const minX = Math.min(ann.x1, ann.x2);
      const minY = Math.min(ann.y1, ann.y2);
      return { x: minX, y: minY, width: Math.max(8, Math.abs(ann.x2 - ann.x1)), height: Math.max(8, Math.abs(ann.y2 - ann.y1)) };
    }
  }
}

/** Resize a box-based annotation to `next` in PDF user-space points (with minimum dimensions). */
export function resizeAnnotationBox(ann: PdfAnnotation, next: PdfRect): PdfAnnotation {
  const width = Math.max(16, next.width);
  const height = Math.max(12, next.height);
  switch (ann.kind) {
    case "textbox":
    case "whiteout":
    case "image":
      return { ...ann, x: next.x, y: next.y, width, height };
    case "highlight":
    case "underline":
    case "strikeout":
      return { ...ann, rects: [{ x: next.x, y: next.y, width, height }] };
    case "shape":
      if (ann.shape === "rect") {
        return { ...ann, x1: next.x, y1: next.y, x2: next.x + width, y2: next.y + height };
      }
      return ann;
    default:
      return ann;
  }
}

/** SVG `<polygon points>` for a filled arrowhead pointing from `(x1, y1)` to `(x2, y2)`. */
export function arrowHeadSvgPoints(x1: number, y1: number, x2: number, y2: number, size = 10): string {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const spread = 0.42;
  const ax = x2 - size * Math.cos(angle - spread);
  const ay = y2 - size * Math.sin(angle - spread);
  const bx = x2 - size * Math.cos(angle + spread);
  const by = y2 - size * Math.sin(angle + spread);
  return `${x2},${y2} ${ax},${ay} ${bx},${by}`;
}

/** Centered placement coordinates `(x, y)` in PDF user-space for a newly stamped box on a page of `(pageW, pageH)`. */
export function centeredBoxOnPage(pageW: number, pageH: number, boxW: number, boxH: number): { x: number; y: number } {
  return {
    x: Math.max(16, Math.round((pageW - boxW) / 2)),
    y: Math.max(16, Math.round((pageH - boxH) / 2)),
  };
}
