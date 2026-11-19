import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, FileText, Layers, Link as LinkIcon, Play, Plus } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  agentStart, APPROVALS, asksNobody, CLAUDE_MODES, ENGINE_LABELS, enginesQuery, modelsQuery, repoBranches, rolesQuery, SANDBOXES, sessionsQuery,
  type Access, type Approval, type ClaudeMode, type Engine, type Interface, type Policy, type Role, type Sandbox,
} from "../../lib/agent";
import { useChangesEnabled, useSystemsEnabled } from "../../lib/connection";
import { classify } from "../../lib/errors";
import { folderForget, folderPick, OTHER_FOLDERS, otherFolders } from "../../lib/folders";
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
import { tabLabel } from "../terminal/tabs";
import { noteQuery } from "../viewer/NoteView";
import { ConnectionDialog } from "./ConnectionDialog";
import { ResumeCli } from "./ResumeCli";
import { useSessionDraft } from "./draft";
import { useShownEngines } from "./engines";
import { ALLOWED_NOTE, CODEX_ALLOWED_NOTE, codexPermissionLines, draftCounts, permissionLines, POLICIES, policyHelp, repoName, sessionBriefing } from "./session";
import { accessLines, buildStart, defaultAccess, effortOptions, historyTarget, PROFILE_HELP, PROFILE_LABELS, terminalsIn, WHERE_HELP, withApproval, type Where } from "./start";

const MODELS = [
  { id: "", label: "Default (your Claude Code setting)" },
  { id: "fable", label: "Fable" },
  { id: "opus", label: "Opus" },
  { id: "sonnet", label: "Sonnet" },
  { id: "haiku", label: "Haiku" },
];

const INTERFACES: { id: Interface; label: string }[] = [{ id: "chat", label: "Chat" }, { id: "terminal", label: "Terminal" }];

const TERMINAL_APPROVALS = "The program asks for approvals itself, in the terminal, as its permission mode says. Hivemind does not see or answer those prompts.";

/** The lines under "Tools, MCP & hooks": what is enforced depends on the engine and the interface. */
function toolLines(engine: Engine, face: Interface): string[] {
  if (face === "terminal") {
    return engine === "claude"
      ? [TERMINAL_APPROVALS, "Never: Living Memory plan, apply and undo commands. Claude Code is started with rules that deny them.", "Loaded from your own Claude Code setup: settings, hooks, plugins and MCP servers."]
      : [TERMINAL_APPROVALS, "Never: applying or undoing Living Memory plans. Living Memory's own hook in your Codex setup refuses them in Hivemind terminals.", "Loaded from your own Codex setup: its configuration, AGENTS.md, plugins and MCP servers."];
  }
  return engine === "claude"
    ? [
      "Without asking: reading files in the worktree; Living Memory's search, read and capture commands (allowed by its own hook); and anything your own Claude Code settings already allow.",
      "With “Accept edits”, also without asking: file edits in the worktree and simple file commands there, such as creating a folder.",
      "Asks you first: everything else, such as other shell commands, reading or writing outside the worktree, and file edits under “Review edits”.",
      "Never: Living Memory plan, apply and undo commands, even if a setting allows them.",
      "Loaded from your Claude Code setup: settings, hooks, plugins and MCP servers. The first line of the session lists the plugins that loaded.",
    ]
    : [
      "With “Review edits”: every file edit, and every command Codex does not trust as read-only, asks you first.",
      "With “Accept edits”: file edits and commands in the worktree run without asking; Codex asks before it goes outside its sandbox.",
      "Never: Living Memory plan, apply and undo commands.",
      "Loaded from your Codex setup: its configuration, AGENTS.md, plugins and MCP servers.",
    ];
}

/** The first option of a model or effort select: the CLI's own choice, named when its configuration names one. */
const cliDefault = (name: string | null | undefined) => (name ? `CLI default (${name})` : "CLI default");

/** Equal buttons of which one is on. */
function Choice<T extends string>({ label, value, options, onPick }: {
  label: string; value: T; options: { id: T; label: string; disabled?: boolean; title?: string }[]; onPick: (id: T) => void;
}) {
  return (
    <div className="segmented wide" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.id} type="button" role="radio" aria-checked={value === o.id} className={value === o.id ? "on" : ""} disabled={o.disabled} title={o.title} onClick={() => onPick(o.id)}>
          {value === o.id && <Check size="1.1em" aria-hidden />}{o.label}
        </button>
      ))}
    </div>
  );
}

