// Today: what needs the leader now (overdue and due commitments, near milestones, projects off track), the capture inbox,
// the latest briefing, and a box to ask the assistant.
import { LoaderCircle, MessageSquare } from "lucide-react";
import { useState } from "react";
import { classify } from "../../lib/errors";
import type { Briefing } from "../../lib/executive";
import type { Project } from "../../lib/lm";
import { openExecutive, useApp } from "../../store";
import { Section, Split } from "../../ui/Page";
import { toast } from "../../ui/toast";
import { useShownEngines } from "../agents/engines";
import { ask, SUGGESTIONS } from "./AgentTab";
import { BRIEFING_LABEL } from "./BriefingsTab";
import { CommitmentList } from "./PortfolioTab";
import { HealthChip } from "./parts";
import type { Attention } from "./portfolio";
import type { CommitmentRow } from "./commitments";
import { useInbox, useRecords, useRecordsError } from "./useExecutive";

function AskBox({ project }: { project?: Project }) {
  const engines = useShownEngines();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const go = async (prompt: string) => {
    if (!prompt.trim() || !engines.first) return;
    setBusy(true);
    try { await ask(project, prompt, engines.first); }
    catch (e) { toast(String(e), "error"); }
    finally { setBusy(false); }
  };
  return (
    <div className="exec-ask-box">
      <input value={text} placeholder={`Ask about ${project?.name ?? "your projects"}`} disabled={busy} onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") go(text); }} />
      <button className="primary" onClick={() => go(text)} disabled={busy || !text.trim()} aria-label="Ask">
        {busy ? <LoaderCircle className="spin" size="1em" aria-hidden /> : <MessageSquare size="1em" aria-hidden />}
      </button>
      <div className="exec-chips">{SUGGESTIONS.slice(0, 2).map((s) => <button key={s} className="chip" disabled={busy} onClick={() => go(s)}>{s}</button>)}</div>
    </div>
  );
}

export function TodayTab({ project, projects, attention, crossProject, loading, error }: {
  project?: Project; projects: Project[]; attention: Attention; crossProject: CommitmentRow[]; loading: boolean; error: unknown;
}) {
  const setProject = useApp((s) => s.setProject);
  const inbox = useInbox();
  const briefings = useRecords<Briefing>("briefing");
  const latest = (briefings.data ?? []).find((b) => !project || b.project === project.slug);
  const crossOverdue = crossProject.filter((c) => c.timing === "overdue");
  const overdue = [...attention.overdue, ...crossOverdue];
  const soon = [...attention.dueSoon, ...crossProject.filter((c) => c.timing === "soon")];
  const failed = useRecordsError();
  const quiet = !overdue.length && !soon.length && !attention.milestones.length && !attention.atRisk.length;
  return (
    <Split rail={
      <>
        <Section title="Capture inbox" count={inbox.count} loading={inbox.batches.isLoading} error={inbox.batches.error} empty={inbox.waiting.length ? undefined : "Nothing waiting. Captures and finished conversations land here for review."}>
          <ul className="item-list">
            {inbox.waiting.map((b) => {
              const n = b.items.filter((i) => i.state === "pending").length;
              return (
                <li key={b.id}>
                  <button className="item-row" onClick={() => openExecutive({ capture: b.id })}>
                    <span className="grow">{b.source.label}<br /><span className="muted small">{n} to review · {new Date(b.created).toLocaleString()}</span></span>
                  </button>
                </li>
              );
            })}
          </ul>
        </Section>
        <Section title="Latest briefing">
          {latest ? (
            <button className="item-row" onClick={() => openExecutive({ tab: "briefings", briefing: latest.id })}>
              <span className="grow">{latest.title}<br /><span className="muted small">{BRIEFING_LABEL[latest.kind]} · {new Date(latest.created).toLocaleDateString()}</span></span>
            </button>
          ) : briefings.error ? <p className="error small">{classify(briefings.error).message}</p> : <p className="muted small">None yet. <button className="link" onClick={() => openExecutive({ tab: "briefings" })}>Write one</button></p>}
        </Section>
      </>
    }>
      <AskBox project={project} />
      <Section title="Needs attention" loading={loading} error={error}>
        {failed ? <p className="error small">Milestones or project health did not load, so they are missing here: {classify(failed).message}</p> : null}
        {quiet && !failed && <p className="muted">Nothing is overdue, due this week or off track{projects.length ? "" : ". Add a project from Overview to start"}.</p>}
        {overdue.length > 0 && <><h3 className="exec-sub">Overdue commitments</h3><CommitmentList items={overdue} /></>}
        {soon.length > 0 && <><h3 className="exec-sub">Due in the next 7 days</h3><CommitmentList items={soon} /></>}
        {attention.milestones.length > 0 && (
          <>
            <h3 className="exec-sub">Milestones in the next 14 days</h3>
            <ul className="exec-list">
              {attention.milestones.map((m) => (
                <li key={m.id} className="exec-row"><span className="grow">{m.title}<span className="muted small"> · {m.projectName}</span></span><span className={`status-chip ${m.due < new Date().toISOString().slice(0, 10) ? "bad" : "warn"}`}>{m.due}</span></li>
              ))}
            </ul>
          </>
        )}
        {attention.atRisk.length > 0 && (
          <>
            <h3 className="exec-sub">Projects at risk</h3>
            <ul className="exec-list">
              {attention.atRisk.map((r) => (
                <li key={r.project.slug} className="exec-row">
                  <button className="link grow" onClick={() => { setProject(r.project.slug); openExecutive({ tab: "portfolio" }); }}>{r.project.name}</button>
                  <span className="muted small">{r.health.set ? r.health.note || r.health.suggestion.reasons[0] : r.health.suggestion.reasons.join("; ")}</span>
                  <HealthChip status={r.health.status} suggested={!r.health.set} />
                </li>
              ))}
            </ul>
          </>
        )}
      </Section>
    </Split>
  );
}
