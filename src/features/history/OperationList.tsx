import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { DiffView } from "../../components/DiffView";
import { diff, list, meta, undo, type NoteRow, type Operation } from "../../lib/lm";
import { myOperations } from "../../lib/oplog";
import { toast } from "../../ui/toast";
import { useWorkspace } from "../../workspace/store";
import { explain, finishDirect } from "../plans/DirectDialog";
import { HoverPreview } from "../preview/HoverPreview";
import { actorOf, dayLabel, noteIdsOf, serverActor, verbOf, type Actor } from "./activity";

/** Every note in the store by its 8-character ID prefix (archived and superseded included). */
export function useNotesById() {
  const all = useQuery({ queryKey: ["list", "*", "any"], queryFn: () => list({ allDomains: true, status: "any" }) });
  return useMemo(() => new Map((all.data?.notes ?? []).map((n) => [n.id.slice(0, 8), n])), [all.data]);
}

/** Labels for each operation; captures look up their note's origin to name the agent. */
export function useActors(ops: Operation[], notes: Map<string, NoteRow>) {
  const mine = useMemo(() => myOperations(), [ops]); // eslint-disable-line react-hooks/exhaustive-deps
  const captured = [...new Set(ops.filter((o) => o.kind.startsWith("capture") && !mine.has(o.operation_id))
    .map((o) => notes.get(noteIdsOf(o)[0] ?? "")?.ref).filter((r): r is string => !!r))];
  const origins = useQueries({ queries: captured.map((ref) => ({ queryKey: ["meta", ref], queryFn: () => meta(ref), staleTime: Infinity })) });
  const originOf = new Map(captured.map((ref, i) => [ref, origins[i].data?.origin]));
  // The server's own actor (history level 3) wins over the guess.
  return (op: Operation): Actor => op.actor ? serverActor(op.actor, mine.has(op.operation_id)) : actorOf(op, mine, originOf.get(notes.get(noteIdsOf(op)[0] ?? "")?.ref ?? ""));
}

function OperationDiff({ id }: { id: string }) {
  const changes = useQuery({ queryKey: ["diff", id], queryFn: () => diff(id), staleTime: Infinity });
  if (changes.isLoading) return <p className="muted small">Loading…</p>;
  if (changes.error) return <p className="error small">{String(changes.error)}</p>;
  const shown = (changes.data ?? []).filter((c) => !c.path.endsWith(".derived-dirty") && c.diff);
  return <>{shown.map((c) => <div key={c.path}><div className="muted small">{c.path.split("/").pop()}</div><DiffView text={c.diff} /></div>)}</>;
}

/** Operations grouped by day, each with who, what, which notes, its diff and Undo. */
export function OperationList({ ops, notes, actorFor, showNotes = true }: {
  ops: Operation[]; notes: Map<string, NoteRow>; actorFor: (op: Operation) => Actor; showNotes?: boolean;
}) {
  const openNote = useWorkspace((s) => s.openNote);
  const [open, setOpen] = useState<string | null>(null);
  const client = useQueryClient();
  const undoOp = (op: Operation) => {
    undo(op.operation_id)
      .then(async (r) => {
        await finishDirect(client, r);
        toast(`Undid: ${verbOf(op.kind)}.`);
      })
      .catch((e) => toast(explain(e), "error"));
  };
  let lastDay = "";
  return (
    <ol className="ops">
      {ops.map((op) => {
        const day = dayLabel(op.created);
        const header = day !== lastDay ? <li key={`day-${day}`} className="ops-day">{(lastDay = day)}</li> : null;
        const actor = actorFor(op);
        const touched = noteIdsOf(op).map((id) => notes.get(id)).filter((n): n is NoteRow => !!n);
        return [
          header,
          <li key={op.operation_id} className="op">
            <div className="op-line">
              <span className="muted small">{new Date(op.created).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
              <span className={`actor actor-${actor.kind}`}>{actor.label}</span>
              <span>{verbOf(op.kind)}</span>
              {op.summary && <span className="muted small">{op.summary}</span>}
              {showNotes && touched.map((n) => (
                <HoverPreview key={n.ref} refId={n.ref}>
                  <a href="#" className="wikilink" onClick={(e) => { e.preventDefault(); openNote(n.ref, { split: e.ctrlKey || e.metaKey, title: n.title }); }}>{n.title}</a>
                </HoverPreview>
              ))}
              {showNotes && !touched.length && !op.files.some((f) => f.endsWith(".md")) && <span className="muted small">{op.files.filter((f) => !f.endsWith(".derived-dirty")).join(", ")}</span>}
              <span className="tabbar-fill" />
              <button className="ghost small" onClick={() => setOpen(open === op.operation_id ? null : op.operation_id)}>{open === op.operation_id ? "Hide changes" : "Changes"}</button>
              <button className="ghost small" title="Reverse this change. It is refused if the files were edited again afterwards."
                onClick={() => undoOp(op)}>
                Undo
              </button>
            </div>
            {open === op.operation_id && <OperationDiff id={op.operation_id} />}
          </li>,
        ];
      })}
    </ol>
  );
}
