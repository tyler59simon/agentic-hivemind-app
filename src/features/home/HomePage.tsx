// Home: one project-scoped page for "what is open, by project, with dates". With a project picked it shows the project's open work
// by due date, what needs the user, its health, the latest briefing and a box to ask about it. With none picked it shows the
// portfolio and what is overdue or due this week across projects. Capture (the header button or Ctrl+Shift+C) starts from here.
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Ellipsis, Plus } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { sessionsQuery } from "../../lib/agent";
import { useSystemsEnabled } from "../../lib/connection";
import { classify } from "../../lib/errors";
import { matches, useFormat } from "../../lib/shortcuts";
import type { Milestone } from "../../lib/executive";
import { writeProject, type NoteRow, type Project } from "../../lib/lm";
import { sections } from "../../lib/note";
import { openProject, openSession, startSession, useApp } from "../../store";
import { Menu } from "../../ui/Menu";
import { Modal } from "../../ui/Modal";
import { dayMonth, PageHeader, Section, Split, Tabs } from "../../ui/Page";
import { toast } from "../../ui/toast";
import { useWorkspace } from "../../workspace/store";
import { isEnded, sessionForNote, waitingForReview } from "../agents/session";
import { isoToday } from "../executive/commitments";
import { CaptureDialog, ReviewDialog } from "../executive/Capture";
import { HealthChip } from "../executive/parts";
import type { ProjectRow } from "../executive/portfolio";
import { useNotes, usePortfolio, useRecords, useRecordsError } from "../executive/useExecutive";
import { displayText } from "../notes/tasks";
import { useTaskItems } from "../notes/useTaskItems";
import { DirectDialog } from "../plans/DirectDialog";
import { buildBriefing } from "../projects/briefing";
import { useProjectIntent } from "../projects/intent";
import { dashboardSections, progress } from "../projects/projects";
import { ProjectWizard } from "../projects/ProjectWizard";
import { Triage } from "../projects/TriageDialog";
import { useCurrentProject, useGitActivity, useProject } from "../projects/useProject";
import { ArchitectureTab } from "../systems/ArchitectureTab";
import { AskBox } from "./AskBox";
import { BriefingCard, BriefingModals } from "./BriefingCard";
import { HealthCard } from "./HealthCard";
import { dueSoon, homeSections, looseItems, projectItems } from "./home";
import { MilestonesDialog } from "./MilestonesDialog";
import { EntryRows, OpenList, useTick } from "./OpenList";
import { AgentActivity, NeedsReview, SystemContext } from "./panels";
import { Since, useVisit } from "./Since";
import { modalOpen } from "../../ui/layers";

const oneLine = (text?: string) => (text ?? "").replace(/\s+/g, " ").trim();

/** The Capture button's dialog, Ctrl+Shift+C, and the review of the batch the route names. */
function useCapture(projects: Project[], project: Project | undefined): { start: () => void; dialogs: ReactNode } {
  const route = useApp((s) => (s.route.page === "home" ? s.route : undefined));
  const go = useApp((s) => s.go);
  const [capturing, setCapturing] = useState(false);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (matches(e, "capture.open") && !modalOpen()) { e.preventDefault(); setCapturing(true); } };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  return {
    start: () => setCapturing(true),
    dialogs: (
      <>
        {capturing && <CaptureDialog projects={projects} project={project} onClose={() => setCapturing(false)} />}
        {route?.capture && <ReviewDialog key={route.capture} id={route.capture} projects={projects} onClose={() => go({ ...route, capture: undefined })} />}
      </>
    ),
  };
}

type HomeTab = "overview" | "architecture";

/** The Overview and Architecture tabs under the page header. Architecture needs the systems registry. The tab is kept in the route
 *  and swapped in place, so Back does not step through tab switches. */
function useHomeTabs(): { tab: HomeTab; tabs: ReactNode } {
  const systemsOn = useSystemsEnabled();
  const route = useApp((s) => (s.route.page === "home" ? s.route : undefined));
  const go = useApp((s) => s.go);
  const tab: HomeTab = systemsOn && route?.tab === "architecture" ? "architecture" : "overview";
  if (!systemsOn) return { tab, tabs: null };
  const change = (next: HomeTab) => go(next === "architecture" ? { ...route, page: "home", tab: "architecture" } : { page: "home" }, { replace: true });
  return { tab, tabs: <Tabs label="Home" value={tab} onChange={change} items={[{ id: "overview", label: "Overview" }, { id: "architecture", label: "Architecture" }]} /> };
}

