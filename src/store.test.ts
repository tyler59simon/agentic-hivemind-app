import { beforeEach, describe, expect, it } from "vitest";
import { wikiRoute } from "./features/wiki/wiki";
import { migrateNav, openProject, openReview, openSession, openSystem, setLeaveGuard, startSession, useApp } from "./store";

const app = () => useApp.getState();

describe("navigation", () => {
  beforeEach(() => useApp.setState({ route: { page: "home" }, back: [], project: undefined }));

  it("go shows a page and Back returns to the one before", () => {
    app().go({ page: "memory" });
    app().go({ page: "review" });
    expect(app().route).toEqual({ page: "review" });
    app().goBack();
    expect(app().route).toEqual({ page: "memory" });
    app().goBack();
    expect(app().route).toEqual({ page: "home" });
    app().goBack();
    expect(app().route).toEqual({ page: "home" });
  });

  it("going to the route already shown adds nothing to Back", () => {
    app().go({ page: "memory", view: "notes" });
    app().go({ page: "memory", view: "notes" });
    expect(app().back).toEqual([{ page: "home" }]);
  });

  it("replace swaps the route without growing Back", () => {
    app().go({ page: "memory" });
    app().go({ page: "memory", q: "idem" }, { replace: true });
    app().go({ page: "memory", q: "idempotency" }, { replace: true });
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
    app().go({ page: "memory" });
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

  it("openReview routes to a session and file", () => {
    openReview("s1", "a/b.ts");
    expect(app().route).toEqual({ page: "review", session: "s1", file: "a/b.ts" });
    expect(app().back).toEqual([{ page: "home" }]);
    openReview();
    expect(app().route).toEqual({ page: "review" });
  });

  it("opens the New session screen", () => {
    startSession();
    expect(app().route).toEqual({ page: "agents", view: "new" });
  });

  it("shows a wiki page by its address, in one domain", () => {
    app().go({ page: "wiki", domain: "demo", at: "p-core" });
    app().go({ page: "wiki", domain: "demo", at: "n-0a1b2c3d" });
    expect(app().route).toEqual({ page: "wiki", domain: "demo", at: "n-0a1b2c3d" });
    expect(app().back).toEqual([{ page: "home" }, { page: "wiki", domain: "demo", at: "p-core" }]);
  });

  it("Back from the structured edition returns to the agent edition and its scope", () => {
    app().go(wikiRoute("demo", { at: "n-pg0a1b2c", agent: true, project: "core" }));
    app().go(wikiRoute("demo", { at: "p-core" }));
    expect(app().route).toEqual({ page: "wiki", domain: "demo", at: "p-core" });
    app().goBack();
    expect(app().route).toEqual({ page: "wiki", domain: "demo", at: "n-pg0a1b2c", edition: "agent", project: "core" });
  });

  // EXEC-R3a: Alt+Left and the palette Back left a capture review without its close check.
  it("a leave guard can stop a move and finish it later", () => {
    app().go({ page: "memory" });
    app().go({ page: "home", capture: "b1" });
    let later: (() => void) | null = null;
    const clear = setLeaveGuard((proceed) => { later = proceed; return false; });
    app().goBack();
    app().go({ page: "review" });
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
    app().go({ page: "review" });
    expect(app().route).toEqual({ page: "review" });
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

describe("saved navigation", () => {
  const migrate = (route: object, version = 1) => useApp.persist.getOptions().migrate!({ project: "pay", domain: "demo", route }, version);

  it("is version 3, and moves the Overview, Executive and Recap pages to Home", () => {
    expect(useApp.persist.getOptions().version).toBe(3);
    for (const page of ["overview", "executive", "recap"]) expect(migrate({ page })).toEqual({ project: "pay", domain: "demo", route: { page: "home" } });
    expect(migrate({ page: "overview", view: "work" })).toMatchObject({ route: { page: "home" } });
  });

  it("keeps the capture or briefing an Executive route showed, and leaves other pages alone", () => {
    expect(migrate({ page: "executive", tab: "briefings", briefing: "b9", draft: "d1", session: "s1" })).toMatchObject({ route: { page: "home", briefing: "b9" } });
    expect(migrate({ page: "executive", capture: "c1" })).toMatchObject({ route: { page: "home", capture: "c1" } });
    expect(migrate({ page: "memory", view: "graph" })).toMatchObject({ route: { page: "memory", view: "graph" } });
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

  it("does not migrate a version 3 save", () => {
    expect(migrate({ page: "home", tab: "architecture", system: "s" }, 3)).toMatchObject({ route: { page: "home", tab: "architecture", system: "s" } });
  });
});
