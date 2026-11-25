import { Columns2, LayoutPanelTop, PanelRight, Plus, X } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { NewNote } from "../features/editor/NewNote";
import { NoteTab } from "../features/editor/NoteTab";
import { FileTab, saveFileTab } from "../features/notes/FileTab";
import { NewFileTab } from "../features/notes/NewFileTab";
import { CompareTab } from "../features/power/Compare";
import { FindInFilesTab } from "../features/search/FindInFiles";
import { discard, flushAllDrafts, keyOf, useDocuments } from "../documents/store";
import { isUnsaved } from "../documents/session";
import { newPageHere } from "../features/notes/actions";
import { fileName, isMarkdown, isRichDoc } from "../lib/notebooks";
import { announceDocumentLook, useWhitePaper } from "../lib/paper";
import { firstMatch, useFormat } from "../lib/shortcuts";
import { useApp } from "../store";
import { ErrorBoundary } from "../ui/ErrorBoundary";
import { tabKey } from "../ui/focus";
import { Confirm } from "../ui/Modal";
import { useNarrow } from "../lib/narrow";
import { remPx } from "../shell/layout";
import { Splitter } from "../ui/Splitter";
import { MAX_PANES, paneSize, railShown, tabLabel, useWorkspace, type Pane, type Tab } from "./store";
import { modalOpen } from "../ui/layers";

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
    <div role="tab" aria-selected={active} tabIndex={active ? 0 : -1} className={`note-tab-pill ${active ? "on" : ""}`} title={tabLabel(tab)}
      onClick={onPick} onAuxClick={(e) => { if (e.button === 1) onClose(); }} onKeyDown={(e) => tabKey(e, { open: onPick, close: onClose })}>
      {tab.kind === "file" && isRichDoc(tab.file?.path ?? "") && <LayoutPanelTop size="1em" aria-hidden className="tab-icon" />}
      <span className="tab-label">{tabLabel(tab)}</span>
      {dirty && <span className="dot" aria-label="unsaved">●</span>}
      <button className="tab-close" tabIndex={-1} aria-label="Close tab" onClick={(e) => { e.stopPropagation(); onClose(); }}><X size="1em" aria-hidden /></button>
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

function PaneView({ pane, grow, focused, last, onClose }: {
  pane: Pane; grow: number; focused: boolean; last: boolean; onClose: (paneId: string, tabId: string) => void;
}) {
  const { activate, focus, split, panes, setRail } = useWorkspace();
  const narrow = useNarrow();
  const goTo = useFormat("palette.notes");
  const rail = useWorkspace((s) => railShown(s, narrow));
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
    // The keyboard makes a pane the current one too (Tab into it), so Ctrl+W and Ctrl+S act on the pane with the focus.
    <section className={`pane ${focused ? "focused" : ""}`} style={{ flexGrow: grow }} onMouseDown={() => !focused && focus(pane.id)} onFocus={() => !focused && focus(pane.id)}>
      <div className="note-tabs" role="tablist" aria-label="Open notes and pages" ref={strip} onWheel={(e) => { if (e.deltaY) e.currentTarget.scrollLeft += e.deltaY; }}>
        {pane.tabs.map((t) => <TabPill key={t.id} tab={t} active={t.id === active?.id} onPick={() => activate(pane.id, t.id)} onClose={() => onClose(pane.id, t.id)} />)}
        <NewButton onBefore={() => focus(pane.id)} />
        <span className="fill" />
        {last && (
          <>
            {panes.length < MAX_PANES && (
              <button className="icon-button" title="Open this note side by side (Ctrl+\)" aria-label="Split" onClick={() => { focus(pane.id); split(); }}><Columns2 size="1.2em" aria-hidden /></button>
            )}
            <button className={`icon-button ${rail ? "on" : ""}`} title={rail ? "Hide the context rail" : "Show connections, history and outline"} aria-label="Context rail" aria-pressed={rail}
              onClick={() => setRail(!rail, narrow)}><PanelRight size="1.2em" aria-hidden /></button>
          </>
        )}
      </div>
      <div className="pane-body" data-paper={white ? "" : undefined} role="tabpanel" aria-label={active ? tabLabel(active) : "No tab open"}>
        {active ? <ErrorBoundary label="This tab" resetKey={active.id} onError={() => void flushAllDrafts()}>{TAB_VIEWS[active.kind](active)}</ErrorBoundary> : (
          <div className="center muted"><p>Open a note or page here: Ctrl+click a link, or press <kbd>{goTo}</kbd>.</p></div>
        )}
      </div>
    </section>
  );
}

