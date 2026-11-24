import { Columns2, LayoutPanelTop, PanelRight, Plus, X } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { NewNote } from "../features/editor/NewNote";
import { NoteTab } from "../features/editor/NoteTab";
import { FileTab, saveFileTab } from "../features/notes/FileTab";
import { NewFileTab } from "../features/notes/NewFileTab";
import { CompareTab } from "../features/power/Compare";
import { FindInFilesTab } from "../features/search/FindInFiles";
import { discard, keyOf, useDocuments } from "../documents/store";
import { isUnsaved } from "../documents/session";
import { newPageHere } from "../features/notes/actions";
import { fileName, isMarkdown, isRichDoc } from "../lib/notebooks";
import { announceDocumentLook, useWhitePaper } from "../lib/paper";
import { useApp } from "../store";
import { Confirm } from "../ui/Modal";
import { MAX_PANES, railShown, tabLabel, useWorkspace, type Pane, type Tab } from "./store";

/** What a tab shows. */
export const TAB_VIEWS: Record<Tab["kind"], (tab: Tab) => ReactNode> = {
  note: (tab) => <NoteTab tab={tab} />,
  "new-note": (tab) => <NewNote key={tab.id} tab={tab} />,
  file: (tab) => <FileTab key={tab.id} tab={tab} />,
  "new-file": (tab) => <NewFileTab key={tab.id} tab={tab} />,
  compare: (tab) => <CompareTab key={tab.id} tab={tab} />,
  find: (tab) => <FindInFilesTab key={tab.id} />,
};


/** Whether a tab other than `tabId` shows the page at `key` (a split), which then keeps the page open. */
const shownAgain = (key: string, tabId: string) =>
  useWorkspace.getState().panes.some((p) => p.tabs.some((t) => t.id !== tabId && t.kind === "file" && t.file && keyOf(t.file) === key));

/** Whether another tab shows the same page or Memory note. A page's tabs share one document and a note's tabs share one
 *  editing session and draft, so closing one of them loses nothing and asks nothing; closing the last one does ask. */
function twinKeepsEdits(tab: Tab | undefined): boolean {
  if (!tab) return false;
  const others = useWorkspace.getState().panes.flatMap((p) => p.tabs).filter((t) => t.id !== tab.id);
  if (tab.kind === "file" && tab.file) return others.some((t) => t.kind === "file" && t.file && keyOf(t.file) === keyOf(tab.file!));
  if (tab.kind === "note" && tab.ref) return others.some((t) => t.kind === "note" && t.ref === tab.ref);
  return false;
}

/** Close a tab, asking first when it holds unsaved edits. */
export function useCloseTab() {
  // `lost`: the page's edits cannot be kept as a draft (why), so closing it really drops them (Codex review of 7320d7f, DATA-5).
  const [asking, setAsking] = useState<{ paneId: string; tabId: string; file?: string; untitled?: boolean; lost?: { key: string; why: string } } | null>(null);
  const closeTab = useWorkspace((s) => s.closeTab);
  const request = (paneId: string, tabId: string) => {
    const ws = useWorkspace.getState();
    const tab = ws.panes.find((p) => p.id === paneId)?.tabs.find((t) => t.id === tabId);
    const key = tab?.kind === "file" && tab.file ? keyOf(tab.file) : undefined;
    const doc = key ? useDocuments.getState().docs[key] : undefined;
    const lost = key && doc?.draftError && isUnsaved(doc) ? { key, why: doc.draftError } : undefined;
    if (ws.dirty[tabId] && !twinKeepsEdits(tab)) setAsking({ paneId, tabId, file: tab?.kind === "file" ? fileName(tab.file?.path ?? "") : tab?.kind === "compare" ? "the compared files" : undefined, untitled: tab?.kind === "new-file", lost });
    else closeTab(paneId, tabId);
  };
  const dialog = asking && (
    <Confirm title="Discard unsaved changes?" danger action="Discard"
      message={asking.untitled ? "This new text file was never saved. Its text is lost when the tab closes."
        : asking.lost ? `The edits to ${asking.file} are not saved, and Hivemind could not keep them as a draft (${asking.lost.why}). They are lost if you discard them. Cancel, then save the page or save a copy first.`
        : asking.file ? `This tab has edits that are not saved to ${asking.file}. A draft is kept, and they come back when you open the page again.`
        : "This tab has edits that are not saved to Living Memory. A draft is kept until you discard it."}
      onAnswer={(yes) => { if (yes) { if (asking.lost && !shownAgain(asking.lost.key, asking.tabId)) discard(asking.lost.key); closeTab(asking.paneId, asking.tabId); } setAsking(null); }} />
  );
  return { request, dialog };
}

