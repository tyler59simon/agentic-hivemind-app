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
}

export type Draft = NoteDraft | FileDraft;
export const isFileDraft = (d: Draft): d is FileDraft => (d as FileDraft).kind === "file";

// The newest value of every draft written in this run, so a reader never sees an older one while the write to disk is
// still on its way (an editor that unmounts and mounts again at once, when moving between the Notes and Memory pages).
const recent = new Map<string, Draft | null>();

export function putDraft(draft: Draft): Promise<void> {
  recent.set(draft.key, draft);
  return invoke<void>("draft_put", { key: draft.key, value: draft });
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
  recent.set(key, null);
  return invoke<void>("draft_delete", { key });
}

/** Pages under `from` moved and Rust moved their drafts: forget what this run cached for them, and every cached
 *  deletion (one may be for the key a moved draft now has), so the next read asks Rust (Claude's review of 32fd236, C2). */
export function forgetMoved(notebook: string, from: string) {
  for (const [key, d] of recent) {
    if (!d || (isFileDraft(d) && d.target.notebook === notebook && movedPath(d.target.path, from, from) !== null)) recent.delete(key);
  }
}

export const listDrafts = () => invoke<Draft[]>("draft_list");
