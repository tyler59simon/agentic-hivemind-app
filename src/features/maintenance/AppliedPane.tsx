// One change maintenance made in the last week, as the Inbox shows it: what it did, why, and the two ways to answer. Undo reverses
// the change (a merge or delete opens its plan first); Looks right removes it from the Inbox on this computer.
import { useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { isPlan, undo } from "../../lib/lm";
import { useApp } from "../../store";
import { ArrowLink } from "../../ui/Page";
import { toast } from "../../ui/toast";
import { explain, finishDirect } from "../plans/DirectDialog";
import { PlanDialog } from "../plans/PlanDialog";
import { NoteLink } from "../preview/NoteLink";
import { reasonText, resultText, type AppliedItem } from "./maintenance";
import { useSeen } from "./seen";

export function AppliedPane({ item, title }: { item: AppliedItem; title?: string }) {
  const client = useQueryClient();
  const go = useApp((s) => s.go);
  const markSeen = useSeen((s) => s.markSeen);
  const [dialog, setDialog] = useState<ReactNode>(null);
  const [busy, setBusy] = useState(false);
  const d = item.decision;
  const what = resultText(d);
  const reason = reasonText(d);
  const settle = () => markSeen(item.key, item.at);
  const reverse = () => {
    setBusy(true);
    undo(item.key)
      .then(async (r) => {
        if (isPlan(r)) {
          setDialog(
            <PlanDialog title={`Undo: ${what.toLowerCase()}`} applyLabel="Undo" intro={<p>This reverses the change below. It is refused if the note was edited again afterwards.</p>}
              make={() => Promise.resolve(r)} onApplied={settle} onClose={() => setDialog(null)} />,
          );
          return;
        }
        await finishDirect(client, r);
        toast(`Undid: ${what.toLowerCase()}.`);
        settle();
      })
      .catch((e) => toast(explain(e), "error"))
      .finally(() => setBusy(false));
  };
  return (
    <>
      <h2><NoteLink row={{ ref: item.ref, title: title ?? item.ref }} /></h2>
      <p>Maintenance {what.toLowerCase()} this note.</p>
      {reason && <p className="muted">{reason}</p>}
      <p className="muted small">The run started {new Date(item.run.attempted_at).toLocaleString()}. Undo reverses the change. Looks right takes it out of the Inbox.</p>
      <div className="work-actions">
        <button className="primary" onClick={settle} disabled={busy}>Looks right</button>
        <button onClick={reverse} disabled={busy}>{busy ? "Undoing…" : "Undo"}</button>
        <ArrowLink onClick={() => go({ page: "maintenance" })}>Open Maintenance</ArrowLink>
      </div>
      {dialog}
    </>
  );
}
