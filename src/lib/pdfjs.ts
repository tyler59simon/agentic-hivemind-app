// Shared lazy `pdfjs-dist` loader with Vite-bundled worker (`useWasm: false, enableXfa: false`)
// so `.hmdoc` PDF embeds and the standalone `.pdf` viewer/editor share one worker under Hivemind's CSP.
type Pdfjs = typeof import("pdfjs-dist");

let library: Promise<Pdfjs> | null = null;

export function loadPdfjs(): Promise<Pdfjs> {
  library ??= (async () => {
    const [pdfjs, { default: PdfWorker }] = await Promise.all([
      import("pdfjs-dist"),
      import("pdfjs-dist/build/pdf.worker.min.mjs?worker"),
    ]);
    pdfjs.GlobalWorkerOptions.workerPort = new PdfWorker();
    return pdfjs;
  })();
  return library;
}
