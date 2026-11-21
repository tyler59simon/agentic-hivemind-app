// One key per open document, whatever tab shows it (README 5.1). Notes keep their ref. File keys keep the path's
// letter case: in a case-sensitive folder `A.md` and `a.md` are two files (Codex re-review of fa08348, W1). The tree,
// the dialogs and the watcher give paths in the case on disk, and a rename in Hivemind moves the document to its new key.
export interface FileRef { notebook: string; path: string }

interface Keyed { kind: string; ref?: string; file?: FileRef }

export function docKey(tab: Keyed): string {
  if (tab.kind === "file" && tab.file) return `file:${tab.file.notebook}:${tab.file.path}`;
  return `${tab.kind}:${tab.ref ?? ""}`;
}

/** Whether two tabs show the same document. New notes and new text files are never the same as anything. */
export const sameDoc = (a: Keyed, b: Keyed) => a.kind === b.kind && a.kind !== "new-note" && a.kind !== "new-file" && docKey(a) === docKey(b);

/** `path` moved from `from` to `to` (a file, or a folder and everything in it); null when the move does not touch it. */
export function movedPath(path: string, from: string, to: string): string | null {
  if (path === from) return to;
  if (path.startsWith(`${from}/`)) return to + path.slice(from.length);
  return null;
}

/** The draft key of a document: a hash, so long or unusual paths never collide or overflow the 200-character limit. */
export async function draftKeyOf(key: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  const hex = Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
  return `${key.startsWith("file:") ? "file" : "doc"}-${hex}`;
}
