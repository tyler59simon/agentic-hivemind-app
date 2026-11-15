import { useQueries, useQuery } from "@tanstack/react-query";
import { CodeXml, Database, FileText, GitBranch, Network, Plus, Square, X } from "lucide-react";
import { useState } from "react";
import { engineOf, reviewFiles, type SessionInfo } from "../../lib/agent";
import { openReview, openSession, openSystem, startSession, useApp } from "../../store";
import { Confirm } from "../../ui/Modal";
import { ArrowLink, Row, Section } from "../../ui/Page";
import { toast } from "../../ui/toast";
import { useWorkspace } from "../../workspace/store";
import { RemoveWorktree } from "../agents/Chat";
import { useSessionDraft } from "../agents/draft";
import { isEnded, repoName, waitingForReview } from "../agents/session";
import { reviewVersion } from "../review/review";
import { noteQuery } from "../viewer/NoteView";
import { termClose } from "../../lib/term";
import * as registry from "./registry";
import { statusLine, tabLabel, terminalTabs } from "./tabs";
import { TerminalView } from "./TerminalView";

const baseName = (path: string) => path.split(/[\\/]/).pop() || path;

const HINT = {
  claude: "Claude Code may ask whether you trust this folder. Every session works in its own new folder, so it can ask each time. Answer in the terminal; Hivemind does not answer for you.",
  codex: "Codex may ask about an update, folder trust or hooks before it starts. Answer in the terminal; Hivemind does not answer for you.",
};

/** "+" and the empty state: a new terminal session of the selected tab's engine. */
function newTerminal(selected?: SessionInfo) {
  const draft = useSessionDraft.getState();
  draft.setInterface("terminal");
  draft.setEngine(selected ? engineOf(selected) : draft.engine);
  startSession();
}

/** The "Stop session" button for the page header; null unless the session's program is running. */
export function StopSession({ session }: { session?: SessionInfo }) {
  const running = registry.useRunning(session ?? { id: "", status: "idle" });
  const [busy, setBusy] = useState(false);
  if (!session || session.interface !== "terminal" || !running) return null;
  const stop = async () => {
    setBusy(true);
    try {
      await termClose(session.id);
    } catch (e) {
      toast(String(e), "error");
    } finally {
      setBusy(false);
    }
  };
  return <button className="outline" disabled={busy} onClick={stop}><Square size="1em" aria-hidden />Stop session</button>;
}

/** What the terminal session works on, what it carries, and what it changed. */
function Rail({ s }: { s: SessionInfo }) {
  const notes = useQueries({ queries: s.context.map((ref) => noteQuery(ref)) });
  const running = registry.useRunning(s);
  const files = useQuery({
    queryKey: ["agent", "review-files", s.id, reviewVersion(s)], queryFn: () => reviewFiles(s.id), enabled: !!s.worktree, staleTime: 0, retry: false,
  });
  const list = files.data ?? [];
  const tree = s.worktree;
  const task = s.task.kind === "work" ? s.task : null;
  return (
    <aside className="split-rail agents-rail term-rail">
      <Section title="Workspace">
        <h3 className="rail-sub">Source</h3>
        {task && <Row icon={<Database size="1.3em" aria-hidden />} title={task.repo}>{repoName(task.repo)}</Row>}
        {tree
          ? <Row icon={<GitBranch size="1.3em" aria-hidden />} title={`Working on ${tree.branch}, created from ${tree.baseBranch}. Folder: ${tree.path}`}>{tree.baseBranch}</Row>
          : <p className="muted small">The worktree was removed.</p>}
      </Section>
      <Section title="Attached context" empty={s.context.length || s.system ? undefined : "No notes attached."}>
        {s.context.map((ref, i) => {
          const title = notes[i]?.data?.title ?? ref.slice(0, 8);
          return <Row key={ref} icon={<FileText size="1.3em" aria-hidden />} onClick={() => useWorkspace.getState().openNote(ref, { title })}>{title}</Row>;
        })}
        {s.system && <Row icon={<Network size="1.3em" aria-hidden />} meta={<ArrowLink onClick={() => openSystem(s.system!)}>Open diagram</ArrowLink>}>Architecture view</Row>}
      </Section>
      {tree && (
        <Section title="Files changed" loading={files.isLoading} error={files.error} empty={list.length ? undefined : "No files changed yet."}>
          {list.slice(0, 8).map((f) => (
            <Row key={f.path} icon={<CodeXml size="1.3em" aria-hidden />} title={`${f.path}  +${f.added} −${f.removed}`}>{baseName(f.path)}</Row>
          ))}
          {list.length > 8 && <p className="muted small">and {list.length - 8} more</p>}
        </Section>
      )}
      {(s.filesChanged?.files ?? 0) > 0 && (
        <div>
          <ArrowLink onClick={() => openReview(s.id)}>Review diff</ArrowLink>
          {running && <p className="muted small">Stop the session to approve the edits.</p>}
        </div>
      )}
      {isEnded(s) && tree && <div className="rail-actions"><RemoveWorktree info={s} /></div>}
    </aside>
  );
}

