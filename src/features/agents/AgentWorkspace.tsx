import { useQuery, useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { ChevronDown, CircleCheck, CircleX, CodeXml, Layers, LoaderCircle, MessageSquare, Network, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import logo from "../../assets/logo.png";
import { agentCancel, agentSession, sessionsQuery, type SeqEvent, type SessionInfo } from "../../lib/agent";
import { useSystemsEnabled } from "../../lib/connection";
import { openSession, openSystem, useApp } from "../../store";
import { Markdown } from "../../ui/Markdown";
import { ArrowLink, PageHeader, Row, Section } from "../../ui/Page";
import { toast } from "../../ui/toast";
import { dayLabel } from "../history/activity";
import { systemsQuery } from "../systems/useSystem";
import { apply, build, cost, duration, EMPTY, merge, type Finished, type Item, type Transcript as State } from "./events";

const when = (ms: number) => new Date(ms).toLocaleString();
const elapsed = (s: SessionInfo) => duration((s.endedAt ?? Date.now()) - s.startedAt);

function Entry({ item }: { item: Item }) {
  const [open, setOpen] = useState(false);
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

/** What the agent said and did, in order. A chat pane later is this plus a message box. */
export function Transcript({ state, running }: { state: State; running: boolean }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { if (running) end.current?.scrollIntoView({ block: "nearest" }); }, [state.next, running]);
  return (
    <div className="transcript">
      {state.items.map((item, i) => <Entry key={i} item={item} />)}
      {state.finished ? <Outcome finished={state.finished} /> : running && <p className="muted small">Working…</p>}
      <div ref={end} />
    </div>
  );
}

/** One session: its log from disk, kept current by live events; and the rail that says what it may touch. */
function Session({ id }: { id: string }) {
  const client = useQueryClient();
  const log = useQuery({ queryKey: ["agent", "session", id], queryFn: () => agentSession(id, 0), staleTime: Infinity, retry: false });
  const sessions = useQuery(sessionsQuery());
  const systems = useQuery(systemsQuery());
  const [state, setState] = useState<State>(EMPTY);
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
  return (
    <>
      <div className="chat-thread">
        <header className="chat-head">
          <h2>{info.title}</h2>
          <span className={`status-chip cap ${status}`}>{status}</span>
        </header>
        <Transcript state={state} running={running} />
      </div>
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
    </>
  );
}

/** Mock 03, read-only: the sessions Hivemind started, the selected one's transcript, and its context. */
export function AgentWorkspace() {
  const systemsOn = useSystemsEnabled();
  const picked = useApp((s) => (s.route.page === "agents" ? s.route.session : undefined));
  const go = useApp((s) => s.go);
  const sessions = useQuery({ ...sessionsQuery(), enabled: systemsOn });
  const all = sessions.data ?? [];
  const current = all.find((s) => s.id === picked)?.id ?? picked ?? all[0]?.id;
  const days = useMemo(() => {
    const groups: { day: string; items: SessionInfo[] }[] = [];
    for (const s of all) {
      const day = dayLabel(new Date(s.startedAt).toISOString());
      const last = groups[groups.length - 1];
      if (last?.day === day) last.items.push(s); else groups.push({ day, items: [s] });
    }
    return groups;
  }, [all]);

  return (
    <div className="page fill-page">
      <PageHeader title="Agent Workspace" subtitle="Sessions Hivemind runs for you in the background, with what each was allowed to do." />
      {!systemsOn ? <p className="muted">Agent sessions need a newer Living Memory (one with the <code>systems</code> command).</p>
        : sessions.isLoading ? <p className="muted">Loading…</p>
        : sessions.error ? <p className="error">{String(sessions.error)}</p>
        : !all.length ? (
          <div className="empty-state">
            <p className="muted">No agent sessions yet. Start one from Architecture with “Generate with agent”.</p>
            <ArrowLink onClick={() => go({ page: "architecture" })}>Open Architecture</ArrowLink>
          </div>
        ) : (
          <div className="agents">
            <nav className="session-list" aria-label="Sessions">
              <h2>Sessions</h2>
              {days.map((g) => (
                <div key={g.day}>
                  <div className="session-day">{g.day}</div>
                  {g.items.map((s) => (
                    <button key={s.id} className={`session-item ${s.id === current ? "on" : ""}`} aria-current={s.id === current} onClick={() => openSession(s.id)} title={s.error ?? s.title}>
                      <MessageSquare size="1.3em" aria-hidden /><span className="grow">{s.title}</span>
                      {s.status === "running" && <span className="nav-dot" aria-label="Running" />}
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
