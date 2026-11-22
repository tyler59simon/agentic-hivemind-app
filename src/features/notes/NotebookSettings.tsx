import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { discard, keyOf } from "../../documents/store";
import { useFolderPolicyEnabled } from "../../lib/connection";
import { classify } from "../../lib/errors";
import { docNotebookUpdate, domains, type DocNotebook, type Visibility } from "../../lib/lm";
import { metaQuery, removeNotebook, renameNotebook, setNotebookMeta, type Notebook, type NotebookMeta } from "../../lib/notebooks";
import { indexRebuild, statusQuery } from "../../lib/noteindex";
import { useApp } from "../../store";
import { Modal } from "../../ui/Modal";
import { toast } from "../../ui/toast";
import { useWorkspace } from "../../workspace/store";
import { progressLine, useIndexState } from "../search/indexState";
import { domainForFolder, forgetFolder, REACH_TEXT, setFolderReach, stricter, type ReachChange } from "./reach";

interface Reach { visibility: Visibility; private: boolean }

/** Agent reach and Private, for both notebook kinds (NS-2C). `onChange` gets only the field the user touched (R2-P1). */
export function ReachFields({ value, onChange }: { value: Reach; onChange: (v: Partial<Reach>) => void }) {
  return (
    <fieldset className="field reach">
      <legend>Agent reach</legend>
      {(["hidden", "searchable", "injectable"] as const).map((v) => (
        <label key={v} className="check"><input type="radio" name="reach" checked={value.visibility === v} onChange={() => onChange({ visibility: v })} />
          <span><b>{REACH_TEXT[v].label}.</b> {REACH_TEXT[v].text}</span></label>
      ))}
      <label className="check"><input type="checkbox" checked={value.private} onChange={(e) => onChange({ private: e.target.checked })} />
        <span><b>Private.</b> Hivemind's AI features and every Living Memory search and prompt leave this notebook out. It is not file
          protection: an agent whose working folder holds the files can still read them with its own tools.</span></label>
    </fieldset>
  );
}

const unregistered = (nb: Notebook) => !nb.domain;

/** The search index of a folder notebook: how many pages it holds, how far a scan is, and Rebuild index (NS-4A). */
function IndexFields({ notebook }: { notebook: Notebook }) {
  const status = useQuery({ ...statusQuery(), refetchInterval: false });
  const progress = useIndexState((s) => s.progress) ?? status.data ?? null;
  const pages = status.data?.notebooks.find((n) => n.id === notebook.id)?.pages ?? 0;
  const running = progress?.state === "scanning";
  const rebuild = () => indexRebuild(notebook.id).catch((e) => toast(classify(e).message, "error"));
  return (
    <div className="field">
      <span>Search index</span>
      <p className="muted small">
        {status.isLoading ? "Reading the index…" : `${pages.toLocaleString()} ${pages === 1 ? "page is" : "pages are"} searchable.`}
        {running && ` ${progressLine(progress)}.`}
        {progress?.error && !running && <span className="error"> {progress.error}</span>}
      </p>
      <div className="actions"><button onClick={rebuild} disabled={running}>Rebuild index</button></div>
      <p className="muted small">The index is made from the files and can be rebuilt at any time. Deleting it loses nothing.</p>
    </div>
  );
}

/** Close every tab of a notebook, dropping their documents and drafts. */
function closeNotebookTabs(id: string) {
  const ws = useWorkspace.getState();
  for (const pane of ws.panes) {
    for (const tab of pane.tabs) {
      if (tab.kind === "file" && tab.file?.notebook === id) { discard(keyOf(tab.file)); ws.closeTab(pane.id, tab.id); }
    }
  }
}

/** A folder notebook's name, folders and agent reach. Settings other than the name and reach are kept in the notebook's
 *  `.hivemind/notebook.json`; reach goes to Living Memory first (NS-2C). */
