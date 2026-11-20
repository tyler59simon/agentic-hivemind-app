//! Before you uninstall (REG-8, REG-9): what Hivemind leaves in the user's repositories. Session worktrees hold edits
//! nobody approved yet, and approved sessions leave `hivemind/<id8>` branches that are never merged for the user.
//! Discarding, ending and removing worktrees reuse the review and agent commands; this module lists, and deletes only
//! `hivemind/*` branches already merged into the repository's default branch.
use crate::agent::events::Status;
use crate::agent::{ReviewState, SessionInfo};
use crate::folders;
use crate::git::run_with_timeout;
use crate::settings::Settings;
use crate::worktree;
use serde::Serialize;
use std::path::Path;
use std::time::Duration;

const TIMEOUT: Duration = Duration::from_secs(10);
const PREFIX: &str = "hivemind/";

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Tree {
    pub session: String,
    pub title: String,
    pub status: Status,
    pub repo: String,
    pub branch: String,
    pub path: String,
    /// False when the folder is gone (removed by hand, or app data deleted).
    pub exists: bool,
    /// Files changed since the review base, read now; None when git could not read the worktree.
    pub files: Option<u64>,
    pub review: Option<ReviewState>,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Branch {
    pub name: String,
    /// Every commit on it is in `Repo::target`.
    pub merged: bool,
    /// A worktree has it checked out, so git would refuse to delete it.
    pub checked_out: bool,
    /// The session that made it, when Hivemind still knows it.
    pub session: Option<String>,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Repo {
    pub repo: String,
    /// What "merged" is measured against: origin's default branch, else the branch the repository is on.
    pub target: Option<String>,
    pub branches: Vec<Branch>,
    pub error: Option<String>,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Inventory {
    pub trees: Vec<Tree>,
    pub repos: Vec<Repo>,
}

fn run(repo: &Path, args: &[&str]) -> Result<String, String> {
    let mut command = worktree::git(repo);
    command.args(args);
    run_with_timeout(command, TIMEOUT)
}

/// The branch "merged" is measured against: `origin/HEAD`'s branch, else the checked-out branch; None on a detached HEAD.
fn target(repo: &Path) -> Option<String> {
    let name = run(repo, &["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"])
        .or_else(|_| run(repo, &["symbolic-ref", "--quiet", "--short", "HEAD"]))
        .ok()?;
    Some(name.trim().to_string()).filter(|n| !n.is_empty())
}

fn merged(repo: &Path, branch: &str, target: &str) -> bool {
    run(repo, &["merge-base", "--is-ancestor", &format!("refs/heads/{branch}"), target]).is_ok()
}

fn checked_out(repo: &Path) -> Result<Vec<String>, String> {
    Ok(worktree::list(repo)?.into_iter().filter_map(|listed| listed.branch).collect())
}

fn branches(repo: &Path, sessions: &[SessionInfo]) -> Repo {
    let spelled = folders::plain(repo);
    let target = target(repo);
    let listed = run(repo, &["for-each-ref", "--format=%(refname:short)", &format!("refs/heads/{PREFIX}")])
        .and_then(|text| Ok((text, checked_out(repo)?)));
    let (text, out) = match listed {
        Ok(found) => found,
        Err(error) => return Repo { repo: spelled, target, branches: vec![], error: Some(error) },
    };
    let branches = text
        .lines()
        .map(str::trim)
        .filter(|name| name.starts_with(PREFIX))
        .map(|name| Branch {
            name: name.to_string(),
            merged: target.as_deref().is_some_and(|t| merged(repo, name, t)),
            checked_out: out.iter().any(|b| b == name),
            session: sessions
                .iter()
                .find(|s| s.worktree.as_ref().is_some_and(|t| t.branch == name && folders::same(&t.repo, &spelled)))
                .map(|s| s.id.clone()),
        })
        .collect();
    Repo { repo: spelled, target, branches, error: None }
}

/// The repository a folder belongs to, as git spells its top level; None when it is not in one.
fn toplevel(folder: &str) -> Option<String> {
    let path = Path::new(folder);
    if !path.is_dir() {
        return None;
    }
    let top = run(path, &["rev-parse", "--show-toplevel"]).ok()?;
    Some(top.trim().to_string()).filter(|t| !t.is_empty())
}

pub fn inventory(sessions: &[SessionInfo], saved: &Settings) -> Inventory {
    let trees = sessions
        .iter()
        .filter_map(|info| {
            let tree = info.worktree.as_ref()?;
            let exists = Path::new(&tree.path).is_dir();
            Some(Tree {
                session: info.id.clone(),
                title: info.name.clone().unwrap_or_else(|| info.title.clone()),
                status: info.status,
                repo: tree.repo.clone(),
                branch: tree.branch.clone(),
                path: tree.path.clone(),
                exists,
                files: exists.then(|| worktree::changes(tree).ok().map(|f| f.len() as u64)).flatten(),
                review: info.review.as_ref().map(|r| r.state),
            })
        })
        .collect();
    let candidates = sessions
        .iter()
        .flat_map(|info| info.worktree.iter().map(|t| t.repo.clone()).chain(info.workspace.iter().cloned()))
        .chain(saved.other_folders.iter().flatten().cloned());
    let mut repos: Vec<String> = Vec::new();
    for top in candidates.filter_map(|folder| toplevel(&folder)) {
        if !repos.iter().any(|r| folders::same(r, &top)) {
            repos.push(top);
        }
    }
    let repos = repos.iter().map(|r| branches(Path::new(r), sessions)).filter(|r| r.error.is_some() || !r.branches.is_empty()).collect();
    Inventory { trees, repos }
}

/// Delete one `hivemind/*` branch, only when every commit on it is already in the default branch and no worktree has it out.
/// Checked here again, not taken from the list the user saw.
pub fn delete_branch(repo: &Path, branch: &str) -> Result<(), String> {
    if !branch.starts_with(PREFIX) || branch.len() == PREFIX.len() {
        return Err(format!("Only {PREFIX}* branches are deleted here"));
    }
    if worktree::branch_tip(repo, branch).is_none() {
        return Err(format!("No branch {branch} in {}", repo.display()));
    }
    if checked_out(repo)?.iter().any(|b| b == branch) {
        return Err(format!("{branch} is checked out in a worktree; remove the worktree first"));
    }
    let Some(target) = target(repo) else {
        return Err("The repository is on a detached commit, so there is no default branch to compare with".into());
    };
    if !merged(repo, branch, &target) {
        return Err(format!("{branch} has commits that are not in {target}; it was left alone"));
    }
    run(repo, &["branch", "-D", branch]).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::process::Command;
    use std::sync::atomic::{AtomicU32, Ordering};

    fn git_available() -> bool {
        Command::new("git").arg("--version").output().map(|o| o.status.success()).unwrap_or(false)
    }

    fn sh(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git").arg("-C").arg(dir).args(args).output().unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    /// A repository on `main` with one commit, plus a worktrees folder; deleted when dropped.
    struct Rig {
        root: PathBuf,
        repo: PathBuf,
        worktrees: PathBuf,
    }

    impl Rig {
        fn new() -> Rig {
            static COUNTER: AtomicU32 = AtomicU32::new(0);
            let root = std::env::temp_dir().join(format!("hivemind-uninstall-{}-{}", std::process::id(), COUNTER.fetch_add(1, Ordering::SeqCst)));
            let repo = root.join("repo");
            std::fs::create_dir_all(&repo).unwrap();
            sh(&repo, &["init", "-q"]);
            sh(&repo, &["symbolic-ref", "HEAD", "refs/heads/main"]);
            sh(&repo, &["config", "user.name", "Tester"]);
            sh(&repo, &["config", "user.email", "t@example.com"]);
            sh(&repo, &["config", "commit.gpgsign", "false"]);
            std::fs::write(repo.join("a.txt"), "one\n").unwrap();
            sh(&repo, &["add", "."]);
            sh(&repo, &["commit", "-q", "-m", "first"]);
            Rig { worktrees: root.join("worktrees"), repo, root }
        }

        /// A session worktree whose branch has one commit.
        fn committed(&self, id: &str) -> worktree::Worktree {
            let tree = worktree::create(&self.worktrees, &self.repo, None, id).unwrap();
            std::fs::write(Path::new(&tree.path).join(format!("{id}.txt")), "work\n").unwrap();
            sh(Path::new(&tree.path), &["add", "-A"]);
            sh(Path::new(&tree.path), &["commit", "-q", "-m", id]);
            tree
        }
    }

    impl Drop for Rig {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.root).ok();
        }
    }

    fn info(id: &str, tree: Option<&worktree::Worktree>, status: &str) -> SessionInfo {
        serde_json::from_value(serde_json::json!({
            "id": id, "adapter": "claude-code", "cliVersion": null, "task": {"kind": "work", "project": "p", "repo": "r"}, "title": "t", "workspace": [],
            "status": status, "startedAt": 0, "endedAt": null, "costUsd": null, "error": null, "structured": null, "mode": "interactive", "policy": "ask",
            "project": "p", "worktree": tree, "turns": 0, "filesChanged": null, "context": [], "model": null
        }))
        .unwrap()
    }

    #[test]
    fn inventory_lists_unapproved_edits_and_merged_and_unmerged_branches() {
        if !git_available() {
            return;
        }
        let rig = Rig::new();
        // Approved and merged: the session's worktree is gone, its branch stays.
        let merged = rig.committed("aaaaaaaa");
        sh(&rig.repo, &["merge", "-q", "--ff-only", &merged.branch]);
        worktree::remove(&merged).unwrap();
        // Approved, not merged, worktree gone.
        let kept = rig.committed("bbbbbbbb");
        worktree::remove(&kept).unwrap();
        // A session with an edit nobody approved.
        let open = worktree::create(&rig.worktrees, &rig.repo, None, "cccccccc").unwrap();
        std::fs::write(Path::new(&open.path).join("a.txt"), "changed\n").unwrap();

        let sessions = [info("cccccccc-1", Some(&open), "ended")];
        let saved = Settings { other_folders: Some(vec![rig.repo.display().to_string()]), ..Default::default() };
        let found = inventory(&sessions, &saved);

        assert_eq!(found.trees.len(), 1);
        let tree = &found.trees[0];
        assert_eq!((tree.session.as_str(), tree.branch.as_str(), tree.exists, tree.files), ("cccccccc-1", "hivemind/cccccccc", true, Some(1)));
        assert_eq!(found.repos.len(), 1, "the saved folder and the worktree's repository are one repository");
        let repo = &found.repos[0];
        assert_eq!(repo.target.as_deref(), Some("main"));
        let row = |name: &str| repo.branches.iter().find(|b| b.name == name).map(|b| (b.merged, b.checked_out, b.session.clone()));
        assert_eq!(row("hivemind/aaaaaaaa"), Some((true, false, None)));
        assert_eq!(row("hivemind/bbbbbbbb"), Some((false, false, None)));
        assert_eq!(row("hivemind/cccccccc"), Some((true, true, Some("cccccccc-1".into()))), "no commits yet, so merged, but checked out");
    }

    #[test]
    fn only_merged_hivemind_branches_that_no_worktree_uses_are_deleted() {
        if !git_available() {
            return;
        }
        let rig = Rig::new();
        let merged = rig.committed("aaaaaaaa");
        sh(&rig.repo, &["merge", "-q", "--ff-only", &merged.branch]);
        worktree::remove(&merged).unwrap();
        let kept = rig.committed("bbbbbbbb");
        worktree::remove(&kept).unwrap();
        let busy = worktree::create(&rig.worktrees, &rig.repo, None, "cccccccc").unwrap();
        sh(&rig.repo, &["branch", "feature/x"]);

        assert!(delete_branch(&rig.repo, "feature/x").unwrap_err().starts_with("Only hivemind/*"));
        assert!(delete_branch(&rig.repo, "hivemind/").unwrap_err().starts_with("Only hivemind/*"));
        assert!(delete_branch(&rig.repo, "hivemind/nothere").unwrap_err().starts_with("No branch"));
        assert!(delete_branch(&rig.repo, "hivemind/bbbbbbbb").unwrap_err().contains("not in main"));
        assert!(delete_branch(&rig.repo, "hivemind/cccccccc").unwrap_err().contains("checked out"));
        assert_eq!(delete_branch(&rig.repo, "hivemind/aaaaaaaa"), Ok(()));
        let left = sh(&rig.repo, &["branch", "--list", "hivemind/*"]);
        assert!(!left.contains("aaaaaaaa") && left.contains("bbbbbbbb") && left.contains("cccccccc"), "{left}");

        // The worktree removal the uninstall check offers leaves nothing in .git/worktrees.
        worktree::remove(&busy).unwrap();
        let admin = rig.repo.join(".git").join("worktrees");
        assert!(!admin.exists() || std::fs::read_dir(&admin).unwrap().next().is_none());
    }
}
