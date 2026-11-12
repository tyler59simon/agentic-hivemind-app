import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, Layers, Link as LinkIcon, Play, Plus } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { agentAvailable, agentStart, repoBranches, type Policy } from "../../lib/agent";
import { useChangesEnabled, useSystemsEnabled } from "../../lib/connection";
import { classify } from "../../lib/errors";
import { domainOf, getSettings, type Project } from "../../lib/lm";
import { actionItems, evidenceItems, stepParts } from "../../lib/note";
import { openChange, openSession, openSystem, useApp } from "../../store";
import { Modal } from "../../ui/Modal";
import { ArrowLink, dayMonth, PageHeader, Row, Section, Split } from "../../ui/Page";
import { toast } from "../../ui/toast";
import { briefState, displayId, linkState, STAGE_LABELS } from "../changes/changes";
import { changesQuery } from "../changes/useChanges";
import { NotePicker } from "../plans/NotePicker";
import { buildBriefing, isoDay } from "../projects/briefing";
import { systemsForProject } from "../projects/scope";
import { useCurrentProject, useGitActivity, useProject } from "../projects/useProject";
import { systemsQuery, useSystem } from "../systems/useSystem";
import { noteQuery } from "../viewer/NoteView";
import { useSessionDraft } from "./draft";
import { ALLOWED_NOTE, draftCounts, permissionLines, POLICIES, repoName, sessionBriefing } from "./session";

const MODELS = [
  { id: "", label: "Default (your Claude Code setting)" },
  { id: "opus", label: "Opus" },
  { id: "sonnet", label: "Sonnet" },
  { id: "haiku", label: "Haiku" },
];

