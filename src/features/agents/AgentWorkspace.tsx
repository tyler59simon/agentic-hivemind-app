import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { Check, ChevronDown, CircleCheck, CircleX, CodeXml, FileText, GitBranch, Inbox, Layers, Lightbulb, Link as LinkIcon, LoaderCircle, MessageSquare, Network, Plus, Shield, ShieldCheck, Sparkle, SquareTerminal } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import logo from "../../assets/logo.png";
import { agentCancel, agentEnd, agentSession, agentSetPolicy, engineName, engineOf, enginesQuery, enginesText, sessionsQuery, type Engine, type Interface, type Policy, type ResourceUsage, type SeqEvent, type SessionInfo } from "../../lib/agent";
import { PROFILE_HELP, PROFILE_LABELS } from "./start";
import { learningQuery, learningReview } from "../../lib/skills";
import { lastRun, runText } from "../skills/skills";
import { useProjectsEnabled, useSystemsEnabled } from "../../lib/connection";
import { sessionCapture } from "../../lib/executive";
import { connect } from "../../lib/lm";
import { openAutomation, openInbox, openProject, openSession, openSystem, startSession, useApp } from "../../store";
import { Markdown } from "../../ui/Markdown";
import { Menu } from "../../ui/Menu";
import { Confirm } from "../../ui/Modal";
import { ArrowLink, PageHeader, Row, Section, Tabs } from "../../ui/Page";
import { toast } from "../../ui/toast";
import { useWorkspace } from "../../workspace/store";
import { dayLabel } from "../history/activity";
import { projectsQuery } from "../projects/useProject";
import { systemsQuery } from "../systems/useSystem";
import { noteQuery } from "../viewer/NoteView";
import { ApprovalCard, Composer, FilesCard, RemoveWorktree } from "./Chat";
import { announcement, apply, build, cost, duration, EMPTY, merge, type Finished, type Item, type Transcript as State } from "./events";
import type { SeqEvent as LogEvent } from "../../lib/agent";
import { announce } from "../../ui/announce";
import { filesWord, reviewLabel } from "../review/review";
import { ALLOWED_NOTE, CODEX_ALLOWED_NOTE, CODEX_COST_NOTE, CODEX_MODE_NOTE, codexPermissionLines, engineLabel, isCodex, isUnattended, resumeCommand, isEnded, permissionLines, POLICIES, repoName, usageText, VERDICT_LABELS, waitingForReview } from "./session";
import { useSessionDraft } from "./draft";
import { useShownEngines } from "./engines";
import { StartSession } from "./StartSession";
import { accessLabel, latestOf, whereLabel } from "../terminal/tabs";
import { StopSession, TerminalWorkspace } from "../terminal/TerminalWorkspace";

const when = (ms: number) => new Date(ms).toLocaleString();
const elapsed = (s: SessionInfo) => duration((s.endedAt ?? Date.now()) - s.startedAt);

/** What an interactive transcript needs beyond the items: the session, which files card is the latest, and how to review it. */
interface Chat { sessionId: string; engine: string; root?: string; latestFiles: number; chip: { text: string; tone: string } | null; onReview?: () => void }

