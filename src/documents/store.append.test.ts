// NS-7A: the Quick capture window adds a line to a page through Rust, which the watcher does not report, and tells the main
// window (`page-appended`). A page the main window has open follows when it is clean; one with unsaved edits keeps them, and
// its merge keeps the new line too.
import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { insertUnder } from "../features/notes/append";
import { mergeBody } from "../features/editor/merge";

const files = new Map<string, string>();
const drafts = new Map<string, unknown>();
const sha = (text: string) => `sha-${text}`;
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, a: Record<string, unknown>) => {
    const path = a.path as string;
    switch (cmd) {
      case "file_read":
        if (!files.has(path)) throw new Error(`${path} not found`);
        return { text: files.get(path)!, sha256: sha(files.get(path)!), size: 1, mtimeMs: 1, format: { encoding: "UTF-8", bom: false, eol: "lf" }, readOnly: null, binary: false };
      case "file_save": {
        const pre = a.pre as { sha256: string };
        if (sha(files.get(path)!) !== pre.sha256) return { status: "stale", sha256: sha(files.get(path)!) };
        files.set(path, a.text as string);
        return { status: "saved", sha256: sha(a.text as string), size: 1, mtimeMs: 2 };
      }
      case "draft_put": drafts.set(a.key as string, a.value); return null;
      case "draft_get": return drafts.get(a.key as string) ?? null;
      case "draft_delete": drafts.delete(a.key as string); return null;
    }
    throw new Error(`unexpected ${cmd}`);
  }),
}));

const { useWorkspace } = await import("../workspace/store");
const { useApp } = await import("../store");
const docs = await import("./store");
const { onPageAppended, startDocumentSync } = await import("./sync");

const ref = (path: string) => ({ notebook: "nb-1", path });
const key = (path: string) => docs.keyOf(ref(path));
const state = (path: string) => docs.useDocuments.getState().docs[key(path)];
let stop = () => {};
async function until(ok: () => boolean) {
  for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 0));
  expect(ok()).toBe(true);
}

const PAGE = "# Day\n\n## Captured\n\n- a\n";
const appended = (text: string) => insertUnder(text, "## Captured", "- 14:05 from capture");

describe("a line the capture window added to an open page", () => {
  beforeEach(() => {
    files.clear(); drafts.clear();
    files.set("Day.md", PAGE);
    useWorkspace.setState({ panes: [{ id: "p0", tabs: [], active: null }], focused: "p0", dirty: {}, reveal: null });
    useApp.setState({ route: { page: "notes" }, back: [] });
    docs.useDocuments.setState({ docs: {}, refs: {} });
    stop = startDocumentSync();
  });
  afterEach(() => stop());

  it("shows up in a page with no unsaved edits", async () => {
    useWorkspace.getState().openTab({ kind: "file", file: ref("Day.md") });
    await docs.open(ref("Day.md"));
    files.set("Day.md", appended(PAGE));
    onPageAppended(new QueryClient(), { notebook: "nb-1", path: "Day.md" });
    await until(() => state("Day.md").text.includes("from capture"));
    expect(state("Day.md")).toMatchObject({ status: "clean", text: appended(PAGE) });
  });

  it("leaves a page with unsaved edits as it is, says the file changed, and keeps the line through the merge", async () => {
    useWorkspace.getState().openTab({ kind: "file", file: ref("Day.md") });
    await docs.open(ref("Day.md"));
    const mine = PAGE.replace("# Day", "# Day, my edit");
    docs.edit(key("Day.md"), mine);
    files.set("Day.md", appended(PAGE));
    onPageAppended(new QueryClient(), { notebook: "nb-1", path: "Day.md" });
    await until(() => state("Day.md").banner?.kind === "changed");
    // The unsaved edits are still the text, and the page is still unsaved.
    expect(state("Day.md")).toMatchObject({ status: "dirty", text: mine });
    expect(state("Day.md").theirs?.text).toBe(appended(PAGE));
    // Saving finds the new line, and the merge holds both changes.
    await docs.save(key("Day.md"));
    expect(state("Day.md")).toMatchObject({ status: "stale", text: mine });
    const d = state("Day.md");
    const merged = mergeBody(d.base!.text, d.text, d.theirs!.text);
    expect(merged.conflicts).toBe(0);
    await docs.resolveMerge(key("Day.md"), merged.text, d.theirs!);
    expect(files.get("Day.md")).toBe("# Day, my edit\n\n## Captured\n\n- a\n- 14:05 from capture\n");
    expect(state("Day.md").status).toBe("clean");
  });
});
