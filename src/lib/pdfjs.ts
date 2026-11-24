// Shared lazy `pdfjs-dist` loader with Vite-bundled worker (`useWasm: false, enableXfa: false`).
// Each opened document gets its own `PDFWorker` tied strictly to that loading task's lifecycle so
// closing or reloading one PDF tab or rich-page embed can never invalidate another open viewer.
type Pdfjs = typeof import("pdfjs-dist");
type PdfWorkerCtor = new () => Worker;

let parts: Promise<{ pdfjs: Pdfjs; PdfWorker: PdfWorkerCtor }> | null = null;

function loadParts() {
  parts ??= Promise.all([
    import("pdfjs-dist"),
    import("pdfjs-dist/build/pdf.worker.min.mjs?worker"),
  ]).then(([pdfjs, mod]) => ({ pdfjs, PdfWorker: mod.default }));
  return parts;
}

export async function loadPdfjs(): Promise<Pdfjs> {
  return (await loadParts()).pdfjs;
}

export async function openPdfJsDocument(
  src: Exclude<Parameters<Pdfjs["getDocument"]>[0], string | URL | Uint8Array | ArrayBuffer>,
) {
  const { pdfjs, PdfWorker } = await loadParts();
  const worker = pdfjs.PDFWorker.create({ port: new PdfWorker() });
  const task = pdfjs.getDocument({ ...src, worker });
  const origDestroy = task.destroy.bind(task);
  task.destroy = async () => {
    try {
      await origDestroy();
    } finally {
      try { worker.destroy(); } catch { /* ignore */ }
    }
  };
  return task;
}
