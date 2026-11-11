//! Session history in the app's data folder: `index.json` lists the sessions, and `<id>.jsonl`
//! keeps each one's raw output so its events can be rebuilt exactly.
use super::SessionInfo;
use crate::worktree::FileChange;
use super::events::{Mode, RunEvent, Status, TurnEnd};
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::{Path, PathBuf};

pub const KEEP: usize = 50;
pub const CLOSED: &str = "Hivemind closed while this session was running";

/// One log line: a line the CLI printed, or an event Hivemind added itself.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(untagged)]
pub enum Record {
    Raw { at: u64, raw: String },
    Event { at: u64, event: RunEvent },
}

/// Ids become file names, so only a plain lowercase UUID will do.
pub fn log_path(dir: &Path, id: &str) -> Result<PathBuf, String> {
    match uuid::Uuid::try_parse(id) {
        Ok(parsed) if parsed.hyphenated().to_string() == id => Ok(dir.join(format!("{id}.jsonl"))),
        _ => Err("Invalid session id".into()),
    }
}

pub fn load_index(dir: &Path) -> Vec<SessionInfo> {
    std::fs::read(dir.join("index.json")).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default()
}

pub fn save_index(dir: &Path, sessions: &[SessionInfo]) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let path = dir.join("index.json");
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, serde_json::to_vec(sessions).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(&temp, &path).map_err(|e| e.to_string())
}

pub fn newest_first(sessions: &mut [SessionInfo]) {
    sessions.sort_by(|a, b| (b.started_at, &b.id).cmp(&(a.started_at, &a.id)));
}

/// Sort newest first and drop all but the newest `KEEP` (a session that is working, waiting for an answer or still has a
/// worktree is never dropped), deleting the dropped sessions' logs. Returns the dropped ids.
pub fn prune(dir: &Path, sessions: &mut Vec<SessionInfo>) -> Vec<String> {
    newest_first(sessions);
    let (mut seen, mut dropped) = (0, vec![]);
    sessions.retain(|session| {
        seen += 1;
        let keep = seen <= KEEP || matches!(session.status, Status::Running | Status::Waiting) || session.worktree.is_some();
        if !keep {
            if let Ok(path) = log_path(dir, &session.id) {
                std::fs::remove_file(path).ok();
            }
            dropped.push(session.id.clone());
        }
        keep
    });
    dropped
}

pub fn append(dir: &Path, id: &str, record: &Record) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let mut file = std::fs::OpenOptions::new().create(true).append(true).open(log_path(dir, id)?).map_err(|e| e.to_string())?;
    let mut line = serde_json::to_vec(record).map_err(|e| e.to_string())?;
    line.push(b'\n');
    file.write_all(&line).map_err(|e| e.to_string())
}

