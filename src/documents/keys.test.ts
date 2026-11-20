import { describe, expect, it } from "vitest";
import { docKey, draftKeyOf, movedPath, sameDoc } from "./keys";

describe("document keys", () => {
  it("notes keep their ref and pages ignore letter case", () => {
    expect(docKey({ kind: "note", ref: "demo:1234" })).toBe("note:demo:1234");
    expect(docKey({ kind: "file", file: { notebook: "nb-1", path: "Projects/A.md" } })).toBe("file:nb-1:projects/a.md");
    expect(sameDoc({ kind: "file", file: { notebook: "nb-1", path: "a.md" } }, { kind: "file", file: { notebook: "nb-1", path: "A.md" } })).toBe(true);
  });

  it("a page and a note never match, and new notes match nothing", () => {
    expect(sameDoc({ kind: "note", ref: "x" }, { kind: "file", file: { notebook: "x", path: "x" } })).toBe(false);
    expect(sameDoc({ kind: "new-note" }, { kind: "new-note" })).toBe(false);
    expect(sameDoc({ kind: "file", file: { notebook: "nb-1", path: "a.md" } }, { kind: "file", file: { notebook: "nb-2", path: "a.md" } })).toBe(false);
  });

  it("draft keys are the hash Rust computes, and distinct for a_b and a/b", async () => {
    // The same value is asserted in src-tauri/src/drafts.rs (the_file_key_matches_the_webview).
    expect(await draftKeyOf("file:nb-1:projects/a.md")).toBe("file-ee426da86755468a9c6ed248410253426f97a9dbb18eee94b3a5e0e10fa30c67");
    expect(await draftKeyOf("file:nb-1:a_b")).not.toBe(await draftKeyOf("file:nb-1:a/b"));
  });

  it("moves carry files and everything inside a moved folder", () => {
    expect(movedPath("Projects/A.md", "Projects/A.md", "Archive/A.md")).toBe("Archive/A.md");
    expect(movedPath("Projects/Sub/B.md", "projects", "Archive/Projects")).toBe("Archive/Projects/Sub/B.md");
    expect(movedPath("ProjectsOld/B.md", "Projects", "X")).toBeNull();
  });
});
