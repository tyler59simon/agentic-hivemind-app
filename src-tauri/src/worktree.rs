//! The git worktree an interactive session works in: create it on its own branch, read what changed in it, remove it.
use crate::git::run_with_timeout;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

const TIMEOUT: Duration = Duration::from_secs(10);
const CREATE_TIMEOUT: Duration = Duration::from_secs(120); // a checkout of a large repository
pub const MAX_FILES: usize = 200;
pub const PATCH_LIMIT: usize = 16_000; // same cap as Living Memory's plan diffs
const MAX_COUNTED: u64 = 1024 * 1024; // untracked files larger than this are not line-counted

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    /// The repository the worktree belongs to, as the registry spells it.
    pub repo: String,
    pub path: String,
    /// `hivemind/<first 8 of the session id>`.
    pub branch: String,
    /// The branch it was created from; "HEAD" when the repository was on a detached commit.
    pub base_branch: String,
    pub base_sha: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct FileChange {
    /// Path inside the worktree, forward slashes.
    pub path: String,
    /// "A" added (also untracked), "M" modified, "D" deleted.
    pub status: String,
    pub added: u64,
    pub removed: u64,
    /// Not read: binary, larger than MAX_COUNTED, or an untracked path that leads outside the worktree.
    /// No line counts and no patch.
    #[serde(default)]
    pub binary: bool,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq)]
