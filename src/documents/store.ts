// Open notebook pages, one session per document key, shared by every tab that shows the page. The store lives outside
// React, so moving between the Notes and Memory pages (which remounts the workspace) keeps edits and state.
import { create } from "zustand";
import { deleteDraft, getFileDraft, putDraft } from "../lib/drafts";
import { isRichDoc, type Loaded as RawLoaded } from "../lib/notebooks";
import { mergeBody } from "../features/editor/merge";
import { isLm } from "./adapters/lmdoc";
import { readDoc, reopenDoc, saveDoc } from "./io";
import { docKey, draftKeyOf, movedPath, type FileRef } from "./keys";
import { initial, isUnsaved, reduce, type DocEvent, type DocState, type FormatChange, type Loaded } from "./session";

/** A move or delete in progress over a page or folder (`hold`); `into` is the destination of a move. */
export interface Held { notebook: string; from: string; kind: "move" | "delete" | "into" }

interface DocumentsState {
  docs: Record<string, DocState>;
  refs: Record<string, FileRef>;
  /** Moves and deletes in progress, for the pages to show it. */
  held: Held[];
  /** Apply an event to an open document. A document no tab holds any more is left alone, so a read or save that ends
   *  after its tab closed cannot bring it back (Codex review of 32fd236, S1). */
  dispatch: (key: string, event: DocEvent) => void;
}

export const useDocuments = create<DocumentsState>()((set) => ({
  docs: {},
  refs: {},
  held: [],
  dispatch: (key, event) => set((s) => (s.docs[key] ? { docs: { ...s.docs, [key]: reduce(s.docs[key], event) } } : s)),
}));

