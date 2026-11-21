// The open documents: side-by-side panes, each with tabs, shared by the Memory page (notes) and the Notes page (notebook
// pages). The layout survives restarts (per device).
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { movedPath, sameDoc, type FileRef } from "../documents/keys";
import { isMarkdown } from "../lib/notebooks";
import type { NoteType } from "../lib/lm";
import { prefs } from "../lib/prefs";
import { safeStorage, useApp } from "../store";

export type Mode = "reading" | "live" | "rich" | "source" | "history";
export type TabKind = "note" | "new-note" | "file" | "new-file";
const KINDS: readonly string[] = ["note", "new-note", "file", "new-file"];
export type { FileRef };
export interface Tab {
  id: string;
  kind: TabKind;
  ref?: string;           // note tabs: domain:id
  file?: FileRef;         // file tabs: a page of a folder notebook, or a loose file (notebook "@<grant>")
  mode?: Mode;            // note and file tabs
  title?: string;         // last known title, for the tab strip
  paper?: boolean;        // true: white paper, false: the theme's colours; undefined follows the setting (documents only)
  init?: { title?: string; type?: NoteType; domain?: string; tags?: string[] }; // new-note tabs
}
export interface Pane { id: string; tabs: Tab[]; active: string | null }

interface WorkspaceState {
  panes: Pane[];
  focused: string;
  /** Whether the context rail beside the focused note is shown: with one pane, and with several (off at first, to make room). */
  rail: boolean;
  railSplit: boolean;
  dirty: Record<string, boolean>;          // tab id -> unsaved edits (not persisted)
  reveal: { tabId: string; line: number; at: number } | null; // outline -> scroll request
  openNote: (ref: string, opts?: { split?: boolean; mode?: Mode; title?: string }) => void;
  openTab: (tab: Omit<Tab, "id">, opts?: { split?: boolean }) => void;
  activate: (paneId: string, tabId: string) => void;
  closeTab: (paneId: string, tabId: string) => void;
  cycle: (step: 1 | -1) => void;
  split: () => void;
  focus: (paneId: string) => void;
  updateTab: (tabId: string, patch: Partial<Tab>) => void;
  setDirty: (tabId: string, dirty: boolean) => void;
  setRail: (rail: boolean) => void;
  revealLine: (tabId: string, line: number) => void;
  replaceRef: (from: string, to: string) => void;
  /** A page or folder of a notebook was renamed or moved: its tabs follow. */
  retargetFile: (notebook: string, from: string, to: string) => void;
}

