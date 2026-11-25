import type { PDFDocumentProxy } from "pdfjs-dist";
import { describe, expect, it } from "vitest";
import type { PdfAnnotation } from "./pdfWriter";
import {
  annotationBounds, arrowHeadSvgPoints, centeredBoxOnPage, extractNestedOutline,
  findSpanMatches, resizeAnnotationBox, translateAnnotation,
} from "./viewerModel";

describe("PDF viewerModel (Phase 0)", () => {
  it("extractNestedOutline recursively resolves nested bookmark hierarchies", async () => {
    const fakeDoc = {
      getOutline: async () => [
        {
          title: "Chapter 1",
          dest: "ch1",
          items: [
            { title: "Section 1.1", dest: [{ num: 2 }] },
            { title: "Section 1.2", dest: [{ num: 3 }], items: [{ title: "Deep 1.2.1", dest: [{ num: 4 }] }] },
          ],
        },
      ],
      getDestination: async (name: string) => (name === "ch1" ? [{ num: 1 }] : null),
      getPageIndex: async (ref: { num: number }) => ref.num,
    } as unknown as PDFDocumentProxy;

    const items = await extractNestedOutline(fakeDoc);
    expect(items).toEqual([
      { title: "Chapter 1", pageIndex: 1, depth: 0 },
      { title: "Section 1.1", pageIndex: 2, depth: 1 },
      { title: "Section 1.2", pageIndex: 3, depth: 1 },
      { title: "Deep 1.2.1", pageIndex: 4, depth: 2 },
    ]);
  });

  it("findSpanMatches matches phrases split across adjacent text spans", () => {
    const spans = ["Quarterly", "Revenue", "Report", "2026", "Quarterly Revenue"];
    const hits = findSpanMatches(spans, "quarterly revenue");
    expect(hits).toEqual([[0, 1], [4]]);
    expect(findSpanMatches(spans, "missing")).toEqual([]);
  });

  it("translates and resizes annotations cleanly in PDF user-space", () => {
    const img: PdfAnnotation = { id: "i1", pageId: "base-0", kind: "image", x: 100, y: 200, width: 150, height: 80, dataUrl: "data:image/png;base64,AA==" };
    const moved = translateAnnotation(img, 25, -15);
    expect(moved).toMatchObject({ x: 125, y: 185, width: 150, height: 80 });
    const resized = resizeAnnotationBox(moved, { x: 120, y: 180, width: 220, height: 110 });
    expect(resized).toMatchObject({ x: 120, y: 180, width: 220, height: 110 });

    const line: PdfAnnotation = { id: "s1", pageId: "base-0", kind: "shape", shape: "arrow", x1: 10, y1: 20, x2: 110, y2: 70, color: "#dc2626", width: 2 };
    expect(translateAnnotation(line, 5, -10)).toMatchObject({ x1: 15, y1: 10, x2: 115, y2: 60 });
    expect(annotationBounds(line)).toEqual({ x: 10, y: 20, width: 100, height: 50 });
  });

  it("computes arrowhead SVG coordinates and centered page placement", () => {
    const pts = arrowHeadSvgPoints(0, 0, 100, 0, 10);
    expect(pts.startsWith("100,0 ")).toBe(true);
    expect(centeredBoxOnPage(612, 792, 180, 120)).toEqual({ x: 216, y: 336 });
  });
});
