import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useRef, useState, type ReactNode } from "react";
import { classify } from "../../lib/errors";
import { meta, undo, type Receipt } from "../../lib/lm";
import { recordOperation } from "../../lib/oplog";
import { refreshStore } from "../../lib/refresh";
import { reloadAfterStale, STALE_MESSAGE, STALE_UNREAD, writeFailure } from "../../lib/stale";
import { Modal } from "../../ui/Modal";
import { toast } from "../../ui/toast";

/** What follows every direct write: log the operation, show warnings, refresh. */
export async function finishDirect(client: QueryClient, receipt: Receipt) {
  recordOperation(receipt.operation_id);
  receipt.warnings?.forEach((w) => toast(w, "warn"));
  await refreshStore(client);
}

/** A toast with Undo for a direct write. */
export function undoToast(client: QueryClient, text: string, receipt: Receipt) {
  toast(text, "info", {
    label: "Undo",
    run: () => undo(receipt.operation_id)
      .then(async (r) => {
        await finishDirect(client, r);
        toast("Undone.");
      })
      .catch((e) => toast(explain(e), "error")),
  });
}

export function explain(e: unknown): string {
  const p = classify(e);
  if (p.kind === "undo-conflict") return "This change can't be undone automatically: it was edited again afterwards. Undo the later change first, or edit it by hand.";
  return p.message;
}

/** Runs a direct write for a form: `go` reports busy and error state, refreshes the store and calls `onDone` with the receipt.
 *  A write refused because the note changed since it was read reads the store again (and `reread`) and says so; the user may
 *  then repeat it. While that read runs (`reading`), and after it failed (`unread`, with `retryRead`), the form waits: it
 *  must not write again before the note on screen is the one read now. Nothing is being written meanwhile, so the form can
 *  be closed (Codex re-review, N04). */
export function useDirect() {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [unread, setUnread] = useState(false);
  const lastReread = useRef<(() => Promise<unknown>) | undefined>(undefined);
  const recover = async (failure: unknown, reread?: () => Promise<unknown>) => {
    setReading(true);
    const message = failure !== undefined ? await writeFailure(client, failure, reread)
      : (await reloadAfterStale(client, reread)) ? STALE_MESSAGE : STALE_UNREAD;
    setError(message);
    setUnread(message === STALE_UNREAD);
    setReading(false);
  };
  const go = async (write: () => Promise<Receipt>, onDone?: (receipt: Receipt) => void, reread?: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    setUnread(false);
    lastReread.current = reread;
    try {
      const receipt = await write();
      await finishDirect(client, receipt);
      onDone?.(receipt); // runs even when the refresh unmounted the form: the toast and the parent's cleanup still belong to this write
    } catch (e) {
      setBusy(false);
      if (classify(e).kind === "stale") await recover(e, reread);
      else setError(explain(e));
    }
  };
  const retryRead = () => recover(undefined, lastReread.current);
  return { busy, error, go, reading, unread, retryRead };
}

/** A short confirm for a direct write: the write runs when the user says so, and the toast offers Undo. `run` is called on
 *  each click. After a stale refusal the button stays disabled until `reread` has read the note again; when that fails, Retry
 *  read tries again. */
export function DirectDialog({ title, intro, run, reread, applyLabel, danger, done, onApplied, onClose }: {
  title: string; intro: ReactNode; run: () => Promise<Receipt>; reread?: () => Promise<unknown>; applyLabel: string; danger?: boolean;
  /** The toast after the write, with Undo. */
  done?: string; onApplied?: (receipt: Receipt) => void; onClose: () => void;
}) {
  const client = useQueryClient();
  const { busy, error, go, reading, unread, retryRead } = useDirect();
  const apply = () => go(run, (receipt) => {
    if (done) undoToast(client, done, receipt);
    onApplied?.(receipt);
    onClose();
  }, reread);
  return (
    <Modal title={title} onClose={onClose} locked={busy}>
      {intro}
      <p className="muted small">Living Memory journals the change, so it can be undone from the toast or from Activity.</p>
      {error && <p className="error">{error}</p>}
      <div className="actions">
        <button onClick={onClose} disabled={busy}>Cancel</button>
        {unread && <button onClick={() => void retryRead()} disabled={reading}>Retry read</button>}
        <button autoFocus className={danger ? "danger" : "primary"} disabled={busy || reading || unread} onClick={apply}>{busy ? "Working…" : reading ? "Reading…" : applyLabel}</button>
      </div>
    </Modal>
  );
}

/** A note as a dialog shows it. */
export interface Seen { ref: string; title: string; revision: string }

/** A confirm for a write to the notes in `first`, sent with the revisions the dialog shows. A background refresh does not
 *  change them, so a note that changed while the dialog was open is refused as stale instead of written unseen; the notes
 *  are then read again and shown, and the user confirms again (Codex review of e30902f, R1). */
export function SeenDialog({ first, text, run, ...rest }: {
  first: Seen[];
  /** The dialog's wording for the notes as shown. */
  text: (seen: Seen[]) => { title: string; intro: ReactNode; done?: string };
  run: (seen: Seen[]) => Promise<Receipt>;
  applyLabel: string; danger?: boolean; onApplied?: (receipt: Receipt) => void; onClose: () => void;
}) {
  const [seen, setSeen] = useState(first);
  const reread = () => Promise.all(seen.map((s) => meta(s.ref)))
    .then((fresh) => setSeen(fresh.map((m, i) => ({ ref: seen[i].ref, title: m.title, revision: m.revision }))));
  return <DirectDialog {...text(seen)} {...rest} run={() => run(seen)} reread={reread} />;
}
