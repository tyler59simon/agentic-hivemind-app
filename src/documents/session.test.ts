import { describe, expect, it } from "vitest";
import { initial, isUnsaved, reduce, type DocEvent, type DocState, type Loaded } from "./session";

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
