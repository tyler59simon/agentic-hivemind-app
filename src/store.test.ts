import { beforeEach, describe, expect, it } from "vitest";
import { openProject, openSession, openSystem, useApp } from "./store";

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
});
