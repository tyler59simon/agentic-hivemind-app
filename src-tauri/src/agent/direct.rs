//! A session that works in a folder of the user's own, not in a worktree of Hivemind's. The start snapshot records what
//! the folder held, so a later review can tell what the session changed. Everything here only reads the folder: the
//! user's own index is copied, never written.
use crate::git::run_with_timeout;
use crate::worktree;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// `git add -A` hashes every changed file of a large repository, so it gets longer than a status call.
const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(120);
const QUICK: Duration = Duration::from_secs(10);

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Direct {
    /// The folder the session runs in.
    pub path: String,
    /// The git work tree the folder is in; None when it is not in one.
    #[serde(default)]
    pub repo: Option<String>,
    /// HEAD when the session started; None on an unborn branch or outside git.
    #[serde(default)]
    pub head_sha: Option<String>,
    /// A tree holding every file of the folder (tracked and untracked, not ignored) when the session started.
    #[serde(default)]
    pub start_tree: Option<String>,
}

fn git_text(dir: &Path, args: &[&str], timeout: Duration) -> Result<String, String> {
    let mut command = worktree::git(dir);
    command.args(args);
    run_with_timeout(command, timeout).map(|text| text.trim().to_string())
}

/// What `dir` is: its git work tree and the start snapshot. A folder git cannot read, or a snapshot that fails, leaves
/// the matching fields None; the session starts anyway.
pub fn describe(dir: &Path) -> Direct {
    let path = dir.display().to_string();
    let repo = git_text(dir, &["rev-parse", "--show-toplevel"], QUICK).ok().filter(|top| !top.is_empty());
    if repo.is_none() {
        return Direct { path, repo: None, head_sha: None, start_tree: None };
    }
    let head_sha = crate::git::head_sha(dir).ok();
    Direct { path, repo, head_sha, start_tree: snapshot(dir).ok() }
}

/// Deletes the temporary index when it goes out of scope.
struct TempIndex(PathBuf);

impl Drop for TempIndex {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
        let mut lock = self.0.clone().into_os_string();
        lock.push(".lock");
        let _ = std::fs::remove_file(lock);
    }
}

