import { useQuery } from "@tanstack/react-query";
import { Circle, CircleCheck, FileText, Plus, Search } from "lucide-react";
import { useMemo, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useProjectsEnabled } from "../../lib/connection";
import { classify } from "../../lib/errors";
import { list, review, type NoteRow } from "../../lib/lm";
import { actionItems, sections } from "../../lib/note";
import { useApp } from "../../store";
import { ArrowLink, dayMonth, PageHeader, Row, Section, Tabs } from "../../ui/Page";
import { useWorkspace } from "../../workspace/store";
import { useNoteLinks } from "../links/useLinks";
import { progress } from "../projects/projects";
import { useCurrentProject, useProject } from "../projects/useProject";
import { noteQuery } from "../viewer/NoteView";

type Shown = "active" | "completed" | "all";
const openNote = (row: Pick<NoteRow, "ref" | "title">, split = false) => useWorkspace.getState().openNote(row.ref, { title: row.title, split });

/** What a plan's state means as a change: done, waiting on a review, or under way. */
function chipOf(row: NoteRow, due: Set<string>): { label: string; tone: string } {
  if (row.status === "resolved") return { label: "Done", tone: "active" };
  if (row.status !== "active") return { label: row.status[0].toUpperCase() + row.status.slice(1), tone: "" };
  if (due.has(row.ref)) return { label: "Needs review", tone: "waiting" };
  return progress(row).done ? { label: "In progress", tone: "busy" } : { label: "Not started", tone: "" };
}

