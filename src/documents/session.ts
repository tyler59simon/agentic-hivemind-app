// The life of one open document (a notebook page), as a pure reducer. Side effects (reading, saving, drafts) live in
// store.ts; this file only decides what the state becomes.
import type { FileFormat, Stamp } from "../lib/notebooks";

/** A file as read from disk. */
export interface Loaded { text: string; stamp: Stamp; format: FileFormat; readOnly: string | null; binary: boolean; convertible?: boolean }

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
  /** Why the latest unsaved edits could not be kept as a draft; cleared when a draft write succeeds. */
  draftError?: string;
  /** The user chose Convert to UTF-8: the next save writes UTF-8 over bytes that did not decode (NS-1B). */
  convert?: boolean;
  /** A draft the file cannot take now (it opened read-only or is not text): kept, and offered as a copy. */
  kept?: { text: string; at: string };
}

export type DocEvent =
  | { type: "loaded"; loaded: Loaded; draft?: { text: string; at: string }; convert?: boolean }
  | { type: "edited"; text: string }
  | { type: "saveStarted" }
  | { type: "saved"; stamp: Stamp }
  | { type: "stale"; theirs: Loaded }
  | { type: "gone" }
  | { type: "outsideChange"; theirs: Loaded }
  | { type: "merged"; text: string; theirs: Loaded }
  | { type: "reloaded"; theirs: Loaded }
  | { type: "failed"; error: string }
  | { type: "draft"; error: string | null }
  | { type: "convert" }
  | { type: "dismiss" };

export const initial: DocState = { status: "loading", base: null, text: "", version: 0 };

/** `l` as Convert to UTF-8 makes it: editable, written as UTF-8 without a BOM, with the same line endings. */
export const converted = (l: Loaded): Loaded => ({ ...l, format: { ...l.format, encoding: "UTF-8", bom: false, confidence: "valid" }, readOnly: null });

/** Whether converting `l` to UTF-8 makes it editable: text whose only problem is its encoding, or editable text. */
const canConvert = (l: Loaded) => !l.binary && (!l.readOnly || !!l.convertible);

const dirtyOr = (s: DocState, text: string): Status => (s.base && text === s.base.text && !s.convert ? "clean" : "dirty");

export function reduce(s: DocState, e: DocEvent): DocState {
  switch (e.type) {
    case "loaded": {
      // A draft written after Convert to UTF-8 comes back converted (Codex review of 52051c8, D3).
      const convert = !!e.convert && !!e.draft && canConvert(e.loaded);
      const loaded = convert ? converted(e.loaded) : e.loaded;
      if (loaded.readOnly || loaded.binary) {
        // Its draft stays where it is and is shown, so it can be saved elsewhere (Codex re-review of fa08348, D3).
        const kept = e.draft && e.draft.text !== loaded.text ? e.draft : undefined;
        return { status: "readOnly", base: loaded, text: loaded.text, version: s.version + 1, kept };
      }
      if (e.draft && (e.draft.text !== loaded.text || convert)) {
        return { status: "dirty", base: loaded, text: e.draft.text, version: s.version + 1, banner: { kind: "restored", at: e.draft.at }, convert: convert || undefined };
      }
      return { status: "clean", base: loaded, text: loaded.text, version: s.version + 1 };
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
      return { ...s, base, saving: undefined, status: s.text === s.saving ? "clean" : "dirty", banner: undefined, theirs: undefined, convert: undefined };
    }
    case "stale":
      return { ...s, status: "stale", saving: undefined, theirs: e.theirs };
    case "gone": {
      // Text that is only in the editor now counts as unsaved, and so does a save that found the file gone, even of an
      // empty page (Codex review of 32fd236, S3). A read-only view stays read-only.
      if (s.status === "readOnly" || s.status === "loading" || s.status === "error") return { ...s, saving: undefined, banner: { kind: "gone" } };
      return { ...s, status: s.text || s.status !== "clean" ? "dirty" : "clean", saving: undefined, banner: { kind: "gone" } };
    }
    case "outsideChange": {
      if (!s.base || e.theirs.stamp.sha256 === s.base.stamp.sha256) return s;
      // A save in flight finds out for itself, and a merge in progress already has a newer version to look at.
      if (s.status === "saving" || s.status === "stale") return s;
      if (s.status === "dirty") return { ...s, banner: { kind: "changed" }, theirs: e.theirs };
      if (e.theirs.readOnly || e.theirs.binary) return { ...s, status: "readOnly", base: e.theirs, text: e.theirs.text, version: s.version + 1 };
      return { ...s, status: "clean", base: e.theirs, text: e.theirs.text, version: s.version + 1, banner: { kind: "followed" }, theirs: undefined };
    }
    case "merged": {
      // The merged text is unsaved until the user saves it, now against the newer version. A converted page stays
      // UTF-8 (Codex review of 52051c8, R3).
      const base = s.convert ? converted(e.theirs) : e.theirs;
      return { ...s, status: e.text === e.theirs.text && !s.convert ? "clean" : "dirty", base, text: e.text, version: s.version + 1, banner: undefined, theirs: undefined };
    }
    case "reloaded":
      return reduce({ ...s, banner: undefined, theirs: undefined, saving: undefined }, { type: "loaded", loaded: e.theirs });
    case "failed":
      return s.base ? { ...s, status: s.status === "saving" ? "dirty" : s.status, saving: undefined, error: e.error } : { ...s, status: "error", error: e.error };
    case "draft":
      return e.error === (s.draftError ?? null) ? s : { ...s, draftError: e.error ?? undefined };
    case "convert": {
      // The page becomes editable as UTF-8 (same line endings), unsaved until written: from a read-only page whose
      // encoding was the problem, or from an unsaved page whose characters its encoding cannot hold.
      const from = s.status === "readOnly" ? !!s.base?.convertible : s.status === "dirty";
      if (!s.base || s.base.binary || !from) return s;
      return { ...s, status: "dirty", base: converted(s.base), convert: true, error: undefined };
    }
    case "dismiss":
      return { ...s, banner: undefined, error: undefined };
  }
}

/** Whether a version read from disk can be merged into: text Hivemind can edit, not binary or undecodable. A page
 *  being converted to UTF-8 can also merge a version whose only problem is its encoding. */
export const mergeable = (l: Loaded | undefined, convert = false) => !!l && (convert ? canConvert(l) : !l.binary && !l.readOnly);

/** Whether the document holds edits that are not on disk. */
export const isUnsaved = (s: DocState | undefined) => !!s && (s.status === "dirty" || s.status === "saving" || s.status === "stale");
