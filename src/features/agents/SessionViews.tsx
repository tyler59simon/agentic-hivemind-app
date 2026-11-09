import { useQuery, useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { agentCancel, agentSession, sessionsQuery, type SeqEvent, type SessionInfo } from "../../lib/agent";
import { toast } from "../../ui/toast";
import { useWorkspace, type Tab } from "../../workspace/store";
import { apply, build, cost, duration, EMPTY, merge, type Finished, type Item, type Transcript as State } from "./events";

const when = (ms: number) => new Date(ms).toLocaleString();
const elapsed = (s: SessionInfo) => duration((s.endedAt ?? Date.now()) - s.startedAt);

function Row({ item }: { item: Item }) {
  switch (item.kind) {
    case "started":
      return <p className="muted small">Claude Code {item.cliVersion ?? ""}{item.model ? ` · ${item.model}` : ""}{item.plugins.length ? ` · plugins: ${item.plugins.join(", ")}` : ""}</p>;
    case "text":
      return <div className="markdown"><Markdown remarkPlugins={[remarkGfm]}>{item.text}</Markdown></div>;
    case "tool":
      return (
        <div className={`tool-line ${item.result && !item.result.ok ? "failed" : ""}`}>
          <span className="badge">{item.name}</span>
          <code title={item.summary}>{item.summary}</code>
          <span className="muted small">{!item.result ? "running…" : item.result.ok ? "done" : "failed"}</span>
          {item.result && !item.result.ok && item.result.summary && <p className="muted small">{item.result.summary}</p>}
        </div>
      );
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
        : finished.result && <div className="markdown small"><Markdown remarkPlugins={[remarkGfm]}>{finished.result}</Markdown></div>}
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
      {state.items.map((item, i) => <Row key={i} item={item} />)}
      {state.finished ? <Outcome finished={state.finished} /> : running && <p className="muted small">Working…</p>}
      <div ref={end} />
    </div>
  );
}

/** One session: its log from disk, kept current by live events. */
export function SessionView({ tab }: { tab: Tab }) {
  const id = tab.session ?? "";
  const client = useQueryClient();
  const log = useQuery({ queryKey: ["agent", "session", id], queryFn: () => agentSession(id, 0), enabled: !!id, staleTime: Infinity, retry: false });
  const sessions = useQuery(sessionsQuery());
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
  const resume = `claude --resume ${info.id}`;
  return (
    <div className="session">
      <header className="card-head">
        <h2>{info.title}</h2>
        <span className={`badge status-${info.status}`}>{state.finished?.status ?? info.status}</span>
        <span className="tabbar-fill" />
        <div className="card-actions">
          {info.task.kind === "system_passport" && <button onClick={() => useWorkspace.getState().openSystem(info.task.slug)}>Open system</button>}
          <button title={`Continue this conversation in a terminal: ${resume}`}
            onClick={() => navigator.clipboard.writeText(resume).then(() => toast("Resume command copied"), () => toast(resume))}>Copy resume command</button>
          {running && <button className="danger-text" onClick={() => agentCancel(info.id).catch((e) => toast(String(e), "error"))}>Cancel</button>}
        </div>
      </header>
      <p className="muted small">
        Started {when(info.startedAt)} · {elapsed(info)}{info.costUsd != null ? ` · ${cost(info.costUsd)}` : ""} · working in <code>{info.workspace[0]}</code>
        {info.workspace.length > 1 && <> with access to {info.workspace.slice(1).map((w) => <code key={w}>{w}</code>)}</>}
      </p>
      <Transcript state={state} running={running} />
    </div>
  );
}

/** Every agent session Hivemind has started, newest first. */
export function SessionsView() {
  const sessions = useQuery(sessionsQuery());
  const open = useWorkspace((s) => s.openSession);
  if (sessions.isLoading) return <p className="muted pad">Loading…</p>;
  if (sessions.error) return <p className="error pad">{String(sessions.error)}</p>;
  const all = sessions.data ?? [];
  return (
    <div className="session">
      <header className="card-head"><h2>Agent sessions</h2><span className="muted small">{all.length}</span></header>
      {!all.length && <p className="muted">No agent sessions yet. Start one from a system's passport with “Generate with agent”.</p>}
      <ul className="card-list">
        {all.map((s) => (
          <li key={s.id}>
            <div className="row-line">
              <span className={`badge status-${s.status}`}>{s.status}</span>
              <button className="link-row" onClick={() => open(s.id, s.title)}>{s.title}</button>
              <span className="tabbar-fill" />
              <span className="muted small">{when(s.startedAt)} · {elapsed(s)}{s.costUsd != null ? ` · ${cost(s.costUsd)}` : ""}</span>
            </div>
            {s.error && <p className="muted small clamp">{s.error}</p>}
          </li>
        ))}
      </ul>
    </div>
  );
}
