import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { ChevronDown, CircleCheck, CircleX, CodeXml, FileText, GitBranch, Layers, Link as LinkIcon, LoaderCircle, MessageSquare, Network, Plus, ShieldCheck, Sparkle } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import logo from "../../assets/logo.png";
import { agentCancel, agentEnd, agentRemoveWorktree, agentSession, agentSetPolicy, sessionsQuery, type Policy, type SeqEvent, type SessionInfo } from "../../lib/agent";
import { useProjectsEnabled, useSystemsEnabled } from "../../lib/connection";
import { connect } from "../../lib/lm";
import { openChange, openProject, openSession, openSystem, startSession, useApp } from "../../store";
import { Markdown } from "../../ui/Markdown";
import { Confirm } from "../../ui/Modal";
import { ArrowLink, PageHeader, Row, Section } from "../../ui/Page";
import { toast } from "../../ui/toast";
import { useWorkspace } from "../../workspace/store";
import { displayId } from "../changes/changes";
import { dayLabel } from "../history/activity";
import { projectsQuery } from "../projects/useProject";
import { systemsQuery } from "../systems/useSystem";
import { noteQuery } from "../viewer/NoteView";
import { ApprovalCard, ChangesModal, Composer, FilesCard } from "./Chat";
import { apply, build, cost, duration, EMPTY, merge, type Finished, type Item, type Transcript as State } from "./events";
import { ALLOWED_NOTE, isEnded, permissionLines, POLICIES, repoName } from "./session";
import { StartSession } from "./StartSession";

const when = (ms: number) => new Date(ms).toLocaleString();
const elapsed = (s: SessionInfo) => duration((s.endedAt ?? Date.now()) - s.startedAt);

/** What an interactive transcript needs beyond the items: the session, which files card is the latest, and how to review it. */
interface Chat { sessionId: string; latestFiles: number; onReview?: () => void }