function CaptureButton({ onClick }: { onClick: () => void }) {
  return <button className="primary" onClick={onClick} title={useFormat("capture.open")}><Plus size="1em" aria-hidden /> Capture</button>;
}

/** A slim line above the open list: the newest active plan note of the project, how far it is and the state of its session. */
function Continue({ project, members }: { project: Project; members: NoteRow[] }) {
  const sessions = useQuery(sessionsQuery());
  const plan = useMemo(() => dashboardSections(members, project.charter).roadmap[0], [members, project.charter]);
  const session = plan && sessionForNote(sessions.data ?? [], project.slug, plan.ref);
  if (!plan) return null;
  const steps = progress(plan);
  const state = session ? (waitingForReview(session) ? "session waiting for review" : session.status === "running" ? "session running" : session.status === "waiting" ? "session waiting for you" : isEnded(session) ? "" : "session ready") : "";
  const open = () => (session ? openSession(session.id) : useWorkspace.getState().openNote(plan.ref, { title: plan.title }));
  return (
    <button className="continue-bar" onClick={open} title={session ? "Resume the session" : "Open the plan"}>
      <span className="muted">Continue:</span>
      <strong className="grow">{plan.title}</strong>
      <span className="muted small">{[steps.total ? `${steps.done} of ${steps.total} steps done` : "", state].filter(Boolean).join(" · ")}</span>
      <ArrowRight size="1.1em" aria-hidden />
    </button>
  );
}

