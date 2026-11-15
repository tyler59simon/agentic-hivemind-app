// Which terminals want the user: a dot on the tab and on the Agent Workspace item. The backend keeps the truth
// (`term_list` has it, `term-attention` changes it); this store only mirrors it for the page.
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import type { TermExit, TermInfo } from "../../lib/term";
import { termList, termSeen } from "../../lib/term";
import { openSession, useApp } from "../../store";
import { useEffect } from "react";
import { useLayout } from "./layout";

export type Attention = "waiting" | "done";

/** The dot for several terminals: waiting beats done; null when none wants anything. */
export function dotOf(kinds: Iterable<Attention | null | undefined>): Attention | null {
  let found: Attention | null = null;
  for (const kind of kinds) {
    if (kind === "waiting") return "waiting";
    if (kind === "done") found = "done";
  }
  return found;
}

/** The text a screen reader and a tooltip get for a dot. */
export const dotTitle = (kind: Attention): string => (kind === "waiting" ? "Waiting for you" : "Finished");

/** Whether the user is already looking at a terminal that just asked for attention, so no dot is needed: the window
 *  has the focus, the Agent Workspace shows the terminal workspace (not the Start screen or a chat session), and the
 *  terminal is the tab shown in one of the panes (`shown` lists each visible pane's active tab). */
export function lookingAt(id: string, v: { windowFocused: boolean; page: string; workspace: boolean; shown: (string | null)[] }): boolean {
  return v.windowFocused && v.page === "agents" && v.workspace && v.shown.includes(id);
}

let workspaceMounted = false;
/** The mounted TerminalWorkspace tells this it is on screen; it is mounted only while the terminal view shows. */
export function setWorkspaceMounted(on: boolean): void { workspaceMounted = on; }

interface State {
  byId: Record<string, Attention>;
  set: (id: string, kind: Attention | null) => void;
  load: (list: TermInfo[]) => void;
}

export const useAttention = create<State>((set) => ({
  byId: {},
  set: (id, kind) => set((s) => {
    if ((s.byId[id] ?? null) === kind) return s;
    const byId = { ...s.byId };
    if (kind) byId[id] = kind; else delete byId[id];
    return { byId };
  }),
  load: (list) => set({ byId: Object.fromEntries(list.filter((t) => t.attention).map((t) => [t.id, t.attention as Attention])) }),
}));

/** The user looked at a terminal: clear its dot now and tell the backend. */
export function seen(id: string): void {
  if (!useAttention.getState().byId[id]) return;
  useAttention.getState().set(id, null);
  termSeen(id).catch(() => undefined);
}

/** The active tab of each pane on screen. */
const shownIds = () => { const l = useLayout.getState(); return l.split ? l.active : [l.active[0]]; };
const look = (id: string) => lookingAt(id, { windowFocused: document.hasFocus(), page: useApp.getState().route.page, workspace: workspaceMounted, shown: shownIds() });

/** Keeps the store in step with the backend, and opens a terminal when its notification was clicked. Mount once. */
export function useAttentionEvents(): void {
  useEffect(() => {
    const { set, load } = useAttention.getState();
    const looking = look;
    const stops = [
      listen<{ id: string; kind: Attention | null }>("term-attention", (e) => {
        if (e.payload.kind && looking(e.payload.id)) { termSeen(e.payload.id).catch(() => undefined); return; }
        set(e.payload.id, e.payload.kind);
      }),
      listen<TermExit>("term-exit", (e) => set(e.payload.id, null)),
      listen<{ id: string }>("open-session", (e) => { openSession(e.payload.id); seen(e.payload.id); }),
    ];
    const onFocus = () => { const l = useLayout.getState(); const id = l.active[l.focus]; if (id && looking(id)) seen(id); };
    window.addEventListener("focus", onFocus);
    termList().then(load).catch(() => undefined);
    return () => { stops.forEach((stop) => stop.then((unlisten) => unlisten())); window.removeEventListener("focus", onFocus); };
  }, []);
}
