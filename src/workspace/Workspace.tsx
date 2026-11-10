import { Columns2, Library, PanelRight, Plus, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { NewNote } from "../features/editor/NewNote";
import { NoteTab } from "../features/editor/NoteTab";
import { useApp } from "../store";
import { Confirm } from "../ui/Modal";
import { MAX_PANES, useWorkspace, type Pane, type Tab } from "./store";

/** What a tab shows. */
export const TAB_VIEWS: Record<Tab["kind"], (tab: Tab) => ReactNode> = {
  note: (tab) => <NoteTab tab={tab} />,
  "new-note": (tab) => <NewNote key={tab.id} tab={tab} />,
};

const label = (tab: Tab) => (tab.kind === "note" ? tab.title || tab.ref?.split(":")[1]?.slice(0, 8) || "Note" : tab.title || "New note");

/** Close a tab, asking first when it holds unsaved edits. */
export function useCloseTab() {
  const [asking, setAsking] = useState<{ paneId: string; tabId: string } | null>(null);
  const closeTab = useWorkspace((s) => s.closeTab);
  const request = (paneId: string, tabId: string) => {
    if (useWorkspace.getState().dirty[tabId]) setAsking({ paneId, tabId });
    else closeTab(paneId, tabId);
  };
  const dialog = asking && (
    <Confirm title="Discard unsaved changes?" danger action="Discard"
      message="This tab has edits that are not saved to Living Memory. A draft is kept until you discard it."
      onAnswer={(yes) => { if (yes) closeTab(asking.paneId, asking.tabId); setAsking(null); }} />
  );
  return { request, dialog };
}

function TabPill({ tab, active, onPick, onClose }: { tab: Tab; active: boolean; onPick: () => void; onClose: () => void }) {
  const dirty = useWorkspace((s) => !!s.dirty[tab.id]);
  return (
    <div role="tab" aria-selected={active} className={`note-tab-pill ${active ? "on" : ""}`} title={label(tab)}
      onClick={onPick} onAuxClick={(e) => { if (e.button === 1) onClose(); }}>
      <span className="tab-label">{label(tab)}</span>
      {dirty && <span className="dot" aria-label="unsaved">●</span>}
      <button className="tab-close" aria-label="Close tab" onClick={(e) => { e.stopPropagation(); onClose(); }}><X size="1em" aria-hidden /></button>
    </div>
  );
}

/** The pinned first tab: back to the library, where notes are found. */
function LibraryPill({ active }: { active: boolean }) {
  const go = useApp((s) => s.go);
  return (
    <button role="tab" aria-selected={active} className={`note-tab-pill library ${active ? "on" : ""}`} onClick={() => go({ page: "memory" })}>
      <Library size="1.1em" aria-hidden /><span className="tab-label">Library</span>
    </button>
  );
}

const newNote = () => useWorkspace.getState().openTab({ kind: "new-note" });

function PaneView({ pane, focused, first, last, onClose }: {
  pane: Pane; focused: boolean; first: boolean; last: boolean; onClose: (paneId: string, tabId: string) => void;
}) {
  const { activate, focus, split, panes, rail, setRail } = useWorkspace();
  const active = pane.tabs.find((t) => t.id === pane.active) ?? pane.tabs[0];
  const strip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    strip.current?.querySelector(".note-tab-pill.on")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active?.id, pane.tabs.length]);
  return (
    <section className={`pane ${focused ? "focused" : ""}`} onMouseDown={() => !focused && focus(pane.id)}>
      <div className="note-tabs" role="tablist" ref={strip} onWheel={(e) => { if (e.deltaY) e.currentTarget.scrollLeft += e.deltaY; }}>
        {first && <LibraryPill active={false} />}
        {pane.tabs.map((t) => <TabPill key={t.id} tab={t} active={t.id === active?.id} onPick={() => activate(pane.id, t.id)} onClose={() => onClose(pane.id, t.id)} />)}
        <button className="icon-button" title="New note (Ctrl+N)" aria-label="New note" onClick={() => { focus(pane.id); newNote(); }}><Plus size="1.2em" aria-hidden /></button>
        <span className="fill" />
        {last && (
          <>
            {panes.length < MAX_PANES && (
              <button className="icon-button" title="Open this note side by side (Ctrl+\)" aria-label="Split" onClick={() => { focus(pane.id); split(); }}><Columns2 size="1.2em" aria-hidden /></button>
            )}
            <button className={`icon-button ${rail ? "on" : ""}`} title={rail ? "Hide the context rail" : "Show connections, history and outline"} aria-label="Context rail" aria-pressed={rail}
              onClick={() => setRail(!rail)}><PanelRight size="1.2em" aria-hidden /></button>
          </>
        )}
      </div>
      <div className="pane-body">
        {active ? TAB_VIEWS[active.kind](active) : (
          <div className="center muted"><p>Open a note here: Ctrl+click a link, or press <kbd>Ctrl</kbd>+<kbd>O</kbd>.</p></div>
        )}
      </div>
    </section>
  );
}

/** The open notes above the library, so a note is one click away while you browse. */
export function OpenTabs() {
  const panes = useWorkspace((s) => s.panes);
  const activate = useWorkspace((s) => s.activate);
  const go = useApp((s) => s.go);
  const close = useCloseTab();
  return (
    <div className="note-tabs standalone" role="tablist">
      <LibraryPill active />
      {panes.flatMap((p) => p.tabs.map((t) => (
        <TabPill key={t.id} tab={t} active={false} onClose={() => close.request(p.id, t.id)}
          onPick={() => { activate(p.id, t.id); go({ page: "memory", view: "notes" }); }} />
      )))}
      <button className="icon-button" title="New note (Ctrl+N)" aria-label="New note" onClick={newNote}><Plus size="1.2em" aria-hidden /></button>
      {close.dialog}
    </div>
  );
}

/** The open notes: one pane, or up to three side by side, each with its own tabs. */
export function Workspace() {
  const panes = useWorkspace((s) => s.panes);
  const focused = useWorkspace((s) => s.focused);
  const close = useCloseTab();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const ws = useWorkspace.getState();
      const pane = ws.panes.find((p) => p.id === ws.focused) ?? ws.panes[0];
      if (e.key.toLowerCase() === "w") { if (pane?.active) close.request(pane.id, pane.active); }
      else if (e.key === "Tab") { e.preventDefault(); ws.cycle(e.shiftKey ? -1 : 1); }
      else if (e.key === "\\") { e.preventDefault(); ws.split(); }
      else if (e.key.toLowerCase() === "e") {
        e.preventDefault();
        const tab = pane?.tabs.find((t) => t.id === pane.active);
        if (tab?.kind === "note") ws.updateTab(tab.id, { mode: tab.mode === "live" ? "reading" : "live" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);
  return (
    <div className="workspace">
      {panes.map((p, i) => (
        <PaneView key={p.id} pane={p} focused={p.id === focused || panes.length === 1} first={i === 0} last={i === panes.length - 1} onClose={close.request} />
      ))}
      {close.dialog}
    </div>
  );
}
