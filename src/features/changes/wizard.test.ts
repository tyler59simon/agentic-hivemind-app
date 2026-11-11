import { describe, expect, it } from "vitest";
import type { Change } from "../../lib/lm";
import { changedChange, createPayload, EMPTY, validateChange, type ChangeFields } from "./wizard";

const form = (o: Partial<ChangeFields> = {}): ChangeFields => ({ ...EMPTY, project: "paystream", title: "Prevent duplicates", outcome: "No duplicates.", ...o });
const change: Change = {
  id: 14, display: "CHG-014", title: "Prevent duplicates", project: "paystream", brief: "demo:abc", stage: "explore", status: "active",
  repo: null, branch: null, system: "paystream", element: "Ingestion", created: "", updated: "", brief_status: "active", actions: { open: 0, done: 0 },
};

describe("change wizard", () => {
  it("validates a new change", () => {
    expect(validateChange(EMPTY, "create")).toEqual([
      "Pick a project.", "Give the change a title.", "Describe the outcome: it becomes the brief's Executive Summary.",
    ]);
    expect(validateChange(form({ title: "A #1" }), "create")).toEqual(["The title cannot contain [ ] | or #: other notes link to the brief by its title."]);
    expect(validateChange(form({ title: "x".repeat(121) }), "create")).toEqual(["The title is limited to 120 characters."]);
    expect(validateChange(form({ outcome: "" }), "adopt")).toEqual([]);
    expect(validateChange(form({ element: "Ingestion" }), "create")).toEqual(["Pick a system before an element."]);
    expect(validateChange(form(), "create")).toEqual([]);
  });

  it("builds the create payload", () => {
    const p = createPayload(form());
    expect(p).toEqual({ project: "paystream", title: "Prevent duplicates", brief: { body: "## 📌 Executive Summary\nNo duplicates." } });
    expect(Object.keys(p)).not.toContain("stage");
    expect(createPayload(form({ stage: "design", branch: " b ", repo: "C:/r", system: "s", element: "e" }))).toMatchObject({ stage: "design", branch: "b", repo: "C:/r", system: "s", element: "e" });
    expect(createPayload(form(), "demo:plan").brief).toBe("demo:plan");
  });

  it("sends only what changed", () => {
    const same = form({ system: "paystream", element: "Ingestion" });
    expect(changedChange(change, same)).toBeNull();
    expect(changedChange(change, { ...same, branch: "feature/x" })).toEqual({ id: 14, branch: "feature/x" });
    expect(changedChange(change, { ...same, system: "", element: "" })).toEqual({ id: 14, system: null, element: null });
  });
});
