import { useEffect, useRef, useState, type ReactNode } from "react";
import { NewNote } from "../features/editor/NewNote";
import { GraphView } from "../features/graph/GraphView";
import { ActivityView } from "../features/history/HistoryViews";
import { TaxonomyView } from "../features/taxonomy/TaxonomyView";
import { NoteTab } from "../features/editor/NoteTab";
import { Confirm } from "../ui/Modal";
import { MAX_PANES, useWorkspace, type Pane, type Tab } from "./store";

/** What a tab shows. Kinds register here as their phase lands. */
export const TAB_VIEWS: Partial<Record<Tab["kind"], (tab: Tab) => ReactNode>> = {
  note: (tab) => <NoteTab tab={tab} />,
  "new-note": (tab) => <NewNote key={tab.id} tab={tab} />,
  graph: () => <GraphView />,
  activity: () => <ActivityView />,
  taxonomy: () => <TaxonomyView />,
};

const KIND_LABEL: Record<Tab["kind"], string> = { note: "Note", "new-note": "New note", graph: "Graph", activity: "Activity", taxonomy: "Tags" };
const label = (tab: Tab) => (tab.kind === "note" ? tab.title || tab.ref?.split(":")[1]?.slice(0, 8) || "Note"
  : tab.kind === "new-note" ? tab.title || "New note" : KIND_LABEL[tab.kind]);

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

function PaneView({ pane, focused, onClose }: { pane: Pane; focused: boolean; onClose: (paneId: string, tabId: string) => void }) {
  const { activate, focus, split, panes } = useWorkspace();
  const dirty = useWorkspace((s) => s.dirty);
  const active = pane.tabs.find((t) => t.id === pane.active) ?? pane.tabs[0];
  const view = active && TAB_VIEWS[active.kind];
  const strip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    strip.current?.querySelector(".tab.on")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active?.id, pane.tabs.length]);
  return (
    <section className={`pane ${focused ? "focused" : ""}`} onMouseDown={() => !focused && focus(pane.id)}>
      <div className="tabbar" role="tablist" ref={strip} onWheel={(e) => { if (e.deltaY) e.currentTarget.scrollLeft += e.deltaY; }}>
        {pane.tabs.map((t) => (
          <div key={t.id} role="tab" aria-selected={t.id === active?.id} className={`tab ${t.id === active?.id ? "on" : ""}`}
            onClick={() => activate(pane.id, t.id)} onAuxClick={(e) => { if (e.button === 1) onClose(pane.id, t.id); }} title={label(t)}>
            <span className="tab-label">{label(t)}</span>
            {dirty[t.id] && <span className="dot" aria-label="unsaved">●</span>}
            <button className="tab-close" aria-label="Close tab" onClick={(e) => { e.stopPropagation(); onClose(pane.id, t.id); }}>×</button>
          </div>
        ))}
        <span className="tabbar-fill" />
        {panes.length < MAX_PANES && <button className="ghost small" title="Split (Ctrl+\)" onClick={() => { focus(pane.id); split(); }}>Split</button>}
      </div>
      <div className="pane-body">
        {active && view ? view(active) : (
          <div className="center muted"><p>Select a note, or press <kbd>Ctrl</kbd>+<kbd>O</kbd> to jump to one.</p></div>
        )}
      </div>
    </section>
  );
}

export function Workspace() {
  const panes = useWorkspace((s) => s.panes);
  const focused = useWorkspace((s) => s.focused);
  const close = useCloseTab();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const ws = useWorkspace.getState();
      const pane = ws.panes.find((p) => p.id === ws.focused) ?? ws.panes[0];
      if (e.key.toLowerCase() === "w") { e.preventDefault(); if (pane?.active) close.request(pane.id, pane.active); }
      else if (e.key === "Tab") { e.preventDefault(); ws.cycle(e.shiftKey ? -1 : 1); }
      else if (e.key === "\\") { e.preventDefault(); ws.split(); }
      else if (e.key.toLowerCase() === "n" && !e.shiftKey) { e.preventDefault(); ws.openTab({ kind: "new-note" }); }
      else if (e.key.toLowerCase() === "g" && !e.shiftKey) { e.preventDefault(); ws.openTab({ kind: "graph" }); }
      else if (e.key.toLowerCase() === "a" && e.shiftKey) { e.preventDefault(); ws.openTab({ kind: "activity" }); }
      else if (e.key.toLowerCase() === "e") {
        e.preventDefault();
        const tab = pane?.tabs.find((t) => t.id === pane.active);
        if (tab?.kind === "note") ws.updateTab(tab.id, { mode: tab.mode === "reading" || !tab.mode ? "live" : "reading" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);
  return (
    <div className="workspace">
      {panes.map((p) => <PaneView key={p.id} pane={p} focused={p.id === focused || panes.length === 1} onClose={close.request} />)}
      {close.dialog}
    </div>
  );
}
