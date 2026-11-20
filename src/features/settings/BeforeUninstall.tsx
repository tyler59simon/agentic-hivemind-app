import { useState } from "react";
import { agentCancel, agentEnd, agentSessions, reviewDiscard, uninstallDeleteBranch, uninstallInventory, uninstallRemoveWorktree, type UninstallInventory, type UninstallTree } from "../../lib/agent";
import { Confirm } from "../../ui/Modal";
import { deletable, treeStep, waitStopped } from "./uninstall";

function stateText(tree: UninstallTree): string {
  if (!tree.exists) return "folder already gone";
  switch (treeStep(tree)) {
    case "terminal": case "stop": case "end": return `the session is ${tree.status}`;
    case "review": return tree.files === null ? "git could not read its edits" : tree.files === 1 ? "1 file not approved" : `${tree.files} files not approved`;
    case "remove": return "nothing to approve";
  }
}

/** REG-8, REG-9: what an uninstall would leave in the user's repositories, and the steps to clean it up first. */
export function BeforeUninstall({ onOpenReview, onOpenSession }: { onOpenReview?: (session: string) => void; onOpenSession?: (session: string) => void }) {
  const [found, setFound] = useState<UninstallInventory | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState<UninstallTree | null>(null);

  const run = (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    work()
      .catch((e) => setError(String(e)))
      .then(() => uninstallInventory().then(setFound))
      .catch((e) => setError(String(e)))
      .finally(() => setBusy(false));
  };
  const deleteAll = (repo: string, names: string[]) => run(async () => { for (const name of names) await uninstallDeleteBranch(repo, name); });

  const step = (tree: UninstallTree) => {
    switch (treeStep(tree)) {
      case "terminal": return onOpenSession
        ? <button type="button" disabled={busy} onClick={() => onOpenSession(tree.session)}>Open terminal to stop it</button>
        : <span className="muted small">stop it in its terminal</span>;
      case "stop": return <button type="button" disabled={busy} onClick={() => run(() => agentCancel(tree.session).then(() => waitStopped(tree.session, agentSessions)))}>Stop session</button>;
      case "end": return <button type="button" disabled={busy} onClick={() => run(() => agentEnd(tree.session))}>End session</button>;
      case "review": return <>
        {onOpenReview && <button type="button" disabled={busy} onClick={() => onOpenReview(tree.session)}>Open in Review</button>}
        <button type="button" className="danger-text" disabled={busy} onClick={() => setDiscarding(tree)}>Discard…</button>
      </>;
      case "remove": return <button type="button" disabled={busy} onClick={() => run(() => uninstallRemoveWorktree(tree.session))}>Remove worktree</button>;
    }
  };
  const empty = found && found.trees.length === 0 && found.repos.length === 0;

  return (
    <section className="settings">
      <h3>Before you uninstall</h3>
      <p className="muted small">Uninstalling Hivemind can delete its app data, and with it the session worktrees that hold edits you have not approved. Approved work stays on <code>hivemind/…</code> branches in your repositories. Check here first. Removing a worktree also deletes the files git ignores in it, such as build output.</p>
      <button type="button" disabled={busy} onClick={() => run(async () => {})}>{busy ? "Checking…" : found ? "Check again" : "Check"}</button>
      {error && <p className="error">{error}</p>}
      {empty && <p className="muted small">Nothing to clean up: no session worktrees and no <code>hivemind/…</code> branches.</p>}
      {found && found.trees.length > 0 && <>
        <h4>Session worktrees</h4>
        <ul>
          {found.trees.map((t) => (
            <li key={t.session}>
              <strong>{t.title}</strong> · <code>{t.branch}</code> · {stateText(t)}{" "}
              {step(t)}
            </li>
          ))}
        </ul>
      </>}
      {found && found.repos.map((r) => {
        const merged = deletable(r);
        return (
          <div key={r.repo}>
            <h4><code>{r.repo}</code></h4>
            {r.error && <p className="error">{r.error}</p>}
            {!r.target && !r.error && <p className="muted small">The repository is on a detached commit, so no branch counts as merged.</p>}
            <ul>
              {r.branches.map((b) => (
                <li key={b.name}>
                  <code>{b.name}</code>{" "}
                  {b.checkedOut ? "· in use by a worktree, rebase or bisect" : b.merged === null ? <>· could not compare with {r.target}; see the error above</> : b.merged
                    ? <>· merged into {r.target} <button type="button" disabled={busy} onClick={() => run(() => uninstallDeleteBranch(r.repo, b.name))}>Delete</button></>
                    : <>· has commits not in {r.target ?? "the default branch"}; merge it or delete it yourself</>}
                </li>
              ))}
            </ul>
            {merged.length > 1 && <button type="button" disabled={busy} onClick={() => deleteAll(r.repo, merged)}>Delete all {merged.length} merged</button>}
          </div>
        );
      })}
      {found && !empty && <p className="muted small">After this, also see the Uninstall section of the README: the app data the uninstaller keeps, published skills, and <code>alm maintenance disable</code>.</p>}
      {discarding && (
        <Confirm title="Discard this session's edits?" action="Discard edits" danger
          message={`This resets the worktree of "${discarding.title}" to its review base (the last approved commit, else where it started) and deletes the files the agent created. It cannot be undone.`}
          onAnswer={(yes) => { const tree = discarding; setDiscarding(null); if (yes) run(() => reviewDiscard(tree.session)); }} />
      )}
    </section>
  );
}