function Entry({ item, index, chat }: { item: Item; index: number; chat?: Chat }) {
  const [open, setOpen] = useState(false);
  const link = useQuery({ queryKey: ["connect"], queryFn: connect, retry: false, staleTime: Infinity });
  switch (item.kind) {
    case "started":
      return <p className="muted small">Claude Code {item.cliVersion ?? ""}{item.model ? ` · ${item.model}` : ""}{item.plugins.length ? ` · plugins: ${item.plugins.join(", ")}` : ""}</p>;
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
      return <ApprovalCard item={item} sessionId={chat?.sessionId ?? ""} />;
    case "files":
      return <FilesCard files={item.files} latest={index === chat?.latestFiles} onReview={chat?.onReview} />;
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

/** Engine, permissions and branch of an interactive session. */
function Toolbar({ info }: { info: SessionInfo }) {
  const client = useQueryClient();
  const setPolicy = (policy: Policy) => agentSetPolicy(info.id, policy).then(() => client.invalidateQueries({ queryKey: ["agent", "sessions"] })).catch((e) => toast(String(e), "error"));
  return (
    <div className="agent-toolbar">
      <span className="engine-chip"><Sparkle size="1.2em" aria-hidden />Claude Code</span>
      <span className="toolbar-sep" />
      <select aria-label="Permissions" value={info.policy} disabled={isEnded(info)} onChange={(e) => setPolicy(e.target.value as Policy)}>
        {POLICIES.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
      </select>
      <span className="toolbar-sep" />
      <span className="branch-label" title={info.worktree ? "from " + info.worktree.baseBranch : undefined}>
        <GitBranch size="1.2em" aria-hidden />{info.worktree?.branch ?? "worktree removed"}
      </span>
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
  const [asking, setAsking] = useState<"end" | "remove" | null>(null);
  const task = info.task.kind === "work" ? info.task : null;
  const project = registry.data?.projects.find((p) => p.slug === info.project);
  const ended = isEnded(info);
  const files = info.filesChanged?.files ?? 0;
  const resume = `claude --resume ${info.id}`;
  const refresh = () => client.invalidateQueries({ queryKey: ["agent", "sessions"] });
  const end = () => agentEnd(info.id).then(refresh).catch((e) => toast(String(e), "error"));
  const remove = () => agentRemoveWorktree(info.id).then(refresh).catch((e) => toast(String(e), "error"));
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
      </Section>
      <Section title="Permissions">
        {permissionLines(info.policy).map((line) => <Row key={line} icon={<ShieldCheck size="1.3em" aria-hidden />}>{line}</Row>)}
        <Row>Living Memory plans are never applied</Row>
        <p className="muted small">{ALLOWED_NOTE}</p>
      </Section>
      <Section title="Changes">
        {files ? <Row icon={<FileText size="1.3em" aria-hidden />} onClick={onReview}>{files} file{files === 1 ? "" : "s"} awaiting review</Row>
          : <p className="muted small">No file changes yet.</p>}
      </Section>
      <div className="rail-actions">
        {!ended && <button className="danger-text" onClick={() => (info.status === "idle" ? end() : setAsking("end"))}>End session</button>}
        {ended && info.worktree && <button className="outline" onClick={() => setAsking("remove")}>Remove worktree</button>}
        {ended && (
          <button className="outline" title={`Continue this conversation in a terminal: ${resume}`}
            onClick={() => navigator.clipboard.writeText(resume).then(() => toast("Resume command copied"), () => toast(resume))}>Copy resume command</button>
        )}
      </div>
      {asking === "end" && (
        <Confirm title="End this session?" danger action="End session" message="The agent is still working. Ending stops it; the files it has changed stay in the worktree."
          onAnswer={(yes) => { setAsking(null); if (yes) end(); }} />
      )}
      {asking === "remove" && info.worktree && (
        <Confirm title="Remove the worktree?" danger action="Remove" onAnswer={(yes) => { setAsking(null); if (yes) remove(); }}
          message={`The folder is deleted${files ? `, with ${files} uncommitted file change${files === 1 ? "" : "s"}` : ""}. Commits on ${info.worktree.branch} are kept.`} />
      )}
    </aside>
  );
}

/** One session: its log from disk, kept current by live events; and the rail that says what it may touch. */
function Session({ id }: { id: string }) {
  const client = useQueryClient();
  // Read again whenever the view opens: events that arrived while it was closed are only in the log, and a session
  // waiting on a prompt sends nothing that would reveal the gap.
  const log = useQuery({ queryKey: ["agent", "session", id], queryFn: () => agentSession(id, 0), staleTime: Infinity, refetchOnMount: "always", retry: false });
  const sessions = useQuery(sessionsQuery());
  const systems = useQuery(systemsQuery());
  const [state, setState] = useState<State>(EMPTY);
  const [reviewing, setReviewing] = useState(false);
  const info = sessions.data?.find((s) => s.id === id) ?? log.data?.info;

  useEffect(() => { if (log.data) setState((live) => merge(live, build(log.data.events))); }, [log.data]);
  useEffect(() => {
    const stop = listen<SeqEvent>("agent-event", (e) => { if (e.payload.sessionId === id) setState((s) => apply(s, e.payload)); });
    return () => { stop.then((unlisten) => unlisten()); };
  }, [id]);
  // Events were missed (the view opened mid-run, or the window reloaded): read the log again.
  useEffect(() => { if (state.gap) client.invalidateQueries({ queryKey: ["agent", "session", id] }); }, [state.gap, client, id]);

  if (log.isLoading) return <p className="muted pad">Loading…</p>;
  if (log.error || !info) return <p className="error pad">{String(log.error ?? "This session is no longer in the history.")}</p>;
  const running = info.status === "running" && !state.finished;
  const status = state.finished?.status ?? info.status;
  const resume = `claude --resume ${info.id}`;
  const passport = info.task.kind === "system_passport" ? info.task : null;
  const system = passport ? systems.data?.systems.find((s) => s.slug === passport.slug) : undefined;
  const work = info.task.kind === "work" ? info.task : null;
  const interactive = info.mode === "interactive";
  const live = { ...info, status };
  const review = info.worktree ? () => setReviewing(true) : undefined;
  return (
    <>
      <div className="chat-thread">
        <header className="chat-head">
          <h2>{info.title}</h2>
          <span className={`status-chip cap ${status === "idle" ? "active" : status === "ended" ? "" : status}`}>{status === "idle" ? "ready" : status}</span>
          {work?.change != null && (
            <button className="linked-chip" style={{ flexBasis: "100%" }} title="Open the change" onClick={() => openChange(work.change!)}>
              <LinkIcon size="1.1em" aria-hidden />{displayId(work.change)}
            </button>
          )}
        </header>
        <div className="chat-scroll">
          <Transcript state={state} running={running} chat={interactive ? { sessionId: info.id, onReview: review } : undefined} />
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
          </Section>
          <Section title="Permissions">
            <Row icon={<ShieldCheck size="1.3em" aria-hidden />}>Unattended: pre-approved actions only</Row>
            <p className="muted small">Anything outside the allowed list is refused and shown in the transcript.</p>
          </Section>
          <div className="rail-actions">
            <button className="outline" title={`Continue this conversation in a terminal: ${resume}`}
              onClick={() => navigator.clipboard.writeText(resume).then(() => toast("Resume command copied"), () => toast(resume))}>Copy resume command</button>
            {running && <button className="danger-text" onClick={() => agentCancel(info.id).catch((e) => toast(String(e), "error"))}>Stop session</button>}
          </div>
        </aside>
      )}
      {reviewing && info.worktree && <ChangesModal info={{ ...info, worktree: info.worktree }} onClose={() => setReviewing(false)} />}
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
  const current = all.find((s) => s.id === picked)?.id ?? picked ?? all[0]?.id;
  const currentInfo = all.find((s) => s.id === current);
  const days = useMemo(() => {
    const groups: { day: string; items: SessionInfo[] }[] = [];
    for (const s of all) {
      const day = dayLabel(new Date(s.startedAt).toISOString());
      const last = groups[groups.length - 1];
      if (last?.day === day) last.items.push(s); else groups.push({ day, items: [s] });
    }
    return groups;
  }, [all]);

  if (view === "new") return <StartSession />;
  return (
    <div className="page fill-page">
      <PageHeader title="Agent Workspace" />
      {currentInfo?.mode === "interactive" && <Toolbar info={currentInfo} />}
      {!enabled ? <p className="muted">Agent sessions need a newer Living Memory (one with the <code>projects</code> command).</p>
        : sessions.isLoading ? <p className="muted">Loading…</p>
        : sessions.error ? <p className="error">{String(sessions.error)}</p>
        : !all.length ? (
          <div className="empty-state">
            <p className="muted">No agent sessions yet.</p>
            <button className="primary" onClick={startSession}><Plus size="1.2em" aria-hidden />Start a session</button>
            <ArrowLink onClick={() => go({ page: "architecture" })}>Open Architecture</ArrowLink>
          </div>
        ) : (
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
                      <MessageSquare size="1.3em" aria-hidden /><span className="grow">{s.title}</span>
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