const toLoaded = (raw: RawLoaded): Loaded => ({
  text: raw.text,
  stamp: { sha256: raw.sha256, size: raw.size, mtimeMs: raw.mtimeMs },
  format: raw.format,
  readOnly: raw.readOnly,
  binary: raw.binary,
  convertible: raw.convertible,
  chooseEol: raw.chooseEol,
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
/** The text each document's stored draft holds, set only once a write succeeded, so quitting can tell which edits are
 *  not kept yet (Codex re-reviews of c496e1c and b82e9ab, N4). */
const kept = new Map<string, string>();
/** Pages no tab shows any more whose last draft could not be written, with the reason: reported at quit (N3). */
const unkept = new Map<string, string>();
let draftLost: (line: string) => void = () => {};
/** Called when a page no tab shows any more could not keep its last edits as a draft. */
export function onDraftLost(listener: (line: string) => void) { draftLost = listener; }

/** The Living Memory store Hivemind is connected to (the root `connect` reports); undefined while it may be changing.
 *  Each open Living Memory page belongs to the store it was read from: it saves only into that store, and its draft
 *  names it, so an edit never lands in another store that has a page of the same name (Codex review of 32fee20, D1). */
let lmStore: string | undefined;
const pageStores = new Map<string, string>();
// Exact apart from separators: `connect` reports the root as the filesystem names it, so letter case tells two stores in
// a case-sensitive folder apart (Codex review of dd4c1b0, R3-D8).
const storeId = (root: string) => root.replace(/\\/g, "/").replace(/\/+$/, "");
const sameStore = (a: string | undefined, b: string | undefined) => a !== undefined && b !== undefined && storeId(a) === storeId(b);
const otherStore = (key: string, ref: FileRef | undefined) => !!ref && isLm(ref) && !sameStore(pageStores.get(key), lmStore);
/** Pages parked by a store switch, with the session they had: it comes back when their store does (R3-D2, R3-U2). */
const retained = new Map<string, DocState>();

/** The store Hivemind is connected to, for an action to remember where it started. */
export const connectedStore = () => lmStore;

/** Whether the page at `key` may reach Living Memory now: not a page of another store, and not parked. Commands that
 *  write or open files for it (Recreate, Attach, attachments) check this (Codex review of dd4c1b0, R3-D2 and R3-P3). */
export function inOwnStore(key: string): boolean {
  const ref = useDocuments.getState().refs[key];
  return !ref || !isLm(ref) || (!otherStore(key, ref) && !retained.has(key));
}

/** Hivemind connected to the store at `root`. A Living Memory page read from another store keeps its unsaved edits as
 *  that store's draft and shows this store's page; one waiting for a store loads now. */
export function setLmStore(root: string) {
  lmStore = root;
  for (const key of Object.keys(useDocuments.getState().refs)) rebind(key);
}

/** Bring an open Living Memory page to the store Hivemind is connected to. A page under a move or delete waits for it to
 *  end (`hold` calls this again), and one loading or saving waits for that (Codex re-review of 75ce884, R2-D3). Edits
 *  whose draft could not be written stay on screen, with the draft error, instead of giving way to the other store's
 *  page (R2-D2); they save once Hivemind is back on their store. */
function rebind(key: string) {
  const ref = useDocuments.getState().refs[key], root = lmStore;
  if (!ref || !isLm(ref) || !get(key) || root === undefined || isHeld(key)) return;
  if (sameStore(pageStores.get(key), root)) {
    // Back on its store: a parked page takes its edits again, and drafts and saves them as if just typed (R3-U2).
    const was = retained.get(key);
    if (!was) return;
    retained.delete(key);
    useDocuments.setState((st) => ({ docs: { ...st.docs, [key]: was } }));
    scheduleDraft(key);
    scheduleSave(key);
    return;
  }
  if (retained.has(key)) return;
  const busy = loads.get(key) ?? saves.get(key);
  if (busy) { void busy.then(() => rebind(key)); return; }
  clearTimeout(autosaves.get(key));
  autosaves.delete(key);
  void flushDraft(key).then(() => {
    const s = get(key);
    if (!s || !sameStore(lmStore, root) || sameStore(pageStores.get(key), root) || isHeld(key)) return;
    if (loads.has(key) || saves.has(key)) { rebind(key); return; }
    // Edits not in a draft stay on screen, read-only, so nothing in this store is written from them (R3-D2).
    if (isUnsaved(s) && kept.get(key) !== s.text) {
      retained.set(key, s);
      const from = pageStores.get(key);
      dispatch(key, { type: "parked", reason: `this page has unsaved edits made in another Living Memory store${from ? ` (${from})` : ""} that could not be kept as a draft. Switch back to that store to save them, or save them as a copy` });
      return;
    }
    useDocuments.setState((st) => ({ docs: { ...st.docs, [key]: initial } }));
    return startLoad(key, ref);
  });
}

/** Living Memory may be about to change (the settings are being saved): its pages neither load nor save until
 *  `setLmStore` names the store. The returned function undoes it when the settings were not saved. */
export function pauseLmStore(): () => void {
  const before = lmStore;
  lmStore = undefined;
  return () => { if (lmStore === undefined && before !== undefined) setLmStore(before); };
}

/** Moves and deletes in progress. A page under one, including one opened after it began, does not load, save or write
 *  drafts until it ends, and its tab closing lets it go only then (Codex re-reviews of c496e1c and b82e9ab, D8, N3 and
 *  N5). */
const holds = new Set<{ entry: Held; done: Promise<void> }>();
function isHeld(key: string) {
  const ref = useDocuments.getState().refs[key];
  return !!ref && [...holds].some(({ entry: h }) => h.notebook === ref.notebook && movedPath(ref.path, h.from, h.from) !== null);
}

const under = (h: Held, ref: FileRef) => h.notebook === ref.notebook && movedPath(ref.path, h.from, h.from) !== null;

/** Whether `ref` lies under a delete in progress, so its page shows that instead of an editor. */
export const isDeleting = (held: Held[], ref: FileRef) => held.some((h) => h.kind === "delete" && under(h, ref));

/** Whether a page or folder is moving onto `ref`: its page takes no edits until the move ends, since the move would
 *  replace them (Codex final review of a34fafd, F2a). */
export const isArriving = (held: Held[], ref: FileRef) => held.some((h) => h.kind === "into" && under(h, ref));

/** Resolves once no move or delete is in progress and the loads they let start have run. */
function afterHolds(): Promise<void> {
  return Promise.all([...holds].map((h) => h.done)).then(() => (holds.size ? afterHolds() : Promise.all([...loads.values()]).then(() => {})));
}

/** Load a page once (later tabs share the same load). A draft left by an earlier run comes back as unsaved edits.
 *  Opening a page whose load failed tries again; its draft is never touched (Codex review of 32fd236, D6). A page
 *  under a move or delete in progress loads once that ends, at the path it ends up at, so it never reads the file and
 *  its draft halfway through (Codex re-review of b82e9ab, N5 and D8). */
export function open(ref: FileRef): Promise<void> {
  const key = keyOf(ref);
  useDocuments.setState((s) => ({ refs: { ...s.refs, [key]: ref } }));
  const doc = get(key);
  if (doc && doc.status !== "error") return loads.get(key) ?? (isHeld(key) ? afterHolds() : Promise.resolve());
  useDocuments.setState((s) => ({ docs: { ...s.docs, [key]: initial } }));
  if (isHeld(key)) return afterHolds();
  return startLoad(key, ref);
}

function startLoad(key: string, ref: FileRef, convertNow = false) {
  const generation = ++generationCount;
  generations.set(key, generation);
  // What an earlier session drafted says nothing about this one (Codex review of dd4c1b0, R3-D5).
  kept.delete(key);
  retained.delete(key);
  // A Living Memory page waits for the store to be known (`setLmStore` loads it), and belongs to the store it is read from.
  if (isLm(ref)) {
    if (lmStore === undefined) { pageStores.delete(key); return Promise.resolve(); }
    pageStores.set(key, lmStore);
  }
  const run = load(key, ref, generation, convertNow).finally(() => { if (loads.get(key) === run) loads.delete(key); });
  loads.set(key, run);
  return run;
}

/** Whether `generation` is still the session of the document at `key` (it was not closed, reopened or moved). */
const current = (key: string, generation: number | undefined) =>
  generation !== undefined && generations.get(key) === generation && !!get(key);

/** The draft kept for `ref`. One written for another page is never taken for this one (Codex final review of
 *  a34fafd, W1a). */
async function draftOf(key: string, ref: FileRef) {
  const draft = await getFileDraft(await draftKeyOf(key));
  return draft && draft.target?.notebook === ref.notebook && draft.target?.path === ref.path ? draft : null;
}

async function load(key: string, ref: FileRef, attempt: number, convertNow = false) {
  let loaded: Loaded;
  const store = pageStores.get(key);
  try {
    loaded = toLoaded(await readDoc(ref));
  } catch (e) {
    if (!current(key, attempt)) return;
    // A page gone from disk may still have unsaved edits kept as a draft: they are shown, to copy out or discard
    // (Codex final review of a34fafd, F2b).
    const draft = isMissing(e) ? await draftOf(key, ref).catch(() => null) : null;
    if (current(key, attempt)) dispatch(key, { type: "failed", error: String(e), kept: draft ? { text: draft.mine, at: draft.savedAt } : undefined });
    return;
  }
  try {
    // A lookup that failed is not "no draft": the page would then write over it (Codex final review of a34fafd, D3a).
    const draft = await draftOf(key, ref).catch((e) => {
      throw new Error(`Hivemind could not check this page for unsaved edits, so it did not open it: ${String(e)}`);
    });
    if (!current(key, attempt)) return;
    // A draft written while Hivemind used another Living Memory store holds edits to that store's page: shown beside this
    // one, which stays read-only so the draft is never saved here or written over (D1).
    if (draft && isLm(ref) && !sameStore((draft as { store?: string }).store, store)) {
      const where = (draft as { store?: string }).store;
      loaded = { ...loaded, readOnly: `This page has unsaved edits made in another Living Memory store${where ? ` (${where})` : ""}. Switch back to that store to save them, or discard them here.` };
      dispatch(key, { type: "loaded", loaded, draft: { text: draft.mine, at: draft.savedAt }, foreign: true });
      return;
    }
    // A draft written after Convert to UTF-8 comes back converted, whether the file is unchanged, still undecodable
    // or changed since; the file's own encoding no longer decides (Codex review of 52051c8, D3).
    const convert = (convertNow || !!draft?.convert) && !loaded.binary && (!loaded.readOnly || !!loaded.convertible);
    // A page that mixes line endings opens for editing again when its draft says which one the user chose (NS-6A).
    const choseEol = !!loaded.chooseEol && !!draft?.reformat;
    if (!draft || loaded.binary || (loaded.readOnly && !convert && !choseEol)) {
      dispatch(key, { type: "loaded", loaded, draft: draft ? { text: draft.mine, at: draft.savedAt } : undefined });
      return;
    }
    if (draft.precondition.sha256 === loaded.stamp.sha256) {
      dispatch(key, { type: "loaded", loaded, draft: { text: draft.mine, at: draft.savedAt }, convert, reformat: draft.reformat });
      autosaveRestored(key, ref);
      return;
    }
    // The file changed after the draft was written: merge the draft into the current file when it can be done cleanly,
    // otherwise show the draft against the file in the merge dialog. A draft without its base (the page was too large
    // to keep one) never merges by itself: an empty base makes every difference a conflict the user resolves (Codex
    // review of 32fd236, D4).
    const base = draft.base;
    // A rich page is JSON: lines of it merged by line can make a document that is not one, so it is never merged (R1-2).
    // The draft opens as the unsaved text and the file as the version to keep or leave, as for any conflict.
    const merged = base !== undefined && !isRichDoc(ref.path) ? mergeBody(base, draft.mine, loaded.text) : null;
    if (merged && merged.conflicts === 0) {
      dispatch(key, { type: "loaded", loaded, draft: { text: merged.text, at: draft.savedAt }, convert, reformat: draft.reformat });
      autosaveRestored(key, ref);
    } else {
      const original: Loaded = { ...loaded, text: base ?? "", stamp: draft.precondition };
      dispatch(key, { type: "loaded", loaded: original, draft: { text: draft.mine, at: draft.savedAt }, convert, reformat: draft.reformat });
      dispatch(key, { type: "stale", theirs: loaded });
    }
  } catch (e) {
    if (current(key, attempt)) dispatch(key, { type: "failed", error: String(e) });
  }
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();
/** Living Memory pages save 5 seconds after typing stops (and on Ctrl+S); folder pages only on Ctrl+S. Never per
 *  keystroke, so Living Memory's journal does not fill with saves (NS-2C). */
const autosaves = new Map<string, ReturnType<typeof setTimeout>>();
export const AUTOSAVE_MS = 5000;
function scheduleSave(key: string) {
  clearTimeout(autosaves.get(key));
  autosaves.set(key, setTimeout(() => {
    autosaves.delete(key);
    // A save still running, a move holding the page or a store being switched would make this one a no-op: try again
    // once they settle. A page of another store does not save here (D1); `setLmStore` reloads it.
    if (isHeld(key) || get(key)?.status === "saving" || lmStore === undefined) scheduleSave(key);
    else void save(key);
  }, AUTOSAVE_MS));
}

/** A Living Memory page that came back with unsaved edits saves itself like one just edited (Codex review of 32fee20,
 *  D6): a tab closed before its autosave leaves a draft, and the page saves once it is open again. */
function autosaveRestored(key: string, ref: FileRef) {
  if (isLm(ref) && get(key)?.status === "dirty") scheduleSave(key);
}

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
  if (isHeld(key)) {
    // Moving: the draft is written under its new key once the move is done (`retarget` carries the timer over, and
    // quitting waits for the move). Deleting: it goes with the page, or is written once a failed delete ends.
    if (s && isUnsaved(s)) scheduleDraft(key);
    return writing.get(key) ?? Promise.resolve();
  }
  const store = pageStores.get(key);
  const run = (writing.get(key) ?? Promise.resolve()).then(() => keepDraft(key, s, ref, store));
  writing.set(key, run);
  void run.finally(() => { if (writing.get(key) === run) writing.delete(key); });
  return run;
}

/** Record how a draft write ended. A page still open shows a failure as a banner; a page no tab shows any more is
 *  reported now and again at quit (Codex re-review of b82e9ab, N3). */
function drafted(key: string, ref: FileRef, error: string | null) {
  if (get(key)) dispatch(key, { type: "draft", error });
  if (error === null) { unkept.delete(key); return; }
  if (get(key)) return;
  const line = `${ref.path}: ${error}`;
  unkept.set(key, line);
  draftLost(line);
}

async function keepDraft(key: string, s: DocState | undefined, ref: FileRef | undefined, store?: string) {
  if (!s?.base || !ref) return;
  const draftKey = await draftKeyOf(key);
  if (!isUnsaved(s)) {
    await deleteDraft(draftKey).catch(() => {});
    kept.delete(key);
    drafted(key, ref, null);
    return;
  }
  // Measured in bytes, and every failure is shown, so the user knows when edits exist only in the window (Codex review
  // of 32fd236, D9).
  if (utf8Bytes(s.text) > DRAFT_LIMIT) {
    drafted(key, ref, "the page is too large to keep a draft of (over 12 MB)");
    return;
  }
  try {
    await putDraft({
      key: draftKey, kind: "file", target: ref, precondition: s.base.stamp, format: s.base.format,
      base: utf8Bytes(s.base.text) <= BASE_LIMIT ? s.base.text : undefined, mine: s.text, savedAt: new Date().toISOString(),
      convert: s.convert || undefined,
      reformat: s.reformat ? s.base.format : undefined,
      ...(isLm(ref) ? { store } : {}),
    });
    kept.set(key, s.text);
    drafted(key, ref, null);
  } catch (e) {
    drafted(key, ref, String(e));
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
    await Promise.all([...holds].map((h) => h.done));
    const keys = new Set([...timers.keys(), ...behind().filter(([, d]) => !d.draftError).map(([k]) => k)]);
    for (const key of keys) { clearTimeout(timers.get(key)); timers.delete(key); }
    const runs = [...[...keys].map(writeDraft), ...writing.values()];
    if (!runs.length && !holds.size) break;
    await Promise.all(runs);
  }
  const { refs } = useDocuments.getState();
  const open = behind().map(([k, d]) => `${refs[k]?.path ?? k}: ${d.draftError ?? "the latest edits were made while quitting"}`);
  return [...open, ...unkept.values()];
}

/** Whether a draft is still to be written, or a failure still to be reported, so the window must not close before
 *  `flushAllDrafts` (Codex re-review of b82e9ab, N3). */
export function draftsPending(): boolean {
  const { docs } = useDocuments.getState();
  return timers.size > 0 || writing.size > 0 || holds.size > 0 || unkept.size > 0
    || Object.entries(docs).some(([k, d]) => isUnsaved(d) && kept.get(k) !== d.text);
}

/** Convert to UTF-8. A read-only page whose draft was written before the file became undecodable converts with that
 *  draft's edits, merged into the file as it is now, so Convert never writes over them (Codex review of 52051c8, D3). */
export async function convertToUtf8(key: string) {
  const ref = useDocuments.getState().refs[key];
  if (ref && get(key)?.status === "readOnly") {
    // A draft that could not be looked up may exist, and converting would write over it (Codex re-review of fa08348, D3).
    const draft = await draftOf(key, ref).catch((e) => {
      throw new Error(`Hivemind could not check this file for unsaved edits, so it did not convert it: ${String(e)}`);
    });
    if (get(key)?.status !== "readOnly") return;
    if (draft) { await startLoad(key, ref, true); return; }
  }
  dispatch(key, { type: "convert" });
  scheduleDraft(key);
}

/** A new line ending or encoding for the page's next save (NS-6A). The text stays as it is; the page becomes unsaved,
 *  and a mixed-endings page that was read-only becomes editable. */
export function reformat(key: string, change: FormatChange) {
  const before = get(key);
  dispatch(key, { type: "reformat", change });
  if (get(key) !== before) scheduleDraft(key);
}

/** Read the page again decoded as `encoding` (NS-6A). Refused while the page has unsaved edits or a line ending or
 *  encoding waiting to be saved: they are not in the file, so reading it again would drop them. Returns whether the page
 *  now shows the file in the new encoding; edits typed while it was read cancel it. */
export async function reopenAs(key: string, encoding: string): Promise<boolean> {
  const ref = useDocuments.getState().refs[key];
  const before = get(key), generation = generations.get(key);
  if (!ref || !before || isLm(ref)) return false;
  if (before.status !== "clean" && before.status !== "readOnly") throw new Error("Save or discard your edits before reopening the file with another encoding");
  if (before.kept) throw new Error("This page has a draft kept beside it. Discard the draft before reopening the file with another encoding");
  const theirs = toLoaded(await reopenDoc(ref, encoding));
  const now = get(key);
  if (!current(key, generation) || !now || now.text !== before.text || now.status !== before.status) return false;
  dispatch(key, { type: "reloaded", theirs });
  return true;
}

/** The editor's text changed; `outside` for a change not typed in the editor, which the editor then shows. */
export function edit(key: string, text: string, outside = false) {
  const ref = useDocuments.getState().refs[key];
  if (ref && isArriving(useDocuments.getState().held, ref)) return;
  dispatch(key, { type: "edited", text, outside });
  scheduleDraft(key);
  if (ref && isLm(ref)) scheduleSave(key);
}

/** Restore a version (NS-5): the page takes `text` and saves it at once, so the version is a new one and nothing before it
 *  is lost. Only a saved page restores: unsaved edits are not in the history, so they would be lost. Returns the state
 *  after the save. */
export async function restore(key: string, text: string) {
  const s = get(key);
  if (!s || s.status !== "clean") throw new Error("Save or discard your edits before restoring a version");
  dispatch(key, { type: "edited", text, outside: true });
  scheduleDraft(key);
  return save(key, "restore");
}

/** Discard the draft shown beside a page that cannot take it (its file is gone, or read-only). A Living Memory page that
 *  was read-only because the draft came from another store then loads again and takes edits (Codex re-review of
 *  75ce884, R2-U1). */
export async function discardKept(key: string) {
  await deleteDraft(await draftKeyOf(key));
  kept.delete(key);
  retained.delete(key);
  dispatch(key, { type: "keptDropped" });
  const ref = useDocuments.getState().refs[key];
  if (!ref || !isLm(ref) || get(key)?.status !== "readOnly") return;
  // During a move or delete the page loads once it ends (R3-U1).
  if (isHeld(key)) useDocuments.setState((s) => ({ docs: { ...s.docs, [key]: initial } }));
  else await startLoad(key, ref);
}

/** Save the document. Returns the state after the attempt. `source` says what asks for it, for the file's history. */
export async function save(key: string, source?: string) {
  const s = get(key), ref = useDocuments.getState().refs[key];
  if (!s?.base || !ref || s.status !== "dirty" || isHeld(key) || otherStore(key, ref)) return get(key);
  dispatch(key, { type: "saveStarted" });
  const text = get(key).saving!;
  const generation = generations.get(key);
  const run = (async () => {
    try {
      // A line ending chosen for a mixed file replaces text the file's own check would refuse, as Convert to UTF-8 does.
      const lenient = !!s.convert || !!s.reformat;
      const out = source ? await saveDoc(ref, text, s.base!.stamp, s.base!.format, lenient, source) : await saveDoc(ref, text, s.base!.stamp, s.base!.format, lenient);
      if (!current(key, generation)) return;
      if (out.status === "saved") {
        dispatch(key, { type: "saved", stamp: { sha256: out.sha256, size: out.size, mtimeMs: out.mtimeMs } });
        if (!isUnsaved(get(key))) { clearTimeout(timers.get(key)); timers.delete(key); await writeDraft(key); }
      } else if (out.status === "stale") {
        const theirs = toLoaded(await readDoc(ref));
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
    const theirs = toLoaded(await readDoc(ref));
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
  // A parked page shows another store's edits: this store's file says nothing about them.
  if (!ref || !get(key) || get(key).status === "loading" || retained.has(key)) return;
  try {
    const theirs = toLoaded(await readDoc(ref));
    if (!current(key, generation)) return;
    // A draft kept beside a read-only page comes back once the file can take it, through a load that merges it like
    // any draft (Codex final review of a34fafd, D3b).
    const s = get(key);
    if (s.kept && s.base && theirs.stamp.sha256 !== s.base.stamp.sha256 && !theirs.readOnly && !theirs.binary) {
      await startLoad(key, ref);
      return;
    }
    dispatch(key, { type: "outsideChange", theirs });
  } catch (e) {
    if (current(key, generation) && get(key)?.base && isMissing(e)) dispatch(key, { type: "gone" });
  }
}

/** Another program changed files: the open documents showing them follow or warn. */
export async function refresh(notebook: string, paths: string[]) {
  const wanted = new Set(paths.map((p) => keyOf({ notebook, path: p })));
  for (const key of Object.keys(useDocuments.getState().refs)) {
    if (!wanted.has(key)) continue;
    // A load in flight may have read the old bytes: it finishes first, then the page is checked against the disk (Codex
    // re-review of fa08348, D2). One that failed (the file was not there yet) has nothing to check against, so the
    // page loads again (final review of a34fafd, D2).
    await loads.get(key);
    const s = get(key), ref = useDocuments.getState().refs[key];
    if (s?.status === "error" && !s.base && ref && !isHeld(key)) await startLoad(key, ref);
    else await recheck(key);
  }
}

/** Before a page or folder moves or is deleted: write pending drafts, let loads, saves and draft writes finish, and
 *  hold new ones until it is done (Codex review of 32fd236, S2 and D7). Returns the function that ends the hold. */
export async function hold(notebook: string, from: string, kind: Held["kind"]): Promise<() => void> {
  const keys = Object.entries(useDocuments.getState().refs)
    .filter(([, ref]) => ref.notebook === notebook && movedPath(ref.path, from, from) !== null)
    .map(([key]) => key);
  for (const key of keys) void flushDraft(key);
  let end = () => {};
  const entry: Held = { notebook, from, kind };
  const h = { entry, done: new Promise<void>((resolve) => { end = resolve; }) };
  holds.add(h);
  useDocuments.setState((s) => ({ held: [...s.held, entry] }));
  await Promise.all(keys.flatMap((key) => [loads.get(key), saves.get(key), writing.get(key)]));
  return () => {
    holds.delete(h);
    end();
    // Tabs closed meanwhile let their documents go now (the sync releases what no tab shows).
    useDocuments.setState((s) => ({ held: s.held.filter((x) => x !== entry) }));
    // Pages opened meanwhile load now, at the path they ended up at.
    const { docs, refs } = useDocuments.getState();
    for (const [key, doc] of Object.entries(docs)) {
      if (doc.status === "loading" && !loads.has(key) && refs[key] && !isHeld(key)) void startLoad(key, refs[key]);
    }
    // Living Memory pages the hold kept from following a store switch follow it now (R2-D3).
    for (const key of Object.keys(refs)) rebind(key);
  };
}

export const beforeMove = (notebook: string, from: string) => hold(notebook, from, "move");

/** A page or folder moved: its documents follow under their new keys (Rust has already moved the drafts). A page opened
 *  during the move has not read anything yet; it loads at the new path when the move ends. */
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
      generations.delete(key);
      generations.set(next, ++generationCount);
      if (pageStores.has(key)) { pageStores.set(next, pageStores.get(key)!); pageStores.delete(key); }
      if (kept.has(key)) { kept.set(next, kept.get(key)!); kept.delete(key); }
      const timer = timers.get(key);
      if (timer) { clearTimeout(timer); timers.delete(key); scheduleDraft(next); }
      const autosave = autosaves.get(key);
      if (autosave) { clearTimeout(autosave); autosaves.delete(key); scheduleSave(next); }
    }
    return { docs, refs };
  });
}

/** Forget a document no tab shows any more; a dirty one keeps its draft for next time. During a move or delete it stays
 *  until that ends: a move writes edits typed meanwhile under the new name, and a failed delete gives the page back
 *  with its edits, even ones too large for a draft (Codex re-reviews of c496e1c and b82e9ab, N3 and D8). */
export function release(key: string) {
  if (isHeld(key)) return;
  const ref = useDocuments.getState().refs[key];
  if (retained.delete(key) && ref) draftLost(`${ref.path}: its unsaved edits belonged to another Living Memory store and could not be kept as a draft`);
  void flushDraft(key);
  // A pending autosave goes with the session; the draft keeps the edits, and the page saves when it opens again (D6).
  clearTimeout(autosaves.get(key));
  autosaves.delete(key);
  generations.delete(key);
  pageStores.delete(key);
  useDocuments.setState((s) => {
    const docs = { ...s.docs }, refs = { ...s.refs };
    delete docs[key]; delete refs[key];
    return { docs, refs };
  });
}

/** Drop a document and its draft (the file was deleted on purpose). `store` is the Living Memory store the delete ran in
 *  (by default the one connected). A draft that another store keeps for its page of the same name stays (R2-D7), and so
 *  does a page of another store shown in a tab, with its session (Codex review of dd4c1b0, R3-D4). */
export function discard(key: string, store = lmStore) {
  const ref = useDocuments.getState().refs[key];
  if (ref && isLm(ref) && pageStores.has(key) && !sameStore(pageStores.get(key), store)) return;
  clearTimeout(timers.get(key));
  timers.delete(key);
  clearTimeout(autosaves.get(key));
  autosaves.delete(key);
  generations.delete(key);
  pageStores.delete(key);
  kept.delete(key);
  unkept.delete(key);
  retained.delete(key);
  useDocuments.setState((s) => {
    const docs = { ...s.docs }, refs = { ...s.refs };
    delete docs[key]; delete refs[key];
    return { docs, refs };
  });
  void (writing.get(key) ?? Promise.resolve()).then(() => draftKeyOf(key)).then(async (draftKey) => {
    if (ref && isLm(ref)) {
      const draft = await getFileDraft(draftKey);
      if (draft?.store !== undefined && !sameStore(draft.store, store)) return;
    }
    await deleteDraft(draftKey);
  }).catch(() => {});
}

/** The pages under `path` (a page, or a section and everything in it) that hold unsaved edits. */
export function unsavedUnder(notebook: string, path: string): string[] {
  const { docs, refs } = useDocuments.getState();
  return Object.entries(refs)
    .filter(([key, ref]) => ref.notebook === notebook && movedPath(ref.path, path, path) !== null && isUnsaved(docs[key]))
    .map(([, ref]) => ref.path);
}
