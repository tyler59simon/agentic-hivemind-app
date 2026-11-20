import type { UninstallRepo, UninstallTree } from "../../lib/agent";

/** What a worktree needs before it can go: end its session, review its edits, or nothing more than removing it. */
export type TreeStep = "end" | "review" | "remove";

export function treeStep(tree: UninstallTree): TreeStep {
  if (tree.status === "running" || tree.status === "waiting" || tree.status === "idle") return "end";
  // A worktree git cannot read may still hold edits: send the user to Review rather than offer removal.
  if (tree.exists && (tree.files === null || tree.files > 0)) return "review";
  return "remove";
}

/** The branches "Delete all merged" removes in a repository. */
export function deletable(repo: UninstallRepo): string[] {
  return repo.branches.filter((b) => b.merged && !b.checkedOut).map((b) => b.name);
}
