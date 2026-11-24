import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

const handlers = new Map<string, (e: { payload: unknown }) => void>();
const listen = vi.fn((name: string, handler: (e: { payload: unknown }) => void) => { handlers.set(name, handler); return Promise.resolve(() => undefined); });
vi.mock("@tauri-apps/api/event", () => ({ listen }));
const wikiAgentBuild = vi.fn();
const wikiAgentCancel = vi.fn(() => Promise.resolve());
vi.mock("../../lib/wiki", () => ({ wikiAgentBuild, wikiAgentCancel }));
const automationList = vi.fn();
const automationAct = vi.fn(() => Promise.resolve(null));
vi.mock("../../lib/automations", () => ({ automationList, automationAct }));
const { cancelWikiBuild, listenOnce, startWikiBuild, useWikiBuild } = await import("./build");
const { useToasts } = await import("../../ui/toast");

// The listeners are set up once, with the first client, so every test uses this one.
const client = new QueryClient();

describe("cancelling a wiki build", () => {
  beforeEach(() => {
    useWikiBuild.setState({ running: null, progress: null, cancelling: false });
    useToasts.setState({ items: [] });
    wikiAgentBuild.mockReset();
    wikiAgentCancel.mockClear();
  });

  it("a Cancel before the build reaches Rust ends it without ever starting it", async () => {
    const started = startWikiBuild(client, "demo", "", false); // running is set at once; the listeners are still being set up
    expect(useWikiBuild.getState().running).toEqual({ domain: "demo", project: "" });
    cancelWikiBuild();
    await started;
    expect(wikiAgentBuild).not.toHaveBeenCalled();
    expect(useWikiBuild.getState()).toMatchObject({ running: null, cancelling: false });
    expect(useToasts.getState().items.map((t) => t.text)).toEqual(["Wiki build cancelled. The pages already written are kept."]);
  });

  it("a build nobody cancelled is handed to Rust", async () => {
    wikiAgentBuild.mockResolvedValue({ ok: true, written: ["pg000001"], failed: [], pending: [], stopped: null, cost_usd: 0.5 });
    await startWikiBuild(client, "demo", "core", true);
    expect(wikiAgentBuild).toHaveBeenCalledWith("demo", "core", true, false);
    expect(useWikiBuild.getState().running).toBeNull();
    expect(useToasts.getState().items[0].text).toBe("Wiki build finished: 1 page written for $0.50.");
  });

  // CON-14: a scheduled rebuild ends while the wiki is open; the view did not start it and still shows its pages.
  it("a done event from a build this view did not start refetches the agent edition, with no toast", async () => {
    const invalidate = vi.spyOn(client, "invalidateQueries");
    await listenOnce(client);
    handlers.get("wiki-build-done")!({ payload: { domain: "demo", scope: "core", ok: true, result: { ok: true, written: ["pg000001"], failed: [], pending: [], stopped: null, cost_usd: 0.4 } } });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["wiki", "agent"] });
    expect(useToasts.getState().items).toEqual([]);
    expect(useWikiBuild.getState().running).toBeNull();
  });

  it("the end of a build the view started still toasts once, and refetches once", async () => {
    const invalidate = vi.spyOn(client, "invalidateQueries");
    useWikiBuild.setState({ running: { domain: "demo", project: "core" }, progress: null, cancelling: false });
    await listenOnce(client);
    handlers.get("wiki-build-done")!({ payload: { domain: "demo", scope: "core", ok: true, result: { ok: true, written: [], failed: [], pending: [], stopped: null, cost_usd: 0 } } });
    expect(useToasts.getState().items.map((t) => t.text)).toEqual(["Wiki build finished: 0 pages written for $0.00."]);
    expect(invalidate).toHaveBeenCalledTimes(1);
  });
});

// WIKI-R1: a scheduled rebuild shows in the view that did not start it, and its Cancel cancels the automation run.
describe("a scheduled rebuild", () => {
  const progress = (event: Record<string, unknown>) => handlers.get("wiki-build-progress")!({ payload: { domain: "demo", scope: "core", ...event } });
  beforeEach(async () => {
    useWikiBuild.setState({ running: null, progress: null, cancelling: false });
    useToasts.setState({ items: [] });
    automationAct.mockClear();
    wikiAgentCancel.mockClear();
    await listenOnce(client);
  });

  it("is taken up from its progress events and ends with no toast", () => {
    progress({ event: "start", calls: 4 });
    expect(useWikiBuild.getState().running).toEqual({ domain: "demo", project: "core", scheduled: true });
    progress({ event: "call", kind: "page", page: "pg000001", title: "A", ok: true, done: 1, total: 4, cost_usd: 0.1 });
    expect(useWikiBuild.getState().progress).toMatchObject({ done: 1, total: 4 });
    handlers.get("wiki-build-done")!({ payload: { domain: "demo", scope: "core", ok: true, result: { ok: true, written: ["pg000001"], failed: [], pending: [], stopped: null, cost_usd: 0.1 } } });
    expect(useWikiBuild.getState().running).toBeNull();
    expect(useToasts.getState().items).toEqual([]);
  });

  it("is not taken up from its last line alone, and a whole-domain build has no project", () => {
    progress({ event: "end", ok: true, stopped: null, cost_usd: 0 });
    expect(useWikiBuild.getState().running).toBeNull();
    handlers.get("wiki-build-progress")!({ payload: { domain: "demo", scope: "domain", event: "start", calls: null } });
    expect(useWikiBuild.getState().running).toEqual({ domain: "demo", project: "", scheduled: true });
  });

  it("Cancel cancels the running rebuild's automation run, and its end toasts as cancelled", async () => {
    automationList.mockResolvedValue({
      automations: [{ id: "a1", action: { kind: "wiki_rebuild", domain: "demo" } }, { id: "a2", action: { kind: "skill_upkeep" } }],
      runs: [{ id: "r2", automation: "a2", state: "running" }, { id: "r1", automation: "a1", state: "running" }], templates: [],
    });
    progress({ event: "start", calls: 2 });
    cancelWikiBuild();
    await vi.waitFor(() => expect(automationAct).toHaveBeenCalledWith("cancel", "r1"));
    expect(wikiAgentCancel).not.toHaveBeenCalled();
    handlers.get("wiki-build-done")!({ payload: { domain: "demo", scope: "core", ok: false, error: "Build cancelled." } });
    expect(useToasts.getState().items.map((t) => t.text)).toEqual(["Wiki build cancelled. The pages already written are kept."]);
  });

  it("Cancel stops the build directly when no rebuild run is running any more", async () => {
    automationList.mockResolvedValue({ automations: [], runs: [], templates: [] });
    progress({ event: "start", calls: 2 });
    cancelWikiBuild();
    await vi.waitFor(() => expect(wikiAgentCancel).toHaveBeenCalled());
    expect(automationAct).not.toHaveBeenCalled();
  });
});
