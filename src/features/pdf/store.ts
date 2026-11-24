// Zustand session store for open `.pdf` documents: binary load, non-destructive edits with undo/redo,
// lazy dynamic loading of `pdfWriter`/`pdf-lib` (never on startup path), in-flight save edit retention,
// move retargeting, tab-close eviction, and atomic SHA-256 save.
import { create } from "zustand";
import { docKey, movedPath, type FileRef } from "../../documents/keys";
import { pdfBytes, pdfMeta, restorePdfVersion, savePdfBytes } from "../../lib/pdf";
import type { Stamp } from "../../lib/notebooks";
import { useWorkspace } from "../../workspace/store";
import type { PdfAnnotation, PdfEdits, PdfFormFieldInfo, PdfPageSpec } from "./pdfWriter";

export type PdfStatus = "loading" | "clean" | "dirty" | "saving" | "stale" | "readOnly" | "error";

export interface PdfSession {
  status: PdfStatus;
  saving: boolean;
  rev: number;
  baseBytes: Uint8Array | null;
  mergedSources: Uint8Array[];
  stamp: Stamp | null;
  readOnly: string | null;
  encrypted: boolean;
  tooLarge: boolean;
  formFields: PdfFormFieldInfo[];
  edits: PdfEdits;
  past: PdfEdits[];
  future: PdfEdits[];
  version: number;
  error: string | null;
}

const emptyEdits = (): PdfEdits => ({ pages: [], annotations: [], formValues: {} });

const initial: PdfSession = {
  status: "loading",
  saving: false,
  rev: 0,
  baseBytes: null,
  mergedSources: [],
  stamp: null,
  readOnly: null,
  encrypted: false,
  tooLarge: false,
  formFields: [],
  edits: emptyEdits(),
  past: [],
  future: [],
  version: 0,
  error: null,
};

interface PdfStoreState {
  sessions: Record<string, PdfSession>;
  refs: Record<string, FileRef>;
}

export const usePdfStore = create<PdfStoreState>(() => ({ sessions: {}, refs: {} }));

export const pdfKey = (ref: FileRef) => docKey({ kind: "file", file: ref });
const MAX_UNDO = 100;
const inFlightSaves = new Map<string, Promise<boolean>>();

export function isPdfDirty(s: PdfSession | undefined): boolean {
  return !!s && (s.status === "dirty" || s.status === "stale");
}

function syncDirty(key: string, dirty: boolean) {
  const ws = useWorkspace.getState();
  for (const pane of ws.panes) {
    for (const tab of pane.tabs) {
      if (tab.kind === "file" && tab.file && pdfKey(tab.file) === key) {
        if (!!ws.dirty[tab.id] !== dirty) ws.setDirty(tab.id, dirty);
      }
    }
  }
}

function setSession(key: string, fn: (cur: PdfSession) => PdfSession) {
  usePdfStore.setState((s) => {
    const prev = s.sessions[key] ?? initial;
    const next = fn(prev);
    syncDirty(key, isPdfDirty(next));
    return { sessions: { ...s.sessions, [key]: next } };
  });
}

