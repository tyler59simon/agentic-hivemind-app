// @vitest-environment jsdom
import { PDFDocument } from "pdf-lib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let samplePdfBytes: Uint8Array;
const calls: { cmd: string; args: unknown }[] = [];
let holdSave: (() => void) | null = null;

function mockDocTask() {
  return {
    promise: Promise.resolve({
      numPages: 2,
      getOutline: async () => null,
      getPage: async () => ({
        rotate: 0,
        getViewport: ({ scale }: { scale: number }) => ({
          width: 612 * scale,
          height: 792 * scale,
          transform: [scale, 0, 0, -scale, 0, 792 * scale],
          convertToPdfPoint: (vx: number, vy: number) => [vx / scale, 792 - vy / scale],
          convertToViewportPoint: (px: number, py: number) => [px * scale, (792 - py) * scale],
        }),
        render: () => ({ promise: Promise.resolve(), cancel: () => {} }),
        getTextContent: async () => ({ items: [{ str: "Hello PDF", transform: [12, 0, 0, 12, 50, 700] }] }),
      }),
    }),
    destroy: async () => {},
  };
}

vi.mock("../../lib/pdfjs", () => ({
  loadPdfjs: vi.fn(async () => ({
    PDFDataRangeTransport: class { constructor(public length: number, public initialData: Uint8Array) {} },
  })),
  openPdfJsDocument: vi.fn(async () => mockDocTask()),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: unknown) => {
    calls.push({ cmd, args });
    switch (cmd) {
      case "notebooks_list": return [{ id: "nb-1", path: "C:\\nb", title: "Notebook", added: "" }];
      case "pdf_meta": return { sha256: "sha-pdf-1", size: samplePdfBytes.byteLength, mtimeMs: 1, readOnly: null, tooLarge: false };
      case "pdf_bytes": return samplePdfBytes.buffer.slice(samplePdfBytes.byteOffset, samplePdfBytes.byteOffset + samplePdfBytes.byteLength);
      case "pdf_save":
        if (holdSave) await new Promise<void>((r) => { const fn = holdSave; holdSave = () => { r(); fn?.(); }; });
        return { status: "saved", sha256: "sha-pdf-2", size: 1000, mtimeMs: 2 };
      default: return null;
    }
  }),
}));

const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { FileTab } = await import("../notes/FileTab");
const { retargetAll, startDocumentSync } = await import("../../documents/sync");
const { unsavedBinaryFiles, useWorkspace } = await import("../../workspace/store");
const { addPdfAnnotation, pdfKey, redoPdf, savePdfSession, undoPdf, usePdfStore } = await import("./store");