pub struct Totals {
    pub files: u64,
    pub added: u64,
    pub removed: u64,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct FileDiff {
    #[serde(flatten)]
    pub file: FileChange,
    /// Unified diff of this file against the base; empty for a binary file.
    pub diff: String,
    /// The diff was cut at PATCH_LIMIT characters.
    pub truncated: bool,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct ChangedFiles {
    pub files: Vec<FileDiff>,
    /// More than MAX_FILES files changed; the rest are left out.
    pub truncated: bool,
}

#[derive(Debug, PartialEq)]
pub struct Listed {
    pub path: String,
    pub head: String,
    pub branch: Option<String>,
}

/// What an untracked path holds, as far as it is safe to look.
enum Untracked {
    Link(String),
    Text(String),
    Unread,
}

fn git(dir: &Path) -> Command {
    let mut command = Command::new("git");
    command.args(["--no-optional-locks", "-c", "core.longpaths=true", "-c", "core.quotepath=false", "-C"]).arg(dir);
    command
}

fn run(dir: &Path, args: &[&str]) -> Result<String, String> {
    let mut command = git(dir);
    command.args(args);
    run_with_timeout(command, TIMEOUT)
}

/// The commit a revision names, or None when it names nothing (an unknown branch, an empty repository).
fn resolve(repo: &Path, rev: &str) -> Option<String> {
    let text = run(repo, &["rev-parse", "--verify", "--quiet", "--end-of-options", &format!("{rev}^{{commit}}")]).ok()?;
    Some(text.trim().to_string()).filter(|sha| !sha.is_empty())
}

/// `worktrees/<name>-<hash>`, both from the repository path with slashes turned to `/`, no trailing `/`, lowercased.
#[allow(dead_code)] // used from commit 4
pub fn folder_for(worktrees: &Path, repo: &Path) -> PathBuf {
    let normal = repo.to_string_lossy().replace('\\', "/").trim_end_matches('/').to_lowercase();
    let last = normal.rsplit('/').next().unwrap_or("");
    let name: String = last.chars().map(|c| if c.is_ascii_alphanumeric() || "._-".contains(c) { c } else { '-' }).take(40).collect();
    let mut hash: u32 = 0x811c9dc5;
    for byte in normal.bytes() {
        hash = (hash ^ byte as u32).wrapping_mul(0x01000193);
    }
    worktrees.join(format!("{name}-{hash:08x}"))
}

#[allow(dead_code)] // used from commit 4
pub fn create(worktrees: &Path, repo: &Path, branch: Option<&str>, session_id: &str) -> Result<Worktree, String> {
    if !repo.is_dir() {
        return Err(format!("The repository folder does not exist: {}", repo.display()));
    }
    if run(repo, &["rev-parse", "--is-inside-work-tree"]).map(|s| s.trim() == "true") != Ok(true) {
        return Err(format!("Not a git repository: {}", repo.display()));
    }
    let (base_branch, base_sha) = match branch {
        Some(name) => {
            let sha = resolve(repo, &format!("refs/heads/{name}")).ok_or_else(|| format!("Unknown branch: {name}"))?;
            (name.to_string(), sha)
        }
        None => match run(repo, &["symbolic-ref", "--quiet", "--short", "HEAD"]).map(|s| s.trim().to_string()) {
            Ok(name) if !name.is_empty() => {
                let sha = resolve(repo, &format!("refs/heads/{name}")).ok_or("The repository has no commits yet")?;
                (name, sha)
            }
            _ => ("HEAD".to_string(), resolve(repo, "HEAD").ok_or("The repository has no commits yet")?),
        },
    };
    let id8: String = session_id.chars().take(8).collect();
    let folder = folder_for(worktrees, repo);
    let path = folder.join(&id8);
    std::fs::create_dir_all(&folder).map_err(|e| format!("Could not create the worktree: {e}"))?;
    if path.exists() {
        return Err(format!("Could not create the worktree: {} already exists", path.display()));
    }
    let branch = format!("hivemind/{id8}");
    let mut command = git(repo);
    command.args(["worktree", "add", "-b", &branch]).arg(&path).arg(&base_sha);
    run_with_timeout(command, CREATE_TIMEOUT).map_err(|e| format!("Could not create the worktree: {e}"))?;
    Ok(Worktree { repo: repo.display().to_string(), path: path.display().to_string(), branch, base_branch, base_sha })
}

/// The only reader of an untracked path's content. A link is reported by its target text and never opened; a file whose
/// real path leaves the worktree (a parent folder of it is a link or junction) is listed but never read.
fn untracked(tree: &Worktree, path: &str) -> Option<Untracked> {
    let root = Path::new(&tree.path);
    let full = root.join(path);
    let kind = std::fs::symlink_metadata(&full).ok()?.file_type();
    if kind.is_symlink() {
        return Some(match std::fs::read_link(&full) {
            Ok(target) => Untracked::Link(target.display().to_string()),
            Err(_) => Untracked::Unread,
        });
    }
    if !kind.is_file() {
        return None;
    }
    match (std::fs::canonicalize(&full), std::fs::canonicalize(root)) {
        (Ok(file), Ok(root)) if file.starts_with(&root) => {}
        _ => return Some(Untracked::Unread),
    }
    let Ok(bytes) = std::fs::read(&full) else { return Some(Untracked::Unread) };
    if bytes.len() as u64 > MAX_COUNTED || bytes.iter().take(8000).any(|b| *b == 0) {
        return Some(Untracked::Unread);
    }
    Some(Untracked::Text(String::from_utf8_lossy(&bytes).into_owned()))
}

fn line_count(text: &str) -> u64 {
    (text.matches('\n').count() + usize::from(!text.is_empty() && !text.ends_with('\n'))) as u64
}

pub fn changes(tree: &Worktree) -> Result<Vec<FileChange>, String> {
    let dir = Path::new(&tree.path);
    let numstat = run(dir, &["diff", "--numstat", "-z", "--no-renames", &tree.base_sha])?;
    let names = run(dir, &["diff", "--name-status", "-z", "--no-renames", &tree.base_sha])?;
    let others = run(dir, &["ls-files", "--others", "--exclude-standard", "-z"])?;
    let fields: Vec<&str> = names.split('\0').filter(|f| !f.is_empty()).collect();
    let status: HashMap<&str, &str> = fields.iter().step_by(2).zip(fields.iter().skip(1).step_by(2)).map(|(s, p)| (*p, *s)).collect();
    let mut files = Vec::new();
    for record in numstat.split('\0').filter(|r| !r.is_empty()) {
        let mut parts = record.splitn(3, '\t');
        let (Some(added), Some(removed), Some(path)) = (parts.next(), parts.next(), parts.next()) else { continue };
        let status = match status.get(path) {
            Some(&"A") => "A",
            Some(&"D") => "D",
            _ => "M",
        };
        let binary = added == "-";
        files.push(FileChange {
            path: path.to_string(),
            status: status.to_string(),
            added: added.parse().unwrap_or(0),
            removed: removed.parse().unwrap_or(0),
            binary,
        });
    }
    for path in others.split('\0').filter(|p| !p.is_empty()) {
        let Some(content) = untracked(tree, path) else { continue };
        let (added, binary) = match content {
            Untracked::Link(_) => (1, false),
            Untracked::Text(text) => (line_count(&text), false),
            Untracked::Unread => (0, true),
        };
        files.push(FileChange { path: path.to_string(), status: "A".into(), added, removed: 0, binary });
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(files)
}

#[allow(dead_code)] // used from commit 4
pub fn totals(files: &[FileChange]) -> Totals {
    Totals { files: files.len() as u64, added: files.iter().map(|f| f.added).sum(), removed: files.iter().map(|f| f.removed).sum() }
}

/// The patch of a file git does not know yet, written like git writes one for a new file.
fn new_file_patch(path: &str, content: Untracked) -> String {
    let (mode, lines): (&str, Vec<String>) = match content {
        Untracked::Link(target) => ("new file mode 120000", vec![target]),
        Untracked::Text(text) => {
            let n = line_count(&text) as usize;
            ("new file", text.split('\n').take(n).map(String::from).collect())
        }
        Untracked::Unread => return String::new(),
    };
    let mut patch = format!("diff --git a/{path} b/{path}\n{mode}\n--- /dev/null\n+++ b/{path}\n@@ -0,0 +1,{} @@\n", lines.len());
    for line in lines {
        patch.push('+');
        patch.push_str(&line);
        patch.push('\n');
    }
    patch
}

pub fn patch(tree: &Worktree, file: &FileChange) -> Result<(String, bool), String> {
    if file.binary {
        return Ok((String::new(), false));
    }
    // A literal pathspec, so a name like `[a].txt` is not read as a pattern that also matches `a.txt`.
    let pathspec = format!(":(literal){}", file.path);
    let mut text = run(Path::new(&tree.path), &["diff", "--no-color", "--no-ext-diff", "--no-renames", &tree.base_sha, "--", &pathspec])?;
    if text.is_empty() {
        text = untracked(tree, &file.path).map(|content| new_file_patch(&file.path, content)).unwrap_or_default();
    }
    match text.char_indices().nth(PATCH_LIMIT) {
        Some((cut, _)) => {
            text.truncate(cut);
            Ok((text, true))
        }
        None => Ok((text, false)),
    }
}

#[allow(dead_code)] // used from commit 4
pub fn changed_files(tree: &Worktree) -> Result<ChangedFiles, String> {
    let all = changes(tree)?;
    let truncated = all.len() > MAX_FILES;
    let mut files = Vec::new();
    for file in all.into_iter().take(MAX_FILES) {
        let (diff, cut) = patch(tree, &file)?;
        files.push(FileDiff { file, diff, truncated: cut });
    }
    Ok(ChangedFiles { files, truncated })
}

/// How many commits the session made on its branch.
pub fn ahead(tree: &Worktree) -> Result<u64, String> {
    let range = format!("{}..refs/heads/{}", tree.base_sha, tree.branch);
    let text = run(Path::new(&tree.repo), &["rev-list", "--count", &range])?;
    text.trim().parse().map_err(|_| format!("Unreadable git output: {}", text.trim()))
}

#[allow(dead_code)] // used from commit 4
pub fn list(repo: &Path) -> Result<Vec<Listed>, String> {
    let text = run(repo, &["worktree", "list", "--porcelain"])?;
    let mut all: Vec<Listed> = Vec::new();
    for line in text.lines() {
        if let Some(path) = line.strip_prefix("worktree ") {
            all.push(Listed { path: path.to_string(), head: String::new(), branch: None });
        } else if let Some(last) = all.last_mut() {
            if let Some(head) = line.strip_prefix("HEAD ") {
                last.head = head.to_string();
            } else if let Some(name) = line.strip_prefix("branch refs/heads/") {
                last.branch = Some(name.to_string());
            }
        }
    }
    Ok(all)
}

/// Removing a worktree that is already gone is fine. The branch goes too, but only when the session made no commits on it.
#[allow(dead_code)] // used from commit 4
pub fn remove(tree: &Worktree) -> Result<(), String> {
    let (repo, path) = (Path::new(&tree.repo), Path::new(&tree.path));
    let mut command = git(repo);
    command.args(["worktree", "remove", "--force"]).arg(path);
    if let (Err(e), true) = (run_with_timeout(command, TIMEOUT), path.exists()) {
        return Err(format!("Could not remove the worktree (is a program still open in it?): {e}"));
    }
    run(repo, &["worktree", "prune"])?;
    if ahead(tree) == Ok(0) {
        let _ = run(repo, &["branch", "-D", &tree.branch]);
    }
    if let Some(parent) = path.parent() {
        let _ = std::fs::remove_dir(parent);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    fn git_available() -> bool {
        Command::new("git").arg("--version").output().map(|o| o.status.success()).unwrap_or(false)
    }

    fn sh(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git").arg("-C").arg(dir).args(args).output().unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    /// A scratch folder holding `repo` and `worktrees`, deleted when it goes out of scope.
    struct Rig {
        root: PathBuf,
        repo: PathBuf,
        worktrees: PathBuf,
    }

    impl Rig {
        fn empty() -> Rig {
            static COUNTER: AtomicU32 = AtomicU32::new(0);
            let root = std::env::temp_dir().join(format!("hivemind-wt-{}-{}", std::process::id(), COUNTER.fetch_add(1, Ordering::SeqCst)));
            let repo = root.join("repo");
            std::fs::create_dir_all(&repo).unwrap();
            sh(&repo, &["init", "-q"]);
            sh(&repo, &["symbolic-ref", "HEAD", "refs/heads/main"]);
            sh(&repo, &["config", "user.name", "Tester"]);
            sh(&repo, &["config", "user.email", "t@example.com"]);
            sh(&repo, &["config", "commit.gpgsign", "false"]);
            Rig { worktrees: root.join("worktrees"), repo, root }
        }

        /// One commit with `a.txt` and `b.txt`, and a branch `feature/x`.
        fn new() -> Rig {
            let rig = Rig::empty();
            std::fs::write(rig.repo.join("a.txt"), "one\ntwo\n").unwrap();
            std::fs::write(rig.repo.join("b.txt"), "bee\n").unwrap();
            sh(&rig.repo, &["add", "."]);
            sh(&rig.repo, &["commit", "-q", "-m", "first"]);
            sh(&rig.repo, &["branch", "feature/x"]);
            rig
        }
    }

    impl Drop for Rig {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.root).ok();
        }
    }

    fn summary(files: &[FileChange]) -> Vec<(&str, &str, u64, u64, bool)> {
        files.iter().map(|f| (f.path.as_str(), f.status.as_str(), f.added, f.removed, f.binary)).collect()
    }

    /// A worktree with a.txt edited, b.txt deleted, and three untracked paths (one with a space, one binary, one non-ASCII).
    fn dirty(rig: &Rig, id: &str) -> Worktree {
        let tree = create(&rig.worktrees, &rig.repo, None, id).unwrap();
        let dir = Path::new(&tree.path);
        std::fs::write(dir.join("a.txt"), "one\nTWO\nthree\n").unwrap();
        std::fs::remove_file(dir.join("b.txt")).unwrap();
        std::fs::write(dir.join("new file.txt"), "n1\nn2").unwrap();
        std::fs::write(dir.join("blob.bin"), [0u8, 1, 2, 255]).unwrap();
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("sub").join("é.txt"), "x\n").unwrap();
        tree
    }

    #[test]
    fn folder_names_are_stable_and_safe() {
        let root = Path::new("/wt");
        let a = folder_for(root, Path::new("C:\\Work\\Pay Stream"));
        assert_eq!(a, folder_for(root, Path::new("c:/work/pay stream/")));
        let (name, hash) = a.file_name().unwrap().to_str().unwrap().rsplit_once('-').unwrap();
        assert_eq!(name, "pay-stream");
        assert!(hash.len() == 8 && hash.chars().all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c)), "{hash}");
        let other = folder_for(root, Path::new("C:/Work/Other"));
        let other_hash = other.file_name().unwrap().to_str().unwrap().strip_prefix("other-").unwrap();
        assert_eq!(other_hash.len(), 8);
        assert_ne!(other_hash, hash);
        let long = folder_for(root, Path::new(&format!("C:/Work/{}", "X".repeat(60))));
        let (long_name, _) = long.file_name().unwrap().to_str().unwrap().rsplit_once('-').unwrap();
        assert_eq!(long_name, "x".repeat(40));
    }

