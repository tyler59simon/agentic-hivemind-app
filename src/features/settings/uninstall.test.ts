import { describe, expect, it } from "vitest";
import type { UninstallRepo, UninstallTree } from "../../lib/agent";
import { deletable, treeStep } from "./uninstall";

const tree = (over: Partial<UninstallTree>): UninstallTree => ({
  session: "s", title: "t", status: "ended", repo: "C:/r", branch: "hivemind/aaaaaaaa", path: "C:/w", exists: true, files: 0, review: null, ...over,
});

describe("before you uninstall", () => {
  it("ends a live session first, then sends edits to review, else removes the worktree", () => {
    for (const status of ["running", "waiting", "idle"] as const) expect(treeStep(tree({ status, files: 3 }))).toBe("end");
    expect(treeStep(tree({ files: 2 }))).toBe("review");
    expect(treeStep(tree({ files: 2, review: "dismissed" }))).toBe("review");
    expect(treeStep(tree({ files: null }))).toBe("review");
    expect(treeStep(tree({ files: 0, status: "succeeded" }))).toBe("remove");
    expect(treeStep(tree({ exists: false, files: null }))).toBe("remove");
  });

  it("deletes only merged branches no worktree has checked out", () => {
    const repo: UninstallRepo = { repo: "C:/r", target: "main", error: null, branches: [
      { name: "hivemind/a", merged: true, checkedOut: false, session: null },
      { name: "hivemind/b", merged: false, checkedOut: false, session: null },
      { name: "hivemind/c", merged: true, checkedOut: true, session: "s" },
    ] };
    expect(deletable(repo)).toEqual(["hivemind/a"]);
  });
});
