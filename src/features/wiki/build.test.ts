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

  // W3: a cancel that did not reach Rust leaves Cancel usable.
  it("a cancel request that fails can be made again", async () => {
    let finishBuild: (v: unknown) => void = () => undefined;
    wikiAgentBuild.mockImplementation(() => new Promise((r) => { finishBuild = r; }));
    const started = startWikiBuild(client, "demo", "", false);
    await vi.waitFor(() => expect(wikiAgentBuild).toHaveBeenCalled());
    wikiAgentCancel.mockImplementationOnce(() => Promise.reject(new Error("no build")));
    cancelWikiBuild();
    await vi.waitFor(() => expect(useWikiBuild.getState().cancelling).toBe(false));
    finishBuild({ ok: true, written: [], failed: [], pending: [], stopped: null, cost_usd: 0 });
    await started;
    expect(useToasts.getState().items.map((t) => t.text)).toEqual(["no build", "Wiki build finished: 0 pages written for $0.00."]);
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

  it("Cancel cancels the rebuild run of the shown domain and project, and its end toasts as cancelled", async () => {
    // W1: another project's rebuild run is never the one cancelled.
    automationList.mockResolvedValue({
      automations: [{ id: "a0", project: "other", action: { kind: "wiki_rebuild", domain: "demo" } }, { id: "a1", project: "core", action: { kind: "wiki_rebuild", domain: "demo" } },
        { id: "a2", project: "core", action: { kind: "skill_upkeep" } }],
      runs: [{ id: "r0", automation: "a0", state: "running" }, { id: "r2", automation: "a2", state: "running" }, { id: "r1", automation: "a1", state: "running" }], templates: [],
    });
    progress({ event: "start", calls: 2 });
    cancelWikiBuild();
    await vi.waitFor(() => expect(automationAct).toHaveBeenCalledWith("cancel", "r1"));
    expect(wikiAgentCancel).not.toHaveBeenCalled();
    handlers.get("wiki-build-done")!({ payload: { domain: "demo", scope: "core", ok: false, error: "Build cancelled." } });
    expect(useToasts.getState().items.map((t) => t.text)).toEqual(["Wiki build cancelled. The pages already written are kept."]);
  });

  // W1, W3: with no rebuild run left nothing is stopped (a build started since is not this one), and Cancel works again.
  it("Cancel stops nothing when the rebuild run has ended, and can be pressed again", async () => {
    automationList.mockResolvedValue({ automations: [], runs: [], templates: [] });
    progress({ event: "start", calls: 2 });
    cancelWikiBuild();
    await vi.waitFor(() => expect(useToasts.getState().items.map((t) => t.text)).toEqual(["The scheduled rebuild has already ended."]));
    expect(wikiAgentCancel).not.toHaveBeenCalled();
    expect(automationAct).not.toHaveBeenCalled();
    expect(useWikiBuild.getState().cancelling).toBe(false);
  });

  // W2: a lost done event does not leave the strip up once the rebuild's automation run is over.
  it("ends when its automation run is no longer running, and not while it is", async () => {
    automationList.mockResolvedValue({ automations: [{ id: "a1", project: "core", action: { kind: "wiki_rebuild", domain: "demo" } }],
      runs: [{ id: "r1", automation: "a1", state: "running" }], templates: [] });
    progress({ event: "start", calls: 2 });
    handlers.get("automations-changed")!({ payload: null });
    await new Promise((r) => setTimeout(r, 10));
    expect(useWikiBuild.getState().running).not.toBeNull();
    automationList.mockResolvedValue({ automations: [{ id: "a1", project: "core", action: { kind: "wiki_rebuild", domain: "demo" } }],
      runs: [{ id: "r1", automation: "a1", state: "succeeded" }], templates: [] });
    handlers.get("automations-changed")!({ payload: null });
    await vi.waitFor(() => expect(useWikiBuild.getState().running).toBeNull());
    expect(useToasts.getState().items).toEqual([]);
  });
});