export async function openPdf(ref: FileRef, force = false): Promise<void> {
  const key = pdfKey(ref);
  usePdfStore.setState((s) => ({ refs: { ...s.refs, [key]: ref } }));
  const cur = usePdfStore.getState().sessions[key];
  if (!force && cur && cur.status !== "error") return;
  setSession(key, (p) => ({ ...p, status: "loading", saving: false, error: null }));
  try {
    const meta = await pdfMeta(ref.notebook, ref.path);
    if (!usePdfStore.getState().refs[key]) return;
    if (meta.tooLarge) {
      setSession(key, (p) => ({
        ...p,
        status: "readOnly",
        saving: false,
        baseBytes: null,
        mergedSources: [],
        stamp: { sha256: meta.sha256, size: meta.size, mtimeMs: meta.mtimeMs },
        readOnly: "This PDF is larger than 64 MB, so it opens read-only via range streaming.",
        tooLarge: true,
        encrypted: false,
        formFields: [],
        edits: emptyEdits(),
        past: [],
        future: [],
        version: p.version + 1,
        error: null,
      }));
      return;
    }
    const [bytes, { initPdfPages }] = await Promise.all([
      pdfBytes(ref.notebook, ref.path),
      import("./pdfWriter"),
    ]);
    const info = await initPdfPages(bytes);
    if (!usePdfStore.getState().refs[key]) return;
    const ro = meta.readOnly ?? (info.encrypted ? "This PDF is password-protected or encrypted, so editing is disabled." : null);
    setSession(key, (p) => ({
      status: ro ? "readOnly" : "clean",
      saving: false,
      rev: p.rev,
      baseBytes: bytes,
      mergedSources: [],
      stamp: { sha256: meta.sha256, size: meta.size, mtimeMs: meta.mtimeMs },
      readOnly: ro,
      encrypted: info.encrypted,
      tooLarge: false,
      formFields: info.formFields,
      // `formValues` stays empty until the user explicitly modifies a field so untouched fields are never rewritten.
      edits: { pages: info.pages, annotations: [], formValues: {} },
      past: [],
      future: [],
      version: p.version + 1,
      error: null,
    }));
  } catch (e) {
    if (!usePdfStore.getState().refs[key]) return;
    setSession(key, (p) => ({ ...p, status: "error", saving: false, error: e instanceof Error ? e.message : String(e) }));
  }
}

export function mutatePdf(key: string, fn: (edits: PdfEdits) => PdfEdits) {
  setSession(key, (p) => {
    if (p.status === "readOnly" || p.status === "loading" || p.status === "error") return p;
    const nextEdits = fn(p.edits);
    if (nextEdits === p.edits) return p;
    const past = [...p.past, p.edits].slice(-MAX_UNDO);
    return { ...p, edits: nextEdits, past, future: [], rev: p.rev + 1, status: "dirty", error: null };
  });
}

export function addPdfAnnotation(key: string, ann: PdfAnnotation) {
  mutatePdf(key, (e) => ({ ...e, annotations: [...e.annotations, ann] }));
}

export function updatePdfAnnotation(key: string, id: string, patch: Partial<PdfAnnotation>) {
  mutatePdf(key, (e) => ({
    ...e,
    annotations: e.annotations.map((a) => (a.id === id ? ({ ...a, ...patch } as PdfAnnotation) : a)),
  }));
}

export function removePdfAnnotation(key: string, id: string) {
  mutatePdf(key, (e) => ({ ...e, annotations: e.annotations.filter((a) => a.id !== id) }));
}

export function setPdfFormValue(key: string, name: string, value: string | boolean | string[]) {
  mutatePdf(key, (e) => ({ ...e, formValues: { ...e.formValues, [name]: value } }));
}

export function rotatePdfPage(key: string, pageId: string, delta: 90 | 270) {
  mutatePdf(key, (e) => ({
    ...e,
    pages: e.pages.map((p) => (p.id === pageId ? { ...p, rotation: (((p.rotation + delta) % 360) as 0 | 90 | 180 | 270) } : p)),
  }));
}

export function reorderPdfPages(key: string, fromIdx: number, toIdx: number) {
  mutatePdf(key, (e) => {
    if (fromIdx === toIdx || fromIdx < 0 || toIdx < 0 || fromIdx >= e.pages.length || toIdx >= e.pages.length) return e;
    const pages = [...e.pages];
    const [moved] = pages.splice(fromIdx, 1);
    pages.splice(toIdx, 0, moved);
    return { ...e, pages };
  });
}

export function deletePdfPage(key: string, pageId: string) {
  mutatePdf(key, (e) => {
    if (e.pages.length <= 1) return e;
    return { ...e, pages: e.pages.filter((p) => p.id !== pageId), annotations: e.annotations.filter((a) => a.pageId !== pageId) };
  });
}

