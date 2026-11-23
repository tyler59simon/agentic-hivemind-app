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
    setShown("wiki", false);
    setShown("wiki", false);
    expect(hidden()).toEqual(["wiki"]);
  });

  it("drops a saved hide of the removed Architecture and Changes sections", () => {
    expect(migrateHidden({ hidden: ["architecture", "wiki", "changes"] })).toEqual({ hidden: ["wiki"] });
    expect(migrateHidden(null)).toBeNull();
    expect(useHidden.persist.getOptions().version).toBe(3);
  });

  it("hides the Inbox where the user hid Review", () => {
    expect(migrateHidden({ hidden: ["wiki", "review"] })).toEqual({ hidden: ["wiki", "inbox"] });
    expect(migrateHidden({ hidden: ["review", "inbox"] })).toEqual({ hidden: ["inbox"] });
  });

  it("never hides Home", () => {
    setShown("home", false);
    expect(hidden()).toEqual([]);
  });
});
