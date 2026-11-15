import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRightLeft, CodeXml, Columns2, Database, FileText, GitBranch, Network, Plus, Square, SquareTerminal, X } from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { agentRename, engineOf, reviewFiles, type SessionInfo } from "../../lib/agent";
import { OTHER_FOLDERS, otherFolders, realProject } from "../../lib/folders";
import { openReview, openSession, openSystem, startSession, useApp } from "../../store";
import { Menu } from "../../ui/Menu";
import { Confirm } from "../../ui/Modal";
import { ArrowLink, Row, Section } from "../../ui/Page";
import { toast } from "../../ui/toast";
import { useWorkspace } from "../../workspace/store";
import { RemoveWorktree } from "../agents/Chat";
import { useSessionDraft } from "../agents/draft";
import { isEnded, repoName, waitingForReview } from "../agents/session";
import { reviewVersion } from "../review/review";
import { useCurrentProject } from "../projects/useProject";
import { noteQuery } from "../viewer/NoteView";
import { termClose, termList, type ShellTarget } from "../../lib/term";
import { closeTab, focusPane, moveTab, openIn, paneOf, reconcile, toggleSplit, update, useLayout, type Pane } from "./layout";
import * as registry from "./registry";
import { isShellId, NO_SHELL_PLACE, shellLabel, shellPlaces, shellStatus, shellTitle, type ShellTab } from "./shells";
import { statusLine, tabLabel, terminalTabs, whereLabel } from "./tabs";
import { TerminalView } from "./TerminalView";

const baseName = (path: string) => path.split(/[\\/]/).pop() || path;

/** A tab is an agent session or a PowerShell tab. */
type Tab = SessionInfo | ShellTab;
const isShell = (t: Tab): t is ShellTab => "shell" in t;
const tabText = (t: Tab) => (isShell(t) ? shellLabel(t) : tabLabel(t));

/** Open a PowerShell tab; the registry keeps its terminal, the layout gets the id. A failure (the tab limit, a folder that is gone) is shown as a toast. */
async function openShell(target: ShellTarget, onOpen: (id: string) => void) {
  try { onOpen(await registry.openShell(target)); } catch (e) { toast(String(e), "error"); }
}

const HINT = {
  claude: "Claude Code may ask whether you trust this folder, once per repository. Answer in the terminal; Hivemind does not answer for you.",
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
          : s.direct
            ? <Row icon={<GitBranch size="1.3em" aria-hidden />} title={`Works in your own files, not in a copy. Folder: ${s.direct.path}`}>{whereLabel(s)}</Row>
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

const DRAG_PX = 6;

/** The tab's label as an input: Enter or blur saves, Escape cancels. It never starts a drag of the pill. */
function RenameInput({ s, onDone }: { s: SessionInfo; onDone: () => void }) {
  const client = useQueryClient();
  const start = s.name ?? tabLabel(s);
  const [value, setValue] = useState(start);
  const finished = useRef(false);
  const finish = (save: boolean) => {
    if (finished.current) return;
    finished.current = true;
    onDone();
    if (!save || value.trim() === start.trim()) return;
    agentRename(s.id, value)
      .then(() => client.invalidateQueries({ queryKey: ["agent", "sessions"] }))
      .catch((e) => toast(String(e), "error"));
  };
  return (
    <input className="tab-rename" autoFocus value={value} maxLength={80} aria-label="Tab name" onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setValue(e.target.value)} onBlur={() => finish(true)}
      onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => { if (e.key === "Enter") finish(true); else if (e.key === "Escape") finish(false); }} />
  );
}

interface Drag { id: string; label: string; x: number; y: number; over: Pane | null }

