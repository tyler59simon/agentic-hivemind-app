// Tauri IPC wrappers for binary `.pdf` metadata, raw bytes, atomic save, create, merge picker, and history restore.
import { invoke } from "@tauri-apps/api/core";
import type { SaveOutcome, Stamp } from "./notebooks";
import { restoreBinaryVersion } from "./docx";

export interface PdfMeta extends Stamp {
  readOnly: string | null;
  tooLarge: boolean;
}

export const pdfMeta = (notebook: string, path: string) =>
  invoke<PdfMeta>("pdf_meta", { notebook, path });

export const pdfBytes = async (notebook: string, path: string): Promise<Uint8Array> => {
  const res = await invoke<ArrayBuffer | Uint8Array | number[]>("pdf_bytes", { notebook, path });
  if (res instanceof Uint8Array) return new Uint8Array(res);
  if (res instanceof ArrayBuffer) return new Uint8Array(res);
  return new Uint8Array(res);
};

export const pdfRange = async (notebook: string, path: string, offset: number, length: number): Promise<Uint8Array> => {
  const res = await invoke<ArrayBuffer | Uint8Array | number[]>("pdf_range", { notebook, path, offset, length });
  if (res instanceof Uint8Array) return new Uint8Array(res);
  if (res instanceof ArrayBuffer) return new Uint8Array(res);
  return new Uint8Array(res);
};

export const savePdfBytes = (notebook: string, path: string, bytes: Uint8Array, pre: Stamp, source = "you") =>
  invoke<SaveOutcome>("pdf_save", bytes, {
    headers: {
      notebook: encodeURIComponent(notebook),
      path: encodeURIComponent(path),
      sha256: encodeURIComponent(pre.sha256),
      size: String(pre.size),
      mtimeMs: String(pre.mtimeMs),
      source: encodeURIComponent(source),
    },
  });

export const createPdfBytes = (notebook: string, path: string, bytes: Uint8Array) =>
  invoke<Stamp>("pdf_create", bytes, {
    headers: {
      notebook: encodeURIComponent(notebook),
      path: encodeURIComponent(path),
    },
  });

export const pickPdfForMerge = async (): Promise<Uint8Array | null> => {
  const res = await invoke<ArrayBuffer | Uint8Array | number[] | null>("pdf_pick_merge");
  if (!res) return null;
  if (res instanceof Uint8Array) return res.byteLength ? new Uint8Array(res) : null;
  if (res instanceof ArrayBuffer) return res.byteLength ? new Uint8Array(res) : null;
  return res.length ? new Uint8Array(res) : null;
};

export const restorePdfVersion = restoreBinaryVersion;
