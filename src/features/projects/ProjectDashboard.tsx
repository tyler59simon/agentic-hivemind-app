import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { classify } from "../../lib/errors";
import type { RepoActivity } from "../../lib/git";
import { diff, domains, projectPlan, search, type NoteRow, type Project } from "../../lib/lm";
import { sections } from "../../lib/note";
import { recordOperation } from "../../lib/oplog";
import { refreshStore } from "../../lib/refresh";
import { shortDate } from "../../lib/text";
import { Modal } from "../../ui/Modal";
import { toast } from "../../ui/toast";
import { useWorkspace, type Tab } from "../../workspace/store";
import { visible } from "../history/activity";
import { OperationList, useActors, useNotesById } from "../history/OperationList";
import { GraphCanvas } from "../graph/GraphCanvas";
import { PlanDialog } from "../plans/PlanDialog";
import { HoverPreview } from "../preview/HoverPreview";
import { OpenWorkList } from "../work/OpenWorkList";
import { ReviewQueue } from "../work/ReviewQueue";
import { buildBriefing } from "./briefing";
import { useProjectIntent } from "./intent";
import { changedSlugs, dashboardSections, progress, projectGraph, projectOps, touchesRegistry } from "./projects";
import { ProjectWizard } from "./ProjectWizard";
import { assignToProject, dismiss, dismissed, suggestTriage } from "./triage";
import { useAllLinks, useGitActivity, useMemberIds, useProject, useRecentActivity, useTriageRows } from "./useProject";

/** A dashboard card: header (title, count, actions) and a body that shows its own loading, error and empty state. */
function Card({ title, count, actions, className = "", loading, error, empty, children }: {
  title: string; count?: number; actions?: ReactNode; className?: string;
  loading?: boolean; error?: unknown; empty?: string; children?: ReactNode;
}) {
  return (
    <section className={`dash-card ${className}`}>
      <header className="card-head">
        <h3>{title}</h3>
        {count !== undefined && <span className="muted small">{count}</span>}
        <span className="tabbar-fill" />
        {actions}
      </header>
      <div className="card-body">
        {loading ? <p className="muted small">Loading…</p>
          : error ? <p className="error small">{classify(error).message}</p>
          : empty ? <p className="muted small">{empty}</p>
          : children}
      </div>
    </section>
  );
}

const openNote = (row: Pick<NoteRow, "ref" | "title">, split = false) => useWorkspace.getState().openNote(row.ref, { title: row.title, split });

function NoteLink({ row }: { row: Pick<NoteRow, "ref" | "title"> }) {
  return (
    <HoverPreview refId={row.ref}>
      <button className="link-row" onClick={(e) => openNote(row, e.ctrlKey || e.metaKey)}>{row.title}</button>
    </HoverPreview>
  );
}

const oneLine = (text?: string) => (text ?? "").replace(/\s+/g, " ").trim();

function ago(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (Number.isNaN(days)) return shortDate(iso);
  if (days < 1) return "today";
  if (days === 1) return "yesterday";
  return days < 60 ? `${days} days ago` : shortDate(iso);
}

