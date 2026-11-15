import { describe, expect, it } from "vitest";
import { dotOf, dotTitle, lookingAt, useAttention } from "./attention";
import type { TermInfo } from "../../lib/term";

describe("dotOf", () => {
  it("is null when nothing wants the user", () => {
    expect(dotOf([])).toBeNull();
    expect(dotOf([null, undefined])).toBeNull();
  });
  it("shows done when one finished", () => {
    expect(dotOf([null, "done", "done"])).toBe("done");
  });
  it("lets waiting win over done, wherever it is", () => {
    expect(dotOf(["done", "waiting"])).toBe("waiting");
    expect(dotOf(["waiting", "done"])).toBe("waiting");
  });
  it("names each dot", () => {
    expect(dotTitle("waiting")).toBe("Waiting for you");
    expect(dotTitle("done")).toBe("Finished");
  });
});

describe("lookingAt", () => {
  const here = { windowFocused: true, page: "agents", workspace: true, shown: ["a", null] as (string | null)[] };
  it("is true only for a tab shown in the terminal workspace of a focused Agent Workspace", () => {
    expect(lookingAt("a", here)).toBe(true);
    expect(lookingAt("b", here)).toBe(false);
    expect(lookingAt("b", { ...here, shown: ["a", "b"] })).toBe(true);
    expect(lookingAt("a", { ...here, windowFocused: false })).toBe(false);
    expect(lookingAt("a", { ...here, page: "memory" })).toBe(false);
    expect(lookingAt("a", { ...here, shown: [null] })).toBe(false);
  });
  it("is false while the Start screen or a chat session replaces the terminal workspace", () => {
    expect(lookingAt("a", { ...here, workspace: false })).toBe(false);
  });
});

describe("the attention store", () => {
  const term = (id: string, attention: TermInfo["attention"]): TermInfo => ({ id, sessionId: id, engine: "claude", running: true, exitCode: null, windowsBuild: null, label: null, cwd: null, attention });
  it("loads from the terminal list and changes one terminal at a time", () => {
    const { load, set } = useAttention.getState();
    load([term("a", "waiting"), term("b", null), term("c", "done")]);
    expect(useAttention.getState().byId).toEqual({ a: "waiting", c: "done" });
    set("b", "done");
    set("a", null);
    expect(useAttention.getState().byId).toEqual({ b: "done", c: "done" });
    const same = useAttention.getState().byId;
    set("b", "done");
    expect(useAttention.getState().byId).toBe(same);
  });
});