/** Mock 02: scope a session (task, repository, start branch, permissions), inspect its briefing, and start it. */
export function StartSession() {
  const { enabled, registry, project } = useCurrentProject();
  const other = useApp((s) => s.project === OTHER_FOLDERS);
  const go = useApp((s) => s.go);
  return (
    <div className="page fill-page">
      <PageHeader title="Start a session" subtitle="Choose an engine, scope the workspace, and inspect the context." />
      {other ? <StartForm key={OTHER_FOLDERS} project={null} />
        : !enabled ? <p className="muted">Sessions need a newer Living Memory (one with the <code>projects</code> command).</p>
        : !project ? (registry.isLoading ? <p className="muted">Loading…</p>
          : <div className="empty-state"><p className="muted">Pick a project in the sidebar to start a session. A session works in one of the project's repositories.</p></div>)
        : !project.repos.length ? (
          <div className="empty-state">
            <p className="muted">This project has no repositories. Add one to the project first.</p>
            <ArrowLink onClick={() => go({ page: "overview" })}>Open the project</ArrowLink>
          </div>
        ) : <StartForm key={project.slug} project={project} />}
    </div>
  );
}

/** `project` is null under "Other folders": a terminal in a folder the user picked, with no project around it. */
function StartForm({ project }: { project: Project | null }) {
  const client = useQueryClient();
  const go = useApp((s) => s.go);
  const appDomain = useApp((s) => s.domain);
  const draft = useSessionDraft();
  const [repo, setRepo] = useState(project?.repos[0] ?? "");
  const [pickedBranch, setPickedBranch] = useState<string | null>(null);
  const [policy, setPolicy] = useState<Policy>("ask");
  const [role, setRole] = useState<Role | "">("");
  const [unattended, setUnattended] = useState(false);
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [picked, setPicked] = useState<Access>(defaultAccess(draft.engine));
  const [confirmed, setConfirmed] = useState(false);
  const [whereChoice, setWhere] = useState<Where>("checkout");
  const [folder, setFolder] = useState<string | null>(null);
  const [clash, setClash] = useState(false);
  const [starting, setStarting] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [picking, setPicking] = useState(false);
  const [connecting, setConnecting] = useState(false);
  // Every note that was in the draft when the screen opened or was added since, ticked or not.
  const [listed, setListed] = useState(draft.context);
  const touched = useRef(false);

  const branches = useQuery({ queryKey: ["repo", "branches", project?.slug, repo], queryFn: () => repoBranches(project!.slug, repo), retry: false, enabled: !!project && !!repo });
  const branch = pickedBranch ?? branches.data?.current ?? branches.data?.branches[0] ?? "";
  // Without a project (Other folders) only a terminal in a picked folder is possible. Chat always works in a worktree.
  const face: Interface = project ? draft.interface : "terminal";
  const terminal = face === "terminal";
  const where: Where = !project ? "folder" : terminal ? whereChoice : "worktree";
  const folderMode = where === "folder";
  const needsBranch = where === "worktree";
  // A change belongs to a work session in a repository; a folder session has none.
  const change = project && !folderMode ? draft.change : null;
  const changesOn = useChangesEnabled();
  const registry = useQuery({ ...changesQuery(), enabled: changesOn && change !== null });
  const linked = change === null ? undefined : registry.data?.changes.find((c) => c.id === change);
  // The brief itself, loaded on its own so nothing below depends on it staying ticked under "Included memory".
  const brief = useQuery({ ...noteQuery(linked?.brief ?? ""), enabled: !!linked && briefState(linked) !== "missing" });
  const briefNote = brief.data;
  const openSteps = briefNote ? actionItems(briefNote.body).filter((s) => !s.done).map((s) => stepParts(s.text).title) : [];
  // The change whose repository and branch have been put into the two selects; null until that is done.
  const [appliedFor, setAppliedFor] = useState<number | null>(null);
  const link = linkState({
    change, changesOn,
    registryLoading: registry.isLoading, registryError: registry.error ? classify(registry.error).message : null, linked,
    branchesLoading: branches.isLoading, branchesError: branches.error ? String(branches.error) : null,
    applied: appliedFor === change,
    briefLoading: brief.isLoading, briefError: brief.error ? classify(brief.error).message : null,
  });
  const norm = (path: string) => path.split("\\").join("/").replace(/\/+$/, "").toLowerCase();
  const branchList = branches.data?.branches;
  useEffect(() => {
    if (!linked || !project) return;
    if (touched.current) { setAppliedFor(linked.id); return; }
    const entry = linked.repo ? project.repos.find((r) => norm(r) === norm(linked.repo!)) : undefined;
    if (entry && entry !== repo) { setRepo(entry); setPickedBranch(null); return; }
    if (!branchList) return;
    if (linked.branch && branchList.includes(linked.branch)) setPickedBranch(linked.branch);
    setAppliedFor(linked.id);
  }, [linked, repo, branchList, project]);
  const engines = useQuery({ ...enginesQuery(), retry: false });
  const selected = engines.data?.find((e) => e.engine === draft.engine);
  // A hidden engine never starts: the draft's default, or a tab's engine copied by the terminal, moves to a shown one.
  const { shown, shows, first } = useShownEngines();
  useEffect(() => { if (!shows(draft.engine)) draft.setEngine(first); }, [draft, shows, first]);
  // A draft can arrive with Codex and Chat (another page preselected the engine); Chat is then not allowed.
  useEffect(() => { if (selected && !selected.chat && draft.interface === "chat") draft.setInterface("terminal"); }, [selected, draft]);
  const settings = useQuery({ queryKey: ["settings"], queryFn: getSettings });
  const roles = useQuery({ ...rolesQuery(), retry: false });
  // A role applies to chat sessions only; the terminal runs the CLI with its own modes.
  const roleInfo = !terminal ? roles.data?.find((r) => r.role === role) : undefined;
  const noUnattended = roleInfo?.profile === "edit_worktree" && draft.engine === "codex";

  // The engine's own permission modes: what was picked, or the engine's default when the engine has changed since.
  const access = picked.engine === draft.engine ? picked : defaultAccess(draft.engine);
  const risky = terminal && asksNobody(access);
  const accessKey = JSON.stringify(access);
  useEffect(() => setConfirmed(false), [accessKey]);
  const models = useQuery({ ...modelsQuery(draft.engine), enabled: terminal, retry: false });
  useEffect(() => { setModel(""); setEffort(""); }, [draft.engine]);
  const efforts = effortOptions(models.data, model);
  const pickModel = (id: string) => {
    setModel(id);
    if (effort && !effortOptions(models.data, id).includes(effort)) setEffort("");
  };
  const folders = useQuery({ queryKey: ["otherFolders"], queryFn: otherFolders, enabled: folderMode });
  const folderList = folders.data ?? [];
  useEffect(() => { if (folders.data && (!folder || !folders.data.includes(folder))) setFolder(folders.data[0] ?? null); }, [folders.data, folder]);
  const addFolder = async () => {
    try {
      const path = await folderPick();
      if (!path) return;
      client.setQueryData(["otherFolders"], await otherFolders());
      setFolder(path);
    } catch (e) { toast(String(e), "error"); }
  };
  const forgetFolder = async (path: string) => {
    try {
      await folderForget(path);
      client.setQueryData(["otherFolders"], await otherFolders());
    } catch (e) { toast(String(e), "error"); }
  };
  const sessions = useQuery({ ...sessionsQuery(), enabled: terminal });
  const resumeTarget = historyTarget({ where, project: project?.slug ?? null, repo, folder });
  const placePath = folderMode ? folder : where === "checkout" ? repo : null;
  const clashes = terminal && placePath ? terminalsIn(sessions.data ?? [], placePath) : [];

  const { rows, open, charter } = useProject(project?.slug);
  const git = useGitActivity(project?.slug);
  const commits = useMemo(() => (git.data ?? []).flatMap((r) => r.commits ?? []).sort((a, b) => b.date.localeCompare(a.date)), [git.data]);
  const systemsOn = useSystemsEnabled();
  const systems = useQuery({ ...systemsQuery(), enabled: systemsOn });
  const system = useMemo(() => {
    const live = (systems.data?.systems ?? []).filter((s) => s.status !== "retired");
    return live.find((s) => s.slug === draft.system) ?? (project ? systemsForProject(project, live)[0] : undefined);
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

  const domain = project?.charter ? domainOf(project.charter) : null;
  const task = draft.task.trim();
  // A folder session has no project briefing: its first message is the task alone.
  const makeBriefing = (w: Where) => project && w !== "folder" ? sessionBriefing({
    project, domain, repo, branch, policy, place: terminal ? (w === "worktree" ? "worktree" : "checkout") : undefined, notes, pack: buildBriefing({ project, charter: charter.data, rows: rows.data?.notes ?? [], open: open.data?.items ?? [], commits, maxChars: 5000 }),
    change: linked && briefNote ? { display: linked.display, title: linked.title, stage: STAGE_LABELS[linked.stage], briefTitle: briefNote.title, steps: openSteps, evidence: evidenceItems(briefNote.body).filter((e) => !e.done).map((e) => e.text) } : null,
    architecture: !system ? null : {
      system: system.name, generated: arch?.generatedAt ? isoDay(new Date(arch.generatedAt)) : null, behind: git.data && arch?.generatedAt ? behind : null,
      element: draft.element, containers: (archModel?.elements ?? []).filter((e) => e.type === "container").map((e) => e.name),
    },
  }) : undefined;
  const briefing = makeBriefing(where);
  const blocked = (needsBranch && !!branches.error) || !!selected?.error || link.kind === "loading" || link.kind === "failed";
  const ready = folderMode ? !!folder : needsBranch ? !!branch && !branches.isLoading : !!repo;
  const canStart = (terminal || !!task) && !loading && !starting && !blocked && ready && (!risky || confirmed);

  const add = (ref: string) => { draft.addContext(ref); setListed((l) => (l.includes(ref) ? l : [...l, ref])); };
  const run = async (w: Where) => {
    setStarting(true);
    try {
      const req = buildStart({
        engine: draft.engine, face, where: w, project: project?.slug ?? null, repo, branch, change, folder, task, policy, access, model, effort,
        context: draft.context, briefing: makeBriefing(w), system: system?.slug,
        role: roleInfo?.role ?? null, unattended: unattended && !noUnattended,
      });
      const info = await agentStart(req.task, req.prompt, req.options);
      useSessionDraft.getState().reset();
      client.invalidateQueries({ queryKey: ["agent", "sessions"] });
      openSession(info.id);
    } catch (e) {
      toast(String(e), "error");
    } finally {
      setStarting(false);
    }
  };
  // Two terminals in one folder can overwrite each other's edits: ask first.
  const start = () => {
    if (!canStart) return;
    if (terminal && where !== "worktree" && clashes.length) setClash(true); else run(where);
  };
  const cancel = () => { if (useApp.getState().back.length) useApp.getState().goBack(); else go({ page: "agents" }); };

  return (
    <>
      <div className="start-body">
        {selected?.error && <div className="banner warn">{selected.error}</div>}
        {link.kind === "failed" && (
          <div className="banner warn" role="alert">
            <strong>{link.message}</strong>
            <span className="small">Start is disabled so a session is not started without its change. Unlink the change to start a plain session, or go back and try again.</span>
            <div className="actions"><button onClick={() => useSessionDraft.setState({ change: null })}>Unlink the change</button></div>
          </div>
        )}
        <Split rail={project && !folderMode ? (
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
                <li>{needsBranch ? `Work on a new branch from ${branch}; nothing is pushed or merged` : "Work in your real checkout; nothing is pushed or merged for you"}</li>
                {terminal ? accessLines(access).slice(0, 2).map((line) => <li key={line}>{line}</li>)
                  : roleInfo ? <li>{PROFILE_HELP[roleInfo.profile]}</li>
                  : <li>{(draft.engine === "codex" ? codexPermissionLines : permissionLines)(policy)[0]}</li>}
              </ul>
            </Section>
            <div>
              <p className="muted">Preview the exact context before starting.</p>
              <ArrowLink onClick={() => setPreviewing(true)}>View full briefing</ArrowLink>
            </div>
          </>
        ) : (
          <>
            <Section title="Briefing preview"><p className="muted" title={folder ?? undefined}>Folder: {folder ? repoName(folder) : "none picked"}</p></Section>
            <Section title="Task boundaries">
              <ul>
                <li>No project briefing: the CLI gets only your task, if you write one</li>
                {accessLines(access).slice(0, 2).map((line) => <li key={line}>{line}</li>)}
              </ul>
            </Section>
            <div>
              <p className="muted">Preview the exact first message before starting.</p>
              <ArrowLink onClick={() => setPreviewing(true)}>View full message</ArrowLink>
            </div>
          </>
        )}>
          <form className="start-form" onSubmit={(e) => e.preventDefault()}>
            <section className="start-section">
              <h2>Task</h2>
              <textarea className="start-task" aria-label="Task" autoFocus placeholder={terminal ? "Optional. Leave empty to start the CLI with no task." : "What should the agent do?"} value={draft.task}
                onChange={(e) => draft.setTask(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && canStart) start(); }} />
              {change !== null && (
                <span>
                  <button className="linked-chip" onClick={() => openChange(change)}><LinkIcon size="1.2em" aria-hidden />{displayId(change)}{linked ? " · " + linked.title : ""}</button>
                  <button type="button" className="tag-x" aria-label="Unlink the change" title="Start the session without the change" onClick={() => useSessionDraft.setState({ change: null })}>×</button>
                </span>
              )}
            </section>
            <section className="start-section">
              <h2>Engine</h2>
              {shown.length > 1 ? (
                <Choice label="Engine" value={draft.engine} options={shown.map((id) => ({ id, label: ENGINE_LABELS[id], disabled: !!engines.data?.find((e) => e.engine === id)?.error, title: engines.data?.find((e) => e.engine === id)?.error ?? undefined }))}
                  onPick={(id) => {
                    draft.setEngine(id);
                    if (engines.data?.find((e) => e.engine === id)?.chat === false && draft.interface === "chat") draft.setInterface("terminal");
                  }} />
              ) : (
                <>
                  <p>{ENGINE_LABELS[first]}</p>
                  {selected?.error && <p className="error small">{selected.error}</p>}
                </>
              )}
              <div className="control-help">
                <span className="muted small">Use existing local sign-in.</span>
                <ArrowLink onClick={() => setConnecting(true)} title="Sign in to the engine in a terminal">Manage connection</ArrowLink>
              </div>
              {engines.isError && <p className="error small">{String(engines.error)}</p>}
            </section>
            <section className="start-section">
              <h2>Interface</h2>
              <Choice label="Interface" value={face} options={INTERFACES.map((o) => ({ ...o, disabled: o.id === "chat" && (selected?.chat === false || !project), title: o.id === "chat" ? (!project ? "Chat needs a project" : selected?.chatReason ?? undefined) : undefined }))}
                onPick={(id) => draft.setInterface(id)} />
              {selected?.chat === false && selected.chatReason && <p className="muted small">{selected.chatReason}</p>}
              {terminal && <p className="muted small">The terminal runs the real command-line program. It asks for approvals itself, inside the terminal.</p>}
            </section>
            {!terminal && (
              <section className="start-section">
                <h2>Role</h2>
                <select aria-label="Role" value={role} onChange={(e) => { setRole(e.target.value as Role | ""); setUnattended(false); }}>
                  <option value="">None (a plain session)</option>
                  {(roles.data ?? []).map((r) => <option key={r.role} value={r.role}>{r.label}</option>)}
                </select>
                <p className="muted small">{roleInfo
                  ? `The ${roleInfo.label.toLowerCase()} instructions go before your task${roleInfo.givesVerdict ? ", and its last line is a verdict" : ""}.`
                  : "A role adds instructions for the job and picks the permissions to match."}</p>
              </section>
            )}
            <section className="start-section">
              <h2>{!project ? "Folder" : terminal ? "Where" : "Workspace"}</h2>
              {project && terminal && (
                <Choice label="Where" value={where} onPick={setWhere}
                  options={[{ id: "checkout", label: "This checkout" }, { id: "worktree", label: "New worktree" }, { id: "folder", label: "Another folder…" }]} />
              )}
              {terminal && <p className="muted small">{WHERE_HELP[where]}</p>}
              {folderMode ? (
                <>
                  {!!folderList.length && (
                    <div className="folder-list" role="radiogroup" aria-label="Folder">
                      {folderList.map((path) => (
                        <div key={path} className="folder-row">
                          <button type="button" role="radio" aria-checked={folder === path} className={`folder-pick ${folder === path ? "on" : ""}`} title={path} onClick={() => setFolder(path)}>
                            {folder === path && <Check size="1.1em" aria-hidden />}<span className="grow">{repoName(path)}</span><span className="muted small">{path}</span>
                          </button>
                          <button type="button" className="text" aria-label={`Remove ${path} from the list`} title="Forget this folder; nothing on disk changes" onClick={() => forgetFolder(path)}>Remove</button>
                        </div>
                      ))}
                    </div>
                  )}
                  {!folderList.length && !folders.isLoading && <p className="muted small">No folders yet. Add one to start a terminal in it.</p>}
                  {folders.isError && <p className="error small">{String(folders.error)}</p>}
                  <div><button type="button" className="outline" onClick={addFolder}><Plus size="1.15em" aria-hidden />Add folder…</button></div>
                </>
              ) : (
                <>
                  <div className="start-row">
                    <label className="field"><span>Repo</span>
                      <select aria-label="Repo" value={repo} onChange={(e) => { touched.current = true; setRepo(e.target.value); setPickedBranch(null); }}>
                        {project?.repos.map((r) => <option key={r} value={r} title={r}>{repoName(r)}</option>)}
                      </select>
                    </label>
                    {needsBranch && (
                      <label className="field"><span>Start branch</span>
                        <select aria-label="Start branch" value={branch} disabled={branches.isLoading || !!branches.error} onChange={(e) => { touched.current = true; setPickedBranch(e.target.value); }}>
                          {branches.isLoading ? <option value="">Loading…</option> : (branches.data?.branches ?? []).map((b) => <option key={b} value={b}>{b}</option>)}
                        </select>
                      </label>
                    )}
                  </div>
                  {needsBranch && !!branches.error && <p className="error small">{String(branches.error)}</p>}
                  {needsBranch && linked?.branch && branchList && !branchList.includes(linked.branch) && <p className="muted small">The change names the branch {linked.branch}, which this repository does not have.</p>}
                  {needsBranch && <p className="muted small">The session works in a new git worktree on its own branch. Uncommitted changes, ignored files and submodules of your checkout are not in it.</p>}
                </>
              )}
            </section>
            {terminal && resumeTarget && (
              <ResumeCli engine={draft.engine} target={resumeTarget} access={access} model={model} effort={effort} confirmed={confirmed} />
            )}
            <section className="start-section">
              <h2>Permissions</h2>
              {terminal ? (
                <>
                  {access.engine === "claude" ? (
                    <label className="field"><span>Mode</span>
                      <select aria-label="Permission mode" value={access.mode} onChange={(e) => setPicked({ engine: "claude", mode: e.target.value as ClaudeMode })}>
                        {CLAUDE_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
                      </select>
                    </label>
                  ) : (
                    <div className="start-row">
                      <label className="field"><span>Sandbox</span>
                        <select aria-label="Sandbox" value={access.sandbox} disabled={access.approval === "approve-for-me"} onChange={(e) => setPicked({ ...access, sandbox: e.target.value as Sandbox })}>
                          {SANDBOXES.map((m) => <option key={m} value={m}>{m}</option>)}
                        </select>
                      </label>
                      <label className="field"><span>Approval</span>
                        <select aria-label="Approval" value={access.approval} onChange={(e) => setPicked(withApproval(access, e.target.value as Approval))}>
                          {APPROVALS.map((m) => <option key={m} value={m}>{m}</option>)}
                        </select>
                      </label>
                    </div>
                  )}
                  {accessLines(access).slice(1).map((line) => <p key={line} className="muted small">{line}</p>)}
                  {risky && (
                    <div className="banner error" role="alert">
                      <strong className="danger-text">This mode never asks before running commands or editing files.</strong>
                      <label><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} /> I understand; start without asking</label>
                    </div>
                  )}
                </>
              ) : roleInfo ? (
                <>
                  <p><strong>{PROFILE_LABELS[roleInfo.profile]}</strong></p>
                  <p className="muted small">{PROFILE_HELP[roleInfo.profile]}</p>
                  {roleInfo.profile === "edit_worktree" && <p className="muted small">Allowed commands come from the project's list in Settings.</p>}
                  <label title={noUnattended ? "Codex cannot edit files without asking; run it attended or use Claude Code." : undefined}>
                    <input type="checkbox" checked={unattended && !noUnattended} disabled={noUnattended} onChange={(e) => setUnattended(e.target.checked)} /> Unattended: never ask me; refuse what the profile does not allow
                  </label>
                </>
              ) : (
                <>
                  <select aria-label="Permissions" value={policy} onChange={(e) => setPolicy(e.target.value as Policy)}>
                    {POLICIES.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                  </select>
                  <p className="muted small">{policyHelp(policy, draft.engine === "codex")}</p>
                  <p className="muted small">{draft.engine === "codex" ? CODEX_ALLOWED_NOTE : ALLOWED_NOTE}</p>
                </>
              )}
            </section>
            <details className="start-more">
              <summary>Tools, MCP &amp; hooks</summary>
              <ul>
                {toolLines(draft.engine, draft.interface).map((line) => <li key={line}>{line}</li>)}
              </ul>
            </details>
            <details className="start-more">
              <summary>Environment &amp; session options</summary>
              {terminal ? (
                <>
                  <label className="field"><span>Model</span>
                    <select aria-label="Model" value={model} onChange={(e) => pickModel(e.target.value)}>
                      <option value="">{cliDefault(models.data?.defaultModel)}</option>
                      {(models.data?.models ?? []).map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                    </select>
                  </label>
                  <label className="field"><span>Effort</span>
                    <select aria-label="Effort" value={effort} onChange={(e) => setEffort(e.target.value)}>
                      <option value="">{cliDefault(models.data?.defaultEffort)}</option>
                      {efforts.map((x) => <option key={x} value={x}>{x}</option>)}
                    </select>
                  </label>
                  {models.isLoading && <p className="muted small">Loading the CLI's models…</p>}
                  {models.isError && <p className="muted small">The model list could not be read; the CLI's default is used.</p>}
                  {!!models.data?.note && <p className="muted small">{models.data.note}</p>}
                </>
              ) : draft.engine === "claude" && (
                <label className="field"><span>Model</span>
                  <select aria-label="Model" value={model} onChange={(e) => setModel(e.target.value)}>
                    {MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                  </select>
                </label>
              )}
              {draft.engine === "claude" && !terminal
                ? <p className="muted small">Spending limit: ${(settings.data?.agent_budget_usd ?? 5).toFixed(2)} per run. Change it in Settings.</p>
                : <p className="muted small">No spending limit applies in the terminal or with Codex.</p>}
              {selected?.path && <p className="muted small">{selected.label}: <code>{selected.path}</code></p>}
            </details>
          </form>
        </Split>
      </div>
      <footer className="start-footer">
        <Layers size="1.4em" aria-hidden />
        <span>{project && !folderMode ? draftCounts(draft.context.length, archModel ? 1 : 0) : `Folder: ${folder ? repoName(folder) : "none picked"}`}</span>
        <span className="fill" />
        {link.kind === "loading" && <span className="muted small" role="status">{link.what}</span>}
        <button className="outline" onClick={cancel}>Cancel</button>
        <button className="primary big" disabled={!canStart} title={link.kind === "loading" ? link.what : link.kind === "failed" ? link.message : terminal || task ? undefined : "Write a task first"} onClick={start}>
          <Play size="1.2em" aria-hidden />{starting ? "Starting…" : "Start session"}
        </button>
      </footer>
      {connecting && selected && <ConnectionDialog engine={selected} onClose={() => setConnecting(false)} />}
      {picking && <NotePicker title="Add a note to the briefing" domain={domain ?? appDomain ?? ""} exclude="" onPick={(n) => { add(n.ref); setPicking(false); }} onClose={() => setPicking(false)} />}
      {previewing && (
        <Modal title="Briefing" wide onClose={() => setPreviewing(false)}>
          <textarea className="briefing-text" readOnly value={briefing ? `${briefing}\n\n---\n\n${task}` : task} />
        </Modal>
      )}
      {clash && (
        <Modal title="Another terminal is in this folder" onClose={() => setClash(false)}>
          <p>Another terminal is working in this folder; their edits can collide.</p>
          <ul>{clashes.map((c) => <li key={c.id}>{tabLabel(c)}</li>)}</ul>
          <div className="actions">
            <button onClick={() => setClash(false)}>Cancel</button>
            {project && !!branch && <button onClick={() => { setClash(false); setWhere("worktree"); run("worktree"); }}>Use a new worktree</button>}
            <button autoFocus className="primary" onClick={() => { setClash(false); run(where); }}>Start anyway</button>
          </div>
        </Modal>
      )}
    </>
  );
}