export function NotebookSettings({ notebook, onClose }: { notebook: Notebook; onClose: () => void }) {
  const client = useQueryClient();
  const meta = useQuery(metaQuery(notebook.id));
  // Agent reach needs Living Memory's folder policy, not only notebook pages (Codex review of 32fee20, C1).
  const docs = useFolderPolicyEnabled();
  const known = useQuery({ queryKey: ["domains"], queryFn: domains, enabled: docs });
  const fallback = useApp((s) => s.domain);
  const [title, setTitle] = useState(notebook.title);
  const [form, setForm] = useState<NotebookMeta | null>(null);
  const [edits, setEdits] = useState<Partial<Reach>>({});
  const [domain, setDomain] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState(false);
  const values = form ?? meta.data ?? {};
  // The stricter of Hivemind's copy and the sidecar, as Living Memory judges it.
  const current = stricter(notebook, (meta.data ?? {}) as Partial<Reach>);
  const shown = { ...current, ...edits };
  const memoryDomains = known.data?.domains ?? [];
  const chosenDomain = domain ?? notebook.domain ?? domainForFolder(notebook.path, memoryDomains, fallback) ?? "";
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
      // Only what the user changed goes to Living Memory, so a privacy decision made elsewhere while this dialog was open
      // stays (Codex review of 32fee20, P3). A folder never registered keeps what Living Memory holds for it, or becomes
      // searchable.
      // Every field the user touched is sent, even one set back to what the dialog showed: what Living Memory holds may
      // have changed since (Codex review of dd4c1b0, R3-P1). Untouched fields are never sent (R2-P1).
      const change: ReachChange = edits;
      if (docs && (Object.keys(change).length || domain !== null || unregistered(notebook))) {
        if (!chosenDomain) throw new Error("Pick the memory domain agents find this notebook from.");
        await setFolderReach(notebook, chosenDomain, change);
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
      closeNotebookTabs(notebook.id);
      client.invalidateQueries({ queryKey: ["notebooks"] });
      toast(`Removed ${notebook.title} from Hivemind. Its files are untouched.`);
      // Living Memory forgets it too; a hidden or private folder stays out of agents' reach (NS-2C).
      if (docs && !unregistered(notebook)) {
        await forgetFolder(notebook).catch((e) => toast(`Living Memory still lists ${notebook.title} for agent search: ${classify(e).message}`, "warn"));
      }
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
        <IndexFields notebook={notebook} />
        {docs ? (
          <>
            <ReachFields value={shown} onChange={(e) => setEdits((was) => ({ ...was, ...e }))} />
            <label className="field">
              <span>Agents find it from the domain</span>
              <select value={chosenDomain} onChange={(e) => setDomain(e.target.value)}>
                {!chosenDomain && <option value="">Pick a domain</option>}
                {memoryDomains.map((d) => <option key={d.name} value={d.name}>{d.name}</option>)}
              </select>
            </label>
            {unregistered(notebook) && <p className="muted small">Living Memory has not registered this folder yet, so agents do not search it. Save to register it.</p>}
          </>
        ) : <p className="muted small">Agent reach needs a newer Living Memory (with folder notebook policy).</p>}
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

/** A Living Memory notebook's title and agent reach, kept in its `notebook.json` (NS-2C). */
export function LmNotebookSettings({ nb, onClose }: { nb: DocNotebook; onClose: () => void }) {
  const client = useQueryClient();
  const [title, setTitle] = useState(nb.title);
  const [edits, setEdits] = useState<Partial<Reach>>({});
  const [busy, setBusy] = useState(false);
  const save = async () => {
    const patch: { title?: string; visibility?: Visibility; private?: boolean } = {};
    if (title.trim() && title.trim() !== nb.title) patch.title = title.trim();
    Object.assign(patch, edits);
    if (!Object.keys(patch).length) { onClose(); return; }
    setBusy(true);
    try {
      await docNotebookUpdate(nb.domain, nb.notebook, patch);
      client.invalidateQueries({ queryKey: ["lm-notebooks"] });
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
        <p className="muted small">Living Memory notebook <code>{nb.notebook}</code> in <code>{nb.domain}</code>: {nb.pages} pages, {nb.assets} attachments.</p>
        <ReachFields value={{ visibility: nb.visibility, private: nb.private, ...edits }} onChange={(e) => setEdits((was) => ({ ...was, ...e }))} />
      </div>
      <div className="actions">
        <span className="fill" />
        <button onClick={onClose} disabled={busy}>Cancel</button>
        <button className="primary" onClick={save} disabled={busy}>Save</button>
      </div>
    </Modal>
  );
}
