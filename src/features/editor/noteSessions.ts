// One editing session per Memory note and store, shared by every pane that shows the note in Edit, as file pages share
// theirs (Codex review of 7320d7f, DATA-2). The text, the banner, the merge and the draft live here, outside React, so two
// panes show the same text and one draft. A draft names its store, and a session saves only into the store (bridge
// generation) it was read in (LM-2).
import { create } from "zustand";
import { bridgeGeneration, type Note } from "../../lib/lm";
import { deleteDraft, getDraft, putDraft, type NoteDraft } from "../../lib/drafts";
import { connectedStore, storeId } from "../../documents/store";
import type { Problem } from "../../lib/errors";
import { useWorkspace } from "../../workspace/store";
import { fieldsOf, isDirty, type Fields } from "./save";

export interface EditState { base: Fields; rev: string; mine: Fields; version: number }
export type Banner =
  | { kind: "restored" | "draft-old"; at: string }
  | { kind: "outside" }
  | { kind: "problems"; problems: string[] }
  | { kind: "error"; problem: Problem };
export interface Merging { base: Fields; mine: Fields; theirs: Fields; rev: string }

export interface Session {
  ref: string;
  store: string;
  /** The bridge generation the note was read in. A save carries it, so one made after Hivemind switched stores is refused. */
  generation: number | undefined;
  /** Panes showing the note in Edit. The session ends with the last one. */
  holders: number;
  /** Null until the note and its draft are loaded. */
  st: EditState | null;
  banner: Banner | null;
  merging: Merging | null;
  saving: boolean;
  /** A draft from before drafts named their store, waiting for the user to keep it here or throw it away. */
  legacy: NoteDraft | null;
}

export const useNoteSessions = create<{ sessions: Record<string, Session> }>()(() => ({ sessions: {} }));

/** The store Hivemind is connected to, as a session names it; undefined while it may be changing. */
export const currentStore = () => {
  const root = connectedStore();
  return root === undefined ? undefined : storeId(root);
};

export const sessionKey = (store: string, ref: string) => `${store}\n${ref}`;
export const getSession = (key: string) => useNoteSessions.getState().sessions[key];

const fnv = (text: string, seed: number) => {
  let h = seed;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16).padStart(8, "0");
};
/** A note's draft key: the store and the note, so two stores that hold the same ref keep separate drafts. The store is
 *  hashed because a key becomes a file name; the draft also names its store in full, and a read checks it. */
export const noteDraftKey = (store: string, ref: string) => `note-${fnv(store, 0x811c9dc5)}${fnv(store, 0x9747b28c)}-${ref}`;

export const patchSession = (key: string, change: Partial<Session> | ((s: Session) => Partial<Session>)) =>
  useNoteSessions.setState((all) => {
    const s = all.sessions[key];
    return s ? { sessions: { ...all.sessions, [key]: { ...s, ...(typeof change === "function" ? change(s) : change) } } } : all;
  });
const patch = patchSession;

const timers = new Map<string, ReturnType<typeof setTimeout>>();
const loading = new Set<string>();

/** Write the draft of a note's edits, or delete it when nothing is unsaved. */
function writeDraft(store: string, ref: string, st: EditState): Promise<void> {
  const key = noteDraftKey(store, ref);
  if (isDirty(st.base, st.mine)) return putDraft({ key, ref, store, baseRevision: st.rev, base: st.base, mine: st.mine, savedAt: new Date().toISOString() });
  return deleteDraft(key);
}

/** Write the session's draft now. */
function persist(key: string) {
  clearTimeout(timers.get(key));
  timers.delete(key);
  const s = getSession(key);
  if (s?.st) writeDraft(s.store, s.ref, s.st).catch(() => {});
}

/** The edits changed: keep a draft a little after typing stops. */
function setEdit(key: string, st: EditState) {
  patch(key, { st });
  clearTimeout(timers.get(key));
  timers.set(key, setTimeout(() => persist(key), 1000));
}

/** A pane shows the note in Edit. Returns what the pane calls when it stops: the last one writes the draft and ends the
 *  session, while a pane that closes with another still showing the note leaves everything as it is. */
export function acquire(store: string, ref: string): () => void {
  const key = sessionKey(store, ref);
  if (getSession(key)) patch(key, (s) => ({ holders: s.holders + 1 }));
  else useNoteSessions.setState((all) => ({ sessions: { ...all.sessions, [key]: { ref, store, generation: undefined, holders: 1, st: null, banner: null, merging: null, saving: false, legacy: null } } }));
  return () => {
    const s = getSession(key);
    if (!s) return;
    if (s.holders > 1) { patch(key, { holders: s.holders - 1 }); return; }
    persist(key);
    loading.delete(key);
    useNoteSessions.setState((all) => {
      const rest = { ...all.sessions };
      delete rest[key];
      return { sessions: rest };
    });
  };
}

