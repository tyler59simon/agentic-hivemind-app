import { useQuery } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Bookmark, CircleCheck, CircleEllipsis, Clock, Ellipsis, Laptop, Layers, Link as LinkIcon, Network, Plus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useSystemsEnabled } from "../../lib/connection";
import { classify } from "../../lib/errors";
import type { RepoActivity } from "../../lib/git";
import { list, openWork, projectPlan, review, type NoteRow, type Project } from "../../lib/lm";
import { sections } from "../../lib/note";
import { shortDate } from "../../lib/text";
import { openSystem, useApp } from "../../store";
import { Menu } from "../../ui/Menu";
import { Modal } from "../../ui/Modal";
import { ArrowLink, dayMonth, PageHeader, Row, Section, Split } from "../../ui/Page";
import { toast } from "../../ui/toast";
import { useWorkspace } from "../../workspace/store";
import { PlanDialog } from "../plans/PlanDialog";
import { HoverPreview } from "../preview/HoverPreview";
import { MiniDiagram } from "../systems/MiniDiagram";
import { systemsQuery, useSystem } from "../systems/useSystem";
import { groupOpenItems } from "../work/work";
import { WorkView } from "../work/WorkView";
import { buildBriefing } from "./briefing";
import { useProjectIntent } from "./intent";
import { dashboardSections, progress } from "./projects";
import { ProjectWizard } from "./ProjectWizard";
import { systemsForProject } from "./scope";
import { Triage } from "./TriageDialog";
import { useCurrentProject, useGitActivity, useProject } from "./useProject";

const oneLine = (text?: string) => (text ?? "").replace(/\s+/g, " ").trim();
const openNote = (row: Pick<NoteRow, "ref" | "title">, split = false) => useWorkspace.getState().openNote(row.ref, { title: row.title, split });

function ago(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (Number.isNaN(days)) return shortDate(iso);
  if (days < 1) return "today";
  if (days === 1) return "yesterday";
  return days < 60 ? `${days} days ago` : shortDate(iso);
}

/** Recent commits and pull requests of the project's repositories. */
function Commits({ repos }: { repos: RepoActivity[] }) {
  return (
    <>
      {repos.map((r) => (
        <div key={r.repo} className="repo-activity">
          <div className="repo-name"><code>{r.repo}</code></div>
          {r.error && <p className="muted small">{r.error}</p>}
          {r.commits && !r.commits.length && !r.error && <p className="muted small">No commits in the last 30 days.</p>}
          <ul className="commit-list">
            {(r.commits ?? []).slice(0, 6).map((c) => (
              <li key={c.sha}>
                <code className="sha">{c.sha.slice(0, 7)}</code>
                <span className="commit-subject" title={c.subject}>{c.subject}</span>
                <span className="muted small">{c.author} · {ago(c.date)}</span>
              </li>
            ))}
          </ul>
          {!!r.prs?.length && (
            <div className="pr-list">
              {r.prs.map((pr) => (
                <a key={pr.number} className={`chip pr pr-${pr.state.toLowerCase()}`} href={pr.url} title={`${pr.title} (${pr.state})`}
                  onClick={(e) => { e.preventDefault(); if (/^https?:/i.test(pr.url)) openUrl(pr.url).catch(() => undefined); }}>
                  #{pr.number} {pr.title}
                </a>
              ))}
            </div>
          )}
        </div>
      ))}
    </>
  );
}

/** The system registered for the project's repositories, as a row of its containers. */
function SystemContext({ project, commits }: { project: Project; commits: { date: string }[] }) {
  const systemsOn = useSystemsEnabled();
  const registry = useQuery({ ...systemsQuery(), enabled: systemsOn });
  const matched = useMemo(() => systemsForProject(project, (registry.data?.systems ?? []).filter((s) => s.status !== "retired")), [project, registry.data]);
  const system = matched[0];
  const { architecture } = useSystem(system?.slug);
  const go = useApp((s) => s.go);
  const arch = architecture.data;
  // Commits made after the architecture output was last generated.
  const behind = arch?.generatedAt ? commits.filter((c) => new Date(c.date).getTime() > arch.generatedAt!).length : 0;
  if (!systemsOn) return null;
  return (
    <>
      <Section title="System context" loading={registry.isLoading} error={registry.error}>
        {system ? (
          <>
            {arch?.model ? <MiniDiagram model={arch.model} />
              : <p className="muted">{architecture.isLoading ? "Loading…" : arch?.error ?? `${system.name} has no architecture output yet.`}</p>}
            <ArrowLink onClick={() => openSystem(system.slug)}>{arch?.model ? "Open diagram" : `Open ${system.name}`}</ArrowLink>
          </>
        ) : (
          <>
            <p className="muted">No system is registered for this project's repositories.</p>
            <ArrowLink onClick={() => go({ page: "architecture" })}>Open Architecture</ArrowLink>
          </>
        )}
      </Section>
      {system && behind > 0 && (
        <Row icon={<Layers size="1.3em" aria-hidden />} onClick={() => openSystem(system.slug)}>
          Architecture snapshot is {behind} commit{behind === 1 ? "" : "s"} behind
        </Row>
      )}
    </>
  );
}

