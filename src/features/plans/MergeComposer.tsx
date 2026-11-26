import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { classify } from "../../lib/errors";
import { at, LM_READ_LIMIT, merge, read, type Note } from "../../lib/lm";
import { sections } from "../../lib/note";
import { STALE_MESSAGE, writeFailure } from "../../lib/stale";
import { Modal } from "../../ui/Modal";
import { toast } from "../../ui/toast";
import { explain, finishDirect, undoToast } from "./DirectDialog";

type NoteTarget = { ref: string; title: string };
/** Both notes as Living Memory returned them. */
type Pair = { target: Note; source: Note };

/** The merged text made from both notes: the target's body, then the source's summary. */
const build = ({ target, source }: Pair) => `${target.body}\n\n## Merged from ${source.title}\n${sections(source.body).summary ?? source.title}`;

/** Why the pair cannot be merged here: a note longer than Living Memory's read limit comes back cut off, and a merged text made
 *  from it would replace the whole note with its first part (Codex review of e30902f, D1). The source's summary feeds the text
 *  too, so a cut-off source blocks as well. */
export function cutOff({ target, source }: Pair): string | null {
  const long = [target, source].filter((n) => n.truncated).map((n) => `“${n.title}”`);
  if (!long.length) return null;
  return `${long.join(" and ")} ${long.length > 1 ? "are" : "is"} longer than the ${LM_READ_LIMIT.toLocaleString("en-US")} characters Hivemind can read, so merged text made here would drop the rest. Shorten the note first.`;
}

/** Merge one note into another: the target keeps its ID and takes the merged text; the source is superseded and archived.
 *  One direct, journaled write, sent with the revisions the merged text was made from. A stale refusal keeps the user's text:
 *  they merge it over the notes as they are now, or make it again from them (Codex review of e30902f, S1). */
export function MergeComposer({ source, target, onClose }: { source: NoteTarget; target: NoteTarget; onClose: () => void }) {
  const client = useQueryClient();
  const [body, setBody] = useState<string | null>(null);
  // The text as made from the notes: a body still equal to it holds nothing of the user's.
  const [made, setMade] = useState<string | null>(null);
  const [revisions, setRevisions] = useState<{ target: string; source: string } | null>(null);
  // The notes as read again after a stale refusal, until the user keeps their text or makes it again.
  const [fresh, setFresh] = useState<Pair | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const readPair = () => Promise.all([read(target.ref), read(source.ref)]).then(([t, s]): Pair => ({ target: t, source: s }));
  const start = (pair: Pair) => {
    const text = build(pair);
    setBody(text);
    setMade(text);
    setRevisions({ target: pair.target.revision, source: pair.source.revision });
    setFresh(null);
  };
  useEffect(() => {
    readPair().then((pair) => {
      const cut = cutOff(pair);
      if (cut) setBlocked(cut);
      else start(pair);
    }).catch((e) => toast(String(e), "error"));
  }, [source.ref, target.ref]); // eslint-disable-line react-hooks/exhaustive-deps

  const apply = async () => {
    if (body === null || !revisions || fresh || blocked) return;
    setBusy(true);
    setError(null);
    try {
      const receipt = await merge({ target: at(target.ref, revisions.target), sources: [at(source.ref, revisions.source)], body });
      await finishDirect(client, receipt);
      undoToast(client, `Merged into “${target.title}”.`, receipt);
      onClose();
    } catch (e) {
      if (classify(e).kind === "stale") {
        let now: Pair | null = null;
        const message = await writeFailure(client, e, () => readPair().then((pair) => { now = pair; }));
        const pair = now as Pair | null;
        const cut = pair && cutOff(pair);
        if (cut) {
          setBlocked(cut);
          setError(message);
        } else if (pair && body === made) {
          // Nothing of the user's is in the text: make it again from the notes as they are now.
          start(pair);
          setError(`${message} The merged text below was made again from the notes as they are now.`);
        } else if (pair) {
          setFresh(pair);
          setError(`${message} Your merged text is kept. Merge it over the notes as they are now, or make it again from them.`);
        } else setError(message);
      } else setError(explain(e));
      setBusy(false);
    }
  };

  const keep = () => {
    if (!fresh) return;
    setRevisions({ target: fresh.target.revision, source: fresh.source.revision });
    setFresh(null);
    setError(null);
  };
  const remake = () => {
    if (!fresh) return;
    start(fresh);
    setError(null);
  };

  return (
    <Modal title={`Merge into “${target.title}”`} onClose={onClose} wide locked={busy}>
      <p>The merged note keeps “{target.title}”. “{source.title}” is marked superseded and moves to the archive. Edit the merged text, then merge.</p>
      {blocked ? <p className="error">{blocked}</p>
        : body === null ? <p className="muted">Loading…</p>
        : <textarea className="merge-body" aria-label="Merged text" value={body} disabled={busy} onChange={(e) => setBody(e.target.value)} />}
      <p className="muted small">Living Memory journals the change, so it can be undone from the toast or from Activity.</p>
      {error && <p className={error.startsWith(STALE_MESSAGE) ? "warn-text" : "error"}>{error}</p>}
      <div className="actions">
        <button onClick={onClose} disabled={busy}>Cancel</button>
        {fresh && <button onClick={remake}>Make it again</button>}
        {fresh && <button onClick={keep}>Keep my text</button>}
        <button className="primary" disabled={body === null || busy || !!fresh || !!blocked} onClick={apply}>{busy ? "Merging…" : "Merge"}</button>
      </div>
    </Modal>
  );
}
