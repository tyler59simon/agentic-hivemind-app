// One change maintenance made in the last week, as the Inbox shows it: what it did, why, and the two ways to answer. Undo reverses
// the change; Looks right removes it from the Inbox on this computer.
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { undo } from "../../lib/lm";
import { openSettings } from "../../store";
import { ArrowLink } from "../../ui/Page";
import { toast } from "../../ui/toast";
import { explain, finishDirect } from "../plans/DirectDialog";
import { NoteLink } from "../preview/NoteLink";
import { reasonText, resultText, type AppliedItem } from "./maintenance";
import { useSeen } from "./seen";

export function AppliedPane({ item, title }: { item: AppliedItem; title?: string }) {
  const client = useQueryClient();
  const markSeen = useSeen((s) => s.markSeen);
  const [busy, setBusy] = useState(false);
  const d = item.decision;
  const what = resultText(d);
  const reason = reasonText(d);
  const settle = () => markSeen(item.key, item.at);
  const reverse = () => {
    setBusy(true);
    undo(item.key)
      .then(async (r) => {
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
        <ArrowLink onClick={() => openSettings("maintenance")}>Open Maintenance</ArrowLink>
      </div>
    </>
  );
}
