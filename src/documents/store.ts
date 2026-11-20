// Open notebook pages, one session per document key, shared by every tab that shows the page. The store lives outside
// React, so moving between the Notes and Memory pages (which remounts the workspace) keeps edits and state.
import { create } from "zustand";
import { deleteDraft, getFileDraft, putDraft } from "../lib/drafts";
import { readFile, saveFile, type Loaded as RawLoaded } from "../lib/notebooks";
import { mergeBody } from "../features/editor/merge";
import { docKey, draftKeyOf, movedPath, type FileRef } from "./keys";
import { initial, isUnsaved, reduce, type DocEvent, type DocState, type Loaded } from "./session";

interface DocumentsState {
  docs: Record<string, DocState>;
  refs: Record<string, FileRef>;
  dispatch: (key: string, event: DocEvent) => void;
}

export const useDocuments = create<DocumentsState>()((set) => ({
  docs: {},
  refs: {},
  dispatch: (key, event) => set((s) => ({ docs: { ...s.docs, [key]: reduce(s.docs[key] ?? initial, event) } })),
}));

const toLoaded = (raw: RawLoaded): Loaded => ({
  text: raw.text,
  stamp: { sha256: raw.sha256, size: raw.size, mtimeMs: raw.mtimeMs },
  format: raw.format,
  readOnly: raw.readOnly,
  binary: raw.binary,
});

export const keyOf = (ref: FileRef) => docKey({ kind: "file", file: ref });
const get = (key: string) => useDocuments.getState().docs[key];
const dispatch = (key: string, event: DocEvent) => useDocuments.getState().dispatch(key, event);
const BASE_LIMIT = 2 * 1024 * 1024;
const DRAFT_LIMIT = 16 * 1024 * 1024;

