import { useEffect, useState } from "react";
import { mergePlan, read } from "../../lib/lm";
import { sections } from "../../lib/note";
import { Modal } from "../../ui/Modal";
import { toast } from "../../ui/toast";
import { PlanDialog } from "./PlanDialog";

type NoteTarget = { ref: string; title: string };

/** Merge one note into another: the target keeps its ID; the source is superseded and archived. */
export function MergeComposer({ source, target, onClose }: { source: NoteTarget; target: NoteTarget; onClose: () => void }) {
  const [body, setBody] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    Promise.all([read(target.ref), read(source.ref)]).then(([t, s]) => {
      const summary = sections(s.body).summary ?? source.title;
      setBody(`${t.body}\n\n## Merged from ${source.title}\n${summary}`);
    }).catch((e) => toast(String(e), "error"));
  }, [source.ref, source.title, target.ref]);
  if (ready && body !== null) {
    return (
      <PlanDialog title={`Merge into “${target.title}”`} make={() => mergePlan({ target: target.ref, sources: [source.ref], body })}
        applyLabel="Merge" onClose={onClose} />
    );
  }
  return (
    <Modal title={`Merge into “${target.title}”`} onClose={onClose} wide>
      <p>The merged note keeps “{target.title}”. “{source.title}” is marked superseded and moves to the archive. Edit the merged text, then review the plan.</p>
      {body === null ? <p className="muted">Loading…</p> : <textarea className="merge-body" value={body} onChange={(e) => setBody(e.target.value)} />}
      <div className="actions"><button onClick={onClose}>Cancel</button><button className="primary" disabled={body === null} onClick={() => setReady(true)}>Review plan…</button></div>
    </Modal>
  );
}