export function insertBlankPdfPage(key: string, afterIndex: number) {
  mutatePdf(key, (e) => {
    const pages = [...e.pages];
    const blank: PdfPageSpec = { id: `blank-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`, source: "blank", rotation: 0 };
    pages.splice(Math.min(pages.length, afterIndex + 1), 0, blank);
    return { ...e, pages };
  });
}

export async function mergePdfBytes(key: string, otherBytes: Uint8Array): Promise<number> {
  const { initPdfPages } = await import("./pdfWriter");
  const info = await initPdfPages(otherBytes);
  if (info.encrypted) throw new Error("Cannot merge a password-protected PDF");
  setSession(key, (p) => {
    if (p.status === "readOnly") return p;
    const mergedIndex = p.mergedSources.length;
    const added: PdfPageSpec[] = info.pages.map((_, idx) => ({
      id: `merged-${mergedIndex}-${idx}-${Date.now().toString(36)}`,
      source: "merged",
      mergedIndex,
      sourcePageIndex: idx,
      rotation: 0,
    }));
    const past = [...p.past, p.edits].slice(-MAX_UNDO);
    return {
      ...p,
      mergedSources: [...p.mergedSources, otherBytes],
      edits: { ...p.edits, pages: [...p.edits.pages, ...added] },
      past,
      future: [],
      rev: p.rev + 1,
      status: "dirty",
      error: null,
    };
  });
  return info.pages.length;
}

export function undoPdf(key: string) {
  setSession(key, (p) => {
    if (!p.past.length) return p;
    const prev = p.past[p.past.length - 1];
    return { ...p, edits: prev, past: p.past.slice(0, -1), future: [p.edits, ...p.future], rev: p.rev + 1, status: "dirty" };
  });
}

export function redoPdf(key: string) {
  setSession(key, (p) => {
    if (!p.future.length) return p;
    const next = p.future[0];
    return { ...p, edits: next, past: [...p.past, p.edits], future: p.future.slice(1), rev: p.rev + 1, status: "dirty" };
  });
}

