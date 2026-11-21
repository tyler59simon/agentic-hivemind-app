import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A fake notebook on disk and Rust's draft store. `gates` holds a read or save of a path until the test opens it;
// `calls` counts commands; `failDrafts` makes draft writes fail; `readError` makes a read of a path fail.
const files = new Map<string, string>();
// Pages of the Living Memory notebook lm:demo:plans (NS-2C), served by fake `doc read` and `doc write` commands.
const lmPages = new Map<string, string>();
const lmRevs = new Map<string, string>();
async function lmRevision(...texts: string[]) {
  for (const text of texts) {
    const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
    lmRevs.set(text, Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(""));
  }
}
const drafts = new Map<string, unknown>();
const gates = new Map<string, Promise<void>>();
const calls: string[] = [];
const flags = { failDrafts: false, readError: new Map<string, string>(), deleteError: "", convertible: new Set<string>(), legacy: new Set<string>(), locked: new Set<string>(), draftGetError: false };
const converted: string[] = [];
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
        if (flags.convertible.has(path)) {
          return { ...loaded(files.get(path)!), format: { encoding: "windows-1252", bom: false, eol: "lf" }, readOnly: "This file contains bytes that are not valid windows-1252", convertible: true };
        }
        if (flags.legacy.has(path)) return { ...loaded(files.get(path)!), format: { encoding: "windows-1252", bom: false, eol: "lf" } };
        if (flags.locked.has(path)) return { ...loaded(files.get(path)!), readOnly: "This file is read-only on disk" };
        return loaded(files.get(path)!);
      case "file_rename": {
        const from = a.from as string, to = a.to as string;
        // Rust refuses a move onto a page whose unsaved edits are kept as a draft (drafts::any_under).
        if ([...drafts.values()].some((d) => { const p = (d as { target: { path: string } }).target.path; return p === to || p.startsWith(`${to}/`); })) {
          throw new Error(`${to} has unsaved edits kept as a draft; open it and save or discard them first`);
        }
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
          const next = await dk(`file:nb-1:${moved}`);
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
        if (a.convert) converted.push(path);
        return { status: "saved", sha256: sha(a.text as string), size: 1, mtimeMs: 2 };
      }
      case "file_delete":
        if (flags.deleteError) throw new Error(flags.deleteError);
        files.delete(path); return `.hivemind/trash/${path}`;
      case "file_save_as": {
        // The user picked the suggested name, replacing that file.
        const to = a.suggested as string;
        files.set(to, a.text as string);
        return ref(to);
      }
      case "draft_put":
        if (flags.failDrafts) throw new Error("The draft is larger than 32 MB");
        drafts.set(a.key as string, a.value); return null;
      case "draft_get":
        if (flags.draftGetError) throw new Error("The draft store could not be read");
        return drafts.get(a.key as string) ?? null;
      case "draft_delete": drafts.delete(a.key as string); return null;
      case "lm":
      case "lm_body": {
        const argv = a.argv as string[], page = argv[4];
        // Web Crypto settles outside fake timers, so the test computes the revisions it needs first (`lmRevision`).
        const rev = (t: string) => lmRevs.get(t) ?? "unknown";
        const ok = (result: unknown) => ({ exit_code: 0, result, error: null });
        if (!lmPages.has(page)) return { exit_code: 2, result: null, error: { code: "invalid", message: `not_found: no page ${page}` } };
        if (argv[1] === "read") {
          const text = lmPages.get(page)!;
          return ok({ text, revision: rev(text), size: text.length, updated: "2026-11-21T00:00:00Z", truncated: false });
        }
        if (argv[1] === "write") {
          if (rev(lmPages.get(page)!) !== argv[argv.indexOf("--expected-revision") + 1]) return { exit_code: 6, result: null, error: { code: "stale", message: "Stale revision" } };
          lmPages.set(page, a.body as string);
          return ok({ revision: rev(a.body as string) });
        }
        break;
      }
    }
    throw new Error(`unexpected ${cmd}`);
  }),
}));

const { useWorkspace } = await import("../workspace/store");
const { useApp } = await import("../store");
const docs = await import("./store");
const { retargetAll, startDocumentSync } = await import("./sync");
const { draftKeyOf } = await import("./keys");
const { forgetMoved } = await import("../lib/drafts");

const ref = (path: string) => ({ notebook: "nb-1", path });
const key = (path: string) => docs.keyOf(ref(path));
const state = (path: string) => docs.useDocuments.getState().docs[key(path)];
const ws = () => useWorkspace.getState();
let stop = () => {};

