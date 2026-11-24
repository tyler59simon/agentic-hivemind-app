// Tauri IPC wrappers for `.docx` OOXML read, layout bytes, surgical save, create, and binary history restore.
import { invoke } from "@tauri-apps/api/core";
import type { SaveOutcome, Stamp } from "./notebooks";

export interface DocxWarning { kind: string; message: string }
export interface DocxMedia { id: string; mime: string; dataUrl: string }
export interface NewDocxMedia { mime: string; base64: string }
export interface DocxLoaded extends Stamp {
  doc: Record<string, unknown>;
  media: Record<string, DocxMedia>;
  readOnly: string | null;
  warnings: DocxWarning[];
  hasHeadersFooters: boolean;
}

export const readDocx = (notebook: string, path: string) =>
  invoke<DocxLoaded>("docx_read", { notebook, path });

export const rawDocx = async (notebook: string, path: string): Promise<ArrayBuffer> => {
  const res = await invoke<ArrayBuffer | Uint8Array | number[]>("docx_raw", { notebook, path });
  if (res instanceof ArrayBuffer) return res;
  if (res instanceof Uint8Array) return new Uint8Array(res).buffer;
  return new Uint8Array(res).buffer;
};

export const saveDocx = (
  notebook: string,
  path: string,
  doc: Record<string, unknown>,
  newMedia: Record<string, NewDocxMedia>,
  pre: Stamp,
  source?: string,
) => invoke<SaveOutcome>("docx_save", { notebook, path, doc, newMedia, pre, ...(source ? { source } : {}) });

export const createDocx = (notebook: string, path: string) =>
  invoke<Stamp>("docx_create", { notebook, path });

/** Restore a binary `.docx` or `.pdf` snapshot from Hivemind's version history by snapshot id. */
export const restoreBinaryVersion = (notebook: string, path: string, id: number, pre: Stamp) =>
  invoke<SaveOutcome>("binary_restore", { notebook, path, id, pre });
