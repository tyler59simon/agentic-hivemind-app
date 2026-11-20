import { unsavedUnder, useDocuments } from "../../documents/store";
import { Confirm } from "../../ui/Modal";

/** Confirm moving a page or section to the notebook's trash. Unsaved edits are not in the files that go to the trash,
 *  so the pages holding them are named, read again whenever a document changes while the dialog is open (Codex review
 *  of 32fd236 and re-review of c496e1c, D8). */
export function DeleteConfirm({ notebook, path, section, onAnswer }: {
  notebook: string; path: string; section: boolean; onAnswer: (yes: boolean) => void;
}) {
  useDocuments((s) => s.docs);
  const lost = unsavedUnder(notebook, path);
  return (
    <Confirm title={section ? "Delete this section?" : "Delete this page?"} danger action={lost.length ? "Delete and lose my edits" : "Move to trash"}
      message={<>
        <p><code>{path}</code>{section ? " and everything in it" : ""} moves to the notebook's <code>.hivemind/trash</code> folder, where you can get it back.</p>
        {lost.length > 0 && (
          <p className="error">
            Unsaved edits are lost when {lost.length === 1 ? "this page is" : "these pages are"} deleted: {lost.map((p) => <code key={p}>{p}</code>)}.
            Save first to keep them in the trash copy.
          </p>
        )}
      </>}
      onAnswer={onAnswer} />
  );
}
