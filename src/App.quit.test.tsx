// @vitest-environment jsdom
// Tray Quit with a never-saved text file open (Codex review of 52051c8, D1).
import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const handlers = new Map<string, () => unknown>();
const invoked: string[] = [];
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: () => unknown) => { handlers.set(name, handler); return () => {}; }),
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ onCloseRequested: async () => () => {}, destroy: async () => {} }) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
// The graph view draws with WebGL, which jsdom lacks; quitting never shows it.
vi.mock("./features/graph/GraphCanvas", () => ({ GraphCanvas: () => null }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
    invoked.push(cmd);
    return cmd === "term_list" || cmd === "agent_sessions" ? [] : null;
  }),
}));

const { useQuitRequest } = await import("./App");
const { useWorkspace } = await import("./workspace/store");

function Host() {
  return <>{useQuitRequest()}</>;
}

describe("tray Quit", () => {
  it("asks before quitting when a new text file holds text that was never saved", async () => {
    useWorkspace.setState({ panes: [{ id: "p0", tabs: [], active: null }], focused: "p0", dirty: {}, reveal: null });
    useWorkspace.getState().openTab({ kind: "new-file" });
    const tab = useWorkspace.getState().panes[0].tabs[0];
    useWorkspace.getState().setDirty(tab.id, true);
    const el = document.createElement("div");
    document.body.append(el);
    const root = createRoot(el);
    await act(async () => { root.render(<Host />); });
    await act(async () => { await handlers.get("quit-requested")!(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(invoked).not.toContain("app_quit");
    expect(document.body.textContent).toContain("Quit with an unsaved new text file?");
    const quit = [...document.querySelectorAll("button")].find((b) => b.textContent === "Quit")!;
    await act(async () => { quit.click(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(invoked).toContain("app_quit");
    await act(async () => root.unmount());
    el.remove();
  });

  it("asks before quitting when a Word (.docx) or PDF file has unsaved edits", async () => {
    invoked.length = 0;
    useWorkspace.setState({ panes: [{ id: "p0", tabs: [], active: null }], focused: "p0", dirty: {}, reveal: null });
    useWorkspace.getState().openTab({ kind: "file", file: { notebook: "nb-1", path: "Contract.pdf" } });
    const tab = useWorkspace.getState().panes[0].tabs[0];
    useWorkspace.getState().setDirty(tab.id, true);
    const el = document.createElement("div");
    document.body.append(el);
    const root = createRoot(el);
    await act(async () => { root.render(<Host />); });
    await act(async () => { await handlers.get("quit-requested")!(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(invoked).not.toContain("app_quit");
    expect(document.body.textContent).toContain("Unsaved Word (.docx) or PDF edits");
    const quit = [...document.querySelectorAll("button")].find((b) => b.textContent === "Quit")!;
    await act(async () => { quit.click(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(invoked).toContain("app_quit");
    await act(async () => root.unmount());
    el.remove();
  });
});
