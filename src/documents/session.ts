// The life of one open document (a notebook page), as a pure reducer. Side effects (reading, saving, drafts) live in
// controller.ts; this file only decides what the state becomes.
import type { FileFormat, Stamp } from "../lib/notebooks";

/** A file as read from disk. */
export interface Loaded { text: string; stamp: Stamp; format: FileFormat; readOnly: string | null; binary: boolean }

export type Status = "loading" | "clean" | "dirty" | "saving" | "stale" | "readOnly" | "error";
export type Banner =
  | { kind: "restored"; at: string }        // unsaved edits came back from a draft
  | { kind: "changed" }                     // changed on disk while you were editing: merge or reload
  | { kind: "followed" }                    // changed on disk while clean: the editor now shows it
  | { kind: "gone" };                       // deleted or moved by another program

export interface DocState {
  status: Status;
  /** What is on disk as far as we know: the merge base and the save precondition. */
  base: Loaded | null;
  /** The editor's text (LF). */
  text: string;
  /** Bumped whenever `text` is replaced from outside the editor (load, follow, merge, reload). */
  version: number;
  banner?: Banner;
  error?: string;
  /** The newer version on disk, kept while the user decides (status `stale`, or banner `changed`). */
  theirs?: Loaded;
  /** The text a save in flight is writing. */
  saving?: string;
}

export type DocEvent =
  | { type: "loaded"; loaded: Loaded; draft?: { text: string; at: string } }
  | { type: "edited"; text: string }
  | { type: "saveStarted" }
  | { type: "saved"; stamp: Stamp }
  | { type: "stale"; theirs: Loaded }
  | { type: "gone" }
  | { type: "outsideChange"; theirs: Loaded }
  | { type: "merged"; text: string; theirs: Loaded }
  | { type: "reloaded"; theirs: Loaded }
  | { type: "failed"; error: string }
  | { type: "dismiss" };

export const initial: DocState = { status: "loading", base: null, text: "", version: 0 };

const dirtyOr = (s: DocState, text: string): Status => (s.base && text === s.base.text ? "clean" : "dirty");

export function reduce(s: DocState, e: DocEvent): DocState {
  switch (e.type) {
    case "loaded": {
      if (e.loaded.readOnly || e.loaded.binary) return { status: "readOnly", base: e.loaded, text: e.loaded.text, version: s.version + 1 };
      if (e.draft && e.draft.text !== e.loaded.text) {
        return { status: "dirty", base: e.loaded, text: e.draft.text, version: s.version + 1, banner: { kind: "restored", at: e.draft.at } };
      }
      return { status: "clean", base: e.loaded, text: e.loaded.text, version: s.version + 1 };
    }
    case "edited":
      if (s.status === "readOnly" || s.status === "loading" || s.status === "error") return s;
      if (s.status === "saving" || s.status === "stale") return { ...s, text: e.text };
      return { ...s, text: e.text, status: dirtyOr(s, e.text) };
    case "saveStarted":
      return s.status === "dirty" ? { ...s, status: "saving", saving: s.text } : s;
    case "saved": {
      if (!s.base || s.saving === undefined) return s;
      const base = { ...s.base, text: s.saving, stamp: e.stamp };
      return { ...s, base, saving: undefined, status: s.text === s.saving ? "clean" : "dirty", banner: undefined, theirs: undefined };
    }
    case "stale":
      return { ...s, status: "stale", saving: undefined, theirs: e.theirs };
    case "gone":
      return { ...s, status: s.text ? "dirty" : s.status, saving: undefined, banner: { kind: "gone" } };
    case "outsideChange": {
      if (!s.base || e.theirs.stamp.sha256 === s.base.stamp.sha256) return s;
      // A save in flight finds out for itself, and a merge in progress already has a newer version to look at.
      if (s.status === "saving" || s.status === "stale") return s;
      if (s.status === "dirty") return { ...s, banner: { kind: "changed" }, theirs: e.theirs };
      if (e.theirs.readOnly || e.theirs.binary) return { ...s, status: "readOnly", base: e.theirs, text: e.theirs.text, version: s.version + 1 };
      return { ...s, status: "clean", base: e.theirs, text: e.theirs.text, version: s.version + 1, banner: { kind: "followed" }, theirs: undefined };
    }
    case "merged":
      // The merged text is unsaved until the user saves it, now against the newer version.
      return { ...s, status: e.text === e.theirs.text ? "clean" : "dirty", base: e.theirs, text: e.text, version: s.version + 1, banner: undefined, theirs: undefined };
    case "reloaded":
      return reduce({ ...s, banner: undefined, theirs: undefined, saving: undefined }, { type: "loaded", loaded: e.theirs });
    case "failed":
      return s.base ? { ...s, status: s.status === "saving" ? "dirty" : s.status, saving: undefined, error: e.error } : { ...s, status: "error", error: e.error };
    case "dismiss":
      return { ...s, banner: undefined, error: undefined };
  }
}

/** Whether the document holds edits that are not on disk. */
export const isUnsaved = (s: DocState | undefined) => !!s && (s.status === "dirty" || s.status === "saving" || s.status === "stale");
