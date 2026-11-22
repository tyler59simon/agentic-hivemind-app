// @vitest-environment jsdom
// NS-7A: Quick capture remembers where it adds a note (`hivemind.captureTarget`).
import { beforeEach, describe, expect, it } from "vitest";
import { prefs } from "./prefs";

beforeEach(() => localStorage.clear());

describe("where Quick capture goes", () => {
  it("is a Memory note until the user picks a notebook target, which is remembered", () => {
    expect(prefs.captureTarget()).toEqual({ kind: "memory", notebook: "" });
    prefs.setCaptureTarget({ kind: "today", notebook: "nb-1" });
    expect(prefs.captureTarget()).toEqual({ kind: "today", notebook: "nb-1" });
    expect(localStorage.getItem("hivemind.captureTarget")).toBe('{"kind":"today","notebook":"nb-1"}');
  });

  it("reads anything damaged as a Memory note", () => {
    localStorage.setItem("hivemind.captureTarget", '{"kind":"elsewhere","notebook":3}');
    expect(prefs.captureTarget()).toEqual({ kind: "memory", notebook: "" });
    localStorage.setItem("hivemind.captureTarget", "not json");
    expect(prefs.captureTarget()).toEqual({ kind: "memory", notebook: "" });
  });
});
