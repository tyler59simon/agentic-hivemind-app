// NS-6A: reopening a file in another encoding, and choosing the encoding and line endings the next save writes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface Disk { text: string; format: { encoding: string; bom: boolean; eol: string; confidence?: string }; readOnly?: string; chooseEol?: boolean; convertible?: boolean; binary?: boolean }
const disk = new Map<string, Disk>();
/** What `file_reopen` gives for a file and an encoding. */
const reopened = new Map<string, Record<string, Disk>>();
const drafts = new Map<string, unknown>();
const calls: { cmd: string; args: Record<string, unknown> }[] = [];
const sha = (d: Disk) => `sha-${d.text}-${d.format.encoding}-${d.format.eol}`;
const loadedOf = (d: Disk) => ({ text: d.text, sha256: sha(d), size: d.text.length, mtimeMs: 1, format: d.format, readOnly: d.readOnly ?? null, binary: !!d.binary, convertible: !!d.convertible, chooseEol: !!d.chooseEol });

let gate: Promise<void> | null = null;
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, a: Record<string, unknown>) => {
    calls.push({ cmd, args: a });
    const path = a.path as string;
    switch (cmd) {
      case "file_read": return loadedOf(disk.get(path)!);
      case "file_reopen": {
        await gate;
        const found = reopened.get(path)?.[a.encoding as string];
        if (!found) throw new Error(`cannot reopen as ${a.encoding}`);
        return loadedOf(found);
      }
      case "file_save": {
        const now = disk.get(path)!;
        if (sha(now) !== (a.pre as { sha256: string }).sha256) return { status: "stale", sha256: sha(now) };
        // Rust refuses a file that is read-only for Hivemind unless the save is a conversion.
        if (now.readOnly && !a.convert) throw new Error(`The file on disk changed to something Hivemind cannot save over (${now.readOnly})`);
        const next: Disk = { text: a.text as string, format: a.format as Disk["format"] };
        disk.set(path, next);
        return { status: "saved", sha256: sha(next), size: 1, mtimeMs: 2 };
      }
      case "draft_put": drafts.set(a.key as string, a.value); return null;
      case "draft_get": return drafts.get(a.key as string) ?? null;
      case "draft_delete": drafts.delete(a.key as string); return null;
    }
    return null;
  }),
}));

const store = await import("./store");
const { useDocuments, keyOf } = store;

const ref = (path: string) => ({ notebook: "nb-1", path });
const doc = (path: string) => useDocuments.getState().docs[keyOf(ref(path))];
const utf8 = { encoding: "UTF-8", bom: false, eol: "lf", confidence: "valid" };
const latin = { encoding: "windows-1252", bom: false, eol: "crlf", confidence: "guess" };

beforeEach(() => {
  disk.clear(); reopened.clear(); drafts.clear(); calls.length = 0; gate = null;
  useDocuments.setState({ docs: {}, refs: {}, held: [] });
});
afterEach(() => { vi.restoreAllMocks(); });

/** The sent `file_save` commands. */
const saves = () => calls.filter((c) => c.cmd === "file_save").map((c) => c.args);

