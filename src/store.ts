// Where the app is: the picked project, the page in the sidebar, and the palette. Open notes live in the
// workspace store (src/workspace/store.ts); a note is shown on the Memory page.
import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";

export type Shelf = "active" | "archived" | "any";

/** One page per sidebar section. Memory also holds the open notes (`view: "notes"`) and its sub-views; Notes holds the
 *  notebooks and shows the same open documents. */
export type Route =
  | { page: "overview"; view?: "work" }
  | { page: "executive"; tab?: ExecutiveTab; capture?: string; briefing?: string; draft?: string; session?: string }
  | { page: "agents"; session?: string; view?: "new" }
  | { page: "changes"; id?: number; view?: "detail"; ref?: string }
  | { page: "architecture"; system?: string }
  | { page: "dashboards"; ref?: string }
  | { page: "memory"; view?: "notes" | "graph" | "activity" | "history" | "tags"; q?: string }
  | { page: "notes"; notebook?: string; path?: string; view?: "tasks" | "views" }
  | { page: "wiki"; domain?: string; at?: string; edition?: "agent"; project?: string }
  | { page: "recap" }
  | { page: "maintenance" }
  | { page: "review"; session?: string; file?: string }
  | { page: "skills"; skill?: string }
  | { page: "workflows"; tab?: "runs" | "automations"; run?: string; automation?: string };
export type Page = Route["page"];
export type ExecutiveTab = "today" | "portfolio" | "agent" | "comms" | "briefings";

export const safeStorage: StateStorage = {
  getItem: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  setItem: (k, v) => { try { localStorage.setItem(k, v); } catch { /* not persisted */ } },
  removeItem: (k) => { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

const BACK_LIMIT = 50;
const same = (a: Route, b: Route) => JSON.stringify(a) === JSON.stringify(b);

interface AppState {
  /** The picked project's slug; null is "All memory"; undefined until the first pick (the shell then chooses one). */
  project: string | null | undefined;
  domain: string | null;
  shelf: Shelf;
  palette: "commands" | "notes" | null;
  route: Route;
  /** Earlier routes, oldest first, for Back. */
  back: Route[];
  setProject: (project: string | null) => void;
  setDomain: (domain: string) => void;
  setShelf: (shelf: Shelf) => void;
  setPalette: (palette: AppState["palette"]) => void;
  /** Show a page. `replace` swaps the current route without adding to Back (filters, typed queries). `force` skips the leave
   *  guard. */
  go: (route: Route, opts?: { replace?: boolean; force?: boolean }) => void;
  goBack: (force?: boolean) => void;
}

/** Asked before every move; false stops it, and the guard may call `proceed` later to finish the same move. */
export type LeaveGuard = (proceed: () => void) => boolean;
let leaveGuard: LeaveGuard | null = null;
/** Guard every way of leaving the current route (Back, Alt+Left, the palette, shortcuts) while something would be lost, such
 *  as a capture review with unrecorded accepts. Returns the function that removes it. */
export function setLeaveGuard(guard: LeaveGuard): () => void {
  leaveGuard = guard;
  return () => { if (leaveGuard === guard) leaveGuard = null; };
}
const stopped = (proceed: () => void) => !!leaveGuard && !leaveGuard(proceed);
/** Do `move` (a change that leaves the current route, and anything else it changes) once the leave guard allows it. */
const whenFree = (move: () => void) => { if (!stopped(move)) move(); };

export const useApp = create<AppState>()(persist((set) => ({
  project: undefined,
  domain: null,
  shelf: "active",
  palette: null,
  route: { page: "overview" },
  back: [],
  setProject: (project) => set({ project }),
  setDomain: (domain) => set({ domain }),
  setShelf: (shelf) => set({ shelf }),
  setPalette: (palette) => set({ palette }),
  go: (route, opts = {}) => {
    if (!opts.force && stopped(() => useApp.getState().go(route, { ...opts, force: true }))) return;
    set((s) => (same(s.route, route) ? s : { route, back: opts.replace ? s.back : [...s.back, s.route].slice(-BACK_LIMIT) }));
  },
  goBack: (force) => {
    if (!useApp.getState().back.length) return;
    if (!force && stopped(() => useApp.getState().goBack(true))) return;
    set((s) => (s.back.length ? { route: s.back[s.back.length - 1], back: s.back.slice(0, -1) } : s));
  },
}), {
  name: "hivemind.nav",
  version: 1,
  storage: createJSONStorage(() => safeStorage),
  partialize: (s) => ({ project: s.project, domain: s.domain, route: s.route }),
}));

const app = () => useApp.getState();
/** Pick a project (null for all memory) and show its overview. */
export const openProject = (slug: string | null) => whenFree(() => { app().setProject(slug); app().go({ page: "overview" }, { force: true }); });
export const openSystem = (slug: string) => app().go({ page: "architecture", system: slug });
export const openSession = (session: string) => app().go({ page: "agents", session });
/** Show the Review page, on one session's edits (and one file) when given. */
export const openReview = (session?: string, file?: string) => app().go({ page: "review", session, file });
export const openSkills = (skill?: string) => app().go({ page: "skills", skill });
export const openWorkflows = (to: { tab?: "runs" | "automations"; run?: string; automation?: string } = {}) =>
  app().go({ page: "workflows", ...to, tab: to.automation ? "automations" : to.run ? "runs" : to.tab }, { replace: app().route.page === "workflows" });
export const startSession = () => app().go({ page: "agents", view: "new" });
export const openChange = (id: number) => app().go({ page: "changes", id, view: "detail" });
export const openExecutive = (to: { tab?: ExecutiveTab; capture?: string; briefing?: string; draft?: string; session?: string } = {}) => app().go({ page: "executive", ...to });
