import { Columns2, LayoutPanelTop, PanelRight, Plus, X } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { createPortal } from "react-dom";
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
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
import { PANE_MIN_REM, paneShares } from "../shell/budget";
import { remPx, toggleRail, useLayout } from "../shell/layout";
import { useBudget } from "../shell/useBudget";
import { ContextMenu } from "../ui/ContextMenu";
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

/** One tab: a pill holding the tab itself (the part that is named, focused and opened) and the close mark beside it, not inside
 *  it (a tab holds no controls). The pill carries the look and the tooltip. */
function TabPill({ tab, active, onPick, onClose }: { tab: Tab; active: boolean; onPick: () => void; onClose: () => void }) {
  const dirty = useWorkspace((s) => !!s.dirty[tab.id]);
  return (
    <div className={`note-tab-pill ${active ? "on" : ""}`} title={tabLabel(tab)} onAuxClick={(e) => { if (e.button === 1) onClose(); }}>
      <div role="tab" aria-selected={active} tabIndex={active ? 0 : -1} className="tab-main"
        onClick={onPick} onKeyDown={(e) => tabKey(e, { open: onPick, close: onClose })}>
        {tab.kind === "file" && isRichDoc(tab.file?.path ?? "") && <LayoutPanelTop size="1em" aria-hidden className="tab-icon" />}
        <span className="tab-label">{tabLabel(tab)}</span>
        {dirty && <><span className="dot" aria-hidden>●</span><span className="visually-hidden">, unsaved</span></>}
      </div>
      {/* A mouse shortcut, hidden from assistive technology: a button inside the tab list is not allowed. The keyboard closes a tab
          with Delete on the tab and with Ctrl+W. */}
      <span className="tab-close" aria-hidden onClick={onClose}><X size="1em" /></span>
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

/** What a pane is called as a region: the notes when there is one pane, else its place in the row. */
function paneName(index: number, count: number): string {
  if (count === 1) return "Open notes";
  return count === 2 ? (index === 0 ? "Left pane" : "Right pane") : `Pane ${index + 1}`;
}

function PaneView({ pane, name, grow, focused, last, onClose }: {
  pane: Pane; name: string; grow: number; focused: boolean; last: boolean; onClose: (paneId: string, tabId: string) => void;
}) {
  const { activate, focus, split, panes } = useWorkspace();
  const narrow = useBudget().overlay;
  const focusMode = useLayout((s) => s.focusMode);
  const goTo = useFormat("palette.notes");
  const railOn = useWorkspace((s) => railShown(s, narrow));
  // Focus mode hides the rail, so its button then shows it (and leaves the mode) instead of hiding it.
  const rail = railOn && !focusMode;
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
    <section className={`pane ${focused ? "focused" : ""}`} id={`pane-${pane.id}`} aria-label={name} style={{ flexGrow: grow }} onMouseDown={() => !focused && focus(pane.id)} onFocus={() => !focused && focus(pane.id)}>
      <div className="note-tabs" ref={strip} onWheel={(e) => { if (e.deltaY) e.currentTarget.scrollLeft += e.deltaY; }}>
        <div className="tab-list" role="tablist" aria-label="Open notes and pages">
          {pane.tabs.map((t) => <TabPill key={t.id} tab={t} active={t.id === active?.id} onPick={() => activate(pane.id, t.id)} onClose={() => onClose(pane.id, t.id)} />)}
        </div>
        <NewButton onBefore={() => focus(pane.id)} />
        <span className="fill" />
        {last && (
          <>
            {panes.length < MAX_PANES && (
              <button className="icon-button" title="Open this note side by side (Ctrl+\)" aria-label="Split" onClick={() => { focus(pane.id); split(); }}><Columns2 size="1.2em" aria-hidden /></button>
            )}
            <button className={`icon-button ${rail ? "on" : ""}`} title={rail ? "Hide the context rail" : "Show connections, history and outline"} aria-label="Context rail" aria-pressed={rail}
              onClick={() => toggleRail(narrow)}><PanelRight size="1.2em" aria-hidden /></button>
          </>
        )}
      </div>
      <div className="pane-body" data-paper={white ? "" : undefined} role="tabpanel" tabIndex={-1} aria-label={active ? tabLabel(active) : "No tab open"}>
        {active ? <ErrorBoundary label="This tab" resetKey={active.id} onError={() => void flushAllDrafts()}>{TAB_VIEWS[active.kind](active)}</ErrorBoundary> : (
          <div className="center muted"><p>Open a note or page here: Ctrl+click a link, or press <kbd>{goTo}</kbd>.</p></div>
        )}
      </div>
    </section>
  );
}

/** The divider between two neighbouring panes: it moves width from one to the other, and a double click makes them equal. `share`
 *  is the left pane's part of the two as they are drawn now, in percent, and `pairRem` the width the two have together (0 until
 *  it is measured). The menu (right-click, Shift+F10) does the same without dragging. */
function PaneSplitter({ left, share, pairRem, label, onShare }: { left: Pane; share: number; pairRem: number; label: string; onShare: (percent: number, force?: boolean) => void }) {
  const [menu, setMenu] = useState<{ x: number; y: number; from: HTMLElement } | null>(null);
  const unit = pairRem > 0 ? 100 / pairRem : 1; // one rem in percent of the two
  const min = pairRem > 0 ? Math.min(PANE_MIN_REM * unit, 50) : 0;
  const pct = Math.round(share);
  const set = (v: number) => onShare(Math.min(100 - min, Math.max(min, v)));
  // A direction that cannot move is off, so a command never does nothing (and never rewrites the saved sizes for it).
  const room = 1e-6;
  return (
    <div className="pane-gap">
      <Splitter label={label} controls={`pane-${left.id}`} value={share} min={min} max={100 - min} step={unit} bigStep={4 * unit} pxPerUnit={(pairRem * remPx()) / 100}
        text={`${pct}% and ${100 - pct}%`} onChange={(v) => onShare(v)} onReset={() => onShare(50, true)}
        onMenu={(at, from) => setMenu({ ...at, from })} />
      {/* In the body, above the rail that lies over the note in a narrow window; focus goes back to the divider. */}
      {menu && createPortal(
        <ContextMenu at={menu} from={menu.from} label="Pane widths" onClose={() => setMenu(null)}>
          <li role="none"><button role="menuitem" disabled={share >= 100 - min - room} onClick={() => { setMenu(null); set(share + 4 * unit); }}><span className="grow">Make left pane wider</span></button></li>
          <li role="none"><button role="menuitem" disabled={share <= min + room} onClick={() => { setMenu(null); set(share - 4 * unit); }}><span className="grow">Make right pane wider</span></button></li>
          <li role="none"><button role="menuitem" onClick={() => { setMenu(null); onShare(50, true); }}><span className="grow">Equal widths</span></button></li>
        </ContextMenu>, document.body)}
    </div>
  );
}

/** The width of the row of panes in rem, kept current as it changes (a window resize, the rail, the notes list, the sidebar), 0
 *  until it is measured. */
function useRowRem(row: RefObject<HTMLElement | null>): number {
  const [rem, setRem] = useState(0);
  useLayoutEffect(() => {
    const el = row.current;
    if (!el) return;
    const measure = () => setRem(el.getBoundingClientRect().width / remPx());
    measure();
    window.addEventListener("resize", measure);
    const watch = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    watch?.observe(el);
    return () => { window.removeEventListener("resize", measure); watch?.disconnect(); };
  }, [row]);
  return rem;
}

/** The registry shortcuts this component handles. */
const KEYS = ["tab.close", "file.save", "tab.next", "tab.prev", "view.split", "view.mode"] as const;

/** The open notes: one pane, or up to three side by side, each with its own tabs. */
export function Workspace() {
  const panes = useWorkspace((s) => s.panes);
  const focused = useWorkspace((s) => s.focused);
  const close = useCloseTab();
  // How the row is shared as it is drawn: the saved sizes, with every pane kept at its minimum width when that fits. The shares
  // add up to 1, so scaled by the number of panes (flex-grow, from a basis of 0) they always fill the row.
  const row = useRef<HTMLDivElement>(null);
  const rowRem = useRowRem(row);
  const shares = paneShares(panes.map(paneSize), rowRem, PANE_MIN_REM);
  const setSizes = useWorkspace((s) => s.setPaneSizes);
  // Move the divider before pane `i`: the two panes next to it share their drawn width as asked, every other pane keeps the
  // width it is drawn at, and the sizes saved are the ones that draw exactly that. A move that changes nothing writes nothing,
  // unless it is a reset (`force`).
  const setPair = (i: number, percent: number, force = false) => {
    const pair = shares[i - 1] + shares[i];
    const left = (pair * percent) / 100;
    if (!force && Math.abs(left - shares[i - 1]) < 1e-6) return;
    const next = shares.map((n, j) => (j === i - 1 ? left : j === i ? pair - left : n));
    setSizes(Object.fromEntries(panes.map((p, j) => [p.id, next[j] * panes.length])));
  };
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
    <div className="workspace" ref={row}>
      {panes.map((p, i) => (
        <Fragment key={p.id}>
          {i > 0 && (
            <PaneSplitter left={panes[i - 1]} onShare={(percent, force) => setPair(i, percent, force)} share={(100 * shares[i - 1]) / (shares[i - 1] + shares[i])} pairRem={(shares[i - 1] + shares[i]) * rowRem}
              label={panes.length === 2 ? "Width of the left pane" : `Width of pane ${i}`} />
          )}
          <PaneView pane={p} name={paneName(i, panes.length)} grow={shares[i] * panes.length} focused={p.id === focused || panes.length === 1} last={i === panes.length - 1} onClose={close.request} />
        </Fragment>
      ))}
      {close.dialog}
    </div>
  );
}