describe("reopening with an encoding", () => {
  it("reads the file again as the chosen encoding and keeps the page clean", async () => {
    disk.set("a.txt", { text: "café", format: latin });
    reopened.set("a.txt", { "windows-1251": { text: "cafй", format: { ...latin, encoding: "windows-1251", confidence: "valid" } } });
    await store.open(ref("a.txt"));
    expect(await store.reopenAs(keyOf(ref("a.txt")), "windows-1251")).toBe(true);
    expect(doc("a.txt")).toMatchObject({ status: "clean", text: "cafй", base: { format: { encoding: "windows-1251" } } });
    expect(calls.filter((c) => c.cmd === "file_reopen")).toEqual([{ cmd: "file_reopen", args: { notebook: "nb-1", path: "a.txt", encoding: "windows-1251" } }]);
    // The version counter moved, so the editor shows the new text.
    expect(doc("a.txt").version).toBeGreaterThan(1);
  });

  it("is refused while the page has unsaved edits, and reads nothing", async () => {
    disk.set("a.txt", { text: "one", format: latin });
    await store.open(ref("a.txt"));
    store.edit(keyOf(ref("a.txt")), "one!");
    await expect(store.reopenAs(keyOf(ref("a.txt")), "UTF-8")).rejects.toThrow(/Save or discard/);
    expect(calls.some((c) => c.cmd === "file_reopen")).toBe(false);
    expect(doc("a.txt").text).toBe("one!");
  });

  it("is refused while an encoding or line ending is waiting to be saved", async () => {
    disk.set("a.txt", { text: "one", format: utf8 });
    await store.open(ref("a.txt"));
    store.reformat(keyOf(ref("a.txt")), { eol: "crlf" });
    await expect(store.reopenAs(keyOf(ref("a.txt")), "windows-1252")).rejects.toThrow(/Save or discard/);
  });

  it("makes a read-only file editable when the chosen encoding decodes it", async () => {
    disk.set("a.txt", { text: "", format: { ...latin, encoding: "UTF-8", eol: "lf" }, readOnly: "This file contains bytes that are not valid UTF-8", convertible: true });
    reopened.set("a.txt", { "windows-1252": { text: "café", format: { ...latin, confidence: "valid" } } });
    await store.open(ref("a.txt"));
    expect(doc("a.txt").status).toBe("readOnly");
    expect(await store.reopenAs(keyOf(ref("a.txt")), "windows-1252")).toBe(true);
    expect(doc("a.txt")).toMatchObject({ status: "clean", text: "café" });
  });

  it("stops when the user types while the file is read", async () => {
    disk.set("a.txt", { text: "one", format: latin });
    reopened.set("a.txt", { "windows-1251": { text: "uno", format: { ...latin, encoding: "windows-1251" } } });
    await store.open(ref("a.txt"));
    let open = () => {};
    gate = new Promise<void>((resolve) => { open = resolve; });
    const pending = store.reopenAs(keyOf(ref("a.txt")), "windows-1251");
    store.edit(keyOf(ref("a.txt")), "one typed");
    open();
    expect(await pending).toBe(false);
    expect(doc("a.txt")).toMatchObject({ text: "one typed", status: "dirty" });
  });

  it("reports a refusal from Rust and leaves the page alone", async () => {
    disk.set("a.txt", { text: "one", format: utf8 });
    await store.open(ref("a.txt"));
    await expect(store.reopenAs(keyOf(ref("a.txt")), "windows-1252")).rejects.toThrow(/cannot reopen/);
    expect(doc("a.txt")).toMatchObject({ status: "clean", text: "one" });
  });

  it("is not offered for a Living Memory page", async () => {
    const lm = { notebook: "lm:demo:plans", path: "P.md" };
    useDocuments.setState({ docs: { [keyOf(lm)]: { status: "clean", base: null, text: "", version: 1 } }, refs: { [keyOf(lm)]: lm } });
    expect(await store.reopenAs(keyOf(lm), "windows-1252")).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe("choosing an encoding or line ending for the next save", () => {
  it("makes the page unsaved, saves in the chosen format, and is clean afterwards", async () => {
    disk.set("a.txt", { text: "one\ntwo\n", format: latin });
    await store.open(ref("a.txt"));
    const key = keyOf(ref("a.txt"));
    store.reformat(key, { encoding: "UTF-8", bom: true });
    expect(doc("a.txt")).toMatchObject({ status: "dirty", text: "one\ntwo\n", reformat: { from: latin }, base: { format: { encoding: "UTF-8", bom: true, eol: "crlf" } } });
    store.reformat(key, { eol: "lf" });
    expect(doc("a.txt").base!.format).toMatchObject({ encoding: "UTF-8", bom: true, eol: "lf" });
    expect((await store.save(key))?.status).toBe("clean");
    expect(saves()[0]).toMatchObject({ format: { encoding: "UTF-8", bom: true, eol: "lf" }, text: "one\ntwo\n" });
    expect(disk.get("a.txt")!.format).toMatchObject({ encoding: "UTF-8", bom: true, eol: "lf" });
    expect(doc("a.txt").reformat).toBeUndefined();
  });

  it("goes back to clean when the old setting is chosen again", async () => {
    disk.set("a.txt", { text: "one", format: utf8 });
    await store.open(ref("a.txt"));
    const key = keyOf(ref("a.txt"));
    store.reformat(key, { eol: "crlf" });
    expect(doc("a.txt").status).toBe("dirty");
    store.reformat(key, { eol: "lf" });
    expect(doc("a.txt")).toMatchObject({ status: "clean", reformat: undefined, base: { format: utf8 } });
  });

  it("keeps an edited page unsaved when the old setting comes back", async () => {
    disk.set("a.txt", { text: "one", format: utf8 });
    await store.open(ref("a.txt"));
    const key = keyOf(ref("a.txt"));
    store.reformat(key, { eol: "crlf" });
    store.edit(key, "one!");
    store.reformat(key, { eol: "lf" });
    expect(doc("a.txt").status).toBe("dirty");
  });

  it("stays unsaved when the text is typed back to what the file holds, because the format still differs", async () => {
    disk.set("a.txt", { text: "one", format: utf8 });
    await store.open(ref("a.txt"));
    const key = keyOf(ref("a.txt"));
    store.reformat(key, { eol: "crlf" });
    store.edit(key, "one!");
    store.edit(key, "one");
    expect(doc("a.txt").status).toBe("dirty");
  });

  it("a change that changes nothing is ignored", async () => {
    disk.set("a.txt", { text: "one", format: utf8 });
    await store.open(ref("a.txt"));
    store.reformat(keyOf(ref("a.txt")), { eol: "lf", encoding: "UTF-8", bom: false });
    expect(doc("a.txt").status).toBe("clean");
  });

  it("is not taken by a page that is saving, loading or read-only for another reason", async () => {
    disk.set("a.txt", { text: "one", format: utf8, readOnly: "This file is read-only on disk" });
    await store.open(ref("a.txt"));
    store.reformat(keyOf(ref("a.txt")), { eol: "crlf" });
    expect(doc("a.txt").status).toBe("readOnly");
  });

  it("keeps what was chosen in a draft and brings it back with the text", async () => {
    disk.set("a.txt", { text: "one\n", format: latin });
    await store.open(ref("a.txt"));
    const key = keyOf(ref("a.txt"));
    store.reformat(key, { encoding: "UTF-8", bom: false });
    store.edit(key, "one\ntwo\n");
    await store.flushDraft(key);
    const [draft] = [...drafts.values()] as { reformat: { encoding: string; eol: string } }[];
    expect(draft.reformat).toMatchObject({ encoding: "UTF-8", eol: "crlf" });
    // The tab closes and the page opens again: the text and the chosen format come back together.
    store.release(key);
    await store.open(ref("a.txt"));
    expect(doc("a.txt")).toMatchObject({ status: "dirty", text: "one\ntwo\n", reformat: { from: latin }, base: { format: { encoding: "UTF-8", eol: "crlf" } } });
    expect((await store.save(key))?.status).toBe("clean");
    expect(disk.get("a.txt")!.format.encoding).toBe("UTF-8");
  });
});

describe("a file that mixes line endings", () => {
  const mixed = (): Disk => ({ text: "one\ntwo\nthree\n", format: { encoding: "UTF-8", bom: false, eol: "mixed", confidence: "valid" }, readOnly: "This file mixes line-ending styles", chooseEol: true });

  it("opens read-only, and choosing a line ending makes it editable and unsaved", async () => {
    disk.set("m.txt", mixed());
    await store.open(ref("m.txt"));
    const key = keyOf(ref("m.txt"));
    expect(doc("m.txt")).toMatchObject({ status: "readOnly", base: { chooseEol: true } });
    store.edit(key, "typed");
    expect(doc("m.txt").text).toBe("one\ntwo\nthree\n");
    store.reformat(key, { eol: "crlf" });
    expect(doc("m.txt")).toMatchObject({ status: "dirty", text: "one\ntwo\nthree\n", base: { readOnly: null, chooseEol: false, format: { eol: "crlf" } }, reformat: { from: { eol: "mixed" } } });
    store.edit(key, "one\ntwo\nthree\nfour\n");
    expect(doc("m.txt").status).toBe("dirty");
  });

  it("saves with the chosen line ending, as a conversion the file's own check allows, and is clean afterwards", async () => {
    disk.set("m.txt", mixed());
    await store.open(ref("m.txt"));
    const key = keyOf(ref("m.txt"));
    store.reformat(key, { eol: "lf" });
    expect((await store.save(key))?.status).toBe("clean");
    expect(saves()[0]).toMatchObject({ convert: true, format: { eol: "lf" }, text: "one\ntwo\nthree\n" });
    expect(disk.get("m.txt")!.format.eol).toBe("lf");
    expect(doc("m.txt")).toMatchObject({ status: "clean", reformat: undefined });
  });

  it("a mixed file that also has bad bytes stays read-only", async () => {
    disk.set("m.txt", { ...mixed(), chooseEol: false, readOnly: "This file contains bytes that are not valid UTF-8" });
    await store.open(ref("m.txt"));
    store.reformat(keyOf(ref("m.txt")), { eol: "lf" });
    expect(doc("m.txt").status).toBe("readOnly");
  });

  it("brings the chosen line ending back with a draft", async () => {
    disk.set("m.txt", mixed());
    await store.open(ref("m.txt"));
    const key = keyOf(ref("m.txt"));
    store.reformat(key, { eol: "crlf" });
    store.edit(key, "one\ntwo\nthree\nmore\n");
    await store.flushDraft(key);
    store.release(key);
    await store.open(ref("m.txt"));
    expect(doc("m.txt")).toMatchObject({ status: "dirty", text: "one\ntwo\nthree\nmore\n", base: { format: { eol: "crlf" }, readOnly: null } });
    expect((await store.save(key))?.status).toBe("clean");
  });
});