function Entry({ item, index, chat }: { item: Item; index: number; chat?: Chat }) {
  const [open, setOpen] = useState(false);
  const link = useQuery({ queryKey: ["connect"], queryFn: connect, retry: false, staleTime: Infinity });
  switch (item.kind) {
    case "started":
      return <p className="muted small">{chat?.engine ?? "Claude Code"} {item.cliVersion ?? ""}{item.model ? ` · ${item.model}` : ""}{item.plugins.length ? ` · plugins: ${item.plugins.join(", ")}` : ""}</p>;
    case "text":
      return <div className="chat-message"><img className="chat-avatar" src={logo} alt="" /><div className="markdown"><Markdown>{item.text}</Markdown></div></div>;
    case "tool": {
      const failed = item.result && !item.result.ok;
      return (
        <div className={`tool-call ${failed ? "failed" : ""}`}>
          <button className="tool-call-head" aria-expanded={open} onClick={() => setOpen(!open)}>
            {!item.result ? <LoaderCircle className="spin" size="1.3em" aria-label="Running" /> : failed ? <CircleX size="1.3em" aria-label="Failed" /> : <CircleCheck size="1.3em" aria-label="Done" />}
            <span className="tool-name">{item.name}</span><code>{item.summary}</code>
            <ChevronDown size="1.1em" aria-hidden />
          </button>
          {open && <div className="tool-call-body"><code>{item.summary}</code>{item.result?.summary && <p className="muted small">{item.result.summary}</p>}</div>}
        </div>
      );
    }
    case "denied":
      return <div className="banner warn"><strong>Not allowed: {item.tool}</strong><span className="small">{item.summary}</span></div>;
    case "user":
      return (
        <div className="chat-user">
          <span className="avatar" aria-hidden>{(link.data?.user || "You").slice(0, 1).toUpperCase()}</span>
          <div className="chat-bubble">
            {item.text}
            {!!item.context.length && <span className="muted small">{item.context.length} note{item.context.length === 1 ? "" : "s"} attached</span>}
          </div>
        </div>
      );
    case "approval":
      return <ApprovalCard item={item} sessionId={chat?.sessionId ?? ""} root={chat?.root} />;
    case "files":
      return <FilesCard files={item.files} latest={index === chat?.latestFiles} chip={index === chat?.latestFiles ? chat.chip : null} onReview={chat?.onReview} />;
    case "turn":
      if (item.outcome === "stopped") return <p className="turn-line">Stopped</p>;
      if (item.outcome === "error") return <div className="banner warn"><strong>The turn failed</strong><span className="small">{item.reason}</span></div>;
      if (item.outcome === "budget") {
        return (
          <div className="banner warn">
            <strong>Spending limit reached</strong>
            <span className="small">This session has spent {cost(item.costUsd)}. Your next message starts a new run with a fresh limit. The limit is set in Settings.</span>
          </div>
        );
      }
      return (
        <p className="turn-line">
          {["Turn finished", duration(item.durationMs), item.costUsd != null ? `${cost(item.costUsd)} total` : "", item.denials ? `${item.denials} action${item.denials > 1 ? "s" : ""} not allowed` : ""].filter(Boolean).join(" · ")}
        </p>
      );
  }
}

function Outcome({ finished }: { finished: Finished }) {
  const structured = finished.structured as { summary?: string; notes?: string[]; gaps?: string[] } | null;
  const facts = [
    finished.turns != null ? `${finished.turns} turns` : "", duration(finished.durationMs), cost(finished.costUsd),
    finished.denials ? `${finished.denials} action${finished.denials > 1 ? "s" : ""} not allowed` : "",
  ].filter(Boolean).join(" · ");
  return (
    <div className={`banner ${finished.status === "succeeded" ? "" : "warn"}`}>
      <strong>{finished.status === "succeeded" ? "Finished" : finished.status === "cancelled" ? "Cancelled" : "Failed"}</strong>
      {facts && <span className="small">{facts}</span>}
      {finished.reason && <p className="small">{finished.reason}</p>}
      {structured?.summary ? <p>{structured.summary}</p>
        : finished.result && <div className="markdown small"><Markdown>{finished.result}</Markdown></div>}
      {!!structured?.notes?.length && <><h4 className="card-sub">Notes captured</h4><ul>{structured.notes.map((n) => <li key={n}>{n}</li>)}</ul></>}
      {!!structured?.gaps?.length && <><h4 className="card-sub">Gaps</h4><ul>{structured.gaps.map((g) => <li key={g}>{g}</li>)}</ul></>}
    </div>
  );
}

/** What the agent said and did, in order. An interactive session adds the user's messages, permission requests and file changes (`chat`). */
export function Transcript({ state, running, chat }: { state: State; running: boolean; chat?: Omit<Chat, "latestFiles"> }) {
  const end = useRef<HTMLDivElement>(null);
  const interactive = !!chat;
  useEffect(() => { if (running || interactive) end.current?.scrollIntoView({ block: "nearest" }); }, [state.next, running, interactive]);
  const latestFiles = state.items.map((i) => i.kind).lastIndexOf("files");
  return (
    <div className="transcript">
      {state.items.map((item, i) => <Entry key={i} item={item} index={i} chat={chat && { ...chat, latestFiles }} />)}
      {state.finished
        ? (interactive && state.finished.status === "ended" ? <p className="turn-line">Session ended</p> : <Outcome finished={state.finished} />)
        : running && <p className="muted small">Working…</p>}
      <div ref={end} />
    </div>
  );
}

