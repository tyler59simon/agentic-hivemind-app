//! Reviewing a work session's edits: the worktree and its base commits come from the session's stored details, never from
//! the webview. It lists nothing itself: the listing is `crate::worktree::changes`.
use crate::agent::direct::{self, Direct};
use crate::agent::events::Status;
use crate::agent::scope::{self, AgentTask};
use crate::agent::{self, Manager, Review, ReviewState, SendOptions, SessionInfo};
use crate::bridge::Bridge;
use crate::git::{is_sha, run_captured};
use crate::settings::Settings;
use crate::term;
use crate::worktree::{self, FileChange, Totals, Worktree};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

pub const MAX_FILE: u64 = 2 * 1024 * 1024; // bytes, per side of a diff
const SNIFF: usize = 8000; // bytes git looks at to call a file binary
const READ: Duration = Duration::from_secs(20);
const WRITE: Duration = Duration::from_secs(120);
pub(crate) const NO_IDENTITY: &str = "Git has no author identity, so it cannot commit. Set one with: git config --global user.name \"Your Name\" and git config --global user.email \"you@example.com\". Then approve again.";
const OUTPUT_LINES: usize = 20; // lines of a failed commit's output that are shown
pub const REFRESH_CAP: usize = 20; // worktrees one review_refresh looks at
const FRESH: Duration = Duration::from_secs(10); // how long a direct session's fresh snapshot is reused

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
    let link = std::fs::symlink_metadata(dir.join(&entry.path)).is_ok_and(|meta| meta.file_type().is_symlink());
    if entry.status != "D" && link {
        // Git commits a link as the path it points to, so that is what is shown; the link is never followed.
        let target = std::fs::read_link(dir.join(&entry.path)).map_err(|e| e.to_string())?;
        head = Some(target.to_string_lossy().replace('\\', "/"));
    } else if entry.status != "D" {
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

/// Everything the worktree changed goes into one commit on its branch; returns the commit id. When nothing is left to
/// stage but the branch is ahead of the review base (the agent committed its own work), that commit is the result.
pub fn commit_all(tree: &Worktree, message: &str) -> Result<String, String> {
    if message.trim().is_empty() {
        return Err("Write a commit message first.".into());
    }
    let dir = Path::new(&tree.path);
    run(dir, &["add", "-A"], WRITE)?;
    if !run(dir, &["diff", "--cached", "--name-only", "-z", "HEAD"], READ)?.is_empty() {
        let mut command = worktree::git(dir);
        command.args(["commit", "-m", message]);
        let ran = run_captured(command, WRITE)?;
        if !ran.status.success() {
            if ran.stderr.contains("Author identity unknown") || ran.stderr.contains("empty ident name") {
                return Err(NO_IDENTITY.into());
            }
            let last = |text: &str| -> Vec<String> {
                let lines: Vec<&str> = text.lines().map(str::trim_end).filter(|line| !line.trim().is_empty()).collect();
                lines[lines.len().saturating_sub(OUTPUT_LINES)..].iter().map(|line| line.to_string()).collect()
            };
            let shown: Vec<String> = last(&ran.stderr).into_iter().chain(last(&ran.stdout)).collect();
            return Err(format!("The commit did not go through:\n{}", shown.join("\n")));
        }
    }
    let head = run(dir, &["rev-parse", "HEAD"], READ)?.trim().to_string();
    if !is_sha(&head) {
        return Err("git did not print a commit id".into());
    }
    if head == tree.review_base() {
        return Err("There is nothing to approve: the worktree matches its base commit.".into());
    }
    Ok(head)
}

/// Throw the edits away: the branch goes back to the review base and untracked files are removed.
pub fn reset_to_base(tree: &Worktree) -> Result<(), String> {
    let dir = Path::new(&tree.path);
    run(dir, &["reset", "--hard", tree.review_base()], WRITE)?;
    run(dir, &["clean", "-fd"], WRITE)?;
    Ok(())
}

// ---- a session in the user's own folder (no worktree: the start snapshot is the base) ----

const NOT_GIT: &str = "This folder is not a git repository; Hivemind cannot show what changed.";

/// What `checked_direct` needs besides the session: the saved settings (the picked folders) and a lookup of a project's
/// registry entry by slug.
pub struct DirectEnv<'a> {
    pub saved: &'a Settings,
    pub registry: &'a dyn Fn(&str) -> Result<Value, String>,
}

/// The tree or commit a direct session's edits are compared with: its start snapshot, else `HEAD` at the start.
fn direct_base(direct: &Direct) -> Option<&str> {
    direct.start_tree.as_deref().or(direct.head_sha.as_deref())
}

/// The session's folder, once it is known to still be one Hivemind may read: the project's registered repository (a
/// session in the checkout) or one of the picked folders (a folder session), and the same one the session started in.
fn checked_direct(info: &SessionInfo, env: &DirectEnv) -> Result<(PathBuf, Direct), String> {
    let direct = info.direct.clone().ok_or("This session does not run in your own folder")?;
    let allowed = match &info.task {
        AgentTask::Work { project, repo, .. } => scope::project_repo(&(env.registry)(project)?, repo)
            .map_err(|_| "This folder is no longer one of the project's repositories, so Hivemind will not read it".to_string())?,
        AgentTask::Folder { path } => scope::other_folder(env.saved, path)
            .map_err(|_| "This folder is no longer one of your other folders, so Hivemind will not read it".to_string())?,
        AgentTask::SystemPassport { .. } | AgentTask::Executive { .. } => return Err("This session does not run in your own folder".into()),
    };
    if !scope::same_path(&allowed.to_string_lossy(), &direct.path) {
        return Err("The session's folder is not the one its project or folder entry names".into());
    }
    if [&direct.start_tree, &direct.head_sha].into_iter().flatten().any(|rev| !is_sha(rev)) {
        return Err("The session's start point is not a commit or tree id".into());
    }
    let dir = PathBuf::from(&direct.path);
    if !dir.is_dir() {
        return Err(format!("The session's folder is missing: {}", direct.path));
    }
    Ok((dir, direct))
}

