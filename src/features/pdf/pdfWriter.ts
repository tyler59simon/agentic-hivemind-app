// Pure client-side PDF modification engine built on `pdf-lib` (zero WASM, zero iframes).
// Coordinates are stored in native PDF user-space points (bottom-left origin, y pointing up),
// matching PDF.js `viewport.convertToPdfPoint` / `convertToViewportPoint` across arbitrary
// page rotations and crop boxes.
import {
  degrees, LineCapStyle, PDFCheckBox, PDFDocument, PDFDropdown, PDFName,
  PDFOptionList, PDFRadioGroup, PDFTextField, rgb, StandardFonts,
  type PDFFont, type PDFPage,
} from "pdf-lib";

/** Rectangle in PDF user-space points (`(x, y)` is lower-left corner in PDF space). */
export interface PdfRect { x: number; y: number; width: number; height: number }
/** Point in PDF user-space points. */
export interface PdfPoint { x: number; y: number }

export interface PdfPageSpec {
  id: string;
  source: "base" | "merged" | "blank";
  sourcePageIndex?: number;
  mergedIndex?: number;
  /** Additional rotation applied in edit mode (0, 90, 180, 270). */
  rotation: 0 | 90 | 180 | 270;
}

export type PdfAnnotation =
  | { id: string; pageId: string; kind: "highlight" | "underline" | "strikeout"; rects: PdfRect[]; color: string }
  | { id: string; pageId: string; kind: "note"; x: number; y: number; text: string; color: string }
  | { id: string; pageId: string; kind: "textbox"; x: number; y: number; width: number; height: number; text: string; fontSize: number; color: string }
  | { id: string; pageId: string; kind: "whiteout"; x: number; y: number; width: number; height: number; bgColor: string; text: string; fontSize: number; color: string }
  | { id: string; pageId: string; kind: "ink"; points: PdfPoint[]; color: string; width: number }
  | { id: string; pageId: string; kind: "shape"; shape: "rect" | "line" | "arrow"; x1: number; y1: number; x2: number; y2: number; color: string; width: number }
  | { id: string; pageId: string; kind: "image"; x: number; y: number; width: number; height: number; dataUrl: string };

export interface PdfFormFieldInfo {
  name: string;
  kind: "text" | "checkbox" | "dropdown" | "radio" | "optionList";
  value: string | boolean | string[];
  options?: string[];
  pageIndex: number;
  /** Widget bounding rectangle in native PDF user-space points. */
  rect: PdfRect;
}

export interface PdfEdits {
  pages: PdfPageSpec[];
  annotations: PdfAnnotation[];
  /** Only fields explicitly edited by the user (unchanged fields are never rewritten). */
  formValues: Record<string, string | boolean | string[]>;
  flattenForm?: boolean;
}

