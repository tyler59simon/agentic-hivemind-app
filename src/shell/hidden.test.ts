import { beforeEach, describe, expect, it } from "vitest";
import type { Page } from "../store";
import { migrateHidden, useHidden } from "./hidden";

const hidden = () => useHidden.getState().hidden;
const setShown = (page: Page, shown: boolean) => useHidden.getState().setShown(page, shown);

describe("hidden sidebar sections", () => {
  beforeEach(() => useHidden.setState({ hidden: [] }));

  it("hides a section and shows it again", () => {
    setShown("skills", false);
    expect(hidden()).toEqual(["skills"]);
    setShown("skills", true);
    expect(hidden()).toEqual([]);
  });

  it("hiding twice keeps one entry", () => {
    setShown("maintenance", false);
    setShown("maintenance", false);
    expect(hidden()).toEqual(["maintenance"]);
  });

  it("drops saved hides of removed sections (architecture, changes, overview, executive, recap, memory, dashboards, wiki)", () => {
    expect(migrateHidden({ hidden: ["architecture", "skills", "changes", "overview", "executive", "recap", "memory", "dashboards", "wiki"] })).toEqual({ hidden: ["skills"] });
    expect(migrateHidden(null)).toBeNull();
    expect(useHidden.persist.getOptions().version).toBe(6);
  });

  it("hides the Inbox where the user hid Review", () => {
    expect(migrateHidden({ hidden: ["skills", "review"] })).toEqual({ hidden: ["skills", "inbox"] });
    expect(migrateHidden({ hidden: ["review", "inbox"] })).toEqual({ hidden: ["inbox"] });
  });

  it("never hides Home", () => {
    setShown("home", false);
    expect(hidden()).toEqual([]);
  });
});
