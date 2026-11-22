// @vitest-environment jsdom
// NS-4A: renaming a page offers to update the links to it. The plan is made before the move, shown after it, and written
// page by page; a page that changed meanwhile is skipped and listed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const disk = new Map<string, { text: string; sha: string }>();
const sent: { cmd: string; args: Record<string, unknown> }[] = [];
let indexDown = false;
const link = (path: string, raw: string, sha: string) => ({ notebook: "nb-1", path, sha256: sha, raw, kind: "wiki", embed: false, line: 1, context: raw });
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, a: Record<string, unknown>) => {
    sent.push({ cmd, args: a });
    switch (cmd) {
      case "notebooks_list": return [{ id: "nb-1", path: "C:\\one", title: "Main", added: "" }];
      case "index_pages": return ["Plan.md", "Inbox.md", "Daily.md", "Busy.md"].map((path) => ({ notebook: "nb-1", path, kind: "md", title: path, mtimeMs: 1 }));
      case "index_incoming":
        if (indexDown) throw new Error("The search index is not available");
        return [link("Inbox.md", "Plan", "sha-inbox"), link("Daily.md", "Plan#Part", "sha-daily-old"), link("Busy.md", "Plan", "sha-busy")];
      case "file_rename": { const from = disk.get(a.from as string); if (from) { disk.set(a.to as string, from); disk.delete(a.from as string); } return null; }
      case "file_read": {
        const f = disk.get(a.path as string);
        if (!f) throw new Error(`${a.path} does not exist`);
        return { text: f.text, sha256: f.sha, size: 1, mtimeMs: 1, format: { encoding: "UTF-8", bom: false, eol: "lf" }, readOnly: null, binary: false };
      }
      case "file_save": {
        const f = disk.get(a.path as string);
        if (f?.sha !== (a.pre as { sha256: string }).sha256) return { status: "stale", sha256: f?.sha };
        disk.set(a.path as string, { text: a.text as string, sha: `${f.sha}+` });
        return { status: "saved", sha256: `${f.sha}+`, size: 1, mtimeMs: 2 };
      }
      case "lm": return { exit_code: 0, error: null, result: { notes: [] } };
    }
    return null;
  }),
}));

const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { movePath } = await import("../notes/actions");
const { RewriteDialog } = await import("./RewriteDialog");
const { useRewritePlan } = await import("./plan");
const docs = await import("../../documents/store");
const { useWorkspace } = await import("../../workspace/store");

let root: Root | null = null;
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const settle = async () => { for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 20)); }); };
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("[role=dialog] button")].find((b) => b.textContent === label);
const saves = () => sent.filter((c) => c.cmd === "file_save").map((c) => c.args.path);

beforeEach(async () => {
  sent.length = 0; disk.clear(); indexDown = false;
  disk.set("Plan.md", { text: "# Plan\n", sha: "sha-plan" });
  disk.set("Inbox.md", { text: "Start with [[Plan]] and `[[Plan]]`.\n", sha: "sha-inbox" });
  disk.set("Daily.md", { text: "[[Plan#Part|today]] changed since the index read it\n", sha: "sha-daily-new" });
  disk.set("Busy.md", { text: "[[Plan]]\n", sha: "sha-busy" });
  useRewritePlan.setState({ plan: null });
  docs.useDocuments.setState({ docs: {}, refs: {}, held: [] });
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<QueryClientProvider client={client}><RewriteDialog /></QueryClientProvider>));
});
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.innerHTML = ""; client.clear(); });

describe("renaming a page", () => {
  it("lists the pages whose links reach it, then rewrites them, skipping a page that changed meanwhile", async () => {
    await act(async () => { await movePath(client, "nb-1", "Plan.md", "Strategy.md"); });
    await settle();
    // The move happened first, and nothing was written yet.
    expect(sent.filter((c) => c.cmd === "file_rename")).toHaveLength(1);
    expect(saves()).toEqual([]);
    const dialog = document.querySelector("[role=dialog]")!;
    expect(dialog.textContent).toContain("3 links in 3 pages");
    expect(dialog.textContent).toMatch(/Inbox[\s\S]*Daily[\s\S]*Busy/);
    await act(async () => { button("Update links")!.click(); });
    await settle();
    expect(disk.get("Inbox.md")!.text).toBe("Start with [[Strategy]] and `[[Plan]]`.\n");
    expect(disk.get("Daily.md")!.text).toBe("[[Plan#Part|today]] changed since the index read it\n");
    expect(saves()).toContain("Inbox.md");
    expect(saves()).not.toContain("Daily.md");
    const done = document.querySelector("[role=dialog]")!.textContent!;
    expect(done).toContain("2 pages were updated.");
    expect(done).toContain("1 page was left as it was");
    expect(done).toContain("it changed after Hivemind read it");
    await act(async () => { button("Done")!.click(); });
    expect(document.querySelector("[role=dialog]")).toBeNull();
    expect(useRewritePlan.getState().plan).toBeNull();
  });

  it("saves each page as a link update, so its history keeps the page as it was before (NS-5)", async () => {
    await act(async () => { await movePath(client, "nb-1", "Plan.md", "Strategy.md"); });
    await settle();
    await act(async () => { button("Update links")!.click(); });
    await settle();
    const writes = sent.filter((c) => c.cmd === "file_save");
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.every((c) => c.args.source === "links")).toBe(true);
  });

  it("a page with unsaved edits in a tab is left alone", async () => {
    // Busy.md is open in a tab with edits that are not saved.
    const busy = { notebook: "nb-1", path: "Busy.md" };
    useWorkspace.setState({ panes: [{ id: "p0", tabs: [], active: null }], focused: "p0", dirty: {} });
    useWorkspace.getState().openTab({ kind: "file", file: busy, mode: "source" });
    await act(async () => { await docs.open(busy); });
    await act(async () => { docs.edit(docs.keyOf(busy), "[[Plan]] plus"); });
    expect(docs.unsavedUnder("nb-1", "Busy.md")).toEqual(["Busy.md"]);
    await act(async () => { await movePath(client, "nb-1", "Plan.md", "Strategy.md"); });
    await settle();
    await act(async () => { button("Update links")!.click(); });
    await settle();
    expect(saves()).not.toContain("Busy.md");
    expect(document.querySelector("[role=dialog]")!.textContent).toContain("it has unsaved edits in a tab");
  });

  it("Not now leaves every page as it is, and a move never waits for an index that cannot answer", async () => {
    await act(async () => { await movePath(client, "nb-1", "Plan.md", "Strategy.md"); });
    await settle();
    await act(async () => { button("Not now")!.click(); });
    expect(saves()).toEqual([]);
    expect(document.querySelector("[role=dialog]")).toBeNull();
    sent.length = 0;
    indexDown = true;
    disk.set("Strategy.md", { text: "x", sha: "s" });
    await act(async () => { await movePath(client, "nb-1", "Strategy.md", "Plan.md"); });
    await settle();
    expect(sent.filter((c) => c.cmd === "file_rename")).toHaveLength(1);
    expect(document.querySelector("[role=dialog]")).toBeNull();
  });
});