/** Mock 04: the tab strip, the selected terminal, its status line, and the Workspace rail. `onEmpty` runs when the last tab is closed. */
export function TerminalWorkspace({ sessions, selected, onEmpty }: { sessions: SessionInfo[]; selected?: SessionInfo; onEmpty?: () => void }) {
  const project = useApp((s) => s.project) ?? null;
  const tabs = terminalTabs(sessions, project, selected?.id);
  const [closing, setClosing] = useState<SessionInfo | null>(null);
  const live = registry.useLive(selected?.id ?? "");
  const running = registry.useRunning(selected ?? { id: "", status: "idle" });

  const leave = (s: SessionInfo) => {
    if (s.id !== selected?.id) return;
    const next = tabs.find((t) => t.id !== s.id);
    if (next) openSession(next.id); else onEmpty?.();
  };
  const close = (s: SessionInfo) => {
    if (registry.isRunning(s)) { setClosing(s); return; }
    registry.dispose(s.id);
    leave(s);
  };
  const stopAndClose = (s: SessionInfo) => {
    termClose(s.id).catch((e) => toast(String(e), "error"));
    leave(s);
  };

  if (!selected) {
    return (
      <div className="term-view">
        <div className="term-main">
          <div className="empty-state">
            <p className="muted">No terminals yet. A terminal runs Claude Code or Codex in its own copy of a repository.</p>
            <button className="primary" onClick={() => newTerminal()}>New terminal session</button>
          </div>
        </div>
      </div>
    );
  }

  const line = statusLine(selected, running);
  const over = (selected.status === "ended" || selected.status === "failed") && !running && !!selected.worktree;
  const label = tabLabel(selected);
  const hint = running && !selected.endedAt && !live?.touched;
  return (
    <div className="term-view">
      <div className="term-main">
        <div className="note-tabs standalone term-tabs" role="tablist" aria-label="Terminals">
          {tabs.map((s) => {
            const active = s.id === selected.id;
            return (
              <div key={s.id} role="tab" aria-selected={active} className={`note-tab-pill ${active ? "on" : ""}`} title={`${s.title} · ${s.worktree?.branch ?? "worktree removed"}`}
                onClick={() => openSession(s.id)} onAuxClick={(e) => { if (e.button === 1) close(s); }}>
                <span className="tab-label">{tabLabel(s)}</span>
                <button className="tab-close" aria-label="Close terminal" onClick={(e) => { e.stopPropagation(); close(s); }}><X size="1em" aria-hidden /></button>
              </div>
            );
          })}
          <button className="icon-button" title="New terminal session" aria-label="New terminal session" onClick={() => newTerminal(selected)}><Plus size="1.2em" aria-hidden /></button>
        </div>
        {hint && <p className="term-hint" role="note">{HINT[engineOf(selected)]}</p>}
        <div className="term-box">
          <TerminalView key={selected.id} id={selected.id} sessionId={selected.id} engine={engineOf(selected)} start={selected.status === "idle" ? "fresh" : null} label={label} />
          <div className="term-status" role="status">
            {over && (
              <>
                <button className="primary" disabled={live?.starting} onClick={() => { registry.start(selected.id, "resume"); }}>Resume in terminal</button>
                <button className="text underline" disabled={live?.starting} title="Start the program again with the briefing, as a new conversation" onClick={() => { registry.start(selected.id, "fresh"); }}>Start over</button>
              </>
            )}
            {waitingForReview(selected) && <span className="status-chip waiting">Waiting for review</span>}
            <span className="fill" />
            <span className={`term-dot ${line.tone}`} aria-hidden />
            <span className={line.tone === "failed" ? "failed-text" : undefined}>{line.text}</span>
          </div>
        </div>
      </div>
      <Rail s={selected} />
      {closing && (
        <Confirm title="Close this terminal?" danger action="Close terminal" message="The program in it will be stopped. You can resume the conversation later from the session list."
          onAnswer={(yes) => { const s = closing; setClosing(null); if (yes) stopAndClose(s); }} />
      )}
    </div>
  );
}
