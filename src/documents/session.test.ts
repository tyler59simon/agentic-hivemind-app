import { describe, expect, it } from "vitest";
import { initial, isUnsaved, mergeable, reduce, type DocEvent, type DocState, type Loaded } from "./session";

const fmt = { encoding: "UTF-8", bom: false, eol: "lf" as const };
const file = (text: string, sha = `sha-${text}`): Loaded => ({ text, stamp: { sha256: sha, size: text.length, mtimeMs: 1 }, format: fmt, readOnly: null, binary: false });
const run = (...events: DocEvent[]) => events.reduce<DocState>(reduce, initial);

describe("document session", () => {
  it("loads clean, becomes dirty on edit and clean again when the edit is undone", () => {
    let s = run({ type: "loaded", loaded: file("one") });
    expect(s.status).toBe("clean");
    s = reduce(s, { type: "edited", text: "two" });
    expect(s.status).toBe("dirty");
    expect(reduce(s, { type: "edited", text: "one" }).status).toBe("clean");
  });

  it("a save keeps edits typed while it was in flight", () => {
    let s = run({ type: "loaded", loaded: file("one") }, { type: "edited", text: "two" }, { type: "saveStarted" });
    expect(s.status).toBe("saving");
    s = reduce(s, { type: "edited", text: "three" });
    s = reduce(s, { type: "saved", stamp: { sha256: "sha-two", size: 3, mtimeMs: 2 } });
    expect(s.status).toBe("dirty");
    expect(s.base?.text).toBe("two");
    expect(s.base?.stamp.sha256).toBe("sha-two");
    expect(s.text).toBe("three");
  });

  it("an outside change follows a clean editor and only warns a dirty one", () => {
    const clean = run({ type: "loaded", loaded: file("one") });
    const followed = reduce(clean, { type: "outsideChange", theirs: file("theirs") });
    expect(followed).toMatchObject({ status: "clean", text: "theirs", banner: { kind: "followed" } });
    expect(followed.version).toBe(clean.version + 1);

    const dirty = reduce(clean, { type: "edited", text: "mine" });
    const warned = reduce(dirty, { type: "outsideChange", theirs: file("theirs") });
    expect(warned).toMatchObject({ status: "dirty", text: "mine", banner: { kind: "changed" } });
    expect(warned.theirs?.text).toBe("theirs");
    expect(warned.version).toBe(dirty.version);
  });

  it("our own save echoed back by the watcher changes nothing", () => {
    const s = run({ type: "loaded", loaded: file("one") });
    expect(reduce(s, { type: "outsideChange", theirs: file("one") })).toBe(s);
  });

  it("a stale save keeps both sides for the merge, and the merge saves against theirs", () => {
    let s = run({ type: "loaded", loaded: file("base") }, { type: "edited", text: "mine" }, { type: "saveStarted" }, { type: "stale", theirs: file("theirs") });
    expect(s).toMatchObject({ status: "stale", text: "mine", base: { text: "base" }, theirs: { text: "theirs" } });
    s = reduce(s, { type: "merged", text: "merged", theirs: file("theirs") });
    expect(s).toMatchObject({ status: "dirty", text: "merged", base: { text: "theirs" } });
    expect(s.theirs).toBeUndefined();
  });

  it("reloading drops edits", () => {
    const s = run({ type: "loaded", loaded: file("one") }, { type: "edited", text: "mine" }, { type: "reloaded", theirs: file("theirs") });
    expect(s).toMatchObject({ status: "clean", text: "theirs" });
  });

  it("a draft restores as dirty with a banner", () => {
    const s = run({ type: "loaded", loaded: file("disk"), draft: { text: "draft", at: "2026-11-20T10:00:00Z" } });
    expect(s).toMatchObject({ status: "dirty", text: "draft", banner: { kind: "restored" } });
    expect(run({ type: "loaded", loaded: file("same"), draft: { text: "same", at: "x" } }).status).toBe("clean");
  });

  it("Convert to UTF-8 makes a page read-only for its encoding editable and unsaved until written", () => {
    const legacy = { ...file("caf?"), format: { encoding: "windows-1252", bom: false, eol: "crlf" as const }, readOnly: "This file contains bytes that are not valid windows-1252", convertible: true };
    let s = run({ type: "loaded", loaded: legacy }, { type: "convert" });
    expect(s).toMatchObject({ status: "dirty", convert: true, base: { readOnly: null, format: { encoding: "UTF-8", bom: false, eol: "crlf" } } });
    // Unsaved even with the text unchanged: the bytes on disk are still the old encoding.
    expect(reduce(s, { type: "edited", text: "caf?" }).status).toBe("dirty");
    s = reduce(reduce(s, { type: "saveStarted" }), { type: "saved", stamp: { sha256: "utf8", size: 4, mtimeMs: 2 } });
    expect(s.status).toBe("clean");
    expect(s.convert).toBeUndefined();
  });

  it("Convert to UTF-8 does nothing for a binary file, a file read-only for another reason, or a clean page", () => {
    const binary = run({ type: "loaded", loaded: { ...file(""), binary: true, readOnly: "This is not a text file" } });
    expect(reduce(binary, { type: "convert" })).toBe(binary);
    const attribute = run({ type: "loaded", loaded: { ...file("x"), readOnly: "This file is read-only on disk" } });
    expect(reduce(attribute, { type: "convert" })).toBe(attribute);
    const clean = run({ type: "loaded", loaded: file("x") });
    expect(reduce(clean, { type: "convert" })).toBe(clean);
    // An unsaved page whose characters its encoding cannot hold converts.
    const legacy = run({ type: "loaded", loaded: { ...file("x"), format: { encoding: "windows-1252", bom: false, eol: "lf" } } }, { type: "edited", text: "x 中" });
    expect(reduce(legacy, { type: "convert" })).toMatchObject({ status: "dirty", convert: true, base: { format: { encoding: "UTF-8" } } });
  });

  it("a draft written after Convert comes back converted, even with the text unchanged (Codex review of 52051c8, D3)", () => {
    const legacy = { ...file("caf?"), format: { encoding: "windows-1252", bom: false, eol: "lf" as const }, readOnly: "This file contains bytes that are not valid windows-1252", convertible: true };
    const back = run({ type: "loaded", loaded: legacy, draft: { text: "caf?", at: "t" }, convert: true });
    expect(back).toMatchObject({ status: "dirty", convert: true, base: { readOnly: null, format: { encoding: "UTF-8", bom: false } } });
    // Without the convert mark the draft of a read-only file is not restored, and a binary file never converts.
    expect(run({ type: "loaded", loaded: legacy, draft: { text: "caf?", at: "t" } }).status).toBe("readOnly");
    const binary = { ...file(""), binary: true, readOnly: "This is not a text file" };
    expect(run({ type: "loaded", loaded: binary, draft: { text: "x", at: "t" }, convert: true }).status).toBe("readOnly");
  });

  it("a merge into a page being converted keeps it UTF-8 (Codex review of 52051c8, R3)", () => {
    const legacy = (text: string): Loaded => ({ ...file(text), format: { encoding: "windows-1252", bom: false, eol: "lf" }, readOnly: "This file contains bytes that are not valid windows-1252", convertible: true });
    const s = run({ type: "loaded", loaded: legacy("a") }, { type: "convert" }, { type: "edited", text: "a mine" },
      { type: "saveStarted" }, { type: "stale", theirs: legacy("a theirs") }, { type: "merged", text: "a mine theirs", theirs: legacy("a theirs") });
    expect(s).toMatchObject({ status: "dirty", convert: true, base: { readOnly: null, format: { encoding: "UTF-8" }, stamp: { sha256: "sha-a theirs" } } });
    // Even a merge that takes their text as it is still has the conversion to write.
    const same = run({ type: "loaded", loaded: legacy("a") }, { type: "convert" }, { type: "merged", text: "a theirs", theirs: legacy("a theirs") });
    expect(same.status).toBe("dirty");
    // Their version is mergeable for a page being converted only when its encoding is all that stops it.
    expect(mergeable(legacy("x"))).toBe(false);
    expect(mergeable(legacy("x"), true)).toBe(true);
    expect(mergeable({ ...file(""), binary: true, readOnly: "This is not a text file" }, true)).toBe(false);
    expect(mergeable({ ...file("x"), readOnly: "This file is read-only on disk" }, true)).toBe(false);
  });

  it("a draft the file can no longer take is kept beside the read-only page (Codex re-review of fa08348, D3)", () => {
    const locked = { ...file("disk"), readOnly: "This file is read-only on disk" };
    expect(run({ type: "loaded", loaded: locked, draft: { text: "my edits", at: "t" } })).toMatchObject({ status: "readOnly", text: "disk", kept: { text: "my edits", at: "t" } });
    expect(run({ type: "loaded", loaded: locked, draft: { text: "disk", at: "t" } }).kept).toBeUndefined();
  });

  it("following the file never drops a kept draft; a page gone on load keeps one to show (Codex final review of a34fafd, D3b and F2b)", () => {
    const locked = { ...file("disk"), readOnly: "This file is read-only on disk" };
    const s = run({ type: "loaded", loaded: locked, draft: { text: "my edits", at: "t" } });
    expect(reduce(s, { type: "outsideChange", theirs: file("new on disk") })).toBe(s);
    expect(reduce(initial, { type: "failed", error: "gone", kept: { text: "mine", at: "t" } })).toMatchObject({ status: "error", kept: { text: "mine" } });
    expect(reduce(s, { type: "keptDropped" }).kept).toBeUndefined();
  });

  it("read-only files ignore edits", () => {
    const s = run({ type: "loaded", loaded: { ...file("x"), readOnly: "This file is not UTF-8" } });
    expect(s.status).toBe("readOnly");
    expect(reduce(s, { type: "edited", text: "y" })).toBe(s);
  });

  it("a failed save stays dirty with the error, a failed load is an error", () => {
    const s = run({ type: "loaded", loaded: file("one") }, { type: "edited", text: "two" }, { type: "saveStarted" }, { type: "failed", error: "in use" });
    expect(s).toMatchObject({ status: "dirty", error: "in use" });
    expect(run({ type: "failed", error: "missing" })).toMatchObject({ status: "error", error: "missing" });
  });

  it("a deleted file keeps the edits as unsaved", () => {
    const s = run({ type: "loaded", loaded: file("one") }, { type: "gone" });
    expect(s).toMatchObject({ status: "dirty", banner: { kind: "gone" } });
    expect(isUnsaved(s)).toBe(true);
  });
});
