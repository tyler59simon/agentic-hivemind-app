// Unsaved edits, stored by the Rust side in the app's data folder (never in the Living Memory store).
import { invoke } from "@tauri-apps/api/core";
import type { Fields } from "../features/editor/save";

export interface Draft {
  key: string;
  ref?: string;               // the note, once it exists
  domain?: string;            // new notes: where they will be captured
  baseRevision?: string;      // revision the edits started from (absent for new notes)
  base?: Fields;              // the note as it was then, for a three-way merge
  mine: Fields;
  savedAt: string;
}

export const putDraft = (draft: Draft) => invoke<void>("draft_put", { key: draft.key, value: draft });
export const getDraft = (key: string) => invoke<Draft | null>("draft_get", { key });
export const deleteDraft = (key: string) => invoke<void>("draft_delete", { key });
export const listDrafts = () => invoke<Draft[]>("draft_list");