function TabPill({ tab, active, onPick, onClose }: { tab: Tab; active: boolean; onPick: () => void; onClose: () => void }) {
  const dirty = useWorkspace((s) => !!s.dirty[tab.id]);
  return (
    <div role="tab" aria-selected={active} className={`note-tab-pill ${active ? "on" : ""}`} title={tabLabel(tab)}
      onClick={onPick} onAuxClick={(e) => { if (e.button === 1) onClose(); }}>
      {tab.kind === "file" && isRichDoc(tab.file?.path ?? "") && <LayoutPanelTop size="1em" aria-hidden className="tab-icon" />}
      <span className="tab-label">{tabLabel(tab)}</span>
      {dirty && <span className="dot" aria-label="unsaved">●</span>}
      <button className="tab-close" aria-label="Close tab" onClick={(e) => { e.stopPropagation(); onClose(); }}><X size="1em" aria-hidden /></button>
    </div>
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

function PaneView({ pane, focused, last, onClose }: {
  pane: Pane; focused: boolean; last: boolean; onClose: (paneId: string, tabId: string) => void;
}) {
  const { activate, focus, split, panes, setRail } = useWorkspace();
  const rail = useWorkspace(railShown);
  const active = pane.tabs.find((t) => t.id === pane.active) ?? pane.tabs[0];
  const strip = useRef<HTMLDivElement>(null);
  // The whole document area is white paper when the tab says so (App.css); views that draw dark or light colours redraw.
  const white = useWhitePaper(active);
  const shownWhite = useRef(white);
  useEffect(() => {
    if (shownWhite.current === white) return;
    shownWhite.current = white;
    announceDocumentLook();
  }, [white]);
  useEffect(() => {
    strip.current?.querySelector(".note-tab-pill.on")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active?.id, pane.tabs.length]);
  return (
    <section className={`pane ${focused ? "focused" : ""}`} onMouseDown={() => !focused && focus(pane.id)}>
      <div className="note-tabs" role="tablist" ref={strip} onWheel={(e) => { if (e.deltaY) e.currentTarget.scrollLeft += e.deltaY; }}>
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
      <div className="pane-body" data-paper={white ? "" : undefined}>
        {active ? TAB_VIEWS[active.kind](active) : (
          <div className="center muted"><p>Open a note or page here: Ctrl+click a link, or press <kbd>Ctrl</kbd>+<kbd>O</kbd>.</p></div>
        )}
      </div>
    </section>
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
        else if (tab?.kind === "compare" && tab.compare) { e.preventDefault(); void saveFileTab(keyOf(tab.compare.left)); void saveFileTab(keyOf(tab.compare.right)); }
      }
      else if (e.key === "Tab") { e.preventDefault(); ws.cycle(e.shiftKey ? -1 : 1); }
      else if (e.key === "\\") { e.preventDefault(); ws.split(); }
      // An editor that used the key has the last word (Codex review of 2392f6b, R1-9). An editing mode (Live or Source)
      // goes to Reading, anything else to Live, for notes and pages alike (CONR-16).
      else if (e.key.toLowerCase() === "e" && !e.defaultPrevented) {
        e.preventDefault();
        const tab = pane?.tabs.find((t) => t.id === pane.active);
        if (tab?.kind === "note") ws.updateTab(tab.id, { mode: tab.mode === "live" || tab.mode === "source" ? "reading" : "live" });
        else if (tab?.kind === "file" && tab.file && isMarkdown(tab.file.path)) ws.updateTab(tab.id, { mode: (tab.mode ?? "live") === "reading" ? "live" : "reading" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);
  return (
    <div className="workspace">
      {panes.map((p, i) => (
        <PaneView key={p.id} pane={p} focused={p.id === focused || panes.length === 1} last={i === panes.length - 1} onClose={close.request} />
      ))}
      {close.dialog}
    </div>
  );
}
