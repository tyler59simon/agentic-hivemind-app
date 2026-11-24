// Where the app is: the picked project, the page in the sidebar, and the palette. Open notes live in the
// workspace store (src/workspace/store.ts) and are shown in Notes.
import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";

/** The Inbox's groups: each is a tab of the page. */
export type InboxKind = "code" | "memory" | "pages" | "captures" | "maintenance" | "architecture" | "skills";

/** One page per sidebar section. Notes holds the notebook and memory trees and the open documents.
 *  Home shows the picked project (or all of them); `view: "briefings"` opens its
 *  list of briefings, `briefing` one briefing, and `capture` the review of one capture batch; `tab: "architecture"` shows the
 *  Architecture tab, on one system when `system` is given. */
export type Route =
  | { page: "home"; view?: "briefings"; briefing?: string; capture?: string; tab?: "architecture"; system?: string }
  | { page: "agents"; session?: string; view?: "new" }
  | { page: "notes"; notebook?: string; path?: string; view?: "tasks" | "views" | "tags" | "graph"; ref?: string }
  | { page: "wiki"; domain?: string; at?: string; edition?: "agent"; project?: string }
  | { page: "maintenance" }
  | { page: "inbox"; session?: string; file?: string; kind?: InboxKind }
  | { page: "skills"; skill?: string }
  | { page: "workflows"; tab?: "runs" | "automations"; run?: string; automation?: string };
export type Page = Route["page"];

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
  palette: "commands" | "notes" | null;
  route: Route;
  /** Earlier routes, oldest first, for Back. */
  back: Route[];
  setProject: (project: string | null) => void;
  setDomain: (domain: string) => void;
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

/** Version 2 of the saved navigation: the Overview, Executive and Recap pages became Home. A capture or a briefing the Executive
 *  route pointed at stays on the Home route. Version 3: the Architecture page became Home's Architecture tab (its system is kept)
 *  and the Changes page was removed (CON-4, CON-17); a saved route to a removed page would have no page to show. Version 4:
 *  the Review page became the Inbox (CON-6), so a saved Review route opens it on the same session and file.
 *  Version 5 moves the old Memory workspace to Notes (CON-10). Version 6 removes `q` from the Memory route (CON-11).
 *  Version 7 moves Memory Graph and Tags into Notes (CON-12) and retires the Memory section and Activity/History pages (CON-21).
 *  Version 8 moves Dashboards into Notes > Views (CON-13): `ref` is the view the route names. */
export function migrateNav(persisted: unknown, version = 1): unknown {
  const saved = persisted as { route?: { page?: string; view?: string; q?: string; capture?: string; briefing?: string; system?: string; ref?: string } } | null;
  const route = saved?.route;
  if (!route) return persisted;
  if (version < 8 && route.page === "dashboards") return { ...saved, route: { page: "notes", view: "views", ...(route.ref ? { ref: route.ref } : {}) } };
  if (version < 7 && route.page === "memory") {
    if (route.view === "graph" || route.view === "tags") return { ...saved, route: { page: "notes", view: route.view } };
    if (route.view === "notes") return { ...saved, route: { page: "notes" } };
    return { ...saved, route: { page: "home" } };
  }
  if (version >= 4) return persisted;
  let home: Route;
  if (route.page === "overview" || route.page === "executive" || route.page === "recap") {
    home = { page: "home", ...(route.page === "executive" && route.capture ? { capture: route.capture } : {}), ...(route.page === "executive" && route.briefing ? { briefing: route.briefing } : {}) };
  } else if (route.page === "architecture") {
    home = { page: "home", tab: "architecture", ...(route.system ? { system: route.system } : {}) };
  } else if (route.page === "changes") {
    home = { page: "home" };
  } else if (route.page === "review") {
    return { ...saved, route: { ...route, page: "inbox" } };
  } else return persisted;
  return { ...saved, route: home };
}

export const useApp = create<AppState>()(persist((set) => ({
  project: undefined,
  domain: null,
  palette: null,
  route: { page: "home" },
  back: [],
  setProject: (project) => set({ project }),
  setDomain: (domain) => set({ domain }),
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
  version: 8,
  storage: createJSONStorage(() => safeStorage),
  migrate: (persisted, version) => migrateNav(persisted, version) as AppState,
  partialize: (s) => ({ project: s.project, domain: s.domain, route: s.route }),
}));

const app = () => useApp.getState();
/** Pick a project (null for all memory) and show its Home. */
export const openProject = (slug: string | null) => whenFree(() => { app().setProject(slug); app().go({ page: "home" }, { force: true }); });
/** Show a system on Home's Architecture tab, whichever project is picked. */
export const openSystem = (slug: string) => app().go({ page: "home", tab: "architecture", system: slug });
export const openSession = (session: string) => app().go({ page: "agents", session });
/** Show the Inbox: on one session's edits (and one file) when given, or on one group. */
export const openInbox = (session?: string, file?: string, kind?: InboxKind) => app().go({ page: "inbox", session, file, kind });
export const openSkills = (skill?: string) => app().go({ page: "skills", skill });
export const openWorkflows = (to: { tab?: "runs" | "automations"; run?: string; automation?: string } = {}) =>
  app().go({ page: "workflows", ...to, tab: to.automation ? "automations" : to.run ? "runs" : to.tab }, { replace: app().route.page === "workflows" });
export const startSession = () => app().go({ page: "agents", view: "new" });
