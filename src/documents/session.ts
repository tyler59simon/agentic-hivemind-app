// The life of one open document (a notebook page), as a pure reducer. Side effects (reading, saving, drafts) live in
// store.ts; this file only decides what the state becomes.
import type { FileFormat, Stamp } from "../lib/notebooks";

/** A file as read from disk. */
export interface Loaded { text: string; stamp: Stamp; format: FileFormat; readOnly: string | null; binary: boolean; convertible?: boolean; chooseEol?: boolean }

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
  /** A draft the file cannot take now (it opened read-only, is not text or is gone): kept, and offered as a copy. */
  kept?: { text: string; at: string };
  /** The user changed the encoding or line endings (NS-6A): `from` is the format the file has on disk, and `base.format`
   *  is the one the next save writes. */
  reformat?: { from: FileFormat };
}

/** The three parts of a format the user can change. */
export type FormatChange = Partial<Pick<FileFormat, "encoding" | "bom" | "eol">>;

export type DocEvent =
  // reformat: the format the draft's page was to be saved in (a line ending or encoding the user chose).
  | { type: "loaded"; loaded: Loaded; draft?: { text: string; at: string }; convert?: boolean; reformat?: FileFormat }
  | { type: "edited"; text: string; outside?: boolean } // outside: not typed in the editor (an attachment link), so it shows the text
  | { type: "saveStarted" }
  | { type: "saved"; stamp: Stamp }
  | { type: "stale"; theirs: Loaded }
  | { type: "gone" }
  | { type: "outsideChange"; theirs: Loaded }
  | { type: "merged"; text: string; theirs: Loaded }
  | { type: "reloaded"; theirs: Loaded }
  | { type: "failed"; error: string; kept?: { text: string; at: string } }
  | { type: "keptDropped" }
  | { type: "draft"; error: string | null }
  | { type: "convert" }
  // A new line ending or encoding for the next save; from a clean or unsaved page, or a mixed-endings page that is
  // read-only until one is chosen.
  | { type: "reformat"; change: FormatChange }
  | { type: "dismiss" };

export const initial: DocState = { status: "loading", base: null, text: "", version: 0 };

/** `l` as Convert to UTF-8 makes it: editable, written as UTF-8 without a BOM, with the same line endings. */
export const converted = (l: Loaded): Loaded => ({ ...l, format: { ...l.format, encoding: "UTF-8", bom: false, confidence: "valid" }, readOnly: null });

/** Whether converting `l` to UTF-8 makes it editable: text whose only problem is its encoding, or editable text. */
const canConvert = (l: Loaded) => !l.binary && (!l.readOnly || !!l.convertible);

const dirtyOr = (s: DocState, text: string): Status => (s.base && text === s.base.text && !s.convert && !s.reformat ? "clean" : "dirty");

/** Whether two reads of a file allow the same use: editable or not (and why), text or not. */
const sameAccess = (a: Loaded, b: Loaded) =>
  (a.readOnly ?? null) === (b.readOnly ?? null) && a.binary === b.binary && !!a.convertible === !!b.convertible && !!a.chooseEol === !!b.chooseEol;

const sameFormat = (a: FileFormat, b: FileFormat) => a.encoding === b.encoding && a.bom === b.bom && a.eol === b.eol;

