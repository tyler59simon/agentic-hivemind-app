// Where the app is: the picked project, the page in the sidebar, and the palette. Open notes live in the
// workspace store (src/workspace/store.ts); a note is shown on the Memory page.
import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";

export type Shelf = "active" | "archived" | "any";

/** One page per sidebar section. Memory also holds the open notes (`view: "notes"`) and its sub-views. */
export type Route =
  | { page: "overview"; view?: "work" }
  | { page: "agents"; session?: string; view?: "new" }
  | { page: "changes"; id?: number; view?: "detail"; ref?: string }
  | { page: "architecture"; system?: string }
  | { page: "memory"; view?: "notes" | "graph" | "activity" | "history" | "tags"; q?: string }
  | { page: "review" };
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
  shelf: Shelf;
  palette: "commands" | "notes" | null;
  route: Route;
  /** Earlier routes, oldest first, for Back. */
  back: Route[];
  setProject: (project: string | null) => void;
  setDomain: (domain: string) => void;
  setShelf: (shelf: Shelf) => void;
  setPalette: (palette: AppState["palette"]) => void;
  /** Show a page. `replace` swaps the current route without adding to Back (filters, typed queries). */
  go: (route: Route, opts?: { replace?: boolean }) => void;
  goBack: () => void;
}

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
  go: (route, opts = {}) => set((s) => (same(s.route, route) ? s
    : { route, back: opts.replace ? s.back : [...s.back, s.route].slice(-BACK_LIMIT) })),
  goBack: () => set((s) => (s.back.length ? { route: s.back[s.back.length - 1], back: s.back.slice(0, -1) } : s)),
}), {
  name: "hivemind.nav",
  version: 1,
  storage: createJSONStorage(() => safeStorage),
  partialize: (s) => ({ project: s.project, domain: s.domain, route: s.route }),
}));

const app = () => useApp.getState();
/** Pick a project (null for all memory) and show its overview. */
export const openProject = (slug: string | null) => { app().setProject(slug); app().go({ page: "overview" }); };
export const openSystem = (slug: string) => app().go({ page: "architecture", system: slug });
export const openSession = (session: string) => app().go({ page: "agents", session });
export const startSession = () => app().go({ page: "agents", view: "new" });
export const openChange = (id: number) => app().go({ page: "changes", id, view: "detail" });