function ProjectOverview({ project }: { project: Project }) {
  const { rows, open, due, charter } = useProject(project.slug);
  const go = useApp((s) => s.go);
  const root = useQuery<{ root: string }>({ queryKey: ["connect"], enabled: false });
  const git = useGitActivity(project.slug);
  const [editing, setEditing] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [triage, setTriage] = useState(false);
  const [fallback, setFallback] = useState<string | null>(null);
  useEffect(() => { if (useProjectIntent.getState().takeTriage(project.slug)) setTriage(true); }, [project.slug]);

  const members = rows.data?.notes ?? [];
  const parts = useMemo(() => dashboardSections(members, project.charter), [members, project.charter]);
  const dueRefs = useMemo(() => new Set((due.data?.notes ?? []).map((n) => n.ref)), [due.data]);
  const commits = useMemo(() => (git.data ?? []).flatMap((r) => r.commits ?? []).sort((a, b) => b.date.localeCompare(a.date)), [git.data]);
  const plan = parts.roadmap[0];
  const focus = plan ?? parts.latestStatus;
  const steps = plan ? progress(plan) : null;
  const next = groupOpenItems(open.data?.items ?? []).slice(0, 5);
  const recent = useMemo(() => [...members].filter((r) => r.ref !== project.charter && r.status === "active").sort((a, b) => b.updated.localeCompare(a.updated)).slice(0, 5), [members, project.charter]);
  const summary = charter.data ? sections(charter.data.body).summary : undefined;

  const copy = async () => {
    const text = buildBriefing({ project, charter: charter.data, rows: members, open: open.data?.items ?? [], commits });
    try { await navigator.clipboard.writeText(text); toast("Briefing copied"); } catch { setFallback(text); }
  };
  const newNote = () => useWorkspace.getState().openTab({ kind: "new-note", init: { tags: [project.tag], domain: charter.data?.domain } });

  return (
    <div className="page">
      <PageHeader title={project.name} subtitle={project.description || oneLine(summary).slice(0, 160) || "No description yet."}
        meta={project.status !== "active" && <span className={`status-chip ${project.status}`}>{project.status}</span>}
        actions={<>
          <button className="text underline" onClick={copy} title="Copy a Markdown context pack for an agent">Copy briefing</button>
          <Menu label="Project actions" align="right" button={<Ellipsis size="1.3em" aria-hidden />} className="icon-menu">
            {(close) => (
              <>
                {project.charter && <li role="none"><button role="menuitem" onClick={() => { close(); openNote({ ref: project.charter!, title: `${project.name} charter` }); }}>Open charter</button></li>}
                <li role="none"><button role="menuitem" onClick={() => { close(); setEditing(true); }}>Edit project…</button></li>
                <li role="none"><button role="menuitem" onClick={() => { close(); setTriage(true); }}>Find notes for this project…</button></li>
                {project.status === "active" && <li role="none"><button role="menuitem" className="danger-text" onClick={() => { close(); setArchiving(true); }}>Archive…</button></li>}
              </>
            )}
          </Menu>
          <button className="primary big" onClick={newNote} title="New note in this project (Ctrl+N)"><Plus size="1.2em" aria-hidden />New note</button>
        </>} />
      <Split rail={<>
        <SystemContext project={project} commits={commits} />
        <Section title="Needs your review" loading={due.isLoading} error={due.error}
          empty={due.data && !due.data.notes.length ? "Nothing is waiting for you." : undefined}>
          <Row icon={<Clock size="1.3em" aria-hidden />} onClick={() => go({ page: "overview", view: "work" })}>
            {due.data?.due} note{due.data?.due === 1 ? "" : "s"} due for review
          </Row>
        </Section>
      </>}>
        <Section title="Continue your work" loading={rows.isLoading} error={rows.error}
          empty={rows.data && !focus ? "Nothing is in progress. A plan note with action items shows up here." : undefined}>
          {focus && (
            <div className="focus-card">
              <h3>{focus.title}</h3>
              <p className="focus-status">
                <CircleCheck size="1.2em" aria-hidden />
                {steps ? (steps.total ? `${steps.done} of ${steps.total} steps done` : "No action items yet") : `Latest status · ${dayMonth(focus.updated)}`}
                {dueRefs.has(focus.ref) && <span className="status-chip waiting">Needs review</span>}
              </p>
              {focus.summary && <p className="clamp">{oneLine(focus.summary)}</p>}
              <p className="focus-meta"><LinkIcon size="1.1em" aria-hidden /><span className="cap">{focus.type}</span><span>Updated {dayMonth(focus.updated)}</span>{!!parts.decisions.length && <span>{parts.decisions.length} decision{parts.decisions.length === 1 ? "" : "s"}</span>}</p>
              <div className="focus-actions">
                <button className="outline" onClick={() => openNote(focus)}>{plan ? "Open plan" : "Open note"}</button>
              </div>
            </div>
          )}
        </Section>
        <Section title="Next in your project" loading={open.isLoading} error={open.error}
          empty={open.data && !next.length ? "No open action items." : undefined}
          actions={!!open.data?.count && <ArrowLink onClick={() => go({ page: "overview", view: "work" })}>All open work</ArrowLink>}>
          <ul className="item-list">
            {next.map((g) => (
              <li key={g.ref}>
                <HoverPreview refId={g.ref}>
                  <button className="item-row" onClick={(e) => openNote(g, e.ctrlKey || e.metaKey)}>
                    {dueRefs.has(g.ref) ? <Clock size="1.6em" aria-hidden /> : <CircleEllipsis size="1.6em" aria-hidden />}
                    <span className="item-main"><strong>{g.title}</strong><span className="muted">{oneLine(g.items[0].item)}{g.items.length > 1 ? ` (+${g.items.length - 1} more)` : ""}</span></span>
                    <span className={`status-chip ${dueRefs.has(g.ref) ? "neutral" : "progress"}`}>{dueRefs.has(g.ref) ? "Needs review" : "In progress"}</span>
                  </button>
                </HoverPreview>
              </li>
            ))}
          </ul>
        </Section>
        <Section title="Recent memory" loading={rows.isLoading} error={rows.error}
          empty={rows.data && !recent.length ? `No notes are tagged with ${project.tag} yet.` : undefined}
          actions={!!recent.length && <ArrowLink onClick={() => go({ page: "memory" })}>All memory</ArrowLink>}>
          <ul className="item-list">
            {recent.map((r) => (
              <li key={r.ref}>
                <HoverPreview refId={r.ref}>
                  <button className="item-row" onClick={(e) => openNote(r, e.ctrlKey || e.metaKey)}>
                    <Bookmark size="1.4em" aria-hidden /><span className="item-main"><span>{r.title}</span></span>
                    <span className="row-meta"><span className="cap">{r.type}</span> · {dayMonth(r.updated)}</span>
                  </button>
                </HoverPreview>
              </li>
            ))}
          </ul>
          {rows.data && !members.length && <button className="link" onClick={() => setTriage(true)}>Find existing notes for this project</button>}
        </Section>
        {!!project.repos.length && (
          <Section title="Recent commits" loading={git.isLoading} empty={git.error ? `Git activity is unavailable: ${classify(git.error).message}` : undefined}>
            <Commits repos={git.data ?? []} />
          </Section>
        )}
      </Split>
      <footer className="status-strip">
        <Laptop size="1.3em" aria-hidden /><span>Local workspace</span><span title={root.data?.root}>Memory connected</span>
        <span><Network size="1em" aria-hidden /> {project.repos.length} repositor{project.repos.length === 1 ? "y" : "ies"}</span>
      </footer>
      {editing && <ProjectWizard mode="edit" project={project} onClose={() => setEditing(false)} />}
      {triage && <Triage project={project} onClose={() => setTriage(false)} />}
      {archiving && (
        <PlanDialog title={`Archive ${project.name}`} applyLabel="Archive" danger
          intro={<p>The project is marked archived. Its notes and tag stay in place.</p>}
          make={() => projectPlan("archive", { slug: project.slug })}
          onApplied={() => { toast(`Archived ${project.name}`); setArchiving(false); }} onClose={() => setArchiving(false)} />
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

/** The whole store when no project is picked: open work, what is due, and the newest notes. */
function StoreOverview({ projectsOn }: { projectsOn: boolean }) {
  const go = useApp((s) => s.go);
  const open = useQuery({ queryKey: ["open", "*"], queryFn: () => openWork({ allDomains: true, limit: 500 }), enabled: projectsOn });
  const due = useQuery({ queryKey: ["review", "*"], queryFn: () => review({ allDomains: true, limit: 100 }), enabled: projectsOn });
  const rows = useQuery({ queryKey: ["list", "*"], queryFn: () => list({ allDomains: true }) });
  const next = groupOpenItems(open.data?.items ?? []).slice(0, 6);
  const recent = useMemo(() => [...(rows.data?.notes ?? [])].sort((a, b) => b.updated.localeCompare(a.updated)).slice(0, 8), [rows.data]);
  return (
    <div className="page">
      <PageHeader title="All memory" subtitle="Everything your agents and you have recorded, across projects."
        actions={projectsOn && <button className="primary big" onClick={() => useProjectIntent.getState().openWizard()}><Plus size="1.2em" aria-hidden />New project</button>} />
      {!projectsOn && <div className="banner warn">Projects, open work and review need a newer Living Memory (API 2 with the <code>projects</code> command). Notes, search, the graph and activity work as they are.</div>}
      <Split rail={projectsOn && (
        <Section title="Needs your review" loading={due.isLoading} error={due.error} empty={due.data && !due.data.notes.length ? "Nothing is waiting for you." : undefined}>
          <Row icon={<Clock size="1.3em" aria-hidden />} onClick={() => go({ page: "overview", view: "work" })}>{due.data?.due} note{due.data?.due === 1 ? "" : "s"} due for review</Row>
        </Section>
      )}>
        {projectsOn && (
          <Section title="Open work" loading={open.isLoading} error={open.error} empty={open.data && !next.length ? "No open action items." : undefined}
            actions={!!open.data?.count && <ArrowLink onClick={() => go({ page: "overview", view: "work" })}>All open work</ArrowLink>}>
            <ul className="item-list">
              {next.map((g) => (
                <li key={g.ref}>
                  <button className="item-row" onClick={() => openNote(g)}>
                    <CircleEllipsis size="1.6em" aria-hidden />
                    <span className="item-main"><strong>{g.title}</strong><span className="muted">{oneLine(g.items[0].item)}{g.items.length > 1 ? ` (+${g.items.length - 1} more)` : ""}</span></span>
                  </button>
                </li>
              ))}
            </ul>
          </Section>
        )}
        <Section title="Recent memory" loading={rows.isLoading} error={rows.error} empty={rows.data && !recent.length ? "No notes yet." : undefined}
          actions={<ArrowLink onClick={() => go({ page: "memory" })}>All memory</ArrowLink>}>
          <ul className="item-list">
            {recent.map((r) => (
              <li key={r.ref}>
                <button className="item-row" onClick={() => openNote(r)}>
                  <Bookmark size="1.4em" aria-hidden /><span className="item-main"><span>{r.title}</span></span>
                  <span className="row-meta"><span className="cap">{r.type}</span> · {r.domain} · {dayMonth(r.updated)}</span>
                </button>
              </li>
            ))}
          </ul>
        </Section>
      </Split>
    </div>
  );
}

/** Overview: the picked project's command center (mock 01), all memory when none is picked, or the open-work lists. */
export function OverviewPage() {
  const view = useApp((s) => (s.route.page === "overview" ? s.route.view : undefined));
  const { enabled, registry, project } = useCurrentProject();
  if (view === "work") {
    return <div className="page fill-page"><PageHeader title="Open work" subtitle="Unchecked action items, notes due for review, and the timeline." /><div className="sub-view"><WorkView /></div></div>;
  }
  if (enabled && registry.isLoading) return <p className="muted pad">Loading…</p>;
  if (enabled && registry.error) return <p className="error pad">{classify(registry.error).message}</p>;
  return project ? <ProjectOverview key={project.slug} project={project} /> : <StoreOverview projectsOn={enabled} />;
}
