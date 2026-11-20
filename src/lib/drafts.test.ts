import { beforeEach, describe, expect, it, vi } from "vitest";

// Rust's draft store, answering slowly so the cache is what a quick read sees. A write of a value in `failing` fails;
// `delays` sets how long a write of a value takes.
const disk = new Map<string, unknown>();
const failing = new Set<unknown>();
const delays = new Map<unknown, number>();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: { key?: string; value?: unknown }) => {
    await new Promise((r) => setTimeout(r, delays.get(args.value) ?? 5));
    if (cmd === "draft_put" && failing.has(args.value)) throw new Error("The disk is full");
    if (cmd === "draft_put") disk.set(args.key!, args.value);
    else if (cmd === "draft_get") return disk.get(args.key!) ?? null;
    else if (cmd === "draft_delete") disk.delete(args.key!);
    return null;
  }),
}));

const { deleteDraft, getDraft, getFileDraft, putDraft } = await import("./drafts");

const note = (key: string, title: string) => ({ key, ref: key, baseRevision: "r", base: {} as never, mine: { title } as never, savedAt: "t" });
const file = (key: string, mine: string) => ({
  key, kind: "file" as const, target: { notebook: "nb", path: "a.md" }, precondition: { sha256: "s", size: 1, mtimeMs: 1 },
  format: { encoding: "UTF-8", bom: false, eol: "lf" as const }, mine, savedAt: "t",
});

describe("drafts", () => {
  beforeEach(() => disk.clear());

  it("a draft put and read back at once returns the newest value", async () => {
    void putDraft(note("d:1", "old"));
    void putDraft(note("d:1", "new"));
    expect((await getDraft("d:1"))?.mine).toEqual({ title: "new" });
  });

  it("a delete is seen at once, before Rust answers", async () => {
    await putDraft(note("d:2", "x"));
    void deleteDraft("d:2");
    expect(await getDraft("d:2")).toBeNull();
  });

  it("writes of one key reach the disk in the order they were made (Codex review of 52051c8, F1)", async () => {
    const first = file("file-order", "first"), second = file("file-order", "second");
    delays.set(first, 30);
    delays.set(second, 1);
    await Promise.all([putDraft(first), putDraft(second)]);
    expect((disk.get("file-order") as { mine: string }).mine).toBe("second");
  });

  it("after failed writes a read goes to the disk, never to a value that was not kept (Codex review of 52051c8, F1)", async () => {
    disk.set("file-fail", file("file-fail", "kept"));
    const a = file("file-fail", "never kept a"), b = file("file-fail", "never kept b");
    failing.add(a);
    failing.add(b);
    await Promise.allSettled([putDraft(a), putDraft(b)]);
    expect((await getFileDraft("file-fail"))?.mine).toBe("kept");
  });

  it("keeps note and page drafts apart", async () => {
    await putDraft(file("file-abc", "page text"));
    expect(await getDraft("file-abc")).toBeNull();
    expect((await getFileDraft("file-abc"))?.mine).toBe("page text");
    await putDraft(note("d:3", "n"));
    expect(await getFileDraft("d:3")).toBeNull();
  });
});
