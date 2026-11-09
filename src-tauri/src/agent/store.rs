//! Session history in the app's data folder: `index.json` lists the sessions, and `<id>.jsonl`
//! keeps each one's raw output so its events can be rebuilt exactly.
use super::SessionInfo;
use super::events::{RunEvent, Status};
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

/// Sort newest first and drop all but the newest `KEEP` (a running session is never dropped),
/// deleting the dropped sessions' logs. Returns the dropped ids.
pub fn prune(dir: &Path, sessions: &mut Vec<SessionInfo>) -> Vec<String> {
    newest_first(sessions);
    let (mut seen, mut dropped) = (0, vec![]);
    sessions.retain(|session| {
        seen += 1;
        let keep = seen <= KEEP || session.status == Status::Running;
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

/// The index at startup. A session still marked running has no process any more: it is closed
/// as failed, with a `finished` record so its log ends like every other session's.
pub fn recover(dir: &Path, now: u64) -> Vec<SessionInfo> {
    let mut sessions = load_index(dir);
    let mut changed = false;
    for session in sessions.iter_mut().filter(|session| session.status == Status::Running) {
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
    use crate::agent::scope::AgentTask;
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
                "endedAt": 2002, "costUsd": 0.25, "error": null, "structured": {"summary": "Billing takes payments."}})
        );
        std::fs::write(dir.join("index.json"), "not json").unwrap();
        assert!(load_index(&dir).is_empty());
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn prunes_to_the_newest_and_deletes_their_logs() {
        let dir = temp("prune");
        let mut sessions: Vec<SessionInfo> = (1..=KEEP as u64 + 3).map(|n| session(n, Status::Succeeded)).collect();
        sessions[1].status = Status::Running; // old, but still going
        for session in &sessions {
            append(&dir, &session.id, &Record::Raw { at: 1, raw: "{}".into() }).unwrap();
        }
        let dropped = prune(&dir, &mut sessions);
        assert_eq!(dropped, vec![id(3), id(1)]);
        assert_eq!(sessions.len(), KEEP + 1);
        assert_eq!(sessions[0].id, id(KEEP as u64 + 3), "newest first");
        assert_eq!(sessions.last().unwrap().id, id(2), "the running one stays");
        assert!(!log_path(&dir, &id(1)).unwrap().exists() && !log_path(&dir, &id(3)).unwrap().exists());
        assert!(log_path(&dir, &id(2)).unwrap().exists() && log_path(&dir, &id(4)).unwrap().exists());
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
}