/** Mock 02: scope a session (task, repository, start branch, permissions), inspect its briefing, and start it. */
export function StartSession() {
  const { enabled, registry, project } = useCurrentProject();
  const go = useApp((s) => s.go);
  return (
    <div className="page fill-page">
      <PageHeader title="Start a session" subtitle="Scope the workspace and inspect the context." />
      {!enabled ? <p className="muted">Sessions need a newer Living Memory (one with the <code>projects</code> command).</p>
        : !project ? (registry.isLoading ? <p className="muted">Loading…</p>
          : <div className="empty-state"><p className="muted">Pick a project in the sidebar to start a session. A session works in one of the project's repositories.</p></div>)
        : !project.repos.length ? (
          <div className="empty-state">
            <p className="muted">This project has no repositories. Add one to the project first.</p>
            <ArrowLink onClick={() => go({ page: "overview" })}>Open the project</ArrowLink>
          </div>
        ) : <StartForm project={project} />}
    </div>
  );
}

function StartForm({ project }: { project: Project }) {
  const client = useQueryClient();
  const go = useApp((s) => s.go);
  const appDomain = useApp((s) => s.domain);
  const draft = useSessionDraft();
  const [repo, setRepo] = useState(project.repos[0]);
  const [pickedBranch, setPickedBranch] = useState<string | null>(null);
  const [policy, setPolicy] = useState<Policy>("ask");
  const [model, setModel] = useState("");
  const [starting, setStarting] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [picking, setPicking] = useState(false);
  // Every note that was in the draft when the screen opened or was added since, ticked or not.
  const [listed, setListed] = useState(draft.context);
  const touched = useRef(false);

  const branches = useQuery({ queryKey: ["repo", "branches", project.slug, repo], queryFn: () => repoBranches(project.slug, repo), retry: false });
  const branch = pickedBranch ?? branches.data?.current ?? branches.data?.branches[0] ?? "";
  const changesOn = useChangesEnabled();
  const registry = useQuery({ ...changesQuery(), enabled: changesOn && draft.change !== null });
  const linked = draft.change === null ? undefined : registry.data?.changes.find((c) => c.id === draft.change);
  // The brief itself, loaded on its own so nothing below depends on it staying ticked under "Included memory".
  const brief = useQuery({ ...noteQuery(linked?.brief ?? ""), enabled: !!linked && briefState(linked) !== "missing" });
  const briefNote = brief.data;
  const openSteps = briefNote ? actionItems(briefNote.body).filter((s) => !s.done).map((s) => stepParts(s.text).title) : [];
  // The change whose repository and branch have been put into the two selects; null until that is done.
  const [appliedFor, setAppliedFor] = useState<number | null>(null);
  const link = linkState({
    change: draft.change, changesOn,
    registryLoading: registry.isLoading, registryError: registry.error ? classify(registry.error).message : null, linked,
    branchesLoading: branches.isLoading, branchesError: branches.error ? String(branches.error) : null,
    applied: appliedFor === draft.change,
    briefLoading: brief.isLoading, briefError: brief.error ? classify(brief.error).message : null,
  });
  const norm = (path: string) => path.split("\\").join("/").replace(/\/+$/, "").toLowerCase();
  const branchList = branches.data?.branches;
  useEffect(() => {
    if (!linked) return;
    if (touched.current) { setAppliedFor(linked.id); return; }
    const entry = linked.repo ? project.repos.find((r) => norm(r) === norm(linked.repo!)) : undefined;
    if (entry && entry !== repo) { setRepo(entry); setPickedBranch(null); return; }
    if (!branchList) return;
    if (linked.branch && branchList.includes(linked.branch)) setPickedBranch(linked.branch);
    setAppliedFor(linked.id);
  }, [linked, repo, branchList, project.repos]);
  const available = useQuery({ queryKey: ["agent", "available"], queryFn: agentAvailable, retry: false, staleTime: 60_000 });
  const settings = useQuery({ queryKey: ["settings"], queryFn: getSettings });

  const { rows, open, charter } = useProject(project.slug);
  const git = useGitActivity(project.slug);
  const commits = useMemo(() => (git.data ?? []).flatMap((r) => r.commits ?? []).sort((a, b) => b.date.localeCompare(a.date)), [git.data]);
  const systemsOn = useSystemsEnabled();
  const systems = useQuery({ ...systemsQuery(), enabled: systemsOn });
  const system = useMemo(() => {
    const live = (systems.data?.systems ?? []).filter((s) => s.status !== "retired");
    return live.find((s) => s.slug === draft.system) ?? systemsForProject(project, live)[0];
  }, [systems.data, project, draft.system]);
  const { architecture } = useSystem(system?.slug);
  const arch = architecture.data;
  const archModel = arch?.model ?? null;
  // Commits made after the architecture output was last generated.
  const behind = arch?.generatedAt ? commits.filter((c) => new Date(c.date).getTime() > arch.generatedAt!).length : 0;

  const noteResults = useQueries({ queries: listed.map((ref) => noteQuery(ref)) });
  const notes = draft.context.flatMap((ref) => {
    const n = noteResults[listed.indexOf(ref)]?.data;
    return n ? [{ ref, title: n.title, type: n.type, body: n.body }] : [];
  });
  const loading = draft.context.some((ref) => noteResults[listed.indexOf(ref)]?.isLoading) || rows.isLoading || open.isLoading;

  const domain = project.charter ? domainOf(project.charter) : null;
  const task = draft.task.trim();
  const briefing = sessionBriefing({
    project, domain, repo, branch, policy, notes, pack: buildBriefing({ project, charter: charter.data, rows: rows.data?.notes ?? [], open: open.data?.items ?? [], commits, maxChars: 5000 }),
    change: linked && briefNote ? { display: linked.display, title: linked.title, stage: STAGE_LABELS[linked.stage], briefTitle: briefNote.title, steps: openSteps, evidence: evidenceItems(briefNote.body).filter((e) => !e.done).map((e) => e.text) } : null,
    architecture: system && {
      system: system.name, generated: arch?.generatedAt ? isoDay(new Date(arch.generatedAt)) : null, behind: git.data && arch?.generatedAt ? behind : null,
      element: draft.element, containers: (archModel?.elements ?? []).filter((e) => e.type === "container").map((e) => e.name),
    },
  });
  const blocked = !!branches.error || available.isError || link.kind === "loading" || link.kind === "failed";
  const canStart = !!task && !loading && !starting && !branches.isLoading && !blocked && !!branch;

  const add = (ref: string) => { draft.addContext(ref); setListed((l) => (l.includes(ref) ? l : [...l, ref])); };
  const start = async () => {
    if (blocked) return;
    setStarting(true);
    try {
      const info = await agentStart({ kind: "work", project: project.slug, repo, branch, ...(draft.change !== null ? { change: draft.change } : {}) }, task, { policy, context: draft.context, briefing, model: model || undefined, system: system?.slug });
      useSessionDraft.getState().reset();
      client.invalidateQueries({ queryKey: ["agent", "sessions"] });
      openSession(info.id);
    } catch (e) {
      toast(String(e), "error");
    } finally {
      setStarting(false);
    }
  };
  const cancel = () => { if (useApp.getState().back.length) useApp.getState().goBack(); else go({ page: "agents" }); };

  return (
    <>
      <div className="start-body">
        {available.isError && <div className="banner warn">{String(available.error)}</div>}
        {link.kind === "failed" && (
          <div className="banner warn" role="alert">
            <strong>{link.message}</strong>
            <span className="small">Start is disabled so a session is not started without its change. Unlink the change to start a plain session, or go back and try again.</span>
            <div className="actions"><button onClick={() => useSessionDraft.setState({ change: null })}>Unlink the change</button></div>
          </div>
        )}
        <Split rail={
          <>
            <Section title="Briefing preview"><p className="muted">Scope: {project.name} / {repoName(repo)}</p></Section>
            <Section title="Included memory">
              {listed.length ? (
                <ul className="briefing-notes">
                  {listed.map((ref, i) => (
                    <li key={ref}>
                      <label>
                        <input type="checkbox" checked={draft.context.includes(ref)} onChange={(e) => (e.target.checked ? add(ref) : draft.removeContext(ref))} />
                        {noteResults[i]?.data?.title ?? ref}
                      </label>
                    </li>
                  ))}
                </ul>
              ) : <p className="muted small">No notes included. The project's decisions are listed in the briefing anyway; add a note to include its summary and details.</p>}
              <button className="text" onClick={() => setPicking(true)}><Plus size="1.15em" aria-hidden />Add note</button>
            </Section>
            <Section title="Architecture" loading={(!!system && architecture.isLoading) || systems.isLoading}>
              {!system ? <p className="muted small">No system is registered for this project's repositories.</p>
                : archModel && arch?.generatedAt ? (
                  <>
                    <Row icon={<FileText size="1.3em" aria-hidden />} meta={<ArrowLink onClick={() => openSystem(system.slug)}>Open diagram</ArrowLink>}>
                      {archModel.views?.some((v) => v.type === "container") ? "Containers" : "Model"} · baseline {dayMonth(new Date(arch.generatedAt).toISOString())}
                    </Row>
                    {draft.element && <p className="muted small">Attached: {draft.element}</p>}
                    {!!git.data && behind > 0 && <p className="warn-text small">Diagram is {behind} commit{behind === 1 ? "" : "s"} behind source.</p>}
                  </>
                ) : <p className="muted small">{system.name} has no architecture output yet.</p>}
            </Section>
            <Section title="Task boundaries">
              <ul>
                <li>Limit edits to {repoName(repo)}</li>
                {openSteps.slice(0, 3).map((step) => <li key={step}>{step}</li>)}
                <li>Work on a new branch from {branch}; nothing is pushed or merged</li>
                <li>{permissionLines(policy)[0]}</li>
              </ul>
            </Section>
            <div>
              <p className="muted">Preview the exact context before starting.</p>
              <ArrowLink onClick={() => setPreviewing(true)}>View full briefing</ArrowLink>
            </div>
          </>
        }>
          <form className="start-form" onSubmit={(e) => e.preventDefault()}>
            <section className="start-section">
              <h2>Task</h2>
              <textarea className="start-task" aria-label="Task" autoFocus placeholder="What should the agent do?" value={draft.task}
                onChange={(e) => draft.setTask(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && canStart) start(); }} />
              {draft.change !== null && (
                <span>
                  <button className="linked-chip" onClick={() => openChange(draft.change!)}><LinkIcon size="1.2em" aria-hidden />{displayId(draft.change)}{linked ? " · " + linked.title : ""}</button>
                  <button type="button" className="tag-x" aria-label="Unlink the change" title="Start the session without the change" onClick={() => useSessionDraft.setState({ change: null })}>×</button>
                </span>
              )}
            </section>
            {/* Phase 5: Engine and Interface sections go here */}
            <section className="start-section">
              <h2>Workspace</h2>
              <div className="start-row">
                <label className="field"><span>Repo</span>
                  <select aria-label="Repo" value={repo} onChange={(e) => { touched.current = true; setRepo(e.target.value); setPickedBranch(null); }}>
                    {project.repos.map((r) => <option key={r} value={r} title={r}>{repoName(r)}</option>)}
                  </select>
                </label>
                <label className="field"><span>Start branch</span>
                  <select aria-label="Start branch" value={branch} disabled={branches.isLoading || !!branches.error} onChange={(e) => { touched.current = true; setPickedBranch(e.target.value); }}>
                    {branches.isLoading ? <option value="">Loading…</option> : (branches.data?.branches ?? []).map((b) => <option key={b} value={b}>{b}</option>)}
                  </select>
                </label>
              </div>
              {!!branches.error && <p className="error small">{String(branches.error)}</p>}
              {linked?.branch && branchList && !branchList.includes(linked.branch) && <p className="muted small">The change names the branch {linked.branch}, which this repository does not have.</p>}
              <p className="muted small">The session works in a new git worktree on its own branch. Uncommitted changes, ignored files and submodules of your checkout are not in it.</p>
            </section>
            <section className="start-section">
              <h2>Permissions</h2>
              <select aria-label="Permissions" value={policy} onChange={(e) => setPolicy(e.target.value as Policy)}>
                {POLICIES.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
              <p className="muted small">{POLICIES.find((p) => p.id === policy)?.help}</p>
              <p className="muted small">{ALLOWED_NOTE}</p>
            </section>
            <details className="start-more">
              <summary>Tools, MCP &amp; hooks</summary>
              <ul>
                <li>Without asking: reading files in the worktree; Living Memory's search, read and capture commands (allowed by its own hook); and anything your own Claude Code settings already allow.</li>
                <li>With “Accept edits”, also without asking: file edits in the worktree and simple file commands there, such as creating a folder.</li>
                <li>Asks you first: everything else, such as other shell commands, reading or writing outside the worktree, and file edits under “Review edits”.</li>
                <li>Never: Living Memory plan, apply and undo commands, even if a setting allows them.</li>
                <li>Loaded from your Claude Code setup: settings, hooks, plugins and MCP servers. The first line of the session lists the plugins that loaded.</li>
              </ul>
            </details>
            <details className="start-more">
              <summary>Environment &amp; session options</summary>
              <label className="field"><span>Model</span>
                <select aria-label="Model" value={model} onChange={(e) => setModel(e.target.value)}>
                  {MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                </select>
              </label>
              <p className="muted small">Spending limit: ${(settings.data?.agent_budget_usd ?? 5).toFixed(2)} per run. Change it in Settings.</p>
              {available.data && <p className="muted small">Claude Code: <code>{available.data}</code></p>}
            </details>
          </form>
        </Split>
      </div>
      <footer className="start-footer">
        <Layers size="1.4em" aria-hidden />
        <span>{draftCounts(draft.context.length, archModel ? 1 : 0)}</span>
        <span className="fill" />
        {link.kind === "loading" && <span className="muted small" role="status">{link.what}</span>}
        <button className="outline" onClick={cancel}>Cancel</button>
        <button className="primary big" disabled={!canStart} title={link.kind === "loading" ? link.what : link.kind === "failed" ? link.message : task ? undefined : "Write a task first"} onClick={start}>
          <Play size="1.2em" aria-hidden />{starting ? "Starting…" : "Start session"}
        </button>
      </footer>
      {picking && <NotePicker title="Add a note to the briefing" domain={domain ?? appDomain ?? ""} exclude="" onPick={(n) => { add(n.ref); setPicking(false); }} onClose={() => setPicking(false)} />}
      {previewing && (
        <Modal title="Briefing" wide onClose={() => setPreviewing(false)}>
          <textarea className="briefing-text" readOnly value={`${briefing}\n\n---\n\n${task}`} />
        </Modal>
      )}
    </>
  );
}
