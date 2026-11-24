// Pure client-side PDF modification engine built on `pdf-lib` (zero WASM, zero iframes).
// Handles page reorder/rotate/delete/insert/merge/extract, text markup, sticky notes, text boxes,
// whiteout-replace patches, freehand ink, shapes, image/signature stamps, and AcroForm field updates.
import { degrees, LineCapStyle, PDFCheckBox, PDFDocument, PDFDropdown, PDFOptionList, PDFRadioGroup, PDFTextField, rgb, StandardFonts, type PDFFont, type PDFPage } from "pdf-lib";

export interface NormRect { x: number; y: number; width: number; height: number }
export interface NormPoint { x: number; y: number }

export interface PdfPageSpec {
  id: string;
  source: "base" | "merged" | "blank";
  sourcePageIndex?: number;
  mergedIndex?: number;
  /** Additional rotation applied in edit mode (0, 90, 180, 270). */
  rotation: 0 | 90 | 180 | 270;
}

export type PdfAnnotation =
  | { id: string; pageId: string; kind: "highlight" | "underline" | "strikeout"; rects: NormRect[]; color: string }
  | { id: string; pageId: string; kind: "note"; x: number; y: number; text: string; color: string }
  | { id: string; pageId: string; kind: "textbox"; x: number; y: number; width: number; height: number; text: string; fontSize: number; color: string }
  | { id: string; pageId: string; kind: "whiteout"; x: number; y: number; width: number; height: number; bgColor: string; text: string; fontSize: number; color: string }
  | { id: string; pageId: string; kind: "ink"; points: NormPoint[]; color: string; width: number }
  | { id: string; pageId: string; kind: "shape"; shape: "rect" | "line" | "arrow"; x1: number; y1: number; x2: number; y2: number; color: string; width: number }
  | { id: string; pageId: string; kind: "image"; x: number; y: number; width: number; height: number; dataUrl: string };

export interface PdfFormFieldInfo {
  name: string;
  kind: "text" | "checkbox" | "dropdown" | "radio" | "optionList";
  value: string | boolean | string[];
  options?: string[];
  pageIndex: number;
  rect: NormRect;
}

export interface PdfEdits {
  pages: PdfPageSpec[];
  annotations: PdfAnnotation[];
  formValues: Record<string, string | boolean | string[]>;
  flattenForm?: boolean;
}

function parseHexRgb(hex: string) {
  const clean = hex.replace(/^#/, "");
  const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean;
  if (!/^[0-9a-f]{6}$/i.test(full)) return rgb(0.1, 0.1, 0.1);
  return rgb(parseInt(full.slice(0, 2), 16) / 255, parseInt(full.slice(2, 4), 16) / 255, parseInt(full.slice(4, 6), 16) / 255);
}

/** Sanitize text to WinAnsi-safe characters for StandardFonts Helvetica without throwing on unsupported glyphs. */
function safePdfText(text: string): string {
  return text.replace(/[^\x20-\x7e\xa0-\xff\n]/g, "?");
}

function wrapLines(text: string, font: PDFFont, fontSize: number, maxWidth: number): string[] {
  const out: string[] = [];
  for (const para of safePdfText(text).split(/\r?\n/)) {
    const words = para.split(" ");
    let line = "";
    for (const word of words) {
      const test = line ? `${line} ${word}` : word;
      if (maxWidth > 20 && font.widthOfTextAtSize(test, fontSize) > maxWidth && line) {
        out.push(line);
        line = word;
      } else {
        line = test;
      }
    }
    out.push(line);
  }
  return out;
}

function dataUrlToBytes(dataUrl: string): { mime: string; bytes: Uint8Array } | null {
  const m = /^data:(image\/(?:png|jpeg|jpg));base64,([A-Za-z0-9+/=\s]+)$/i.exec(dataUrl.trim());
  if (!m) return null;
  const bin = atob(m[2].replace(/\s+/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { mime: m[1].toLowerCase(), bytes };
}

/** Build the initial non-destructive page list from a PDF byte buffer. */
export async function initPdfPages(bytes: Uint8Array): Promise<{ pages: PdfPageSpec[]; encrypted: boolean; formFields: PdfFormFieldInfo[] }> {
  try {
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: false });
    const pages: PdfPageSpec[] = doc.getPages().map((_, i) => ({
      id: `base-${i}`,
      source: "base",
      sourcePageIndex: i,
      rotation: 0,
    }));
    const formFields = extractFormFields(doc);
    return { pages, encrypted: false, formFields };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/encrypt/i.test(msg)) {
      return { pages: [], encrypted: true, formFields: [] };
    }
    throw e;
  }
}

