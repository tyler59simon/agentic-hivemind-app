// Drift: how far a system's Architecture Suite output is from its code, worked out by the Suite's own command line
// (diff, check, verify) and git. Checking runs the Suite (a few seconds); the last result is kept.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { architectureDrift, architectureRulesSet, driftQuery } from "../../lib/architecture";
import { classify } from "../../lib/errors";
import { getSettings } from "../../lib/lm";
import { Section } from "../../ui/Page";
import { toast } from "../../ui/toast";
import { changeCounts, changeText, findingText } from "./drift";

const SHOWN = 12;

export function DriftPanel({ slug }: { slug: string }) {
  const client = useQueryClient();
  const drift = useQuery(driftQuery(slug));
  const settings = useQuery({ queryKey: ["settings"], queryFn: getSettings });
  const saved = settings.data?.architecture_rules?.[slug] ?? "";
  const [rules, setRules] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const d = drift.data;
  const run = () => {
    setBusy(true);
    architectureDrift(slug, true).then((r) => { client.setQueryData(driftQuery(slug).queryKey, r); toast(r?.summary ?? "Checked"); },
      (e) => toast(classify(e).message, "error")).finally(() => setBusy(false));
  };
  const saveRules = (path: string | null) => architectureRulesSet(slug, path).then(() => {
    setRules(null);
    client.invalidateQueries({ queryKey: ["settings"] });
    toast(path ? "Rules file saved; check again to apply it" : "Rules file removed");
  }, (e) => toast(classify(e).message, "error"));
  return (
    <Section title="Drift" loading={drift.isLoading} error={drift.error}
      actions={<button className="text" disabled={busy} onClick={run} title="Run the Architecture Suite's diff, check and verify">{busy ? "Checking…" : "Check now"}</button>}>
      {!d ? <p className="muted small">Not checked yet. Check now compares the output with the repository, the previous model and the rules file.</p> : (
        <>
          <p className={d.attention ? "warn-text" : "muted"}>{d.summary}</p>
          <p className="muted small">Checked {new Date(d.at).toLocaleString()}</p>
          {!!d.edited.length && (
            <details><summary className="small">Output files changed outside the Suite ({d.edited.length})</summary>
              <ul className="plain-list small">{d.edited.slice(0, SHOWN).map((f) => <li key={f.path}><code>{f.path}</code> {f.state === "missing" ? "missing" : "edited"}</li>)}</ul>
            </details>
          )}
          {d.changes && (
            <details><summary className="small">Since the previous model{d.baselineAt ? ` (${new Date(d.baselineAt).toLocaleDateString()})` : ""}: {changeCounts(d.changes)}</summary>
              <ul className="plain-list small">{d.changes.slice(0, SHOWN).map((c) => <li key={`${c.section}-${c.id}`}>{changeText(c)}</li>)}</ul>
              {d.changes.length > SHOWN && <p className="muted small">and {d.changes.length - SHOWN} more</p>}
            </details>
          )}
          {d.findings && (
            d.findings.length
              ? <details open><summary className="small">Rule findings ({d.findings.length})</summary>
                  <ul className="plain-list small">{d.findings.slice(0, SHOWN).map((f, i) => <li key={i} className={f.severity === "error" && !f.existing ? "error" : ""}>{findingText(f)}</li>)}</ul>
                </details>
              : <p className="muted small">The model follows every rule.</p>
          )}
          {d.layout && <p className="muted small">Diagram layout: {d.layout.status}, {d.layout.findings} finding{d.layout.findings === 1 ? "" : "s"} across {d.layout.diagrams} diagram{d.layout.diagrams === 1 ? "" : "s"}.</p>}
          {d.problems.map((p) => <p key={p} className="error small">{p}</p>)}
        </>
      )}
      <label className="field small">
        <span>Rules file (architecture-rules/v1)</span>
        <input value={rules ?? saved} placeholder="No rules file" onChange={(e) => setRules(e.target.value)} />
      </label>
      {rules !== null && rules !== saved && (
        <div className="work-actions">
          <button onClick={() => saveRules(rules.trim() || null)}>Save</button>
          <button className="ghost" onClick={() => setRules(null)}>Discard</button>
        </div>
      )}
    </Section>
  );
}