/** One pane: its tab strip, the active tab's terminal and its status line. */
function PaneView({ index, tabs, activeId, focused, split, over, onFocus, onToggleSplit, onNew, onShell, onTab, onClose, onMove, onDragStart, clicked }: {
  index: Pane; tabs: Tab[]; activeId: string | null; focused: boolean; split: boolean; over: boolean;
  onFocus: () => void; onToggleSplit: () => void; onNew: (active?: SessionInfo) => void; onShell: (target: ShellTarget) => void;
  onTab: (t: Tab) => void; onClose: (t: Tab) => void; onMove: (t: Tab) => void;
  onDragStart: (e: ReactPointerEvent, t: Tab) => void; clicked: () => boolean;
}) {
  const active = tabs.find((t) => t.id === activeId);
  const session = active && !isShell(active) ? active : undefined;
  const shell = active && isShell(active) ? active : undefined;
  const [renaming, setRenaming] = useState<string | null>(null);
  const live = registry.useLive(active?.id ?? "");
  const running = registry.useRunning(session ?? (shell ? { id: shell.id, status: shell.running ? "running" : "ended" } : { id: "", status: "idle" }));
  const line = session ? statusLine(session, running) : shell ? shellStatus({ running, exitCode: shell.exitCode }) : null;
  const ended = !!session && (session.status === "ended" || session.status === "failed") && !running && !!session.worktree;
  const hint = !!session && running && !session.endedAt && !live?.touched;
  const splitWord = split ? "Close the second pane" : "Split into two panes";
  const project = useApp((s) => s.project) ?? null;
  const { project: current } = useCurrentProject();
  const folders = useQuery({ queryKey: ["settings", "other-folders"], queryFn: otherFolders, enabled: project === OTHER_FOLDERS, staleTime: 0 });
  const places = shellPlaces({ session: session?.id ?? null, project: realProject(project), repo: current?.repos[0] ?? null, other: project === OTHER_FOLDERS, folders: folders.data ?? [] });
  return (
    <div className={`term-pane ${focused && split ? "focused" : ""}`} data-pane={index} onPointerDownCapture={onFocus}>
      <div className="term-bar">
      <div className={`note-tabs standalone term-tabs ${over ? "drop" : ""}`} role="tablist" aria-label={split ? `Terminals, pane ${index + 1}` : "Terminals"}>
        {tabs.map((s) => {
          const on = s.id === activeId;
          const title = isShell(s) ? shellTitle(s) : `${s.title} · ${whereLabel(s)}`;
          return (
            <div key={s.id} role="tab" aria-selected={on} className={`note-tab-pill ${on ? "on" : ""}`} title={title}
              onPointerDown={(e) => onDragStart(e, s)}
              onClick={() => { if (!clicked()) onTab(s); }} onAuxClick={(e) => { if (e.button === 1) onClose(s); }}>
              {isShell(s) ? <span className="tab-label">{shellLabel(s)}</span>
                : renaming === s.id
                  ? <RenameInput s={s} onDone={() => setRenaming(null)} />
                  : <span className="tab-label" onDoubleClick={() => setRenaming(s.id)}>{tabLabel(s)}</span>}
              {!isShell(s) && <button className="tab-close tab-move" aria-label="Open PowerShell here" title="Open PowerShell here" onClick={(e) => { e.stopPropagation(); onShell({ session: s.id }); }}><SquareTerminal size="1em" aria-hidden /></button>}
              {split && <button className="tab-close tab-move" aria-label="Move to other pane" title="Move to other pane" onClick={(e) => { e.stopPropagation(); onMove(s); }}><ArrowRightLeft size="1em" aria-hidden /></button>}
              <button className="tab-close" aria-label="Close terminal" onClick={(e) => { e.stopPropagation(); onClose(s); }}><X size="1em" aria-hidden /></button>
            </div>
          );
        })}
      </div>
        <Menu className="icon-menu" label="New terminal" button={<Plus size="1.2em" aria-hidden />}>
          {(close) => (
            <>
              <li role="none"><button role="menuitem" onClick={() => { close(); onNew(session); }}>Agent session…</button></li>
              {places.length === 0 && <li role="none"><button role="menuitem" disabled title={NO_SHELL_PLACE}>PowerShell here</button></li>}
              {places.length === 1 && places[0].label === "PowerShell here" && <li role="none"><button role="menuitem" onClick={() => { close(); onShell(places[0].target); }}>PowerShell here</button></li>}
              {places.length > 0 && places[0].label !== "PowerShell here" && (
                <>
                  <li className="menu-label" role="none">PowerShell in</li>
                  {places.map((p) => <li key={p.label + JSON.stringify(p.target)} role="none"><button role="menuitem" title={"folder" in p.target ? p.target.folder : undefined} onClick={() => { close(); onShell(p.target); }}>{p.label}</button></li>)}
                </>
              )}
            </>
          )}
        </Menu>
        <button className={`icon-button ${split ? "on" : ""}`} title={splitWord} aria-label={splitWord} aria-pressed={split} onClick={onToggleSplit}><Columns2 size="1.2em" aria-hidden /></button>
      </div>
      {hint && <p className="term-hint" role="note">{HINT[engineOf(session)]}</p>}
      <div className="term-box">
        {active && line ? (
          <>
            {shell
              ? <TerminalView key={shell.id} id={shell.id} sessionId={null} engine={null} start={null} shell label={shellLabel(shell)} focused={focused} />
              : session && <TerminalView key={session.id} id={session.id} sessionId={session.id} engine={engineOf(session)} start={session.status === "idle" ? "fresh" : null} label={tabLabel(session)} focused={focused} />}
            <div className="term-status" role="status">
              {ended && session && (
                <>
                  <button className="primary" disabled={live?.starting} onClick={() => { registry.start(session.id, "resume"); }}>Resume in terminal</button>
                  <button className="text underline" disabled={live?.starting} title="Start the program again with the briefing, as a new conversation" onClick={() => { registry.start(session.id, "fresh"); }}>Start over</button>
                </>
              )}
              {session && waitingForReview(session) && <span className="status-chip waiting">Waiting for review</span>}
              <span className="fill" />
              <span className={`term-dot ${line.tone}`} aria-hidden />
              <span className={line.tone === "failed" ? "failed-text" : undefined}>{line.text}</span>
            </div>
          </>
        ) : (
          <p className="muted pad">No terminal in this pane. Move a tab here, or start one with the plus button.</p>
        )}
      </div>
    </div>
  );
}

