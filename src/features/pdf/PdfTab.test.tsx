// @vitest-environment jsdom
import { PDFDocument } from "pdf-lib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let samplePdfBytes: Uint8Array;
const calls: { cmd: string; args: unknown }[] = [];

vi.mock("../../lib/pdfjs", () => ({
  loadPdfjs: vi.fn(async () => ({
    getDocument: vi.fn(() => ({
      promise: Promise.resolve({
        numPages: 2,
        getOutline: async () => null,
        getPage: async () => ({
          rotate: 0,
          getViewport: ({ scale }: { scale: number }) => ({ width: 612 * scale, height: 792 * scale, transform: [1, 0, 0, -1, 0, 792 * scale] }),
          render: () => ({ promise: Promise.resolve() }),
          getTextContent: async () => ({ items: [{ str: "Hello PDF", transform: [12, 0, 0, 12, 50, 700] }] }),
        }),
      }),
      destroy: async () => {},
    })),
  })),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: unknown) => {
    calls.push({ cmd, args });
    switch (cmd) {
      case "notebooks_list": return [{ id: "nb-1", path: "C:\\nb", title: "Notebook", added: "" }];
      case "pdf_meta": return { sha256: "sha-pdf-1", size: samplePdfBytes.byteLength, mtimeMs: 1, readOnly: null, tooLarge: false };
      case "pdf_bytes": return samplePdfBytes.buffer.slice(samplePdfBytes.byteOffset, samplePdfBytes.byteOffset + samplePdfBytes.byteLength);
      case "pdf_save": return { status: "saved", sha256: "sha-pdf-2", size: 1000, mtimeMs: 2 };
      default: return null;
    }
  }),
}));

const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { FileTab } = await import("../notes/FileTab");
const { useWorkspace } = await import("../../workspace/store");
const { addPdfAnnotation, pdfKey, redoPdf, savePdfSession, undoPdf, usePdfStore } = await import("./store");

let root: Root | null = null;
beforeEach(async () => {
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  doc.addPage([612, 792]);
  samplePdfBytes = await doc.save();
  calls.length = 0;
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
  it("routes .pdf to PdfTab in View mode, renders pages with zero iframes, and supports edit/undo/redo/save", async () => {
    const ref = { notebook: "nb-1", path: "Report.pdf" };
    useWorkspace.getState().openTab({ kind: "file", file: ref, mode: "preview" });
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

    const key = pdfKey(ref);
    await act(async () => {
      addPdfAnnotation(key, { id: "n1", pageId: "base-0", kind: "note", x: 0.2, y: 0.2, text: "Review", color: "#fef08a" });
    });
    expect(usePdfStore.getState().sessions[key].edits.annotations).toHaveLength(1);
    expect(useWorkspace.getState().dirty[tab.id]).toBe(true);

    await act(async () => { undoPdf(key); });
    expect(usePdfStore.getState().sessions[key].edits.annotations).toHaveLength(0);
    await act(async () => { redoPdf(key); });
    expect(usePdfStore.getState().sessions[key].edits.annotations).toHaveLength(1);

    let ok = false;
    await act(async () => { ok = await savePdfSession(key); });
    expect(ok).toBe(true);
    expect(calls.some((c) => c.cmd === "pdf_save")).toBe(true);
    expect(useWorkspace.getState().dirty[tab.id]).toBe(false);
  });
});
