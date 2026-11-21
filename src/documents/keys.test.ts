import { describe, expect, it } from "vitest";
import { docKey, draftKeyOf, movedPath, sameDoc } from "./keys";

describe("document keys", () => {
  it("notes keep their ref and pages keep letter case (Codex re-review of fa08348, W1)", () => {
    expect(docKey({ kind: "note", ref: "demo:1234" })).toBe("note:demo:1234");
    expect(docKey({ kind: "file", file: { notebook: "nb-1", path: "Projects/A.md" } })).toBe("file:nb-1:Projects/A.md");
    // In a case-sensitive folder these are two files.
    expect(sameDoc({ kind: "file", file: { notebook: "nb-1", path: "a.md" } }, { kind: "file", file: { notebook: "nb-1", path: "A.md" } })).toBe(false);
  });

  it("a page and a note never match, and new notes match nothing", () => {
    expect(sameDoc({ kind: "note", ref: "x" }, { kind: "file", file: { notebook: "x", path: "x" } })).toBe(false);
    expect(sameDoc({ kind: "new-note" }, { kind: "new-note" })).toBe(false);
    expect(sameDoc({ kind: "file", file: { notebook: "nb-1", path: "a.md" } }, { kind: "file", file: { notebook: "nb-2", path: "a.md" } })).toBe(false);
  });

  it("draft keys are the hash Rust computes, and distinct for a_b and a/b", async () => {
    // The same value is asserted in src-tauri/src/drafts.rs (the_file_key_matches_the_webview).
    // From a tab's own key, so the letter case the webview keeps is the one Rust hashes (Codex final review of a34fafd, T4).
    expect(await draftKeyOf(docKey({ kind: "file", file: { notebook: "nb-1", path: "Projects/A.md" } }))).toBe("file-16d2a638270cf6584f1fae6209b8cae20d85327e77e3f1371b6172d17e4f491c");
    expect(await draftKeyOf("file:nb-1:a_b")).not.toBe(await draftKeyOf("file:nb-1:a/b"));
  });

  it("moves carry files and everything inside a moved folder", () => {
    expect(movedPath("Projects/A.md", "Projects/A.md", "Archive/A.md")).toBe("Archive/A.md");
    expect(movedPath("Projects/Sub/B.md", "Projects", "Archive/Projects")).toBe("Archive/Projects/Sub/B.md");
    expect(movedPath("Projects/Sub/B.md", "projects", "Archive/Projects")).toBeNull();
    expect(movedPath("ProjectsOld/B.md", "Projects", "X")).toBeNull();
  });
});
