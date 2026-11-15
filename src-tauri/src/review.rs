//! Reviewing a work session's edits: the worktree and its base commits come from the session's stored details, never from
//! the webview. It lists nothing itself: the listing is `crate::worktree::changes`.
use crate::agent::{self, Manager, SessionInfo};
use crate::git::{is_sha, run_captured};
use crate::agent::events::Status;
use crate::worktree::{self, FileChange, Worktree};
use serde::Serialize;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

pub const MAX_FILE: u64 = 2 * 1024 * 1024; // bytes, per side of a diff
const SNIFF: usize = 8000; // bytes git looks at to call a file binary
const READ: Duration = Duration::from_secs(20);
pub const REFRESH_CAP: usize = 20; // worktrees one review_refresh looks at

/// The two versions of one changed file.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileContents {
    /// The file at the review base; None when it did not exist there, or is binary or too large.
    pub base: Option<String>,
    /// The file in the worktree now; None when it was deleted, or is binary or too large.
    pub head: Option<String>,
    pub binary: bool,
    /// One side is larger than MAX_FILE.
    pub too_large: bool,
}

// ---- git on a worktree (no session knowledge) ----

/// Run git in `dir`. The error is git's own `fatal:` or `error:` line, not the first line of stderr (that is often a
/// line-ending warning).
fn run(dir: &Path, args: &[&str], timeout: Duration) -> Result<String, String> {
    let mut command = worktree::git(dir);
    command.args(args);
    let ran = run_captured(command, timeout)?;
    if ran.status.success() {
        return Ok(ran.stdout);
    }
    let lines: Vec<&str> = ran.stderr.lines().map(str::trim).filter(|line| !line.is_empty()).collect();
    let reason = lines.iter().find(|line| line.starts_with("fatal:") || line.starts_with("error:")).or(lines.last());
    Err(reason.map_or_else(|| format!("git exited with {}", ran.status), |line| line.to_string()))
}

/// A folder's real path, without the `\\?\` prefix Windows puts on it, so two spellings of one folder compare equal.
fn canonical(path: &Path) -> std::io::Result<PathBuf> {
    let real = std::fs::canonicalize(path)?;
    let text = real.to_string_lossy();
    Ok(match text.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC\\") => PathBuf::from(rest),
        _ => real,
    })
}

fn has_nul(bytes: &[u8]) -> bool {
    bytes.iter().take(SNIFF).any(|b| *b == 0)
}

/// The two versions of one file of the session's changes. `path` must be one of `worktree::changes`.
pub fn file_contents(tree: &Worktree, path: &str) -> Result<FileContents, String> {
    let list = worktree::changes(tree)?;
    let entry = list.iter().find(|entry| entry.path == path).ok_or("That file is not one of this session's changes")?;
    let (mut base, mut head, mut binary, mut too_large) = (None, None, entry.binary, false);
    if binary {
        return Ok(FileContents { base, head, binary, too_large });
    }
    let dir = Path::new(&tree.path);
    if entry.status != "A" {
        let spec = format!("{}:{}", tree.review_base(), entry.path);
        let size = run(dir, &["cat-file", "-s", &spec], READ)?.trim().parse::<u64>().map_err(|_| "git did not print a size".to_string())?;
        if size > MAX_FILE {
            too_large = true;
        } else {
            let text = run(dir, &["show", &spec], READ)?;
            if has_nul(text.as_bytes()) { binary = true } else { base = Some(text) }
        }
    }
    if entry.status != "D" {
        let root = canonical(dir).map_err(|_| format!("The session's worktree folder is missing: {}", tree.path))?;
        let full = canonical(&dir.join(&entry.path)).ok().filter(|full| full.starts_with(&root)).ok_or("That file is outside the worktree")?;
        let meta = std::fs::metadata(&full).map_err(|e| e.to_string())?;
        if meta.is_dir() {
            binary = true;
        } else if meta.len() > MAX_FILE {
            too_large = true;
        } else {
            let mut bytes = Vec::new();
            std::fs::File::open(&full).and_then(|file| file.take(MAX_FILE + 1).read_to_end(&mut bytes)).map_err(|e| e.to_string())?;
            if bytes.len() as u64 > MAX_FILE {
                too_large = true;
            } else if has_nul(&bytes) {
                binary = true;
            } else {
                head = Some(String::from_utf8_lossy(&bytes).into_owned());
            }
        }
    }
    if binary || too_large {
        (base, head) = (None, None);
    }
    Ok(FileContents { base, head, binary, too_large })
}

