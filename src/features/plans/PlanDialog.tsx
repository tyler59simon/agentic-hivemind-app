import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import { classify } from "../../lib/errors";
import { applyPlan, inspectPlan, type Plan, type PlanInspection } from "../../lib/lm";
import { recordOperation } from "../../lib/oplog";
import { refreshStore } from "../../lib/refresh";
import { Modal } from "../../ui/Modal";
import { toast } from "../../ui/toast";

/** A unified diff with added and removed lines coloured. */
export function DiffView({ text }: { text: string }) {
  return (
    <pre className="diff">
      {text.split("\n").map((line, i) => {
        const kind = line.startsWith("+++") || line.startsWith("---") ? "meta"
          : line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : line.startsWith("@@") ? "hunk" : "";
        return <span key={i} className={`diff-line ${kind}`}>{line || " "}{"\n"}</span>;
      })}
    </pre>
  );
}

const fileLabel = (path: string) => path.split("/").pop()?.replace(/\.md$/, "") ?? path;

/** Make a plan, show exactly what it will change, and apply it only when the user says so.
 *  A dismissed plan stays unapplied in the store's .plans folder (LM has no command to discard one). */
export function PlanDialog({ title, intro, make, applyLabel = "Apply", danger, onApplied, onClose }: {
  title: string; intro?: ReactNode; make: () => Promise<Plan>; applyLabel?: string; danger?: boolean;
  onApplied?: (operationId: string) => void; onClose: () => void;
}) {
  const client = useQueryClient();
  const [plan, setPlan] = useState<PlanInspection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    let live = true;
    make().then((p) => inspectPlan(p.plan_id)).then((p) => { if (live) setPlan(p); }).catch((e) => live && setError(explain(e)));
    return () => { live = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const apply = async () => {
    if (!plan) return;
    setApplying(true);
    try {
      const done = await applyPlan(plan);
      recordOperation(done.operation_id);
      done.warnings?.forEach((w) => toast(w, "warn"));
      await refreshStore(client);
      onApplied?.(done.operation_id);
      onClose();
    } catch (e) {
      setError(explain(e));
      setApplying(false);
    }
  };

  return (
    <Modal title={title} onClose={onClose} wide locked={applying}>
      {intro}
      {!plan && !error && <p className="muted">Preparing the plan…</p>}
      {error && <p className="error">{error}</p>}
      {plan && (
        <>
          <p className="muted">
            {plan.effects.length} file{plan.effects.length === 1 ? "" : "s"} will change. Living Memory journals the change, so it can be undone from History.
          </p>
          <div className="effects">
            {plan.effects.map((e) => (
              <details key={e.path} open={plan.effects.length === 1}>
                <summary><span className={`badge ${e.action === "delete" ? "status-archived" : ""}`}>{e.action}</span> {fileLabel(e.path)}</summary>
                <DiffView text={e.diff} />
                {e.truncated && <p className="muted small">The diff is cut off at 16,000 characters.</p>}
              </details>
            ))}
          </div>
        </>
      )}
      <div className="actions">
        <button onClick={onClose} disabled={applying}>Cancel</button>
        <button className={danger ? "danger" : "primary"} disabled={!plan || applying} onClick={apply}>{applying ? "Applying…" : applyLabel}</button>
      </div>
    </Modal>
  );
}

function explain(e: unknown): string {
  const p = classify(e);
  if (p.kind === "undo-conflict") return "This change can't be undone automatically: the note was edited again afterwards. Undo the later change first, or edit the note by hand.";
  if (/^stale plan|^Stale revision/.test(p.message)) return "The note changed while this plan was open. Close this and try again.";
  return p.message;
}