function ProjectHome({ project }: { project: Project }) {
  const today = isoToday();
  const days = useVisit(project.slug);
  const data = usePortfolio();
  const { rows, charter, open } = useProject(project.slug);
  const tasks = useTaskItems("open");
  const notes = useNotes();
  const milestones = useRecords<Milestone>("milestone");
  const git = useGitActivity(project.slug);
  const capture = useCapture(data.projects, project);
  const { tab, tabs } = useHomeTabs();
  const ticks = useTick();
  const [editing, setEditing] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [triage, setTriage] = useState(false);
  const [fallback, setFallback] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Milestone | "new" | null>(null);
  useEffect(() => { if (useProjectIntent.getState().takeTriage(project.slug)) setTriage(true); }, [project.slug]);

  const mine = useMemo(() => projectItems(tasks.items, project, notes.rows.data?.notes ?? [], tasks.folders), [tasks.items, project, notes.rows.data, tasks.folders]);
  const ms = useMemo(() => (milestones.data ?? []).filter((m) => m.project === project.slug), [milestones.data, project.slug]);
  const openSections = useMemo(() => homeSections(mine, ms, today), [mine, ms, today]);
  const row: ProjectRow | undefined = data.rows[0];
  const members = rows.data?.notes ?? [];
  const summary = charter.data ? sections(charter.data.body).summary : undefined;
  const failed = useRecordsError();

  const copy = async () => {
    const commits = (git.data ?? []).flatMap((r) => r.commits ?? []).sort((a, b) => b.date.localeCompare(a.date));
    const text = buildBriefing({ project, charter: charter.data, rows: members, open: open.data?.items ?? [], commits });
    try { await navigator.clipboard.writeText(text); toast("Briefing copied"); } catch { setFallback(text); }
  };
  const newNote = () => useWorkspace.getState().openTab({ kind: "new-note", init: { tags: [project.tag], domain: charter.data?.domain } });

  return (
    <div className="page exec">
      <PageHeader title={project.name} subtitle={project.description || oneLine(summary).slice(0, 160) || "No description yet."}
        meta={project.status !== "active" && <span className={`status-chip cap ${project.status}`}>{project.status}</span>}
        actions={<>
          <CaptureButton onClick={capture.start} />
          {row && <HealthChip status={row.health.status} suggested={!row.health.set} />}
          <Menu label="Project actions" align="right" button={<Ellipsis size="1.3em" aria-hidden />} className="icon-menu">
            {(close) => (
              <>
                <li role="none"><button role="menuitem" onClick={() => { close(); newNote(); }}>New note</button></li>
                {project.charter && <li role="none"><button role="menuitem" onClick={() => { close(); useWorkspace.getState().openNote(project.charter!, { title: `${project.name} charter` }); }}>Open charter</button></li>}
                <li role="none"><button role="menuitem" onClick={() => { close(); setDialog("new"); }}>Milestones…</button></li>
                <li role="none"><button role="menuitem" onClick={() => { close(); startSession(); }}>Start a session</button></li>
                <li role="none"><button role="menuitem" onClick={() => { close(); void copy(); }}>Copy briefing for an agent</button></li>
                <li role="none"><button role="menuitem" onClick={() => { close(); setEditing(true); }}>Edit project…</button></li>
                <li role="none"><button role="menuitem" onClick={() => { close(); setTriage(true); }}>Find notes for this project…</button></li>
                {project.status === "active" && <li role="none"><button role="menuitem" className="danger-text" onClick={() => { close(); setArchiving(true); }}>Archive…</button></li>}
              </>
            )}
          </Menu>
        </>} />
      {tabs}
      {tab === "architecture" ? <ArchitectureTab /> : <Continue project={project} members={members} />}
      {tab === "overview" && <Split rail={<>
        <NeedsReview project={project} />
        {row && <HealthCard row={row} />}
        <BriefingCard project={project} />
        <AskBox project={project} />
        <SystemContext project={project} />
        <AgentActivity project={project} />
      </>}>
        <Section title="Open work" loading={tasks.loading || notes.rows.isLoading} actions={<button className="link small" onClick={() => setDialog("new")}>Add a milestone</button>}>
          {tasks.problems.map((p) => <p key={p} className="error small">{p}</p>)}
          {notes.rows.error ? <p className="error small">Could not load notes for this project: {classify(notes.rows.error).message}</p> : null}
          {!notes.rows.error && data.error ? <p className="error small">Could not load project summary: {classify(data.error).message}</p> : null}
          {failed ? <p className="error small">Milestones or project health did not load, so they are missing here: {classify(failed).message}</p> : null}
          <OpenList sections={openSections} today={today} ticks={ticks} onMilestone={setDialog} empty="No open work for this project. Items are open action items on notes tagged with the project, and tasks in notebooks inside its repositories." />
        </Section>
        <Since days={days} project={project.slug} git={project.repos.length ? { loading: git.isLoading, error: git.error, repos: git.data ?? [] } : undefined} />
      </Split>}
      {dialog && <MilestonesDialog project={project} milestones={milestones.data ?? []} initial={dialog} onClose={() => setDialog(null)} />}
      {capture.dialogs}
      <BriefingModals project={project} projects={data.projects} />
      {editing && <ProjectWizard mode="edit" project={project} onClose={() => setEditing(false)} />}
      {triage && <Triage project={project} onClose={() => setTriage(false)} />}
      {archiving && (
        <DirectDialog title={`Archive ${project.name}`} applyLabel="Archive" danger
          intro={<p>The project is marked archived. Its notes and tag stay in place.</p>}
          run={() => writeProject("archive", { slug: project.slug })} done={`Archived ${project.name}`}
          onApplied={() => setArchiving(false)} onClose={() => setArchiving(false)} />
      )}
      {fallback !== null && (
        <Modal title="Briefing" wide onClose={() => setFallback(null)}>
          <p className="muted small">The clipboard is not available here. Select the text and copy it.</p>
          <textarea className="briefing-text" readOnly value={fallback} autoFocus onFocus={(e) => e.currentTarget.select()} />
        </Modal>
      )}
    </div>
  );
}

