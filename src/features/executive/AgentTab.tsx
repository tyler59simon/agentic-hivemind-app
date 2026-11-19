// The executive assistant: a chat with Claude Code or Codex that starts from the evidence (projects, commitments,
// milestones, decisions, risks) and may read Living Memory, but not write to it. When a conversation ends, what it
// decided and committed to goes to the capture inbox for review.
import { useQuery } from "@tanstack/react-query";
import { Inbox, LoaderCircle, MessageSquare, Plus, Square } from "lucide-react";
import { useState } from "react";
import { agentEnd, sessionsQuery, type Engine, type SessionInfo } from "../../lib/agent";
import { agentStart, sessionCapture } from "../../lib/executive";
import type { Project } from "../../lib/lm";
import { openExecutive } from "../../store";
import { Section } from "../../ui/Page";
import { toast } from "../../ui/toast";
import { Transcript, useTranscript } from "../agents/AgentWorkspace";
import { Composer } from "../agents/Chat";
import { useShownEngines } from "../agents/engines";
import { engineLabel, isEnded } from "../agents/session";

export const SUGGESTIONS = [
  "What needs my attention this week?",
  "Which commitments are overdue, and who owns them?",
  "Summarize the open risks and what we are doing about each.",
  "What did we decide in the last two weeks, and why?",
];

const isExecutive = (s: SessionInfo) => s.task.kind === "executive";

/** Start a conversation, then open it. Shared by this tab and the Today box. */
export async function ask(project: Project | undefined, prompt: string, engine: Engine) {
  const info = await agentStart(project?.slug ?? null, prompt, { engine });
  openExecutive({ tab: "agent", session: info.id });
}

function NewConversation({ project }: { project?: Project }) {
  const engines = useShownEngines();
  const [text, setText] = useState("");
  const [engine, setEngine] = useState<Engine | undefined>();
  const [busy, setBusy] = useState(false);
  const chosen = engine && engines.shows(engine) ? engine : engines.first;
  const start = async (prompt: string) => {
    if (!prompt.trim() || !chosen) return;
    setBusy(true);
    try { await ask(project, prompt, chosen); }
    catch (e) { toast(String(e), "error"); }
    finally { setBusy(false); }
  };
  return (
    <div className="exec-form exec-ask">
      <h2>Ask about {project?.name ?? "your projects"}</h2>
      <p className="muted small">The assistant starts with your projects' health, milestones, commitments, decisions and risks, and can search Living Memory for more. It cites what it uses and says when something is not known. It cannot change your records: when the conversation ends, what it decided waits for you in the capture inbox.</p>
      <textarea rows={4} autoFocus value={text} placeholder="Ask anything about your projects" disabled={busy} onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); start(text); } }} />
      <div className="exec-chips">{SUGGESTIONS.map((s) => <button key={s} className="chip" disabled={busy} onClick={() => start(s)}>{s}</button>)}</div>
      <div className="actions">
        {engines.shown.length > 1 && (
          <select aria-label="Engine" value={chosen} onChange={(e) => setEngine(e.target.value as Engine)} disabled={busy}>
            {engines.shown.map((e) => <option key={e} value={e}>{e === "codex" ? "Codex" : "Claude Code"}</option>)}
          </select>
        )}
        <button className="primary" disabled={busy || !text.trim() || !chosen} onClick={() => start(text)} title="Ctrl+Enter">
          {busy ? <><LoaderCircle className="spin" size="1em" aria-hidden /> Starting</> : <><MessageSquare size="1em" aria-hidden /> Ask</>}
        </button>
      </div>
      {chosen === "codex" && <p className="muted small">Codex has no rule that stops a memory write; its read-only sandbox is the only guard, and it may refuse Living Memory reads too.</p>}
    </div>
  );
}

function Conversation({ id }: { id: string }) {
  const { log, state } = useTranscript(id);
  const sessions = useQuery(sessionsQuery());
  const [capturing, setCapturing] = useState(false);
  const info = sessions.data?.find((s) => s.id === id) ?? log.data?.info;
  if (log.isLoading) return <p className="muted pad">Loading…</p>;
  if (log.error || !info) return <p className="error pad">{String(log.error ?? "This conversation is no longer in the history.")}</p>;
  const status = state.finished?.status ?? info.status;
  const live = { ...info, status };
  const running = status === "running";
  const captureNow = async () => {
    setCapturing(true);
    try {
      const batch = await sessionCapture(id);
      if (batch) openExecutive({ capture: batch.id, tab: "agent", session: id });
      else toast("Nothing to capture from this conversation yet.");
    } catch (e) { toast(String(e), "error"); }
    finally { setCapturing(false); }
  };
  return (
    <div className="chat-thread">
      <header className="chat-head">
        <h2>{info.title.replace(/^Executive: /, "")}</h2>
        <span className={`status-chip cap ${status === "idle" ? "active" : status === "ended" ? "" : status}`}>{status === "idle" ? "ready" : status}</span>
        <span className="muted small">{engineLabel(info)}</span>
        <span className="grow" />
        <button onClick={captureNow} disabled={capturing || running || info.turns === 0} title="Pull decisions, commitments and risks out of this conversation for review">
          {capturing ? <LoaderCircle className="spin" size="1em" aria-hidden /> : <Inbox size="1em" aria-hidden />} Capture
        </button>
        {!isEnded(live) && <button onClick={() => agentEnd(id).catch((e) => toast(String(e), "error"))} title="End it; its decisions go to the capture inbox"><Square size="1em" aria-hidden /> End</button>}
      </header>
      <div className="chat-scroll">
        <Transcript state={state} running={running} chat={{ sessionId: info.id, engine: engineLabel(info), chip: null }} />
      </div>
      {isEnded(live)
        ? <p className="muted pad">This conversation has ended. <button className="link" onClick={() => openExecutive({ tab: "agent" })}>Start another</button></p>
        : <Composer info={live} transcript={state} />}
    </div>
  );
}

export function AgentTab({ project, picked }: { project?: Project; picked?: string }) {
  const sessions = useQuery(sessionsQuery());
  const mine = (sessions.data ?? []).filter(isExecutive).filter((s) => !project || s.project === project.slug).sort((a, b) => b.startedAt - a.startedAt);
  const shown = picked && mine.some((s) => s.id === picked) ? picked : undefined;
  return (
    <div className="exec-comms">
      <aside className="exec-drafts">
        <button className="primary" onClick={() => openExecutive({ tab: "agent" })}><Plus size="1em" aria-hidden /> New conversation</button>
        <Section title="Conversations" count={mine.length} loading={sessions.isLoading} empty={mine.length ? undefined : "None yet."}>
          <ul className="item-list">
            {mine.map((s) => (
              <li key={s.id}>
                <button className={`item-row ${s.id === shown ? "on" : ""}`} onClick={() => openExecutive({ tab: "agent", session: s.id })}>
                  <span className="grow">{s.title.replace(/^Executive: /, "")}<br /><span className="muted small">{new Date(s.startedAt).toLocaleString()} · {s.status === "idle" ? "ready" : s.status}</span></span>
                </button>
              </li>
            ))}
          </ul>
        </Section>
      </aside>
      <div className="exec-comms-main exec-chat">{shown ? <Conversation key={shown} id={shown} /> : <NewConversation project={project} />}</div>
    </div>
  );
}
