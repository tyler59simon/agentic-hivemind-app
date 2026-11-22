// NS-7B: ticking a task, setting a property from a board or a table and clearing one write one change to one page, against
// the hash or revision the list showed. A page that moved on is refused; an open page keeps its unsaved edits; a Living
// Memory page read truncated is never written.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Folder notebook `nb-1`: the raw bytes of each page (so Windows line endings can be seen), read as LF text with the format. */
const files = new Map<string, string>();
const drafts = new Map<string, unknown>();
const saves: string[] = [];
const sha = (raw: string) => `sha-${raw}`;
const format = (raw: string) => ({ encoding: "UTF-8", bom: false, eol: raw.includes("\r\n") ? "crlf" : "lf" });

/** Living Memory notebook `demo/plans`. `revision` is the real hash, which `pageText`'s check needs. */
const lmPages = new Map<string, { text: string; truncated?: boolean }>();
const lmWrites: { path: string; body: string; expected: string }[] = [];
let lmStale = false;
const hash = async (text: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))), (b) => b.toString(16).padStart(2, "0")).join("");

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, a: Record<string, unknown>) => {
    const path = a.path as string;
    switch (cmd) {
      case "file_read": {
        const raw = files.get(path);
        if (raw === undefined) throw new Error(`${path} not found`);
        return { text: raw.replace(/\r\n/g, "\n"), sha256: sha(raw), size: raw.length, mtimeMs: 1, format: format(raw), readOnly: null, binary: false };
      }
      case "file_save": {
        const pre = a.pre as { sha256: string };
        const raw = files.get(path)!;
        if (sha(raw) !== pre.sha256) return { status: "stale", sha256: sha(raw) };
        const eol = (a.format as { eol: string }).eol;
        const next = eol === "crlf" ? (a.text as string).replace(/\n/g, "\r\n") : (a.text as string);
        files.set(path, next);
        saves.push(path);
        return { status: "saved", sha256: sha(next), size: next.length, mtimeMs: 2 };
      }
      case "draft_put": drafts.set(a.key as string, a.value); return null;
      case "draft_get": return drafts.get(a.key as string) ?? null;
      case "draft_delete": drafts.delete(a.key as string); return null;
      case "lm": {
        const argv = a.argv as string[];
        const page = lmPages.get(argv[argv.length - 1]);
        if (argv[1] !== "read" || !page) return { exit_code: 4, error: { code: "not_found", message: "not_found: no such page" }, result: null };
        return { exit_code: 0, error: null, result: { domain: "demo", notebook: "plans", path: argv[argv.length - 1], text: page.text, revision: await hash(page.text), size: page.text.length, updated: "", ...(page.truncated ? { truncated: true } : {}) } };
      }
      case "lm_body": {
        const argv = a.argv as string[];
        const at = argv.indexOf("--expected-revision");
        lmWrites.push({ path: argv[argv.length - 1], body: a.body as string, expected: argv[at + 1] });
        if (lmStale) return { exit_code: 6, error: { code: "stale", message: "stale: the page changed" }, result: null };
        lmPages.set(argv[argv.length - 1], { text: a.body as string });
        return { exit_code: 0, error: null, result: { operation_id: "op", revision: await hash(a.body as string) } };
      }
    }
    throw new Error(`unexpected ${cmd}`);
  }),
}));

const { useWorkspace } = await import("../../workspace/store");
const { useApp } = await import("../../store");
const docs = await import("../../documents/store");
const { setTaskDone, setPageProperty, clearPageProperty } = await import("./writes");

const ref = (path: string) => ({ notebook: "nb-1", path });
const key = (path: string) => docs.keyOf(ref(path));
const state = (path: string) => docs.useDocuments.getState().docs[key(path)];
const task = (path: string, line: number, text: string, extra: Record<string, unknown> = {}) => ({ notebook: "nb-1", path, line, done: false, text, sha256: sha(files.get(path)!), ...extra });

beforeEach(() => {
  files.clear(); drafts.clear(); saves.length = 0; lmPages.clear(); lmWrites.length = 0; lmStale = false;
  useWorkspace.setState({ panes: [{ id: "p0", tabs: [], active: null }], focused: "p0", dirty: {}, reveal: null });
  useApp.setState({ route: { page: "notes" }, back: [] });
  docs.useDocuments.setState({ docs: {}, refs: {} });
});
afterEach(() => vi.clearAllMocks());

