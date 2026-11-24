// Zustand session store for open `.docx` documents: load, edit, save with SHA-256 precondition,
// conflict handling, media management, and workspace dirty tracking.
import { create } from "zustand";
import { docKey, type FileRef } from "../../documents/keys";
import { readDocx, restoreBinaryVersion, saveDocx, type DocxLoaded, type DocxMedia, type DocxWarning, type NewDocxMedia } from "../../lib/docx";
import type { Stamp } from "../../lib/notebooks";
import { useWorkspace } from "../../workspace/store";

export type DocxStatus = "loading" | "clean" | "dirty" | "saving" | "stale" | "readOnly" | "error";

export interface DocxSession {
  status: DocxStatus;
  doc: Record<string, unknown> | null;
  media: Record<string, DocxMedia>;
  newMedia: Record<string, NewDocxMedia>;
  stamp: Stamp | null;
  readOnly: string | null;
  warnings: DocxWarning[];
  hasHeadersFooters: boolean;
  version: number;
  error: string | null;
  changedOnDisk: boolean;
}

const initial: DocxSession = {
  status: "loading",
  doc: null,
  media: {},
  newMedia: {},
  stamp: null,
  readOnly: null,
  warnings: [],
  hasHeadersFooters: false,
  version: 0,
  error: null,
  changedOnDisk: false,
};

interface DocxStoreState {
  sessions: Record<string, DocxSession>;
  refs: Record<string, FileRef>;
}

export const useDocxStore = create<DocxStoreState>(() => ({ sessions: {}, refs: {} }));

export const docxKey = (ref: FileRef) => docKey({ kind: "file", file: ref });

function syncWorkspaceDirty(key: string, dirty: boolean) {
  const ws = useWorkspace.getState();
  for (const pane of ws.panes) {
    for (const tab of pane.tabs) {
      if (tab.kind === "file" && tab.file && docxKey(tab.file) === key) {
        ws.setDirty(tab.id, dirty);
      }
    }
  }
}

function setSession(key: string, fn: (cur: DocxSession) => DocxSession) {
  useDocxStore.setState((s) => {
    const prev = s.sessions[key] ?? initial;
    const next = fn(prev);
    syncWorkspaceDirty(key, next.status === "dirty" || next.status === "stale");
    return { sessions: { ...s.sessions, [key]: next } };
  });
}

function applyLoaded(prev: DocxSession, loaded: DocxLoaded): DocxSession {
  return {
    status: loaded.readOnly ? "readOnly" : "clean",
    doc: loaded.doc,
    media: loaded.media,
    newMedia: {},
    stamp: { sha256: loaded.sha256, size: loaded.size, mtimeMs: loaded.mtimeMs },
    readOnly: loaded.readOnly,
    warnings: loaded.warnings,
    hasHeadersFooters: loaded.hasHeadersFooters,
    version: prev.version + 1,
    error: null,
    changedOnDisk: false,
  };
}

export async function openDocx(ref: FileRef, force = false): Promise<void> {
  const key = docxKey(ref);
  useDocxStore.setState((s) => ({ refs: { ...s.refs, [key]: ref } }));
  const cur = useDocxStore.getState().sessions[key];
  if (!force && cur && cur.status !== "error") return;
  setSession(key, (p) => ({ ...p, status: "loading", error: null }));
  try {
    const loaded = await readDocx(ref.notebook, ref.path);
    setSession(key, (p) => applyLoaded(p, loaded));
  } catch (e) {
    setSession(key, (p) => ({ ...p, status: "error", error: e instanceof Error ? e.message : String(e) }));
  }
}

export function editDocx(key: string, doc: Record<string, unknown>) {
  setSession(key, (p) => (p.status === "readOnly" ? p : { ...p, doc, status: "dirty", error: null }));
}

export function addDocxMedia(key: string, mime: string, base64: string): string {
  const id = `new-media-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const dataUrl = `data:${mime};base64,${base64}`;
  setSession(key, (p) => ({
    ...p,
    media: { ...p.media, [id]: { id, mime, dataUrl } },
    newMedia: { ...p.newMedia, [id]: { mime, base64 } },
    status: p.status === "readOnly" ? p.status : "dirty",
  }));
  return id;
}

export async function saveDocxSession(key: string, forceOverwrite = false): Promise<boolean> {
  const state = useDocxStore.getState();
  const s = state.sessions[key];
  const ref = state.refs[key];
  if (!s || !ref || !s.doc || !s.stamp || (s.status !== "dirty" && !(forceOverwrite && s.status === "stale"))) return false;
  let pre = s.stamp;
  if (forceOverwrite) {
    try {
      const fresh = await readDocx(ref.notebook, ref.path);
      pre = { sha256: fresh.sha256, size: fresh.size, mtimeMs: fresh.mtimeMs };
    } catch (e) {
      setSession(key, (p) => ({ ...p, error: e instanceof Error ? e.message : String(e) }));
      return false;
    }
  }
  const snapshotDoc = s.doc;
  const snapshotMedia = s.newMedia;
  setSession(key, (p) => ({ ...p, status: "saving", error: null }));
  try {
    const outcome = await saveDocx(ref.notebook, ref.path, snapshotDoc, snapshotMedia, pre, "you");
    if (outcome.status === "saved") {
      // Reload clean media IDs/stamp from disk so any newly added media resolves to its real word/media/ path.
      const loaded = await readDocx(ref.notebook, ref.path);
      setSession(key, (p) => applyLoaded(p, loaded));
      return true;
    }
    if (outcome.status === "stale") {
      setSession(key, (p) => ({ ...p, status: "stale", changedOnDisk: true }));
      return false;
    }
    setSession(key, (p) => ({ ...p, status: "dirty", error: "The .docx file was deleted or moved on disk." }));
    return false;
  } catch (e) {
    setSession(key, (p) => ({ ...p, status: "dirty", error: e instanceof Error ? e.message : String(e) }));
    return false;
  }
}

export async function restoreDocxSnapshot(key: string, id: number): Promise<boolean> {
  const state = useDocxStore.getState();
  const s = state.sessions[key];
  const ref = state.refs[key];
  if (!s || !ref || !s.stamp || s.status !== "clean") return false;
  const outcome = await restoreBinaryVersion(ref.notebook, ref.path, id, s.stamp);
  if (outcome.status !== "saved") return false;
  await openDocx(ref, true);
  return true;
}

export async function refreshDocxOnDisk(notebook: string, paths: string[]) {
  const wanted = new Set(paths.map((p) => docxKey({ notebook, path: p })));
  const state = useDocxStore.getState();
  for (const key of Object.keys(state.sessions)) {
    if (!wanted.has(key)) continue;
    const s = state.sessions[key];
    const ref = state.refs[key];
    if (!ref || !s) continue;
    if (s.status === "clean" || s.status === "readOnly") {
      await openDocx(ref, true);
    } else if (s.status === "dirty") {
      setSession(key, (p) => ({ ...p, status: "stale", changedOnDisk: true }));
    }
  }
}
