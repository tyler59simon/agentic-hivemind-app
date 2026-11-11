import { useQuery } from "@tanstack/react-query";
import { ArrowRight, CircleQuestionMark, FileText, Layers, Plus, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { useSystemsEnabled } from "../../lib/connection";
import { classify } from "../../lib/errors";
import { sections } from "../../lib/note";
import { openChange, openSession, openSystem, useApp } from "../../store";
import { Markdown } from "../../ui/Markdown";
import { ArrowLink, dayMonth, PageHeader, Row, Section, Tabs } from "../../ui/Page";
import { useWorkspace } from "../../workspace/store";
import { isEnded, waitingForReview } from "../agents/session";
import { useCurrentProject, useProject } from "../projects/useProject";
import { systemsQuery } from "../systems/useSystem";
import { noteQuery } from "../viewer/NoteView";
import { briefState, displayId, engineName, metaLines, unadopted, type ChangeView } from "./changes";
import { useChangeIntent } from "./intent";
import { startSessionFor, useChangeViews } from "./useChanges";

type Shown = "active" | "completed" | "all";
const openNote = (ref: string, title: string, split = false) => useWorkspace.getState().openNote(ref, { title, split });

/** The selected change: its outcome, its latest session and the notes connected to it. */
function Rail({ view }: { view: ChangeView }) {
  const { change, latest } = view;
  const brief = briefState(change);
  const note = useQuery({ ...noteQuery(change.brief), enabled: brief !== "missing" });
  const systemsOn = useSystemsEnabled();
  const systems = useQuery({ ...systemsQuery(), enabled: systemsOn && !!change.system });
  const system = systems.data?.systems.find((s) => s.slug === change.system);
  const outcome = note.data ? sections(note.data.body).summary : undefined;
  const context = [
    ...(change.system ? [<Row key="system" icon={<Layers size="1.3em" aria-hidden />} meta="Architecture" onClick={() => openSystem(change.system!)}>{change.element ?? system?.name ?? change.system}</Row>] : []),
    ...view.decisions.map((n) => <Row key={n.ref} icon={<FileText size="1.3em" aria-hidden />} meta="Decision" onClick={(e) => openNote(n.ref, n.title, e.ctrlKey || e.metaKey)}>{n.title}</Row>),
    ...view.questions.map((n) => <Row key={n.ref} icon={<CircleQuestionMark size="1.3em" aria-hidden />} meta="Open question" onClick={(e) => openNote(n.ref, n.title, e.ctrlKey || e.metaKey)}>{n.title}</Row>),
  ].slice(0, 6);
  const chip = latest && (waitingForReview(latest) ? { label: "Waiting for review", cls: "status-chip waiting" }
    : latest.status === "idle" ? { label: "ready", cls: "status-chip cap active" }
    : { label: latest.status, cls: `status-chip cap ${latest.status === "ended" ? "" : latest.status}` });
  return (
    <>
      <Section>
        <h2 className="detail-title">{change.title}</h2>
        {brief === "missing" ? <p className="muted">The brief note of this change is missing.</p> : (
          <>
            {outcome && <div className="markdown"><Markdown>{outcome}</Markdown></div>}
            {brief === "retired" && <p className="muted">The brief of this change was {change.brief_status}.</p>}
          </>
        )}
      </Section>
      <Section title="Linked session">
        {latest ? (
          <div className="session-card">
            <strong>{engineName(latest.adapter)}</strong>
            <span className="session-title">{latest.title}</span>
            {chip && <span className={chip.cls}>{chip.label}</span>}
            <button className="outline" onClick={() => openSession(latest.id)}>{isEnded(latest) ? "Open session" : "Resume session"}<ArrowRight size="1.1em" aria-hidden /></button>
          </div>
        ) : (
          <>
            <p className="muted">No agent session yet.</p>
            {change.status === "active" && brief === "ok" && <button className="outline" onClick={() => startSessionFor(view)}>Start agent session</button>}
          </>
        )}
      </Section>
      <Section title="Connected context" empty={!context.length ? "Nothing is connected yet. Link a note to this change's brief to see it here." : undefined}>{context}</Section>
      <ArrowLink onClick={() => openChange(change.id)}>Open change</ArrowLink>
    </>
  );
}

/** Changes: the registry's numbered changes with their stage, session and context. */
export function ChangesList() {
  const { project } = useCurrentProject();
  const { views, query } = useChangeViews();
  const mine = useProject(project?.slug);
  const picked = useApp((s) => (s.route.page === "changes" ? s.route.id : undefined));
  const go = useApp((s) => s.go);
  const [shown, setShown] = useState<Shown>("active");
  const [search, setSearch] = useState("");

  const scoped = useMemo(() => views.filter((v) => !project || v.change.project === project.slug).sort((a, b) => b.change.id - a.change.id), [views, project]);
  const active = scoped.filter((v) => v.change.status === "active");
  const words = search.trim().toLowerCase();
  const rows = (shown === "active" ? active : shown === "completed" ? scoped.filter((v) => v.change.status === "done") : scoped)
    .filter((v) => !words || `${displayId(v.change.id)} ${v.change.title}`.toLowerCase().includes(words));
  const current = rows.find((v) => v.change.id === picked) ?? rows[0];
  const orphans = shown === "active" && project ? unadopted(mine.rows.data?.notes ?? [], query.data?.changes ?? [], project.charter) : [];
  const warnings = query.data?.warnings ?? [];
  const projectName = (slug: string) => mine.registry.data?.projects.find((p) => p.slug === slug)?.name ?? slug;

  return (
    <div className="page">
      <PageHeader title="Changes" subtitle="Plans, architecture and agent work in one place."
        actions={<button className="primary big" onClick={() => useChangeIntent.getState().open()}><Plus size="1.2em" aria-hidden />Start a change</button>} />
      <div className="lib-bar">
        <Tabs label="Changes" value={shown} onChange={setShown}
          items={[{ id: "active", label: "Active", count: active.length }, { id: "completed", label: "Completed" }, { id: "all", label: "All changes" }]} />
        <label className="lib-search inline"><Search size="1.2em" aria-hidden /><input value={search} placeholder="Find a change" aria-label="Find a change" onChange={(e) => setSearch(e.target.value)} /></label>
      </div>
      <div className="split wide-rail lib-split changes-split">
        <div className="split-main">
          {query.isLoading && <p className="muted">Loading…</p>}
          {query.error && <p className="error">{classify(query.error).message}</p>}
          {query.data && !rows.length && (
            <p className="muted">{words ? "No change matches." : !scoped.length ? "No changes yet. A change is a numbered piece of work with a brief, stages and its agent sessions."
              : shown === "completed" ? "No completed changes yet. Marking a change as done completes it." : "No active changes."}</p>
          )}
          <ol className="lib-list">
            {rows.map((v) => {
              const selected = current?.change.id === v.change.id;
              const lines = metaLines(v, dayMonth(v.updated));
              if (!project) lines.second.unshift(projectName(v.change.project));
              return (
                <li key={v.change.id}>
                  <button className={"lib-row change-row" + (selected ? " on" : "")} aria-current={selected}
                    onClick={() => go({ page: "changes", id: v.change.id }, { replace: true })} onDoubleClick={() => openChange(v.change.id)}>
                    <span className="lib-row-main">
                      <span className="eyebrow">{displayId(v.change.id)}</span>
                      <span className="lib-row-title">{v.change.title}</span>
                      {!!lines.first.length && <span className="lib-row-meta">{lines.first.map((t) => <span key={t}>{t}</span>)}</span>}
                      <span className="lib-row-meta">{lines.second.map((t, i) => <span key={i}>{t}</span>)}</span>
                    </span>
                    <span className={`status-chip ${v.chip.tone}`}>{v.chip.label}</span>
                  </button>
                </li>
              );
            })}
          </ol>
          {!!orphans.length && (
            <Section title="Plans without a change">
              {orphans.map((r) => (
                <div key={r.ref} className="arrow-row">
                  <FileText size="1.3em" aria-hidden />
                  <button className="link" onClick={(e) => openNote(r.ref, r.title, e.ctrlKey || e.metaKey)}>{r.title}</button>
                  <button className="outline" onClick={() => useChangeIntent.getState().open({ mode: "adopt", ref: r.ref, title: r.title })}>Adopt as change</button>
                </div>
              ))}
            </Section>
          )}
          {!!warnings.length && (
            <div className="banner warn">
              <span>Living Memory reports problems with the change registry:</span>
              <ul>{warnings.map((w) => <li key={w}>{w}</li>)}</ul>
            </div>
          )}
        </div>
        <aside className="split-rail">{current ? <Rail key={current.change.id} view={current} /> : <p className="muted">Select a change to see its outcome and context.</p>}</aside>
      </div>
    </div>
  );
}