function extractFormFields(doc: PDFDocument): PdfFormFieldInfo[] {
  const out: PdfFormFieldInfo[] = [];
  const pdfPages = doc.getPages();
  const pageRefMap = new Map<unknown, number>();
  pdfPages.forEach((p, idx) => pageRefMap.set(p.ref, idx));
  let form;
  try {
    form = doc.getForm();
  } catch {
    return out;
  }
  for (const field of form.getFields()) {
    const widgets = field.acroField.getWidgets();
    if (!widgets.length) continue;
    const w = widgets[0];
    const pRef = w.P();
    const pageIndex = pRef && pageRefMap.has(pRef) ? pageRefMap.get(pRef)! : 0;
    const page = pdfPages[pageIndex];
    if (!page) continue;
    const { width: pw, height: ph } = page.getSize();
    const r = w.getRectangle();
    const rect: NormRect = {
      x: Math.max(0, r.x / pw),
      y: Math.max(0, (ph - r.y - r.height) / ph),
      width: Math.min(1, r.width / pw),
      height: Math.min(1, r.height / ph),
    };
    const name = field.getName();
    if (field instanceof PDFTextField) {
      out.push({ name, kind: "text", value: field.getText() ?? "", pageIndex, rect });
    } else if (field instanceof PDFCheckBox) {
      out.push({ name, kind: "checkbox", value: field.isChecked(), pageIndex, rect });
    } else if (field instanceof PDFDropdown) {
      out.push({ name, kind: "dropdown", value: field.getSelected()[0] ?? "", options: field.getOptions(), pageIndex, rect });
    } else if (field instanceof PDFRadioGroup) {
      out.push({ name, kind: "radio", value: field.getSelected() ?? "", options: field.getOptions(), pageIndex, rect });
    } else if (field instanceof PDFOptionList) {
      out.push({ name, kind: "optionList", value: field.getSelected(), options: field.getOptions(), pageIndex, rect });
    }
  }
  return out;
}

