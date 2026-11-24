import { beforeEach, describe, expect, it } from "vitest";
import type { Page } from "../store";
import { migrateHidden, useHidden } from "./hidden";

const hidden = () => useHidden.getState().hidden;
const setShown = (page: Page, shown: boolean) => useHidden.getState().setShown(page, shown);

describe("hidden sidebar sections", () => {
  beforeEach(() => useHidden.setState({ hidden: [] }));

  it("hides a section and shows it again", () => {
    setShown("agents", false);
    expect(hidden()).toEqual(["agents"]);
    setShown("agents", true);
    expect(hidden()).toEqual([]);
  });

  it("hiding twice keeps one entry", () => {
    setShown("notes", false);
    setShown("notes", false);
    expect(hidden()).toEqual(["notes"]);
  });

  it("drops saved hides of removed sections (architecture, changes, overview, executive, recap, memory, dashboards, wiki, workflows, maintenance, skills)", () => {
    expect(migrateHidden({ hidden: ["architecture", "agents", "changes", "overview", "executive", "recap", "memory", "dashboards", "wiki", "workflows", "maintenance", "skills"] })).toEqual({ hidden: ["agents"] });
    expect(migrateHidden(null)).toBeNull();
    expect(useHidden.persist.getOptions().version).toBe(8);
  });

  it("hides the Inbox where the user hid Review", () => {
    expect(migrateHidden({ hidden: ["notes", "review"] })).toEqual({ hidden: ["notes", "inbox"] });
    expect(migrateHidden({ hidden: ["review", "inbox"] })).toEqual({ hidden: ["inbox"] });
  });

  it("never hides Home", () => {
    setShown("home", false);
    expect(hidden()).toEqual([]);
  });
});
