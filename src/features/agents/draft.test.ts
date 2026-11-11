import { beforeEach, describe, expect, it } from "vitest";
import { useSessionDraft } from "./draft";

const draft = () => useSessionDraft.getState();

describe("session draft", () => {
  beforeEach(() => draft().reset());

  it("adds each note once and removes it", () => {
    draft().addContext("a");
    draft().addContext("a");
    expect(draft().context).toEqual(["a"]);
    draft().removeContext("a");
    expect(draft().context).toEqual([]);
  });

  it("reset clears everything", () => {
    draft().setTask("Fix it");
    draft().addContext("a");
    draft().setSystem("pay", "Ingestion");
    expect([draft().task, draft().context, draft().system, draft().element]).toEqual(["Fix it", ["a"], "pay", "Ingestion"]);
    draft().reset();
    expect(draft()).toMatchObject({ task: "", context: [], change: null, system: null, element: null });
  });
});
