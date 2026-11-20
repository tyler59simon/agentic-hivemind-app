import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A fake notebook on disk and Rust's draft store.
const files = new Map<string, string>();
const drafts = new Map<string, unknown>();
const sha = (text: string) => `sha-${text}`;
const loaded = (text: string) => ({ text, sha256: sha(text), size: text.length, mtimeMs: 1, format: { encoding: "UTF-8", bom: false, eol: "lf" }, readOnly: null, binary: false });
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, a: Record<string, unknown>) => {
    const path = a.path as string;
    switch (cmd) {
      case "file_read":
        if (!files.has(path)) throw new Error(`${path} not found`);
        return loaded(files.get(path)!);
      case "file_save": {
        if (!files.has(path)) return { status: "gone" };
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
const { retargetAll, startDocumentSync } = await import("./sync");
const { draftKeyOf } = await import("./keys");

const ref = (path: string) => ({ notebook: "nb-1", path });
const key = (path: string) => docs.keyOf(ref(path));
const state = (path: string) => docs.useDocuments.getState().docs[key(path)];
const ws = () => useWorkspace.getState();
let stop = () => {};

describe("documents store", () => {
  beforeEach(() => {
    files.clear(); drafts.clear();
    files.set("A.md", "one");
    useWorkspace.setState({ panes: [{ id: "p0", tabs: [], active: null }], focused: "p0", dirty: {}, reveal: null });
    useApp.setState({ route: { page: "notes" }, back: [] });
    docs.useDocuments.setState({ docs: {}, refs: {} });
    stop = startDocumentSync();
  });
  afterEach(() => stop());

  it("marks every tab of an edited page unsaved, and clears it on save", async () => {
    ws().openTab({ kind: "file", file: ref("A.md") });
    await docs.open(ref("A.md"));
    docs.edit(key("A.md"), "two");
    const tab = ws().panes[0].tabs[0];
    expect(ws().dirty[tab.id]).toBe(true);
    await docs.save(key("A.md"));
    expect(files.get("A.md")).toBe("two");
    expect(ws().dirty[tab.id]).toBe(false);
  });

  it("a save over an outside change keeps both sides for the merge, and the merge saves", async () => {
    ws().openTab({ kind: "file", file: ref("A.md") });
    await docs.open(ref("A.md"));
    docs.edit(key("A.md"), "mine");
    files.set("A.md", "theirs");
    await docs.save(key("A.md"));
    expect(state("A.md")).toMatchObject({ status: "stale", text: "mine", theirs: { text: "theirs" } });
    await docs.resolveMerge(key("A.md"), "merged");
    expect(files.get("A.md")).toBe("merged");
    expect(state("A.md").status).toBe("clean");
  });

  it("restores unsaved edits from a draft, and merges a draft into a file that changed since", async () => {
    const lines = (...xs: string[]) => xs.map((x) => `${x}\n`).join("");
    const base = lines("one", "two", "three", "four");
    files.set("B.md", base);
    const draftKey = await draftKeyOf(key("B.md"));
    drafts.set(draftKey, {
      key: draftKey, kind: "file", target: ref("B.md"), precondition: { sha256: sha(base), size: 1, mtimeMs: 1 },
      format: { encoding: "UTF-8", bom: false, eol: "lf" }, base, mine: lines("ONE", "two", "three", "four"), savedAt: "t",
    });
    ws().openTab({ kind: "file", file: ref("B.md") });
    await docs.open(ref("B.md"));
    expect(state("B.md")).toMatchObject({ status: "dirty", text: lines("ONE", "two", "three", "four"), banner: { kind: "restored" } });

    // The file changed elsewhere while the app was closed: a clean merge comes back as unsaved edits on the new version.
    docs.release(key("B.md"));
    files.set("B.md", lines("one", "two", "three", "FOUR"));
    await docs.open(ref("B.md"));
    expect(state("B.md")).toMatchObject({ status: "dirty", text: lines("ONE", "two", "three", "FOUR") });
    expect(state("B.md").base?.text).toBe(lines("one", "two", "three", "FOUR"));

    // A clash opens the merge with both sides.
    docs.release(key("B.md"));
    files.set("B.md", lines("uno", "two", "three", "four"));
    await docs.open(ref("B.md"));
    expect(state("B.md")).toMatchObject({ status: "stale", text: lines("ONE", "two", "three", "four"), base: { text: base }, theirs: { text: lines("uno", "two", "three", "four") } });
  });

  it("a rename moves the tab and the document together, edits included", async () => {
    ws().openTab({ kind: "file", file: ref("Projects/A.md") });
    files.set("Projects/A.md", "x");
    await docs.open(ref("Projects/A.md"));
    docs.edit(key("Projects/A.md"), "edited");
    retargetAll("nb-1", "Projects", "Archive/Projects");
    expect(ws().panes[0].tabs[0].file?.path).toBe("Archive/Projects/A.md");
    expect(state("Archive/Projects/A.md")).toMatchObject({ status: "dirty", text: "edited" });
    expect(state("Projects/A.md")).toBeUndefined();
    expect(ws().dirty[ws().panes[0].tabs[0].id]).toBe(true);
  });

  it("closing the last tab lets the document go; a clean outside change follows", async () => {
    ws().openTab({ kind: "file", file: ref("A.md") });
    await docs.open(ref("A.md"));
    files.set("A.md", "from Notepad");
    await docs.refresh("nb-1", ["A.md"]);
    expect(state("A.md")).toMatchObject({ status: "clean", text: "from Notepad", banner: { kind: "followed" } });
    const tab = ws().panes[0].tabs[0];
    ws().closeTab("p0", tab.id);
    expect(state("A.md")).toBeUndefined();
  });
});
