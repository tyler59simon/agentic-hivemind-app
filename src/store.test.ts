import { beforeEach, describe, expect, it } from "vitest";
import { wikiRoute } from "./features/wiki/wiki";
import { migrateNav, openInbox, openProject, openSession, openSettings, openSystem, setLeaveGuard, startSession, useApp } from "./store";

const app = () => useApp.getState();

describe("navigation", () => {
  beforeEach(() => useApp.setState({ route: { page: "home" }, back: [], project: undefined }));

  it("go shows a page and Back returns to the one before", () => {
    app().go({ page: "notes" });
    app().go({ page: "inbox" });
    expect(app().route).toEqual({ page: "inbox" });
    app().goBack();
    expect(app().route).toEqual({ page: "notes" });
    app().goBack();
    expect(app().route).toEqual({ page: "home" });
    app().goBack();
    expect(app().route).toEqual({ page: "home" });
  });

  it("going to the route already shown adds nothing to Back", () => {
    app().go({ page: "notes" });
    app().go({ page: "notes" });
    expect(app().back).toEqual([{ page: "home" }]);
  });

  it("replace swaps the route without growing Back", () => {
    app().go({ page: "notes", view: "graph" });
    app().go({ page: "notes", view: "tags" }, { replace: true });
    app().go({ page: "notes", view: "tasks" }, { replace: true });
    expect(app().back).toEqual([{ page: "home" }]);
    app().goBack();
    expect(app().route).toEqual({ page: "home" });
  });

  it("keeps only the newest 50 routes for Back", () => {
    for (let i = 0; i < 60; i++) app().go({ page: "agents", session: String(i) });
    expect(app().back).toHaveLength(50);
    expect(app().back[49]).toEqual({ page: "agents", session: "58" });
  });

  it("opens a project on its Home, and a system or session on its page", () => {
    app().go({ page: "notes" });
    openProject("paystream");
    expect([app().project, app().route]).toEqual(["paystream", { page: "home" }]);
    openSystem("ingestion");
    expect(app().route).toEqual({ page: "home", tab: "architecture", system: "ingestion" });
    expect(app().project).toBe("paystream");
    openSession("s1");
    expect(app().route).toEqual({ page: "agents", session: "s1" });
    openProject(null);
    expect(app().project).toBeNull();
  });

  it("openInbox routes to a session and file, or to a group", () => {
    openInbox("s1", "a/b.ts");
    expect(app().route).toEqual({ page: "inbox", session: "s1", file: "a/b.ts" });
    expect(app().back).toEqual([{ page: "home" }]);
    openInbox();
    expect(app().route).toEqual({ page: "inbox" });
    openInbox(undefined, undefined, "captures");
    expect(app().route).toEqual({ page: "inbox", kind: "captures" });
  });

  it("opens the New session screen", () => {
    startSession();
    expect(app().route).toEqual({ page: "agents", view: "new" });
  });

  it("shows a wiki page by its address, in one domain", () => {
    app().go(wikiRoute("demo", { at: "p-core" }));
    app().go(wikiRoute("demo", { at: "n-0a1b2c3d" }));
    expect(app().route).toEqual({ page: "notes", view: "wiki", domain: "demo", at: "n-0a1b2c3d" });
    expect(app().back).toEqual([{ page: "home" }, { page: "notes", view: "wiki", domain: "demo", at: "p-core" }]);
  });

  it("Back from the structured edition returns to the agent edition", () => {
    app().go(wikiRoute("demo", { at: "n-pg0a1b2c", agent: true }));
    app().go(wikiRoute("demo", { at: "p-core" }));
    expect(app().route).toEqual({ page: "notes", view: "wiki", domain: "demo", at: "p-core" });
    app().goBack();
    expect(app().route).toEqual({ page: "notes", view: "wiki", domain: "demo", at: "n-pg0a1b2c", edition: "agent" });
  });

  // EXEC-R3a: Alt+Left and the palette Back left a capture review without its close check.
  it("a leave guard can stop a move and finish it later", () => {
    app().go({ page: "notes" });
    app().go({ page: "home", capture: "b1" });
    let later: (() => void) | null = null;
    const clear = setLeaveGuard((proceed) => { later = proceed; return false; });
    app().goBack();
    app().go({ page: "inbox" });
    expect(app().route).toEqual({ page: "home", capture: "b1" });
    app().go({ page: "home" }, { force: true });
    expect(app().route).toEqual({ page: "home" });
    app().go({ page: "home", capture: "b1" }, { force: true });
    app().goBack();
    later!();
    expect(app().route).toEqual({ page: "home" }); // the stopped Back, finished
    clear();
    app().goBack();
    expect(app().route).toEqual({ page: "home", capture: "b1" });
    const allow = setLeaveGuard(() => true);
    app().go({ page: "inbox" });
    expect(app().route).toEqual({ page: "inbox" });
    allow();
  });

  // Codex review of 6f8714e.
  it("Back with nowhere to go asks nothing, and a stopped project switch changes nothing until it goes ahead", () => {
    let asked = 0;
    let later: (() => void) | null = null;
    const clear = setLeaveGuard((proceed) => { asked++; later = proceed; return false; });
    app().goBack();
    expect(asked).toBe(0);
    useApp.setState({ project: "pay" });
    openProject("core");
    expect(app().project).toBe("pay");
    expect(app().route).toEqual({ page: "home" });
    later!();
    expect(app().project).toBe("core");
    clear();
  });
});