/** The least width a pane keeps when a splitter moves, in rem. Two panes that together have less share what there is. */
export const PANE_MIN_REM = 14;

/** The divider between two neighbouring panes: it moves width from one to the other, and a double click makes them equal. The
 *  value is the left pane's share of the two, in percent. */
function PaneSplitter({ left, right, at }: { left: Pane; right: Pane; at: number }) {
  const slot = useRef<HTMLDivElement>(null);
  const resize = useWorkspace((s) => s.resizePanes);
  // What the two panes measure together, in CSS pixels; 0 until measured.
  const [total, setTotal] = useState(0);
  useLayoutEffect(() => {
    const measure = () => {
      const a = slot.current?.previousElementSibling, b = slot.current?.nextElementSibling;
      setTotal(a && b ? a.getBoundingClientRect().width + b.getBoundingClientRect().width : 0);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [left.id, right.id, left.size, right.size]);
  const rem = remPx();
  const unit = total > 0 ? 100 / (total / rem) : 1; // one rem in percent
  const min = total > 0 ? Math.min(PANE_MIN_REM * unit, 50) : 0;
  const share = (100 * paneSize(left)) / (paneSize(left) + paneSize(right));
  const pct = Math.round(share);
  return (
    <div className="pane-gap" ref={slot}>
      <Splitter label={`Width of panes ${at} and ${at + 1}`} value={share} min={min} max={100 - min} step={unit} bigStep={4 * unit} pxPerUnit={total / 100}
        text={`${pct}% and ${100 - pct}%`} onChange={(v) => resize(left.id, right.id, v / 100)} onReset={() => resize(left.id, right.id, 0.5)} />
    </div>
  );
}

/** The registry shortcuts this component handles. */
const KEYS = ["tab.close", "file.save", "tab.next", "tab.prev", "view.split", "view.mode"] as const;

/** The open notes: one pane, or up to three side by side, each with its own tabs. */
export function Workspace() {
  const panes = useWorkspace((s) => s.panes);
  const focused = useWorkspace((s) => s.focused);
  const close = useCloseTab();
  // Flex growth factors that add up to less than 1 would leave the row unfilled (a pane left alone after a split was dragged),
  // so the sizes are scaled to average 1: the shares stay the same.
  const sum = panes.reduce((n, p) => n + paneSize(p), 0);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (modalOpen()) return;
      // The keys are as the registry has them: letters take the platform's command key (Ctrl+E and Ctrl+W edit text on
      // macOS); Ctrl+Tab cycles tabs everywhere, since Cmd+Tab switches apps on macOS.
      const hit = firstMatch(e, KEYS);
      if (!hit) return;
      const ws = useWorkspace.getState();
      const pane = ws.panes.find((p) => p.id === ws.focused) ?? ws.panes[0];
      if (hit === "tab.close") { if (pane?.active) close.request(pane.id, pane.active); }
      else if (hit === "file.save" && !e.defaultPrevented) {
        // The editor saves on its own; this covers a page in Reading mode, which has no editor (Codex review of 32fd236, U1).
        const tab = pane?.tabs.find((t) => t.id === pane.active);
        if (tab?.kind === "file" && tab.file) { e.preventDefault(); void saveFileTab(keyOf(tab.file)); }
        else if (tab?.kind === "compare" && tab.compare) { e.preventDefault(); void saveFileTab(keyOf(tab.compare.left)); void saveFileTab(keyOf(tab.compare.right)); }
      }
      else if (hit === "tab.next" || hit === "tab.prev") { e.preventDefault(); ws.cycle(hit === "tab.prev" ? -1 : 1); }
      else if (hit === "view.split") { e.preventDefault(); ws.split(); }
      // An editor that used the key has the last word (Codex review of 2392f6b, R1-9). An editing mode (Live or Source)
      // goes to Reading, anything else to Live, for notes and pages alike (CONR-16).
      else if (hit === "view.mode" && !e.defaultPrevented) {
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
        <Fragment key={p.id}>
          {i > 0 && <PaneSplitter left={panes[i - 1]} right={p} at={i} />}
          <PaneView pane={p} grow={(paneSize(p) * panes.length) / sum} focused={p.id === focused || panes.length === 1} last={i === panes.length - 1} onClose={close.request} />
        </Fragment>
      ))}
      {close.dialog}
    </div>
  );
}