/** Wait, a macrotask at a time, until `ok()` holds. */
async function until(ok: () => boolean) {
  for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 0));
  expect(ok()).toBe(true);
}

describe("documents store", () => {
  beforeEach(() => {
    // The drafts module caches the drafts this run wrote; in the app the cache and the store always agree, so it forgets
    // them when the fake store is cleared.
    for (const d of drafts.values()) forgetMoved("nb-1", (d as { target: { path: string } }).target.path);
    files.clear(); lmPages.clear(); drafts.clear(); gates.clear(); calls.length = 0;
    flags.failDrafts = false; flags.readError.clear(); flags.deleteError = ""; flags.convertible.clear(); flags.legacy.clear(); flags.locked.clear(); flags.draftGetError = false; converted.length = 0;
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

  // Codex re-review of c496e1c.

  it("D2: a merge that keeps the version shown still finds a newer version on disk", async () => {
    ws().openTab({ kind: "file", file: ref("A.md") });
    await docs.open(ref("A.md"));
    docs.edit(key("A.md"), "mine");
    files.set("A.md", "theirs 1");
    await docs.refresh("nb-1", ["A.md"]);
    const shown = state("A.md").theirs!;
    files.set("A.md", "theirs 2");
    await docs.refresh("nb-1", ["A.md"]);
    await docs.resolveMerge(key("A.md"), "theirs 1", shown);
    expect(state("A.md")).toMatchObject({ status: "clean", text: "theirs 2", base: { text: "theirs 2" } });
  });

  it("S1 and S5: a refresh or reload that ends after its page was closed and reopened changes nothing", async () => {
    const reopen = async () => {
      ws().closeTab("p0", ws().panes[0].tabs[0].id);
      expect(state("A.md")).toBeUndefined();
      await docs.flushDraft(key("A.md"));
      ws().openTab({ kind: "file", file: ref("A.md") });
      await docs.open(ref("A.md"));
    };
    ws().openTab({ kind: "file", file: ref("A.md") });
    await docs.open(ref("A.md"));
    const lateRefresh = gate("file_read A.md");
    const refreshing = docs.refresh("nb-1", ["A.md"]);
    gates.delete("file_read A.md");
    files.set("A.md", "newer");
    await reopen();
    files.set("A.md", "what the late read saw");
    lateRefresh();
    await refreshing;
    expect(state("A.md")).toMatchObject({ status: "clean", text: "newer" });
    files.set("A.md", "newer");

    docs.edit(key("A.md"), "mine");
    const lateReload = gate("file_read A.md");
    const reloading = docs.reload(key("A.md"));
    gates.delete("file_read A.md");
    await reopen();
    expect(state("A.md")).toMatchObject({ status: "dirty", text: "mine" });
    lateReload();
    expect(await reloading).toBe(false);
    expect(state("A.md")).toMatchObject({ status: "dirty", text: "mine" });
    expect(drafts.has(await draftKeyOf(key("A.md")))).toBe(true);
  });

  it("N3: edits typed during a rename are kept when the tab closes and the app quits before the rename ends", async () => {
    const { QueryClient } = await import("@tanstack/react-query");
    const { movePath } = await import("../features/notes/actions");
    ws().openTab({ kind: "file", file: ref("A.md") });
    await docs.open(ref("A.md"));
    const slow = gate("file_rename undefined");
    const moving = movePath(new QueryClient(), "nb-1", "A.md", "B.md");
    await vi.waitFor(() => expect(calls).toContain("file_rename "));
    docs.edit(key("A.md"), "typed during the rename");
    ws().closeTab("p0", ws().panes[0].tabs[0].id);
    const quitting = docs.flushAllDrafts();
    slow();
    await moving;
    expect(await quitting).toEqual([]);
    expect(state("B.md")).toBeUndefined();
    expect((drafts.get(await draftKeyOf(key("B.md"))) as { mine: string }).mine).toBe("typed during the rename");
    expect(drafts.has(await draftKeyOf(key("A.md")))).toBe(false);
  });

  it("N4: edits typed while quitting writes drafts are written too", async () => {
    ws().openTab({ kind: "file", file: ref("A.md") });
    await docs.open(ref("A.md"));
    docs.edit(key("A.md"), "before quitting");
    const slow = gate("draft_put undefined");
    const quitting = docs.flushAllDrafts();
    await vi.waitFor(() => expect(calls).toContain("draft_put "));
    docs.edit(key("A.md"), "typed while quitting");
    slow();
    expect(await quitting).toEqual([]);
    expect((drafts.get(await draftKeyOf(key("A.md"))) as { mine: string }).mine).toBe("typed while quitting");
  });

  it("N5: a page opened while its section is renamed opens at the new name", async () => {
    const { QueryClient } = await import("@tanstack/react-query");
    const { movePath } = await import("../features/notes/actions");
    files.set("Area/P.md", "p");
    const slowMove = gate("file_rename undefined");
    const moving = movePath(new QueryClient(), "nb-1", "Area", "Zone");
    await vi.waitFor(() => expect(calls).toContain("file_rename "));
    const slowRead = gate("file_read Area/P.md");
    ws().openTab({ kind: "file", file: ref("Area/P.md") });
    const opening = docs.open(ref("Area/P.md"));
    slowMove();
    await moving;
    slowRead();
    await opening;
    expect(ws().panes[0].tabs[0].file).toEqual(ref("Zone/P.md"));
    await vi.waitFor(() => expect(state("Zone/P.md")).toMatchObject({ status: "clean", text: "p" }));
  });

  it("D7: a rename waits for a draft write in flight, so the draft is only under the new name", async () => {
    const { QueryClient } = await import("@tanstack/react-query");
    const { movePath } = await import("../features/notes/actions");
    ws().openTab({ kind: "file", file: ref("A.md") });
    await docs.open(ref("A.md"));
    docs.edit(key("A.md"), "draft in flight");
    const slow = gate("draft_put undefined");
    const flushing = docs.flushDraft(key("A.md"));
    await vi.waitFor(() => expect(calls).toContain("draft_put "));
    const moving = movePath(new QueryClient(), "nb-1", "A.md", "B.md");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).not.toContain("file_rename ");
    slow();
    await Promise.all([flushing, moving]);
    expect((drafts.get(await draftKeyOf(key("B.md"))) as { mine: string }).mine).toBe("draft in flight");
    expect(drafts.has(await draftKeyOf(key("A.md")))).toBe(false);
  });

  it("D8: a page's tabs close before its delete settles, and come back with their edits when it fails", async () => {
    const { QueryClient } = await import("@tanstack/react-query");
    const { trashPath } = await import("../features/notes/actions");
    ws().openTab({ kind: "file", file: ref("A.md") });
    await docs.open(ref("A.md"));
    docs.edit(key("A.md"), "edited");
    flags.deleteError = "Access is denied. (os error 5)";
    const slow = gate("file_delete A.md");
    const deleting = trashPath(new QueryClient(), "nb-1", "A.md");
    await vi.waitFor(() => expect(calls).toContain("file_delete A.md"));
    expect(ws().panes[0].tabs).toHaveLength(0);
    slow();
    await expect(deleting).rejects.toThrow("denied");
    await docs.flushDraft(key("A.md"));
    expect(ws().panes[0].tabs.map((t) => t.file)).toEqual([ref("A.md")]);
    await docs.open(ref("A.md"));
    expect(state("A.md")).toMatchObject({ status: "dirty", text: "edited" });
    flags.deleteError = "";
    await trashPath(new QueryClient(), "nb-1", "A.md");
    expect(files.has("A.md")).toBe(false);
    expect(ws().panes[0].tabs).toHaveLength(0);
    await vi.waitFor(async () => expect(drafts.has(await draftKeyOf(key("A.md")))).toBe(false));
  });

  // Codex re-review of b82e9ab.

  it("D8 (round 3): a failed delete gives back edits no draft could keep, and a page reopened during a delete goes with it", async () => {
    const { QueryClient } = await import("@tanstack/react-query");
    const { trashPath } = await import("../features/notes/actions");
    ws().openTab({ kind: "file", file: ref("A.md") });
    await docs.open(ref("A.md"));
    flags.failDrafts = true;
    docs.edit(key("A.md"), "edits no draft could keep");
    flags.deleteError = "Access is denied. (os error 5)";
    const slow = gate("file_delete A.md");
    const failing = trashPath(new QueryClient(), "nb-1", "A.md");
    await vi.waitFor(() => expect(calls).toContain("file_delete A.md"));
    expect(docs.isDeleting(docs.useDocuments.getState().held, ref("A.md"))).toBe(true);
    slow();
    await expect(failing).rejects.toThrow("denied");
    expect(state("A.md")).toMatchObject({ status: "dirty", text: "edits no draft could keep" });
    expect(ws().panes[0].tabs.map((tab) => tab.file)).toEqual([ref("A.md")]);
    flags.failDrafts = false;
    flags.deleteError = "";

    const slowAgain = gate("file_delete A.md");
    const deleting = trashPath(new QueryClient(), "nb-1", "A.md");
    await vi.waitFor(() => expect(calls.filter((c) => c === "file_delete A.md")).toHaveLength(2));
    ws().openTab({ kind: "file", file: ref("A.md") });
    const reads = calls.filter((c) => c === "file_read A.md").length;
    const reopening = docs.open(ref("A.md"));
    slowAgain();
    await deleting;
    await reopening;
    expect(calls.filter((c) => c === "file_read A.md")).toHaveLength(reads);
    expect(ws().panes[0].tabs).toHaveLength(0);
    expect(state("A.md")).toBeUndefined();
    expect(files.has("A.md")).toBe(false);
  });

  it("N5 (round 3): a page opened during a move reads nothing until the move ends, then finds its moved draft", async () => {
    const { QueryClient } = await import("@tanstack/react-query");
    const { movePath } = await import("../features/notes/actions");
    files.set("Area/P.md", "p");
    const draftKey = await draftKeyOf(key("Area/P.md"));
    drafts.set(draftKey, {
      key: draftKey, kind: "file", target: ref("Area/P.md"), precondition: { sha256: sha("p"), size: 1, mtimeMs: 1 },
      format: { encoding: "UTF-8", bom: false, eol: "lf" }, base: "p", mine: "p and a draft", savedAt: "t",
    });
    const slowMove = gate("file_rename undefined");
    const moving = movePath(new QueryClient(), "nb-1", "Area", "Zone");
    await vi.waitFor(() => expect(calls).toContain("file_rename "));
    ws().openTab({ kind: "file", file: ref("Area/P.md") });
    const opening = docs.open(ref("Area/P.md"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls).not.toContain("file_read Area/P.md");
    slowMove();
    await moving;
    await opening;
    expect(state("Zone/P.md")).toMatchObject({ status: "dirty", text: "p and a draft" });
  });

  it("N3 (round 3): a closed page whose last draft failed is reported, and the window waits for drafts in flight", async () => {
    const lost: string[] = [];
    docs.onDraftLost((line) => lost.push(line));
    ws().openTab({ kind: "file", file: ref("A.md") });
    await docs.open(ref("A.md"));
    docs.edit(key("A.md"), "typed, then the tab closed");
    expect(docs.draftsPending()).toBe(true);
    flags.failDrafts = true;
    ws().closeTab("p0", ws().panes[0].tabs[0].id);
    await vi.waitFor(() => expect(lost).toHaveLength(1));
    expect(lost[0]).toContain("A.md");
    expect(docs.draftsPending()).toBe(true);
    expect(await docs.flushAllDrafts()).toEqual([expect.stringContaining("A.md")]);
    docs.onDraftLost(() => {});
    docs.discard(key("A.md"));
    expect(docs.draftsPending()).toBe(false);
  });

  it("N4 (round 3): a draft whose write failed is never read back from the cache", async () => {
    const { putDraft, getFileDraft } = await import("../lib/drafts");
    const draftKey = await draftKeyOf(key("A.md"));
    flags.failDrafts = true;
    await expect(putDraft({
      key: draftKey, kind: "file", target: ref("A.md"), precondition: { sha256: sha("one"), size: 1, mtimeMs: 1 },
      format: { encoding: "UTF-8", bom: false, eol: "lf" }, mine: "never stored", savedAt: "t",
    })).rejects.toThrow();
    expect(await getFileDraft(draftKey)).toBeNull();
  });

  it("NS-1B: Convert to UTF-8 survives a restart as a draft and the save asks Rust to convert", async () => {
    files.set("L.txt", "caf?");
    flags.convertible.add("L.txt");
    ws().openTab({ kind: "file", file: ref("L.txt") });
    await docs.open(ref("L.txt"));
    expect(state("L.txt")).toMatchObject({ status: "readOnly", base: { convertible: true } });
    await docs.convertToUtf8(key("L.txt"));
    docs.edit(key("L.txt"), "café");
    await docs.flushAllDrafts();
    // Closed and reopened (the app restarted): still converted, with the edits.
    ws().closeTab("p0", ws().panes[0].tabs[0].id);
    docs.release(key("L.txt"));
    ws().openTab({ kind: "file", file: ref("L.txt") });
    await docs.open(ref("L.txt"));
    expect(state("L.txt")).toMatchObject({ status: "dirty", convert: true, text: "café", base: { format: { encoding: "UTF-8" } } });
    await docs.save(key("L.txt"));
    expect(converted).toEqual(["L.txt"]);
    expect(files.get("L.txt")).toBe("café");
  });

  it("D3: a converted draft comes back converted when the file changed since, and for an editable legacy file", async () => {   // Codex review of 52051c8
    files.set("L.txt", "line one\nline two\n");
    flags.convertible.add("L.txt");
    ws().openTab({ kind: "file", file: ref("L.txt") });
    await docs.open(ref("L.txt"));
    await docs.convertToUtf8(key("L.txt"));
    docs.edit(key("L.txt"), "line one, mine\nline two\n");
    await docs.flushAllDrafts();
    ws().closeTab("p0", ws().panes[0].tabs[0].id);
    docs.release(key("L.txt"));
    // Someone else changed the file meanwhile; it is still not valid windows-1252.
    files.set("L.txt", "line one\nline two\nline three\n");
    ws().openTab({ kind: "file", file: ref("L.txt") });
    await docs.open(ref("L.txt"));
    expect(state("L.txt")).toMatchObject({ status: "dirty", convert: true, text: "line one, mine\nline two\nline three\n", base: { format: { encoding: "UTF-8" } } });
    // An editable windows-1252 file converted because the edits hold characters it cannot store.
    files.set("W.txt", "plain");
    flags.legacy.add("W.txt");
    ws().openTab({ kind: "file", file: ref("W.txt") });
    await docs.open(ref("W.txt"));
    docs.edit(key("W.txt"), "plain \u4e2d");
    await docs.convertToUtf8(key("W.txt"));
    await docs.flushAllDrafts();
    ws().closeTab("p0", ws().panes[0].tabs.find((t) => t.file?.path === "W.txt")!.id);
    docs.release(key("W.txt"));
    ws().openTab({ kind: "file", file: ref("W.txt") });
    await docs.open(ref("W.txt"));
    expect(state("W.txt")).toMatchObject({ status: "dirty", convert: true, text: "plain \u4e2d", base: { format: { encoding: "UTF-8" } } });
    await docs.save(key("W.txt"));
    expect(converted).toEqual(["W.txt"]);
  });

  it("D3: Convert on a page that became undecodable brings back the draft written before, never writes over it", async () => {   // Codex review of 52051c8
    files.set("P.txt", "line one\nline two\n");
    ws().openTab({ kind: "file", file: ref("P.txt") });
    await docs.open(ref("P.txt"));
    docs.edit(key("P.txt"), "line one, mine\nline two\n");
    await docs.flushAllDrafts();
    ws().closeTab("p0", ws().panes[0].tabs[0].id);
    docs.release(key("P.txt"));
    // Another program added a line and bytes that do not decode.
    files.set("P.txt", "line one\nline two\nline three\n");
    flags.convertible.add("P.txt");
    ws().openTab({ kind: "file", file: ref("P.txt") });
    await docs.open(ref("P.txt"));
    expect(state("P.txt").status).toBe("readOnly");
    await docs.convertToUtf8(key("P.txt"));
    expect(state("P.txt")).toMatchObject({ status: "dirty", convert: true, text: "line one, mine\nline two\nline three\n", banner: { kind: "restored" } });
    await docs.flushAllDrafts();
    const kept = drafts.get(await draftKeyOf(key("P.txt"))) as { mine: string; convert?: boolean };
    expect(kept).toMatchObject({ mine: "line one, mine\nline two\nline three\n", convert: true });
  });

  it("D2: Save as over a file open in a tab shows the new text there", async () => {   // Codex review of 52051c8
    const { saveCopy } = await import("../features/notes/actions");
    ws().openTab({ kind: "file", file: ref("A.md") });
    await docs.open(ref("A.md"));
    await saveCopy("replaced from elsewhere", "A.md");
    expect(state("A.md")).toMatchObject({ status: "clean", text: "replaced from elsewhere" });
  });

  it("R2: new pages never go to a file opened from outside every notebook", async () => {   // Codex review of 52051c8
    const { currentNotebook } = await import("../features/notes/actions");
    ws().openTab({ kind: "file", file: { notebook: "@0123456789abcdef", path: "loose.txt" } });
    expect(currentNotebook("nb-1")).toEqual({ notebook: "nb-1", folder: "" });
    ws().openTab({ kind: "file", file: ref("Area/A.md") });
    expect(currentNotebook("nb-1")).toEqual({ notebook: "nb-1", folder: "Area" });
  });

  it("F2: a page opened at a rename's destination waits for the rename and gets the moved draft", async () => {   // Codex review of 52051c8 and its re-review
    const { QueryClient } = await import("@tanstack/react-query");
    const { movePath } = await import("../features/notes/actions");
    // A closed page whose unsaved edits exist only as a draft on disk.
    ws().openTab({ kind: "file", file: ref("A.md") });
    await docs.open(ref("A.md"));
    docs.edit(key("A.md"), "one, edited");
    await docs.flushAllDrafts();
    ws().closeTab("p0", ws().panes[0].tabs[0].id);
    docs.release(key("A.md"));
    const slow = gate("file_rename undefined");
    const moving = movePath(new QueryClient(), "nb-1", "A.md", "B.md");
    await until(() => calls.includes("file_rename "));
    ws().openTab({ kind: "file", file: ref("B.md") });
    const opening = docs.open(ref("B.md"));
    await Promise.resolve();
    expect(calls).not.toContain("file_read B.md");
    slow();
    await Promise.all([moving, opening]);
    expect(state("B.md")).toMatchObject({ status: "dirty", text: "one, edited" });
  });

  it("F2: a rename onto a page with unsaved edits is refused, and both keep their text", async () => {   // Codex re-review of fa08348
    const { QueryClient } = await import("@tanstack/react-query");
    const { movePath } = await import("../features/notes/actions");
    files.set("B.md", "b");
    ws().openTab({ kind: "file", file: ref("B.md") });
    await docs.open(ref("B.md"));
    docs.edit(key("B.md"), "b, mine");
    files.delete("B.md");   // another program deleted it
    await expect(movePath(new QueryClient(), "nb-1", "A.md", "B.md")).rejects.toThrow("unsaved edits");
    expect(calls).not.toContain("file_rename ");
    expect(files.get("A.md")).toBe("one");
    expect(state("B.md")).toMatchObject({ text: "b, mine" });
  });

  it("D2: Save as over a page that is still loading shows the new text once the load ends", async () => {   // Codex re-review of fa08348
    const { saveCopy } = await import("../features/notes/actions");
    files.set("B.md", "old");
    ws().openTab({ kind: "file", file: ref("B.md") });
    const slow = gate("draft_get undefined");
    const opening = docs.open(ref("B.md"));
    await until(() => calls.includes("draft_get "));
    const saving = saveCopy("new from Save as", "B.md");
    await until(() => calls.includes("file_save_as "));
    slow();
    await Promise.all([opening, saving]);
    expect(state("B.md")).toMatchObject({ status: "clean", text: "new from Save as" });
  });

  it("D3: Convert refuses when the draft lookup fails, so it never writes over a draft it could not see", async () => {   // Codex re-review of fa08348
    files.set("L.txt", "caf?");
    flags.convertible.add("L.txt");
    ws().openTab({ kind: "file", file: ref("L.txt") });
    await docs.open(ref("L.txt"));
    flags.draftGetError = true;
    await expect(docs.convertToUtf8(key("L.txt"))).rejects.toThrow("did not convert");
    expect(state("L.txt").status).toBe("readOnly");
    await docs.flushAllDrafts();
    expect(calls.filter((c) => c.startsWith("draft_put"))).toEqual([]);
  });

  it("D3: a draft the file can no longer take is kept and shown beside the read-only page", async () => {   // Codex re-review of fa08348
    ws().openTab({ kind: "file", file: ref("A.md") });
    await docs.open(ref("A.md"));
    docs.edit(key("A.md"), "one, mine");
    await docs.flushAllDrafts();
    ws().closeTab("p0", ws().panes[0].tabs[0].id);
    docs.release(key("A.md"));
    flags.locked.add("A.md");
    ws().openTab({ kind: "file", file: ref("A.md") });
    await docs.open(ref("A.md"));
    expect(state("A.md")).toMatchObject({ status: "readOnly", text: "one", kept: { text: "one, mine" } });
    expect(drafts.size).toBe(1);
  });

  it("W1: two pages whose names differ only in letter case are two documents", async () => {   // Codex re-review of fa08348
    files.set("Plan.md", "same");
    files.set("plan.md", "same");
    ws().openTab({ kind: "file", file: ref("Plan.md") });
    ws().openTab({ kind: "file", file: ref("plan.md") });
    await Promise.all([docs.open(ref("Plan.md")), docs.open(ref("plan.md"))]);
    docs.edit(key("Plan.md"), "the upper one's edit");
    await docs.save(key("Plan.md"));
    expect(files.get("Plan.md")).toBe("the upper one's edit");
    expect(files.get("plan.md")).toBe("same");
    expect(state("plan.md")).toMatchObject({ status: "clean", text: "same" });
  });

  it("N3: text typed during an untitled file's Save as stays as unsaved edits of the saved file", async () => {   // Codex re-review of fa08348
    const { saveUntitled } = await import("../features/notes/actions");
    const { setUntitledText } = await import("../features/notes/untitled");
    ws().openTab({ kind: "new-file" });
    const tab = ws().panes[0].tabs[0];
    setUntitledText(tab.id, "first");
    const slow = gate("file_save_as undefined");
    const saving = saveUntitled(tab.id, "first", "U.txt");
    await until(() => calls.includes("file_save_as "));
    setUntitledText(tab.id, "first and more");
    slow();
    await saving;
    expect(ws().panes[0].tabs[0]).toMatchObject({ kind: "file", file: ref("U.txt") });
    expect(files.get("U.txt")).toBe("first");
    expect(state("U.txt")).toMatchObject({ status: "dirty", text: "first and more" });
  });

  it("W1a: a draft filed under this page's key but written for another page is not taken for it", async () => {   // Codex final review of a34fafd
    files.set("plan.md", "lower");
    drafts.set(await draftKeyOf(key("plan.md")), { key: "x", kind: "file", target: ref("Plan.md"), precondition: { sha256: sha("lower"), size: 5, mtimeMs: 1 }, format: loaded("").format, base: "lower", mine: "Plan.md's edits", savedAt: "t" });
    ws().openTab({ kind: "file", file: ref("plan.md") });
    await docs.open(ref("plan.md"));
    expect(state("plan.md")).toMatchObject({ status: "clean", text: "lower" });
  });

  it("D3a: a page whose draft lookup fails does not open, so nothing writes over the draft", async () => {   // Codex final review of a34fafd
    flags.draftGetError = true;
    ws().openTab({ kind: "file", file: ref("A.md") });
    await docs.open(ref("A.md"));
    expect(state("A.md")).toMatchObject({ status: "error" });
    expect(state("A.md").error).toContain("could not check this page for unsaved edits");
  });

  it("F2b: a page gone from disk shows the draft it left, to copy out or discard", async () => {   // Codex final review of a34fafd
    ws().openTab({ kind: "file", file: ref("A.md") });
    await docs.open(ref("A.md"));
    docs.edit(key("A.md"), "one, mine");
    await docs.flushAllDrafts();
    ws().closeTab("p0", ws().panes[0].tabs[0].id);
    docs.release(key("A.md"));
    files.delete("A.md");
    ws().openTab({ kind: "file", file: ref("A.md") });
    await docs.open(ref("A.md"));
    expect(state("A.md")).toMatchObject({ status: "error", kept: { text: "one, mine" } });
    await docs.discardKept(key("A.md"));
    expect(drafts.size).toBe(0);
    expect(state("A.md").kept).toBeUndefined();
  });

  it("D3b: a draft kept beside a read-only page comes back once the file can take it", async () => {   // Codex final review of a34fafd
    ws().openTab({ kind: "file", file: ref("A.md") });
    await docs.open(ref("A.md"));
    docs.edit(key("A.md"), "one, mine");
    await docs.flushAllDrafts();
    ws().closeTab("p0", ws().panes[0].tabs[0].id);
    docs.release(key("A.md"));
    flags.locked.add("A.md");
    ws().openTab({ kind: "file", file: ref("A.md") });
    await docs.open(ref("A.md"));
    expect(state("A.md").kept).toBeDefined();
    flags.locked.delete("A.md");
    files.set("A.md", "one, changed");
    await docs.refresh("nb-1", ["A.md"]);
    expect(state("A.md")).toMatchObject({ text: "one, mine" });
    expect(state("A.md").kept).toBeUndefined();
    expect(["dirty", "stale"]).toContain(state("A.md").status);
  });

  it("D2: Save as onto a page whose load failed (the file was not there) shows the saved text", async () => {   // Codex final review of a34fafd
    const { saveCopy } = await import("../features/notes/actions");
    ws().openTab({ kind: "file", file: ref("B.md") });
    await docs.open(ref("B.md"));
    expect(state("B.md").status).toBe("error");
    await saveCopy("saved by Save as", "B.md");
    expect(state("B.md")).toMatchObject({ status: "clean", text: "saved by Save as" });
  });

  it("F2a: a page a move lands on takes no edits until the move ends", async () => {   // Codex final review of a34fafd
    const { QueryClient } = await import("@tanstack/react-query");
    const { movePath } = await import("../features/notes/actions");
    files.set("B.md", "b");
    ws().openTab({ kind: "file", file: ref("B.md") });
    await docs.open(ref("B.md"));
    files.delete("B.md");   // another program deleted it; the page is still open and clean
    const slow = gate("file_rename undefined");
    const moving = movePath(new QueryClient(), "nb-1", "A.md", "B.md");
    await until(() => calls.includes("file_rename "));
    docs.edit(key("B.md"), "typed during the move");
    expect(state("B.md").text).toBe("b");
    slow();
    await moving;
    expect(files.get("B.md")).toBe("one");
  });

  it("N3a: text typed during Save as onto a page with unsaved edits stays in the untitled tab", async () => {   // Codex final review of a34fafd
    const { saveUntitled } = await import("../features/notes/actions");
    const { setUntitledText, untitledText } = await import("../features/notes/untitled");
    files.set("B.md", "b");
    ws().openTab({ kind: "file", file: ref("B.md") });
    await docs.open(ref("B.md"));
    docs.edit(key("B.md"), "b, mine");
    ws().openTab({ kind: "new-file" });
    const tab = ws().panes[0].tabs[1];
    setUntitledText(tab.id, "first");
    const slow = gate("file_save_as undefined");
    const saving = saveUntitled(tab.id, "first", "B.md");
    await until(() => calls.includes("file_save_as "));
    setUntitledText(tab.id, "first and more");
    slow();
    await saving;
    expect(state("B.md")).toMatchObject({ text: "b, mine" });
    expect(ws().panes[0].tabs[1]).toMatchObject({ kind: "new-file" });
    expect(untitledText(tab.id)).toBe("first and more");
  });

  it("N3b: text typed during Save as stays in the untitled tab when the saved file does not open for editing", async () => {   // Codex final review of a34fafd
    const { saveUntitled } = await import("../features/notes/actions");
    const { setUntitledText, untitledText } = await import("../features/notes/untitled");
    flags.readError.set("U.txt", "U.txt is in use by another program");
    ws().openTab({ kind: "new-file" });
    const tab = ws().panes[0].tabs[0];
    setUntitledText(tab.id, "first");
    const slow = gate("file_save_as undefined");
    const saving = saveUntitled(tab.id, "first", "U.txt");
    await until(() => calls.includes("file_save_as "));
    setUntitledText(tab.id, "first and more");
    slow();
    await saving;
    expect(ws().panes[0].tabs[0]).toMatchObject({ kind: "new-file" });
    expect(untitledText(tab.id)).toBe("first and more");
  });

  it("N3c: a second Save as of the same untitled tab while one runs does nothing", async () => {   // Codex final review of a34fafd
    const { saveUntitled } = await import("../features/notes/actions");
    const { setUntitledText } = await import("../features/notes/untitled");
    ws().openTab({ kind: "new-file" });
    const tab = ws().panes[0].tabs[0];
    setUntitledText(tab.id, "text");
    const slow = gate("file_save_as undefined");
    const first = saveUntitled(tab.id, "text", "U.txt");
    await until(() => calls.includes("file_save_as "));
    expect(await saveUntitled(tab.id, "text", "U.txt")).toBeNull();
    slow();
    await first;
    expect(calls.filter((c) => c === "file_save_as ")).toHaveLength(1);
  });

  it("U2: renaming a section keeps every dot of the new name", async () => {
    const { renamed } = await import("../features/notes/actions");
    expect(renamed("Projects/Release.2026", "Archive", true)).toBe("Projects/Archive");
    expect(renamed("Projects/Plan.md", "Roadmap")).toBe("Projects/Roadmap.md");
  });
  it("NS-2C: a Living Memory page saves itself 5 s after the last edit, and again after a save that was still running", async () => {
    lmPages.set("A.md", "one\r\n");
    await lmRevision("one\r\n", "three\r\n", "four\r\n", "five\r\n");
    const lm = { notebook: "lm:demo:plans", path: "A.md" }, k = docs.keyOf(lm);
    ws().openTab({ kind: "file", file: lm });
    await docs.open(lm);
    expect(docs.useDocuments.getState().docs[k]).toMatchObject({ status: "clean", text: "one\n" });
    vi.useFakeTimers();
    try {
      docs.edit(k, "two\n");
      await vi.advanceTimersByTimeAsync(4000);
      docs.edit(k, "three\n");
      await vi.advanceTimersByTimeAsync(4000);
      expect(lmPages.get("A.md")).toBe("one\r\n");
      await vi.advanceTimersByTimeAsync(1500);
      // Written with the page's own line endings.
      expect(lmPages.get("A.md")).toBe("three\r\n");
      expect(docs.useDocuments.getState().docs[k].status).toBe("clean");
      // A save held at the bridge: the next autosave waits for it instead of being lost.
      docs.edit(k, "four\n");
      const open = gate("lm_body undefined");
      void docs.save(k);
      docs.edit(k, "five\n");
      await vi.advanceTimersByTimeAsync(5500);
      expect(lmPages.get("A.md")).toBe("three\r\n");
      open();
      await vi.advanceTimersByTimeAsync(5500);
      expect(lmPages.get("A.md")).toBe("five\r\n");
    } finally {
      vi.useRealTimers();
    }
  });
});