// ---- the same for a session (what the commands call) ----

/// The session's worktree, once it is known to be one of Hivemind's: base commits that are commit ids, and a folder that
/// exists inside `worktrees_dir`. The returned path is the folder's real path.
fn checked_worktree(info: &SessionInfo, worktrees_dir: &Path) -> Result<Worktree, String> {
    let mut tree = info.worktree.clone().ok_or("This session has no worktree to review")?;
    if !is_sha(&tree.base_sha) || tree.reviewed_sha.as_deref().is_some_and(|sha| !is_sha(sha)) {
        return Err("The session's base commit is not a commit id".into());
    }
    let real = canonical(Path::new(&tree.path)).map_err(|_| format!("The session's worktree folder is missing: {}", tree.path))?;
    if !canonical(worktrees_dir).is_ok_and(|root| real.starts_with(root)) {
        return Err("The session's worktree is outside Hivemind's worktrees folder".into());
    }
    tree.path = real.display().to_string();
    Ok(tree)
}

/// Store new totals (and the review decision they imply) when a listing differs from what the session lists. Not for a
/// session that is mid-turn: its own turn end does that.
fn reconcile(agents: &Manager, info: &SessionInfo, list: &[FileChange]) -> bool {
    let totals = worktree::totals(list);
    if matches!(info.status, Status::Running | Status::Waiting) || totals == info.files_changed.unwrap_or_default() {
        return false;
    }
    let stored = agents.amend(&info.id, |info| {
        info.review = agent::review_after_turn(info.review.take(), info.files_changed.as_ref(), Some(&totals), agent::now_ms());
        info.files_changed = (!list.is_empty()).then_some(totals);
    });
    stored.is_ok()
}

/// The files the session changed since its review base.
pub fn files(agents: &Manager, worktrees_dir: &Path, id: &str) -> Result<Vec<FileChange>, String> {
    let info = agents.info(id)?;
    let tree = checked_worktree(&info, worktrees_dir)?;
    let list = worktree::changes(&tree)?;
    reconcile(agents, &info, &list);
    Ok(list)
}

/// Look at the worktree of every session (newest first, at most `REFRESH_CAP`) again, so edits made outside a turn are
/// noticed. Returns how many sessions changed.
pub fn refresh(agents: &Manager, worktrees_dir: &Path) -> usize {
    let (mut looked, mut changed) = (0, 0);
    for info in agents.sessions() {
        if looked >= REFRESH_CAP {
            break;
        }
        if info.worktree.is_none() || matches!(info.status, Status::Running | Status::Waiting) {
            continue;
        }
        let Ok(tree) = checked_worktree(&info, worktrees_dir) else { continue };
        looked += 1;
        if let Ok(list) = worktree::changes(&tree) {
            changed += usize::from(reconcile(agents, &info, &list));
        }
    }
    changed
}

