// Unsaved edits, stored by the Rust side in the app's data folder (never in the Living Memory store).
import { invoke } from "@tauri-apps/api/core";
import type { Fields } from "../features/editor/save";
import { movedPath, type FileRef } from "../documents/keys";
import type { FileFormat, Stamp } from "./notebooks";

/** A note's draft (no `kind`, the shape drafts always had). */
export interface NoteDraft {
  key: string;
  ref?: string;               // the note, once it exists
  domain?: string;            // new notes: where they will be captured
  baseRevision?: string;      // revision the edits started from (absent for new notes)
  base?: Fields;              // the note as it was then, for a three-way merge
  mine: Fields;
  savedAt: string;
  /** The Living Memory store the note was edited in. Drafts written before this was recorded have none (Codex review of
   *  7320d7f, LM-2). */
  store?: string;
}

/** A notebook page's draft. `base` is left out for pages over 2 MB. */
export interface FileDraft {
  key: string;
  kind: "file";
  target: FileRef;
  precondition: Stamp;
  format: FileFormat;
  base?: string;
  mine: string;
  savedAt: string;
  /** The user chose Convert to UTF-8 for this page. */
  convert?: boolean;
  /** The line ending or encoding the user chose for the next save (NS-6A). */
  reformat?: FileFormat;
}

export type Draft = NoteDraft | FileDraft;
export const isFileDraft = (d: Draft): d is FileDraft => (d as FileDraft).kind === "file";

// The newest value of every draft written in this run, so a reader never sees an older one while the write to disk is
// still on its way (an editor that unmounts and mounts again at once).
const recent = new Map<string, Draft | null>();

// Writes of one key run one after another, so they reach the disk in the order they were made.
const queues = new Map<string, Promise<void>>();
function inOrder(key: string, write: () => Promise<void>): Promise<void> {
  const run = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(write);
  queues.set(key, run);
  run.catch(() => {}).finally(() => { if (queues.get(key) === run) queues.delete(key); });
  return run;
}

// The newest change of each key: a write or delete that fails forgets the cache only while it is still the newest, so a
// later one stays visible until it lands (Codex re-review of fa08348, F1).
const latest = new Map<string, number>();
let changes = 0;
function change(key: string, value: Draft | null, write: () => Promise<void>): Promise<void> {
  const mine = ++changes;
  latest.set(key, mine);
  recent.set(key, value);
  return inOrder(key, write).catch((e) => {
    if (latest.get(key) === mine) recent.delete(key);
    throw e;
  });
}

/** A write that fails leaves the key to the disk: the cache forgets it, so a draft that never reached the disk is never
 *  read as kept, and neither is an earlier one that failed too (Codex re-review of b82e9ab, N4; Codex review of
 *  52051c8, F1). */
export function putDraft(draft: Draft): Promise<void> {
  return change(draft.key, draft, () => invoke<void>("draft_put", { key: draft.key, value: draft }));
}

async function readDraft(key: string): Promise<Draft | null> {
  if (recent.has(key)) return recent.get(key) ?? null;
  return invoke<Draft | null>("draft_get", { key });
}

/** A note's draft (note keys are refs or `new-<tab>`, never a file key). */
export const getDraft = async (key: string): Promise<NoteDraft | null> => {
  const d = await readDraft(key);
  return d && !isFileDraft(d) ? d : null;
};

/** A notebook page's draft, by its hashed key (`draftKeyOf`). */
export const getFileDraft = async (key: string): Promise<FileDraft | null> => {
  const d = await readDraft(key);
  return d && isFileDraft(d) ? d : null;
};

export function deleteDraft(key: string): Promise<void> {
  return change(key, null, () => invoke<void>("draft_delete", { key }));
}

/** Pages under `from` moved and Rust moved their drafts: forget what this run cached for them, and every cached
 *  deletion (one may be for the key a moved draft now has), so the next read asks Rust (Claude's review of 32fd236, C2). */
export function forgetMoved(notebook: string, from: string) {
  for (const [key, d] of recent) {
    if (!d || (isFileDraft(d) && d.target.notebook === notebook && movedPath(d.target.path, from, from) !== null)) recent.delete(key);
  }
}

export const listDrafts = () => invoke<Draft[]>("draft_list");