/** Load a page once (later tabs share it). A draft left by an earlier run comes back as unsaved edits. */
export async function open(ref: FileRef) {
  const key = keyOf(ref);
  useDocuments.setState((s) => ({ refs: { ...s.refs, [key]: ref } }));
  if (get(key) && get(key).status !== "error") return;
  try {
    const loaded = toLoaded(await readFile(ref.notebook, ref.path));
    const draft = await getFileDraft(await draftKeyOf(key)).catch(() => null);
    if (!draft || loaded.readOnly || loaded.binary) { dispatch(key, { type: "loaded", loaded }); return; }
    if (draft.precondition.sha256 === loaded.stamp.sha256) {
      dispatch(key, { type: "loaded", loaded, draft: { text: draft.mine, at: draft.savedAt } });
      return;
    }
    // The file changed after the draft was written: merge the draft into the current file when it can be done cleanly,
    // otherwise show the draft against the file in the merge dialog.
    const base = draft.base;
    const merged = base !== undefined ? mergeBody(base, draft.mine, loaded.text) : null;
    if (merged && merged.conflicts === 0) dispatch(key, { type: "loaded", loaded, draft: { text: merged.text, at: draft.savedAt } });
    else {
      const original: Loaded = { ...loaded, text: base ?? loaded.text, stamp: draft.precondition };
      dispatch(key, { type: "loaded", loaded: original, draft: { text: draft.mine, at: draft.savedAt } });
      dispatch(key, { type: "stale", theirs: loaded });
    }
  } catch (e) {
    dispatch(key, { type: "failed", error: String(e) });
  }
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();

/** Keep a draft of unsaved edits, a little after typing stops. */
function scheduleDraft(key: string) {
  clearTimeout(timers.get(key));
  const s = get(key);
  const wait = s && s.text.length > 256 * 1024 ? 5000 : 1000;
  timers.set(key, setTimeout(() => { timers.delete(key); void writeDraft(key); }, wait));
}

async function writeDraft(key: string) {
  const s = get(key), ref = useDocuments.getState().refs[key];
  if (!s?.base || !ref) return;
  const draftKey = await draftKeyOf(key);
  if (!isUnsaved(s)) { await deleteDraft(draftKey).catch(() => {}); return; }
  if (s.text.length > DRAFT_LIMIT) return;
  await putDraft({
    key: draftKey, kind: "file", target: ref, precondition: s.base.stamp, format: s.base.format,
    base: s.base.text.length <= BASE_LIMIT ? s.base.text : undefined, mine: s.text, savedAt: new Date().toISOString(),
  }).catch(() => {});
}

/** Write any pending draft now (a tab closing, the app leaving the page). */
export function flushDraft(key: string) {
  if (!timers.has(key)) return;
  clearTimeout(timers.get(key));
  timers.delete(key);
  void writeDraft(key);
}

export function edit(key: string, text: string) {
  dispatch(key, { type: "edited", text });
  scheduleDraft(key);
}

/** Save the document. Returns the state after the attempt. */
export async function save(key: string) {
  const s = get(key), ref = useDocuments.getState().refs[key];
  if (!s?.base || !ref || s.status !== "dirty") return get(key);
  dispatch(key, { type: "saveStarted" });
  const text = get(key).saving!;
  try {
    const out = await saveFile(ref.notebook, ref.path, text, s.base.stamp, s.base.format);
    if (out.status === "saved") {
      dispatch(key, { type: "saved", stamp: { sha256: out.sha256, size: out.size, mtimeMs: out.mtimeMs } });
      if (!isUnsaved(get(key))) { clearTimeout(timers.get(key)); timers.delete(key); await deleteDraft(await draftKeyOf(key)).catch(() => {}); }
    } else if (out.status === "stale") {
      dispatch(key, { type: "stale", theirs: toLoaded(await readFile(ref.notebook, ref.path)) });
    } else {
      dispatch(key, { type: "gone" });
    }
  } catch (e) {
    dispatch(key, { type: "failed", error: String(e) });
  }
  return get(key);
}

/** The user resolved a merge: the result becomes the unsaved text, based on the newer version, and is saved. */
export async function resolveMerge(key: string, text: string) {
  const theirs = get(key)?.theirs;
  if (!theirs) return;
  dispatch(key, { type: "merged", text, theirs });
  scheduleDraft(key);
  await save(key);
}

/** Drop unsaved edits and show what is on disk. */
export async function reload(key: string) {
  const ref = useDocuments.getState().refs[key];
  if (!ref) return;
  try {
    dispatch(key, { type: "reloaded", theirs: toLoaded(await readFile(ref.notebook, ref.path)) });
    await deleteDraft(await draftKeyOf(key)).catch(() => {});
  } catch (e) {
    dispatch(key, { type: "gone" });
    dispatch(key, { type: "failed", error: String(e) });
  }
}

/** Another program changed a file: an open document follows it or warns. */
export async function refresh(notebook: string, paths: string[]) {
  const { refs } = useDocuments.getState();
  const wanted = new Set(paths.map((p) => keyOf({ notebook, path: p })));
  for (const [key, ref] of Object.entries(refs)) {
    if (!wanted.has(key) || !get(key) || get(key).status === "loading") continue;
    try {
      dispatch(key, { type: "outsideChange", theirs: toLoaded(await readFile(ref.notebook, ref.path)) });
    } catch {
      if (get(key)?.base) dispatch(key, { type: "gone" });
    }
  }
}

/** A page or folder moved: its documents follow under their new keys (Rust has already moved the drafts). */
export function retarget(notebook: string, from: string, to: string) {
  useDocuments.setState((s) => {
    const docs = { ...s.docs }, refs = { ...s.refs };
    for (const [key, ref] of Object.entries(s.refs)) {
      if (ref.notebook !== notebook) continue;
      const path = movedPath(ref.path, from, to);
      if (path === null) continue;
      const next = keyOf({ notebook, path });
      const doc = docs[key];
      delete docs[key]; delete refs[key];
      if (doc) docs[next] = doc;
      refs[next] = { notebook, path };
      const timer = timers.get(key);
      if (timer) { clearTimeout(timer); timers.delete(key); scheduleDraft(next); }
    }
    return { docs, refs };
  });
}

/** Forget a document no tab shows any more; a dirty one keeps its draft for next time. */
export function release(key: string) {
  flushDraft(key);
  useDocuments.setState((s) => {
    const docs = { ...s.docs }, refs = { ...s.refs };
    delete docs[key]; delete refs[key];
    return { docs, refs };
  });
}

/** Drop a document and its draft (the file was deleted on purpose). */
export function discard(key: string) {
  clearTimeout(timers.get(key));
  timers.delete(key);
  useDocuments.setState((s) => {
    const docs = { ...s.docs }, refs = { ...s.refs };
    delete docs[key]; delete refs[key];
    return { docs, refs };
  });
  void draftKeyOf(key).then(deleteDraft).catch(() => {});
}
