// Drawing one page of a PDF (NS-3D). `pdfjs-dist` and its worker are lazy chunks: nothing loads until a PDF page block
// first draws. The worker is bundled by Vite (`?worker`), not fetched from anywhere. pdf.js 6 has no `isEvalSupported`
// option any more: its worker never calls `eval` or `new Function`, which the page's CSP (no `unsafe-eval`) would refuse.
// WebAssembly is off (the CSP has no `wasm-unsafe-eval`), so the JPEG 2000 and JBIG2 decoders, which need it, do not
// run: a page that holds such an image draws without it.
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from "pdfjs-dist";
import { loadPdfjs } from "../../../lib/pdfjs";

const load = loadPdfjs;

/** Documents by URL, shared by the blocks that show pages of the same file and closed when the last one lets go. */
const open = new Map<string, { task: Promise<PDFDocumentLoadingTask>; doc: Promise<PDFDocumentProxy>; users: number }>();

async function acquire(url: string): Promise<PDFDocumentProxy> {
  let entry = open.get(url);
  if (!entry) {
    const task = load().then((pdfjs) => pdfjs.getDocument({ url, useWasm: false, enableXfa: false }));
    const doc = task.then((t) => t.promise);
    entry = { task, doc, users: 0 };
    open.set(url, entry);
    // A file that cannot be opened is not kept, so the next draw tries again.
    doc.catch(() => { if (open.get(url) === entry) open.delete(url); });
  }
  entry.users++;
  return entry.doc;
}

function release(url: string) {
  const entry = open.get(url);
  if (!entry || --entry.users > 0) return;
  open.delete(url);
  entry.task.then((task) => task.destroy(), () => {});
}

export type PageResult = { ok: true; pages: number } | { ok: false; reason: string; pages?: number };

/** Draw `page` (from 1) of the PDF at `url` into `canvas`, `width` CSS pixels wide. */
export async function drawPage(url: string, page: number, canvas: HTMLCanvasElement, width: number, isCurrent: () => boolean): Promise<PageResult> {
  let doc: PDFDocumentProxy;
  try {
    doc = await acquire(url);
  } catch (e) {
    return { ok: false, reason: `The PDF could not be opened (${e instanceof Error ? e.message : String(e)})` };
  }
  try {
    if (page > doc.numPages) return { ok: false, reason: `The PDF has ${doc.numPages} ${doc.numPages === 1 ? "page" : "pages"}, so page ${page} is not there.`, pages: doc.numPages };
    const p = await doc.getPage(page);
    if (!isCurrent()) return { ok: true, pages: doc.numPages };
    const natural = p.getViewport({ scale: 1 });
    const ratio = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    const viewport = p.getViewport({ scale: (Math.max(120, width) / natural.width) * ratio });
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.style.width = `${Math.floor(viewport.width / ratio)}px`;
    canvas.style.height = `${Math.floor(viewport.height / ratio)}px`;
    await p.render({ canvas, viewport }).promise;
    return { ok: true, pages: doc.numPages };
  } catch (e) {
    return { ok: false, reason: `The page could not be drawn (${e instanceof Error ? e.message : String(e)})` };
  } finally {
    release(url);
  }
}
