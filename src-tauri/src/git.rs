//! Read-only git and GitHub activity for a project's repos. Repo paths come from Living Memory
//! (`projects`), never from the webview.
use crate::bridge::Bridge;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

const MAX_REPOS: usize = 10;
const TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Serialize, Debug, PartialEq)]
pub struct Commit {
    pub sha: String,
    pub author: String,
    pub date: String,
    pub subject: String,
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Pr {
    pub number: u64,
    pub title: String,
    pub state: String,
    pub url: String,
    pub updated_at: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RepoActivity {
    pub repo: String,
    pub commits: Option<Vec<Commit>>,
    pub error: Option<String>,
    pub prs: Option<Vec<Pr>>,
    pub prs_error: Option<String>,
}

/// Records are separated by \x1e and fields by \x1f; malformed records are skipped.
pub fn parse_log(text: &str) -> Vec<Commit> {
    text.split('\x1e')
        .filter_map(|record| {
            let record = record.trim_start_matches(['\r', '\n']);
            let mut fields = record.split('\x1f');
            let (sha, author, date, subject) = (fields.next()?, fields.next()?, fields.next()?, fields.next()?);
            if sha.is_empty() || fields.next().is_some() {
                return None;
            }
            Some(Commit { sha: sha.into(), author: author.into(), date: date.into(), subject: subject.into() })
        })
        .collect()
}

pub fn drain<R: Read + Send + 'static>(pipe: Option<R>) -> std::thread::JoinHandle<String> {
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut p) = pipe {
            let _ = p.read_to_end(&mut buf);
        }
        String::from_utf8_lossy(&buf).into_owned()
    })
}

/// What a finished command printed and how it ended.
pub struct Ran {
    pub status: std::process::ExitStatus,
    pub stdout: String,
    pub stderr: String,
}

const DRAIN_GRACE: Duration = Duration::from_secs(2); // how long to wait for output once a command is over

