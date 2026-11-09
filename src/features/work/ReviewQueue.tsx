import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { confirm, LmError, meta, plan, update, type ReviewRow } from "../../lib/lm";
import { classify } from "../../lib/errors";
import { recordOperation } from "../../lib/oplog";
import { shortDate } from "../../lib/text";
import { toast } from "../../ui/toast";
import { useWorkspace } from "../../workspace/store";
import { PlanDialog } from "../plans/PlanDialog";
import { HoverPreview } from "../preview/HoverPreview";
import { snoozeDate } from "./work";

const SNOOZES = [7, 30, 90];

async function snooze(row: ReviewRow, days: number) {
  const review_by = snoozeDate(days);
  const send = async (rev?: string) => update(row.ref, { review_by, expected_revision: rev ?? (await meta(row.ref)).revision });
  try {
    return await send(row.revision);
  } catch (e) {
    if (e instanceof LmError && e.stale) return send();
    throw e;
  }
}

function ReviewItem({ row }: { row: ReviewRow }) {
  const client = useQueryClient();
  const [archiving, setArchiving] = useState(false);
  const done = (operationId?: string) => {
    recordOperation(operationId);
    for (const key of [["review"], ["list"], ["note", row.ref]]) client.invalidateQueries({ queryKey: key });
  };
  const still = useMutation({
    mutationFn: () => confirm(row.ref),
    onSuccess: (r) => done(r.operation_id),
    onError: (e) => toast(classify(e).message, "error"),
  });
  const snoozed = useMutation({
    mutationFn: (days: number) => snooze(row, days),
    onSuccess: (r) => done(r.operation_id),
    onError: (e) => toast(classify(e).message, "error"),
  });
  const busy = still.isPending || snoozed.isPending;
  return (
    <div className="work-group">
      <div className="work-head">
        <span className={`badge type-${row.type}`}>{row.type}</span>
        <HoverPreview refId={row.ref}>
          <button className="link-row" onClick={() => useWorkspace.getState().openNote(row.ref, { title: row.title })}>{row.title}</button>
        </HoverPreview>
      </div>
      <div className="muted small">
        Updated {shortDate(row.updated)}{row.review_by && <> · review by {shortDate(row.review_by)}</>}
      </div>
      <div className="work-actions">
        <button disabled={busy} onClick={() => still.mutate()} title="Confirm this note still holds">Still true</button>
        {SNOOZES.map((d) => <button key={d} disabled={busy} onClick={() => snoozed.mutate(d)} title={`Review again in ${d} days`}>Snooze {d}d</button>)}
        <button disabled={busy} onClick={() => setArchiving(true)}>Archive…</button>
      </div>
      {archiving && (
        <PlanDialog title={`Archive “${row.title}”`} make={() => plan("archive", row.ref)} applyLabel="Archive" danger
          onApplied={done} onClose={() => setArchiving(false)}
          intro={<p>The note moves to the archive. Undoing this change restores it.</p>} />
      )}
    </div>
  );
}

/** Notes due for re-confirmation. */
export function ReviewQueue({ rows }: { rows: ReviewRow[] }) {
  if (!rows.length) return <p className="muted pad">Nothing is due for review</p>;
  return <div className="work-list">{rows.map((r) => <ReviewItem key={r.ref} row={r} />)}</div>;
}