/// The tree of everything in `dir`'s work tree now. Works on a copy of the index, so the user's own index is not touched.
pub fn snapshot(dir: &Path) -> Result<String, String> {
    let index = PathBuf::from(git_text(dir, &["rev-parse", "--git-path", "index"], QUICK)?);
    let index = if index.is_absolute() { index } else { dir.join(index) };
    let temp = TempIndex(std::env::temp_dir().join(format!("hivemind-index-{}", uuid::Uuid::new_v4())));
    // A repository with no index file yet starts from an empty one.
    if index.is_file() {
        std::fs::copy(&index, &temp.0).map_err(|e| format!("Could not copy the index: {e}"))?;
    }
    let run = |args: &[&str], timeout| {
        let mut command = worktree::git(dir);
        command.args(args).env("GIT_INDEX_FILE", &temp.0);
        run_with_timeout(command, timeout).map(|text| text.trim().to_string())
    };
    run(&["add", "-A"], SNAPSHOT_TIMEOUT)?;
    let tree = run(&["write-tree"], QUICK)?;
    if crate::git::is_sha(&tree) { Ok(tree) } else { Err("git did not print a tree id".into()) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn git_available() -> bool {
        Command::new("git").arg("--version").output().is_ok_and(|out| out.status.success())
    }

    fn sh(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git").arg("-C").arg(dir).args(args).output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    fn repo(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hivemind-direct-{name}-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        sh(&dir, &["init", "-q"]);
        sh(&dir, &["symbolic-ref", "HEAD", "refs/heads/main"]);
        sh(&dir, &["config", "user.name", "Tester"]);
        sh(&dir, &["config", "user.email", "t@example.com"]);
        sh(&dir, &["config", "commit.gpgsign", "false"]);
        dir
    }

    #[test]
    fn the_snapshot_holds_untracked_files_and_leaves_the_index_alone() {
        if !git_available() {
            return;
        }
        let dir = repo("snapshot");
        std::fs::write(dir.join("a.txt"), "one\n").unwrap();
        sh(&dir, &["add", "."]);
        sh(&dir, &["commit", "-q", "-m", "first"]);
        std::fs::write(dir.join("a.txt"), "two\n").unwrap();
        std::fs::write(dir.join("new.txt"), "fresh\n").unwrap();
        std::fs::write(dir.join(".gitignore"), "skip.log\n").unwrap();
        std::fs::write(dir.join("skip.log"), "x\n").unwrap();
        std::fs::write(dir.join("staged.txt"), "s\n").unwrap();
        sh(&dir, &["add", "staged.txt"]);
        sh(&dir, &["status", "--porcelain"]); // lets git refresh its own index before the comparison

        let index = dir.join(".git").join("index");
        let (bytes, status) = (std::fs::read(&index).unwrap(), sh(&dir, &["status", "--porcelain"]));
        let info = describe(&dir);
        assert_eq!(std::fs::read(&index).unwrap(), bytes, "the real index is byte for byte the same");
        assert_eq!(sh(&dir, &["status", "--porcelain"]), status);

        assert_eq!(info.path, dir.display().to_string());
        assert_eq!(info.head_sha.as_deref(), Some(sh(&dir, &["rev-parse", "HEAD"]).trim()));
        let tree = info.start_tree.expect("a tree");
        let files = sh(&dir, &["ls-tree", "-r", "--name-only", &tree]);
        assert!(files.lines().any(|f| f == "new.txt"), "{files}");
        assert!(files.lines().any(|f| f == "staged.txt") && files.lines().any(|f| f == "a.txt"), "{files}");
        assert!(!files.lines().any(|f| f == "skip.log"), "ignored files are left out: {files}");
        assert_eq!(sh(&dir, &["show", &format!("{tree}:a.txt")]), "two\n");
        assert!(info.repo.is_some());
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn an_unborn_branch_has_a_tree_and_no_head() {
        if !git_available() {
            return;
        }
        let dir = repo("unborn");
        std::fs::write(dir.join("a.txt"), "one\n").unwrap();
        let info = describe(&dir);
        assert_eq!(info.head_sha, None);
        assert!(info.start_tree.is_some());
        assert!(!dir.join(".git").join("index").exists(), "no index was created");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn a_linked_worktree_uses_its_own_index() {
        if !git_available() {
            return;
        }
        let dir = repo("linked");
        std::fs::write(dir.join("a.txt"), "one\n").unwrap();
        sh(&dir, &["add", "."]);
        sh(&dir, &["commit", "-q", "-m", "first"]);
        let linked = dir.with_extension("linked");
        sh(&dir, &["worktree", "add", "-q", "-b", "other", &linked.display().to_string()]);
        std::fs::write(linked.join("b.txt"), "b\n").unwrap();
        let tree = describe(&linked).start_tree.expect("a tree");
        assert!(sh(&dir, &["ls-tree", "-r", "--name-only", &tree]).lines().any(|f| f == "b.txt"));
        std::fs::remove_dir_all(&linked).ok();
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn a_folder_outside_git_has_no_snapshot() {
        let dir = std::env::temp_dir().join(format!("hivemind-direct-plain-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        // The temp folder could itself sit inside a repository on an odd machine; the test needs a clean one.
        if git_text(&dir, &["rev-parse", "--show-toplevel"], QUICK).is_ok() {
            std::fs::remove_dir_all(dir).ok();
            return;
        }
        let info = describe(&dir);
        assert_eq!((info.repo, info.head_sha, info.start_tree), (None, None, None));
        assert_eq!(info.path, dir.display().to_string());
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn direct_json_is_camel_case() {
        let direct = Direct { path: "C:/n".into(), repo: None, head_sha: Some("a".into()), start_tree: None };
        let json = serde_json::to_value(&direct).unwrap();
        assert_eq!(json, serde_json::json!({"path": "C:/n", "repo": null, "headSha": "a", "startTree": null}));
        assert_eq!(serde_json::from_value::<Direct>(serde_json::json!({"path": "C:/n"})).unwrap().head_sha, None);
    }
}
