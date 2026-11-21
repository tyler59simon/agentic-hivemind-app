// New notebook (NS-2C): a folder on disk (the native dialog), or a Living Memory notebook in a domain, which can be a
// new notebook-only domain that holds no notes.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { classify } from "../../lib/errors";
import { allDomains, docNotebookCreate, domainCreateNotebook } from "../../lib/lm";
import { useApp } from "../../store";
import { Modal } from "../../ui/Modal";
import { toast } from "../../ui/toast";

const NEW = "\u0000new";

/** A notebook id from its title: 2 to 40 lowercase letters, digits or hyphens, as Living Memory requires. */
export function notebookId(title: string): string {
  const id = title.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
  return id.length >= 2 ? id : "notebook";
}

export function NewNotebook({ onClose, onFolder }: { onClose: () => void; onFolder: () => void }) {
  const client = useQueryClient();
  const known = useQuery({ queryKey: ["all-domains"], queryFn: allDomains });
  const preferred = useApp((s) => s.domain);
  const [kind, setKind] = useState<"lm" | "folder">("lm");
  const [domain, setDomain] = useState<string | null>(null);
  const [newDomain, setNewDomain] = useState("");
  const [title, setTitle] = useState("");
  const [id, setId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const list = known.data?.domains ?? [];
  const chosen = domain ?? (list.some((d) => d.name === preferred) ? preferred! : list[0]?.name ?? NEW);
  const nbId = id ?? notebookId(title);

  const create = async () => {
    const target = chosen === NEW ? newDomain.trim() : chosen;
    if (!target) { toast("Name the new domain.", "error"); return; }
    if (!title.trim()) { toast("Give the notebook a name.", "error"); return; }
    setBusy(true);
    try {
      if (chosen === NEW) await domainCreateNotebook(target);
      await docNotebookCreate(target, nbId, title.trim());
      for (const key of [["lm-notebooks"], ["all-domains"], ["domains"]]) client.invalidateQueries({ queryKey: key });
      toast(`Created ${title.trim()} in ${target}.`);
      onClose();
    } catch (e) {
      toast(classify(e).message, "error");
      setBusy(false);
    }
  };

  return (
    <Modal title="New notebook" onClose={onClose} locked={busy}>
      <div className="form">
        <label className="check"><input type="radio" name="kind" checked={kind === "lm"} onChange={() => setKind("lm")} />
          <span><b>Living Memory notebook.</b> Pages live in your memory store: backed up, journaled (every save can be undone) and synced to Obsidian with the domain.</span></label>
        <label className="check"><input type="radio" name="kind" checked={kind === "folder"} onChange={() => setKind("folder")} />
          <span><b>Folder on disk.</b> Any folder of Markdown files, such as an Obsidian vault; pages stay ordinary files.</span></label>
        {kind === "lm" && (
          <>
            <label className="field"><span>Name</span><input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Plans" /></label>
            <label className="field"><span>Id</span><input value={nbId} onChange={(e) => setId(e.target.value)} aria-describedby="nb-id-hint" /></label>
            <p className="muted small" id="nb-id-hint">2 to 40 lowercase letters, digits or hyphens; it names the notebook's folder.</p>
            <label className="field">
              <span>Domain</span>
              <select value={chosen} onChange={(e) => setDomain(e.target.value)}>
                {list.map((d) => <option key={d.name} value={d.name}>{d.name}{d.kind === "notebook" ? " (notebooks only)" : ""}</option>)}
                <option value={NEW}>New notebook-only domain…</option>
              </select>
            </label>
            {chosen === NEW && (
              <>
                <label className="field"><span>New domain name</span><input value={newDomain} onChange={(e) => setNewDomain(e.target.value)} placeholder="journal" /></label>
                <p className="muted small">A notebook-only domain holds notebooks and no notes, and no project folder is bound to it.</p>
              </>
            )}
          </>
        )}
      </div>
      <div className="actions">
        <span className="fill" />
        <button onClick={onClose} disabled={busy}>Cancel</button>
        {kind === "lm"
          ? <button className="primary" onClick={create} disabled={busy}>Create notebook</button>
          : <button className="primary" onClick={() => { onClose(); onFolder(); }}>Choose a folder…</button>}
      </div>
    </Modal>
  );
}
