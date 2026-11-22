// After a page or folder was renamed or moved: the pages whose links reach it, listed first, and one button to rewrite
// them (NS-4A). A page changed meanwhile is skipped and listed, never written over.
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { refresh, unsavedUnder } from "../../documents/store";
import { INDEX_KEY } from "../../lib/noteindex";
import { readFile, saveFile, pageTitle } from "../../lib/notebooks";
import { useNotebookTitle } from "../notes/notebookTitle";
import { Modal } from "../../ui/Modal";
import { toast } from "../../ui/toast";
import { useRewritePlan } from "./plan";
import { applyPlan, type Applied, type Plan } from "./rewrite";

const plural = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

function Where({ notebook, path }: { notebook: string; path: string }) {
  const title = useNotebookTitle(notebook, true);
  return <>{pageTitle(path)} <span className="muted small">{title ? `${title} · ` : ""}{path}</span></>;
}

function Result({ result, onClose }: { result: Applied; onClose: () => void }) {
  return (
    <Modal title="Links updated" onClose={onClose}>
      <p>{plural(result.updated.length, "page was", "pages were")} updated.</p>
      {result.skipped.length > 0 && (
        <>
          <p>{plural(result.skipped.length, "page was", "pages were")} left as {result.skipped.length === 1 ? "it was" : "they were"}:</p>
          <ul className="plain-list">
            {result.skipped.map((s) => <li key={`${s.page.notebook}:${s.page.path}`}><Where notebook={s.page.notebook} path={s.page.path} /> <span className="muted small">{s.why}</span></li>)}
          </ul>
        </>
      )}
      <div className="actions"><button className="primary" onClick={onClose}>Done</button></div>
    </Modal>
  );
}

function Ask({ plan, onClose, onDone }: { plan: Plan; onClose: () => void; onDone: (result: Applied) => void }) {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const links = plan.pages.reduce((n, p) => n + p.links, 0);
  const run = async () => {
    setBusy(true);
    try {
      const result = await applyPlan(plan, {
        read: readFile, save: saveFile,
        unsaved: (notebook, path) => unsavedUnder(notebook, path).length > 0,
        written: (notebook, path) => { void refresh(notebook, [path]); },
      });
      client.invalidateQueries({ queryKey: [INDEX_KEY] });
      onDone(result);
    } catch (e) {
      toast(String(e instanceof Error ? e.message : e), "error");
      setBusy(false);
    }
  };
  return (
    <Modal title="Update links?" onClose={onClose} locked={busy} wide>
      {plan.pages.length > 0 && (
        <>
          <p><b>{plural(links, "link", "links")}</b> in {plural(plan.pages.length, "page", "pages")} point to what you moved. Update them so they keep working?</p>
          <ul className="plain-list">
            {plan.pages.map((p) => <li key={`${p.notebook}:${p.path}`}><Where notebook={p.notebook} path={p.path} /> <span className="muted small">{plural(p.links, "link", "links")}</span></li>)}
          </ul>
        </>
      )}
      {plan.stuck.length > 0 && (
        <>
          <p className="muted">Hivemind cannot rewrite {plural(plan.stuck.length, "link", "links")}:</p>
          <ul className="plain-list">
            {plan.stuck.map((s, i) => <li key={i}><Where notebook={s.notebook} path={s.path} /> <span className="muted small">{s.raw}: {s.why}</span></li>)}
          </ul>
        </>
      )}
      <div className="actions">
        <button onClick={onClose} disabled={busy}>{plan.pages.length ? "Not now" : "Close"}</button>
        {plan.pages.length > 0 && <button className="primary" onClick={run} disabled={busy}>{busy ? "Updating…" : "Update links"}</button>}
      </div>
    </Modal>
  );
}

/** Shows the plan `movePath` left, and what came of it. Mounted once on the Notes page. */
export function RewriteDialog() {
  const plan = useRewritePlan((s) => s.plan);
  const [result, setResult] = useState<Applied | null>(null);
  const close = () => { useRewritePlan.setState({ plan: null }); setResult(null); };
  if (result) return <Result result={result} onClose={close} />;
  return plan ? <Ask plan={plan} onClose={close} onDone={setResult} /> : null;
}
