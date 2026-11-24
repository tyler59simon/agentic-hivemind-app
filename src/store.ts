// Where the app is: the picked project, the page in the sidebar, and the palette. Open notes live in the
// workspace store (src/workspace/store.ts) and are shown in Notes.
import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";

/** The Inbox's groups: each is a tab of the page. */
export type InboxKind = "code" | "memory" | "pages" | "captures" | "maintenance" | "architecture" | "skills";

/** One page per sidebar section. Notes holds the notebook and memory trees and the open documents; `view: "skills"` shows the
 *  skills library (on `skill` when given); `view: "wiki"` shows the wiki of the
 *  picked project, at the page `at` of `domain` and in the agent-written `edition`, or with `whole` the wiki of the whole domain.
 *  Home shows the picked project (or all of them); `view: "briefings"` opens its
 *  list of briefings, `briefing` one briefing, and `capture` the review of one capture batch; `tab: "architecture"` shows the
 *  Architecture tab, on one system when `system` is given. */
export type Route =
  | { page: "home"; view?: "briefings"; briefing?: string; capture?: string; tab?: "architecture"; system?: string }
  | { page: "agents"; session?: string; view?: "new" }
  | { page: "notes"; notebook?: string; path?: string; view?: "tasks" | "views" | "tags" | "graph" | "wiki" | "skills"; ref?: string; domain?: string; at?: string; edition?: "agent"; whole?: true; skill?: string }
  | { page: "inbox"; session?: string; file?: string; kind?: InboxKind };
export type Page = Route["page"];

/** The Settings sections a link can open at. Settings is not a route: it replaces the whole shell while it is open. */
export type SettingsSection = "learning" | "spend" | "schedules" | "maintenance";

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
  /** Settings while it is open, at a section when a link asked for one; null when closed. Not kept over a restart. */
  /** Settings while it is open: the section a link opened it at, and with `automation` the automation to show in Schedules. */
  settings: { section?: SettingsSection; automation?: string } | null;
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
 *  Version 8 moves Dashboards into Notes > Views (CON-13): `ref` is the view the route names.
 *  Version 9 moves the Wiki into Notes (CON-14): the project it named becomes the picked project.
 *  Version 10 removes the Workflows page (CON-20): its schedules are in Settings, so a saved Workflows route opens Home.
 *  Version 11 moves Skills into Notes > Skills and Maintenance into Settings (CON-22); a saved Maintenance route opens Home. */
export function migrateNav(persisted: unknown, version = 1): unknown {
  const saved = persisted as { route?: { page?: string; view?: string; q?: string; capture?: string; briefing?: string; system?: string; ref?: string; domain?: string; at?: string; edition?: string; project?: string; skill?: string } } | null;
  const route = saved?.route;
  if (!route) return persisted;
  if (version < 11 && route.page === "skills") return { ...saved, route: { page: "notes", view: "skills", ...(route.skill ? { skill: route.skill } : {}) } };
  if (version < 11 && route.page === "maintenance") return { ...saved, route: { page: "home" } };
  if (version < 10 && route.page === "workflows") return { ...saved, route: { page: "home" } };
  if (version < 9 && route.page === "wiki") {
    const { domain, at, edition, project } = route;
    return { ...saved, ...(project ? { project } : {}), route: { page: "notes", view: "wiki", ...(domain ? { domain } : {}), ...(at ? { at } : {}), ...(edition === "agent" ? { edition } : {}),
      // A route that named no project showed a whole domain's wiki: keep that view when no project is picked.
      ...(project ? {} : { whole: true }) } };
  }
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
  settings: null,
  setProject: (project) => set({ project }),
  setDomain: (domain) => set({ domain }),
  setPalette: (palette) => set({ palette }),
  go: (route, opts = {}) => {
    if (!opts.force && stopped(() => useApp.getState().go(route, { ...opts, force: true }))) return;
    // Settings covers the shell, so going anywhere closes it: a link in Settings shows where it leads (Codex review of 857ec37, S2).
    set((s) => (same(s.route, route) ? (s.settings ? { settings: null } : s) : { route, back: opts.replace ? s.back : [...s.back, s.route].slice(-BACK_LIMIT), settings: null }));
  },
  goBack: (force) => {
    if (!useApp.getState().back.length) return;
    if (!force && stopped(() => useApp.getState().goBack(true))) return;
    set((s) => (s.back.length ? { route: s.back[s.back.length - 1], back: s.back.slice(0, -1) } : s));
  },
}), {
  name: "hivemind.nav",
  version: 11,
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
export const openSkills = (skill?: string) => app().go({ page: "notes", view: "skills", ...(skill ? { skill } : {}) });
/** Open Settings, at a section when one is given (Schedules, Spend, Maintenance, Learning). */
export const openSettings = (section?: SettingsSection) => useApp.setState({ settings: section ? { section } : {} });
/** Open Settings > Schedules at one automation, shown even when it is a custom one and those are hidden. */
export const openAutomation = (automation: string) => useApp.setState({ settings: { section: "schedules", automation } });
export const closeSettings = () => useApp.setState({ settings: null });
export const startSession = () => app().go({ page: "agents", view: "new" });