async function drawAnnotation(pdfDoc: PDFDocument, page: PDFPage, ann: PdfAnnotation, font: PDFFont) {
  const { width: pw, height: ph } = page.getSize();
  const toY = (ny: number) => ph - ny * ph;

  switch (ann.kind) {
    case "highlight": {
      const col = parseHexRgb(ann.color);
      for (const r of ann.rects) {
        page.drawRectangle({ x: r.x * pw, y: ph - (r.y + r.height) * ph, width: r.width * pw, height: r.height * ph, color: col, opacity: 0.35 });
      }
      break;
    }
    case "underline": {
      const col = parseHexRgb(ann.color);
      for (const r of ann.rects) {
        const y = ph - (r.y + r.height) * ph;
        page.drawLine({ start: { x: r.x * pw, y }, end: { x: (r.x + r.width) * pw, y }, color: col, thickness: 1.5 });
      }
      break;
    }
    case "strikeout": {
      const col = parseHexRgb(ann.color);
      for (const r of ann.rects) {
        const y = ph - (r.y + r.height / 2) * ph;
        page.drawLine({ start: { x: r.x * pw, y }, end: { x: (r.x + r.width) * pw, y }, color: col, thickness: 1.5 });
      }
      break;
    }
    case "note": {
      const col = parseHexRgb(ann.color);
      const x = ann.x * pw;
      const y = toY(ann.y);
      const lines = wrapLines(ann.text || "Note", font, 9, 150);
      const boxH = Math.max(24, lines.length * 12 + 10);
      const boxW = 160;
      page.drawRectangle({ x, y: y - boxH, width: boxW, height: boxH, color: col, borderColor: rgb(0.4, 0.35, 0.1), borderWidth: 1, opacity: 0.92 });
      lines.forEach((line, i) => {
        page.drawText(line, { x: x + 5, y: y - 13 - i * 12, size: 9, font, color: rgb(0.1, 0.1, 0.1) });
      });
      break;
    }
    case "textbox": {
      const col = parseHexRgb(ann.color);
      const x = ann.x * pw;
      const topY = toY(ann.y);
      const w = Math.max(40, ann.width * pw);
      const lines = wrapLines(ann.text, font, ann.fontSize, w);
      lines.forEach((line, i) => {
        page.drawText(line, { x, y: topY - ann.fontSize - i * (ann.fontSize * 1.25), size: ann.fontSize, font, color: col });
      });
      break;
    }
    case "whiteout": {
      const bg = parseHexRgb(ann.bgColor);
      const fg = parseHexRgb(ann.color);
      const x = ann.x * pw;
      const y = ph - (ann.y + ann.height) * ph;
      const w = ann.width * pw;
      const h = ann.height * ph;
      page.drawRectangle({ x, y, width: w, height: h, color: bg, opacity: 1 });
      if (ann.text.trim()) {
        const lines = wrapLines(ann.text, font, ann.fontSize, Math.max(20, w - 4));
        const topY = y + h;
        lines.forEach((line, i) => {
          page.drawText(line, { x: x + 2, y: topY - ann.fontSize - i * (ann.fontSize * 1.2), size: ann.fontSize, font, color: fg });
        });
      }
      break;
    }
    case "ink": {
      if (ann.points.length < 2) break;
      const col = parseHexRgb(ann.color);
      for (let i = 1; i < ann.points.length; i++) {
        page.drawLine({
          start: { x: ann.points[i - 1].x * pw, y: toY(ann.points[i - 1].y) },
          end: { x: ann.points[i].x * pw, y: toY(ann.points[i].y) },
          color: col,
          thickness: ann.width,
          lineCap: LineCapStyle.Round,
        });
      }
      break;
    }
    case "shape": {
      const col = parseHexRgb(ann.color);
      const x1 = ann.x1 * pw, y1 = toY(ann.y1);
      const x2 = ann.x2 * pw, y2 = toY(ann.y2);
      if (ann.shape === "rect") {
        page.drawRectangle({ x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1), borderColor: col, borderWidth: ann.width });
      } else {
        page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, color: col, thickness: ann.width });
        if (ann.shape === "arrow") {
          const angle = Math.atan2(y2 - y1, x2 - x1);
          const head = Math.max(8, ann.width * 4);
          page.drawLine({ start: { x: x2, y: y2 }, end: { x: x2 - head * Math.cos(angle - 0.45), y: y2 - head * Math.sin(angle - 0.45) }, color: col, thickness: ann.width });
          page.drawLine({ start: { x: x2, y: y2 }, end: { x: x2 - head * Math.cos(angle + 0.45), y: y2 - head * Math.sin(angle + 0.45) }, color: col, thickness: ann.width });
        }
      }
      break;
    }
    case "image": {
      const decoded = dataUrlToBytes(ann.dataUrl);
      if (!decoded) break;
      const embedded = decoded.mime === "image/png" ? await pdfDoc.embedPng(decoded.bytes) : await pdfDoc.embedJpg(decoded.bytes);
      page.drawImage(embedded, {
        x: ann.x * pw,
        y: ph - (ann.y + ann.height) * ph,
        width: ann.width * pw,
        height: ann.height * ph,
      });
      break;
    }
  }
}