// Codex review of 857ec37, S2: a link inside Settings (a session, a note, the Inbox) closes Settings so its target shows.
describe("Settings", () => {
  beforeEach(() => useApp.setState({ route: { page: "home" }, back: [], settings: null }));
  it("opens at a section and closes when a link goes anywhere, the current page included", () => {
    openSettings("schedules");
    expect(useApp.getState().settings).toEqual({ section: "schedules" });
    openSession("s1");
    expect(useApp.getState()).toMatchObject({ settings: null, route: { page: "agents", session: "s1" } });
    openSettings();
    expect(useApp.getState().settings).toEqual({});
    useApp.getState().go({ page: "agents", session: "s1" });
    expect(useApp.getState().settings).toBeNull();
  });
});

describe("saved navigation", () => {
  const migrate = (route: object, version = 1) => useApp.persist.getOptions().migrate!({ project: "pay", domain: "demo", route }, version);

  it("is version 12, and moves the Overview, Executive and Recap pages to Home", () => {
    expect(useApp.persist.getOptions().version).toBe(12);
    for (const page of ["overview", "executive", "recap"]) expect(migrate({ page })).toEqual({ project: "pay", domain: "demo", route: { page: "home" } });
    expect(migrate({ page: "overview", view: "work" })).toMatchObject({ route: { page: "home" } });
  });

  // CON-18: a Notes route that named a page of a hosted notebook has no notebook to open.
  it("sends a saved route to a hosted notebook's page to Notes, and leaves a folder notebook's page alone", () => {
    expect(migrate({ page: "notes", notebook: "lm:demo:plans", path: "Ideas/A.md" }, 11)).toEqual({ project: "pay", domain: "demo", route: { page: "notes" } });
    expect(migrate({ page: "notes", notebook: "lm:demo:plans", path: "A.md" }, 7)).toEqual({ project: "pay", domain: "demo", route: { page: "notes" } });
    expect(migrate({ page: "notes", notebook: "nb-1", path: "A.md" }, 11)).toEqual({ project: "pay", domain: "demo", route: { page: "notes", notebook: "nb-1", path: "A.md" } });
    expect(migrate({ page: "notes", view: "tasks" }, 11)).toMatchObject({ route: { page: "notes", view: "tasks" } });
  });

  it("moves Memory Graph/Tags/notes to Notes and retires Memory Activity/History/bare routes on v7", () => {
    expect(migrate({ page: "memory", view: "notes" }, 4)).toEqual({ project: "pay", domain: "demo", route: { page: "notes" } });
    expect(migrate({ page: "memory", view: "graph" }, 6)).toEqual({ project: "pay", domain: "demo", route: { page: "notes", view: "graph" } });
    expect(migrate({ page: "memory", view: "tags" }, 6)).toEqual({ project: "pay", domain: "demo", route: { page: "notes", view: "tags" } });
    expect(migrate({ page: "memory", view: "activity" }, 6)).toEqual({ project: "pay", domain: "demo", route: { page: "home" } });
    expect(migrate({ page: "memory", view: "history" }, 6)).toEqual({ project: "pay", domain: "demo", route: { page: "home" } });
    expect(migrate({ page: "memory", q: "ledger" }, 5)).toEqual({ project: "pay", domain: "demo", route: { page: "home" } });
    expect(migrate({ page: "memory" }, 6)).toEqual({ project: "pay", domain: "demo", route: { page: "home" } });
  });

  it("keeps the capture or briefing an Executive route showed, and leaves other pages alone", () => {
    expect(migrate({ page: "executive", tab: "briefings", briefing: "b9", draft: "d1", session: "s1" })).toMatchObject({ route: { page: "home", briefing: "b9" } });
    expect(migrate({ page: "executive", capture: "c1" })).toMatchObject({ route: { page: "home", capture: "c1" } });
    expect(migrate({ page: "notes", view: "graph" })).toMatchObject({ route: { page: "notes", view: "graph" } });
    expect(migrateNav(null)).toBeNull();
    expect(migrateNav({ project: "pay" })).toEqual({ project: "pay" });
  });

  // CON-4, CON-17: a saved route to a removed page would make the shell look up a page that no longer exists.
  it("moves a saved Architecture route to Home's Architecture tab, keeping its system and the picked project", () => {
    expect(migrate({ page: "architecture", system: "ingestion" }, 2)).toEqual({ project: "pay", domain: "demo", route: { page: "home", tab: "architecture", system: "ingestion" } });
    expect(migrate({ page: "architecture" }, 2)).toMatchObject({ route: { page: "home", tab: "architecture" } });
    expect(migrate({ page: "architecture" }, 1)).toEqual({ project: "pay", domain: "demo", route: { page: "home", tab: "architecture" } });
  });

  it("moves a saved Changes route to Home", () => {
    expect(migrate({ page: "changes", id: 14, view: "detail" }, 2)).toEqual({ project: "pay", domain: "demo", route: { page: "home" } });
  });

  // CON-6: the Review page became the Inbox.
  it("moves a saved Review route to the Inbox, keeping its session and file", () => {
    expect(migrate({ page: "review" }, 3)).toEqual({ project: "pay", domain: "demo", route: { page: "inbox" } });
    expect(migrate({ page: "review", session: "s1", file: "a/b.ts" }, 3)).toEqual({ project: "pay", domain: "demo", route: { page: "inbox", session: "s1", file: "a/b.ts" } });
    expect(migrate({ page: "review" }, 1)).toMatchObject({ route: { page: "inbox" } });
  });

  it("does not rerun older migrations on a version 4 save", () => {
    expect(migrate({ page: "home", tab: "architecture", system: "s" }, 4)).toMatchObject({ route: { page: "home", tab: "architecture", system: "s" } });
    expect(migrate({ page: "review" }, 4)).toMatchObject({ route: { page: "review" } });
  });

  // CON-13: the Dashboards page became Notes > Views.
  it("moves a saved Dashboards route to Notes > Views, keeping the view it showed", () => {
    expect(migrate({ page: "dashboards", ref: "demo:3a562a09-2b34-4a43-8901-c7a1801168e6" }, 7)).toEqual({ project: "pay", domain: "demo", route: { page: "notes", view: "views", ref: "demo:3a562a09-2b34-4a43-8901-c7a1801168e6" } });
    expect(migrate({ page: "dashboards" }, 7)).toEqual({ project: "pay", domain: "demo", route: { page: "notes", view: "views" } });
    expect(migrate({ page: "dashboards", ref: "demo:x" }, 1)).toMatchObject({ route: { page: "notes", view: "views", ref: "demo:x" } });
  });

  // CON-14: the Wiki page became Notes > Wiki, and the project it named became the picked project.
  it("moves a saved Wiki route to Notes > Wiki and picks the project it named", () => {
    expect(migrate({ page: "wiki", domain: "demo", at: "n-pg0a1b2c", edition: "agent", project: "core" }, 8))
      .toEqual({ project: "core", domain: "demo", route: { page: "notes", view: "wiki", domain: "demo", at: "n-pg0a1b2c", edition: "agent" } });
    // A route that named no project showed a whole domain: it keeps that view (whole) when no project is picked.
    expect(migrate({ page: "wiki", domain: "demo", at: "p-core" }, 8)).toEqual({ project: "pay", domain: "demo", route: { page: "notes", view: "wiki", domain: "demo", at: "p-core", whole: true } });
    expect(migrate({ page: "wiki" }, 8)).toEqual({ project: "pay", domain: "demo", route: { page: "notes", view: "wiki", whole: true } });
    expect(migrate({ page: "wiki", domain: "demo", project: "core" }, 1)).toMatchObject({ project: "core", route: { page: "notes", view: "wiki", domain: "demo" } });
    // The whole-domain scope of the agent edition ("") names no project.
    expect(migrate({ page: "wiki", domain: "demo", edition: "agent", project: "" }, 8)).toEqual({ project: "pay", domain: "demo", route: { page: "notes", view: "wiki", domain: "demo", edition: "agent", whole: true } });
  });

  // CON-20: the Workflows page was deleted; its schedules are in Settings, which is not a route.
  it("sends a saved Workflows route to Home", () => {
    expect(migrate({ page: "workflows", tab: "automations", automation: "a1" }, 9)).toEqual({ project: "pay", domain: "demo", route: { page: "home" } });
    expect(migrate({ page: "workflows" }, 1)).toMatchObject({ route: { page: "home" } });
  });

  // CON-22: Skills became Notes > Skills; Maintenance became a Settings section, which is not a route.
  it("moves a saved Skills route to Notes > Skills and sends Maintenance to Home", () => {
    expect(migrate({ page: "skills", skill: "restart-recovery" }, 10)).toEqual({ project: "pay", domain: "demo", route: { page: "notes", view: "skills", skill: "restart-recovery" } });
    expect(migrate({ page: "skills" }, 1)).toEqual({ project: "pay", domain: "demo", route: { page: "notes", view: "skills" } });
    expect(migrate({ page: "maintenance" }, 10)).toEqual({ project: "pay", domain: "demo", route: { page: "home" } });
  });

  it("leaves a version 11 save alone", () => {
    expect(migrate({ page: "inbox", kind: "skills" }, 11)).toMatchObject({ route: { page: "inbox", kind: "skills" } });
    expect(migrate({ page: "notes", view: "skills", skill: "x" }, 11)).toMatchObject({ route: { page: "notes", view: "skills", skill: "x" } });
  });

  it("leaves a version 9 save alone", () => {
    expect(migrate({ page: "notes", view: "wiki", domain: "demo", at: "az", whole: true }, 9)).toEqual({ project: "pay", domain: "demo", route: { page: "notes", view: "wiki", domain: "demo", at: "az", whole: true } });
  });

  it("leaves a version 8 save, and the Notes routes of older ones, alone", () => {
    expect(migrate({ page: "notes", view: "views", ref: "q-1a2b3c4d" }, 8)).toMatchObject({ route: { page: "notes", view: "views", ref: "q-1a2b3c4d" } });
    expect(migrate({ page: "notes", view: "views" }, 7)).toMatchObject({ route: { page: "notes", view: "views" } });
  });
});