let root: Root | null = null;
beforeEach(async () => {
  const doc = await PDFDocument.create();
  const p0 = doc.addPage([612, 792]);
  doc.addPage([612, 792]);
  const list = doc.getForm().createOptionList("tags");
  list.addOptions(["A", "B", "C"]);
  list.addToPage(p0, { x: 50, y: 500, width: 120, height: 60 });
  samplePdfBytes = await doc.save();
  calls.length = 0;
  holdSave = null;
  usePdfStore.setState({ sessions: {}, refs: {} });
  useWorkspace.setState({ panes: [{ id: "p0", tabs: [], active: null }], focused: "p0", dirty: {}, reveal: null });
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

async function until(check: () => unknown) {
  for (let i = 0; i < 150; i++) {
    if (check()) return;
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  }
  throw new Error("timed out");
}

describe("PdfTab & PdfStore", () => {
  it("routes .pdf to PdfTab in View mode, renders pages with zero iframes, and supports edit/undo/redo/save + optionList", async () => {
    const ref = { notebook: "nb-1", path: "Report.pdf" };
    useWorkspace.getState().openTab({ kind: "file", file: ref, mode: "edit" });
    const tab = useWorkspace.getState().panes[0].tabs[0];
    const el = document.createElement("div");
    document.body.append(el);
    root = createRoot(el);
    await act(async () => {
      root!.render(<QueryClientProvider client={new QueryClient()}><FileTab tab={tab} /></QueryClientProvider>);
    });
    await until(() => el.querySelectorAll(".pdf-page-card").length === 2);
    expect(calls.some((c) => c.cmd === "file_read")).toBe(false);
    expect([...el.querySelectorAll('[role="tab"]')].map((t) => t.textContent)).toEqual(["View", "Edit", "History"]);
    expect(document.querySelector("iframe")).toBeNull();
    // optionList renders as a multi-select <select multiple>
    const listEl = el.querySelector<HTMLSelectElement>('select[aria-label="tags"]');
    expect(listEl?.multiple).toBe(true);

    const key = pdfKey(ref);
    await act(async () => {
      addPdfAnnotation(key, { id: "n1", pageId: "base-0", kind: "note", x: 120, y: 500, text: "Review", color: "#fef08a" });
    });
    expect(usePdfStore.getState().sessions[key].edits.annotations).toHaveLength(1);
    expect(useWorkspace.getState().dirty[tab.id]).toBe(true);
    expect(unsavedBinaryFiles(useWorkspace.getState())).toBe(true);

    await act(async () => { undoPdf(key); });
    expect(usePdfStore.getState().sessions[key].edits.annotations).toHaveLength(0);
    await act(async () => { redoPdf(key); });
    expect(usePdfStore.getState().sessions[key].edits.annotations).toHaveLength(1);

    let ok = false;
    await act(async () => { ok = await savePdfSession(key); });
    expect(ok).toBe(true);
    expect(calls.some((c) => c.cmd === "pdf_save")).toBe(true);
    expect(useWorkspace.getState().dirty[tab.id]).toBe(false);
    expect(unsavedBinaryFiles(useWorkspace.getState())).toBe(false);
  });

  it("retains edits made while a PDF save is in flight, carries sessions across renames, and evicts on tab close", async () => {
    const stop = startDocumentSync();
    try {
      const ref = { notebook: "nb-1", path: "Draft.pdf" };
      useWorkspace.getState().openTab({ kind: "file", file: ref, mode: "edit" });
      const paneId = useWorkspace.getState().panes[0].id;
      const tab = useWorkspace.getState().panes[0].tabs[0];
      const el = document.createElement("div");
      document.body.append(el);
      root = createRoot(el);
      await act(async () => {
        root!.render(<QueryClientProvider client={new QueryClient()}><FileTab tab={tab} /></QueryClientProvider>);
      });
      await until(() => usePdfStore.getState().sessions[pdfKey(ref)]?.status === "clean");

      const key = pdfKey(ref);
      addPdfAnnotation(key, { id: "n1", pageId: "base-0", kind: "note", x: 100, y: 400, text: "First", color: "#fef08a" });

      // Hold the save in flight, then add a second annotation before it finishes.
      let releaseSave!: () => void;
      holdSave = () => { releaseSave?.(); };
      const saveDone = new Promise<void>((r) => { releaseSave = r; });
      const savePromise = savePdfSession(key);
      await until(() => calls.some((c) => c.cmd === "pdf_save"));
      addPdfAnnotation(key, { id: "n2", pageId: "base-0", kind: "note", x: 200, y: 400, text: "During save", color: "#fef08a" });
      holdSave();
      await saveDone;
      const ok = await savePromise;
      expect(ok).toBe(true);
      // Second annotation survived and session stays dirty!
      const after = usePdfStore.getState().sessions[key];
      expect(after.status).toBe("dirty");
      expect(after.edits.annotations).toHaveLength(2);
      expect(after.stamp?.sha256).toBe("sha-pdf-2");

      // Retarget session across rename
      retargetAll("nb-1", "Draft.pdf", "Renamed.pdf");
      const newKey = pdfKey({ notebook: "nb-1", path: "Renamed.pdf" });
      expect(usePdfStore.getState().sessions[key]).toBeUndefined();
      expect(usePdfStore.getState().sessions[newKey]?.edits.annotations).toHaveLength(2);

      // Closing the last tab evicts the binary session
      await act(async () => {
        useWorkspace.getState().closeTab(paneId, tab.id);
      });
      expect(usePdfStore.getState().sessions[newKey]).toBeUndefined();
    } finally {
      stop();
    }
  });
});