    #[test]
    fn creates_a_worktree_on_its_own_branch() {
        if !git_available() {
            return;
        }
        let rig = Rig::new();
        let tree = create(&rig.worktrees, &rig.repo, Some("feature/x"), "0123456789abcdef").unwrap();
        assert_eq!(tree.branch, "hivemind/01234567");
        assert_eq!(tree.base_branch, "feature/x");
        assert_eq!(tree.base_sha, sh(&rig.repo, &["rev-parse", "feature/x"]).trim());
        assert!(Path::new(&tree.path).join("a.txt").is_file());
        let listed = list(&rig.repo).unwrap();
        assert!(listed.iter().any(|l| l.branch.as_deref() == Some("hivemind/01234567") && l.head == tree.base_sha), "{listed:?}");
        let other = create(&rig.worktrees, &rig.repo, None, "fedcba9876543210").unwrap();
        assert_eq!(other.base_branch, "main");
        assert_eq!(other.branch, "hivemind/fedcba98");
    }

    #[test]
    fn create_errors_say_what_is_wrong() {
        if !git_available() {
            return;
        }
        let rig = Rig::new();
        let missing = rig.root.join("missing");
        let expected = format!("The repository folder does not exist: {}", missing.display());
        assert_eq!(create(&rig.worktrees, &missing, None, "abcdefgh"), Err(expected));
        let plain = rig.root.join("plain");
        std::fs::create_dir_all(&plain).unwrap();
        assert_eq!(create(&rig.worktrees, &plain, None, "abcdefgh"), Err(format!("Not a git repository: {}", plain.display())));
        for name in ["nope", "--upload-pack=x"] {
            assert_eq!(create(&rig.worktrees, &rig.repo, Some(name), "abcdefgh"), Err(format!("Unknown branch: {name}")));
        }
        let empty = Rig::empty();
        assert_eq!(create(&empty.worktrees, &empty.repo, None, "abcdefgh"), Err("The repository has no commits yet".to_string()));
        assert!(!rig.worktrees.exists() && !empty.worktrees.exists());
    }