/// What the files of `dir` hold now, as a tree. Reused for `FRESH`, so the file list and each file's diff do not
/// snapshot again per click. The commands run it off the UI thread.
fn fresh_tree(id: &str, dir: &Path) -> Result<String, String> {
    static CACHE: OnceLock<Mutex<HashMap<String, (Instant, String)>>> = OnceLock::new();
    let mut cache = CACHE.get_or_init(Mutex::default).lock().unwrap_or_else(|e| e.into_inner());
    let key = format!("{id}|{}", dir.display());
    if let Some((_, tree)) = cache.get(&key).filter(|(at, _)| at.elapsed() < FRESH) {
        return Ok(tree.clone());
    }
    let tree = direct::snapshot(dir)?;
    cache.retain(|_, (at, _)| at.elapsed() < FRESH);
    cache.insert(key, (Instant::now(), tree.clone()));
    Ok(tree)
}

/// The files that differ between two trees (or a commit and a tree) of the repository `dir` is in.
fn direct_changes(dir: &Path, from: &str, now: &str) -> Result<Vec<FileChange>, String> {
    let numstat = run(dir, &["diff", "--numstat", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", from, now], READ)?;
    let names = run(dir, &["diff", "--name-status", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", from, now], READ)?;
    let mut files = worktree::parse_changes(&numstat, &names);
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(files)
}

/// What a direct session changed, from a snapshot taken now (not cached). No base (a folder git does not know) means no
/// files. For the terminal, which stores the totals when a program ends.
pub fn direct_files_now(direct: &Direct) -> Result<Vec<FileChange>, String> {
    let Some(from) = direct_base(direct) else { return Ok(vec![]) };
    let dir = Path::new(&direct.path);
    direct_changes(dir, from, &direct::snapshot(dir)?)
}

enum Blob {
    Text(String),
    Binary,
    TooLarge,
}

/// One file of a tree, read through git only (a link is its target text; nothing on disk is opened).
fn blob(dir: &Path, spec: &str) -> Result<Blob, String> {
    let size = run(dir, &["cat-file", "-s", spec], READ)?.trim().parse::<u64>().map_err(|_| "git did not print a size".to_string())?;
    if size > MAX_FILE {
        return Ok(Blob::TooLarge);
    }
    let text = run(dir, &["show", spec], READ)?;
    Ok(if has_nul(text.as_bytes()) { Blob::Binary } else { Blob::Text(text) })
}

/// The two versions of one file a direct session changed. `path` must be one of `direct_changes`.
fn direct_contents(dir: &Path, from: &str, now: &str, path: &str) -> Result<FileContents, String> {
    let list = direct_changes(dir, from, now)?;
    let entry = list.iter().find(|entry| entry.path == path).ok_or("That file is not one of this session's changes")?;
    let (mut base, mut head, mut binary, mut too_large) = (None, None, entry.binary, false);
    if !binary {
        // A new file has no base side, a deleted one no head side.
        for (side, missing, rev) in [(&mut base, "A", from), (&mut head, "D", now)] {
            if entry.status == missing {
                continue;
            }
            match blob(dir, &format!("{rev}:{}", entry.path))? {
                Blob::Text(text) => *side = Some(text),
                Blob::Binary => binary = true,
                Blob::TooLarge => too_large = true,
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

/// Being inside the worktrees folder does not make a folder the session's own branch: someone may have checked out
/// another branch there, or the record may be damaged. Refuses to go on unless git agrees that the folder is a worktree of
/// the session's repository, is its own top level, and is on `hivemind/<first 8 of the id>`.
fn checked_for_write(id: &str, tree: &Worktree) -> Result<(), String> {
    if tree.branch != format!("hivemind/{}", id.chars().take(8).collect::<String>()) {
        return Err(format!("This session's branch name does not match its id: {}", tree.branch));
    }
    let dir = Path::new(&tree.path);
    let here = canonical(dir).map_err(|_| format!("The session's worktree folder is missing: {}", tree.path))?;
    let registered = worktree::list(Path::new(&tree.repo))?.iter().any(|listed| canonical(Path::new(&listed.path)).is_ok_and(|path| path == here));
    if !registered {
        return Err(format!("The session's folder is not a worktree of {}", tree.repo));
    }
    let top = run(dir, &["rev-parse", "--show-toplevel"], READ)?;
    if !canonical(Path::new(top.trim())).is_ok_and(|path| path == here) {
        return Err(format!("The session's folder is inside another git checkout: {}", top.trim()));
    }
    match run(dir, &["symbolic-ref", "--short", "HEAD"], READ) {
        Ok(name) if name.trim() == tree.branch => Ok(()),
        Ok(name) => Err(format!("The session's worktree is on branch {}, not on its own branch {}", name.trim(), tree.branch)),
        Err(_) => Err(format!("The session's worktree is on a detached commit, not on its own branch {}", tree.branch)),
    }
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
pub fn files(agents: &Manager, worktrees_dir: &Path, env: &DirectEnv, id: &str) -> Result<Vec<FileChange>, String> {
    let info = agents.info(id)?;
    if info.direct.is_some() {
        let (dir, direct) = checked_direct(&info, env)?;
        let Some(from) = direct_base(&direct) else { return Ok(vec![]) };
        let list = direct_changes(&dir, from, &fresh_tree(id, &dir)?)?;
        reconcile(agents, &info, &list);
        return Ok(list);
    }
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
pub fn file(agents: &Manager, worktrees_dir: &Path, env: &DirectEnv, id: &str, path: &str) -> Result<FileContents, String> {
    let info = agents.info(id)?;
    if info.direct.is_some() {
        let (dir, direct) = checked_direct(&info, env)?;
        let from = direct_base(&direct).ok_or(NOT_GIT)?;
        return direct_contents(&dir, from, &fresh_tree(id, &dir)?, path);
    }
    file_contents(&checked_worktree(&info, worktrees_dir)?, path)
}

/// Commit the session's edits on its own branch. Never merges, never pushes. Returns the commit id.
pub fn approve(agents: &Manager, worktrees_dir: &Path, id: &str, message: &str) -> Result<String, String> {
    let _held = agents.reserve(id)?;
    let tree = checked_worktree(&agents.info(id)?, worktrees_dir)?;
    checked_for_write(id, &tree)?;
    let commit = commit_all(&tree, message)?;
    // `base_sha` stays where the branch started: Phase 2 counts commits ahead of it before it deletes a branch.
    agents.amend(id, |info| {
        if let Some(tree) = &mut info.worktree {
            tree.reviewed_sha = Some(commit.clone());
        }
        info.files_changed = Some(Totals::default());
        info.review = Some(Review { state: ReviewState::Approved, commit: Some(commit.clone()), at: agent::now_ms() });
    })
    .map_err(|e| format!("Committed {} on {}, but Hivemind did not record the approval. {e}", &commit[..7], tree.branch))?;
    Ok(commit)
}

/// A workflow checkpoint: the session's edits as a commit on its own branch, without recording a review decision (the
/// user still approves the session in Review; the approval then finds this commit). When nothing changed, the worktree's
/// commit as it is, read while the session is held, so the checkpoint is the commit this call saw (Codex review F7-1).
pub fn checkpoint(agents: &Manager, worktrees_dir: &Path, id: &str, message: &str) -> Result<Option<String>, String> {
    let _held = agents.reserve(id)?;
    let tree = checked_worktree(&agents.info(id)?, worktrees_dir)?;
    checked_for_write(id, &tree)?;
    match commit_all(&tree, message) {
        Ok(commit) => Ok(Some(commit)),
        Err(e) if e.starts_with("There is nothing to approve") => crate::git::head_sha(Path::new(&tree.path)).map(Some),
        Err(e) => Err(e),
    }
}

/// Send the text to the session as a new message, and record that changes were requested once it is on its way.
pub fn request_changes(agents: &Manager, bridge: &Bridge, saved: &Settings, id: &str, text: &str) -> Result<(), String> {
    if text.trim().is_empty() {
        return Err("Write what should change first.".into());
    }
    let held = agents.reserve(id)?;
    agent::send_task(agents, bridge, saved, id, text, SendOptions::default(), Some(&held))?;
    agents.amend(id, |info| info.review = Some(Review { state: ReviewState::ChangesRequested, commit: None, at: agent::now_ms() }))?;
    Ok(())
}

/// How long a terminal program gets to leave before a review action gives up on it.
const STOP_WAIT: Duration = Duration::from_secs(10);

/// A terminal session that works in its own worktree: the only kind Stop and approve and a terminal Request changes act on.
fn terminal_in_worktree(info: &SessionInfo) -> Result<(), String> {
    if info.interface != agent::Interface::Terminal {
        return Err("This is not a terminal session".into());
    }
    if info.worktree.is_none() {
        return Err("Only a terminal session in its own worktree can be approved here".into());
    }
    Ok(())
}

/// Close the terminal's program, wait for it to leave, then commit the session's edits as `approve` does.
pub fn stop_and_approve(agents: &Manager, terms: &term::Manager, worktrees_dir: &Path, id: &str, message: &str) -> Result<String, String> {
    terminal_in_worktree(&agents.info(id)?)?;
    terms.stop(id, STOP_WAIT)?;
    approve(agents, worktrees_dir, id, message)
}

/// Request changes for a terminal session: write the comments to a file in its context folder, close the program if it
/// runs, and start it again in the CLI's resume form with a prompt that points at the file. Returns the file's path.
pub fn request_terminal_changes(agents: &Manager, terms: &term::Manager, id: &str, text: &str) -> Result<PathBuf, String> {
    if text.trim().is_empty() {
        return Err("Write what should change first.".into());
    }
    terminal_in_worktree(&agents.info(id)?)?;
    // A running session cannot be reserved, so the program leaves first.
    terms.stop(id, STOP_WAIT)?;
    let held = agents.reserve(id)?;
    let file = terms.feedback_file(id, text)?;
    terms.resume_with(id, &file, &held)?;
    agents.amend(id, |info| info.review = Some(Review { state: ReviewState::ChangesRequested, commit: None, at: agent::now_ms() }))?;
    Ok(file)
}

/// The user leaves the edits where they are and takes the session out of the queue.
pub fn dismiss(agents: &Manager, id: &str) -> Result<(), String> {
    agents.amend(id, |info| info.review = Some(Review { state: ReviewState::Dismissed, commit: None, at: agent::now_ms() }))?;
    Ok(())
}

/// Reset the session's worktree to its review base and remove what git does not know. Approved work stays.
pub fn discard(agents: &Manager, worktrees_dir: &Path, id: &str) -> Result<(), String> {
    let _held = agents.reserve(id)?;
    let tree = checked_worktree(&agents.info(id)?, worktrees_dir)?;
    checked_for_write(id, &tree)?;
    reset_to_base(&tree)?;
    agents.amend(id, |info| {
        info.files_changed = Some(Totals::default());
        info.review = Some(Review { state: ReviewState::Dismissed, commit: None, at: agent::now_ms() });
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::claude::ClaudeCode;
    use crate::agent::codex::Codex;
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
            let sink = Arc::new(move |emit| sink.lock().unwrap().push(emit));
            (Manager::new(self.sessions.clone(), Arc::new(ClaudeCode), Arc::new(Codex), sink), seen)
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
            interface: crate::agent::Interface::Chat,
            name: None,
            cli_title: None,
            direct: None,
            no_task: false,
            access: None,
            effort: None,
            engine_session: None,
            role: None,
            profile: None,
            summary: None,
            verdict: None,
            origin: None,
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
        let list = files(&manager, &rig.worktrees, &no_direct(), &id(1)).unwrap();
        assert_eq!(paths(&list), ["a.txt", "new.txt"]);
        assert_eq!(manager.info(&id(1)).unwrap().files_changed.map(|totals| totals.files), Some(2));
        assert!(seen.lock().unwrap().iter().any(|emit| matches!(emit, Emit::SessionsChanged)));
        assert_eq!(files(&manager, &rig.worktrees, &no_direct(), &id(2)).unwrap().len(), 2);
        let reopened = manager.info(&id(2)).unwrap();
        assert_eq!(reopened.review.map(|review| (review.state, review.commit)), Some((ReviewState::Pending, None)));
        assert_eq!(reopened.files_changed.map(|totals| totals.files), Some(2));
        assert_eq!(files(&manager, &rig.worktrees, &no_direct(), "../index").unwrap_err(), "Invalid session id");
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

    /// Edits the way an agent leaves them: one file changed, one deleted, one new.
    fn make_edits(tree: &Worktree) {
        let dir = Path::new(&tree.path);
        std::fs::write(dir.join("a.txt"), "one\nTWO\n").unwrap();
        std::fs::remove_file(dir.join("b.txt")).unwrap();
        std::fs::write(dir.join("new.txt"), "fresh\n").unwrap();
    }

    fn head(dir: &Path) -> String {
        sh(dir, &["rev-parse", "HEAD"]).trim().to_string()
    }

    fn status(dir: &Path) -> String {
        sh(dir, &["status", "--porcelain"])
    }

    #[test]
    fn approve_commits_everything_on_the_branch() {
        if !git_available() {
            return;
        }
        let rig = Rig::new();
        let mut tree = rig.tree(1);
        make_edits(&tree);
        let dir = Path::new(&tree.path);
        let (repo_head, repo_status) = (head(&rig.repo), status(&rig.repo));
        let commit = commit_all(&tree, "Prevent duplicate payment alerts").unwrap();
        assert!(is_sha(&commit));
        assert_eq!(commit, head(dir));
        assert_eq!(sh(dir, &["log", "-1", "--format=%s"]).trim(), "Prevent duplicate payment alerts");
        assert_eq!(sh(dir, &["symbolic-ref", "--short", "HEAD"]).trim(), tree.branch);
        assert_eq!((head(&rig.repo), status(&rig.repo)), (repo_head, repo_status));
        tree.reviewed_sha = Some(commit);
        assert_eq!(worktree::changes(&tree).unwrap(), vec![]);
    }

    #[test]
    fn approve_needs_a_message_and_something_to_commit() {
        if !git_available() {
            return;
        }
        let rig = Rig::new();
        let tree = rig.tree(1);
        assert_eq!(commit_all(&tree, "  \n"), Err("Write a commit message first.".to_string()));
        assert_eq!(
            commit_all(&tree, "msg"),
            Err("There is nothing to approve: the worktree matches its base commit.".to_string())
        );
    }

    #[test]
    fn approve_after_the_agent_committed_returns_its_commit() {
        if !git_available() {
            return;
        }
        let rig = Rig::new();
        let tree = rig.tree(1);
        make_edits(&tree);
        let dir = Path::new(&tree.path);
        sh(dir, &["add", "-A"]);
        sh(dir, &["commit", "-q", "-m", "the agent's own commit"]);
        let theirs = head(dir);
        assert_eq!(commit_all(&tree, "my message"), Ok(theirs.clone()));
        assert_eq!(head(dir), theirs);
        assert_eq!(sh(dir, &["rev-list", "--count", &format!("{}..HEAD", tree.base_sha)]).trim(), "1");
    }

    #[test]
    fn approve_without_an_identity_says_how_to_set_one() {
        if !git_available() {
            return;
        }
        let rig = Rig::new();
        let tree = rig.tree(1);
        make_edits(&tree);
        sh(&rig.repo, &["config", "user.name", ""]);
        sh(&rig.repo, &["config", "user.email", ""]);
        assert_eq!(commit_all(&tree, "msg"), Err(NO_IDENTITY.to_string()));
    }

    #[test]
    fn approve_reports_a_failing_hook() {
        if !git_available() {
            return;
        }
        let rig = Rig::new();
        let tree = rig.tree(1);
        make_edits(&tree);
        let hooks = rig.root.join("hooks");
        std::fs::create_dir_all(&hooks).unwrap();
        let hook = hooks.join("pre-commit");
        std::fs::write(&hook, "#!/bin/sh\necho \"hook says no\" >&2\nexit 1\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        sh(&rig.repo, &["config", "core.hooksPath", &hooks.display().to_string().replace('\\', "/")]);
        let error = commit_all(&tree, "msg").unwrap_err();
        assert!(error.starts_with("The commit did not go through:"), "{error}");
        assert!(error.contains("hook says no"), "{error}");
    }

    #[test]
    fn discard_resets_and_removes_untracked() {
        if !git_available() {
            return;
        }
        let rig = Rig::new();
        let tree = rig.tree(1);
        let dir = Path::new(&tree.path);
        std::fs::write(dir.join("later.txt"), "committed after the base\n").unwrap();
        sh(dir, &["add", "-A"]);
        sh(dir, &["commit", "-q", "-m", "after the base"]);
        make_edits(&tree);
        std::fs::create_dir_all(dir.join("junk").join("deep")).unwrap();
        std::fs::write(dir.join("junk").join("deep").join("x.txt"), "x\n").unwrap();
        reset_to_base(&tree).unwrap();
        assert_eq!(worktree::changes(&tree).unwrap(), vec![]);
        assert!(!dir.join("new.txt").exists() && !dir.join("junk").exists() && !dir.join("later.txt").exists());
        assert_eq!(std::fs::read_to_string(dir.join("b.txt")).unwrap().replace("\r\n", "\n"), "bee\n");
        assert_eq!(head(dir), tree.base_sha);
    }

    #[test]
    fn approving_a_session_records_the_commit_as_its_review_base() {
        if !git_available() {
            return;
        }
        let rig = Rig::new();
        let tree = rig.tree(1);
        make_edits(&tree);
        let (manager, seen) = rig.manager(&[session(1, Some(tree.clone()))]);
        let before = seen.lock().unwrap().len();
        let commit = approve(&manager, &rig.worktrees, &id(1), "msg").unwrap();
        let info = manager.info(&id(1)).unwrap();
        let stored = info.worktree.clone().unwrap();
        assert_eq!(info.review.as_ref().map(|review| (review.state, review.commit.clone())), Some((ReviewState::Approved, Some(commit.clone()))));
        assert_eq!(stored.reviewed_sha, Some(commit.clone()));
        assert_eq!(stored.base_sha, tree.base_sha);
        assert_eq!(info.files_changed.map_or(0, |totals| totals.files), 0);
        assert_eq!(worktree::ahead(&stored), Ok(1));
        assert!(seen.lock().unwrap()[before..].iter().any(|emit| matches!(emit, Emit::SessionsChanged)));
        assert_eq!(
            approve(&manager, &rig.worktrees, &id(1), "again"),
            Err("There is nothing to approve: the worktree matches its base commit.".to_string())
        );
        std::fs::write(Path::new(&stored.path).join("a.txt"), "more edits\n").unwrap();
        discard(&manager, &rig.worktrees, &id(1)).unwrap();
        assert_eq!(head(Path::new(&stored.path)), commit);
        assert_eq!(std::fs::read_to_string(Path::new(&stored.path).join("a.txt")).unwrap().replace("\r\n", "\n"), "one\nTWO\n");
    }

    #[test]
    fn discarding_and_dismissing_a_session() {
        if !git_available() {
            return;
        }
        let rig = Rig::new();
        let tree = rig.tree(1);
        make_edits(&tree);
        let (manager, _) = rig.manager(&[session(1, Some(tree.clone()))]);
        dismiss(&manager, &id(1)).unwrap();
        let info = manager.info(&id(1)).unwrap();
        assert_eq!(info.review.map(|review| (review.state, review.commit)), Some((ReviewState::Dismissed, None)));
        assert_eq!(worktree::changes(&tree).unwrap().len(), 3);
        assert_eq!(dismiss(&manager, "../index"), Err("Invalid session id".to_string()));
        assert_eq!(dismiss(&manager, "00000000-0000-4000-8000-000000000009"), Err("Unknown session".to_string()));
        manager.amend(&id(1), |info| info.review = None).unwrap();
        discard(&manager, &rig.worktrees, &id(1)).unwrap();
        let info = manager.info(&id(1)).unwrap();
        assert_eq!(info.review.map(|review| (review.state, review.commit)), Some((ReviewState::Dismissed, None)));
        assert_eq!(info.files_changed.map_or(0, |totals| totals.files), 0);
        assert_eq!(worktree::changes(&tree).unwrap(), vec![]);
    }

    #[test]
    fn a_checkpoint_without_edits_is_the_worktrees_commit() {   // Codex review F7-1
        if !git_available() {
            return;
        }
        let rig = Rig::new();
        let tree = rig.tree(1);
        let (manager, _) = rig.manager(&[session(1, Some(tree.clone()))]);
        assert_eq!(checkpoint(&manager, &rig.worktrees, &id(1), "nothing"), Ok(Some(tree.base_sha.clone())));
        make_edits(&tree);
        let made = checkpoint(&manager, &rig.worktrees, &id(1), "edits").unwrap().unwrap();
        assert_ne!(made, tree.base_sha);
        assert_eq!(head(Path::new(&tree.path)), made);
    }

    #[test]
    fn a_review_action_holds_and_releases_its_session() {
        if !git_available() {
            return;
        }
        let rig = Rig::new();
        let tree = rig.tree(1);
        make_edits(&tree);
        let (manager, _) = rig.manager(&[session(1, Some(tree.clone()))]);
        let (me, root) = (id(1), rig.worktrees.clone());
        let free = |manager: &Manager| assert!(manager.reserve(&me).is_ok());
        assert_eq!(approve(&manager, &root, &me, " "), Err("Write a commit message first.".to_string()));
        free(&manager);

        // While someone else holds the session, nothing is touched.
        let before = worktree::changes(&tree).unwrap();
        let held = manager.reserve(&me).unwrap();
        let busy = "A review action is already running for this session".to_string();
        assert_eq!(approve(&manager, &root, &me, "msg"), Err(busy.clone()));
        assert_eq!(discard(&manager, &root, &me), Err(busy));
        assert_eq!(worktree::changes(&tree).unwrap(), before);
        drop(held);

        sh(&rig.repo, &["config", "user.name", ""]);
        sh(&rig.repo, &["config", "user.email", ""]);
        assert_eq!(approve(&manager, &root, &me, "msg"), Err(NO_IDENTITY.to_string()));
        free(&manager);
        sh(&rig.repo, &["config", "user.name", "Tester"]);
        sh(&rig.repo, &["config", "user.email", "t@example.com"]);

        sh(Path::new(&tree.path), &["checkout", "-q", "-b", "other"]);
        assert!(discard(&manager, &root, &me).unwrap_err().starts_with("The session's worktree is on branch other"));
        free(&manager);
    }

    #[test]
    fn writes_need_the_sessions_own_worktree_and_branch() {
        if !git_available() {
            return;
        }
        let rig = Rig::new();
        let other_repo = Rig::new();
        let id8 = |n: u32| format!("{:08x}", 0x1a2b3c00 + n);
        let (good, branched, detached, renamed, foreign, plain) = (rig.tree(1), rig.tree(2), rig.tree(3), rig.tree(4), rig.tree(5), rig.tree(6));
        sh(Path::new(&branched.path), &["checkout", "-q", "-b", "other"]);
        sh(Path::new(&detached.path), &["checkout", "-q", "--detach"]);
        let not_registered = rig.worktrees.join("plain-folder");
        std::fs::create_dir_all(&not_registered).unwrap();
        let cases = vec![
            (1, good.clone(), None),
            (2, branched, Some(format!("The session's worktree is on branch other, not on its own branch hivemind/{}", id8(2)))),
            (3, detached, Some(format!("The session's worktree is on a detached commit, not on its own branch hivemind/{}", id8(3)))),
            (4, Worktree { branch: "main".into(), ..renamed }, Some("This session's branch name does not match its id: main".to_string())),
            (5, Worktree { repo: other_repo.repo.display().to_string(), ..foreign }, Some(format!("The session's folder is not a worktree of {}", other_repo.repo.display()))),
            (6, Worktree { path: not_registered.display().to_string(), ..plain }, Some(format!("The session's folder is not a worktree of {}", rig.repo.display()))),
        ];
        let infos: Vec<SessionInfo> = cases.iter().map(|(n, tree, _)| session(*n, Some(tree.clone()))).collect();
        let (manager, _) = rig.manager(&infos);
        for (n, tree, expected) in cases {
            let checked = checked_worktree(&session(n, Some(tree.clone())), &rig.worktrees).unwrap();
            assert_eq!(checked_for_write(&id(n), &checked), expected.clone().map_or(Ok(()), Err), "case {n}");
            let Some(expected) = expected else { continue };
            let dir = PathBuf::from(&tree.path);
            if n <= 5 {
                make_edits(&tree);
            }
            let snapshot = |dir: &Path| if n <= 5 { (Some(status(dir)), Some(head(dir))) } else { (None, None) };
            let before = snapshot(&dir);
            assert_eq!(approve(&manager, &rig.worktrees, &id(n), "msg"), Err(expected.clone()), "approve {n}");
            assert_eq!(discard(&manager, &rig.worktrees, &id(n)), Err(expected), "discard {n}");
            assert_eq!(snapshot(&dir), before, "case {n}");
        }
    }

    #[test]
    fn request_changes_needs_text_and_a_session_that_takes_messages() {
        if !git_available() {
            return;
        }
        let rig = Rig::new();
        let ended = SessionInfo { status: Status::Ended, ended_at: Some(2000), ..session(1, Some(rig.tree(1))) };
        let (manager, _) = rig.manager(&[ended]);
        let bridge = Bridge::new(crate::settings::Launch { program: "unused".into(), args: vec![], script: "unused".into(), root: None });
        let saved = Settings::default();
        assert_eq!(request_changes(&manager, &bridge, &saved, &id(1), "  "), Err("Write what should change first.".to_string()));
        assert_eq!(request_changes(&manager, &bridge, &saved, &id(1), "add a test"), Err("This session has ended".to_string()));
        assert_eq!(manager.info(&id(1)).unwrap().review, None);
        assert!(manager.reserve(&id(1)).is_ok());
    }

    // ---- terminal sessions ----

    fn terminals(rig: &Rig, agents: &Manager) -> term::Manager {
        term::Manager::new_in(rig.root.join("terminals"), agents.clone(), rig.root.join("settings.json"), Arc::new(|_| {}), rig.root.join("home"))
    }

    #[test]
    fn stop_and_approve_and_terminal_feedback_refuse_other_sessions() {
        if !git_available() {
            return;
        }
        let rig = Rig::new();
        let tree = rig.tree(1);
        let chat = session(1, Some(tree.clone()));
        let direct = checkout_session(2, &rig.repo, Direct { path: rig.repo.display().to_string(), repo: Some(rig.repo.display().to_string()), head_sha: None, start_tree: None });
        let direct = SessionInfo { interface: agent::Interface::Terminal, ..direct };
        let (manager, _) = rig.manager(&[chat, direct]);
        let terms = terminals(&rig, &manager);
        make_edits(&tree);
        assert_eq!(stop_and_approve(&manager, &terms, &rig.worktrees, &id(1), "msg"), Err("This is not a terminal session".to_string()));
        assert_eq!(stop_and_approve(&manager, &terms, &rig.worktrees, &id(2), "msg"), Err("Only a terminal session in its own worktree can be approved here".to_string()));
        assert_eq!(request_terminal_changes(&manager, &terms, &id(1), "fix"), Err("This is not a terminal session".to_string()));
        assert_eq!(request_terminal_changes(&manager, &terms, &id(2), "fix"), Err("Only a terminal session in its own worktree can be approved here".to_string()));
        assert_eq!(request_terminal_changes(&manager, &terms, &id(2), " "), Err("Write what should change first.".to_string()));
        // Nothing was committed or written.
        assert_eq!(head(Path::new(&tree.path)), head(&rig.repo));
        assert!(!rig.root.join("terminals").join(id(2)).exists());
        assert!(manager.reserve(&id(1)).is_ok());
    }

    #[test]
    fn stop_and_approve_commits_a_terminal_session_that_is_not_running() {
        if !git_available() {
            return;
        }
        let rig = Rig::new();
        let tree = rig.tree(1);
        make_edits(&tree);
        let ended = SessionInfo { interface: agent::Interface::Terminal, status: Status::Ended, ..session(1, Some(tree.clone())) };
        let (manager, _) = rig.manager(&[ended]);
        let terms = terminals(&rig, &manager);
        let commit = stop_and_approve(&manager, &terms, &rig.worktrees, &id(1), "Terminal edits").unwrap();
        assert_eq!(commit, head(Path::new(&tree.path)));
        assert_eq!(manager.info(&id(1)).unwrap().review.map(|review| review.state), Some(ReviewState::Approved));
    }

    #[test]
    fn terminal_feedback_waits_while_another_action_holds_the_session() {
        if !git_available() {
            return;
        }
        let rig = Rig::new();
        let at_rest = SessionInfo { interface: agent::Interface::Terminal, status: Status::Ended, ..session(1, Some(rig.tree(1))) };
        let (manager, _) = rig.manager(&[at_rest]);
        let terms = terminals(&rig, &manager);
        let held = manager.reserve(&id(1)).unwrap();
        assert_eq!(request_terminal_changes(&manager, &terms, &id(1), "fix"), Err("A review action is already running for this session".to_string()));
        assert!(!rig.root.join("terminals").join(id(1)).exists());
        assert_eq!(manager.info(&id(1)).unwrap().review, None);
        drop(held);
    }

    // ---- sessions in the user's own folder ----

    /// A direct session's environment with no project registry and no picked folders.
    fn no_direct() -> DirectEnv<'static> {
        fn nothing(_: &str) -> Result<Value, String> {
            Err("no registry".into())
        }
        DirectEnv { saved: Box::leak(Box::new(Settings::default())), registry: &nothing }
    }

    fn registry_of(repo: &Path) -> impl Fn(&str) -> Result<Value, String> {
        let repos = serde_json::json!({ "repos": [repo.display().to_string()] });
        move |_| Ok(repos.clone())
    }

    fn checkout_session(n: u32, repo: &Path, direct: Direct) -> SessionInfo {
        let task = AgentTask::Work { project: "paystream".into(), repo: repo.display().to_string(), branch: None, change: None };
        SessionInfo { task, direct: Some(direct), status: Status::Ended, ..session(n, None) }
    }

    #[test]
    fn a_direct_review_shows_only_what_changed_after_the_start() {
        if !git_available() {
            return;
        }
        let rig = Rig::new();
        let repo = &rig.repo;
        std::fs::write(repo.join(".gitignore"), "skip.log\n").unwrap();
        std::fs::write(repo.join("a.txt"), "before the session\n").unwrap();
        std::fs::write(repo.join("older.txt"), "also before\n").unwrap();
        let started = direct::describe(repo);
        assert!(started.start_tree.is_some());
        std::fs::write(repo.join("b.txt"), "bee\nafter\n").unwrap();
        std::fs::write(repo.join("new.txt"), "fresh\n").unwrap();
        std::fs::write(repo.join("skip.log"), "ignored\n").unwrap();
        sh(repo, &["status", "--porcelain"]); // lets git refresh its own index before the comparison
        let index = repo.join(".git").join("index");
        let (bytes, porcelain) = (std::fs::read(&index).unwrap(), status(repo));

        let (manager, _) = rig.manager(&[checkout_session(1, repo, started)]);
        let registry = registry_of(repo);
        let saved = Settings::default();
        let env = DirectEnv { saved: &saved, registry: &registry };
        let list = files(&manager, &rig.worktrees, &env, &id(1)).unwrap();
        assert_eq!(paths(&list), ["b.txt", "new.txt"]);
        assert_eq!(list.iter().map(|f| f.status.as_str()).collect::<Vec<_>>(), ["M", "A"]);
        assert_eq!(std::fs::read(&index).unwrap(), bytes, "the real index is byte for byte the same");
        assert_eq!(status(repo), porcelain);
        let both = |base: Option<&str>, head: Option<&str>| FileContents { base: base.map(String::from), head: head.map(String::from), binary: false, too_large: false };
        assert_eq!(file(&manager, &rig.worktrees, &env, &id(1), "b.txt"), Ok(both(Some("bee\n"), Some("bee\nafter\n"))));
        assert_eq!(file(&manager, &rig.worktrees, &env, &id(1), "new.txt"), Ok(both(None, Some("fresh\n"))));
        let not_listed = Err("That file is not one of this session's changes".to_string());
        for path in ["a.txt", "skip.log", "older.txt", "../x"] {
            assert_eq!(file(&manager, &rig.worktrees, &env, &id(1), path), not_listed, "{path}");
        }
        let stored = manager.info(&id(1)).unwrap();
        assert_eq!(stored.files_changed.map(|totals| totals.files), Some(2));
        assert_eq!(stored.review, None, "no decision yet");
        // The same call for the terminal's own bookkeeping sees the same files.
        let started = stored.direct.unwrap();
        assert_eq!(paths(&direct_files_now(&started).unwrap()), ["b.txt", "new.txt"]);
    }

    #[test]
    fn a_direct_review_without_a_start_tree_compares_with_head() {
        if !git_available() {
            return;
        }
        let rig = Rig::new();
        std::fs::write(rig.repo.join("a.txt"), "edited before\n").unwrap();
        let started = Direct { start_tree: None, ..direct::describe(&rig.repo) };
        assert!(started.head_sha.is_some());
        let (manager, _) = rig.manager(&[checkout_session(1, &rig.repo, started)]);
        let registry = registry_of(&rig.repo);
        let saved = Settings::default();
        let env = DirectEnv { saved: &saved, registry: &registry };
        assert_eq!(paths(&files(&manager, &rig.worktrees, &env, &id(1)).unwrap()), ["a.txt"]);
    }

    #[test]
    fn a_folder_git_does_not_know_has_nothing_to_show() {
        let dir = std::env::temp_dir().join(format!("hivemind-review-plain-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        let rig = Rig::new();
        let path = dir.display().to_string();
        let started = Direct { path: path.clone(), repo: None, head_sha: None, start_tree: None };
        let info = SessionInfo { task: AgentTask::Folder { path: path.clone() }, direct: Some(started), status: Status::Ended, ..session(1, None) };
        let (manager, _) = rig.manager(&[info]);
        let saved = Settings { other_folders: Some(vec![path]), ..Default::default() };
        let env = DirectEnv { saved: &saved, registry: no_direct().registry };
        assert_eq!(files(&manager, &rig.worktrees, &env, &id(1)), Ok(vec![]));
        assert_eq!(file(&manager, &rig.worktrees, &env, &id(1), "a.txt"), Err(NOT_GIT.to_string()));
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn a_direct_folder_must_still_be_registered_or_allowed() {
        if !git_available() {
            return;
        }
        let rig = Rig::new();
        let other = Rig::new();
        let started = direct::describe(&rig.repo);
        let checkout = checkout_session(1, &rig.repo, started.clone());
        let check = |registry: &dyn Fn(&str) -> Result<Value, String>, saved: &Settings, info: &SessionInfo| checked_direct(info, &DirectEnv { saved, registry });
        let none = Settings::default();

        let registered = registry_of(&rig.repo);
        assert_eq!(check(&registered, &none, &checkout).unwrap().0, PathBuf::from(&started.path));
        let elsewhere = registry_of(&other.repo);
        let gone = "This folder is no longer one of the project's repositories, so Hivemind will not read it".to_string();
        assert_eq!(check(&elsewhere, &none, &checkout).unwrap_err(), gone);
        assert_eq!(check(&|_| Err("Unknown project: paystream".into()), &none, &checkout).unwrap_err(), "Unknown project: paystream");
        // The registry entry is right, but the session ran somewhere else.
        let moved = checkout_session(1, &rig.repo, Direct { path: other.repo.display().to_string(), ..started.clone() });
        assert_eq!(check(&registered, &none, &moved).unwrap_err(), "The session's folder is not the one its project or folder entry names");
        // A start point that is not an id never reaches git.
        let odd = checkout_session(1, &rig.repo, Direct { start_tree: Some("--all".into()), ..started });
        assert_eq!(check(&registered, &none, &odd).unwrap_err(), "The session's start point is not a commit or tree id");

        let path = rig.repo.display().to_string();
        let folder = SessionInfo { task: AgentTask::Folder { path: path.clone() }, ..checkout };
        let refused = "This folder is no longer one of your other folders, so Hivemind will not read it".to_string();
        assert_eq!(check(&registered, &none, &folder).unwrap_err(), refused);
        let wrong = Settings { other_folders: Some(vec![other.repo.display().to_string()]), ..Default::default() };
        assert_eq!(check(&registered, &wrong, &folder).unwrap_err(), refused);
        let right = Settings { other_folders: Some(vec![path]), ..Default::default() };
        assert!(check(&registered, &right, &folder).is_ok());
        assert_eq!(check(&registered, &none, &session(1, None)).unwrap_err(), "This session does not run in your own folder");
    }
}
