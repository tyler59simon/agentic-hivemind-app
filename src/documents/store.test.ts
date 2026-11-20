import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A fake notebook on disk and Rust's draft store. `gates` holds a read or save of a path until the test opens it;
// `calls` counts commands; `failDrafts` makes draft writes fail; `readError` makes a read of a path fail.
const files = new Map<string, string>();
const drafts = new Map<string, unknown>();
const gates = new Map<string, Promise<void>>();
const calls: string[] = [];
const flags = { failDrafts: false, readError: new Map<string, string>() };
function gate(name: string) {
  let open = () => {};
  gates.set(name, new Promise<void>((resolve) => { open = resolve; }));
  return () => { gates.delete(name); open(); };
}
const sha = (text: string) => `sha-${text}`;
const loaded = (text: string) => ({ text, sha256: sha(text), size: text.length, mtimeMs: 1, format: { encoding: "UTF-8", bom: false, eol: "lf" }, readOnly: null, binary: false });
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, a: Record<string, unknown>) => {
    const path = a.path as string;
    calls.push(`${cmd} ${path ?? ""}`);
    await gates.get(`${cmd} ${path}`);
    switch (cmd) {
      case "file_read":
        if (flags.readError.has(path)) throw new Error(flags.readError.get(path));
        if (!files.has(path)) throw new Error(`${path} not found`);
        return loaded(files.get(path)!);
      case "file_rename": {
        const from = a.from as string, to = a.to as string;
        for (const [p, text] of [...files]) {
          const moved = p === from ? to : p.startsWith(`${from}/`) ? to + p.slice(from.length) : null;
          if (moved !== null) { files.delete(p); files.set(moved, text); }
        }
        // Rust moves the drafts of moved pages too (drafts::retarget).
        const { draftKeyOf: dk } = await import("./keys");
        for (const [k, d] of [...drafts]) {
          const target = (d as { target: { path: string } }).target;
          const moved = target.path === from ? to : target.path.startsWith(`${from}/`) ? to + target.path.slice(from.length) : null;
          if (moved === null) continue;
          const next = await dk(`file:nb-1:${moved.toLowerCase()}`);
          drafts.delete(k);
          drafts.set(next, { ...(d as object), key: next, target: { ...target, path: moved } });
        }
        return null;
      }
      case "file_save": {
        if (!files.has(path)) return { status: "gone" };
        const pre = a.pre as { sha256: string };
        if (sha(files.get(path)!) !== pre.sha256) return { status: "stale", sha256: sha(files.get(path)!) };
        files.set(path, a.text as string);
        return { status: "saved", sha256: sha(a.text as string), size: 1, mtimeMs: 2 };
      }
      case "draft_put":
        if (flags.failDrafts) throw new Error("The draft is larger than 32 MB");
        drafts.set(a.key as string, a.value); return null;
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
    files.clear(); drafts.clear(); gates.clear(); calls.length = 0;
    flags.failDrafts = false; flags.readError.clear();
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
    await docs.resolveMerge(key("A.md"), "merged", state("A.md").theirs!);
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

  // ---- Codex review of 32fd236 ----

  it("S1: two tabs opening at once share one read, and a read that ends after its tab closed leaves nothing behind", async () => {
    const release = gate("file_read A.md");
    ws().openTab({ kind: "file", file: ref("A.md") });
    const first = docs.open(ref("A.md")), second = docs.open(ref("A.md"));
    expect(state("A.md").status).toBe("loading");
    release();
    await Promise.all([first, second]);
    expect(calls.filter((c) => c === "file_read A.md")).toHaveLength(1);
    expect(state("A.md").status).toBe("clean");

    files.set("C.md", "c");
    const late = gate("file_read C.md");
    const opening = docs.open(ref("C.md"));
    docs.release(key("C.md"));
    late();
    await opening;
    expect(state("C.md")).toBeUndefined();
    expect(docs.useDocuments.getState().docs[key("C.md")]).toBeUndefined();
  });

  it("S2 and D7: a rename waits for a save and a draft write in flight, and nothing lands under the old name", async () => {
    const { QueryClient } = await import("@tanstack/react-query");
    const { movePath } = await import("../features/notes/actions");
    ws().openTab({ kind: "file", file: ref("A.md") });
    await docs.open(ref("A.md"));
    docs.edit(key("A.md"), "saving this");
    const slow = gate("file_save A.md");
    const saving = docs.save(key("A.md"));
    docs.edit(key("A.md"), "saving this, then more");
    const moving = movePath(new QueryClient(), "nb-1", "A.md", "B.md");
    await Promise.resolve();
    expect(calls).not.toContain("file_rename ");
    slow();
    await Promise.all([saving, moving]);
    expect(files.get("B.md")).toBe("saving this");
    expect(state("B.md")).toMatchObject({ status: "dirty", text: "saving this, then more" });
    expect(state("A.md")).toBeUndefined();
    // The newest draft is under the new name only.
    await docs.flushDraft(key("B.md"));
    const newKey = await draftKeyOf(key("B.md")), oldKey = await draftKeyOf(key("A.md"));
    expect((drafts.get(newKey) as { mine: string }).mine).toBe("saving this, then more");
    expect(drafts.has(oldKey)).toBe(false);
    // A new page at the old name starts clean: the moved draft is not served from this run's cache (C2).
    files.set("A.md", "fresh");
    ws().openTab({ kind: "file", file: ref("A.md") });
    await docs.open(ref("A.md"));
    expect(state("A.md")).toMatchObject({ status: "clean", text: "fresh" });
  });

  it("S3: a page emptied and saved after its file vanished is unsaved, and a read that fails for another reason changes nothing", async () => {
    const { reduce } = await import("./session");
    const saving = { status: "saving" as const, base: null, text: "", version: 1, saving: "" };
    expect(reduce(saving, { type: "gone" }).status).toBe("dirty");
    ws().openTab({ kind: "file", file: ref("A.md") });
    await docs.open(ref("A.md"));
    flags.readError.set("A.md", "The process cannot access the file because it is being used by another process. (os error 32)");
    await docs.refresh("nb-1", ["A.md"]);
    expect(state("A.md")).toMatchObject({ status: "clean", text: "one" });
    expect(state("A.md").banner).toBeUndefined();
  });

  it("S5: typing while a reload reads the file keeps the new edits", async () => {
    ws().openTab({ kind: "file", file: ref("A.md") });
    await docs.open(ref("A.md"));
    docs.edit(key("A.md"), "first edit");
    const slow = gate("file_read A.md");
    const reloading = docs.reload(key("A.md"));
    docs.edit(key("A.md"), "typed during the reload");
    slow();
    expect(await reloading).toBe(false);
    expect(state("A.md")).toMatchObject({ status: "dirty", text: "typed during the reload" });
  });

  it("D2: a merge is saved against the version the dialog showed, never a newer one that came in meanwhile", async () => {
    ws().openTab({ kind: "file", file: ref("A.md") });
    await docs.open(ref("A.md"));
    docs.edit(key("A.md"), "mine");
    files.set("A.md", "theirs 1");
    await docs.refresh("nb-1", ["A.md"]);
    const shown = state("A.md").theirs!;
    expect(shown.text).toBe("theirs 1");
    files.set("A.md", "theirs 2");
    await docs.refresh("nb-1", ["A.md"]);
    await docs.resolveMerge(key("A.md"), "mine merged with theirs 1", shown);
    expect(files.get("A.md")).toBe("theirs 2");
    expect(state("A.md")).toMatchObject({ status: "stale", text: "mine merged with theirs 1", theirs: { text: "theirs 2" } });
  });

  it("D4: a draft kept without its base never merges by itself over a changed file", async () => {
    files.set("Big.md", "disk now\n");
    const draftKey = await draftKeyOf(key("Big.md"));
    drafts.set(draftKey, {
      key: draftKey, kind: "file", target: ref("Big.md"), precondition: { sha256: "sha-old", size: 1, mtimeMs: 1 },
      format: { encoding: "UTF-8", bom: false, eol: "lf" }, mine: "my draft\n", savedAt: "t",
    });
    ws().openTab({ kind: "file", file: ref("Big.md") });
    await docs.open(ref("Big.md"));
    expect(state("Big.md")).toMatchObject({ status: "stale", text: "my draft\n", base: { text: "" }, theirs: { text: "disk now\n" } });
    const { mergeBody } = await import("../features/editor/merge");
    expect(mergeBody("", "my draft\n", "disk now\n").conflicts).toBeGreaterThan(0);
  });

  it("D6: Try again after a failed open keeps the draft", async () => {
    const draftKey = await draftKeyOf(key("Later.md"));
    drafts.set(draftKey, {
      key: draftKey, kind: "file", target: ref("Later.md"), precondition: { sha256: sha("x"), size: 1, mtimeMs: 1 },
      format: { encoding: "UTF-8", bom: false, eol: "lf" }, base: "x", mine: "x and my edit", savedAt: "t",
    });
    ws().openTab({ kind: "file", file: ref("Later.md") });
    await docs.open(ref("Later.md"));
    expect(state("Later.md").status).toBe("error");
    files.set("Later.md", "x");
    await docs.open(ref("Later.md"));
    expect(state("Later.md")).toMatchObject({ status: "dirty", text: "x and my edit" });
    expect(drafts.has(draftKey)).toBe(true);
  });

  it("D5 and D9: quitting writes pending drafts, and a draft that cannot be written is reported", async () => {
    ws().openTab({ kind: "file", file: ref("A.md") });
    await docs.open(ref("A.md"));
    docs.edit(key("A.md"), "typed just before quitting");
    expect(await docs.flushAllDrafts()).toEqual([]);
    expect((drafts.get(await draftKeyOf(key("A.md"))) as { mine: string }).mine).toBe("typed just before quitting");
    flags.failDrafts = true;
    docs.edit(key("A.md"), "this one cannot be kept");
    const failed = await docs.flushAllDrafts();
    expect(failed).toHaveLength(1);
    expect(failed[0]).toContain("A.md");
    expect(state("A.md").draftError).toContain("32 MB");
    flags.failDrafts = false;
    docs.edit(key("A.md"), "kept again");
    await docs.flushAllDrafts();
    expect(state("A.md").draftError).toBeUndefined();
    expect(docs.utf8Bytes("a\u00e9\u20ac\ud83d\ude00")).toBe(1 + 2 + 3 + 4);
  });

  it("D8: pages with unsaved edits under a section are found before it is deleted", async () => {
    files.set("Area/P.md", "p");
    files.set("Area/Q.md", "q");
    ws().openTab({ kind: "file", file: ref("Area/P.md") });
    ws().openTab({ kind: "file", file: ref("Area/Q.md") }, { split: true });
    await docs.open(ref("Area/P.md"));
    await docs.open(ref("Area/Q.md"));
    docs.edit(key("Area/Q.md"), "edited");
    expect(docs.unsavedUnder("nb-1", "Area")).toEqual(["Area/Q.md"]);
    expect(docs.unsavedUnder("nb-1", "Area/P.md")).toEqual([]);
  });

  it("U2: renaming a section keeps every dot of the new name", async () => {
    const { renamed } = await import("../features/notes/actions");
    expect(renamed("Projects/Release.2026", "Archive", true)).toBe("Projects/Archive");
    expect(renamed("Projects/Plan.md", "Roadmap")).toBe("Projects/Roadmap.md");
  });
});