/// Kill a child and everything it started. A commit hook that outlives git would otherwise keep the output pipes open.
pub(crate) fn kill_tree(child: &mut Child) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let _ = Command::new("taskkill")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .status();
    }
    #[cfg(not(windows))]
    {
        // The command was started in its own process group; a minus sign addresses the whole group.
        let _ = Command::new("kill")
            .args(["-KILL", &format!("-{}", child.id())])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// The text a reader thread collected, or nothing when something still holds the pipe after `grace`.
fn collect(reader: std::thread::JoinHandle<String>, grace: Duration) -> String {
    let start = Instant::now();
    while !reader.is_finished() && start.elapsed() < grace {
        std::thread::sleep(Duration::from_millis(20));
    }
    if reader.is_finished() { reader.join().unwrap_or_default() } else { String::new() }
}

/// Run a command to its end, or kill it after `timeout`. An error means it could not start or it timed out.
pub fn run_captured(command: Command, timeout: Duration) -> Result<Ran, String> {
    run_with_input(command, None, timeout)
}

/// How a run that could not start says so (`Could not run git: ...`), so a caller can tell it from a timeout.
pub const COULD_NOT_RUN: &str = "Could not run";

/// `run_captured` with `input` written to the command's stdin (then closed); stdin is empty when None.
pub fn run_with_input(command: Command, input: Option<&str>, timeout: Duration) -> Result<Ran, String> {
    run_cancellable(command, input, timeout, None).map_err(String::from)
}

/// Why `run_cancellable` has no result: the process never started (so it cost nothing), or it started and was stopped (a
/// timeout, a cancel) or could not be watched.
pub enum Failure {
    NotStarted(String),
    Stopped(String),
}

impl From<Failure> for String {
    fn from(failure: Failure) -> String {
        match failure {
            Failure::NotStarted(e) | Failure::Stopped(e) => e,
        }
    }
}

/// `run_with_input` that also stops (killing the process tree) once `cancel` is set. A cancel set before the process
/// starts means it never does.
pub fn run_cancellable(mut command: Command, input: Option<&str>, timeout: Duration, cancel: Option<&AtomicBool>) -> Result<Ran, Failure> {
    command
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let name = command.get_program().to_string_lossy().into_owned();
    let cancelled_now = || cancel.is_some_and(|c| c.load(Ordering::Relaxed));
    if cancelled_now() {
        return Err(Failure::NotStarted(format!("{name} was cancelled")));
    }
    let mut child = command.spawn().map_err(|e| Failure::NotStarted(format!("{COULD_NOT_RUN} {name}: {e}")))?;
    if let (Some(text), Some(mut pipe)) = (input, child.stdin.take()) {
        let text = text.to_string();
        // A thread, so a child that never reads cannot block us past the timeout; dropping the pipe closes stdin.
        std::thread::spawn(move || {
            use std::io::Write;
            let _ = pipe.write_all(text.as_bytes());
        });
    }
    let out = drain(child.stdout.take());
    let err = drain(child.stderr.take());
    let start = Instant::now();
    let mut cancelled = false;
    let status = loop {
        match child.try_wait().map_err(|e| Failure::Stopped(e.to_string()))? {
            Some(status) => break Some(status),
            None if cancelled_now() => {
                kill_tree(&mut child);
                cancelled = true;
                break None;
            }
            None if start.elapsed() >= timeout => {
                kill_tree(&mut child);
                break None;
            }
            None => std::thread::sleep(Duration::from_millis(20)),
        }
    };
    let (stdout, stderr) = (collect(out, DRAIN_GRACE), collect(err, DRAIN_GRACE));
    match status {
        None if cancelled => Err(Failure::Stopped(format!("{name} was cancelled"))),
        None => Err(Failure::Stopped(format!("{name} timed out after {}s", timeout.as_secs()))),
        Some(status) => Ok(Ran { status, stdout, stderr }),
    }
}

/// Run a command, returning stdout. Kills it after `timeout`; non-zero exit is an error.
pub fn run_with_timeout(command: Command, timeout: Duration) -> Result<String, String> {
    let name = command.get_program().to_string_lossy().into_owned();
    let ran = run_captured(command, timeout)?;
    if ran.status.success() {
        return Ok(ran.stdout);
    }
    let line = ran.stderr.lines().find(|l| !l.trim().is_empty()).unwrap_or("").trim();
    Err(if line.is_empty() { format!("{name} exited with {}", ran.status) } else { line.to_string() })
}

/// True for a full commit id: 40 or 64 hex characters.
pub fn is_sha(text: &str) -> bool {
    matches!(text.len(), 40 | 64) && text.bytes().all(|b| b.is_ascii_hexdigit())
}

/// The commit a repository's HEAD points at.
pub fn head_sha(repo: &Path) -> Result<String, String> {
    let mut command = crate::worktree::git_command();
    command.arg("-C").arg(repo).args(["rev-parse", "HEAD"]);
    let text = run_with_timeout(command, TIMEOUT)?;
    Some(text.trim()).filter(|sha| is_sha(sha)).map(String::from).ok_or_else(|| "git did not print a commit id".to_string())
}

/// The next commit review after `reviewed` (the commit ids already reviewed up to, as tips): up to `limit` commits that HEAD
/// has and the tips do not, oldest first (parents before children), and the tips that cover everything reviewed once
/// those are too (`merge-base --independent`). Empty commits when HEAD has nothing new. Because parents come first, what
/// is reviewed stays closed under ancestry, so no commit is skipped or reviewed twice, across merges and branch switches.
/// When none of the reviewed tips is left (history was rewritten), nothing is reviewed and HEAD becomes the only tip, as on a
/// first look.
pub fn next_batch(repo: &Path, reviewed: &[&str], limit: usize) -> Result<(Vec<String>, Vec<String>), String> {
    let reviewed = live_tips(repo, reviewed)?;
    if reviewed.is_empty() {
        return Ok((vec![], vec![head_sha(repo)?]));
    }
    let reviewed: Vec<&str> = reviewed.iter().map(String::as_str).collect();
    let mut command = crate::worktree::git_command();
    command.arg("-C").arg(repo).args(["rev-list", "--reverse", "--topo-order", "HEAD", "--not"]).args(&reviewed);
    let text = run_with_timeout(command, TIMEOUT)?;
    let batch: Vec<String> = text.lines().map(str::trim).filter(|sha| is_sha(sha)).take(limit).map(String::from).collect();
    if batch.is_empty() {
        return Ok((batch, reviewed.iter().map(|sha| sha.to_string()).collect()));
    }
    let mut command = crate::worktree::git_command();
    command.arg("-C").arg(repo).args(["merge-base", "--independent"]).args(&reviewed).args(&batch);
    let tips = run_with_timeout(command, TIMEOUT)?.lines().map(str::trim).filter(|sha| is_sha(sha)).map(String::from).collect();
    Ok((batch, tips))
}

/// The reviewed tips that are full commit ids and still name a commit in `repo`. Anything else is never passed to git (so a
/// stored value cannot become an option), and a tip git reports missing (a pruned branch) is dropped so the others keep
/// working. Git failing (a timeout, a broken repository) is an error, not a missing tip.
pub fn live_tips(repo: &Path, tips: &[&str]) -> Result<Vec<String>, String> {
    let ids: Vec<&str> = tips.iter().copied().filter(|sha| is_sha(sha)).collect();
    if ids.is_empty() {
        return Ok(vec![]);
    }
    let mut command = crate::worktree::git_command();
    command.arg("-C").arg(repo).args(["cat-file", "--batch-check"]);
    let ran = run_with_input(command, Some(&format!("{}\n", ids.join("\n"))), TIMEOUT)?;
    if !ran.status.success() {
        return Err(format!("git cat-file failed: {}", ran.stderr.trim()));
    }
    // One line per id, in order: "<id> commit <size>", or "<id> missing".
    Ok(ran.stdout.lines().filter_map(|line| {
        let mut words = line.split_whitespace();
        let sha = words.next()?;
        (words.next() == Some("commit") && ids.contains(&sha)).then(|| sha.to_string())
    }).collect())
}

/// `git rev-list --count <selector...>` in `repo`, e.g. `["abc..HEAD"]` or `["--since=@1794322874", "HEAD"]`.
pub fn rev_count(repo: &Path, selector: &[&str]) -> Result<u64, String> {
    let mut command = crate::worktree::git_command();
    command.arg("-C").arg(repo).args(["rev-list", "--count"]).args(selector);
    run_with_timeout(command, TIMEOUT)?.trim().parse().map_err(|_| "git did not print a number".to_string())
}

fn commits_for(repo: &Path) -> Result<Vec<Commit>, String> {
    let mut command = crate::worktree::git_command();
    command
        .arg("-C")
        .arg(repo)
        .args(["log", "--since=30.days", "--max-count=50", "--no-color", "--pretty=format:%H%x1f%an%x1f%aI%x1f%s%x1e"]);
    run_with_timeout(command, TIMEOUT).map(|text| parse_log(&text))
}

fn prs_for(repo: &Path) -> Result<Vec<Pr>, String> {
    let mut command = Command::new("gh");
    command
        .args(["pr", "list", "--state", "all", "--limit", "10", "--json", "number,title,state,url,updatedAt"])
        .current_dir(repo);
    let text = run_with_timeout(command, TIMEOUT)?;
    serde_json::from_str(&text).map_err(|e| format!("Unreadable gh output: {e}"))
}

pub fn activity_for_repos(repos: &[PathBuf]) -> Vec<RepoActivity> {
    repos
        .iter()
        .take(MAX_REPOS)
        .map(|repo| {
            let (commits, error) = match commits_for(repo) {
                Ok(c) => (Some(c), None),
                Err(e) => (None, Some(e)),
            };
            let (prs, prs_error) = match prs_for(repo) {
                Ok(p) => (Some(p), None),
                Err(e) => (None, Some(e)),
            };
            RepoActivity { repo: repo.display().to_string(), commits, error, prs, prs_error }
        })
        .collect()
}

/// One project's registry entry from Living Memory (`projects`), by slug.
pub fn project_entry(bridge: &Bridge, slug: &str) -> Result<Value, String> {
    let reply = bridge.call(&["projects".into(), "--actor".into(), "viewer".into()], None)?;
    if reply.exit_code != 0 {
        return Err(format!("Living Memory could not list projects (is it up to date?): {}", reply.error));
    }
    reply
        .result
        .get("projects")
        .and_then(Value::as_array)
        .and_then(|all| all.iter().find(|p| p.get("slug").and_then(Value::as_str) == Some(slug)))
        .cloned()
        .ok_or_else(|| format!("Unknown project: {slug}"))
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Branches {
    pub current: Option<String>,
    pub branches: Vec<String>,
}

/// The local branches of a repository and the one checked out (None on a detached HEAD).
pub fn branches(repo: &Path) -> Result<Branches, String> {
    let run = |args: &[&str]| {
        let mut command = crate::worktree::git_command();
        command.arg("-C").arg(repo).args(args);
        run_with_timeout(command, TIMEOUT)
    };
    if run(&["rev-parse", "--is-inside-work-tree"]).map(|s| s.trim() == "true") != Ok(true) {
        return Err(format!("Not a git repository: {}", repo.display()));
    }
    let current = run(&["symbolic-ref", "--quiet", "--short", "HEAD"]).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let list = run(&["for-each-ref", "--format=%(refname:short)", "refs/heads"])?;
    Ok(Branches { current, branches: list.lines().map(str::trim).filter(|l| !l.is_empty()).map(String::from).collect() })
}

/// Look up the project's repo paths in Living Memory, then collect their activity.
pub fn git_activity(bridge: &Bridge, slug: &str) -> Result<Vec<RepoActivity>, String> {
    let project = project_entry(bridge, slug)?;
    let repos: Vec<PathBuf> = project
        .get("repos")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).map(PathBuf::from).collect())
        .unwrap_or_default();
    Ok(activity_for_repos(&repos))
}

