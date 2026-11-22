// The editor of each file tab, so the command palette and the status line can act on it (NS-6A).
import type { EditorView } from "@codemirror/view";

const editors = new Map<string, EditorView>();

/** A file tab's editor, while it is showing source. `null` removes it. */
export function setEditor(tabId: string, view: EditorView | null) {
  if (view) editors.set(tabId, view);
  else editors.delete(tabId);
}

/** The tab's editor, if it has one now. */
export const editorOf = (tabId: string | undefined) => (tabId ? editors.get(tabId) : undefined);
