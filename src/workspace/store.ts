// Obsidian-style workspace: side-by-side panes, each with tabs. The layout survives restarts (per device).
import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import type { NoteType } from "../lib/lm";

export type Mode = "reading" | "live" | "source";
export type TabKind = "note" | "new-note" | "graph" | "activity" | "taxonomy";
export interface Tab {
  id: string;
  kind: TabKind;
  ref?: string;           // note tabs: domain:id
  mode?: Mode;            // note tabs
  title?: string;         // last known title, for the tab strip
  init?: { title?: string; type?: NoteType; domain?: string }; // new-note tabs
}
export interface Pane { id: string; tabs: Tab[]; active: string | null }
export type Panel = "outline" | "backlinks" | "graph" | "history";

interface WorkspaceState {
  panes: Pane[];
  focused: string;
  panel: Panel | null;
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
  setPanel: (panel: Panel | null) => void;
  revealLine: (tabId: string, line: number) => void;
  replaceRef: (from: string, to: string) => void;
}

let counter = 0;
const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}`;
const firstPane = (): Pane => ({ id: newId("pane"), tabs: [], active: null });
export const MAX_PANES = 3;

const safeStorage: StateStorage = {
  getItem: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  setItem: (k, v) => { try { localStorage.setItem(k, v); } catch { /* not persisted */ } },
  removeItem: (k) => { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

const sameTab = (a: Omit<Tab, "id">, b: Tab) =>
  a.kind === b.kind && (a.kind === "note" ? a.ref === b.ref : a.kind !== "new-note");

export const useWorkspace = create<WorkspaceState>()(persist((set, get) => {
  const initial = firstPane();
  const withPane = (paneId: string, fn: (p: Pane) => Pane) =>
    set((s) => ({ panes: s.panes.map((p) => (p.id === paneId ? fn(p) : p)) }));

  return {
    panes: [initial],
    focused: initial.id,
    panel: "outline",
    dirty: {},
    reveal: null,

    openTab: (tab, opts = {}) => {
      const s = get();
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
      get().openTab({ kind: "note", ref, mode: opts.mode ?? "reading", title: opts.title }, { split: opts.split }),

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
      if (tab && tab.kind === "note") get().openTab({ ...tab, mode: "reading" }, { split: true });
      else if (s.panes.length < MAX_PANES) { const p = firstPane(); set({ panes: [...s.panes, p], focused: p.id }); }
    },

    focus: (paneId) => set({ focused: paneId }),
    updateTab: (tabId, patch) =>
      set((s) => ({ panes: s.panes.map((p) => ({ ...p, tabs: p.tabs.map((t) => (t.id === tabId ? { ...t, ...patch } : t)) })) })),
    setDirty: (tabId, dirty) => set((s) => (Boolean(s.dirty[tabId]) === dirty ? s : { dirty: { ...s.dirty, [tabId]: dirty } })),
    setPanel: (panel) => set({ panel }),
    revealLine: (tabId, line) => set({ reveal: { tabId, line, at: Date.now() } }),
    // After a new note is captured, its tab becomes a note tab.
    replaceRef: (from, to) =>
      set((s) => ({ panes: s.panes.map((p) => ({ ...p, tabs: p.tabs.map((t) => (t.ref === from ? { ...t, ref: to } : t)) })) })),
  };
}, {
  name: "hivemind.workspace",
  version: 1,
  storage: createJSONStorage(() => safeStorage),
  partialize: (s) => ({
    // New-note tabs hold unsaved text in drafts, not here; keep only reopenable tabs.
    panes: s.panes.map((p) => ({ ...p, tabs: p.tabs.filter((t) => t.kind !== "new-note") })),
    focused: s.focused,
    panel: s.panel,
  }),
}));

/** The tab shown in the focused pane. */
export function activeTab(s: Pick<WorkspaceState, "panes" | "focused">): Tab | undefined {
  const pane = s.panes.find((p) => p.id === s.focused) ?? s.panes[0];
  return pane?.tabs.find((t) => t.id === pane.active);
}
