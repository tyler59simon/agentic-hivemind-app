import { Columns2, LayoutPanelTop, Library, PanelRight, Plus, X } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { NewNote } from "../features/editor/NewNote";
import { NoteTab } from "../features/editor/NoteTab";
import { FileTab, saveFileTab } from "../features/notes/FileTab";
import { NewFileTab } from "../features/notes/NewFileTab";
import { keyOf } from "../documents/store";
import { newPageHere } from "../features/notes/actions";
import { fileName, isMarkdown, isRichDoc, pageTitle } from "../lib/notebooks";
import { useApp } from "../store";
import { Confirm } from "../ui/Modal";
import { MAX_PANES, railShown, useWorkspace, type Pane, type Tab } from "./store";

/** What a tab shows. */
export const TAB_VIEWS: Record<Tab["kind"], (tab: Tab) => ReactNode> = {
  note: (tab) => <NoteTab tab={tab} />,
  "new-note": (tab) => <NewNote key={tab.id} tab={tab} />,
  file: (tab) => <FileTab key={tab.id} tab={tab} />,
  "new-file": (tab) => <NewFileTab key={tab.id} tab={tab} />,
};

const label = (tab: Tab) => (tab.kind === "note" ? tab.title || tab.ref?.split(":")[1]?.slice(0, 8) || "Note"
  : tab.kind === "file" ? tab.title || pageTitle(tab.file?.path ?? "") || "Page"
  : tab.kind === "new-file" ? tab.title || "Untitled" : tab.title || "New note");

/** Close a tab, asking first when it holds unsaved edits. */
export function useCloseTab() {
  const [asking, setAsking] = useState<{ paneId: string; tabId: string; file?: string; untitled?: boolean } | null>(null);
  const closeTab = useWorkspace((s) => s.closeTab);
  const request = (paneId: string, tabId: string) => {
    const ws = useWorkspace.getState();
    const tab = ws.panes.find((p) => p.id === paneId)?.tabs.find((t) => t.id === tabId);
    if (ws.dirty[tabId]) setAsking({ paneId, tabId, file: tab?.kind === "file" ? fileName(tab.file?.path ?? "") : undefined, untitled: tab?.kind === "new-file" });
    else closeTab(paneId, tabId);
  };
  const dialog = asking && (
    <Confirm title="Discard unsaved changes?" danger action="Discard"
      message={asking.untitled ? "This new text file was never saved. Its text is lost when the tab closes."
        : asking.file ? `This tab has edits that are not saved to ${asking.file}. A draft is kept, and they come back when you open the page again.`
        : "This tab has edits that are not saved to Living Memory. A draft is kept until you discard it."}
      onAnswer={(yes) => { if (yes) closeTab(asking.paneId, asking.tabId); setAsking(null); }} />
  );
  return { request, dialog };
}

function TabPill({ tab, active, onPick, onClose }: { tab: Tab; active: boolean; onPick: () => void; onClose: () => void }) {
  const dirty = useWorkspace((s) => !!s.dirty[tab.id]);
  return (
    <div role="tab" aria-selected={active} className={`note-tab-pill ${active ? "on" : ""}`} title={label(tab)}
      onClick={onPick} onAuxClick={(e) => { if (e.button === 1) onClose(); }}>
      {tab.kind === "file" && isRichDoc(tab.file?.path ?? "") && <LayoutPanelTop size="1em" aria-hidden className="tab-icon" />}
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

/** The strip's + button: a new page on the Notes page, a new note elsewhere. */
function NewButton({ onBefore }: { onBefore?: () => void }) {
  const notes = useApp((s) => s.route.page === "notes");
  const client = useQueryClient();
  const label = notes ? "New page" : "New note";
  return (
    <button className="icon-button" title={`${label} (Ctrl+N)`} aria-label={label}
      onClick={() => { onBefore?.(); if (notes) void newPageHere(client); else newNote(); }}><Plus size="1.2em" aria-hidden /></button>
  );
}

function PaneView({ pane, focused, first, last, onClose }: {
  pane: Pane; focused: boolean; first: boolean; last: boolean; onClose: (paneId: string, tabId: string) => void;
}) {
  const { activate, focus, split, panes, setRail } = useWorkspace();
  const rail = useWorkspace(railShown);
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
        <NewButton onBefore={() => focus(pane.id)} />
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
          <div className="center muted"><p>Open a note or page here: Ctrl+click a link, or press <kbd>Ctrl</kbd>+<kbd>O</kbd>.</p></div>
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
      else if (e.key.toLowerCase() === "s" && !e.defaultPrevented) {
        // The editor saves on its own; this covers a page in Reading mode, which has no editor (Codex review of 32fd236, U1).
        const tab = pane?.tabs.find((t) => t.id === pane.active);
        if (tab?.kind === "file" && tab.file) { e.preventDefault(); void saveFileTab(keyOf(tab.file)); }
      }
      else if (e.key === "Tab") { e.preventDefault(); ws.cycle(e.shiftKey ? -1 : 1); }
      else if (e.key === "\\") { e.preventDefault(); ws.split(); }
      // An editor that used the key (Rich mode's inline code) has the last word (Codex review of 2392f6b, R1-9).
      else if (e.key.toLowerCase() === "e" && !e.defaultPrevented) {
        e.preventDefault();
        const tab = pane?.tabs.find((t) => t.id === pane.active);
        if (tab?.kind === "note") ws.updateTab(tab.id, { mode: tab.mode === "live" ? "reading" : "live" });
        else if (tab?.kind === "file" && tab.file && isMarkdown(tab.file.path)) ws.updateTab(tab.id, { mode: (tab.mode ?? "live") === "reading" ? "live" : "reading" });
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