    #[test]
    fn changes_cover_edits_deletions_untracked_and_commits() {
        if !git_available() {
            return;
        }
        let rig = Rig::new();
        let tree = dirty(&rig, "abcdefgh");
        let expected = vec![
            ("a.txt", "M", 2, 1, false),
            ("b.txt", "D", 0, 1, false),
            ("blob.bin", "A", 0, 0, true),
            ("new file.txt", "A", 2, 0, false),
            ("sub/é.txt", "A", 1, 0, false),
        ];
        let files = changes(&tree).unwrap();
        assert_eq!(summary(&files), expected);
        assert_eq!(totals(&files), Totals { files: 5, added: 5, removed: 2 });
        assert_eq!(ahead(&tree), Ok(0));
        sh(Path::new(&tree.path), &["add", "-A"]);
        sh(Path::new(&tree.path), &["commit", "-q", "-m", "work"]);
        assert_eq!(summary(&changes(&tree).unwrap()), expected);
        assert_eq!(ahead(&tree), Ok(1));
    }

    #[test]
    fn patches_are_unified_diffs_cut_at_the_limit() {
        if !git_available() {
            return;
        }
        let rig = Rig::new();
        let tree = dirty(&rig, "abcdefgh");
        std::fs::write(Path::new(&tree.path).join("big.txt"), "y".repeat(40_000)).unwrap();
        let files = changes(&tree).unwrap();
        let find = |path: &str| files.iter().find(|f| f.path == path).unwrap();
        let (tracked, cut) = patch(&tree, find("a.txt")).unwrap();
        assert!(tracked.contains("-two") && tracked.contains("+TWO") && !cut, "{tracked}");
        let (new, cut) = patch(&tree, find("new file.txt")).unwrap();
        assert!(new.starts_with("diff --git a/new file.txt b/new file.txt\nnew file\n--- /dev/null\n+++ b/new file.txt\n@@ -0,0 +1,2 @@\n"));
        assert!(new.contains("+n1\n+n2\n") && !cut, "{new}");
        assert_eq!(patch(&tree, find("blob.bin")).unwrap(), (String::new(), false));
        let (big, cut) = patch(&tree, find("big.txt")).unwrap();
        assert_eq!(big.chars().count(), PATCH_LIMIT);
        assert!(cut);
    }

