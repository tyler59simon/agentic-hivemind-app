import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

const listen = vi.fn(() => Promise.resolve(() => undefined));
vi.mock("@tauri-apps/api/event", () => ({ listen }));
const wikiAgentBuild = vi.fn();
const wikiAgentCancel = vi.fn(() => Promise.resolve());
vi.mock("../../lib/wiki", () => ({ wikiAgentBuild, wikiAgentCancel }));
const { cancelWikiBuild, startWikiBuild, useWikiBuild } = await import("./build");
const { useToasts } = await import("../../ui/toast");

describe("cancelling a wiki build", () => {
  beforeEach(() => {
    useWikiBuild.setState({ running: null, progress: null, cancelling: false });
    useToasts.setState({ items: [] });
    wikiAgentBuild.mockReset();
    wikiAgentCancel.mockClear();
  });

  it("a Cancel before the build reaches Rust ends it without ever starting it", async () => {
    const started = startWikiBuild(new QueryClient(), "demo", "", false); // running is set at once; the listeners are still being set up
    expect(useWikiBuild.getState().running).toEqual({ domain: "demo", project: "" });
    cancelWikiBuild();
    await started;
    expect(wikiAgentBuild).not.toHaveBeenCalled();
    expect(useWikiBuild.getState()).toMatchObject({ running: null, cancelling: false });
    expect(useToasts.getState().items.map((t) => t.text)).toEqual(["Wiki build cancelled. The pages already written are kept."]);
  });

  it("a build nobody cancelled is handed to Rust", async () => {
    wikiAgentBuild.mockResolvedValue({ ok: true, written: ["pg000001"], failed: [], pending: [], stopped: null, cost_usd: 0.5 });
    await startWikiBuild(new QueryClient(), "demo", "core", true);
    expect(wikiAgentBuild).toHaveBeenCalledWith("demo", "core", true, false);
    expect(useWikiBuild.getState().running).toBeNull();
    expect(useToasts.getState().items[0].text).toBe("Wiki build finished: 1 page written for $0.50.");
  });
});