export async function savePdfSession(key: string, opts: { forceOverwrite?: boolean; flattenForm?: boolean } = {}): Promise<boolean> {
  const state = usePdfStore.getState();
  const s = state.sessions[key];
  const ref = state.refs[key];
  if (!s || !ref || !s.baseBytes || !s.stamp || s.saving) return false;
  if (s.status !== "dirty" && !(opts.forceOverwrite && s.status === "stale") && !opts.flattenForm) return false;

  const task = (async (): Promise<boolean> => {
    let pre = s.stamp!;
    if (opts.forceOverwrite) {
      try {
        const fresh = await pdfMeta(ref.notebook, ref.path);
        pre = { sha256: fresh.sha256, size: fresh.size, mtimeMs: fresh.mtimeMs };
      } catch (e) {
        setSession(key, (p) => ({ ...p, saving: false, error: e instanceof Error ? e.message : String(e) }));
        return false;
      }
    }
    const latest = usePdfStore.getState().sessions[key];
    if (!latest || !latest.baseBytes) return false;
    const saveRev = latest.rev;
    const baseBytes = latest.baseBytes;
    const merged = latest.mergedSources;
    const edits: PdfEdits = opts.flattenForm ? { ...latest.edits, flattenForm: true } : latest.edits;
    setSession(key, (p) => ({ ...p, saving: true, error: null }));
    try {
      const { applyPdfEdits } = await import("./pdfWriter");
      const outBytes = await applyPdfEdits(baseBytes, merged, edits);
      const outcome = await savePdfBytes(ref.notebook, ref.path, outBytes, pre, "you");
      const cur = usePdfStore.getState().sessions[key];
      if (!cur) return outcome.status === "saved";
      if (outcome.status === "saved") {
        const savedStamp: Stamp = { sha256: outcome.sha256, size: outcome.size, mtimeMs: outcome.mtimeMs };
        if (cur.rev !== saveRev) {
          // User added further edits while the save was in flight: keep newer edits on top of the pre-save base,
          // advance `stamp` to the saved disk stamp, and stay dirty so the next save writes everything cleanly.
          setSession(key, (p) => ({ ...p, stamp: savedStamp, saving: false, status: "dirty", error: null }));
          return true;
        }
        await openPdf(ref, true);
        return true;
      }
      if (outcome.status === "stale") {
        setSession(key, (p) => ({ ...p, saving: false, status: "stale" }));
        return false;
      }
      setSession(key, (p) => ({ ...p, saving: false, status: "dirty", error: "The PDF file was deleted or moved on disk." }));
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

export async function restorePdfSnapshot(key: string, id: number): Promise<boolean> {
  const state = usePdfStore.getState();
  const s = state.sessions[key];
  const ref = state.refs[key];
  if (!s || !ref || !s.stamp || s.status !== "clean" || s.saving) return false;
  const outcome = await restorePdfVersion(ref.notebook, ref.path, id, s.stamp);
  if (outcome.status !== "saved") return false;
  await openPdf(ref, true);
  return true;
}

export async function refreshPdfOnDisk(notebook: string, paths: string[]) {
  const wanted = new Set(paths.map((p) => pdfKey({ notebook, path: p })));
  const state = usePdfStore.getState();
  for (const key of Object.keys(state.sessions)) {
    if (!wanted.has(key)) continue;
    const s = state.sessions[key];
    const ref = state.refs[key];
    if (!ref || !s || s.saving) continue;
    if (s.status === "clean" || s.status === "readOnly") await openPdf(ref, true);
    else if (s.status === "dirty") setSession(key, (p) => ({ ...p, status: "stale" }));
  }
}

/** Retarget open `.pdf` sessions when a file or folder is renamed/moved in a notebook. */
export function retargetPdf(notebook: string, from: string, to: string) {
  usePdfStore.setState((s) => {
    const sessions = { ...s.sessions };
    const refs = { ...s.refs };
    let changed = false;
    for (const [key, ref] of Object.entries(s.refs)) {
      if (ref.notebook !== notebook) continue;
      const nextPath = movedPath(ref.path, from, to);
      if (nextPath === null) continue;
      const nextKey = pdfKey({ notebook, path: nextPath });
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

/** Release a `.pdf` session once no tab shows it any more. */
export function releasePdf(key: string) {
  const s = usePdfStore.getState().sessions[key];
  if (!s || s.saving) return;
  usePdfStore.setState((st) => {
    const sessions = { ...st.sessions };
    const refs = { ...st.refs };
    delete sessions[key];
    delete refs[key];
    return { sessions, refs };
  });
}

/** Drop `.pdf` sessions under a deleted path or folder. */
export function discardPdfUnder(notebook: string, path: string) {
  usePdfStore.setState((st) => {
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

/** Paths of open `.pdf` files under `path` that have unsaved edits. */
export function unsavedPdfUnder(notebook: string, path: string): string[] {
  const { sessions, refs } = usePdfStore.getState();
  return Object.entries(refs)
    .filter(([key, ref]) => ref.notebook === notebook && movedPath(ref.path, path, path) !== null && isPdfDirty(sessions[key]))
    .map(([, ref]) => ref.path);
}

/** Wait for any in-flight `.pdf` saves under `path` before a move or delete. */
export async function waitPdfSaves(notebook: string, path: string) {
  const { refs } = usePdfStore.getState();
  const pending = Object.entries(refs)
    .filter(([, ref]) => ref.notebook === notebook && movedPath(ref.path, path, path) !== null)
    .map(([key]) => inFlightSaves.get(key))
    .filter((p): p is Promise<boolean> => !!p);
  if (pending.length) await Promise.all(pending);
}