    #[test]
    fn remove_deletes_the_folder_and_an_unused_branch() {
        if !git_available() {
            return;
        }
        let rig = Rig::new();
        let unused = dirty(&rig, "aaaaaaaa");
        assert_eq!(remove(&unused), Ok(()));
        assert!(!Path::new(&unused.path).exists());
        assert!(list(&rig.repo).unwrap().iter().all(|l| l.branch.as_deref() != Some("hivemind/aaaaaaaa")));
        assert_eq!(sh(&rig.repo, &["branch", "--list", "hivemind/*"]).trim(), "");
        assert_eq!(remove(&unused), Ok(()));

        let used = dirty(&rig, "bbbbbbbb");
        sh(Path::new(&used.path), &["add", "-A"]);
        sh(Path::new(&used.path), &["commit", "-q", "-m", "work"]);
        assert_eq!(remove(&used), Ok(()));
        assert!(!Path::new(&used.path).exists());
        assert!(sh(&rig.repo, &["branch", "--list", "hivemind/*"]).contains("hivemind/bbbbbbbb"));
        assert_eq!(remove(&used), Ok(()));
    }

    /// A folder outside the worktree whose `secret.txt` must never show up in anything Hivemind reads.
    fn outside(rig: &Rig) -> PathBuf {
        let folder = rig.root.join("outside");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("secret.txt"), "TOP-SECRET-LINE\n".repeat(50)).unwrap();
        folder
    }

    #[test]
    fn an_untracked_link_is_reported_by_its_target_and_never_followed() {
        if !git_available() {
            return;
        }
        let rig = Rig::new();
        let secret = outside(&rig).join("secret.txt");
        let tree = create(&rig.worktrees, &rig.repo, None, "abcdefgh").unwrap();
        let link = Path::new(&tree.path).join("leak.txt");
        #[cfg(windows)]
        let made = std::os::windows::fs::symlink_file(&secret, &link);
        #[cfg(unix)]
        let made = std::os::unix::fs::symlink(&secret, &link);
        if made.is_err() {
            eprintln!("skipped: cannot create a symbolic link without the privilege");
            return;
        }
        let files = changes(&tree).unwrap();
        let leak = files.iter().find(|f| f.path == "leak.txt").unwrap();
        assert_eq!((leak.status.as_str(), leak.added, leak.binary), ("A", 1, false));
        let (text, _) = patch(&tree, leak).unwrap();
        assert!(text.contains("new file mode 120000"), "{text}");
        let plus: Vec<&str> = text.lines().filter(|l| l.starts_with('+') && !l.starts_with("+++")).collect();
        assert!(plus.len() == 1 && plus[0].ends_with("secret.txt"), "{text}");
        assert!(!text.contains("TOP-SECRET-LINE"));
    }

    #[cfg(windows)]
    #[test]
    fn files_behind_a_junction_are_listed_but_never_read() {
        if !git_available() {
            return;
        }
        let rig = Rig::new();
        let target = outside(&rig);
        let tree = create(&rig.worktrees, &rig.repo, None, "abcdefgh").unwrap();
        let vendor = Path::new(&tree.path).join("vendor");
        let made = Command::new("cmd").arg("/C").arg("mklink").arg("/J").arg(&vendor).arg(&target).output().unwrap();
        assert!(made.status.success(), "{}", String::from_utf8_lossy(&made.stdout));
        let files = changes(&tree).unwrap();
        for file in files.iter().filter(|f| f.path.starts_with("vendor")) {
            assert_eq!(file.added, 0, "{file:?}");
            assert!(file.binary || !file.path.starts_with("vendor/"), "{file:?}");
            assert!(!patch(&tree, file).unwrap().0.contains("TOP-SECRET-LINE"));
        }
        assert!(!serde_json::to_string(&changed_files(&tree).unwrap()).unwrap().contains("TOP-SECRET-LINE"));
        std::fs::remove_dir(&vendor).unwrap();
    }

    #[test]
    fn things_that_are_not_regular_files_are_skipped() {
        if !git_available() {
            return;
        }
        let rig = Rig::new();
        let tree = create(&rig.worktrees, &rig.repo, None, "abcdefgh").unwrap();
        std::fs::create_dir_all(Path::new(&tree.path).join("empty")).unwrap();
        assert!(untracked(&tree, "empty").is_none());
        assert!(untracked(&tree, "missing.txt").is_none());
        assert!(changes(&tree).unwrap().is_empty());
    }
}
