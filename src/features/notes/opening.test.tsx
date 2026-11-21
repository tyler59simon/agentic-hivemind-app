// @vitest-environment jsdom
// Files that Explorer asks Hivemind to open while the app starts (Codex review of 52051c8, I1).
import { describe, expect, it, vi } from "vitest";
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Rust hands the queued files over once; later drains find the queue empty. Listeners are in place a little later.
let queued = [{ notebook: "@0123456789abcdef", path: "From Explorer.md" }];
let drains = 0;
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => new Promise((resolve) => setTimeout(() => resolve(() => {}), 5))),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
    if (cmd === "open_pending") { drains++; const refs = queued; queued = []; return refs; }
    return null;
  }),
}));

const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { useOpenRequests } = await import("./opening");
const { useWorkspace } = await import("../../workspace/store");

function Host() {
  return <>{useOpenRequests()}</>;
}

describe("open requests", () => {
  it("a file queued before the app was ready opens once, even though Strict Mode starts the listener twice", async () => {
    useWorkspace.setState({ panes: [{ id: "p0", tabs: [], active: null }], focused: "p0", dirty: {}, reveal: null });
    const el = document.createElement("div");
    document.body.append(el);
    const root = createRoot(el);
    await act(async () => { root.render(<StrictMode><QueryClientProvider client={new QueryClient()}><Host /></QueryClientProvider></StrictMode>); });
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    const tabs = useWorkspace.getState().panes.flatMap((p) => p.tabs);
    expect(tabs.map((t) => t.file?.path)).toEqual(["From Explorer.md"]);
    // Only the effect that is still running drains the queue (Codex re-review of fa08348, I1).
    expect(drains).toBe(1);
    await act(async () => root.unmount());
  });
});