/** The portfolio, and what is overdue or due this week in each project and in the commitments that belong to none. */
function AllHome({ projectsOn }: { projectsOn: boolean }) {
  const today = isoToday();
  const days = useVisit("*");
  const data = usePortfolio();
  const tasks = useTaskItems("open");
  const notes = useNotes();
  const milestones = useRecords<Milestone>("milestone");
  const capture = useCapture(data.projects, undefined);
  const { tab, tabs } = useHomeTabs();
  const ticks = useTick();
  const failed = useRecordsError();
  const rows = notes.rows.data?.notes ?? [];

  const groups = useMemo(() => data.rows.map((r) => {
    const s = homeSections(projectItems(tasks.items, r.project, rows, tasks.folders), (milestones.data ?? []).filter((m) => m.project === r.project.slug), today);
    return { row: r, sections: s, soon: dueSoon(s), next: [...s.today, ...s.week, ...s.later][0] };
  }), [data.rows, tasks.items, tasks.folders, rows, milestones.data, today]);
  const loose = useMemo(() => dueSoon(homeSections(looseItems(tasks.items, rows), [], today)), [tasks.items, rows, today]);
  const none = !groups.some((g) => g.soon.length) && !loose.length;
  const onMilestone = (m: Milestone) => openProject(m.project);

  return (
    <div className="page exec">
      <PageHeader title="All projects" subtitle="Every project's health and what is due, across projects."
        actions={<>
          <CaptureButton onClick={capture.start} />
          {projectsOn && <button className="primary big" onClick={() => useProjectIntent.getState().openWizard()}><Plus size="1.2em" aria-hidden />New project</button>}
        </>} />
      {tabs}
      {tab === "architecture" && <ArchitectureTab />}
      {tab === "overview" && !projectsOn && <div className="banner warn">Projects, open work and review need a newer Living Memory (API 2 with the <code>projects</code> command). Notes, search, the graph and activity work as they are.</div>}
      {tab === "overview" && <Split rail={projectsOn && <>
        <NeedsReview />
        <BriefingCard project={undefined} />
        <AskBox project={undefined} />
        <AgentActivity />
      </>}>
        {projectsOn && (
          <>
            <Section title="Projects" loading={data.loading} error={data.error} empty={data.rows.length ? undefined : "No projects yet. Create one with New project."}>
              {failed ? <p className="error small">Milestones or project health did not load, so they are missing here: {classify(failed).message}</p> : null}
              <table className="exec-table">
                <thead><tr><th>Project</th><th>Health</th><th>Overdue</th><th>Next due</th><th>Last activity</th></tr></thead>
                <tbody>
                  {groups.map(({ row: r, sections: s, next }) => (
                    <tr key={r.project.slug} onClick={(e) => { if (!(e.target as HTMLElement).closest("button,a")) openProject(r.project.slug); }} title={`Open ${r.project.name}`}>
                      <td><button type="button" className="link" onClick={() => openProject(r.project.slug)}><strong>{r.project.name}</strong></button>{r.project.status === "paused" && <span className="muted small"> paused</span>}</td>
                      <td><HealthChip status={r.health.status} suggested={!r.health.set} /><div className="muted small">{r.health.suggestion.reasons[0]}</div></td>
                      <td>{s.overdue.length ? <span className="status-chip bad">{s.overdue.length} overdue</span> : <span className="muted">0</span>}</td>
                      <td>{next ? <>{next.due}<div className="muted small">{next.kind === "task" ? displayText(next.task.text) : next.milestone.title}</div></> : <span className="muted">none</span>}</td>
                      <td>{r.lastActivity ? dayMonth(r.lastActivity) : <span className="muted">none</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Section>
            <Section title="Overdue and this week" loading={tasks.loading || notes.rows.isLoading}>
              {tasks.problems.map((p) => <p key={p} className="error small">{p}</p>)}
              {none && <p className="muted">Nothing is overdue or due this week.</p>}
              {groups.filter((g) => g.soon.length).map((g) => (
                <div key={g.row.project.slug} className="task-group">
                  <h3><button className="link" onClick={() => openProject(g.row.project.slug)}>{g.row.project.name}</button> <span className="muted small">{g.soon.length}</span></h3>
                  <EntryRows entries={g.soon} today={today} ticks={ticks} onMilestone={onMilestone} />
                </div>
              ))}
              {loose.length > 0 && (
                <div className="task-group">
                  <h3>Cross-project commitments <span className="muted small">{loose.length}</span></h3>
                  <EntryRows entries={loose} today={today} ticks={ticks} onMilestone={onMilestone} />
                </div>
              )}
            </Section>
          </>
        )}
        <Since days={days} />
      </Split>}
      {capture.dialogs}
      <BriefingModals project={undefined} projects={data.projects} />
    </div>
  );
}

/** Home: the picked project's page, or the portfolio when none is picked. */
export function HomePage() {
  const { enabled, registry, project } = useCurrentProject();
  if (enabled && registry.isLoading) return <p className="muted pad">Loading…</p>;
  if (enabled && registry.error) return <p className="error pad">{classify(registry.error).message}</p>;
  return project ? <ProjectHome key={project.slug} project={project} /> : <AllHome key="*" projectsOn={enabled} />;
}