/** Apply all non-destructive edits (page ops, annotations, form values) and return new PDF bytes. */
export async function applyPdfEdits(
  baseBytes: Uint8Array,
  mergedSources: Uint8Array[],
  edits: PdfEdits,
): Promise<Uint8Array> {
  const baseDoc = await PDFDocument.load(baseBytes, { ignoreEncryption: false });
  const hasPageStructureChange =
    edits.pages.length !== baseDoc.getPageCount()
    || edits.pages.some((p, i) => p.source !== "base" || p.sourcePageIndex !== i);

  let targetDoc: PDFDocument;
  if (!hasPageStructureChange) {
    // Modify in-place to preserve AcroForms, outlines/bookmarks, and metadata untouched.
    targetDoc = baseDoc;
  } else {
    targetDoc = await PDFDocument.create();
    const mergedDocs = await Promise.all(mergedSources.map((b) => PDFDocument.load(b, { ignoreEncryption: false })));
    for (const spec of edits.pages) {
      if (spec.source === "blank") {
        targetDoc.addPage([612, 792]);
      } else if (spec.source === "base" && spec.sourcePageIndex !== undefined) {
        const [copied] = await targetDoc.copyPages(baseDoc, [spec.sourcePageIndex]);
        targetDoc.addPage(copied);
      } else if (spec.source === "merged" && spec.mergedIndex !== undefined && spec.sourcePageIndex !== undefined) {
        const srcDoc = mergedDocs[spec.mergedIndex];
        if (srcDoc) {
          const [copied] = await targetDoc.copyPages(srcDoc, [spec.sourcePageIndex]);
          targetDoc.addPage(copied);
        }
      }
    }
  }

  // Apply rotations and annotations per page.
  const font = await targetDoc.embedFont(StandardFonts.Helvetica);
  const pages = targetDoc.getPages();
  for (let i = 0; i < edits.pages.length && i < pages.length; i++) {
    const spec = edits.pages[i];
    const page = pages[i];
    if (spec.rotation) {
      const current = page.getRotation().angle;
      page.setRotation(degrees((current + spec.rotation) % 360));
    }
    const pageAnns = edits.annotations.filter((a) => a.pageId === spec.id);
    for (const ann of pageAnns) {
      await drawAnnotation(targetDoc, page, ann, font);
    }
  }

  // Apply AcroForm values when present on the target document.
  const formEntries = Object.entries(edits.formValues);
  if (formEntries.length > 0 || edits.flattenForm) {
    try {
      const form = targetDoc.getForm();
      for (const [name, val] of formEntries) {
        const field = form.getFields().find((f) => f.getName() === name);
        if (!field) continue;
        if (field instanceof PDFTextField && typeof val === "string") field.setText(safePdfText(val));
        else if (field instanceof PDFCheckBox && typeof val === "boolean") {
          if (val) field.check();
          else field.uncheck();
        } else if (field instanceof PDFDropdown && typeof val === "string") field.select(val);
        else if (field instanceof PDFRadioGroup && typeof val === "string") field.select(val);
        else if (field instanceof PDFOptionList && Array.isArray(val)) field.select(val);
      }
      if (edits.flattenForm) form.flatten();
    } catch {
      // Document has no AcroForm; skip quietly.
    }
  }

  return targetDoc.save();
}

/** Extract selected 0-based page indices from `baseBytes` into a standalone new PDF. */
export async function extractPdfPages(baseBytes: Uint8Array, pageIndices: number[]): Promise<Uint8Array> {
  const src = await PDFDocument.load(baseBytes, { ignoreEncryption: false });
  const dst = await PDFDocument.create();
  const valid = pageIndices.filter((i) => i >= 0 && i < src.getPageCount());
  if (!valid.length) throw new Error("Select at least one page to extract");
  const copied = await dst.copyPages(src, valid);
  for (const p of copied) dst.addPage(p);
  return dst.save();
}
