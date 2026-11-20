import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { discard, keyOf } from "../../documents/store";
import { classify } from "../../lib/errors";
import { metaQuery, removeNotebook, renameNotebook, setNotebookMeta, type Notebook, type NotebookMeta } from "../../lib/notebooks";
import { Modal } from "../../ui/Modal";
import { toast } from "../../ui/toast";
import { useWorkspace } from "../../workspace/store";

/** A notebook's name and folders. Settings other than the name are kept in the notebook's `.hivemind/notebook.json`. */
export function NotebookSettings({ notebook, onClose }: { notebook: Notebook; onClose: () => void }) {
  const client = useQueryClient();
  const meta = useQuery(metaQuery(notebook.id));
  const [title, setTitle] = useState(notebook.title);
  const [form, setForm] = useState<NotebookMeta | null>(null);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState(false);
  const values = form ?? meta.data ?? {};
  const field = (key: "attachments" | "templates" | "inbox", label: string, hint: string) => (
    <label className="field">
      <span>{label}</span>
      <input value={(values[key] as string | undefined) ?? ""} placeholder={hint} onChange={(e) => setForm({ ...values, [key]: e.target.value })} />
    </label>
  );

  const save = async () => {
    setBusy(true);
    try {
      if (title.trim() && title.trim() !== notebook.title) await renameNotebook(notebook.id, title.trim());
      if (form) {
        const patch: NotebookMeta = {};
        for (const key of ["attachments", "templates", "inbox"] as const) {
          const v = (form[key] as string | undefined)?.trim().replace(/\\/g, "/");
          // An empty field removes the setting (null deletes the key in Rust's merge).
          if (v !== (meta.data?.[key] ?? undefined)) patch[key] = v ? v : null;
        }
        if (Object.keys(patch).length) await setNotebookMeta(notebook.id, patch);
      }
      client.invalidateQueries({ queryKey: ["notebooks"] });
      client.invalidateQueries({ queryKey: ["notebook-meta", notebook.id] });
      onClose();
    } catch (e) {
      toast(classify(e).message, "error");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await removeNotebook(notebook.id);
      const ws = useWorkspace.getState();
      for (const pane of ws.panes) {
        for (const tab of pane.tabs) {
          if (tab.kind === "file" && tab.file?.notebook === notebook.id) { discard(keyOf(tab.file)); ws.closeTab(pane.id, tab.id); }
        }
      }
      client.invalidateQueries({ queryKey: ["notebooks"] });
      toast(`Removed ${notebook.title} from Hivemind. Its files are untouched.`);
      onClose();
    } catch (e) {
      toast(classify(e).message, "error");
      setBusy(false);
    }
  };

  return (
    <Modal title="Notebook settings" onClose={onClose} locked={busy}>
      <div className="form">
        <label className="field"><span>Name</span><input value={title} onChange={(e) => setTitle(e.target.value)} /></label>
        <p className="muted small">Folder: <code>{notebook.path}</code></p>
        {field("attachments", "Attachments folder", "attachments")}
        {field("templates", "Templates folder", "Templates")}
        {field("inbox", "Inbox page", "Inbox.md")}
        <p className="muted small">These are kept in <code>.hivemind/notebook.json</code> inside the notebook, so they travel with the folder.</p>
      </div>
      {removing ? (
        <div className="banner warn">
          Remove this notebook from Hivemind? Its folder and files stay where they are; unsaved edits in its open pages are dropped.
          <div className="actions"><button onClick={() => setRemoving(false)}>Cancel</button><button className="danger" onClick={remove} disabled={busy}>Remove</button></div>
        </div>
      ) : (
        <div className="actions">
          <button className="danger-text ghost" onClick={() => setRemoving(true)}>Remove from Hivemind…</button>
          <span className="fill" />
          <button onClick={onClose} disabled={busy}>Cancel</button>
          <button className="primary" onClick={save} disabled={busy}>Save</button>
        </div>
      )}
    </Modal>
  );
}