/** Mock 04: one or two panes of tabs and terminals, and the Workspace rail. `onEmpty` runs when the last tab is closed. */
export function TerminalWorkspace({ sessions, selected, onEmpty }: { sessions: SessionInfo[]; selected?: SessionInfo; onEmpty?: () => void }) {
  const project = useApp((s) => s.project) ?? null;
  const stored = useLayout();
  // Tabs closed here stay in the session list until it is refetched; they must not come back as new tabs meanwhile.
  const closed = useRef(new Set<string>());
  const sessionTabs = terminalTabs(sessions, project, selected?.id, [...stored.panes[0], ...stored.panes[1]]).filter((s) => s.id === selected?.id || !closed.current.has(s.id));
  // Running shells come from `term_list`; the registry keeps them (and the ones that exited) from then on.
  const shellList = useQuery({ queryKey: ["term", "list"], queryFn: termList, staleTime: 0, refetchOnWindowFocus: false, retry: false });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (shellList.isFetched) registry.loadShells(shellList.data ?? []); }, [shellList.isFetched, shellList.dataUpdatedAt]);
  const shells = registry.useShells();
  const tabs: Tab[] = [...sessionTabs, ...shells.tabs];
  // Until the shell list has arrived, a stored shell id is kept: reconcile would drop it as unknown.
  const waiting = shells.loaded ? [] : [...stored.panes[0], ...stored.panes[1]].filter(isShellId);
  const view = reconcile(stored, [...tabs.map((t) => t.id), ...waiting]);
  const byId = (id: string | null) => tabs.find((t) => t.id === id);
  const sessionById = (id: string | null) => sessionTabs.find((t) => t.id === id);
  const [closing, setClosing] = useState<Tab | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragged = useRef(false);

  // The view is derived on every render, so nothing flickers; this keeps the store in step with it.
  useEffect(() => { if (view !== stored) update(() => view); });
  // A session opened from elsewhere shows in its pane and takes the focus.
  const selectedId = selected?.id;
  useEffect(() => {
    if (!selectedId) return;
    closed.current.delete(selectedId);
    update((m) => openIn(m, selectedId));
  }, [selectedId]);

  // The rail shows the focused pane's session; a PowerShell tab has none, so it shows no rail.
  const focusedTab = byId(view.active[view.focus]);
  const railSession = focusedTab ? sessionById(focusedTab.id) : selected;
  // The page's own selection follows session tabs only; a shell id is not a session.
  const select = (id: string) => { if (sessionById(id)) openSession(id); };

  const leave = (s: Tab) => {
    closed.current.add(s.id);
    const was = paneOf(view, s.id);
    const after = closeTab(view, s.id);
    update(() => after);
    if (s.id !== selected?.id) return;
    const next = (was !== null ? after.active[was] : null) ?? after.active[after.focus] ?? after.active[0] ?? after.active[1];
    if (next) update((m) => openIn(m, next));
    // Only a session can be the page's selection: with a shell left, the page goes to its empty terminal view.
    if (next && sessionById(next)) openSession(next); else onEmpty?.();
  };
  const close = (s: Tab) => {
    if (isShell(s)) {
      if (registry.isRunning({ id: s.id, status: s.running ? "running" : "ended" })) { setClosing(s); return; }
      registry.dispose(s.id);
      leave(s);
      return;
    }
    if (registry.isRunning(s)) { setClosing(s); return; }
    // With nothing running, term_close ends a session that never started, so its tab goes and its worktree can be removed.
    if (s.status === "idle") termClose(s.id).catch((e) => toast(String(e), "error"));
    registry.dispose(s.id);
    leave(s);
  };
  const stopAndClose = (s: Tab) => {
    termClose(s.id).catch((e) => toast(String(e), "error"));
    if (isShell(s)) registry.dispose(s.id);
    leave(s);
  };
  const show = (s: Tab) => { update((m) => openIn(m, s.id)); select(s.id); };
  const focusOn = (pane: Pane) => {
    if (view.focus === pane) return;
    update((m) => focusPane(m, pane));
    const a = view.active[pane];
    if (a && a !== selected?.id) select(a);
  };
  const moveOther = (s: Tab) => {
    const from = paneOf(view, s.id);
    if (from === null) return;
    update((m) => moveTab(m, s.id, from === 0 ? 1 : 0));
    select(s.id);
  };
  /** A PowerShell tab in the pane that asked, right after its start. */
  const shellIn = (pane: Pane, target: ShellTarget) => {
    focusOn(pane);
    return openShell(target, (id) => update((m) => openIn(m, id)));
  };

  /** Pointer events, not HTML5 drag and drop: Tauri's file-drop handling swallows `dragover` and `drop` in WebView2. */
  const startDrag = (e: ReactPointerEvent, s: Tab) => {
    if (e.button !== 0 || !view.split || (e.target as HTMLElement).closest("button")) return;
    const x0 = e.clientX, y0 = e.clientY;
    let moving = false;
    const at = (x: number, y: number): Pane | null => {
      const n = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-pane]")?.dataset.pane;
      return n === "0" ? 0 : n === "1" ? 1 : null;
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
    };
    const move = (ev: PointerEvent) => {
      if (!moving && Math.hypot(ev.clientX - x0, ev.clientY - y0) < DRAG_PX) return;
      moving = true;
      setDrag({ id: s.id, label: tabText(s), x: ev.clientX, y: ev.clientY, over: at(ev.clientX, ev.clientY) });
    };
    const up = (ev: PointerEvent) => {
      stop();
      setDrag(null);
      if (!moving) return;
      // The click that follows this pointerup must not select the tab.
      dragged.current = true;
      window.setTimeout(() => { dragged.current = false; }, 0);
      const to = at(ev.clientX, ev.clientY);
      if (to !== null && paneOf(view, s.id) !== to) { update((m) => moveTab(m, s.id, to)); select(s.id); }
    };
    const cancel = () => { stop(); setDrag(null); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
  };

  if (!focusedTab && !selected) {
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

  const panes: Pane[] = view.split ? [0, 1] : [0];
  return (
    <div className={`term-view ${drag ? "dragging" : ""} ${railSession ? "" : "no-rail"}`}>
      <div className="term-main">
        <div className="term-panes">
          {panes.map((i) => (
            <PaneView key={i} index={i} tabs={view.panes[i].map(byId).filter((t): t is Tab => !!t)} activeId={view.active[i]}
              focused={view.focus === i} split={view.split} over={drag?.over === i && paneOf(view, drag.id) !== i}
              onFocus={() => focusOn(i)} onToggleSplit={() => update(toggleSplit)} onNew={(a) => { focusOn(i); newTerminal(a ?? railSession); }} onShell={(t) => { void shellIn(i, t); }}
              onTab={show} onClose={close} onMove={moveOther} onDragStart={startDrag} clicked={() => dragged.current} />
          ))}
        </div>
      </div>
      {railSession && <Rail s={railSession} />}
      {closing && (
        <Confirm title="Close this terminal?" danger action="Close terminal" message={isShellId(closing.id) ? "PowerShell and anything running in it will be stopped." : "The program in it will be stopped. You can resume the conversation later from the session list."}
          onAnswer={(yes) => { const s = closing; setClosing(null); if (yes) stopAndClose(s); }} />
      )}
      {drag && <div className="term-drag" style={{ left: drag.x + 8, top: drag.y + 8 }}>{drag.label}</div>}
    </div>
  );
}
