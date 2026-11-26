import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { archiveNote, confirm, resolveNote, update, type ReviewRow } from "../../lib/lm";
import { typeClass } from "../../lib/noteTypes";
import { recordOperation } from "../../lib/oplog";
import { toastWriteFailure } from "../../lib/stale";
import { shortDate } from "../../lib/text";
import { useWorkspace } from "../../workspace/store";
import { MergeComposer } from "../plans/MergeComposer";
import { DirectDialog } from "../plans/DirectDialog";
import { HoverPreview } from "../preview/HoverPreview";
import { primaryAction } from "../review/worklist";
import { snoozeDate } from "./work";

const SNOOZES = [7, 30, 90];

/** Every write here carries the revision the row was listed at; a note changed since is read again, and the user repeats. */
const revisionOf = (row: ReviewRow) => row.revision ?? "";

const snooze = (row: ReviewRow, days: number) => update(row.ref, { review_by: snoozeDate(days), expected_revision: revisionOf(row) });

function ReviewItem({ row, snooze: snoozing = true }: { row: ReviewRow; snooze?: boolean }) {
  const client = useQueryClient();
  const [dialog, setDialog] = useState<"archive" | "resolve" | "merge" | null>(null);
  const done = (operationId?: string) => {
    recordOperation(operationId);
    for (const key of [["review"], ["list"], ["note", row.ref], ["meta", row.ref]]) client.invalidateQueries({ queryKey: key });
  };
  const still = useMutation({
    mutationFn: () => confirm(row.ref, revisionOf(row)),
    onSuccess: (r) => done(r.operation_id),
    onError: (e) => toastWriteFailure(client, e),
  });
  const snoozed = useMutation({
    mutationFn: (days: number) => snooze(row, days),
    onSuccess: (r) => done(r.operation_id),
    onError: (e) => toastWriteFailure(client, e),
  });
  const busy = still.isPending || snoozed.isPending;
  const primary = primaryAction(row);
  const open = () => useWorkspace.getState().openNote(row.ref, { title: row.title });
  const stillTrue = <button key="still" disabled={busy} onClick={() => still.mutate()} title="Confirm this note still holds">Still true</button>;
  const first = {
    confirm: stillTrue,
    open: <button key="open" disabled={busy} onClick={open}>Open</button>,
    resolve: <button key="resolve" disabled={busy} onClick={() => setDialog("resolve")}>{primary.label}</button>,
    archive: <button key="archive" disabled={busy} onClick={() => setDialog("archive")}>{primary.label}</button>,
    merge: <button key="merge" disabled={busy} onClick={() => setDialog("merge")} title={`Merge “${row.pair?.title}” into this note`}>{primary.label}</button>,
  }[primary.kind];
  return (
    <div className="work-group">
      <div className="work-head">
        <span className={`badge ${typeClass(row.type)}`}>{row.type}</span>
        <HoverPreview refId={row.ref}>
          <button className="link-row" onClick={open}>{row.title}</button>
        </HoverPreview>
        {row.kinds?.map((k) => <span key={k} className="badge">{k}</span>)}
      </div>
      {row.reason && <div className="small">{row.reason}</div>}
      <div className="muted small">
        Updated {shortDate(row.updated)}{row.review_by && <> · review by {shortDate(row.review_by)}</>}
      </div>
      <div className="work-actions">
        {first}
        {primary.kind !== "confirm" && stillTrue}
        {snoozing && SNOOZES.map((d) => <button key={d} disabled={busy} onClick={() => snoozed.mutate(d)} title={`Review again in ${d} days`}>Snooze {d}d</button>)}
        {primary.kind !== "archive" && <button disabled={busy} onClick={() => setDialog("archive")}>Archive…</button>}
      </div>
      {dialog === "archive" && (
        <DirectDialog title={`Archive “${row.title}”`} run={() => archiveNote(row.ref, revisionOf(row))} applyLabel="Archive" danger
          done={`Archived “${row.title}”.`} onApplied={(r) => done(r.operation_id)} onClose={() => setDialog(null)}
          intro={<p>The note moves to the archive. Undoing this change restores it.</p>} />
      )}
      {dialog === "resolve" && (
        <DirectDialog title={`Resolve “${row.title}”`} run={() => resolveNote(row.ref, revisionOf(row))} applyLabel="Resolve"
          done={`Resolved “${row.title}”.`} onApplied={(r) => done(r.operation_id)} onClose={() => setDialog(null)}
          intro={<p>The note is marked resolved and moves to the archive.</p>} />
      )}
      {dialog === "merge" && row.pair && <MergeComposer source={row.pair} target={row} onClose={() => setDialog(null)} />}
    </div>
  );
}

/** Notes due for re-confirmation. Snoozing sets a review date and does not confirm, so a caller listing unconfirmed notes turns it off. */
export function ReviewQueue({ rows, snooze }: { rows: ReviewRow[]; snooze?: boolean }) {
  if (!rows.length) return <p className="muted pad">Nothing is due for review</p>;
  return <div className="work-list">{rows.map((r) => <ReviewItem key={r.ref} row={r} snooze={snooze} />)}</div>;
}
