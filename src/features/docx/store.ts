// Zustand session store for open `.docx` documents: load, edit, save with SHA-256 precondition,
// in-flight edit retention via revision counters, move retargeting, tab-close eviction, and conflict handling.
import { create } from "zustand";
import { docKey, movedPath, type FileRef } from "../../documents/keys";
import { readDocx, restoreBinaryVersion, saveDocx, type DocxLoaded, type DocxMedia, type DocxWarning, type NewDocxMedia } from "../../lib/docx";
import type { Stamp } from "../../lib/notebooks";
import { useWorkspace } from "../../workspace/store";

export type DocxStatus = "loading" | "clean" | "dirty" | "saving" | "stale" | "readOnly" | "error";

export interface DocxSession {
  status: DocxStatus;
  saving: boolean;
  rev: number;
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
  saving: false,
  rev: 0,
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

const inFlightSaves = new Map<string, Promise<boolean>>();

export function isDocxDirty(s: DocxSession | undefined): boolean {
  return !!s && (s.status === "dirty" || s.status === "stale");
}

function syncWorkspaceDirty(key: string, dirty: boolean) {
  const ws = useWorkspace.getState();
  for (const pane of ws.panes) {
    for (const tab of pane.tabs) {
      if (tab.kind === "file" && tab.file && docxKey(tab.file) === key) {
        if (!!ws.dirty[tab.id] !== dirty) ws.setDirty(tab.id, dirty);
      }
    }
  }
}

function setSession(key: string, fn: (cur: DocxSession) => DocxSession) {
  useDocxStore.setState((s) => {
    const prev = s.sessions[key] ?? initial;
    const next = fn(prev);
    syncWorkspaceDirty(key, isDocxDirty(next));
    return { sessions: { ...s.sessions, [key]: next } };
  });
}

function applyLoaded(prev: DocxSession, loaded: DocxLoaded): DocxSession {
  return {
    status: loaded.readOnly ? "readOnly" : "clean",
    saving: false,
    rev: prev.rev,
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
  setSession(key, (p) => ({ ...p, status: "loading", saving: false, error: null }));
  try {
    const loaded = await readDocx(ref.notebook, ref.path);
    if (!useDocxStore.getState().refs[key]) return;
    setSession(key, (p) => applyLoaded(p, loaded));
  } catch (e) {
    if (!useDocxStore.getState().refs[key]) return;
    setSession(key, (p) => ({ ...p, status: "error", saving: false, error: e instanceof Error ? e.message : String(e) }));
  }
}

export function editDocx(key: string, doc: Record<string, unknown>) {
  setSession(key, (p) => (p.status === "readOnly" ? p : { ...p, doc, rev: p.rev + 1, status: "dirty", error: null }));
}

export function addDocxMedia(key: string, mime: string, base64: string): string {
  const id = `new-media-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const dataUrl = `data:${mime};base64,${base64}`;
  setSession(key, (p) => ({
    ...p,
    media: { ...p.media, [id]: { id, mime, dataUrl } },
    newMedia: { ...p.newMedia, [id]: { mime, base64 } },
    rev: p.status === "readOnly" ? p.rev : p.rev + 1,
    status: p.status === "readOnly" ? p.status : "dirty",
  }));
  return id;
}

export async function saveDocxSession(key: string, forceOverwrite = false): Promise<boolean> {
  const state = useDocxStore.getState();
  const s = state.sessions[key];
  const ref = state.refs[key];
  if (!s || !ref || !s.doc || !s.stamp || s.saving) return false;
  if (s.status !== "dirty" && !(forceOverwrite && s.status === "stale")) return false;

  const task = (async (): Promise<boolean> => {
    let pre = s.stamp!;
    if (forceOverwrite) {
      try {
        const fresh = await readDocx(ref.notebook, ref.path);
        pre = { sha256: fresh.sha256, size: fresh.size, mtimeMs: fresh.mtimeMs };
      } catch (e) {
        setSession(key, (p) => ({ ...p, saving: false, error: e instanceof Error ? e.message : String(e) }));
        return false;
      }
    }
    const latest = useDocxStore.getState().sessions[key];
    if (!latest || !latest.doc) return false;
    const saveRev = latest.rev;
    const snapshotDoc = latest.doc;
    const snapshotMedia = latest.newMedia;
    setSession(key, (p) => ({ ...p, saving: true, error: null }));
    try {
      const outcome = await saveDocx(ref.notebook, ref.path, snapshotDoc, snapshotMedia, pre, "you");
      const cur = useDocxStore.getState().sessions[key];
      if (!cur) return outcome.status === "saved";
      if (outcome.status === "saved") {
        const savedStamp: Stamp = { sha256: outcome.sha256, size: outcome.size, mtimeMs: outcome.mtimeMs };
        if (cur.rev !== saveRev) {
          // User edited while save was in flight: keep newer edits & dirty state, update stamp to the saved revision.
          setSession(key, (p) => ({
            ...p,
            stamp: savedStamp,
            saving: false,
            status: "dirty",
            changedOnDisk: false,
            error: null,
          }));
          return true;
        }
        // No newer edits: reload clean media IDs/stamp from disk so any newly added media resolves to word/media/.
        const loaded = await readDocx(ref.notebook, ref.path);
        const afterReload = useDocxStore.getState().sessions[key];
        if (!afterReload) return true;
        if (afterReload.rev !== saveRev) {
          setSession(key, (p) => ({
            ...p,
            stamp: { sha256: loaded.sha256, size: loaded.size, mtimeMs: loaded.mtimeMs },
            saving: false,
            status: "dirty",
            changedOnDisk: false,
            error: null,
          }));
          return true;
        }
        setSession(key, (p) => applyLoaded(p, loaded));
        return true;
      }
      if (outcome.status === "stale") {
        setSession(key, (p) => ({ ...p, saving: false, status: "stale", changedOnDisk: true }));
        return false;
      }
      setSession(key, (p) => ({ ...p, saving: false, status: "dirty", error: "The .docx file was deleted or moved on disk." }));
      return false;
    } catch (e) {
      setSession(key, (p) => ({ ...p, saving: false, status: "dirty", error: e instanceof Error ? e.message : String(e) }));
      return false;
    }
  })();

  inFlightSaves.set(key, task);
  try {
    return await task;
  } finally {
    if (inFlightSaves.get(key) === task) inFlightSaves.delete(key);
  }
}

export async function restoreDocxSnapshot(key: string, id: number): Promise<boolean> {
  const state = useDocxStore.getState();
  const s = state.sessions[key];
  const ref = state.refs[key];
  if (!s || !ref || !s.stamp || s.status !== "clean" || s.saving) return false;
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
    if (!ref || !s || s.saving) continue;
    if (s.status === "clean" || s.status === "readOnly") {
      await openDocx(ref, true);
    } else if (s.status === "dirty") {
      setSession(key, (p) => ({ ...p, status: "stale", changedOnDisk: true }));
    }
  }
}

/** Retarget open `.docx` sessions when a file or folder is renamed/moved in a notebook. */
export function retargetDocx(notebook: string, from: string, to: string) {
  useDocxStore.setState((s) => {
    const sessions = { ...s.sessions };
    const refs = { ...s.refs };
    let changed = false;
    for (const [key, ref] of Object.entries(s.refs)) {
      if (ref.notebook !== notebook) continue;
      const nextPath = movedPath(ref.path, from, to);
      if (nextPath === null) continue;
      const nextKey = docxKey({ notebook, path: nextPath });
      const sess = sessions[key];
      delete sessions[key];
      delete refs[key];
      if (sess) sessions[nextKey] = sess;
      refs[nextKey] = { notebook, path: nextPath };
      changed = true;
    }
    return changed ? { sessions, refs } : s;
  });
}

/** Release a `.docx` session once no tab shows it any more. */
export function releaseDocx(key: string) {
  const s = useDocxStore.getState().sessions[key];
  if (!s || s.saving) return;
  useDocxStore.setState((st) => {
    const sessions = { ...st.sessions };
    const refs = { ...st.refs };
    delete sessions[key];
    delete refs[key];
    return { sessions, refs };
  });
}

/** Drop `.docx` sessions under a deleted path or folder. */
export function discardDocxUnder(notebook: string, path: string) {
  useDocxStore.setState((st) => {
    const sessions = { ...st.sessions };
    const refs = { ...st.refs };
    let changed = false;
    for (const [key, ref] of Object.entries(st.refs)) {
      if (ref.notebook === notebook && movedPath(ref.path, path, path) !== null) {
        delete sessions[key];
        delete refs[key];
        changed = true;
      }
    }
    return changed ? { sessions, refs } : st;
  });
}

/** Paths of open `.docx` files under `path` that have unsaved edits. */
export function unsavedDocxUnder(notebook: string, path: string): string[] {
  const { sessions, refs } = useDocxStore.getState();
  return Object.entries(refs)
    .filter(([key, ref]) => ref.notebook === notebook && movedPath(ref.path, path, path) !== null && isDocxDirty(sessions[key]))
    .map(([, ref]) => ref.path);
}

/** Wait for any in-flight `.docx` saves under `path` before a move or delete. */
export async function waitDocxSaves(notebook: string, path: string) {
  const { refs } = useDocxStore.getState();
  const pending = Object.entries(refs)
    .filter(([, ref]) => ref.notebook === notebook && movedPath(ref.path, path, path) !== null)
    .map(([key]) => inFlightSaves.get(key))
    .filter((p): p is Promise<boolean> => !!p);
  if (pending.length) await Promise.all(pending);
}
