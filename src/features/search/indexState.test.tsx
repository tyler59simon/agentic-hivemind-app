// @vitest-environment jsdom
// NS-4A: the indexing status line, the settling of the queries that read the index, and Rebuild index in notebook settings.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sent: { cmd: string; args: Record<string, unknown> }[] = [];
let status = { state: "idle", done: 0, total: 0, error: null as string | null, pages: 1234, notebooks: [{ id: "nb-1", pages: 1234 }, { id: "nb-2", pages: 5 }], version: 1 };
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: Record<string, unknown>) => {
    sent.push({ cmd, args });
    switch (cmd) {
      case "index_status": return status;
      case "notebook_meta_get": return {};
      case "lm": return { exit_code: 0, error: null, result: {} };
    }
    return null;
  }),
}));

const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { onIndexProgress, progressLine, useIndexState } = await import("./indexState");
const { NotebookSettings } = await import("../notes/NotebookSettings");

describe("progressLine", () => {
  it("says how far a scan is, and nothing while the index is idle", () => {
    expect(progressLine(null)).toBeNull();
    expect(progressLine({ state: "idle", done: 5, total: 5, error: null })).toBeNull();
    expect(progressLine({ state: "scanning", done: 1200, total: 3400, error: null })).toBe("Indexing pages: 1,200 of 3,400");
    expect(progressLine({ state: "scanning", done: 0, total: 0, error: null })).toBe("Indexing pages…");
  });
});

describe("onIndexProgress", () => {
  beforeEach(() => { vi.useFakeTimers(); useIndexState.setState({ progress: null }); });
  afterEach(() => { vi.useRealTimers(); });

  it("keeps the last event, and asks the index queries again once it settles, a burst of events refreshing them once", () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    onIndexProgress(client, { state: "scanning", done: 1, total: 10, error: null });
    expect(useIndexState.getState().progress?.done).toBe(1);
    vi.advanceTimersByTime(1000);
    expect(invalidate).not.toHaveBeenCalled();
    onIndexProgress(client, { state: "idle", done: 0, total: 0, error: null });
    onIndexProgress(client, { state: "idle", done: 0, total: 0, error: null });
    onIndexProgress(client, { state: "idle", done: 0, total: 0, error: null });
    vi.advanceTimersByTime(1000);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["index"] });
  });
});

describe("Rebuild index in notebook settings", () => {
  let root: Root | null = null;
  afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.innerHTML = ""; });
  const settle = async () => { for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 20)); }); };
  async function open() {
    sent.length = 0;
    useIndexState.setState({ progress: null });
    const el = document.createElement("div");
    document.body.append(el);
    root = createRoot(el);
    const notebook = { id: "nb-1", path: "C:\\one", title: "Main", added: "" };
    await act(async () => root!.render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><NotebookSettings notebook={notebook} onClose={() => {}} /></QueryClientProvider>));
    await settle();
  }
  const rebuild = () => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Rebuild index")!;

  it("shows how many pages the notebook has in the index, and rebuilds only this notebook", async () => {
    status = { ...status, state: "idle", error: null };
    await open();
    expect(document.body.textContent).toContain("1,234 pages are searchable.");
    await act(async () => { rebuild().click(); });
    expect(sent.find((c) => c.cmd === "index_rebuild")?.args).toEqual({ notebook: "nb-1" });
  });

  it("shows the progress of a running scan, disables the button meanwhile, and says why the index could not be kept current", async () => {
    status = { ...status, state: "scanning", done: 40, total: 120, error: null };
    await open();
    expect(document.body.textContent).toContain("Indexing pages: 40 of 120");
    expect(rebuild().disabled).toBe(true);
    await act(async () => { await Promise.resolve(); useIndexState.setState({ progress: { state: "idle", done: 0, total: 0, error: "The notebook folder D:\\Notes is missing" } }); });
    expect(document.body.textContent).toContain("D:\\Notes is missing");
    expect(rebuild().disabled).toBe(false);
  });
});