function ProgressBar({ row }: { row: NoteRow }) {
  const p = progress(row);
  if (!p.total) return <span className="muted small">no action items</span>;
  return (
    <span className="progress-line">
      <span className="progress" role="progressbar" aria-valuenow={p.pct} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${p.pct}%` }} /></span>
      <span className="muted small">{p.done}/{p.total}</span>
    </span>
  );
}

function Overview({ project, charter, latestStatus, briefing }: {
  project: Project; charter?: { title: string; body: string; domain: string }; latestStatus?: NoteRow; briefing: () => string;
}) {
  const [editing, setEditing] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [fallback, setFallback] = useState<string | null>(null);
  const summary = charter ? sections(charter.body).summary : undefined;

  const copy = async () => {
    const text = briefing();
    try {
      await navigator.clipboard.writeText(text);
      toast("Briefing copied");
    } catch {
      setFallback(text);
    }
  };

  return (
    <section className="dash-card overview">
      <header className="card-head">
        <h2>{project.name}</h2>
        <span className={`badge status-${project.status}`}>{project.status}</span>
        <span className="tabbar-fill" />
        <div className="card-actions">
          {project.charter && <button onClick={() => useWorkspace.getState().openNote(project.charter!, { title: `${project.name} charter` })}>Open charter</button>}
          <button onClick={() => useWorkspace.getState().openTab({ kind: "new-note", init: { tags: [project.tag], domain: charter?.domain } })}>New note</button>
          <button onClick={copy} title="Copy a Markdown context pack for an agent">Copy briefing</button>
          <button onClick={() => setEditing(true)}>Edit</button>
          {project.status === "active" && <button onClick={() => setArchiving(true)}>Archive…</button>}
        </div>
      </header>
      <div className="card-body overview-body">
        {project.description && <p className="project-desc">{project.description}</p>}
        {!!project.repos.length && <div className="repo-list">{project.repos.map((r) => <code key={r}>{r}</code>)}</div>}
        {summary && <div className="markdown small"><Markdown remarkPlugins={[remarkGfm]}>{summary}</Markdown></div>}
        {latestStatus && (
          <div className="latest-status">
            <span className="muted small">Latest status · {shortDate(latestStatus.updated)}</span>
            <div><NoteLink row={latestStatus} /></div>
            {latestStatus.summary && <p className="small">{oneLine(latestStatus.summary)}</p>}
          </div>
        )}
      </div>
      {editing && <ProjectWizard mode="edit" project={project} onClose={() => setEditing(false)} />}
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
    </section>
  );
}

function Commits({ slug, enabled }: { slug: string; enabled: boolean }) {
  const git = useGitActivity(slug, enabled);
  if (git.isLoading) return <p className="muted small">Loading commits…</p>;
  if (git.error) return <p className="muted small">Git activity is unavailable: {classify(git.error).message}</p>;
  const repos: RepoActivity[] = git.data ?? [];
  if (!repos.length) return <p className="muted small">This project has no repos.</p>;
  return (
    <>
      {repos.map((r) => (
        <div key={r.repo} className="repo-activity">
          <div className="repo-name"><code>{r.repo}</code></div>
          {r.error && <p className="muted small">{r.error}</p>}
          {r.commits && !r.commits.length && !r.error && <p className="muted small">No commits in the last 30 days.</p>}
          <ul className="commit-list">
            {(r.commits ?? []).slice(0, 10).map((c) => (
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

function Triage({ project, rows: members, open, onToggle }: {
  project: Project; rows: NoteRow[]; open: boolean; onToggle: () => void;
}) {
  const client = useQueryClient();
  const all = useTriageRows(open);
  const links = useAllLinks(open);
  const known = useQuery({ queryKey: ["domains"], queryFn: domains, enabled: open });
  const searchDomain = known.data?.domains[0]?.name;
  const hits = useQuery({
    queryKey: ["triage-search", project.slug, project.name],
    queryFn: () => search({ query: project.name, domain: searchDomain!, scope: "all", limit: 30 }),
    enabled: open && !!searchDomain, retry: false, staleTime: 60_000,
  });
  const [version, setVersion] = useState(0);
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);

  const suggestions = useMemo(() => {
    if (!all.data || !known.data) return [];
    const byId = new Set((hits.data?.results ?? []).map((h) => h.id));
    const found = new Set(all.data.notes.filter((n) => byId.has(n.id)).map((n) => n.ref));
    const skip = dismissed(project.slug);
    return suggestTriage({ project, rows: all.data.notes, domains: known.data.domains, graph: links.data, hits: found })
      .filter((s) => !skip.has(s.ref));
  }, [all.data, known.data, links.data, hits.data, project, version]); // eslint-disable-line react-hooks/exhaustive-deps

  const checked = (s: { ref: string; level: string }) => picked[s.ref] ?? s.level === "likely";
  const chosen = suggestions.filter(checked);

  const assign = async () => {
    const byRef = new Map((all.data?.notes ?? []).map((n) => [n.ref, n]));
    setBusy(true);
    try {
      const results = await assignToProject(chosen.map((s) => byRef.get(s.ref)!).filter(Boolean), project.tag);
      for (const r of results) if (r.ok) recordOperation(r.operation_id);
      await refreshStore(client);
      const ok = results.filter((r) => r.ok).length;
      if (ok) toast(`Added ${ok} note${ok > 1 ? "s" : ""} to ${project.name}`);
      for (const r of results) if (!r.ok) toast(`${byRef.get(r.ref)?.title ?? r.ref}: ${r.error}`, "error");
      setPicked({});
    } finally { setBusy(false); }
  };

  const group = (level: "likely" | "maybe", label: string) => {
    const list = suggestions.filter((s) => s.level === level);
    if (!list.length) return null;
    return (
      <div className="triage-group">
        <div className="muted small triage-label">{label} · {list.length}</div>
        {list.map((s) => (
          <div key={s.ref} className="triage-row">
            <input type="checkbox" checked={checked(s)} onChange={(e) => setPicked({ ...picked, [s.ref]: e.target.checked })} aria-label={`Select ${s.title}`} />
            <div className="triage-main">
              <div className="triage-title">
                <span className={`badge type-${s.type}`}>{s.type}</span>
                <NoteLink row={s} />
                <span className="muted small">{s.domain}</span>
              </div>
              <div className="chips">{s.reasons.map((r) => <span key={r} className="chip reason-chip">{r}</span>)}</div>
              {!!s.otherProjects.length && <div className="muted small">Also in: {s.otherProjects.join(", ")}</div>}
            </div>
            <button className="ghost small" onClick={() => { dismiss(project.slug, s.ref); setVersion((v) => v + 1); }}>Dismiss</button>
          </div>
        ))}
      </div>
    );
  };

  return (
    <section className="dash-card wide">
      <header className="card-head">
        <h3><button className="ghost disclosure" onClick={onToggle} aria-expanded={open}>{open ? "▾" : "▸"} Triage</button></h3>
        <span className="muted small">{open ? "Existing notes that may belong here" : "Find existing notes that belong to this project"}</span>
        <span className="tabbar-fill" />
        {open && <button className="primary" disabled={!chosen.length || busy} onClick={assign}>{busy ? "Assigning…" : `Assign selected (${chosen.length})`}</button>}
      </header>
      {open && (
        <div className="card-body">
          {all.isLoading || known.isLoading ? <p className="muted small">Looking through the store…</p>
            : all.error ? <p className="error small">{classify(all.error).message}</p>
            : !suggestions.length ? <p className="muted small">No suggestions{members.length ? " beyond the notes already in the project" : ""}.</p>
            : <>{group("likely", "Likely")}{group("maybe", "Maybe")}</>}
        </div>
      )}
    </section>
  );
}

export function ProjectDashboard({ tab }: { tab: Tab }) {
  const slug = tab.slug;
  const { enabled, registry, project, rows, open, due, charter, loading } = useProject(slug);
  const updateTab = useWorkspace((s) => s.updateTab);
  const [showRetired, setShowRetired] = useState(false);
  const [triageOpen, setTriageOpen] = useState(false);
  useEffect(() => { if (slug && useProjectIntent.getState().takeTriage(slug)) setTriageOpen(true); }, [slug]);
  useEffect(() => { if (project && tab.title !== project.name) updateTab(tab.id, { title: project.name }); }, [project?.name, tab.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const members = rows.data?.notes ?? [];
  const parts = useMemo(() => dashboardSections(members, project?.charter ?? null), [members, project?.charter]);
  const memberIds = useMemberIds(members);
  const ops = useRecentActivity(!!project);
  const graph = useAllLinks(!!project);
  const notesById = useNotesById();
  // Registry-only operations name no note, so read their projects.json diff to see which project they changed.
  const registryOps = useMemo(() => (ops.data ?? []).filter(visible).filter(touchesRegistry).slice(0, 20), [ops.data]);
  const changed = useQueries({
    queries: registryOps.map((op) => ({ queryKey: ["diff", op.operation_id], queryFn: () => diff(op.operation_id), staleTime: Infinity })),
    combine: (results) => results.map((r) => r.data),
  });
  const changedKey = changed.map((d) => (d ? "1" : "0")).join("");
  const changedBySlug = useMemo(() => new Map(registryOps.flatMap((op, i) => {
    const file = changed[i]?.find((c) => c.path === "projects.json");
    return file ? [[op.operation_id, changedSlugs(file.diff)] as const] : [];
  })), [registryOps, changedKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const shownOps = useMemo(() => projectOps((ops.data ?? []).filter(visible), memberIds, slug, changedBySlug).slice(0, 30), [ops.data, memberIds, slug, changedBySlug]);
  const actorFor = useActors(shownOps, notesById);
  const memberRefs = useMemo(() => new Set(members.map((m) => m.ref)), [members]);
  const sub = useMemo(() => graph.data && projectGraph(graph.data, memberRefs), [graph.data, memberRefs]);
  const neighbours = useMemo(() => new Set((sub?.nodes ?? []).map((n) => n.ref).filter((r) => !memberRefs.has(r))), [sub, memberRefs]);
  const git = useGitActivity(slug, !!project);

  if (!enabled) return <p className="muted pad">Projects need a newer Living Memory (API 2 with the <code>projects</code> command).</p>;
  if (loading) return <p className="muted pad">Loading…</p>;
  if (registry.error) return <p className="error pad">{classify(registry.error).message}</p>;
  if (!project) return <p className="muted pad">There is no project named <code>{slug}</code>. It may have been renamed or removed; pick another from the Projects list.</p>;

  const briefing = () => buildBriefing({
    project, charter: charter.data, rows: members, open: open.data?.items ?? [],
    commits: (git.data ?? []).flatMap((r) => r.commits ?? []).sort((a, b) => b.date.localeCompare(a.date)),
  });
  const empty = rows.data && !members.length;

  return (
    <div className="project-dash">
      <Overview project={project} charter={charter.data} latestStatus={parts.latestStatus} briefing={briefing} />
      {empty && (
        <div className="banner">
          No notes are tagged with <code>{project.tag}</code> yet. Use Triage to find existing ones.
        </div>
      )}
      <div className="project-grid">
        <Card title="Now" count={open.data?.count} loading={open.isLoading} error={open.error} empty={open.data && !open.data.items.length ? "No open action items" : undefined}>
          <OpenWorkList items={open.data?.items ?? []} />
        </Card>
        <Card title="Roadmap" count={parts.roadmap.length} loading={rows.isLoading} error={rows.error} empty={!parts.roadmap.length ? "No active plans" : undefined}>
          <ul className="card-list">
            {parts.roadmap.map((r) => (
              <li key={r.ref}>
                <div className="row-line"><NoteLink row={r} /><span className="tabbar-fill" /><span className="muted small">{shortDate(r.updated)}</span></div>
                <ProgressBar row={r} />
                {r.summary && <p className="muted small clamp">{oneLine(r.summary)}</p>}
              </li>
            ))}
          </ul>
        </Card>
        <Card title="Decisions" count={parts.decisions.length} loading={rows.isLoading} error={rows.error}
          empty={!parts.decisions.length && !parts.retired.some((r) => r.type === "decision") ? "No decisions recorded" : undefined}
          actions={parts.retired.some((r) => r.type === "decision") && (
            <label className="check small"><input type="checkbox" checked={showRetired} onChange={(e) => setShowRetired(e.target.checked)} /> Show superseded</label>
          )}>
          <ul className="card-list adr">
            {[...parts.decisions, ...(showRetired ? parts.retired.filter((r) => r.type === "decision") : [])].map((r) => (
              <li key={r.ref} className={r.status === "active" ? "" : "retired"}>
                <span className="muted small adr-date">{shortDate(r.created)}</span>
                <div className="adr-main">
                  <NoteLink row={r} />
                  {r.status !== "active" && <span className={`badge status-${r.status}`}>{r.status}</span>}
                  {r.summary && <p className="muted small clamp">{oneLine(r.summary)}</p>}
                </div>
              </li>
            ))}
          </ul>
        </Card>
        <Card title="Risks & debt" count={parts.risks.length} loading={rows.isLoading} error={rows.error} empty={!parts.risks.length ? "No risks or bugs" : undefined}>
          <ul className="card-list">
            {parts.risks.map((r) => (
              <li key={r.ref} className={r.status === "active" ? "" : "retired"}>
                <div className="row-line">
                  <span className={`badge type-${r.type}`}>{r.type}</span>
                  <NoteLink row={r} />
                  <span className="tabbar-fill" />
                  {r.status !== "active" && <span className={`badge status-${r.status}`}>{r.status}</span>}
                  {!!r.actions?.open && <span className="muted small" title="Open action items">{r.actions.open} open</span>}
                </div>
                {r.summary && <p className="muted small clamp">{oneLine(r.summary)}</p>}
              </li>
            ))}
          </ul>
        </Card>
        <Card title="Knowledge" count={parts.knowledge.length} loading={rows.isLoading} error={rows.error} empty={!parts.knowledge.length ? "No knowledge notes" : undefined}>
          <ul className="card-list compact">
            {parts.knowledge.map((r) => (
              <li key={r.ref}><div className="row-line"><span className={`badge type-${r.type}`}>{r.type}</span><NoteLink row={r} /></div></li>
            ))}
          </ul>
        </Card>
        <Card title="Review due" count={due.data?.due} loading={due.isLoading} error={due.error} empty={due.data && !due.data.notes.length ? "Nothing is due for review" : undefined}>
          <ReviewQueue rows={due.data?.notes ?? []} />
        </Card>
        <Card title="Activity" className="wide">
          {ops.isLoading ? <p className="muted small">Loading…</p>
            : ops.error ? <p className="error small">{classify(ops.error).message}</p>
            : shownOps.length ? <OperationList ops={shownOps} notes={notesById} actorFor={actorFor} />
            : <p className="muted small">No recent changes among the last 200 operations.</p>}
          <h4 className="card-sub">Recent commits</h4>
          <Commits slug={project.slug} enabled />
        </Card>
        <Card title="Graph" className="wide" count={sub?.nodes.length} loading={graph.isLoading} error={graph.error}
          empty={sub && !sub.nodes.length ? "No linked notes yet" : undefined}>
          {sub && <GraphCanvas data={sub} dim={neighbours} compact onOpen={(ref, title, split) => useWorkspace.getState().openNote(ref, { split, title })} />}
        </Card>
      </div>
      <Triage project={project} rows={members} open={triageOpen} onToggle={() => setTriageOpen(!triageOpen)} />
    </div>
  );
}
