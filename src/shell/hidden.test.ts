import { beforeEach, describe, expect, it } from "vitest";
import type { Page } from "../store";
import { useHidden } from "./hidden";

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

  it("never hides Home", () => {
    setShown("home", false);
    expect(hidden()).toEqual([]);
  });
});