/** The exact permission flags a terminal session was started with (see `term/launch.rs`). */
const permissionFlags = (s: SessionInfo) => {
  const a = s.access;
  if (a?.engine === "claude") return `Claude Code was started with --permission-mode ${a.mode}`;
  if (a?.engine === "codex") return a.approval === "approve-for-me" ? "Codex was started with --approve-for-me -s workspace-write" : `Codex was started with -s ${a.sandbox} -a ${a.approval}`;
  const edits = s.policy === "accept_edits";
  return s.adapter === "codex"
    ? `Codex was started with -s ${edits ? "workspace-write" : "read-only"} -a on-request`
    : `Claude Code was started with --permission-mode ${edits ? "acceptEdits" : "manual"}`;
};

/** Engine, interface switch, permissions and branch. Without a session (the terminal empty state) only the engine menu and the switch show. */
function Toolbar({ info, face, sessions, onAsk }: { info?: SessionInfo; face: Interface; sessions: SessionInfo[]; onAsk: (face: Interface) => void }) {
  const client = useQueryClient();
  const project = useApp((s) => s.project) ?? null;
  const draftEngine = useSessionDraft((s) => s.engine);
  const engines = useQuery(enginesQuery());
  const { shown, shows, first } = useShownEngines();
  const engine: Engine = info ? engineOf(info) : shows(draftEngine) ? draftEngine : first;
  const others: Engine[] = info ? shown.filter((e) => e !== engine) : shown;
  const adapterOf = (e: Engine) => (e === "codex" ? "codex" : "claude-code");
  const setPolicy = (policy: Policy) => info && agentSetPolicy(info.id, policy).then(() => client.invalidateQueries({ queryKey: ["agent", "sessions"] })).catch((e) => toast(String(e), "error"));
  const newWith = (e: Engine) => {
    const draft = useSessionDraft.getState();
    draft.setEngine(e);
    draft.setInterface(face);
    startSession();
  };
  const switchTo = (next: Interface) => {
    if (next === face && info) return;
    const s = latestOf(sessions, project, next);
    if (s) openSession(s.id); else { onAsk(next); useApp.getState().go({ page: "agents" }); }
  };
  return (
    <div className="agent-toolbar">
      <Menu className="engine-menu" label="Engine" button={<><Sparkle size="1.2em" aria-hidden />{engineName(adapterOf(engine))}<ChevronDown size="1.1em" aria-hidden /></>}>
        {(close) => (
          <>
            {info && (
              <>
                <li className="menu-label" role="none">This session</li>
                <li role="none"><button role="menuitem" onClick={close}><span className="grow">{engineName(info.adapter)}</span><Check size="1em" aria-hidden /></button></li>
                <li className="menu-sep" role="none" />
              </>
            )}
            {others.map((e) => {
              const error = engines.data?.find((x) => x.engine === e)?.error ?? undefined;
              return (
                <li key={e} role="none">
                  <button role="menuitem" disabled={!!error} title={error} onClick={() => { close(); newWith(e); }}>
                    <span className="grow">New session with {engineName(adapterOf(e))}</span>
                  </button>
                </li>
              );
            })}
            <li className="menu-note" role="none">A session keeps the engine it was started with.</li>
          </>
        )}
      </Menu>
      <Tabs pill label="Interface" items={[{ id: "chat", label: "Chat" }, { id: "terminal", label: "Terminal" }]} value={face} onChange={switchTo} />
      {info && (
        <>
          <span className="toolbar-sep" />
          {info.interface === "terminal"
            ? <span className="toolbar-fact" title={permissionFlags(info)}><Shield size="1.2em" aria-hidden />{accessLabel(info)}</span>
            : info.profile ? (
              <span className="toolbar-fact" title={PROFILE_HELP[info.profile]}>
                <Shield size="1.2em" aria-hidden />{PROFILE_LABELS[info.profile]}{isUnattended(info) ? " · unattended" : ""}
              </span>
            ) : (
              <select aria-label="Permissions" value={info.policy} disabled={isEnded(info) || isCodex(info) || info.task.kind === "executive"} title={isCodex(info) ? CODEX_MODE_NOTE : info.task.kind === "executive" ? "The executive assistant stays read-only." : undefined} onChange={(e) => setPolicy(e.target.value as Policy)}>
                {POLICIES.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
            )}
          <span className="toolbar-sep" />
          <span className="branch-label" title={info.worktree ? "from " + info.worktree.baseBranch : undefined}>
            <GitBranch size="1.2em" aria-hidden />{whereLabel(info)}
          </span>
        </>
      )}
    </div>
  );
}

/** What an interactive session works on, what it may do, what it changed, and how to end it. */
function InteractiveRail({ info, onReview }: { info: SessionInfo; onReview?: () => void }) {
  const client = useQueryClient();
  const projectsOn = useProjectsEnabled();
  const registry = useQuery({ ...projectsQuery(), enabled: projectsOn });
  const notes = useQueries({ queries: info.context.map((ref) => noteQuery(ref)) });
  const [linked, setLinked] = useState(false);
  const [asking, setAsking] = useState<"end" | null>(null);
  const task = info.task.kind === "work" ? info.task : null;
  const project = registry.data?.projects.find((p) => p.slug === info.project);
  const ended = isEnded(info);
  const files = info.filesChanged?.files ?? 0;
  const resume = resumeCommand(info);
  const learning = useQuery(learningQuery());
  const run = lastRun(learning.data?.runs ?? [], info.id);
  const [reviewing, setReviewing] = useState(false);
  const claudeShown = useShownEngines().shows("claude");
  const reviewNow = () => {
    setReviewing(true);
    learningReview(info.id).then(() => toast("Reviewing the session for lessons. Drafts appear in the Inbox."), (e) => toast(String(e), "error"))
      .finally(() => setReviewing(false));
  };
  const refresh = () => client.invalidateQueries({ queryKey: ["agent", "sessions"] });
  const end = () => agentEnd(info.id).then(refresh).catch((e) => toast(String(e), "error"));
  return (
    <aside className="split-rail agents-rail">
      <Section title="Session context">
        {info.project && <Row icon={<Layers size="1.3em" aria-hidden />} meta={project?.name ?? info.project} onClick={() => openProject(info.project)}>Project</Row>}
        {task && <Row icon={<CodeXml size="1.3em" aria-hidden />} meta={repoName(task.repo)} title={task.repo}>Repo</Row>}
        {!!info.context.length && (
          <>
            <Row icon={<LinkIcon size="1.3em" aria-hidden />} onClick={() => setLinked(!linked)}>{info.context.length} linked note{info.context.length === 1 ? "" : "s"}</Row>
            {linked && (
              <ul className="card-list compact">
                {info.context.map((ref, i) => {
                  const title = notes[i]?.data?.title ?? ref;
                  return <li key={ref}><button className="link-row" onClick={(e) => useWorkspace.getState().openNote(ref, { title, split: e.ctrlKey || e.metaKey })}>{title}</button></li>;
                })}
              </ul>
            )}
          </>
        )}
        {info.system && <Row icon={<Network size="1.3em" aria-hidden />} onClick={() => openSystem(info.system!)}>1 architecture view</Row>}
        <Row meta={when(info.startedAt)}>Started</Row>
        <Row meta={[elapsed(info), info.costUsd != null ? cost(info.costUsd) : ""].filter(Boolean).join(" · ")}>Duration</Row>
        {isCodex(info) && <p className="muted small">{CODEX_COST_NOTE}</p>}
      </Section>
      <Section title="Permissions">
        {info.profile
          ? <Row icon={<ShieldCheck size="1.3em" aria-hidden />} meta={isUnattended(info) ? "unattended" : undefined}>{PROFILE_LABELS[info.profile]}: {PROFILE_HELP[info.profile]}</Row>
          : (isCodex(info) ? codexPermissionLines : permissionLines)(info.policy).map((line) => <Row key={line} icon={<ShieldCheck size="1.3em" aria-hidden />}>{line}</Row>)}
        <Row>Living Memory plans are never applied</Row>
        <p className="muted small">{isCodex(info) ? CODEX_ALLOWED_NOTE : ALLOWED_NOTE}</p>
      </Section>
      <Section title="Changes">
        {files ? <Row icon={<FileText size="1.3em" aria-hidden />} onClick={onReview}>{filesWord(files)} {waitingForReview(info) ? "awaiting review" : "changed"}</Row>
          : <p className="muted small">No file changes yet.</p>}
      </Section>
      {info.interface === "chat" && task && (claudeShown || run) && (
        <Section title="Learning">
          {run ? <Row icon={<Lightbulb size="1.3em" aria-hidden />} meta={when(run.at)}>{runText(run)}</Row>
            : <p className="muted small">Hivemind reviews a session for notes and skills when you approve or discard its edits, or when a long session ends.</p>}
          {claudeShown && (
            <button className="outline" disabled={reviewing} title="One tool-free Claude call that reads this session and proposes notes (and, after approval, a skill). It counts against the daily learning budget."
              onClick={reviewNow}>{run ? "Review again" : "Review for lessons now"}</button>
          )}
        </Section>
      )}
      <div className="rail-actions">
        {!ended && <button className="danger-text" onClick={() => (info.status === "idle" ? end() : setAsking("end"))}>End session</button>}
        <RemoveWorktree info={info} />
        {ended && resume && (
          <button className="outline" title={`Continue this conversation in a terminal: ${resume}`}
            onClick={() => navigator.clipboard.writeText(resume).then(() => toast("Resume command copied"), () => toast(resume))}>Copy resume command</button>
        )}
      </div>
      {asking === "end" && (
        <Confirm title="End this session?" danger action="End session" message="The agent is still working. Ending stops it; the files it has changed stay in the worktree."
          onAnswer={(yes) => { setAsking(null); if (yes) end(); }} />
      )}
    </aside>
  );
}

/** The CPU and memory of a session's processes, from the samples Rust sends every few seconds while it runs. */
function useResources(id: string): ResourceUsage | undefined {
  const [usage, setUsage] = useState<ResourceUsage>();
  useEffect(() => {
    setUsage(undefined);
    const stop = listen<Record<string, ResourceUsage>>("agent-resources", (e) => setUsage(e.payload[id]));
    return () => { stop.then((unlisten) => unlisten()); };
  }, [id]);
  return usage;
}

/** A session's log from disk, kept current by live events. Callers key their view by the session id. */
export function useTranscript(id: string) {
  const client = useQueryClient();
  // Read again whenever the view opens: events that arrived while it was closed are only in the log, and a session
  // waiting on a prompt sends nothing that would reveal the gap.
  const log = useQuery({ queryKey: ["agent", "session", id], queryFn: () => agentSession(id, 0), staleTime: Infinity, refetchOnMount: "always", retry: false });
  const [state, setState] = useState<State>(EMPTY);
  useEffect(() => { if (log.data) setState((live) => merge(live, build(log.data.events))); }, [log.data]);
  useEffect(() => {
    const stop = listen<SeqEvent>("agent-event", (e) => { if (e.payload.sessionId === id) setState((s) => apply(s, e.payload)); });
    return () => { stop.then((unlisten) => unlisten()); };
  }, [id]);
  // Events were missed (the view opened mid-run, or the window reloaded): read the log again.
  useEffect(() => { if (state.gap) client.invalidateQueries({ queryKey: ["agent", "session", id] }); }, [state.gap, client, id]);
  return { log, state };
}

/** Read out new permission requests and finished turns (DESK-7). What the log held when it first loaded is the baseline,
 *  so opening a session does not read its history. The view is keyed by session, so the baseline is per session. */
function useTranscriptAnnouncements(state: State, firstLog: LogEvent[] | undefined, agent: string) {
  const seen = useRef<number | null>(null);
  useEffect(() => {
    if (!firstLog) return;
    if (seen.current === null) seen.current = build(firstLog).items.length;
    if (state.items.length > seen.current) {
      const said = announcement(state.items, seen.current, agent);
      if (said) announce(said.text, said.urgent ? "assertive" : "polite");
    }
    seen.current = Math.max(seen.current, state.items.length);
  }, [state.items, firstLog, agent]);
}

/** One session: its log from disk, kept current by live events; and the rail that says what it may touch. */
function Session({ id }: { id: string }) {
  const client = useQueryClient();
  const { log, state } = useTranscript(id);
  const sessions = useQuery(sessionsQuery());
  const systems = useQuery(systemsQuery());
  const usage = useResources(id);
  const [capturing, setCapturing] = useState(false);
  const info = sessions.data?.find((s) => s.id === id) ?? log.data?.info;
  useTranscriptAnnouncements(state, log.data?.events, info ? engineLabel(info) : "The agent");

  if (log.isLoading) return <p className="muted pad">Loading…</p>;
  if (log.error || !info) return <p className="error pad">{String(log.error ?? "This session is no longer in the history.")}</p>;
  const running = info.status === "running" && !state.finished;
  const status = state.finished?.status ?? info.status;
  const resume = resumeCommand(info);
  const passport = info.task.kind === "system_passport" ? info.task : null;
  const system = passport ? systems.data?.systems.find((s) => s.slug === passport.slug) : undefined;
  const interactive = info.mode === "interactive";
  const live = { ...info, status };
  const review = info.worktree ? () => openInbox(info.id) : undefined;
  // What an Executive Assistant conversation decided is captured when it ends; this takes it again, and opens the review.
  const captureChat = async () => {
    setCapturing(true);
    try {
      const batch = await sessionCapture(info.id);
      if (batch) {
        client.setQueryData<unknown[]>(["executive", "capture"], (prev) => [batch, ...((prev ?? []) as { id: string }[]).filter((b) => b.id !== batch.id)]);
        useApp.getState().go({ page: "home", capture: batch.id });
      }
      else toast("Nothing to capture from this conversation yet.");
    } catch (e) { toast(String(e), "error"); }
    finally { setCapturing(false); }
  };
  return (
    <>
      <div className="chat-thread">
        <header className="chat-head">
          <h2>{info.title}</h2>
          <span className={`status-chip cap ${status === "idle" ? "active" : status === "ended" ? "" : status}`}>{status === "idle" ? "ready" : status}</span>
          {info.role && <span className="status-chip cap">{info.role}</span>}
          {info.verdict && <span className={`status-chip ${info.verdict === "pass" ? "active" : "waiting"}`}>{VERDICT_LABELS[info.verdict]}</span>}
          {usage && <span className="muted small" title="The agent program and every process it started">{usageText(usage)}</span>}
          {info.origin?.startsWith("automation:") && <button className="linked-chip" title="Open Settings, Schedules" onClick={() => openAutomation(info.origin!.slice("automation:".length))}>Automation</button>}
          {info.task.kind === "executive" && isEnded(live) && (
            <button className="linked-chip" disabled={capturing || info.turns === 0} onClick={captureChat} title="Pull decisions, commitments and risks out of this conversation for review">
              {capturing ? <LoaderCircle className="spin" size="1.1em" aria-hidden /> : <Inbox size="1.1em" aria-hidden />}Capture from this chat
            </button>
          )}
        </header>
        <div className="chat-scroll">
          <Transcript state={state} running={running} chat={interactive ? { sessionId: info.id, engine: engineLabel(info), root: live.worktree?.path, chip: reviewLabel(live), onReview: review } : undefined} />
        </div>
        {interactive && <Composer info={live} transcript={state} />}
      </div>
      {interactive ? <InteractiveRail info={live} onReview={review} /> : (
        <aside className="split-rail agents-rail">
          <Section title="Session context">
            {passport && (
              <Row icon={<Network size="1.3em" aria-hidden />} meta={system?.name ?? passport.slug} onClick={() => openSystem(passport.slug)}>System</Row>
            )}
            <Row icon={<CodeXml size="1.3em" aria-hidden />} meta={<code title={info.workspace[0]}>{info.workspace[0]?.split(/[\\/]/).filter(Boolean).pop()}</code>}>Working in</Row>
            {info.workspace.slice(1).map((w) => <Row key={w} icon={<Layers size="1.3em" aria-hidden />} meta={<code title={w}>{w.split(/[\\/]/).filter(Boolean).pop()}</code>}>Can also read</Row>)}
            <Row meta={when(info.startedAt)}>Started</Row>
            <Row meta={[elapsed(info), info.costUsd != null ? cost(info.costUsd) : ""].filter(Boolean).join(" · ")}>Duration</Row>
            {isCodex(info) && <p className="muted small">{CODEX_COST_NOTE}</p>}
          </Section>
          <Section title="Permissions">
            <Row icon={<ShieldCheck size="1.3em" aria-hidden />}>Unattended: pre-approved actions only</Row>
            <p className="muted small">Anything outside the allowed list is refused and shown in the transcript.</p>
          </Section>
          <div className="rail-actions">
            {resume && <button className="outline" title={`Continue this conversation in a terminal: ${resume}`}
              onClick={() => navigator.clipboard.writeText(resume).then(() => toast("Resume command copied"), () => toast(resume))}>Copy resume command</button>}
            {running && <button className="danger-text" onClick={() => agentCancel(info.id).catch((e) => toast(String(e), "error"))}>Stop session</button>}
          </div>
        </aside>
      )}
    </>
  );
}

/** Mock 03: the sessions Hivemind started, the selected one's transcript (a chat for an interactive session), and its context. */
export function AgentWorkspace() {
  const systemsOn = useSystemsEnabled();
  const projectsOn = useProjectsEnabled();
  const picked = useApp((s) => (s.route.page === "agents" ? s.route.session : undefined));
  const view = useApp((s) => (s.route.page === "agents" ? s.route.view : undefined));
  const go = useApp((s) => s.go);
  const enabled = systemsOn || projectsOn;
  const sessions = useQuery({ ...sessionsQuery(), enabled });
  const all = sessions.data ?? [];
  // After the last terminal tab is closed, the terminal view stays up with its empty state.
  // The switch asks for an interface that has no session yet: that interface's empty state shows until a session is picked.
  const [asked, setAsked] = useState<Interface | null>(null);
  const emptied = asked === "terminal" && !picked;
  const chatEmpty = asked === "chat" && !picked;
  useEffect(() => { if (picked) setAsked(null); }, [picked]);
  const current = emptied || chatEmpty ? undefined : all.find((s) => s.id === picked)?.id ?? picked ?? all[0]?.id;
  const currentInfo = all.find((s) => s.id === current);
  const terminalView = emptied || currentInfo?.interface === "terminal";
  const days = useMemo(() => {
    const groups: { day: string; items: SessionInfo[] }[] = [];
    for (const s of all) {
      const day = dayLabel(new Date(s.startedAt).toISOString());
      const last = groups[groups.length - 1];
      if (last?.day === day) last.items.push(s); else groups.push({ day, items: [s] });
    }
    return groups;
  }, [all]);

  const { shown } = useShownEngines();

  if (view === "new") return <StartSession />;
  return (
    <div className="page fill-page">
      <PageHeader title="Agents" actions={<StopSession session={currentInfo} />}
        subtitle={terminalView ? `Run ${enginesText(shown, "or")} in a local, project-aware harness with memory and context.` : undefined} />
      {(terminalView || chatEmpty || currentInfo?.mode === "interactive") && <Toolbar info={currentInfo} face={terminalView ? "terminal" : "chat"} sessions={all} onAsk={setAsked} />}
      {!enabled ? <p className="muted">Agent sessions need a newer Living Memory (one with the <code>projects</code> command).</p>
        : sessions.isLoading ? <p className="muted">Loading…</p>
        : sessions.error ? <p className="error">{String(sessions.error)}</p>
        : !all.length ? (
          <div className="empty-state">
            <p className="muted">No agent sessions yet.</p>
            <button className="primary" onClick={startSession}><Plus size="1.2em" aria-hidden />Start a session</button>
            <ArrowLink onClick={() => go({ page: "home", tab: "architecture" })}>Open Architecture</ArrowLink>
          </div>
        ) : terminalView ? <TerminalWorkspace sessions={all} selected={currentInfo} onEmpty={() => { setAsked("terminal"); go({ page: "agents" }); }} />
        : (
          <div className="agents">
            <nav className="session-list" aria-label="Sessions">
              <div className="session-list-head">
                <h2>Sessions</h2>
                <button className="text" onClick={startSession}><Plus size="1.15em" aria-hidden />New session</button>
              </div>
              {days.map((g) => (
                <div key={g.day}>
                  <div className="session-day">{g.day}</div>
                  {g.items.map((s) => (
                    <button key={s.id} className={`session-item ${s.id === current ? "on" : ""}`} aria-current={s.id === current} onClick={() => openSession(s.id)} title={s.error ?? s.title}>
                      {s.interface === "terminal" ? <SquareTerminal size="1.3em" aria-hidden /> : <MessageSquare size="1.3em" aria-hidden />}
                      <span className="grow">{s.title}{s.interface === "terminal" && waitingForReview(s) && <><br /><span className="status-chip waiting">Waiting for review</span></>}</span>
                      {s.status === "running" && <span className="nav-dot" aria-label="Running" />}
                      {s.status === "waiting" && <span className="nav-dot waiting" aria-label="Waiting for you" />}
                    </button>
                  ))}
                </div>
              ))}
            </nav>
            {current && <Session key={current} id={current} />}
          </div>
        )}
    </div>
  );
}