/** The selected plan: its outcome, its steps, and the notes it links to. */
function Detail({ row, chip }: { row: NoteRow; chip: { label: string; tone: string } }) {
  const note = useQuery(noteQuery(row.ref));
  const { note: links } = useNoteLinks(row.ref);
  const steps = note.data ? actionItems(note.data.body) : [];
  const summary = note.data ? sections(note.data.body).summary : row.summary;
  const linked = (links?.outgoing ?? []).filter((e) => e.kind === "link");
  const p = progress(row);
  return (
    <>
      <Section>
        <h2 className="detail-title">{row.title}</h2>
        {summary && <div className="markdown"><Markdown remarkPlugins={[remarkGfm]}>{summary}</Markdown></div>}
        <div className="page-meta"><span className={`status-chip ${chip.tone}`}>{chip.label}</span><span className="muted">Updated {dayMonth(row.updated)}</span></div>
      </Section>
      <Section title="Implementation plan" loading={note.isLoading} error={note.error}
        empty={note.data && !steps.length ? "This plan has no action items yet. Add them under Action Items in the note." : undefined}>
        {!!p.total && (
          <span className="progress-line">
            <span className="progress" role="progressbar" aria-valuenow={p.pct} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${p.pct}%` }} /></span>
            <span className="muted small">{p.done}/{p.total}</span>
          </span>
        )}
        <ul className="step-list">
          {steps.map((s) => (
            <li key={s.index} className={s.done ? "done" : ""}>
              {s.done ? <CircleCheck size="1.3em" aria-label="Done" /> : <Circle size="1.3em" aria-label="Open" />}<span>{s.text}</span>
            </li>
          ))}
        </ul>
      </Section>
      <Section title="Connected context" empty={links && !linked.length ? "This plan links to no other notes yet." : undefined}>
        {linked.map((e) => (
          <Row key={e.node.ref} icon={<FileText size="1.3em" aria-hidden />} meta={<span className="cap">{e.node.type}</span>} onClick={(ev) => openNote(e.node, ev.ctrlKey || ev.metaKey)}>
            {e.node.title}
          </Row>
        ))}
      </Section>
      <ArrowLink onClick={() => openNote(row)}>Open change</ArrowLink>
    </>
  );
}

/** Changes: the plans a project is working through. (Change numbers, stages and linked sessions arrive with the change registry.) */
export function ChangesPage() {
  const enabled = useProjectsEnabled();
  const { project } = useCurrentProject();
  const picked = useApp((s) => (s.route.page === "changes" ? s.route.ref : undefined));
  const go = useApp((s) => s.go);
  const mine = useProject(project?.slug);
  const everyPlan = useQuery({
    queryKey: ["list", "*", "any", "plans"], queryFn: () => list({ allDomains: true, status: "any", types: ["plan"], summary: true }), enabled: !project,
  });
  const everyDue = useQuery({ queryKey: ["review", "*"], queryFn: () => review({ allDomains: true, limit: 100 }), enabled: enabled && !project });
  const source = project ? mine.rows : everyPlan;
  const dueRows = (project ? mine.due : everyDue).data?.notes;
  const [shown, setShown] = useState<Shown>("active");
  const [query, setQuery] = useState("");

  const plans = useMemo(() => (source.data?.notes ?? []).filter((r) => r.type === "plan" && r.ref !== project?.charter)
    .sort((a, b) => b.updated.localeCompare(a.updated)), [source.data, project?.charter]);
  const due = useMemo(() => new Set((dueRows ?? []).map((n) => n.ref)), [dueRows]);
  const active = plans.filter((r) => r.status === "active");
  const completed = plans.filter((r) => r.status === "resolved");
  const words = query.trim().toLowerCase();
  const rows = (shown === "active" ? active : shown === "completed" ? completed : plans).filter((r) => !words || `${r.title} ${r.summary ?? ""}`.toLowerCase().includes(words));
  const current = rows.find((r) => r.ref === picked) ?? rows[0];
  const start = () => useWorkspace.getState().openTab({ kind: "new-note", init: { type: "plan", tags: project ? [project.tag] : undefined } });

  return (
    <div className="page">
      <PageHeader title="Changes" subtitle={project ? "The plans this project is working through." : "The plans being worked through, across projects."}
        actions={<button className="primary big" onClick={start}><Plus size="1.2em" aria-hidden />Start a change</button>} />
      <div className="lib-bar">
        <Tabs label="Changes" value={shown} onChange={setShown}
          items={[{ id: "active", label: "Active", count: active.length }, { id: "completed", label: "Completed" }, { id: "all", label: "All changes" }]} />
        <label className="lib-search inline"><Search size="1.2em" aria-hidden /><input value={query} placeholder="Find a change" aria-label="Find a change" onChange={(e) => setQuery(e.target.value)} /></label>
      </div>
      <div className="split wide-rail lib-split">
        <div className="split-main">
          {source.isLoading && <p className="muted">Loading…</p>}
          {source.error && <p className="error">{classify(source.error).message}</p>}
          {source.data && !rows.length && (
            <p className="muted">{words ? "No change matches." : shown === "completed" ? "No completed changes yet. Resolving a plan note completes it." : "No changes yet. A change starts as a plan note with action items."}</p>
          )}
          <ol className="lib-list">
            {rows.map((r) => {
              const chip = chipOf(r, due);
              const p = progress(r);
              return (
                <li key={r.ref}>
                  <button className={`lib-row change-row ${current?.ref === r.ref ? "on" : ""}`} aria-current={current?.ref === r.ref}
                    onClick={(e) => (e.ctrlKey || e.metaKey ? openNote(r, true) : go({ page: "changes", ref: r.ref }, { replace: true }))} onDoubleClick={() => openNote(r)}>
                    <span className="lib-row-main">
                      <span className="eyebrow">Plan</span>
                      <span className="lib-row-title">{r.title}</span>
                      <span className="lib-row-meta">
                        <span>{p.total ? `${p.done} of ${p.total} steps` : "No steps yet"}</span>
                        <span>Updated {dayMonth(r.updated)}</span>
                        {!project && <span>{r.domain}</span>}
                      </span>
                    </span>
                    <span className={`status-chip ${chip.tone}`}>{chip.label}</span>
                  </button>
                </li>
              );
            })}
          </ol>
        </div>
        <aside className="split-rail">{current ? <Detail key={current.ref} row={current} chip={chipOf(current, due)} /> : <p className="muted">Select a change to see its plan.</p>}</aside>
      </div>
    </div>
  );
}
