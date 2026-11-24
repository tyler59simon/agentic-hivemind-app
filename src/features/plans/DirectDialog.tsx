import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { classify } from "../../lib/errors";
import { isPlan, undo, type Receipt } from "../../lib/lm";
import { recordOperation } from "../../lib/oplog";
import { refreshStore } from "../../lib/refresh";
import { Modal } from "../../ui/Modal";
import { toast } from "../../ui/toast";

/** What follows every direct write: log the operation, show warnings, refresh. */
export async function finishDirect(client: QueryClient, receipt: Receipt) {
  recordOperation(receipt.operation_id);
  receipt.warnings?.forEach((w) => toast(w, "warn"));
  await refreshStore(client);
}

/** A toast with Undo for a direct write. A kept plan kind would return a plan, which a toast cannot review: that case points to Activity. */
export function undoToast(client: QueryClient, text: string, receipt: Receipt) {
  toast(text, "info", {
    label: "Undo",
    run: () => undo(receipt.operation_id)
      .then(async (r) => {
        if (isPlan(r)) { toast("This change needs a reviewed undo. Open it in Activity.", "warn"); return; }
        await finishDirect(client, r);
        toast("Undone.");
      })
      .catch((e) => toast(explain(e), "error")),
  });
}

export function explain(e: unknown): string {
  const p = classify(e);
  if (p.kind === "undo-conflict") return "This change can't be undone automatically: it was edited again afterwards. Undo the later change first, or edit it by hand.";
  if (/^stale plan|^Stale revision/.test(p.message)) return "The note changed in the meantime. Close this and try again.";
  return p.message;
}

/** Runs a direct write for a form: `go` reports busy and error state, refreshes the store and calls `onDone` with the receipt. */
export function useDirect() {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = async (write: () => Promise<Receipt>, onDone?: (receipt: Receipt) => void) => {
    setBusy(true);
    setError(null);
    try {
      const receipt = await write();
      await finishDirect(client, receipt);
      onDone?.(receipt); // runs even when the refresh unmounted the form: the toast and the parent's cleanup still belong to this write
    } catch (e) {
      setError(explain(e));
      setBusy(false);
    }
  };
  return { busy, error, go };
}

/** A short confirm for a direct write (no plan to review): the write runs when the user says so, and the toast offers Undo. */
export function DirectDialog({ title, intro, run, applyLabel, danger, done, onApplied, onClose }: {
  title: string; intro: ReactNode; run: () => Promise<Receipt>; applyLabel: string; danger?: boolean;
  /** The toast after the write, with Undo. */
  done?: string; onApplied?: (receipt: Receipt) => void; onClose: () => void;
}) {
  const client = useQueryClient();
  const { busy, error, go } = useDirect();
  const apply = () => go(run, (receipt) => {
    if (done) undoToast(client, done, receipt);
    onApplied?.(receipt);
    onClose();
  });
  return (
    <Modal title={title} onClose={onClose} locked={busy}>
      {intro}
      <p className="muted small">Living Memory journals the change, so it can be undone from the toast or from Activity.</p>
      {error && <p className="error">{error}</p>}
      <div className="actions">
        <button onClick={onClose} disabled={busy}>Cancel</button>
        <button autoFocus className={danger ? "danger" : "primary"} disabled={busy} onClick={apply}>{busy ? "Working…" : applyLabel}</button>
      </div>
    </Modal>
  );
}
