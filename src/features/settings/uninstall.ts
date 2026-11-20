import type { UninstallRepo, UninstallTree } from "../../lib/agent";

/** What a worktree needs before it can go: stop its session (a terminal session in its terminal, a background one with
 * Stop, a chat with End), review its edits, or nothing more than removing it. */
export type TreeStep = "terminal" | "stop" | "end" | "review" | "remove";

export function treeStep(tree: UninstallTree): TreeStep {
  if (tree.status === "running" || tree.status === "waiting" || tree.status === "idle") {
    if (tree.interface === "terminal") return "terminal";
    return tree.mode === "interactive" ? "end" : "stop";
  }
  // A worktree git cannot read may still hold edits: send the user to Review rather than offer removal.
  if (tree.exists && (tree.files === null || tree.files > 0)) return "review";
  return "remove";
}

/** Wait until a session that was asked to stop has stopped (at most `ms`), so the next check sees its final status. */
export async function waitStopped(session: string, list: () => Promise<{ id: string; status: string }[]>, ms = 5000, step = 250): Promise<void> {
  for (let waited = 0; waited < ms; waited += step) {
    const info = (await list()).find((s) => s.id === session);
    if (!info || !["running", "waiting", "idle"].includes(info.status)) return;
    await new Promise((done) => setTimeout(done, step));
  }
}

/** The branches "Delete all merged" removes in a repository. */
export function deletable(repo: UninstallRepo): string[] {
  return repo.branches.filter((b) => b.merged === true && !b.checkedOut).map((b) => b.name);
}