/** The edits a draft holds on top of `note`, and the banner that says where they come from. */
function fromDraft(d: NoteDraft, note: Note): { st: EditState; banner: Banner } {
  const current = d.baseRevision === note.revision;
  return { st: { base: current ? fieldsOf(note) : d.base!, rev: d.baseRevision!, mine: d.mine, version: 1 }, banner: { kind: current ? "restored" : "draft-old", at: d.savedAt } };
}
const usable = (d: NoteDraft | null): d is NoteDraft => !!d?.base && !!d.baseRevision && isDirty(d.base, d.mine);

/** Load the session once, from the note and this store's draft: the draft wins over the saved note (it may be based on an
 *  older revision). A draft from before drafts named their store is held back for the user to decide. */
export async function loadSession(key: string, note: Note) {
  const s = getSession(key);
  if (!s || s.st || s.legacy || loading.has(key)) return;
  loading.add(key);
  try {
    let d = await getDraft(noteDraftKey(s.store, s.ref)).catch(() => null);
    if (d && d.store !== s.store) d = null;
    const old = d ? null : await getDraft(s.ref).catch(() => null);
    const now = getSession(key);
    if (!now || now.st) return;
    const generation = bridgeGeneration();
    if (usable(d)) patch(key, { ...fromDraft(d, note), generation });
    else if (usable(old) && old.store === undefined) patch(key, { legacy: old, generation });
    else { const fresh = fieldsOf(note); patch(key, { st: { base: fresh, rev: note.revision, mine: fresh, version: 1 }, generation }); }
  } finally { loading.delete(key); }
}

/** The user chose what happens to a draft from before drafts named their store: it becomes this store's draft, or goes. */
export function resolveLegacy(key: string, keep: boolean, note: Note) {
  const s = getSession(key);
  const old = s?.legacy;
  if (!s || !old) return;
  patch(key, { legacy: null });
  if (!keep) { deleteDraft(old.key).catch(() => {}); void loadSession(key, note); return; }
  const adopted = fromDraft(old, note);
  patch(key, { ...adopted, generation: bridgeGeneration() });
  // The old file goes once the draft is kept under this store's name.
  writeDraft(s.store, s.ref, adopted.st).then(() => deleteDraft(old.key)).catch(() => {});
}

/** Someone else saved the note: follow along if there are no local edits, else warn. */
export function followNote(key: string, note: Note) {
  const s = getSession(key);
  if (!s?.st || s.saving || note.revision === s.st.rev) return;
  if (!isDirty(s.st.base, s.st.mine)) {
    const f = fieldsOf(note);
    setEdit(key, { base: f, rev: note.revision, mine: f, version: s.st.version + 1 });
  } else patch(key, (x) => ({ banner: x.banner?.kind === "draft-old" ? x.banner : { kind: "outside" } }));
}

export function editSession(key: string, change: Partial<Fields>) {
  const s = getSession(key);
  if (s?.st) setEdit(key, { ...s.st, mine: { ...s.st.mine, ...change } });
}
/** Replace the whole edit state (discard, merge). */
export const replaceEdit = setEdit;

/** The save of `sent` reached Living Memory and `fresh` is the note now. Anything typed meanwhile, in any pane, stays as
 *  the unsaved text. The draft is deleted only when the saved note covers it. A session that ended while the save ran
 *  leaves its draft unless the draft holds exactly what was saved. */
export function savedNote(store: string, ref: string, sent: EditState, fresh: Note) {
  const key = sessionKey(store, ref);
  const s = getSession(key);
  if (!s?.st) {
    const dk = noteDraftKey(store, ref);
    getDraft(dk).then((d) => {
      if (d && isDirty(sent.mine, d.mine)) return; // newer edits are kept as a draft, and their tabs keep the dot
      // No editor is left to tell the tabs, so they lose the dot here, unless an editor opened on the note meanwhile
      // (Codex review of 9dfa56d, C3).
      if (!getSession(key)) {
        const ws = useWorkspace.getState();
        for (const pane of ws.panes) for (const tab of pane.tabs) if (tab.kind === "note" && tab.ref === ref && ws.dirty[tab.id]) ws.setDirty(tab.id, false);
      }
      if (d) return deleteDraft(dk);
    }).catch(() => {});
    return;
  }
  const f = fieldsOf(fresh);
  const typed = s.st.mine !== sent.mine;
  patch(key, { st: { base: f, rev: fresh.revision, mine: typed ? s.st.mine : f, version: s.st.version + (typed ? 0 : 1) }, banner: null });
  persist(key);
}
