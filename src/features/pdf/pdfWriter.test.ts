// @vitest-environment jsdom
import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { applyPdfEdits, extractPdfPages, extractPdfPageSpecs, initPdfPages, type PdfEdits } from "./pdfWriter";

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
  nameField.setText("Alice €100");
  nameField.addToPage(doc.getPages()[0], { x: 50, y: 600, width: 200, height: 24 });
  const agree = form.createCheckBox("customer.agree");
  agree.addToPage(doc.getPages()[0], { x: 50, y: 560, width: 16, height: 16 });
  const radio = form.createRadioGroup("customer.plan");
  radio.addOptionToPage("Basic", doc.getPages()[0], { x: 50, y: 520, width: 16, height: 16 });
  radio.addOptionToPage("Pro", doc.getPages()[0], { x: 100, y: 520, width: 16, height: 16 });
  const list = form.createOptionList("customer.tags");
  list.addOptions(["Alpha", "Beta", "Gamma"]);
  list.addToPage(doc.getPages()[0], { x: 50, y: 440, width: 140, height: 60 });
  return doc.save();
}

describe("pdfWriter offline PDF editing engine", () => {
  it("inspects pages and AcroForm fields in PDF user space, applies annotations + form values + rotations, and reloads cleanly", async () => {
    const base = await makeSamplePdf(2);
    const info = await initPdfPages(base);
    expect(info.encrypted).toBe(false);
    expect(info.pages).toHaveLength(2);
    expect(info.formFields.map((f) => f.name)).toEqual(["customer.name", "customer.agree", "customer.plan", "customer.tags"]);
    // Form widget rect is preserved in native PDF user-space points (pdf-lib includes 0.5pt border pad).
    expect(info.formFields[0].rect.x).toBeCloseTo(49.5, 1);
    expect(info.formFields[0].rect.y).toBeCloseTo(599.5, 1);
    expect(info.formFields[0].rect.width).toBeCloseTo(201, 1);
    expect(info.formFields[0].rect.height).toBeCloseTo(25, 1);

    const edits: PdfEdits = {
      pages: [
        { ...info.pages[0], rotation: 90 },
        info.pages[1],
      ],
      annotations: [
        { id: "h1", pageId: info.pages[0].id, kind: "highlight", rects: [{ x: 60, y: 690, width: 180, height: 24 }], color: "#fef08a" },
        { id: "u1", pageId: info.pages[0].id, kind: "underline", rects: [{ x: 60, y: 650, width: 180, height: 18 }], color: "#1a73e8" },
        { id: "s1", pageId: info.pages[0].id, kind: "strikeout", rects: [{ x: 60, y: 620, width: 180, height: 18 }], color: "#dc2626" },
        { id: "n1", pageId: info.pages[0].id, kind: "note", x: 300, y: 600, text: "Check totals", color: "#fef08a" },
        { id: "t1", pageId: info.pages[0].id, kind: "textbox", x: 60, y: 500, width: 240, height: 40, text: "Added caption", fontSize: 12, color: "#111827" },
        { id: "w1", pageId: info.pages[0].id, kind: "whiteout", x: 60, y: 420, width: 150, height: 30, bgColor: "#ffffff", text: "Corrected", fontSize: 12, color: "#111827" },
        { id: "i1", pageId: info.pages[0].id, kind: "ink", points: [{ x: 60, y: 300 }, { x: 120, y: 340 }], color: "#dc2626", width: 2 },
        { id: "sh1", pageId: info.pages[0].id, kind: "shape", shape: "arrow", x1: 120, y1: 200, x2: 260, y2: 200, color: "#1a73e8", width: 2 },
        { id: "im1", pageId: info.pages[0].id, kind: "image", x: 360, y: 120, width: 120, height: 60, dataUrl: ONE_PIXEL_PNG },
      ],
      formValues: {
        "customer.name": "Bob",
        "customer.agree": true,
        "customer.plan": "Pro",
        "customer.tags": ["Alpha", "Gamma"],
      },
    };

    const out = await applyPdfEdits(base, [], edits);
    const reloaded = await PDFDocument.load(out);
    expect(reloaded.getPageCount()).toBe(2);
    expect(reloaded.getPages()[0].getRotation().angle).toBe(90);
    expect(reloaded.getForm().getTextField("customer.name").getText()).toBe("Bob");
    expect(reloaded.getForm().getCheckBox("customer.agree").isChecked()).toBe(true);
    expect(reloaded.getForm().getRadioGroup("customer.plan").getSelected()).toBe("Pro");
    expect(reloaded.getForm().getOptionList("customer.tags").getSelected()).toEqual(["Alpha", "Gamma"]);
  });

  it("leaves untouched form fields intact, clears unselected radio groups cleanly, and flattens without dropping later fields", async () => {
    const base = await makeSamplePdf(1);
    const info = await initPdfPages(base);

    // Save an unrelated annotation without touching customer.name -> Euro sign survives untouched.
    const out1 = await applyPdfEdits(base, [], {
      pages: info.pages,
      annotations: [{ id: "n1", pageId: info.pages[0].id, kind: "note", x: 100, y: 200, text: "Hi", color: "#fef08a" }],
      formValues: {},
    });
    const d1 = await PDFDocument.load(out1);
    expect(d1.getForm().getTextField("customer.name").getText()).toBe("Alice €100");

    // Empty radio selection uses clear() instead of throwing, allowing later edits + flattenForm to succeed.
    const out2 = await applyPdfEdits(base, [], {
      pages: info.pages,
      annotations: [],
      formValues: { "customer.plan": "", "customer.name": "Flattened" },
      flattenForm: true,
    });
    const d2 = await PDFDocument.load(out2);
    expect(d2.getForm().getFields()).toHaveLength(0);
  });

  it("preserves AcroForm during page reorder, blank insertion, deletion, and merge, and extracts mixed page selections", async () => {
    const base = await makeSamplePdf(2);
    const other = await makeSamplePdf(1);
    const info = await initPdfPages(base);

    const specs = [
      info.pages[1],
      { id: "blank-1", source: "blank" as const, rotation: 0 as const },
      info.pages[0],
      { id: "merged-0-0", source: "merged" as const, mergedIndex: 0, sourcePageIndex: 0, rotation: 180 as const },
    ];
    const out = await applyPdfEdits(base, [other], {
      pages: specs,
      annotations: [],
      formValues: { "customer.name": "After Reorder" },
    });
    const reloaded = await PDFDocument.load(out);
    expect(reloaded.getPageCount()).toBe(4);
    expect(reloaded.getPages()[3].getRotation().angle).toBe(180);
    // Interactive form survived page reorder + blank insert + merge!
    expect(reloaded.getForm().getTextField("customer.name").getText()).toBe("After Reorder");

    // Mixed selection containing original + blank + merged extracts ALL 3 pages without dropping any.
    const mixedExtracted = await extractPdfPageSpecs(base, [other], [specs[0], specs[1], specs[3]]);
    const mixedDoc = await PDFDocument.load(mixedExtracted);
    expect(mixedDoc.getPageCount()).toBe(3);
    expect(mixedDoc.getPages()[2].getRotation().angle).toBe(180);

    const extracted = await extractPdfPages(out, [0, 3]);
    const exDoc = await PDFDocument.load(extracted);
    expect(exDoc.getPageCount()).toBe(2);
  });
});
