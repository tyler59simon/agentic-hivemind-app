import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { classify } from "../../lib/errors";
import { at, merge, read } from "../../lib/lm";
import { sections } from "../../lib/note";
import { STALE_MESSAGE, writeFailure } from "../../lib/stale";
import { Modal } from "../../ui/Modal";
import { toast } from "../../ui/toast";
import { explain, finishDirect, undoToast } from "./DirectDialog";

type NoteTarget = { ref: string; title: string };

/** Merge one note into another: the target keeps its ID and takes the merged text; the source is superseded and archived.
 *  One direct, journaled write, sent with the revisions the merged text was made from. */
export function MergeComposer({ source, target, onClose }: { source: NoteTarget; target: NoteTarget; onClose: () => void }) {
  const client = useQueryClient();
  const [body, setBody] = useState<string | null>(null);
  const [revisions, setRevisions] = useState<{ target: string; source: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => Promise.all([read(target.ref), read(source.ref)]).then(([t, s]) => {
    const summary = sections(s.body).summary ?? source.title;
    setBody(`${t.body}\n\n## Merged from ${source.title}\n${summary}`);
    setRevisions({ target: t.revision, source: s.revision });
  }), [source.ref, source.title, target.ref]);
  useEffect(() => { load().catch((e) => toast(String(e), "error")); }, [load]);

  const apply = async () => {
    if (body === null || !revisions) return;
    setBusy(true);
    setError(null);
    try {
      const receipt = await merge({ target: at(target.ref, revisions.target), sources: [at(source.ref, revisions.source)], body });
      await finishDirect(client, receipt);
      undoToast(client, `Merged into “${target.title}”.`, receipt);
      onClose();
    } catch (e) {
      if (classify(e).kind === "stale") {
        // The merged text was made from the notes as they were: make it again from what they hold now.
        setError(`${await writeFailure(client, e)} The merged text below was made again from the notes as they are now.`);
        await load().catch((err) => setError(classify(err).message));
      } else setError(explain(e));
      setBusy(false);
    }
  };

  return (
    <Modal title={`Merge into “${target.title}”`} onClose={onClose} wide locked={busy}>
      <p>The merged note keeps “{target.title}”. “{source.title}” is marked superseded and moves to the archive. Edit the merged text, then merge.</p>
      {body === null ? <p className="muted">Loading…</p> : <textarea className="merge-body" value={body} disabled={busy} onChange={(e) => setBody(e.target.value)} />}
      <p className="muted small">Living Memory journals the change, so it can be undone from the toast or from Activity.</p>
      {error && <p className={error.startsWith(STALE_MESSAGE) ? "warn-text" : "error"}>{error}</p>}
      <div className="actions">
        <button onClick={onClose} disabled={busy}>Cancel</button>
        <button className="primary" disabled={body === null || busy} onClick={apply}>{busy ? "Merging…" : "Merge"}</button>
      </div>
    </Modal>
  );
}