/// Every readable record, in order. A session with no log yet has none.
pub fn read_log(dir: &Path, id: &str) -> Result<Vec<Record>, String> {
    match std::fs::read_to_string(log_path(dir, id)?) {
        Ok(text) => Ok(text.lines().filter_map(|line| serde_json::from_str(line).ok()).collect()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(vec![]),
        Err(e) => Err(e.to_string()),
    }
}

/// What the last `filesChanged` event in a session's log says; empty when there is none.
fn last_files(dir: &Path, id: &str) -> Vec<FileChange> {
    let log = read_log(dir, id).unwrap_or_default();
    log.into_iter()
        .rev()
        .find_map(|record| match record {
            Record::Event { event: RunEvent::FilesChanged { files }, .. } => Some(files),
            _ => None,
        })
        .unwrap_or_default()
}

/// The index at startup. A session still marked running or waiting has no process any more. An unattended one is closed
/// as failed, with a `finished` record so its log ends like every other session's; an interactive one goes idle, so
/// the user can message it again, after the files its dead process left in the worktree are reported.
pub fn recover(dir: &Path, now: u64) -> Vec<SessionInfo> {
    let mut sessions = load_index(dir);
    let mut changed = false;
    for session in sessions.iter_mut().filter(|session| matches!(session.status, Status::Running | Status::Waiting)) {
        if session.mode == Mode::Interactive {
            // A git failure is ignored: the worktree may be gone, and only the turn is closed then.
            if let Some(files) = session.worktree.as_ref().and_then(|tree| crate::worktree::changes(tree).ok())
                && files != last_files(dir, &session.id)
            {
                session.files_changed = (!files.is_empty()).then(|| crate::worktree::totals(&files));
                let _ = append(dir, &session.id, &Record::Event { at: now, event: RunEvent::FilesChanged { files } });
            }
            session.status = Status::Idle;
            let event = RunEvent::TurnFinished {
                ok: false,
                reason: Some(CLOSED.into()),
                cost_usd: session.cost_usd,
                duration_ms: None,
                result: None,
                denials: 0,
                outcome: TurnEnd::Error,
            };
            let _ = append(dir, &session.id, &Record::Event { at: now, event });
            changed = true;
            continue;
        }
        session.status = Status::Failed;
        session.error = Some(CLOSED.into());
        session.ended_at = Some(now);
        let event = RunEvent::Finished {
            status: Status::Failed,
            reason: Some(CLOSED.into()),
            cost_usd: session.cost_usd,
            duration_ms: None,
            turns: None,
            result: None,
            structured: None,
            denials: 0,
        };
        let _ = append(dir, &session.id, &Record::Event { at: now, event });
        changed = true;
    }
    if changed {
        let _ = save_index(dir, &sessions);
    }
    sessions
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::scope::{AgentTask, PolicyMode};
    use crate::worktree::{Totals, Worktree};
    use serde_json::json;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hivemind-agent-store-{name}-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        dir
    }

    fn id(n: u64) -> String {
        format!("00000000-0000-4000-8000-{n:012}")
    }

    fn session(n: u64, status: Status) -> SessionInfo {
        SessionInfo {
            id: id(n),
            adapter: "claude-code".into(),
            cli_version: Some("2.1.321".into()),
            task: AgentTask::SystemPassport { slug: "billing".into() },
            title: "System passport: Billing".into(),
            workspace: vec!["/work/app".into(), "/work/arch".into()],
            status,
            started_at: 1_000 + n,
            ended_at: (status != Status::Running).then_some(2_000 + n),
            cost_usd: Some(0.25),
            error: None,
            structured: Some(json!({"summary": "Billing takes payments."})),
            mode: Mode::Unattended,
            policy: PolicyMode::PreApproved,
            project: None,
            worktree: None,
            turns: 0,
            files_changed: None,
            context: vec![],
            model: None,
            system: None,
        }
    }

    fn tree(path: &str) -> Worktree {
        Worktree {
            repo: "C:/demo/repos/paystream".into(),
            path: path.into(),
            branch: "hivemind/0f9e8d7c".into(),
            base_branch: "main".into(),
            base_sha: "a053c800edb319fae41bc4873e4412b763b9d93b".into(),
        }
    }

    /// An interactive session that was in the middle of a turn.
    fn interactive(n: u64, status: Status, worktree: Option<Worktree>) -> SessionInfo {
        SessionInfo {
            task: AgentTask::Work { project: "paystream".into(), repo: "C:/demo/repos/paystream".into(), branch: None, change: None },
            mode: Mode::Interactive,
            policy: PolicyMode::Ask,
            project: Some("paystream".into()),
            worktree,
            ended_at: None,
            structured: None,
            ..session(n, status)
        }
    }

    #[test]
    fn index_round_trips_with_the_contract_field_names() {
        let dir = temp("index");
        assert!(load_index(&dir).is_empty());
        let sessions = vec![session(2, Status::Succeeded), session(1, Status::Cancelled)];
        save_index(&dir, &sessions).unwrap();
        assert_eq!(load_index(&dir), sessions);
        let stored: serde_json::Value = serde_json::from_slice(&std::fs::read(dir.join("index.json")).unwrap()).unwrap();
        assert_eq!(
            stored[0],
            json!({"id": id(2), "adapter": "claude-code", "cliVersion": "2.1.321", "task": {"kind": "system_passport", "slug": "billing"},
                "title": "System passport: Billing", "workspace": ["/work/app", "/work/arch"], "status": "succeeded", "startedAt": 1002,
                "endedAt": 2002, "costUsd": 0.25, "error": null, "structured": {"summary": "Billing takes payments."},
                "mode": "unattended", "policy": "pre_approved", "project": null, "worktree": null, "turns": 0, "filesChanged": null,
                "context": [], "model": null, "system": null})
        );
        // The persisted JSON of a work session, as the Phase 2 document shows it.
        let path = r"C:\Users\me\AppData\Roaming\dev.hivemind.app\worktrees\paystream-5d1c0a3e\0f9e8d7c";
        let work = SessionInfo {
            id: "0f9e8d7c-1111-4222-8333-444455556666".into(),
            cli_version: Some("2.1.322".into()),
            task: AgentTask::Work { project: "paystream".into(), repo: "C:/demo/repos/paystream".into(), branch: Some("main".into()), change: None },
            title: "Add a retry ceiling flag to the replay tool".into(),
            workspace: vec![path.into()],
            status: Status::Idle,
            started_at: 1794300000000,
            ended_at: None,
            cost_usd: Some(0.04),
            structured: None,
            mode: Mode::Interactive,
            policy: PolicyMode::Ask,
            project: Some("paystream".into()),
            worktree: Some(Worktree {
                repo: "C:/demo/repos/paystream".into(),
                path: path.into(),
                branch: "hivemind/0f9e8d7c".into(),
                base_branch: "main".into(),
                base_sha: "a053c800edb319fae41bc4873e4412b763b9d93b".into(),
            }),
            turns: 2,
            files_changed: Some(Totals { files: 3, added: 42, removed: 8 }),
            context: vec!["paystream:6f0c1d2e-3b4a-4c5d-8e9f-0a1b2c3d4e5f".into()],
            model: None,
            system: Some("paystream".into()),
            ..session(1, Status::Idle)
        };
        save_index(&dir, std::slice::from_ref(&work)).unwrap();
        assert_eq!(load_index(&dir), vec![work]);
        let stored: serde_json::Value = serde_json::from_slice(&std::fs::read(dir.join("index.json")).unwrap()).unwrap();
        assert_eq!(
            stored[0],
            json!({"id": "0f9e8d7c-1111-4222-8333-444455556666", "adapter": "claude-code", "cliVersion": "2.1.322",
                "task": {"kind": "work", "project": "paystream", "repo": "C:/demo/repos/paystream", "branch": "main"},
                "title": "Add a retry ceiling flag to the replay tool", "workspace": [path], "status": "idle", "startedAt": 1794300000000u64,
                "endedAt": null, "costUsd": 0.04, "error": null, "structured": null,
                "mode": "interactive", "policy": "ask", "project": "paystream",
                "worktree": {"repo": "C:/demo/repos/paystream", "path": path, "branch": "hivemind/0f9e8d7c", "baseBranch": "main",
                    "baseSha": "a053c800edb319fae41bc4873e4412b763b9d93b"},
                "turns": 2, "filesChanged": {"files": 3, "added": 42, "removed": 8},
                "context": ["paystream:6f0c1d2e-3b4a-4c5d-8e9f-0a1b2c3d4e5f"], "model": null, "system": "paystream"})
        );
        save_index(&dir, &sessions).unwrap();
        std::fs::write(dir.join("index.json"), "not json").unwrap();
        assert!(load_index(&dir).is_empty());
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn index_written_before_interactive_sessions_still_loads() {
        let dir = temp("old-index");
        let old = json!([{"id": id(2), "adapter": "claude-code", "cliVersion": "2.1.321", "task": {"kind": "system_passport", "slug": "billing"},
            "title": "System passport: Billing", "workspace": ["/work/app", "/work/arch"], "status": "succeeded", "startedAt": 1002,
            "endedAt": 2002, "costUsd": 0.25, "error": null, "structured": {"summary": "Billing takes payments."}}]);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("index.json"), old.to_string()).unwrap();
        let loaded = load_index(&dir);
        assert_eq!(loaded, vec![session(2, Status::Succeeded)]);
        let info = &loaded[0];
        assert_eq!((info.mode, info.policy, info.turns), (Mode::Unattended, PolicyMode::PreApproved, 0));
        assert_eq!((&info.project, &info.worktree, &info.files_changed, &info.model, &info.system), (&None, &None, &None, &None, &None));
        assert!(info.context.is_empty());
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn prunes_to_the_newest_and_deletes_their_logs() {
        let dir = temp("prune");
        let mut sessions: Vec<SessionInfo> = (1..=KEEP as u64 + 3).map(|n| session(n, Status::Succeeded)).collect();
        sessions[1].status = Status::Running; // old, but still going
        sessions[2].worktree = Some(tree("/wt/paystream-5d1c0a3e/0f9e8d7c")); // old, but its worktree still holds work
        for session in &sessions {
            append(&dir, &session.id, &Record::Raw { at: 1, raw: "{}".into() }).unwrap();
        }
        let dropped = prune(&dir, &mut sessions);
        assert_eq!(dropped, vec![id(1)]);
        assert_eq!(sessions.len(), KEEP + 2);
        assert_eq!(sessions[0].id, id(KEEP as u64 + 3), "newest first");
        assert_eq!(sessions.iter().rev().map(|session| session.id.clone()).take(2).collect::<Vec<_>>(), vec![id(2), id(3)], "the running one and the one with a worktree stay");
        assert!(!log_path(&dir, &id(1)).unwrap().exists());
        assert!(log_path(&dir, &id(2)).unwrap().exists() && log_path(&dir, &id(3)).unwrap().exists() && log_path(&dir, &id(4)).unwrap().exists());
        assert!(prune(&dir, &mut sessions).is_empty());
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn only_plain_uuids_name_a_log() {
        let dir = temp("ids");
        assert_eq!(log_path(&dir, &id(7)).unwrap(), dir.join(format!("{}.jsonl", id(7))));
        for bad in [
            "",
            "index",
            "../index",
            "..\\..\\settings",
            "00000000-0000-4000-8000-000000000007/../x",
            "00000000-0000-4000-8000-000000000007.jsonl",
            "00000000000040008000000000000007",
            "{00000000-0000-4000-8000-000000000007}",
            "urn:uuid:00000000-0000-4000-8000-000000000007",
            "ABCDEF00-0000-4000-8000-000000000007",
            " 00000000-0000-4000-8000-000000000007",
        ] {
            assert!(log_path(&dir, bad).is_err(), "{bad}");
            assert!(read_log(&dir, bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn log_keeps_raw_lines_and_events_in_order() {
        let dir = temp("log");
        assert_eq!(read_log(&dir, &id(1)).unwrap(), vec![]);
        let raw = Record::Raw { at: 5, raw: r#"{"type":"assistant","message":{"content":[]}}"#.into() };
        let event = Record::Event { at: 6, event: RunEvent::Text { text: "hello".into() } };
        append(&dir, &id(1), &raw).unwrap();
        append(&dir, &id(1), &event).unwrap();
        let path = log_path(&dir, &id(1)).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert_eq!(text.lines().nth(1).unwrap(), r#"{"at":6,"event":{"type":"text","text":"hello"}}"#);
        // A torn last line (the app died mid-write) is skipped.
        std::fs::write(&path, format!("{text}{{\"at\":7,\"ra")).unwrap();
        assert_eq!(read_log(&dir, &id(1)).unwrap(), vec![raw, event]);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn recovery_closes_sessions_left_running() {
        let dir = temp("recover");
        save_index(&dir, &[session(2, Status::Running), session(1, Status::Succeeded)]).unwrap();
        let sessions = recover(&dir, 9_000);
        assert_eq!((sessions[0].status, sessions[0].error.as_deref(), sessions[0].ended_at), (Status::Failed, Some(CLOSED), Some(9_000)));
        assert_eq!(sessions[1], session(1, Status::Succeeded));
        assert_eq!(load_index(&dir), sessions);
        let log = read_log(&dir, &id(2)).unwrap();
        assert!(matches!(&log[..], [Record::Event { at: 9_000, event: RunEvent::Finished { status: Status::Failed, .. } }]));
        assert!(read_log(&dir, &id(1)).unwrap().is_empty());
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn recovery_leaves_an_interactive_session_idle() {
        let dir = temp("recover-interactive");
        save_index(&dir, &[interactive(3, Status::Waiting, None), session(2, Status::Running), interactive(1, Status::Idle, None)]).unwrap();
        let sessions = recover(&dir, 9_000);
        let waiting = &sessions[0];
        assert_eq!((waiting.status, waiting.ended_at, &waiting.error), (Status::Idle, None, &None));
        let log = read_log(&dir, &id(3)).unwrap();
        let closed = RunEvent::TurnFinished {
            ok: false,
            reason: Some(CLOSED.into()),
            cost_usd: Some(0.25),
            duration_ms: None,
            result: None,
            denials: 0,
            outcome: TurnEnd::Error,
        };
        assert_eq!(log, vec![Record::Event { at: 9_000, event: closed }]);
        // An unattended session still fails, and an idle one is left alone.
        assert_eq!((sessions[1].status, sessions[1].error.as_deref(), sessions[1].ended_at), (Status::Failed, Some(CLOSED), Some(9_000)));
        assert!(matches!(&read_log(&dir, &id(2)).unwrap()[..], [Record::Event { event: RunEvent::Finished { status: Status::Failed, .. }, .. }]));
        assert_eq!(sessions[2], interactive(1, Status::Idle, None));
        assert!(read_log(&dir, &id(1)).unwrap().is_empty());
        assert_eq!(load_index(&dir), sessions);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn recovery_reports_files_a_dead_process_left() {
        use std::process::Command;
        let git = |dir: &Path, args: &[&str]| {
            let out = Command::new("git").arg("-C").arg(dir).args(args).output().unwrap();
            assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        };
        if !Command::new("git").arg("--version").output().map(|o| o.status.success()).unwrap_or(false) {
            return;
        }
        let dir = temp("recover-files");
        let (repo, sessions_dir) = (dir.join("repo"), dir.join("sessions"));
        std::fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-q"]);
        git(&repo, &["symbolic-ref", "HEAD", "refs/heads/main"]);
        git(&repo, &["config", "user.name", "Tester"]);
        git(&repo, &["config", "user.email", "t@example.com"]);
        git(&repo, &["config", "commit.gpgsign", "false"]);
        std::fs::write(repo.join("a.txt"), "one\n").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-q", "-m", "first"]);
        let worktree = crate::worktree::create(&dir.join("worktrees"), &repo, None, &id(1)).unwrap();
        std::fs::write(Path::new(&worktree.path).join("new.txt"), "x\n").unwrap();
        let files = crate::worktree::changes(&worktree).unwrap();
        assert_eq!(files.len(), 1);
        let totals = Totals { files: 1, added: 1, removed: 0 };

        // Three sessions that were mid-turn: no log yet; a log that already ends with the same list; a worktree that is gone.
        let known = Record::Event { at: 5, event: RunEvent::FilesChanged { files: files.clone() } };
        append(&sessions_dir, &id(2), &known).unwrap();
        let gone = Worktree { path: dir.join("no-such-folder").display().to_string(), ..worktree.clone() };
        let mut second = interactive(2, Status::Running, Some(worktree.clone()));
        second.files_changed = Some(totals);
        save_index(&sessions_dir, &[interactive(1, Status::Running, Some(worktree)), second, interactive(3, Status::Waiting, Some(gone))]).unwrap();

        let recovered = recover(&sessions_dir, 9_000);
        assert!(recovered.iter().all(|session| session.status == Status::Idle));
        let closed = |log: &[Record]| matches!(log.last(), Some(Record::Event { event: RunEvent::TurnFinished { ok: false, outcome: TurnEnd::Error, .. }, .. }));

        let log = read_log(&sessions_dir, &id(1)).unwrap();
        assert_eq!(log.len(), 2);
        assert!(matches!(&log[0], Record::Event { at: 9_000, event: RunEvent::FilesChanged { files: reported } } if *reported == files));
        assert!(closed(&log));
        assert_eq!(recovered.iter().find(|session| session.id == id(1)).unwrap().files_changed, Some(totals));

        let log = read_log(&sessions_dir, &id(2)).unwrap();
        assert_eq!(log.len(), 2, "the list was already reported: {log:?}");
        assert_eq!(log[0], known);
        assert!(closed(&log));
        assert_eq!(recovered.iter().find(|session| session.id == id(2)).unwrap().files_changed, Some(totals));

        let log = read_log(&sessions_dir, &id(3)).unwrap();
        assert_eq!(log.len(), 1, "a worktree that cannot be read adds nothing: {log:?}");
        assert!(closed(&log));
        assert_eq!(recovered.iter().find(|session| session.id == id(3)).unwrap().files_changed, None);
        std::fs::remove_dir_all(dir).ok();
    }
}
