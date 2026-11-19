import { beforeEach, describe, expect, it } from "vitest";
import { wikiRoute } from "./features/wiki/wiki";
import { openProject, openReview, openSession, openSystem, startSession, useApp } from "./store";

const app = () => useApp.getState();

describe("navigation", () => {
  beforeEach(() => useApp.setState({ route: { page: "overview" }, back: [], project: undefined }));

  it("go shows a page and Back returns to the one before", () => {
    app().go({ page: "memory" });
    app().go({ page: "review" });
    expect(app().route).toEqual({ page: "review" });
    app().goBack();
    expect(app().route).toEqual({ page: "memory" });
    app().goBack();
    expect(app().route).toEqual({ page: "overview" });
    app().goBack();
    expect(app().route).toEqual({ page: "overview" });
  });

  it("going to the route already shown adds nothing to Back", () => {
    app().go({ page: "memory", view: "notes" });
    app().go({ page: "memory", view: "notes" });
    expect(app().back).toEqual([{ page: "overview" }]);
  });

  it("replace swaps the route without growing Back", () => {
    app().go({ page: "memory" });
    app().go({ page: "memory", q: "idem" }, { replace: true });
    app().go({ page: "memory", q: "idempotency" }, { replace: true });
    expect(app().back).toEqual([{ page: "overview" }]);
    app().goBack();
    expect(app().route).toEqual({ page: "overview" });
  });

  it("keeps only the newest 50 routes for Back", () => {
    for (let i = 0; i < 60; i++) app().go({ page: "agents", session: String(i) });
    expect(app().back).toHaveLength(50);
    expect(app().back[49]).toEqual({ page: "agents", session: "58" });
  });

  it("opens a project on its overview, and a system or session on its page", () => {
    app().go({ page: "memory" });
    openProject("paystream");
    expect([app().project, app().route]).toEqual(["paystream", { page: "overview" }]);
    openSystem("ingestion");
    expect(app().route).toEqual({ page: "architecture", system: "ingestion" });
    openSession("s1");
    expect(app().route).toEqual({ page: "agents", session: "s1" });
    openProject(null);
    expect(app().project).toBeNull();
  });

  it("openReview routes to a session and file", () => {
    openReview("s1", "a/b.ts");
    expect(app().route).toEqual({ page: "review", session: "s1", file: "a/b.ts" });
    expect(app().back).toEqual([{ page: "overview" }]);
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
    expect(app().back).toEqual([{ page: "overview" }, { page: "wiki", domain: "demo", at: "p-core" }]);
  });

  it("Back from the structured edition returns to the agent edition and its scope", () => {
    app().go(wikiRoute("demo", { at: "n-pg0a1b2c", agent: true, project: "core" }));
    app().go(wikiRoute("demo", { at: "p-core" }));
    expect(app().route).toEqual({ page: "wiki", domain: "demo", at: "p-core" });
    app().goBack();
    expect(app().route).toEqual({ page: "wiki", domain: "demo", at: "n-pg0a1b2c", edition: "agent", project: "core" });
  });
});
