import { afterEach, describe, expect, it } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { setTransport, type Invoke } from "../../lib/lm";
import { useSessionDraft } from "../agents/draft";
import type { ChangeView } from "./changes";
import { moveStage, startSessionFor } from "./useChanges";

afterEach(() => setTransport(invoke as Invoke));

const ok = (result: unknown) => ({ exit_code: 0, result, error: null });
const registry = (stage: string) => ok({ ok: true, warnings: [], changes: [{ id: 14, stage, status: "active" }] });
const stagePlan = ok({ ok: true, plan_id: "p", digest: "d", kind: "change_update", summary: { id: 14, display: "CHG-014", title: "T", fields: ["stage"], files: 1 } });

/** Answers each Living Memory command from its own queue and records the commands sent. */
function script(replies: Record<string, unknown[]>) {
  const sent: string[] = [];
  setTransport(async (_cmd, args) => {
    const name = (args as { argv: string[] }).argv[0];
    sent.push(name);
    return replies[name].shift();
  });
  return sent;
}

describe("moveStage", () => {
  it("applies nothing when the change has moved since it was shown", async () => {
    const sent = script({ changes: [registry("implement")] });
    await expect(moveStage(14, "design", "explore")).rejects.toThrow("CHG-014 is now at Implement; nothing was applied.");
    expect(sent).toEqual(["changes"]);
  });

  it("does not retry over a move made while the first plan was open", async () => {
    const sent = script({
      changes: [registry("explore"), registry("implement")],
      "change-plan": [stagePlan],
      apply: [{ exit_code: 6, result: null, error: { code: "stale", message: "Stale revision: changes.json" } }],
    });
    await expect(moveStage(14, "design", "explore")).rejects.toThrow("now at Implement");
    expect(sent).toEqual(["changes", "change-plan", "apply", "changes"]);
  });
});

describe("startSessionFor", () => {
  it("reads the brief's decisions and questions itself when the screen's link graph had not loaded", async () => {
    const node = (ref: string, type: string) => ({ ref, id: ref, domain: "demo", title: ref, type, status: "active", tags: [] });
    script({ links: [ok({ domains: ["demo"], unresolved: [],
      nodes: [node("demo:brief", "plan"), node("demo:d1", "decision"), node("demo:q1", "risk")],
      edges: [{ from: "demo:brief", to: "demo:d1", kind: "link" }, { from: "demo:q1", to: "demo:brief", kind: "link" }] })] });
    useSessionDraft.getState().reset();
    const view = { change: { id: 14, display: "CHG-014", brief: "demo:brief", brief_status: "active", project: "paystream", system: null, element: null },
      decisions: [], questions: [], checkpoints: [] } as unknown as ChangeView;
    await startSessionFor(view);
    expect(useSessionDraft.getState().context).toEqual(["demo:brief", "demo:d1", "demo:q1"]);
    expect(useSessionDraft.getState().change).toBe(14);
  });
});