/// The two versions of one file the session changed.
pub fn file(agents: &Manager, worktrees_dir: &Path, id: &str, path: &str) -> Result<FileContents, String> {
    let info = agents.info(id)?;
    file_contents(&checked_worktree(&info, worktrees_dir)?, path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::claude::ClaudeCode;
    use crate::agent::events::Mode;
    use crate::agent::scope::{AgentTask, PolicyMode};
    use crate::agent::{store, Emit, Review, ReviewState};
    use std::process::Command;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::{Arc, Mutex};

    fn git_available() -> bool {
        Command::new("git").arg("--version").output().map(|o| o.status.success()).unwrap_or(false)
    }

    fn sh(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git").arg("-C").arg(dir).args(args).output().unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    fn id(n: u32) -> String {
        format!("{:08x}-0000-4000-8000-{n:012}", 0x1a2b3c00 + n)
    }

    /// A scratch folder with a repository (one commit: `a.txt`, `b.txt`, `bin.dat`) and a worktrees folder.
    struct Rig {
        root: PathBuf,
        repo: PathBuf,
        worktrees: PathBuf,
        sessions: PathBuf,
    }

    impl Rig {
        fn new() -> Rig {
            static COUNTER: AtomicU32 = AtomicU32::new(0);
            let root = std::env::temp_dir().join(format!("hivemind-review-{}-{}", std::process::id(), COUNTER.fetch_add(1, Ordering::SeqCst)));
            let repo = root.join("repo");
            std::fs::create_dir_all(&repo).unwrap();
            sh(&repo, &["init", "-q"]);
            sh(&repo, &["symbolic-ref", "HEAD", "refs/heads/main"]);
            for (key, value) in [("user.name", "Tester"), ("user.email", "t@example.com"), ("commit.gpgsign", "false"), ("core.autocrlf", "false")] {
                sh(&repo, &["config", key, value]);
            }
            std::fs::write(repo.join("a.txt"), "one\ntwo\n").unwrap();
            std::fs::write(repo.join("b.txt"), "bee\n").unwrap();
            std::fs::write(repo.join("bin.dat"), [0u8, 1, 2]).unwrap();
            sh(&repo, &["add", "."]);
            sh(&repo, &["commit", "-q", "-m", "first"]);
            Rig { worktrees: root.join("worktrees"), sessions: root.join("sessions"), repo, root }
        }

        /// A worktree of the repository for session `n`.
        fn tree(&self, n: u32) -> Worktree {
            worktree::create(&self.worktrees, &self.repo, None, &id(n)).unwrap()
        }

        /// A manager on a history that holds `infos`, and what it announced.
        fn manager(&self, infos: &[SessionInfo]) -> (Manager, Arc<Mutex<Vec<Emit>>>) {
            store::save_index(&self.sessions, infos).unwrap();
            let seen: Arc<Mutex<Vec<Emit>>> = Arc::default();
            let sink = seen.clone();
            (Manager::new(self.sessions.clone(), Arc::new(ClaudeCode), Arc::new(move |emit| sink.lock().unwrap().push(emit))), seen)
        }
    }

    impl Drop for Rig {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.root).ok();
        }
    }

    /// An interactive work session at rest.
    fn session(n: u32, tree: Option<Worktree>) -> SessionInfo {
        SessionInfo {
            id: id(n),
            adapter: "claude-code".into(),
            cli_version: None,
            task: AgentTask::Work { project: "paystream".into(), repo: "repo".into(), branch: None, change: None },
            title: "Fix the bug".into(),
            workspace: vec![],
            status: Status::Idle,
            started_at: 1000 + n as u64,
            ended_at: None,
            cost_usd: None,
            error: None,
            structured: None,
            mode: Mode::Interactive,
            policy: PolicyMode::Ask,
            project: Some("paystream".into()),
            worktree: tree,
            turns: 1,
            files_changed: None,
            context: vec![],
            model: None,
            system: None,
            review: None,
            source_sha: None,
        }
    }

    fn paths(list: &[FileChange]) -> Vec<&str> {
        list.iter().map(|file| file.path.as_str()).collect()
    }

    #[test]
    fn file_contents_gives_both_sides() {
        if !git_available() {
            return;
        }
        let rig = Rig::new();
        let tree = rig.tree(1);
        let dir = Path::new(&tree.path);
        std::fs::write(dir.join("a.txt"), "one\nTWO\n").unwrap();
        std::fs::remove_file(dir.join("b.txt")).unwrap();
        std::fs::write(dir.join("new.txt"), "fresh\n").unwrap();
        std::fs::write(dir.join("new.bin"), [0u8, 9, 9]).unwrap();
        let both = |base: Option<&str>, head: Option<&str>| FileContents {
            base: base.map(String::from),
            head: head.map(String::from),
            binary: false,
            too_large: false,
        };
        assert_eq!(file_contents(&tree, "a.txt"), Ok(both(Some("one\ntwo\n"), Some("one\nTWO\n"))));
        assert_eq!(file_contents(&tree, "new.txt"), Ok(both(None, Some("fresh\n"))));
        assert_eq!(file_contents(&tree, "b.txt"), Ok(both(Some("bee\n"), None)));
        assert_eq!(file_contents(&tree, "new.bin"), Ok(FileContents { base: None, head: None, binary: true, too_large: false }));
        let not_listed = "That file is not one of this session's changes";
        let absolute = rig.root.join("repo").join("a.txt").display().to_string();
        for path in ["c.txt", "../x", absolute.as_str(), "a.txt/"] {
            assert_eq!(file_contents(&tree, path), Err(not_listed.to_string()), "{path}");
        }
    }

    #[test]
    fn file_contents_refuses_large_files() {
        if !git_available() {
            return;
        }
        let rig = Rig::new();
        let tree = rig.tree(1);
        std::fs::write(Path::new(&tree.path).join("a.txt"), "x".repeat(MAX_FILE as usize + 1)).unwrap();
        assert_eq!(file_contents(&tree, "a.txt"), Ok(FileContents { base: None, head: None, binary: false, too_large: true }));
    }

    #[test]
    fn worktree_must_be_inside_the_worktrees_folder() {
        if !git_available() {
            return;
        }
        let rig = Rig::new();
        let tree = rig.tree(1);
        std::fs::create_dir_all(&rig.worktrees).unwrap();
        assert_eq!(checked_worktree(&session(1, None), &rig.worktrees), Err("This session has no worktree to review".to_string()));
        let bad_base = Worktree { base_sha: "HEAD".into(), ..tree.clone() };
        assert_eq!(checked_worktree(&session(1, Some(bad_base)), &rig.worktrees), Err("The session's base commit is not a commit id".to_string()));
        let bad_review = Worktree { reviewed_sha: Some("--all".into()), ..tree.clone() };
        assert_eq!(checked_worktree(&session(1, Some(bad_review)), &rig.worktrees), Err("The session's base commit is not a commit id".to_string()));
        let gone = rig.worktrees.join("gone");
        let missing = Worktree { path: gone.display().to_string(), ..tree.clone() };
        assert_eq!(
            checked_worktree(&session(1, Some(missing)), &rig.worktrees),
            Err(format!("The session's worktree folder is missing: {}", gone.display()))
        );
        // The user's own checkout is a real folder, but not one of Hivemind's.
        let outside = Worktree { path: rig.repo.display().to_string(), ..tree.clone() };
        assert_eq!(
            checked_worktree(&session(1, Some(outside)), &rig.worktrees),
            Err("The session's worktree is outside Hivemind's worktrees folder".to_string())
        );
        let checked = checked_worktree(&session(1, Some(tree.clone())), &rig.worktrees).unwrap();
        assert_eq!(PathBuf::from(&checked.path), canonical(Path::new(&tree.path)).unwrap());
        assert_eq!(checked.review_base(), tree.base_sha);
        let reviewed = Worktree { reviewed_sha: Some("b".repeat(40)), ..tree };
        assert_eq!(checked_worktree(&session(1, Some(reviewed)), &rig.worktrees).unwrap().review_base(), "b".repeat(40));
    }

    #[test]
    fn listing_a_session_reconciles_its_totals() {
        if !git_available() {
            return;
        }
        let rig = Rig::new();
        let (first, second) = (rig.tree(1), rig.tree(2));
        for tree in [&first, &second] {
            std::fs::write(Path::new(&tree.path).join("a.txt"), "changed\n").unwrap();
            std::fs::write(Path::new(&tree.path).join("new.txt"), "new\n").unwrap();
        }
        let stale = session(1, Some(first));
        let approved = SessionInfo {
            review: Some(Review { state: ReviewState::Approved, commit: Some("c".repeat(40)), at: 5 }),
            files_changed: None,
            ..session(2, Some(second))
        };
        let (manager, seen) = rig.manager(&[SessionInfo { files_changed: Some(crate::worktree::Totals { files: 1, added: 1, removed: 0 }), ..stale }, approved]);
        let list = files(&manager, &rig.worktrees, &id(1)).unwrap();
        assert_eq!(paths(&list), ["a.txt", "new.txt"]);
        assert_eq!(manager.info(&id(1)).unwrap().files_changed.map(|totals| totals.files), Some(2));
        assert!(seen.lock().unwrap().iter().any(|emit| matches!(emit, Emit::SessionsChanged)));
        assert_eq!(files(&manager, &rig.worktrees, &id(2)).unwrap().len(), 2);
        let reopened = manager.info(&id(2)).unwrap();
        assert_eq!(reopened.review.map(|review| (review.state, review.commit)), Some((ReviewState::Pending, None)));
        assert_eq!(reopened.files_changed.map(|totals| totals.files), Some(2));
        assert_eq!(files(&manager, &rig.worktrees, "../index").unwrap_err(), "Invalid session id");
    }

    #[test]
    fn refresh_finds_edits_in_sessions_the_page_does_not_list() {
        if !git_available() {
            return;
        }
        let rig = Rig::new();
        let (a_tree, b_tree, c_tree) = (rig.tree(1), rig.tree(2), rig.tree(3));
        std::fs::write(Path::new(&a_tree.path).join("new.txt"), "new\n").unwrap();
        std::fs::write(Path::new(&b_tree.path).join("a.txt"), "changed\n").unwrap();
        let ghost = Worktree { path: rig.worktrees.join("ghost").display().to_string(), ..c_tree };
        let one = crate::worktree::Totals { files: 1, added: 1, removed: 2 };
        let approved = Review { state: ReviewState::Approved, commit: Some("c".repeat(40)), at: 5 };
        let pending = Review { state: ReviewState::Pending, commit: None, at: 6 };
        let (manager, _) = rig.manager(&[
            SessionInfo { review: Some(approved), ..session(1, Some(a_tree)) },
            SessionInfo { review: Some(pending.clone()), files_changed: Some(one), ..session(2, Some(b_tree)) },
            SessionInfo { files_changed: Some(one), ..session(3, Some(ghost)) },
        ]);
        let before_b = manager.info(&id(2)).unwrap();
        let before_c = manager.info(&id(3)).unwrap();
        assert_eq!(refresh(&manager, &rig.worktrees), 1);
        let a = manager.info(&id(1)).unwrap();
        assert_eq!(a.files_changed.map(|totals| totals.files), Some(1));
        assert_eq!(a.review.map(|review| review.state), Some(ReviewState::Pending));
        assert_eq!(manager.info(&id(2)).unwrap(), before_b);
        assert_eq!(manager.info(&id(3)).unwrap(), before_c);
        assert_eq!(refresh(&manager, &rig.worktrees), 0);

        // Only the newest REFRESH_CAP sessions with a worktree are looked at.
        let many = Rig::new();
        let stale = crate::worktree::Totals { files: 5, added: 5, removed: 0 };
        let infos: Vec<SessionInfo> = (1..=REFRESH_CAP as u32 + 1)
            .map(|n| SessionInfo { files_changed: (n == 1).then_some(stale), ..session(n, Some(many.tree(n))) })
            .collect();
        let (manager, _) = many.manager(&infos);
        assert_eq!(refresh(&manager, &many.worktrees), 0);
        assert_eq!(manager.info(&id(1)).unwrap().files_changed, Some(stale));
        assert_eq!(manager.info(&id(2)).unwrap().files_changed, None);
    }
}