// ---- the history of one file (NS-5) ----

/// Commits one file's log shows at most.
const FILE_LOG_LIMIT: usize = 100;
const COMMIT_TIMEOUT: Duration = Duration::from_secs(120);

/// A commit that touched one file, with the file's path in the repository at that commit (it differs from today's after a
/// rename).
#[derive(Serialize, Debug, PartialEq, Clone)]
pub struct FileCommit {
    pub sha: String,
    pub author: String,
    /// Strict ISO 8601.
    pub date: String,
    pub subject: String,
    pub path: String,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileLog {
    /// The work tree the file is in; None when it is not in one (or git is not installed).
    pub repo: Option<String>,
    pub commits: Vec<FileCommit>,
    /// The file differs from the last commit: it is modified, or not in the repository yet.
    pub changed: bool,
}

/// A file's folder and name. Every git command about the file runs in that folder with the name as a literal pathspec, so
/// no character of the name (`*`, `?`, `[`, `:`) is read as a pattern or as pathspec syntax.
pub fn beside(full: &Path) -> Result<(PathBuf, String), String> {
    let dir = full.parent().ok_or_else(|| format!("{} has no folder", full.display()))?;
    let name = full.file_name().map(|n| n.to_string_lossy().into_owned()).ok_or_else(|| format!("{} has no name", full.display()))?;
    Ok((dir.to_path_buf(), name))
}

fn literal(name: &str) -> String {
    format!(":(literal){name}")
}

fn git_in(dir: &Path, args: &[&str]) -> Command {
    let mut command = crate::worktree::git(dir);
    command.args(args);
    command
}

/// The work tree `dir` is inside, or None when it is in none or git cannot be run.
pub fn work_tree(dir: &Path) -> Result<Option<String>, String> {
    let ran = match run_captured(git_in(dir, &["rev-parse", "--show-toplevel"]), TIMEOUT) {
        Ok(ran) => ran,
        Err(e) if e.starts_with(COULD_NOT_RUN) => return Ok(None),
        Err(e) => return Err(e),
    };
    let top = ran.stdout.trim();
    Ok(ran.status.success().then_some(top).filter(|t| !t.is_empty()).map(String::from))
}

/// A path as `git log --name-only` prints it: plain, or in double quotes with C escapes (octal for bytes).
fn unquote(text: &str) -> String {
    let Some(inner) = text.strip_prefix('"').and_then(|t| t.strip_suffix('"')) else { return text.to_string() };
    let (mut out, bytes) = (Vec::new(), inner.as_bytes());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'\\' || i + 1 >= bytes.len() {
            out.push(bytes[i]);
            i += 1;
            continue;
        }
        i += 1;
        match bytes[i] {
            b'n' => out.push(b'\n'),
            b't' => out.push(b'\t'),
            b'0'..=b'7' => {
                let digits = bytes[i..].iter().take(3).take_while(|b| (b'0'..=b'7').contains(b)).count();
                out.push(u8::from_str_radix(&inner[i..i + digits], 8).unwrap_or(b'?'));
                i += digits - 1;
            }
            other => out.push(other),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The commits of `git log --follow --name-only --format=%x1e%H%x1f%an%x1f%aI%x1f%s`; a record without a path is skipped.
fn parse_file_log(text: &str) -> Vec<FileCommit> {
    text.split('\x1e')
        .filter_map(|record| {
            let mut lines = record.lines();
            let mut fields = lines.next()?.split('\x1f');
            let (sha, author, date, subject) = (fields.next()?, fields.next()?, fields.next()?, fields.next()?);
            let path = lines.map(str::trim_end).find(|l| !l.is_empty())?;
            (!sha.is_empty() && fields.next().is_none()).then(|| FileCommit { sha: sha.into(), author: author.into(), date: date.into(), subject: subject.into(), path: unquote(path) })
        })
        .collect()
}

/// The newest commits that touched the file `name` of `dir`, following renames, and whether it has uncommitted changes.
pub fn file_log(dir: &Path, name: &str) -> Result<FileLog, String> {
    let Some(repo) = work_tree(dir)? else { return Ok(FileLog { repo: None, commits: Vec::new(), changed: false }) };
    let spec = literal(name);
    let limit = FILE_LOG_LIMIT.to_string();
    let ran = run_captured(git_in(dir, &["log", "--follow", "-n", &limit, "--name-only", "--format=%x1e%H%x1f%an%x1f%aI%x1f%s", "--", &spec]), TIMEOUT)?;
    // A repository with no commit yet has no log, and every file in it is new.
    let commits = if ran.status.success() {
        parse_file_log(&ran.stdout)
    } else if ran.stderr.contains("does not have any commits yet") {
        Vec::new()
    } else {
        return Err(ran.stderr.lines().find(|l| !l.trim().is_empty()).unwrap_or("git log failed").trim().to_string());
    };
    let changed = !run_with_timeout(git_in(dir, &["status", "--porcelain", "--", &spec]), TIMEOUT)?.trim().is_empty();
    Ok(FileLog { repo: Some(repo), commits, changed })
}

/// The file as commit `sha` held it (`git show <sha>:<path>`, the path the file had then). Output is read as text, so
/// bytes that are not UTF-8 come back replaced.
pub fn file_version(dir: &Path, name: &str, sha: &str) -> Result<String, String> {
    if !is_sha(sha) {
        return Err("That is not a commit id".into());
    }
    let log = file_log(dir, name)?;
    let commit = log.commits.iter().find(|c| c.sha == sha).ok_or("That commit does not touch this file")?;
    let object = format!("{sha}:{}", commit.path);
    let size = run_with_timeout(git_in(dir, &["cat-file", "-s", &object]), TIMEOUT)?;
    if size.trim().parse::<u64>().is_ok_and(|n| n > crate::history::MAX_SNAPSHOT) {
        return Err("This version is larger than 16 MB, so Hivemind does not show it".into());
    }
    run_with_timeout(git_in(dir, &["show", &object]), TIMEOUT)
}

/// What a failed commit or add said: the identity message when that is the reason, else the last lines of its output.
fn failure(what: &str, ran: &Ran) -> String {
    if ran.stderr.contains("Author identity unknown") || ran.stderr.contains("empty ident name") {
        return crate::review::NO_IDENTITY.to_string();
    }
    let lines: Vec<&str> = ran.stderr.lines().chain(ran.stdout.lines()).map(str::trim_end).filter(|l| !l.trim().is_empty()).collect();
    format!("{what}:\n{}", lines[lines.len().saturating_sub(10)..].join("\n"))
}

/// Commit the file `name` of `dir` and nothing else (`git commit --only`, so changes staged for other files stay staged);
/// a file git does not know yet is added first. Returns the new commit's id. Never pushes.
pub fn file_commit(dir: &Path, name: &str, message: &str) -> Result<String, String> {
    if message.trim().is_empty() {
        return Err("Write a commit message first.".into());
    }
    if work_tree(dir)?.is_none() {
        return Err("This file is not in a git repository.".into());
    }
    let spec = literal(name);
    let tracked = run_captured(git_in(dir, &["ls-files", "--error-unmatch", "--", &spec]), TIMEOUT)?.status.success();
    if tracked {
        if run_with_timeout(git_in(dir, &["status", "--porcelain", "--", &spec]), TIMEOUT)?.trim().is_empty() {
            return Err("There is nothing to commit: this file matches the last commit.".into());
        }
    } else {
        let added = run_captured(git_in(dir, &["add", "-N", "--", &spec]), TIMEOUT)?;
        if !added.status.success() {
            return Err(failure("Git did not add the file", &added));
        }
    }
    let ran = run_captured(git_in(dir, &["commit", "--only", "-m", message, "--", &spec]), COMMIT_TIMEOUT)?;
    if !ran.status.success() {
        // The file was only marked as to be added: leave the index as it was.
        if !tracked {
            let _ = run_captured(git_in(dir, &["reset", "-q", "--", &spec]), TIMEOUT);
        }
        return Err(failure("The commit did not go through", &ran));
    }
    let head = run_with_timeout(git_in(dir, &["rev-parse", "HEAD"]), TIMEOUT)?.trim().to_string();
    if is_sha(&head) { Ok(head) } else { Err("git did not print a commit id".into()) }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(sha: &str, subject: &str) -> String {
        format!("{sha}\x1fAda\x1f2026-01-02T03:04:05+00:00\x1f{subject}\x1e")
    }

    #[test]
    fn parses_records_and_trims_newlines() {
        let text = format!("{}\n{}", record("aaa", "First"), record("bbb", "Second"));
        let commits = parse_log(&text);
        assert_eq!(commits.len(), 2);
        assert_eq!(
            commits[1],
            Commit { sha: "bbb".into(), author: "Ada".into(), date: "2026-01-02T03:04:05+00:00".into(), subject: "Second".into() }
        );
    }

    #[test]
    fn empty_output_is_no_commits() {
        assert!(parse_log("").is_empty());
        assert!(parse_log("\n").is_empty());
    }

    #[test]
    fn keeps_odd_subjects() {
        let commits = parse_log(&record("aaa", "fix: \"quotes\" & <tags> ünï 日本 | pipe"));
        assert_eq!(commits[0].subject, "fix: \"quotes\" & <tags> ünï 日本 | pipe");
    }

    #[test]
    fn skips_malformed_records() {
        let text = format!("garbage\x1e\x1fa\x1fb\x1fc\x1ea\x1fb\x1fc\x1fd\x1fe\x1e{}", record("ok", "x"));
        let commits = parse_log(&text);
        assert_eq!(commits.len(), 1);
        assert_eq!(commits[0].sha, "ok");
    }

    #[test]
    fn timeout_kills_a_long_process() {
        let mut command;
        if cfg!(windows) {
            command = Command::new("ping");
            command.args(["-n", "30", "127.0.0.1"]);
        } else {
            command = Command::new("sleep");
            command.arg("30");
        }
        let start = Instant::now();
        let result = run_with_timeout(command, Duration::from_secs(1));
        assert!(result.unwrap_err().contains("timed out"));
        assert!(start.elapsed() < Duration::from_secs(10));
    }

    #[test]
    fn a_cancel_kills_a_long_process() {   // EXEC-5
        let mut command;
        if cfg!(windows) {
            command = Command::new("ping");
            command.args(["-n", "30", "127.0.0.1"]);
        } else {
            command = Command::new("sleep");
            command.arg("30");
        }
        let cancel = AtomicBool::new(false);
        let start = Instant::now();
        let result = std::thread::scope(|s| {
            s.spawn(|| {
                std::thread::sleep(Duration::from_millis(300));
                cancel.store(true, Ordering::Relaxed);
            });
            run_cancellable(command, None, Duration::from_secs(60), Some(&cancel))
        });
        assert!(matches!(&result, Err(Failure::Stopped(e)) if e.contains("was cancelled")));
        assert!(start.elapsed() < Duration::from_secs(10));
        // Never started: a cancel before the spawn, or a program that does not run, whatever its name says (Codex review of
        // 5118618 and 74bba49).
        let early = run_cancellable(Command::new("git"), None, Duration::from_secs(5), Some(&cancel));
        assert!(matches!(early, Err(Failure::NotStarted(_))));
        let missing = run_cancellable(Command::new("Could not run x"), None, Duration::from_secs(5), None);
        assert!(matches!(missing, Err(Failure::NotStarted(_))));
    }

    fn git_available() -> bool {
        Command::new("git").arg("--version").output().map(|o| o.status.success()).unwrap_or(false)
    }

    fn git(dir: &Path, args: &[&str]) {
        let out = Command::new("git").arg("-C").arg(dir).args(args).output().unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    }

    fn batch_repo(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hivemind-git-{name}-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        for args in [&["init", "-q", "-b", "main"][..], &["config", "user.name", "Tester"], &["config", "user.email", "t@example.com"], &["config", "commit.gpgsign", "false"]] {
            git(&dir, args);
        }
        dir
    }

    fn commit(dir: &Path, message: &str) -> String {
        git(dir, &["commit", "-q", "--allow-empty", "-m", message]);
        head_sha(dir).unwrap()
    }

    /// Review `dir` from `reviewed` in batches of `limit` until caught up: the batches, and the tips at the end.
    fn drain(dir: &Path, mut reviewed: Vec<String>, limit: usize) -> (Vec<Vec<String>>, Vec<String>) {
        let mut batches = vec![];
        loop {
            let tips: Vec<&str> = reviewed.iter().map(String::as_str).collect();
            let (batch, next) = next_batch(dir, &tips, limit).unwrap();
            if batch.is_empty() {
                return (batches, reviewed);
            }
            assert!(batches.len() < 10, "the review goes round in circles: {batches:?}");
            batches.push(batch);
            reviewed = next;
        }
    }

    #[test]
    fn a_backlog_is_reviewed_oldest_first_in_batches() {   // HIDE-14
        if !git_available() {
            return;
        }
        let dir = batch_repo("batch");
        let shas: Vec<String> = (1..=6).map(|n| commit(&dir, &format!("c{n}"))).collect();
        let (batches, tips) = drain(&dir, vec![shas[0].clone()], 2);
        assert_eq!(batches, [shas[1..3].to_vec(), shas[3..5].to_vec(), shas[5..6].to_vec()], "oldest first, two at a time");
        assert_eq!(tips, [shas[5].clone()], "caught up at HEAD");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn every_commit_of_a_merge_is_reviewed_once() {   // HIDE-14, Codex reviews of f07f22e and 9134b3c
        if !git_available() {
            return;
        }
        let dir = batch_repo("merge");
        let base = commit(&dir, "base");
        git(&dir, &["checkout", "-q", "-b", "side"]);
        let side: Vec<String> = (1..=5).map(|n| commit(&dir, &format!("b{n}"))).collect();
        git(&dir, &["checkout", "-q", "main"]);
        let main: Vec<String> = (1..=3).map(|n| commit(&dir, &format!("a{n}"))).collect();
        git(&dir, &["merge", "-q", "--no-ff", "-m", "merge", "side"]);
        let merge = head_sha(&dir).unwrap();
        // A merge larger than a batch is split across runs, and no run repeats a commit.
        let (batches, tips) = drain(&dir, vec![base.clone()], 2);
        let mut all: Vec<String> = batches.concat();
        assert!(batches.iter().all(|b| b.len() <= 2), "{batches:?}");
        assert_eq!(all.last(), Some(&merge), "the merge comes after everything it brings in");
        all.sort();
        let mut expected = [side.clone(), main.clone(), vec![merge.clone()]].concat();
        expected.sort();
        assert_eq!(all, expected, "each new commit exactly once");
        assert_eq!(tips, std::slice::from_ref(&merge));

        // Reviewed up to a side-branch commit (the branch was checked out then): those are not reviewed again.
        let (batches, _) = drain(&dir, vec![side[2].clone()], 30);
        let again: Vec<String> = batches.concat();
        assert!(!again.iter().any(|sha| side[..3].contains(sha) || sha == &base), "{again:?}");
        assert_eq!(again.len(), side.len() - 3 + main.len() + 1);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn only_live_commit_ids_are_passed_to_git() {   // HIDE-14, Codex review of c8a7ca5
        if !git_available() {
            return;
        }
        let dir = batch_repo("tips");
        let first = commit(&dir, "c1");
        let gone = "0123456789abcdef0123456789abcdef01234567";
        let kept = live_tips(&dir, &["--output=x", "HEAD", &first[..7], gone, &first]).unwrap();
        assert_eq!(kept, std::slice::from_ref(&first), "options, names, short ids and pruned commits are dropped");
        let second = commit(&dir, "c2");
        // A pruned tip beside a live one: the live one still bounds the batch.
        assert_eq!(next_batch(&dir, &[gone, &first], 30).unwrap(), (vec![second.clone()], vec![second.clone()]));
        // Every tip gone: start again from HEAD, reviewing nothing.
        assert_eq!(next_batch(&dir, &[gone], 30).unwrap(), (vec![], vec![second]));
        assert!(!dir.join("x").exists());
        // Git failing is an error, not a missing tip, so the cursor stays (Codex re-review of b3f5b40).
        assert!(live_tips(&dir.join("no-such-folder"), &[&first]).is_err());
        assert!(next_batch(&dir.join("no-such-folder"), &[&first], 30).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn live_repo_gives_commits() {
        if !git_available() {
            return;
        }
        let dir = std::env::temp_dir().join(format!("hivemind-git-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        git(&dir, &["init", "-q"]);
        git(&dir, &["config", "user.name", "Tester"]);
        git(&dir, &["config", "user.email", "t@example.com"]);
        git(&dir, &["config", "commit.gpgsign", "false"]);
        for n in 1..=2 {
            std::fs::write(dir.join("f.txt"), n.to_string()).unwrap();
            git(&dir, &["add", "."]);
            git(&dir, &["commit", "-q", "-m", &format!("commit {n}")]);
        }
        let activity = activity_for_repos(std::slice::from_ref(&dir));
        std::fs::remove_dir_all(&dir).ok();
        let a = &activity[0];
        assert!(a.error.is_none(), "{:?}", a.error);
        let commits = a.commits.as_ref().unwrap();
        assert_eq!(commits.len(), 2);
        assert_eq!(commits[0].subject, "commit 2");
        assert_eq!(commits[0].author, "Tester");
        assert!(a.prs.is_some() || a.prs_error.is_some());
    }

    #[test]
    fn lists_branches_and_the_current_one() {
        if !git_available() {
            return;
        }
        let dir = std::env::temp_dir().join(format!("hivemind-branches-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        git(&dir, &["init", "-q"]);
        git(&dir, &["symbolic-ref", "HEAD", "refs/heads/main"]);
        git(&dir, &["config", "user.name", "Tester"]);
        git(&dir, &["config", "user.email", "t@example.com"]);
        git(&dir, &["config", "commit.gpgsign", "false"]);
        std::fs::write(dir.join("f.txt"), "1").unwrap();
        git(&dir, &["add", "."]);
        git(&dir, &["commit", "-q", "-m", "first"]);
        git(&dir, &["branch", "feature/x"]);
        let attached = branches(&dir);
        git(&dir, &["checkout", "-q", "--detach"]);
        let detached = branches(&dir);
        std::fs::remove_dir_all(&dir).ok();
        assert_eq!(attached, Ok(Branches { current: Some("main".into()), branches: vec!["feature/x".into(), "main".into()] }));
        assert_eq!(detached.unwrap().current, None);
        let plain = std::env::temp_dir().join(format!("hivemind-branches-plain-{}", std::process::id()));
        std::fs::create_dir_all(&plain).unwrap();
        let error = branches(&plain);
        std::fs::remove_dir_all(&plain).ok();
        assert_eq!(error, Err(format!("Not a git repository: {}", plain.display())));
    }

    #[test]
    fn captured_run_keeps_status_and_both_streams() {
        if !git_available() {
            return;
        }
        let mut command = Command::new("git");
        command.arg("--version");
        let ran = run_captured(command, Duration::from_secs(10)).unwrap();
        assert!(ran.status.success() && ran.stdout.starts_with("git version"), "{}", ran.stdout);
        let dir = std::env::temp_dir().join(format!("hivemind-captured-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut command = Command::new("git");
        command.arg("-C").arg(&dir).args(["rev-parse", "--verify", "nothing-here"]);
        let ran = run_captured(command, Duration::from_secs(10)).unwrap();
        std::fs::remove_dir_all(&dir).ok();
        assert!(!ran.status.success());
        assert!(!ran.stderr.is_empty());
    }

    #[test]
    fn timeout_kills_a_hook_that_outlives_git() {
        if !git_available() {
            return;
        }
        let dir = std::env::temp_dir().join(format!("hivemind-hook-{}", std::process::id()));
        let (repo, hooks) = (dir.join("repo"), dir.join("hooks"));
        std::fs::create_dir_all(&repo).unwrap();
        std::fs::create_dir_all(&hooks).unwrap();
        git(&repo, &["init", "-q"]);
        git(&repo, &["config", "user.name", "Tester"]);
        git(&repo, &["config", "user.email", "t@example.com"]);
        git(&repo, &["config", "commit.gpgsign", "false"]);
        git(&repo, &["config", "core.autocrlf", "false"]);
        git(&repo, &["commit", "-q", "--allow-empty", "-m", "first"]);
        let hook = hooks.join("pre-commit");
        std::fs::write(&hook, "#!/bin/sh\nsleep 30\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let mut command = Command::new("git");
        command.arg("-C").arg(&repo).arg("-c").arg(format!("core.hooksPath={}", hooks.display()));
        command.args(["commit", "--allow-empty", "-m", "x"]);
        let start = Instant::now();
        let result = run_captured(command, Duration::from_secs(2));
        let took = start.elapsed();
        std::fs::remove_dir_all(&dir).ok();
        assert!(result.err().is_some_and(|e| e.contains("timed out")));
        assert!(took < Duration::from_secs(10), "{took:?}");
    }

    #[test]
    fn sha_check() {
        assert!(is_sha(&"a".repeat(40)));
        assert!(is_sha(&"0123456789abcdef".repeat(4)));
        assert!(!is_sha(&"a".repeat(39)));
        assert!(!is_sha("HEAD"));
        assert!(!is_sha(&format!("{}g", "a".repeat(39))));
        assert!(!is_sha("--all"));
    }

    #[test]
    fn non_repo_reports_error() {
        if !git_available() {
            return;
        }
        let dir = std::env::temp_dir().join(format!("hivemind-nogit-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let activity = activity_for_repos(std::slice::from_ref(&dir));
        std::fs::remove_dir_all(&dir).ok();
        assert!(activity[0].error.is_some());
        assert!(activity[0].commits.is_none());
    }

    #[test]
    fn counts_commits_since_a_commit_and_since_a_time() {
        if !git_available() {
            return;
        }
        let dir = std::env::temp_dir().join(format!("hivemind-revcount-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        let sh = |args: &[&str]| {
            let mut command = Command::new("git");
            command.arg("-C").arg(&dir).args(["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false"]).args(args);
            run_with_timeout(command, TIMEOUT).unwrap()
        };
        sh(&["init", "-q"]);
        for n in 0..3 {
            sh(&["commit", "-q", "--allow-empty", "-m", &format!("c{n}")]);
        }
        let first = sh(&["rev-list", "--max-parents=0", "HEAD"]).trim().to_string();
        assert_eq!(rev_count(&dir, &[&format!("{first}..HEAD")]), Ok(2));
        assert!(rev_count(&dir, &[&format!("{}..HEAD", "0".repeat(40))]).is_err());
        assert_eq!(rev_count(&dir, &["--since=@1000000000", "HEAD"]), Ok(3));
        let head = head_sha(&dir).unwrap();
        assert!(is_sha(&head) && head.len() == 40);
        assert_eq!(head, sh(&["rev-parse", "HEAD"]).trim());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A repository for the file-history tests: line endings left alone, so a file's content is what was written.
    fn file_repo(name: &str) -> PathBuf {
        let dir = batch_repo(name);
        git(&dir, &["config", "core.autocrlf", "false"]);
        dir
    }

    fn write_and_commit(dir: &Path, file: &str, text: &str, message: &str) -> String {
        std::fs::write(dir.join(file), text).unwrap();
        git(dir, &["add", "--", file]);
        git(dir, &["commit", "-q", "-m", message]);
        head_sha(dir).unwrap()
    }

    fn out(dir: &Path, args: &[&str]) -> String {
        let result = Command::new("git").arg("-C").arg(dir).args(args).output().unwrap();
        assert!(result.status.success(), "{}", String::from_utf8_lossy(&result.stderr));
        String::from_utf8_lossy(&result.stdout).into_owned()
    }

    #[test]
    fn a_files_log_follows_renames_and_each_commit_shows_the_file_as_it_was() {
        if !git_available() {
            return;
        }
        let dir = file_repo("filelog");
        let first = write_and_commit(&dir, "a.md", "one\n", "first");
        write_and_commit(&dir, "other.md", "x\n", "unrelated");
        let second = write_and_commit(&dir, "a.md", "two\n", "second");
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        git(&dir, &["mv", "a.md", "sub/b.md"]);
        git(&dir, &["commit", "-q", "-m", "move it"]);
        let sub = dir.join("sub");
        let log = file_log(&sub, "b.md").unwrap();
        assert!(log.repo.is_some() && !log.changed);
        assert_eq!(log.commits.iter().map(|c| c.subject.as_str()).collect::<Vec<_>>(), ["move it", "second", "first"], "the unrelated commit is not listed");
        assert_eq!(log.commits.iter().map(|c| c.path.as_str()).collect::<Vec<_>>(), ["sub/b.md", "a.md", "a.md"]);
        assert_eq!((log.commits[2].sha.as_str(), log.commits[1].author.as_str()), (first.as_str(), "Tester"));
        assert!(log.commits[0].date.contains('T'));
        assert_eq!(file_version(&sub, "b.md", &first).unwrap(), "one\n");
        assert_eq!(file_version(&sub, "b.md", &second).unwrap(), "two\n");
        assert!(file_version(&sub, "b.md", "nothex").is_err());
        assert!(file_version(&sub, "b.md", &"0".repeat(40)).unwrap_err().contains("does not touch"));
        std::fs::write(sub.join("b.md"), "three\n").unwrap();
        assert!(file_log(&sub, "b.md").unwrap().changed);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn reading_a_files_history_does_not_run_the_repositorys_filesystem_monitor() {   // PROC-1
        if !git_available() {
            return;
        }
        let dir = file_repo("fsmonitor");
        write_and_commit(&dir, "a.md", "one\n", "first");
        let scripts = std::env::temp_dir().join(format!("hivemind-fsmonitor-{}", std::process::id()));
        std::fs::remove_dir_all(&scripts).ok();
        std::fs::create_dir_all(&scripts).unwrap();
        let marker = scripts.join("ran");
        let script = scripts.join("monitor.sh");
        let slashed = |path: &Path| path.display().to_string().replace('\\', "/");
        std::fs::write(&script, format!("#!/bin/sh\necho ran > \"{}\"\n", slashed(&marker))).unwrap();
        git(&dir, &["config", "core.fsmonitor", &format!("sh {}", slashed(&script))]);
        std::fs::write(dir.join("a.md"), "two\n").unwrap();
        // Control: git itself runs the monitor, so the check below can tell.
        out(&dir, &["status", "--porcelain"]);
        assert!(marker.exists(), "this git does not run the monitor, so the test proves nothing");
        std::fs::remove_file(&marker).unwrap();
        assert!(file_log(&dir, "a.md").unwrap().changed);
        assert!(file_commit(&dir, "a.md", "second").is_ok());
        let ran = marker.exists();
        std::fs::remove_dir_all(&scripts).ok();
        std::fs::remove_dir_all(&dir).ok();
        assert!(!ran, "the repository's fsmonitor program ran");
    }

    #[test]
    fn a_folder_outside_any_repository_has_no_log_and_a_new_repository_has_no_commits() {
        if !git_available() {
            return;
        }
        let plain = std::env::temp_dir().join(format!("hivemind-nolog-{}", std::process::id()));
        std::fs::create_dir_all(&plain).unwrap();
        std::fs::write(plain.join("a.md"), "x").unwrap();
        // A folder inside no work tree (unless the temp folder itself is in one).
        if work_tree(&plain).unwrap().is_none() {
            assert_eq!(file_log(&plain, "a.md").unwrap(), FileLog { repo: None, commits: vec![], changed: false });
            assert!(file_commit(&plain, "a.md", "msg").unwrap_err().contains("not in a git repository"));
        }
        std::fs::remove_dir_all(&plain).ok();
        let dir = file_repo("nocommits");
        std::fs::write(dir.join("new.md"), "x\n").unwrap();
        let log = file_log(&dir, "new.md").unwrap();
        assert!(log.repo.is_some() && log.commits.is_empty() && log.changed, "a file git does not know is changed");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_commit_takes_only_its_file_and_leaves_what_was_staged_for_others_staged() {
        if !git_available() {
            return;
        }
        let dir = file_repo("only");
        // `[ab].md` read as a pattern would match `a.md` and `b.md` too.
        for name in ["[ab].md", "a.md", "other.md"] {
            write_and_commit(&dir, name, "v1\n", &format!("add {name}"));
        }
        std::fs::write(dir.join("[ab].md"), "v2\n").unwrap();
        std::fs::write(dir.join("a.md"), "v2\n").unwrap();
        std::fs::write(dir.join("other.md"), "v2\n").unwrap();
        git(&dir, &["add", "--", "other.md"]);
        let sha = file_commit(&dir, "[ab].md", "Edit the bracket page").unwrap();
        assert_eq!(sha, head_sha(&dir).unwrap());
        assert_eq!(out(&dir, &["show", "--name-only", "--format=", "HEAD"]).trim(), "[ab].md", "only that file is in the commit");
        assert_eq!(out(&dir, &["log", "-1", "--format=%s"]).trim(), "Edit the bracket page");
        assert_eq!(out(&dir, &["diff", "--cached", "--name-only"]).trim(), "other.md", "the file staged before is still staged");
        assert!(out(&dir, &["status", "--short"]).contains(" M a.md"), "a.md is still modified and uncommitted");
        // Nothing left to commit in that file.
        assert!(file_commit(&dir, "[ab].md", "again").unwrap_err().contains("nothing to commit"));
        assert!(file_commit(&dir, "a.md", "  ").unwrap_err().contains("message"));
        // A file git does not know yet is added and committed alone.
        std::fs::write(dir.join("new [x].md"), "new\n").unwrap();
        file_commit(&dir, "new [x].md", "Add it").unwrap();
        assert_eq!(out(&dir, &["show", "--name-only", "--format=", "HEAD"]).trim(), "new [x].md");
        assert_eq!(out(&dir, &["diff", "--cached", "--name-only"]).trim(), "other.md");
        // A file the repository ignores says so and is not committed.
        std::fs::write(dir.join(".gitignore"), "ignored.md\n").unwrap();
        std::fs::write(dir.join("ignored.md"), "x\n").unwrap();
        assert!(file_commit(&dir, "ignored.md", "no").unwrap_err().contains("did not add"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_name_is_always_a_literal_pathspec() {
        assert_eq!(literal("a*b?[c]:d.md"), ":(literal)a*b?[c]:d.md");
        // Windows cannot name a file with `*`, `?` or `:`; elsewhere git is asked about such names.
        #[cfg(unix)]
        {
            if !git_available() {
                return;
            }
            let dir = file_repo("literal");
            write_and_commit(&dir, "a.md", "plain\n", "plain");
            write_and_commit(&dir, "a*.md", "star\n", "star");
            write_and_commit(&dir, ":(top)x.md", "magic\n", "magic");
            assert_eq!(file_log(&dir, "a*.md").unwrap().commits.iter().map(|c| c.subject.as_str()).collect::<Vec<_>>(), ["star"]);
            assert_eq!(file_log(&dir, ":(top)x.md").unwrap().commits.len(), 1);
            std::fs::write(dir.join("a*.md"), "star 2\n").unwrap();
            std::fs::write(dir.join("a.md"), "plain 2\n").unwrap();
            file_commit(&dir, "a*.md", "star again").unwrap();
            assert!(out(&dir, &["status", "--short"]).contains(" M a.md"));
            std::fs::remove_dir_all(&dir).ok();
        }
    }

    #[test]
    fn a_commit_with_no_git_identity_says_so_and_leaves_the_index_as_it_was() {
        if !git_available() {
            return;
        }
        let dir = file_repo("identity");
        write_and_commit(&dir, "tracked.md", "v1\n", "first");
        std::fs::write(dir.join("tracked.md"), "v2\n").unwrap();
        std::fs::write(dir.join("fresh.md"), "new\n").unwrap();
        git(&dir, &["config", "user.name", ""]);
        git(&dir, &["config", "user.email", ""]);
        assert_eq!(file_commit(&dir, "tracked.md", "msg"), Err(crate::review::NO_IDENTITY.to_string()));
        assert_eq!(file_commit(&dir, "fresh.md", "msg"), Err(crate::review::NO_IDENTITY.to_string()));
        assert_eq!(out(&dir, &["status", "--short"]).lines().map(str::trim).collect::<Vec<_>>(), ["M tracked.md", "?? fresh.md"], "the new file is not left staged");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn quoted_names_in_a_log_are_read_back() {
        assert_eq!(unquote("plain.md"), "plain.md");
        assert_eq!(unquote("\"with \\\"quote\\\".md\""), "with \"quote\".md");
        assert_eq!(unquote("\"tab\\tname\""), "tab\tname");
        assert_eq!(unquote("\"caf\\303\\251.md\""), "café.md");
        let text = format!("\x1e{}\x1fAda\x1f2026-01-02T03:04:05+00:00\x1fSubject\n\nsub/a.md\n\x1e{}\x1fBo\x1f2026-01-01T00:00:00+00:00\x1fNo path\n", "a".repeat(40), "b".repeat(40));
        let commits = parse_file_log(&text);
        assert_eq!(commits.len(), 1, "a record with no path is skipped");
        assert_eq!((commits[0].author.as_str(), commits[0].path.as_str(), commits[0].subject.as_str()), ("Ada", "sub/a.md", "Subject"));
    }
}