describe("ticking a task on a page that is not open", () => {
  it("changes that one line and keeps the page's Windows line endings", async () => {
    files.set("A.md", "# A\r\n- [ ] one\r\n- [ ] two 📅 2026-12-01\r\n- [ ] three\r\n");
    expect(await setTaskDone(task("A.md", 3, "two 📅 2026-12-01"), true)).toBe("saved");
    expect(files.get("A.md")).toBe("# A\r\n- [ ] one\r\n- [x] two 📅 2026-12-01\r\n- [ ] three\r\n");
    // And back: the box is cleared again.
    await setTaskDone(task("A.md", 3, "two 📅 2026-12-01", { done: true }), false);
    expect(files.get("A.md")).toBe("# A\r\n- [ ] one\r\n- [ ] two 📅 2026-12-01\r\n- [ ] three\r\n");
  });

  it("refuses a page whose hash is not the one the list was read from, and writes nothing", async () => {
    files.set("A.md", "# A\n- [ ] one\n");
    const listed = task("A.md", 2, "one");
    files.set("A.md", "# A\n\n- [ ] one\n");
    await expect(setTaskDone(listed, true)).rejects.toThrow(/changed since it was read, so nothing was written/);
    expect(files.get("A.md")).toBe("# A\n\n- [ ] one\n");
    expect(saves).toEqual([]);
  });

  it("refuses a line that is no longer the task that was listed, even when the page's hash matches", async () => {
    files.set("A.md", "# A\n- [ ] one\n- [ ] two\n");
    for (const listed of [task("A.md", 2, "two"), task("A.md", 2, "one", { done: true }), task("A.md", 9, "one"), task("A.md", 1, "A")]) {
      await expect(setTaskDone(listed, true)).rejects.toThrow(/no longer there/);
    }
    expect(files.get("A.md")).toBe("# A\n- [ ] one\n- [ ] two\n");
    expect(saves).toEqual([]);
  });

  it("is refused by the save too when the file changes between its read and its write", async () => {
    files.set("A.md", "# A\n- [ ] one\n");
    const listed = task("A.md", 2, "one");
    const { invoke } = await import("@tauri-apps/api/core");
    const real = vi.mocked(invoke).getMockImplementation()!;
    vi.mocked(invoke).mockImplementation(async (cmd, args) => {
      const out = await real(cmd, args);
      if (cmd === "file_read") files.set("A.md", "# A\n- [ ] one\nsomeone else\n");
      return out;
    });
    await expect(setTaskDone(listed, true)).rejects.toThrow(/changed since it was read/);
    expect(files.get("A.md")).toBe("# A\n- [ ] one\nsomeone else\n");
    vi.mocked(invoke).mockImplementation(real);
  });
});

describe("ticking a task on a page that is open", () => {
  const PAGE = "# Day\n\n- [ ] a\n- [ ] b\n";

  async function opened(path: string) {
    useWorkspace.getState().openTab({ kind: "file", file: ref(path) });
    await docs.open(ref(path));
  }

  it("keeps the unsaved edits, adds the tick to them and leaves the page unsaved", async () => {
    files.set("Day.md", PAGE);
    await opened("Day.md");
    docs.edit(key("Day.md"), PAGE.replace("# Day", "# Day, my edit"));
    // The edit above does not move the task, so the list's line 4 is still its line.
    expect(await setTaskDone(task("Day.md", 4, "b"), true)).toBe("unsaved");
    expect(state("Day.md")).toMatchObject({ status: "dirty", text: "# Day, my edit\n\n- [ ] a\n- [x] b\n" });
    expect(files.get("Day.md")).toBe(PAGE);
    expect(saves).toEqual([]);
    // Saving writes both.
    await docs.save(key("Day.md"));
    expect(files.get("Day.md")).toBe("# Day, my edit\n\n- [ ] a\n- [x] b\n");
  });

  it("refuses a tick whose line the unsaved edits moved", async () => {
    files.set("Day.md", PAGE);
    await opened("Day.md");
    const mine = `new line\n${PAGE}`;
    docs.edit(key("Day.md"), mine);
    await expect(setTaskDone(task("Day.md", 4, "b"), true)).rejects.toThrow(/no longer there/);
    expect(state("Day.md").text).toBe(mine);
  });

  it("saves a page with no unsaved edits at once", async () => {
    files.set("Day.md", PAGE);
    await opened("Day.md");
    expect(await setTaskDone(task("Day.md", 3, "a"), true)).toBe("saved");
    expect(files.get("Day.md")).toBe("# Day\n\n- [x] a\n- [ ] b\n");
    expect(state("Day.md")).toMatchObject({ status: "clean", text: "# Day\n\n- [x] a\n- [ ] b\n" });
  });

  it("refuses a list that is older than the page the tab last saw", async () => {
    files.set("Day.md", PAGE);
    await opened("Day.md");
    await expect(setTaskDone({ ...task("Day.md", 3, "a"), sha256: "sha-an older page" }, true)).rejects.toThrow(/changed since it was read/);
    expect(state("Day.md").text).toBe(PAGE);
  });

  it("is refused while the page cannot take an edit", async () => {
    files.set("Day.md", PAGE);
    await opened("Day.md");
    docs.useDocuments.setState((st) => ({ docs: { ...st.docs, [key("Day.md")]: { ...st.docs[key("Day.md")], status: "saving" } } }));
    await expect(setTaskDone(task("Day.md", 3, "a"), true)).rejects.toThrow(/is open and is busy/);
  });
});