let counter = 0;
const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}`;
const firstPane = (): Pane => ({ id: newId("pane"), tabs: [], active: null });
export const MAX_PANES = 3;

/** Whether a never-saved text file holds text. It has no draft, so closing the window or quitting loses it. */
export const unsavedUntitled = (s: { panes: Pane[]; dirty: Record<string, boolean> }) =>
  s.panes.some((p) => p.tabs.some((t) => t.kind === "new-file" && s.dirty[t.id]));

/** A document is open at most once per pane set; a new note is always its own tab. */
export const sameTab = (a: Omit<Tab, "id">, b: Tab) => sameDoc(a, b);

/** Showing a tab also shows a page that holds the workspace: the one already shown, else Memory for notes and Notes
 *  for notebook pages. */
export function showTab(tab: Pick<Tab, "kind">) {
  const { route, go } = useApp.getState();
  if (route.page === "notes" || (route.page === "memory" && route.view === "notes")) return;
  go(tab.kind === "file" || tab.kind === "new-file" ? { page: "notes" } : { page: "memory", view: "notes" });
}

/** The mode a second view of a tab opens in. */
const splitMode = (tab: Tab): Mode => (tab.kind === "file" && tab.file && !isMarkdown(tab.file.path) ? "source" : "reading");

export const useWorkspace = create<WorkspaceState>()(persist((set, get) => {
  const initial = firstPane();
  const withPane = (paneId: string, fn: (p: Pane) => Pane) =>
    set((s) => ({ panes: s.panes.map((p) => (p.id === paneId ? fn(p) : p)) }));

  return {
    panes: [initial],
    focused: initial.id,
    rail: true,
    railSplit: false,
    dirty: {},
    reveal: null,

    openTab: (tab, opts = {}) => {
      const s = get();
      showTab(tab);
      // Already open somewhere: show it (a split request still opens a second view).
      if (!opts.split) {
        for (const pane of s.panes) {
          const found = pane.tabs.find((t) => sameTab(tab, t));
          if (found) { set({ focused: pane.id }); withPane(pane.id, (p) => ({ ...p, active: found.id })); return; }
        }
      }
      let paneId = s.focused;
      if (opts.split) {
        const other = s.panes.find((p) => p.id !== s.focused);
        if (other) paneId = other.id;
        else if (s.panes.length < MAX_PANES) {
          const pane = firstPane();
          set({ panes: [...s.panes, pane] });
          paneId = pane.id;
        }
      }
      const full: Tab = { ...tab, id: newId("tab") };
      withPane(paneId, (p) => ({ ...p, tabs: [...p.tabs, full], active: full.id }));
      set({ focused: paneId });
    },

    openNote: (ref, opts = {}) =>
      get().openTab({ kind: "note", ref, mode: opts.mode ?? prefs.defaultMode(), title: opts.title }, { split: opts.split }),

    activate: (paneId, tabId) => { set({ focused: paneId }); withPane(paneId, (p) => ({ ...p, active: tabId })); },

    closeTab: (paneId, tabId) => {
      const s = get();
      const pane = s.panes.find((p) => p.id === paneId);
      if (!pane) return;
      const at = pane.tabs.findIndex((t) => t.id === tabId);
      const tabs = pane.tabs.filter((t) => t.id !== tabId);
      const active = pane.active === tabId ? (tabs[Math.min(at, tabs.length - 1)]?.id ?? null) : pane.active;
      const dirty = { ...s.dirty };
      delete dirty[tabId];
      // An emptied pane goes away unless it is the last one.
      if (!tabs.length && s.panes.length > 1) {
        const panes = s.panes.filter((p) => p.id !== paneId);
        set({ panes, dirty, focused: s.focused === paneId ? panes[0].id : s.focused });
      } else {
        set({ dirty, panes: s.panes.map((p) => (p.id === paneId ? { ...p, tabs, active } : p)) });
      }
    },

    cycle: (step) => {
      const s = get();
      const pane = s.panes.find((p) => p.id === s.focused);
      if (!pane?.tabs.length) return;
      const at = pane.tabs.findIndex((t) => t.id === pane.active);
      const next = pane.tabs[(at + step + pane.tabs.length) % pane.tabs.length];
      withPane(pane.id, (p) => ({ ...p, active: next.id }));
    },

    split: () => {
      const s = get();
      const pane = s.panes.find((p) => p.id === s.focused);
      const tab = pane?.tabs.find((t) => t.id === pane.active);
      if (tab && tab.kind !== "new-note" && tab.kind !== "new-file") get().openTab({ ...tab, mode: splitMode(tab) }, { split: true });
      else if (s.panes.length < MAX_PANES) { const p = firstPane(); set({ panes: [...s.panes, p], focused: p.id }); }
    },

    focus: (paneId) => set({ focused: paneId }),
    updateTab: (tabId, patch) =>
      set((s) => ({ panes: s.panes.map((p) => ({ ...p, tabs: p.tabs.map((t) => (t.id === tabId ? { ...t, ...patch } : t)) })) })),
    setDirty: (tabId, dirty) => set((s) => (Boolean(s.dirty[tabId]) === dirty ? s : { dirty: { ...s.dirty, [tabId]: dirty } })),
    setRail: (shown) => set((s) => (s.panes.length > 1 ? { railSplit: shown } : { rail: shown })),
    revealLine: (tabId, line) => set({ reveal: { tabId, line, at: Date.now() } }),
    // After a new note is captured, its tab becomes a note tab.
    replaceRef: (from, to) =>
      set((s) => ({ panes: s.panes.map((p) => ({ ...p, tabs: p.tabs.map((t) => (t.ref === from ? { ...t, ref: to } : t)) })) })),
    retargetFile: (notebook, from, to) =>
      set((s) => ({
        panes: s.panes.map((p) => ({
          ...p,
          tabs: p.tabs.map((t) => {
            if (t.kind !== "file" || t.file?.notebook !== notebook) return t;
            const path = movedPath(t.file.path, from, to);
            return path === null ? t : { ...t, file: { notebook, path }, title: undefined };
          }),
        })),
      })),
  };
}, {
  name: "hivemind.workspace",
  version: 3,
  storage: createJSONStorage(() => safeStorage),
  // Version 1 also kept graph, project, system and session tabs; those are pages now. Version 2 had notes only and loads
  // as it is.
  migrate: (stored, version) =>
    version >= 2 ? (stored as WorkspaceState) : notesOnly(stored as { panes?: Pane[]; focused?: string; panel?: string | null }),
  // Tabs of a kind this build does not know (written by a newer one) are dropped.
  merge: (stored, current) => ({ ...current, ...knownKinds(stored as Partial<WorkspaceState>) }),
  partialize: (s) => ({
    // New-note tabs hold unsaved text in drafts, not here, and a new text file has none; keep only reopenable tabs.
    panes: s.panes.map((p) => ({ ...p, tabs: p.tabs.filter((t) => t.kind !== "new-note" && t.kind !== "new-file") })),
    focused: s.focused,
    rail: s.rail,
    railSplit: s.railSplit,
  }),
}));

/** A stored version-1 layout with only its note tabs, and empty panes dropped (one pane always remains). */
export function notesOnly(stored: { panes?: Pane[]; focused?: string; panel?: string | null }) {
  const kept = (stored.panes ?? []).map((p) => {
    const tabs = p.tabs.filter((t) => t.kind === "note" && t.ref);
    return { ...p, tabs, active: tabs.some((t) => t.id === p.active) ? p.active : tabs[0]?.id ?? null };
  });
  const panes = kept.filter((p) => p.tabs.length);
  const all = panes.length ? panes : [kept[0] ?? firstPane()];
  return { panes: all, focused: all.some((p) => p.id === stored.focused) ? stored.focused! : all[0].id, rail: stored.panel !== null };
}

/** A stored layout without tabs of unknown kinds. */
export function knownKinds(stored: Partial<WorkspaceState> | undefined): Partial<WorkspaceState> {
  if (!stored?.panes) return stored ?? {};
  const panes = stored.panes.map((p) => {
    const tabs = p.tabs.filter((t) => KINDS.includes(t.kind) && (t.kind !== "file" || !!t.file))
      .map((t) => (t.paper === undefined || typeof t.paper === "boolean" ? t : { ...t, paper: undefined }));
    return { ...p, tabs, active: tabs.some((t) => t.id === p.active) ? p.active : tabs[0]?.id ?? null };
  });
  return { ...stored, panes };
}

/** The tab shown in the focused pane. */
export function activeTab(s: Pick<WorkspaceState, "panes" | "focused">): Tab | undefined {
  const pane = s.panes.find((p) => p.id === s.focused) ?? s.panes[0];
  return pane?.tabs.find((t) => t.id === pane.active);
}

/** Whether the context rail is shown for the current number of panes. */
export const railShown = (s: Pick<WorkspaceState, "panes" | "rail" | "railSplit">) => (s.panes.length > 1 ? s.railSplit : s.rail);

/** Whether any document is open. */
export const hasTabs = (s: Pick<WorkspaceState, "panes">) => s.panes.some((p) => p.tabs.length > 0);
