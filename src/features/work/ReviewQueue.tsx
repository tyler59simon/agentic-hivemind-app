import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { archiveNote, confirm, resolveNote, update, type ReviewRow } from "../../lib/lm";
import { typeClass } from "../../lib/noteTypes";
import { recordOperation } from "../../lib/oplog";
import { toastWriteFailure } from "../../lib/stale";
import { shortDate } from "../../lib/text";
import { useWorkspace } from "../../workspace/store";
import { MergeComposer } from "../plans/MergeComposer";
import { SeenDialog, type Seen } from "../plans/DirectDialog";
import { HoverPreview } from "../preview/HoverPreview";
import { primaryAction } from "../review/worklist";
import { snoozeDate } from "./work";

const SNOOZES = [7, 30, 90];

/** Every write here carries the revision the row was listed at; a note changed since is read again, and the user repeats. */
const revisionOf = (row: ReviewRow) => row.revision ?? "";

const snooze = (row: ReviewRow, days: number) => update(row.ref, { review_by: snoozeDate(days), expected_revision: revisionOf(row) });

/** A dialog opened from a row. It keeps the row as it was when it opened: the queue may refresh, drop the row's duplicate pair
 *  or drop the row while it is open (Codex review of e30902f, R1 and S1). */
export type Opened =
  | { kind: "archive" | "resolve"; note: Seen }
  | { kind: "merge"; source: { ref: string; title: string }; target: { ref: string; title: string } };

const settled = (client: QueryClient, ref: string, operationId?: string) => {
  recordOperation(operationId);
  for (const key of [["review"], ["list"], ["note", ref], ["meta", ref]]) client.invalidateQueries({ queryKey: key });
};

function ReviewItem({ row, snooze: snoozing = true, onOpen }: { row: ReviewRow; snooze?: boolean; onOpen: (opened: Opened) => void }) {
  const client = useQueryClient();
  const done = (operationId?: string) => settled(client, row.ref, operationId);
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
  const note = (): Seen => ({ ref: row.ref, title: row.title, revision: revisionOf(row) });
  const stillTrue = <button key="still" disabled={busy} onClick={() => still.mutate()} title="Confirm this note still holds">Still true</button>;
  const first = {
    confirm: stillTrue,
    open: <button key="open" disabled={busy} onClick={open}>Open</button>,
    resolve: <button key="resolve" disabled={busy} onClick={() => onOpen({ kind: "resolve", note: note() })}>{primary.label}</button>,
    archive: <button key="archive" disabled={busy} onClick={() => onOpen({ kind: "archive", note: note() })}>{primary.label}</button>,
    merge: <button key="merge" disabled={busy || !row.pair} onClick={() => row.pair && onOpen({ kind: "merge", source: { ref: row.pair.ref, title: row.pair.title }, target: { ref: row.ref, title: row.title } })}
      title={`Merge “${row.pair?.title}” into this note`}>{primary.label}</button>,
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
        {primary.kind !== "archive" && <button disabled={busy} onClick={() => onOpen({ kind: "archive", note: note() })}>Archive…</button>}
      </div>
    </div>
  );
}

/** The open dialog, apart from the rows. */
export function OpenedDialog({ opened, onClose }: { opened: Opened; onClose: () => void }) {
  const client = useQueryClient();
  if (opened.kind === "merge") return <MergeComposer source={opened.source} target={opened.target} onClose={onClose} />;
  const archive = opened.kind === "archive";
  return (
    <SeenDialog first={[opened.note]} applyLabel={archive ? "Archive" : "Resolve"} danger={archive} onClose={onClose}
      onApplied={(r) => settled(client, opened.note.ref, r.operation_id)}
      run={([s]) => (archive ? archiveNote : resolveNote)(s.ref, s.revision)}
      text={([s]) => archive
        ? { title: `Archive “${s.title}”`, done: `Archived “${s.title}”.`, intro: <p>The note moves to the archive. Undoing this change restores it.</p> }
        : { title: `Resolve “${s.title}”`, done: `Resolved “${s.title}”.`, intro: <p>The note is marked resolved and moves to the archive.</p> }} />
  );
}

/** Notes due for re-confirmation. Snoozing sets a review date and does not confirm, so a caller listing unconfirmed notes turns it off.
 *  A caller that may unmount the queue while a dialog is open (the Inbox's selected card) passes `onOpen` and shows
 *  `OpenedDialog` itself (Codex re-review, N03). */
export function ReviewQueue({ rows, snooze, onOpen }: { rows: ReviewRow[]; snooze?: boolean; onOpen?: (opened: Opened) => void }) {
  const [opened, setOpened] = useState<Opened | null>(null);
  const dialog = opened && <OpenedDialog opened={opened} onClose={() => setOpened(null)} />;
  // One shape whether or not rows are left, so an open dialog stays mounted when the last row goes.
  return (
    <>
      {rows.length ? <div className="work-list">{rows.map((r) => <ReviewItem key={r.ref} row={r} snooze={snooze} onOpen={onOpen ?? setOpened} />)}</div>
        : <p className="muted pad">Nothing is due for review</p>}
      {dialog}
    </>
  );
}