function parseHexRgb(hex: string) {
  const clean = hex.replace(/^#/, "");
  const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean;
  if (!/^[0-9a-f]{6}$/i.test(full)) return rgb(0.1, 0.1, 0.1);
  return rgb(parseInt(full.slice(0, 2), 16) / 255, parseInt(full.slice(2, 4), 16) / 255, parseInt(full.slice(4, 6), 16) / 255);
}

/** Sanitize text for StandardFonts Helvetica overlay annotations (notes/textboxes/whiteout). */
function safeAnnotationText(text: string): string {
  return text.replace(/[^\x20-\x7e\xa0-\xff\u20ac\n]/g, "?");
}

function wrapLines(text: string, font: PDFFont, fontSize: number, maxWidth: number): string[] {
  const out: string[] = [];
  for (const para of safeAnnotationText(text).split(/\r?\n/)) {
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

/** Build the initial non-destructive page list and form metadata from a PDF byte buffer. */
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
    let pageIndex = pRef && pageRefMap.has(pRef) ? pageRefMap.get(pRef)! : -1;
    if (pageIndex < 0) {
      // Fallback: find the page whose Annots array references this widget.
      pageIndex = pdfPages.findIndex((p) => {
        const annots = p.node.Annots();
        if (!annots) return false;
        for (let i = 0; i < annots.size(); i++) {
          if (annots.lookup(i) === w.dict) return true;
        }
        return false;
      });
      if (pageIndex < 0) pageIndex = 0;
    }
    const r = w.getRectangle();
    const rect: PdfRect = { x: r.x, y: r.y, width: r.width, height: r.height };
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
  switch (ann.kind) {
    case "highlight": {
      const col = parseHexRgb(ann.color);
      for (const r of ann.rects) {
        page.drawRectangle({ x: r.x, y: r.y, width: r.width, height: r.height, color: col, opacity: 0.35 });
      }
      break;
    }
    case "underline": {
      const col = parseHexRgb(ann.color);
      for (const r of ann.rects) {
        page.drawLine({ start: { x: r.x, y: r.y }, end: { x: r.x + r.width, y: r.y }, color: col, thickness: 1.5 });
      }
      break;
    }
    case "strikeout": {
      const col = parseHexRgb(ann.color);
      for (const r of ann.rects) {
        const y = r.y + r.height / 2;
        page.drawLine({ start: { x: r.x, y }, end: { x: r.x + r.width, y }, color: col, thickness: 1.5 });
      }
      break;
    }
    case "note": {
      const col = parseHexRgb(ann.color);
      const lines = wrapLines(ann.text || "Note", font, 9, 150);
      const boxH = Math.max(24, lines.length * 12 + 10);
      const boxW = 160;
      page.drawRectangle({ x: ann.x, y: ann.y - boxH, width: boxW, height: boxH, color: col, borderColor: rgb(0.4, 0.35, 0.1), borderWidth: 1, opacity: 0.92 });
      lines.forEach((line, i) => {
        page.drawText(line, { x: ann.x + 5, y: ann.y - 13 - i * 12, size: 9, font, color: rgb(0.1, 0.1, 0.1) });
      });
      break;
    }
    case "textbox": {
      const col = parseHexRgb(ann.color);
      const w = Math.max(40, ann.width);
      const topY = ann.y + ann.height;
      const lines = wrapLines(ann.text, font, ann.fontSize, w);
      lines.forEach((line, i) => {
        page.drawText(line, { x: ann.x, y: topY - ann.fontSize - i * (ann.fontSize * 1.25), size: ann.fontSize, font, color: col });
      });
      break;
    }
    case "whiteout": {
      const bg = parseHexRgb(ann.bgColor);
      const fg = parseHexRgb(ann.color);
      page.drawRectangle({ x: ann.x, y: ann.y, width: ann.width, height: ann.height, color: bg, opacity: 1 });
      if (ann.text.trim()) {
        const lines = wrapLines(ann.text, font, ann.fontSize, Math.max(20, ann.width - 4));
        const topY = ann.y + ann.height;
        lines.forEach((line, i) => {
          page.drawText(line, { x: ann.x + 2, y: topY - ann.fontSize - i * (ann.fontSize * 1.2), size: ann.fontSize, font, color: fg });
        });
      }
      break;
    }
    case "ink": {
      if (ann.points.length < 2) break;
      const col = parseHexRgb(ann.color);
      for (let i = 1; i < ann.points.length; i++) {
        page.drawLine({
          start: { x: ann.points[i - 1].x, y: ann.points[i - 1].y },
          end: { x: ann.points[i].x, y: ann.points[i].y },
          color: col,
          thickness: ann.width,
          lineCap: LineCapStyle.Round,
        });
      }
      break;
    }
    case "shape": {
      const col = parseHexRgb(ann.color);
      const { x1, y1, x2, y2 } = ann;
      if (ann.shape === "rect") {
        page.drawRectangle({
          x: Math.min(x1, x2),
          y: Math.min(y1, y2),
          width: Math.abs(x2 - x1),
          height: Math.abs(y2 - y1),
          borderColor: col,
          borderWidth: ann.width,
        });
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
        x: ann.x,
        y: ann.y,
        width: ann.width,
        height: ann.height,
      });
      break;
    }
  }
}

/** Remove AcroForm fields whose widgets all belonged to deleted pages so form updates/flattening never fail. */
function pruneDeletedPageFields(doc: PDFDocument, keptPageRefs: Set<unknown>) {
  let form;
  try {
    form = doc.getForm();
  } catch {
    return;
  }
  const fields = form.getFields();
  for (const field of fields) {
    const widgets = field.acroField.getWidgets();
    if (!widgets.length) continue;
    const anyKept = widgets.some((w) => {
      const pRef = w.P();
      return !pRef || keptPageRefs.has(pRef);
    });
    if (!anyKept) {
      try {
        form.removeField(field);
      } catch {
        // Best-effort cleanup; ignore if field cannot be detached cleanly.
      }
    }
  }
}

/** Apply all non-destructive edits (page ops, annotations, form values) and return new PDF bytes.
 *  Always mutates `baseDoc` in place so the document-level AcroForm, bookmarks, and metadata survive
 *  page reordering, blank-page insertion, deletion, and merging. */
export async function applyPdfEdits(
  baseBytes: Uint8Array,
  mergedSources: Uint8Array[],
  edits: PdfEdits,
): Promise<Uint8Array> {
  const targetDoc = await PDFDocument.load(baseBytes, { ignoreEncryption: false });
  const hasPageStructureChange =
    edits.pages.length !== targetDoc.getPageCount()
    || edits.pages.some((p, i) => p.source !== "base" || p.sourcePageIndex !== i);

  if (hasPageStructureChange) {
    const origPages = targetDoc.getPages();
    const mergedDocs = await Promise.all(mergedSources.map((b) => PDFDocument.load(b, { ignoreEncryption: false })));
    const usedBase = new Set<number>();
    const desiredPages: PDFPage[] = [];

    for (const spec of edits.pages) {
      if (spec.source === "blank") {
        desiredPages.push(targetDoc.addPage([612, 792]));
      } else if (spec.source === "base" && spec.sourcePageIndex !== undefined) {
        const orig = origPages[spec.sourcePageIndex];
        if (!orig) continue;
        if (!usedBase.has(spec.sourcePageIndex)) {
          usedBase.add(spec.sourcePageIndex);
          desiredPages.push(orig);
        } else {
          const [dup] = await targetDoc.copyPages(targetDoc, [spec.sourcePageIndex]);
          desiredPages.push(dup);
        }
      } else if (spec.source === "merged" && spec.mergedIndex !== undefined && spec.sourcePageIndex !== undefined) {
        const srcDoc = mergedDocs[spec.mergedIndex];
        if (srcDoc) {
          const [copied] = await targetDoc.copyPages(srcDoc, [spec.sourcePageIndex]);
          desiredPages.push(copied);
        }
      }
    }

    // Reorder/filter targetDoc's page tree in place while preserving page object refs (and thus AcroForm widget `/P` refs).
    while (targetDoc.getPageCount() > 0) targetDoc.removePage(0);
    for (let i = 0; i < desiredPages.length; i++) {
      targetDoc.insertPage(i, desiredPages[i]);
    }

    const keptRefs = new Set<unknown>(desiredPages.map((p) => p.ref));
    pruneDeletedPageFields(targetDoc, keptRefs);
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

  // Apply ONLY user-edited AcroForm values, propagating errors cleanly (never silently reporting partial saves).
  const formEntries = Object.entries(edits.formValues);
  if (formEntries.length > 0 || edits.flattenForm) {
    const hasAcroForm = targetDoc.catalog.get(PDFName.of("AcroForm")) !== undefined;
    if (hasAcroForm) {
      const form = targetDoc.getForm();
      const fields = form.getFields();
      for (const [name, val] of formEntries) {
        const field = fields.find((f) => f.getName() === name);
        if (!field) continue;
        if (field instanceof PDFTextField && typeof val === "string") {
          try {
            field.setText(val);
          } catch (e) {
            throw new Error(`Could not save text field "${name}": ${e instanceof Error ? e.message : String(e)}`);
          }
        } else if (field instanceof PDFCheckBox && typeof val === "boolean") {
          if (val) field.check();
          else field.uncheck();
        } else if (field instanceof PDFDropdown && typeof val === "string") {
          if (val === "") field.clear();
          else field.select(val);
        } else if (field instanceof PDFRadioGroup && typeof val === "string") {
          if (val === "") field.clear();
          else field.select(val);
        } else if (field instanceof PDFOptionList && Array.isArray(val)) {
          if (val.length === 0) field.clear();
          else field.select(val);
        }
      }
      if (edits.flattenForm) {
        form.flatten();
      }
    }
  }

  return targetDoc.save();
}

/** Extract arbitrary selected page specs (original, blank, merged, rotated, with their annotations) into a new PDF. */
export async function extractPdfPageSpecs(
  baseBytes: Uint8Array,
  mergedSources: Uint8Array[],
  selectedSpecs: PdfPageSpec[],
  annotations: PdfAnnotation[] = [],
): Promise<Uint8Array> {
  if (!selectedSpecs.length) throw new Error("Select at least one page to extract");
  const baseDoc = await PDFDocument.load(baseBytes, { ignoreEncryption: false });
  const mergedDocs = await Promise.all(mergedSources.map((b) => PDFDocument.load(b, { ignoreEncryption: false })));
  const dst = await PDFDocument.create();
  const font = await dst.embedFont(StandardFonts.Helvetica);

  for (const spec of selectedSpecs) {
    let page: PDFPage;
    if (spec.source === "blank") {
      page = dst.addPage([612, 792]);
    } else if (spec.source === "base" && spec.sourcePageIndex !== undefined) {
      if (spec.sourcePageIndex < 0 || spec.sourcePageIndex >= baseDoc.getPageCount()) {
        throw new Error(`Page index ${spec.sourcePageIndex + 1} is out of range`);
      }
      const [copied] = await dst.copyPages(baseDoc, [spec.sourcePageIndex]);
      page = dst.addPage(copied);
    } else if (spec.source === "merged" && spec.mergedIndex !== undefined && spec.sourcePageIndex !== undefined) {
      const srcDoc = mergedDocs[spec.mergedIndex];
      if (!srcDoc || spec.sourcePageIndex < 0 || spec.sourcePageIndex >= srcDoc.getPageCount()) {
        throw new Error("Selected merged page could not be found");
      }
      const [copied] = await dst.copyPages(srcDoc, [spec.sourcePageIndex]);
      page = dst.addPage(copied);
    } else {
      throw new Error("Unsupported page specification for extraction");
    }

    if (spec.rotation) {
      const current = page.getRotation().angle;
      page.setRotation(degrees((current + spec.rotation) % 360));
    }
    const pageAnns = annotations.filter((a) => a.pageId === spec.id);
    for (const ann of pageAnns) {
      await drawAnnotation(dst, page, ann, font);
    }
  }
  return dst.save();
}

/** Extract selected 0-based base page indices from `baseBytes` into a standalone new PDF. */
export async function extractPdfPages(baseBytes: Uint8Array, pageIndices: number[]): Promise<Uint8Array> {
  const specs: PdfPageSpec[] = pageIndices.map((idx, i) => ({
    id: `ext-${i}`,
    source: "base",
    sourcePageIndex: idx,
    rotation: 0,
  }));
  return extractPdfPageSpecs(baseBytes, [], specs);
}
