// @vitest-environment jsdom
// Codex re-review, N09: saving Settings reads everything again without restarting Living Memory (save_settings starts a new
// process itself when the launch changed), so a write another window has running is not cut off. Only Reconnect restarts it.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const invoked = vi.hoisted(() => [] as string[]);
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ onCloseRequested: async () => () => {}, destroy: async () => {} }) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("./features/graph/GraphCanvas", () => ({ GraphCanvas: () => null }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async (cmd: string) => { invoked.push(cmd); return null; }) }));

const { useReconnect } = await import("./App");

let root: Root | null = null;
let handlers: ReturnType<typeof useReconnect> | null = null;
function Host() {
  handlers = useReconnect();
  return null;
}
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.innerHTML = ""; });

describe("Settings Save and Reconnect", () => {
  it("restart Living Memory only on Reconnect", async () => {
    const el = document.createElement("div");
    document.body.append(el);
    root = createRoot(el);
    await act(async () => root!.render(<QueryClientProvider client={new QueryClient()}><Host /></QueryClientProvider>));
    invoked.length = 0;
    await act(async () => { handlers!.settingsSaved(); });
    expect(invoked).not.toContain("bridge_restart");
    await act(async () => { handlers!.reconnect(); await new Promise((r) => setTimeout(r, 0)); });
    expect(invoked).toContain("bridge_restart");
  });
});
