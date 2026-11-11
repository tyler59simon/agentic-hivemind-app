//! Read-only git and GitHub activity for a project's repos. Repo paths come from Living Memory
//! (`projects`), never from the webview.
use crate::bridge::Bridge;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
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

/// Run a command, returning stdout. Kills it after `timeout`; non-zero exit is an error.
pub fn run_with_timeout(mut command: Command, timeout: Duration) -> Result<String, String> {
    command
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let name = command.get_program().to_string_lossy().into_owned();
    let mut child = command.spawn().map_err(|e| format!("Could not run {name}: {e}"))?;
    let out = drain(child.stdout.take());
    let err = drain(child.stderr.take());
    let start = Instant::now();
    let status = loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(status) => break Some(status),
            None if start.elapsed() >= timeout => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
            None => std::thread::sleep(Duration::from_millis(20)),
        }
    };
    let (stdout, stderr) = (out.join().unwrap_or_default(), err.join().unwrap_or_default());
    match status {
        None => Err(format!("{name} timed out after {}s", timeout.as_secs())),
        Some(s) if s.success() => Ok(stdout),
        Some(s) => {
            let line = stderr.lines().find(|l| !l.trim().is_empty()).unwrap_or("").trim();
            Err(if line.is_empty() { format!("{name} exited with {s}") } else { line.to_string() })
        }
    }
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

    fn git_available() -> bool {
        Command::new("git").arg("--version").output().map(|o| o.status.success()).unwrap_or(false)
    }

    fn git(dir: &Path, args: &[&str]) {
        let out = Command::new("git").arg("-C").arg(dir).args(args).output().unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
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
}