export function reduce(s: DocState, e: DocEvent): DocState {
  switch (e.type) {
    case "loaded": {
      // A draft written after Convert to UTF-8 comes back converted (Codex review of 52051c8, D3).
      const convert = !!e.convert && !!e.draft && canConvert(e.loaded);
      // A format the user chose comes back with the draft, for a page that can take it (NS-6A).
      const again = !convert && !!e.draft && !!e.reformat && !e.loaded.binary && (!e.loaded.readOnly || !!e.loaded.chooseEol) && !sameFormat(e.reformat, e.loaded.format);
      const loaded = convert ? converted(e.loaded) : again ? { ...e.loaded, format: e.reformat!, readOnly: null, chooseEol: false } : e.loaded;
      if (loaded.readOnly || loaded.binary) {
        // Its draft stays where it is and is shown, so it can be saved elsewhere (Codex re-review of fa08348, D3).
        const kept = e.draft && (e.draft.text !== loaded.text) ? e.draft : undefined;
        return { status: "readOnly", base: loaded, text: loaded.text, version: s.version + 1, kept };
      }
      if (e.draft && (e.draft.text !== loaded.text || convert || again)) {
        return {
          status: "dirty", base: loaded, text: e.draft.text, version: s.version + 1, banner: { kind: "restored", at: e.draft.at }, convert: convert || undefined,
          reformat: again ? { from: e.loaded.format } : undefined,
        };
      }
      return { status: "clean", base: loaded, text: loaded.text, version: s.version + 1 };
    }
    case "edited": {
      if (s.status === "readOnly" || s.status === "loading" || s.status === "error") return s;
      const version = e.outside ? s.version + 1 : s.version;
      if (s.status === "saving" || s.status === "stale") return { ...s, text: e.text, version };
      return { ...s, text: e.text, status: dirtyOr(s, e.text), version };
    }
    case "saveStarted":
      return s.status === "dirty" ? { ...s, status: "saving", saving: s.text } : s;
    case "saved": {
      if (!s.base || s.saving === undefined) return s;
      const base = { ...s.base, text: s.saving, stamp: e.stamp };
      return { ...s, base, saving: undefined, status: s.text === s.saving ? "clean" : "dirty", banner: undefined, theirs: undefined, convert: undefined, reformat: undefined };
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
      if (!s.base) return s;
      // The same bytes can still be a different file: a read-only attribute set or cleared leaves the hash as it was
      // (Codex review of 7320d7f, UI-2).
      const sameBytes = e.theirs.stamp.sha256 === s.base.stamp.sha256;
      if (sameBytes && sameAccess(e.theirs, s.base)) return s;
      // A kept draft is never dropped by following the file: once the file can take it, the store loads the page
      // again, which brings the draft back as edits (Codex final review of a34fafd, D3b).
      if (s.kept && !e.theirs.readOnly && !e.theirs.binary) return s;
      // A save in flight finds out for itself, and a merge in progress already has a newer version to look at.
      if (s.status === "saving" || s.status === "stale") return s;
      // Unsaved edits of a file whose bytes did not change have nothing to merge or warn about.
      if (s.status === "dirty") return sameBytes ? s : { ...s, banner: { kind: "changed" }, theirs: e.theirs };
      if (e.theirs.readOnly || e.theirs.binary) return { ...s, status: "readOnly", base: e.theirs, text: e.theirs.text, version: sameBytes ? s.version : s.version + 1 };
      return { ...s, status: "clean", base: e.theirs, text: e.theirs.text, version: sameBytes ? s.version : s.version + 1, banner: sameBytes ? s.banner : { kind: "followed" }, theirs: undefined };
    }
    case "merged": {
      // The merged text is unsaved until the user saves it, now against the newer version. A converted page stays
      // UTF-8 (Codex review of 52051c8, R3).
      // A line ending or encoding the user chose is kept too.
      const merged = s.convert ? converted(e.theirs) : e.theirs;
      const base = s.reformat && s.base ? { ...merged, format: { ...merged.format, encoding: s.base.format.encoding, bom: s.base.format.bom, eol: s.base.format.eol } } : merged;
      const reformat = s.reformat && !sameFormat(base.format, e.theirs.format) ? { from: e.theirs.format } : undefined;
      return { ...s, status: e.text === e.theirs.text && !s.convert && !reformat ? "clean" : "dirty", base, text: e.text, version: s.version + 1, banner: undefined, theirs: undefined, reformat };
    }
    case "reloaded":
      return reduce({ ...s, banner: undefined, theirs: undefined, saving: undefined }, { type: "loaded", loaded: e.theirs });
    case "failed":
      return s.base ? { ...s, status: s.status === "saving" ? "dirty" : s.status, saving: undefined, error: e.error } : { ...s, status: "error", error: e.error, kept: e.kept };
    case "keptDropped":
      return { ...s, kept: undefined };
    case "draft":
      return e.error === (s.draftError ?? null) ? s : { ...s, draftError: e.error ?? undefined };
    case "convert": {
      // The page becomes editable as UTF-8 (same line endings), unsaved until written: from a read-only page whose
      // encoding was the problem, or from an unsaved page whose characters its encoding cannot hold.
      const from = s.status === "readOnly" ? !!s.base?.convertible : s.status === "dirty";
      if (!s.base || s.base.binary || !from) return s;
      return { ...s, status: "dirty", base: converted(s.base), convert: true, error: undefined };
    }
    case "reformat": {
      const b = s.base;
      const choosing = s.status === "readOnly" && !!b?.chooseEol && !s.kept;
      if (!b || b.binary || !(s.status === "clean" || s.status === "dirty" || choosing)) return s;
      const from = s.reformat?.from ?? b.format;
      const next: FileFormat = { ...b.format, ...e.change, confidence: e.change.encoding && e.change.encoding !== b.format.encoding ? "valid" : b.format.confidence };
      if (sameFormat(next, b.format)) return s;
      // Back to what the file has: nothing is pending any more.
      if (sameFormat(next, from)) return { ...s, base: { ...b, format: from }, reformat: undefined, status: s.text === b.text && !s.convert ? "clean" : "dirty" };
      return { ...s, status: "dirty", base: { ...b, format: next, readOnly: choosing ? null : b.readOnly, chooseEol: false }, reformat: { from }, error: undefined };
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
