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
    run_cancellable(command, input, timeout, None)
}

/// `run_with_input` that also stops (killing the process tree) once `cancel` is set.
pub fn run_cancellable(mut command: Command, input: Option<&str>, timeout: Duration, cancel: Option<&AtomicBool>) -> Result<Ran, String> {
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
    let mut child = command.spawn().map_err(|e| format!("{COULD_NOT_RUN} {name}: {e}"))?;
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
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(status) => break Some(status),
            None if cancel.is_some_and(|c| c.load(Ordering::Relaxed)) => {
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
        None if cancelled => Err(format!("{name} was cancelled")),
        None => Err(format!("{name} timed out after {}s", timeout.as_secs())),
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
    let mut command = Command::new("git");
    command.args(["--no-optional-locks", "-C"]).arg(repo).args(["rev-parse", "HEAD"]);
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
    let mut command = Command::new("git");
    command.args(["--no-optional-locks", "-C"]).arg(repo).args(["rev-list", "--reverse", "--topo-order", "HEAD", "--not"]).args(&reviewed);
    let text = run_with_timeout(command, TIMEOUT)?;
    let batch: Vec<String> = text.lines().map(str::trim).filter(|sha| is_sha(sha)).take(limit).map(String::from).collect();
    if batch.is_empty() {
        return Ok((batch, reviewed.iter().map(|sha| sha.to_string()).collect()));
    }
    let mut command = Command::new("git");
    command.args(["--no-optional-locks", "-C"]).arg(repo).args(["merge-base", "--independent"]).args(&reviewed).args(&batch);
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
    let mut command = Command::new("git");
    command.args(["--no-optional-locks", "-C"]).arg(repo).args(["cat-file", "--batch-check"]);
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
    let mut command = Command::new("git");
    command.args(["--no-optional-locks", "-C"]).arg(repo).args(["rev-list", "--count"]).args(selector);
    run_with_timeout(command, TIMEOUT)?.trim().parse().map_err(|_| "git did not print a number".to_string())
}

fn commits_for(repo: &Path) -> Result<Vec<Commit>, String> {
    let mut command = Command::new("git");
    command
        .args(["--no-optional-locks", "-C"])
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
        let mut command = Command::new("git");
        command.args(["--no-optional-locks", "-C"]).arg(repo).args(args);
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
        assert!(result.err().unwrap_or_default().contains("was cancelled"));
        assert!(start.elapsed() < Duration::from_secs(10));
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
}
