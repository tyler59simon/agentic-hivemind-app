// @vitest-environment jsdom
import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { applyPdfEdits, extractPdfPages, initPdfPages, type PdfEdits } from "./pdfWriter";

const ONE_PIXEL_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

async function makeSamplePdf(pageCount = 2): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pageCount; i++) {
    const p = doc.addPage([612, 792]);
    p.drawText(`Sample Page ${i + 1}`, { x: 50, y: 700, size: 16, font });
  }
  const form = doc.getForm();
  const nameField = form.createTextField("customer.name");
  nameField.setText("Alice");
  nameField.addToPage(doc.getPages()[0], { x: 50, y: 600, width: 200, height: 24 });
  const agree = form.createCheckBox("customer.agree");
  agree.addToPage(doc.getPages()[0], { x: 50, y: 560, width: 16, height: 16 });
  return doc.save();
}

describe("pdfWriter offline PDF editing engine", () => {
  it("inspects pages and AcroForm fields, applies annotations + form values + rotations, and reloads cleanly", async () => {
    const base = await makeSamplePdf(2);
    const info = await initPdfPages(base);
    expect(info.encrypted).toBe(false);
    expect(info.pages).toHaveLength(2);
    expect(info.formFields.map((f) => f.name)).toEqual(["customer.name", "customer.agree"]);

    const edits: PdfEdits = {
      pages: [
        { ...info.pages[0], rotation: 90 },
        info.pages[1],
      ],
      annotations: [
        { id: "h1", pageId: info.pages[0].id, kind: "highlight", rects: [{ x: 0.1, y: 0.1, width: 0.3, height: 0.04 }], color: "#fef08a" },
        { id: "u1", pageId: info.pages[0].id, kind: "underline", rects: [{ x: 0.1, y: 0.16, width: 0.3, height: 0.03 }], color: "#1a73e8" },
        { id: "s1", pageId: info.pages[0].id, kind: "strikeout", rects: [{ x: 0.1, y: 0.22, width: 0.3, height: 0.03 }], color: "#dc2626" },
        { id: "n1", pageId: info.pages[0].id, kind: "note", x: 0.5, y: 0.2, text: "Check totals", color: "#fef08a" },
        { id: "t1", pageId: info.pages[0].id, kind: "textbox", x: 0.1, y: 0.35, width: 0.4, height: 0.06, text: "Added caption", fontSize: 12, color: "#111827" },
        { id: "w1", pageId: info.pages[0].id, kind: "whiteout", x: 0.1, y: 0.45, width: 0.25, height: 0.04, bgColor: "#ffffff", text: "Corrected", fontSize: 12, color: "#111827" },
        { id: "i1", pageId: info.pages[0].id, kind: "ink", points: [{ x: 0.1, y: 0.6 }, { x: 0.2, y: 0.65 }], color: "#dc2626", width: 2 },
        { id: "sh1", pageId: info.pages[0].id, kind: "shape", shape: "arrow", x1: 0.2, y1: 0.7, x2: 0.4, y2: 0.7, color: "#1a73e8", width: 2 },
        { id: "im1", pageId: info.pages[0].id, kind: "image", x: 0.6, y: 0.7, width: 0.2, height: 0.1, dataUrl: ONE_PIXEL_PNG },
      ],
      formValues: { "customer.name": "Bob", "customer.agree": true },
    };

    const out = await applyPdfEdits(base, [], edits);
    const reloaded = await PDFDocument.load(out);
    expect(reloaded.getPageCount()).toBe(2);
    expect(reloaded.getPages()[0].getRotation().angle).toBe(90);
    expect(reloaded.getForm().getTextField("customer.name").getText()).toBe("Bob");
    expect(reloaded.getForm().getCheckBox("customer.agree").isChecked()).toBe(true);
  });

  it("supports page reorder, blank insertion, deletion, merging a second PDF, and extracting pages", async () => {
    const base = await makeSamplePdf(2);
    const other = await makeSamplePdf(1);
    const info = await initPdfPages(base);

    const edits: PdfEdits = {
      pages: [
        info.pages[1],
        { id: "blank-1", source: "blank", rotation: 0 },
        { id: "merged-0-0", source: "merged", mergedIndex: 0, sourcePageIndex: 0, rotation: 180 },
      ],
      annotations: [],
      formValues: {},
    };

    const out = await applyPdfEdits(base, [other], edits);
    const reloaded = await PDFDocument.load(out);
    expect(reloaded.getPageCount()).toBe(3);
    expect(reloaded.getPages()[2].getRotation().angle).toBe(180);

    const extracted = await extractPdfPages(out, [0, 2]);
    const exDoc = await PDFDocument.load(extracted);
    expect(exDoc.getPageCount()).toBe(2);
  });
});
