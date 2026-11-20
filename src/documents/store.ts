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
  /** Apply an event to an open document. A document no tab holds any more is left alone, so a read or save that ends
   *  after its tab closed cannot bring it back (Codex review of 32fd236, S1). */
  dispatch: (key: string, event: DocEvent) => void;
}

export const useDocuments = create<DocumentsState>()((set) => ({
  docs: {},
  refs: {},
  dispatch: (key, event) => set((s) => (s.docs[key] ? { docs: { ...s.docs, [key]: reduce(s.docs[key], event) } } : s)),
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
/** Limits in UTF-8 bytes, under Rust's 32 MiB for a whole serialized draft. */
const BASE_LIMIT = 2 * 1024 * 1024;
const DRAFT_LIMIT = 12 * 1024 * 1024;

/** A file read failed because the file is not there (deleted or moved), not for some other reason. */
export const isMissing = (e: unknown) => /does not exist|not found|os error [23]\b/i.test(String(e));

/** UTF-8 size of `text`, counted without copying it. */
export function utf8Bytes(text: string) {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

// Work in flight per document key: loads (one per document, shared by every tab), saves and draft writes. A move waits
// for all of them before Rust moves the files and drafts, and documents being moved neither save nor write drafts.
const loads = new Map<string, Promise<void>>();
const saves = new Map<string, Promise<void>>();
const writing = new Map<string, Promise<void>>();
/** The session of each open document: a new number whenever it is opened, reopened or moved. A read or save that
 *  ends applies only to the session that started it (Codex re-review of c496e1c, S1 and S5). */
const generations = new Map<string, number>();
let generationCount = 0;
/** The text the stored draft of each document holds, so quitting can tell which edits are not kept yet (N4). */
const kept = new Map<string, string>();

/** Moves in progress. A page under one, including one opened after the move began, neither saves nor writes drafts
 *  until the move ends, and its tab closing lets it go only then (Codex re-review of c496e1c, N3 and N5). */
const moves = new Set<{ notebook: string; from: string; done: Promise<void> }>();
function isMoving(key: string) {
  const ref = useDocuments.getState().refs[key];
  return !!ref && [...moves].some((m) => m.notebook === ref.notebook && movedPath(ref.path, m.from, m.from) !== null);
}

/** Load a page once (later tabs share the same load). A draft left by an earlier run comes back as unsaved edits.
 *  Opening a page whose load failed tries again; its draft is never touched (Codex review of 32fd236, D6). */
export function open(ref: FileRef): Promise<void> {
  const key = keyOf(ref);
  useDocuments.setState((s) => ({ refs: { ...s.refs, [key]: ref } }));
  const doc = get(key);
  if (doc && doc.status !== "error") return loads.get(key) ?? Promise.resolve();
  useDocuments.setState((s) => ({ docs: { ...s.docs, [key]: initial } }));
  return startLoad(key, ref);
}

function startLoad(key: string, ref: FileRef) {
  const generation = ++generationCount;
  generations.set(key, generation);
  const run = load(key, ref, generation).finally(() => { if (loads.get(key) === run) loads.delete(key); });
  loads.set(key, run);
  return run;
}

/** Whether `generation` is still the session of the document at `key` (it was not closed, reopened or moved). */
const current = (key: string, generation: number | undefined) =>
  generation !== undefined && generations.get(key) === generation && !!get(key);

async function load(key: string, ref: FileRef, attempt: number) {
  try {
    const loaded = toLoaded(await readFile(ref.notebook, ref.path));
    const draft = await getFileDraft(await draftKeyOf(key)).catch(() => null);
    if (!current(key, attempt)) return;
    if (draft) kept.set(key, draft.mine);
    if (!draft || loaded.readOnly || loaded.binary) { dispatch(key, { type: "loaded", loaded }); return; }
    if (draft.precondition.sha256 === loaded.stamp.sha256) {
      dispatch(key, { type: "loaded", loaded, draft: { text: draft.mine, at: draft.savedAt } });
      return;
    }
    // The file changed after the draft was written: merge the draft into the current file when it can be done cleanly,
    // otherwise show the draft against the file in the merge dialog. A draft without its base (the page was too large
    // to keep one) never merges by itself: an empty base makes every difference a conflict the user resolves (Codex
    // review of 32fd236, D4).
    const base = draft.base;
    const merged = base !== undefined ? mergeBody(base, draft.mine, loaded.text) : null;
    if (merged && merged.conflicts === 0) dispatch(key, { type: "loaded", loaded, draft: { text: merged.text, at: draft.savedAt } });
    else {
      const original: Loaded = { ...loaded, text: base ?? "", stamp: draft.precondition };
      dispatch(key, { type: "loaded", loaded: original, draft: { text: draft.mine, at: draft.savedAt } });
      dispatch(key, { type: "stale", theirs: loaded });
    }
  } catch (e) {
    if (current(key, attempt)) dispatch(key, { type: "failed", error: String(e) });
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

/** Write the draft of `key` as the document is now (or delete it when nothing is unsaved). Writes of one document run
 *  one after another, so the last one written is the newest (Codex review of 32fd236, D7). */
function writeDraft(key: string): Promise<void> {
  const s = get(key), ref = useDocuments.getState().refs[key];
  if (isMoving(key)) {
    // Moving: the draft is written under its new key once the move is done (`retarget` carries the timer over, and
    // quitting waits for the move).
    if (s && isUnsaved(s)) scheduleDraft(key);
    return writing.get(key) ?? Promise.resolve();
  }
  const run = (writing.get(key) ?? Promise.resolve()).then(() => keepDraft(key, s, ref));
  writing.set(key, run);
  void run.finally(() => { if (writing.get(key) === run) writing.delete(key); });
  return run;
}

async function keepDraft(key: string, s: DocState | undefined, ref: FileRef | undefined) {
  if (!s?.base || !ref) return;
  const draftKey = await draftKeyOf(key);
  if (!isUnsaved(s)) {
    await deleteDraft(draftKey).catch(() => {});
    kept.delete(key);
    dispatch(key, { type: "draft", error: null });
    return;
  }
  // Measured in bytes, and every failure is shown, so the user knows when edits exist only in the window (Codex review
  // of 32fd236, D9).
  if (utf8Bytes(s.text) > DRAFT_LIMIT) {
    dispatch(key, { type: "draft", error: "the page is too large to keep a draft of (over 12 MB)" });
    return;
  }
  try {
    await putDraft({
      key: draftKey, kind: "file", target: ref, precondition: s.base.stamp, format: s.base.format,
      base: utf8Bytes(s.base.text) <= BASE_LIMIT ? s.base.text : undefined, mine: s.text, savedAt: new Date().toISOString(),
    });
    kept.set(key, s.text);
    dispatch(key, { type: "draft", error: null });
  } catch (e) {
    dispatch(key, { type: "draft", error: String(e) });
  }
}

/** Write any pending draft now (a tab closing, the app leaving the page). */
export function flushDraft(key: string): Promise<void> {
  if (!timers.has(key)) return writing.get(key) ?? Promise.resolve();
  clearTimeout(timers.get(key));
  timers.delete(key);
  return writeDraft(key);
}

/** Before the app quits: let moves finish, then write drafts until every unsaved page's text is in its draft, edits
 *  typed meanwhile included. Returns the pages whose latest edits are not kept, with the reason (Codex review of
 *  32fd236, D5; re-review of c496e1c, N3 and N4). */
export async function flushAllDrafts(): Promise<string[]> {
  const behind = () => Object.entries(useDocuments.getState().docs).filter(([k, d]) => isUnsaved(d) && kept.get(k) !== d.text);
  for (let round = 0; round < 3; round++) {
    await Promise.all([...moves].map((m) => m.done));
    const keys = new Set([...timers.keys(), ...behind().filter(([, d]) => !d.draftError).map(([k]) => k)]);
    for (const key of keys) { clearTimeout(timers.get(key)); timers.delete(key); }
    const runs = [...[...keys].map(writeDraft), ...writing.values()];
    if (!runs.length && !moves.size) break;
    await Promise.all(runs);
  }
  const { refs } = useDocuments.getState();
  return behind().map(([k, d]) => `${refs[k]?.path ?? k}: ${d.draftError ?? "the latest edits were made while quitting"}`);
}

export function edit(key: string, text: string) {
  dispatch(key, { type: "edited", text });
  scheduleDraft(key);
}

/** Save the document. Returns the state after the attempt. */
export async function save(key: string) {
  const s = get(key), ref = useDocuments.getState().refs[key];
  if (!s?.base || !ref || s.status !== "dirty" || isMoving(key)) return get(key);
  dispatch(key, { type: "saveStarted" });
  const text = get(key).saving!;
  const generation = generations.get(key);
  const run = (async () => {
    try {
      const out = await saveFile(ref.notebook, ref.path, text, s.base!.stamp, s.base!.format);
      if (!current(key, generation)) return;
      if (out.status === "saved") {
        dispatch(key, { type: "saved", stamp: { sha256: out.sha256, size: out.size, mtimeMs: out.mtimeMs } });
        if (!isUnsaved(get(key))) { clearTimeout(timers.get(key)); timers.delete(key); await writeDraft(key); }
      } else if (out.status === "stale") {
        const theirs = toLoaded(await readFile(ref.notebook, ref.path));
        if (current(key, generation)) dispatch(key, { type: "stale", theirs });
      } else {
        dispatch(key, { type: "gone" });
      }
    } catch (e) {
      if (current(key, generation)) dispatch(key, { type: "failed", error: String(e) });
    }
  })();
  saves.set(key, run);
  await run;
  if (saves.get(key) === run) saves.delete(key);
  return get(key);
}

/** The user resolved a merge against `theirs`, the version the dialog showed. The result becomes the unsaved text based
 *  on that version and is saved against it, so a newer outside save made while the dialog was open is never
 *  overwritten: the save finds it and asks for another merge (Codex review of 32fd236, D2). */
export async function resolveMerge(key: string, text: string, theirs: Loaded) {
  if (!get(key)) return;
  dispatch(key, { type: "merged", text, theirs });
  scheduleDraft(key);
  // A result equal to the version shown has nothing to save, but the file may have moved on since that version: read
  // it again, and the clean page follows it (Codex re-review of c496e1c, D2).
  if (get(key)?.status === "clean") await recheck(key);
  else await save(key);
}

/** Drop unsaved edits and show what is on disk. Edits typed while the file is read cancel the reload (Codex review of
 *  32fd236, S5). Returns whether it happened. */
export async function reload(key: string): Promise<boolean> {
  const ref = useDocuments.getState().refs[key];
  const before = get(key), generation = generations.get(key);
  if (!ref || !before) return false;
  try {
    const theirs = toLoaded(await readFile(ref.notebook, ref.path));
    if (!current(key, generation) || get(key)?.text !== before.text) return false;
    clearTimeout(timers.get(key)); timers.delete(key);
    dispatch(key, { type: "reloaded", theirs });
    await writeDraft(key);
    return true;
  } catch (e) {
    if (!current(key, generation)) return false;
    if (isMissing(e)) dispatch(key, { type: "gone" });
    dispatch(key, { type: "failed", error: String(e) });
    return false;
  }
}

/** Read an open document's file again: a clean one follows it, a dirty one warns. A read that fails for another
 *  reason than the file being gone (a lock, a scanner) changes nothing (Codex review of 32fd236, S3). */
async function recheck(key: string) {
  const ref = useDocuments.getState().refs[key], generation = generations.get(key);
  if (!ref || !get(key) || get(key).status === "loading") return;
  try {
    const theirs = toLoaded(await readFile(ref.notebook, ref.path));
    if (current(key, generation)) dispatch(key, { type: "outsideChange", theirs });
  } catch (e) {
    if (current(key, generation) && get(key)?.base && isMissing(e)) dispatch(key, { type: "gone" });
  }
}

/** Another program changed files: the open documents showing them follow or warn. */
export async function refresh(notebook: string, paths: string[]) {
  const wanted = new Set(paths.map((p) => keyOf({ notebook, path: p })));
  for (const key of Object.keys(useDocuments.getState().refs)) if (wanted.has(key)) await recheck(key);
}

/** Before a page or folder moves: write pending drafts, let loads, saves and draft writes finish, and hold new ones
 *  until the move is done (Codex review of 32fd236, S2 and D7). Returns the function that ends the hold. */
export async function beforeMove(notebook: string, from: string): Promise<() => void> {
  const keys = Object.entries(useDocuments.getState().refs)
    .filter(([, ref]) => ref.notebook === notebook && movedPath(ref.path, from, from) !== null)
    .map(([key]) => key);
  for (const key of keys) void flushDraft(key);
  let end = () => {};
  const move = { notebook, from, done: new Promise<void>((resolve) => { end = resolve; }) };
  moves.add(move);
  await Promise.all(keys.flatMap((key) => [loads.get(key), saves.get(key), writing.get(key)]));
  return () => {
    moves.delete(move);
    end();
    // Tabs closed during the move let their documents go now (the sync releases what no tab shows).
    useDocuments.setState({});
  };
}

/** A page or folder moved: its documents follow under their new keys (Rust has already moved the drafts). A page
 *  still opening starts its read again at the new path (Codex re-review of c496e1c, N5). */
export function retarget(notebook: string, from: string, to: string) {
  const reopen: [string, FileRef][] = [];
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
      generations.delete(key);
      generations.set(next, ++generationCount);
      if (kept.has(key)) { kept.set(next, kept.get(key)!); kept.delete(key); }
      if (doc?.status === "loading") reopen.push([next, { notebook, path }]);
      const timer = timers.get(key);
      if (timer) { clearTimeout(timer); timers.delete(key); scheduleDraft(next); }
    }
    return { docs, refs };
  });
  for (const [key, ref] of reopen) void startLoad(key, ref);
}

/** Forget a document no tab shows any more; a dirty one keeps its draft for next time. During a move it stays until
 *  the move ends, so edits typed meanwhile are written under the new name (Codex re-review of c496e1c, N3). */
export function release(key: string) {
  if (isMoving(key)) return;
  void flushDraft(key);
  generations.delete(key);
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
  generations.delete(key);
  kept.delete(key);
  useDocuments.setState((s) => {
    const docs = { ...s.docs }, refs = { ...s.refs };
    delete docs[key]; delete refs[key];
    return { docs, refs };
  });
  void (writing.get(key) ?? Promise.resolve()).then(() => draftKeyOf(key)).then(deleteDraft).catch(() => {});
}

/** The pages under `path` (a page, or a section and everything in it) that hold unsaved edits. */
export function unsavedUnder(notebook: string, path: string): string[] {
  const { docs, refs } = useDocuments.getState();
  return Object.entries(refs)
    .filter(([key, ref]) => ref.notebook === notebook && movedPath(ref.path, path, path) !== null && isUnsaved(docs[key]))
    .map(([, ref]) => ref.path);
}