describe("ticking a task of a Living Memory page", () => {
  const lm = (line: number, text: string, extra: Record<string, unknown> = {}) => ({ notebook: "lm:demo:plans", path: "Page.md", line, done: false, text, ...extra });

  it("writes the page against the revision it read, with the line ending it had", async () => {
    lmPages.set("Page.md", { text: "# P\r\n- [ ] one 📅 2026-12-01\r\n" });
    const revision = await hash("# P\r\n- [ ] one 📅 2026-12-01\r\n");
    expect(await setTaskDone(lm(2, "one 📅 2026-12-01"), true)).toBe("saved");
    expect(lmWrites).toEqual([{ path: "Page.md", body: "# P\r\n- [x] one 📅 2026-12-01\r\n", expected: revision }]);
  });

  it("refuses a page Living Memory gave only the start of, and writes nothing", async () => {
    lmPages.set("Page.md", { text: "# P\n- [ ] one\n", truncated: true });
    await expect(setTaskDone(lm(2, "one"), true)).rejects.toThrow(/too long for Hivemind to change/);
    expect(lmWrites).toEqual([]);
  });

  it("refuses a line that changed and a revision that moved on", async () => {
    lmPages.set("Page.md", { text: "# P\n- [ ] other\n" });
    await expect(setTaskDone(lm(2, "one"), true)).rejects.toThrow(/no longer there/);
    expect(lmWrites).toEqual([]);
    lmPages.set("Page.md", { text: "# P\n- [ ] one\n" });
    await expect(setTaskDone(lm(2, "one", { sha256: "an older revision" }), true)).rejects.toThrow(/changed since it was read/);
    expect(lmWrites).toEqual([]);
    lmStale = true;
    await expect(setTaskDone(lm(2, "one"), true)).rejects.toThrow(/changed since it was read/);
  });
});

describe("setting a property from a board or a table", () => {
  const PAGE = "---\nstatus: todo # keep\ntags: [a]\n---\n# B\n";

  it("writes the one value against the hash the board showed, and nothing else changes", async () => {
    files.set("B.md", PAGE);
    expect(await setPageProperty({ notebook: "nb-1", path: "B.md", hash: sha(PAGE) }, "status", "done")).toBe("saved");
    expect(files.get("B.md")).toBe("---\nstatus: done # keep\ntags: [a]\n---\n# B\n");
  });

  it("refuses a card whose page changed after the board was drawn", async () => {
    files.set("B.md", PAGE);
    await expect(setPageProperty({ notebook: "nb-1", path: "B.md", hash: "sha-an older page" }, "status", "done")).rejects.toThrow(/changed since it was read/);
    expect(files.get("B.md")).toBe(PAGE);
    expect(saves).toEqual([]);
  });

  it("clears a property (the column for no value) and refuses a page whose properties are not YAML", async () => {
    files.set("B.md", PAGE);
    await clearPageProperty({ notebook: "nb-1", path: "B.md", hash: sha(PAGE) }, "status");
    expect(files.get("B.md")).toBe("---\ntags: [a]\n---\n# B\n");
    const bad = "---\nstatus: [1\n---\n";
    files.set("C.md", bad);
    await expect(setPageProperty({ notebook: "nb-1", path: "C.md", hash: sha(bad) }, "status", "x")).rejects.toThrow(/not valid YAML/);
    expect(files.get("C.md")).toBe(bad);
  });

  it("goes through an open page's session, keeping its unsaved edits", async () => {
    files.set("B.md", PAGE);
    useWorkspace.getState().openTab({ kind: "file", file: ref("B.md") });
    await docs.open(ref("B.md"));
    docs.edit(key("B.md"), `${PAGE}more text\n`);
    expect(await setPageProperty({ notebook: "nb-1", path: "B.md", hash: sha(PAGE) }, "status", "done")).toBe("unsaved");
    expect(state("B.md").text).toBe("---\nstatus: done # keep\ntags: [a]\n---\n# B\nmore text\n");
    expect(files.get("B.md")).toBe(PAGE);
  });

  it("writes a Living Memory page against its revision", async () => {
    lmPages.set("Page.md", { text: PAGE });
    const revision = await hash(PAGE);
    await setPageProperty({ notebook: "lm:demo:plans", path: "Page.md", hash: revision }, "status", "done");
    expect(lmWrites).toEqual([{ path: "Page.md", body: "---\nstatus: done # keep\ntags: [a]\n---\n# B\n", expected: revision }]);
    await expect(setPageProperty({ notebook: "lm:demo:plans", path: "Page.md", hash: "old" }, "status", "x")).rejects.toThrow(/changed since it was read/);
    expect(lmWrites).toHaveLength(1);
  });
});
