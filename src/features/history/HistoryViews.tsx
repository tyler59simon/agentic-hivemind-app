import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { history } from "../../lib/lm";
import type { Tab } from "../../workspace/store";
import { dayMonth } from "../../ui/Page";
import { verbOf, visible } from "./activity";
import { OperationList, useActors, useNotesById } from "./OperationList";

function useNoteHistory(refId: string) {
  const id = refId.split(":")[1];
  const ops = useQuery({ queryKey: ["history", id], queryFn: () => history({ note: id, limit: 100 }) });
  const notes = useNotesById();
  const shown = useMemo(() => (ops.data ?? []).filter(visible), [ops.data]);
  return { ops, notes, shown, actorFor: useActors(shown, notes) };
}

/** The History tab of a note: every journaled change to it, with its diff and an Undo plan. */
export function HistoryPanel({ tab }: { tab: Tab }) {
  const { ops, notes, shown, actorFor } = useNoteHistory(tab.ref!);
  if (ops.isLoading) return <p className="muted pad">Loading…</p>;
  if (ops.error) return <p className="error pad">{String(ops.error)}</p>;
  if (!shown.length) return <p className="muted pad">No recorded changes.</p>;
  return (
    <>
      <p className="muted small">{shown.length} recorded change{shown.length === 1 ? "" : "s"}{ops.data && ops.data.length >= 100 ? " (the newest 100)" : ""}</p>
      <OperationList ops={shown} notes={notes} actorFor={actorFor} showNotes={false} />
    </>
  );
}

/** The newest few changes to a note as a timeline, for the context rail. */
export function SourceHistory({ refId }: { refId: string }) {
  const { ops, shown, actorFor } = useNoteHistory(refId);
  if (ops.isLoading) return <p className="muted">Loading…</p>;
  if (ops.error) return <p className="error">{String(ops.error)}</p>;
  if (!shown.length) return <p className="muted">No recorded changes.</p>;
  return (
    <ol className="timeline">
      {shown.slice(0, 4).map((op) => (
        <li key={op.operation_id}><strong>{dayMonth(op.created)}</strong><span>{actorFor(op).label} {verbOf(op.kind)}</span></li>
      ))}
    </ol>
  );
}
