//! The conversations each CLI saved for a folder, including the ones started outside Hivemind. Read-only; every path is
//! built from the home folder (a parameter, so tests use a temp folder) and file names that passed `valid_id`.
use super::cli_files::{claude_folder, codex_index, date_folders, first_line, rollouts, same_folder, valid_id};
use super::transcript::{injected, message_text, text_of};
use crate::agent::events::clip;
use crate::agent::{Engine, Interface, SessionInfo};
use serde::Serialize;
use serde_json::Value;
use std::io::BufRead;
use std::path::Path;

/// How many conversations are listed.
pub const MAX_LISTED: usize = 50;
/// How many Codex rollouts are opened looking for the folder's conversations, newest first, before the search stops.
pub const MAX_ROLLOUTS: usize = 2000;
const TITLE_CHARS: usize = 80;
const UNTITLED: &str = "Untitled";

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    /// The CLI's own id for the conversation.
    pub id: String,
    pub title: String,
    /// Milliseconds since the epoch.
    pub updated_at: u64,
    /// The Hivemind session already bound to this conversation, if any.
    pub hivemind_session: Option<String>,
}

fn modified_ms(path: &Path) -> u64 {
    path.metadata()
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |since| since.as_millis() as u64)
}

/// A user's message as a title: one line of words, cut to 80 characters.
fn title_from(text: &str) -> String {
    clip(&text.split_whitespace().collect::<Vec<_>>().join(" "), TITLE_CHARS)
}

/// Lines of a file, read as bytes so one bad character does not end the read.
fn each_line(path: &Path, mut visit: impl FnMut(&str) -> bool) {
    let Ok(file) = std::fs::File::open(path) else { return };
    let mut reader = std::io::BufReader::new(file);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        if reader.read_until(b'\n', &mut buf).unwrap_or(0) == 0 || !visit(&String::from_utf8_lossy(&buf)) {
            return;
        }
    }
}

/// The text of a real user message in a Claude Code line: not meta, not a sub-agent's, not an injected `<tag>` block.
fn claude_user_text(line: &str) -> Option<String> {
    let record: Value = serde_json::from_str(line).ok()?;
    if text_of(&record, "type") != Some("user")
        || record.get("isMeta").and_then(Value::as_bool) == Some(true)
        || record.get("isSidechain").and_then(Value::as_bool) == Some(true)
    {
        return None;
    }
    let text = message_text(record.get("message").and_then(|m| m.get("content")), &["text"]);
    (!text.trim().is_empty() && !injected(&text)).then(|| title_from(&text))
}

/// The last `ai-title`, else the first real user message, else "Untitled". One pass; a line is only parsed when a cheap
/// substring test says it could matter.
fn claude_title_of(path: &Path) -> String {
    let (mut ai, mut first) = (None, None);
    each_line(path, |line| {
        if line.contains("\"ai-title\"")
            && let Some(record) = serde_json::from_str::<Value>(line).ok().filter(|r| text_of(r, "type") == Some("ai-title"))
            && let Some(title) = text_of(&record, "aiTitle").map(str::trim).filter(|title| !title.is_empty())
        {
            ai = Some(title.to_string());
        }
        if first.is_none() && line.contains("\"user\"") {
            first = claude_user_text(line);
        }
        true
    });
    ai.map(|title| title_from(&title)).or(first).unwrap_or_else(|| UNTITLED.to_string())
}

/// The newest conversations Claude Code saved for `cwd`. Its project folder is named from the path (`:`, `\`, `/` and `.`
/// become `-`); the name with every other symbol replaced too is tried as well, for folders with spaces or underscores.
pub fn claude(home: &Path, cwd: &str) -> Vec<Conversation> {
    let projects = home.join(".claude").join("projects");
    let mut names = vec![claude_folder(cwd)];
    let every: String = cwd.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
    if !names.contains(&every) {
        names.push(every);
    }
    let mut files: Vec<(String, std::path::PathBuf, u64)> = Vec::new();
    for name in names {
        for entry in std::fs::read_dir(projects.join(name)).into_iter().flatten().flatten() {
            let path = entry.path();
            let id = path.file_stem().and_then(|stem| stem.to_str()).map(str::to_string);
            let is_log = path.extension().and_then(|ext| ext.to_str()) == Some("jsonl");
            if let Some(id) = id.filter(|id| is_log && valid_id(id) && path.is_file() && !files.iter().any(|(seen, ..)| seen == id)) {
                let at = modified_ms(&path);
                files.push((id, path, at));
            }
        }
    }
    files.sort_by(|a, b| b.2.cmp(&a.2).then_with(|| a.0.cmp(&b.0)));
    files
        .into_iter()
        .take(MAX_LISTED)
        .map(|(id, path, updated_at)| Conversation { id, title: claude_title_of(&path), updated_at, hivemind_session: None })
        .collect()
}

/// The first real user message of a Codex rollout, as a title.
fn codex_first_message(path: &Path) -> Option<String> {
    let mut found = None;
    each_line(path, |line| {
        if !line.contains("\"user\"") {
            return true;
        }
        let Ok(record) = serde_json::from_str::<Value>(line) else { return true };
        let payload = &record["payload"];
        if text_of(&record, "type") == Some("response_item") && text_of(payload, "type") == Some("message") && text_of(payload, "role") == Some("user") {
            let text = message_text(payload.get("content"), &["input_text", "text"]);
            if !text.trim().is_empty() && !text.trim_start().starts_with("# AGENTS.md instructions") && !injected(&text) {
                found = Some(title_from(&text));
            }
        }
        found.is_none()
    });
    found
}

/// The most recently updated Codex conversations whose rollout names `cwd`. The date folders are walked newest first
/// until `MAX_ROLLOUTS` rollouts have been opened; the matches are then sorted by update time (the index's, else the
/// file's modified time) and the newest `MAX_LISTED` kept, so an old conversation resumed today is not missed.
pub fn codex(home: &Path, cwd: &str) -> Vec<Conversation> {
    let index = codex_index(home);
    let mut days = date_folders(home);
    days.sort_by_key(|day| std::cmp::Reverse(day.0));
    let (mut matches, mut opened) = (Vec::new(), 0);
    'days: for (_, dir) in days {
        let mut files: Vec<_> = rollouts(&dir).collect();
        files.sort_by(|a, b| b.cmp(a));
        for path in files {
            if opened >= MAX_ROLLOUTS {
                break 'days;
            }
            opened += 1;
            let Some(meta) = first_line(&path).filter(|meta| text_of(meta, "type") == Some("session_meta")) else { continue };
            let payload = &meta["payload"];
            let (Some(id), Some(folder)) = (text_of(payload, "id").filter(|id| valid_id(id)), text_of(payload, "cwd")) else { continue };
            if !same_folder(folder, cwd) {
                continue;
            }
            let (name, at) = index.get(id).cloned().unwrap_or_default();
            matches.push((id.to_string(), path.clone(), name, at.unwrap_or_else(|| modified_ms(&path))));
        }
    }
    matches.sort_by(|a, b| b.3.cmp(&a.3).then_with(|| a.0.cmp(&b.0)));
    matches.truncate(MAX_LISTED);
    // The first message is read only for the conversations that are kept.
    matches
        .into_iter()
        .map(|(id, path, name, updated_at)| {
            let title = name.or_else(|| codex_first_message(&path)).unwrap_or_else(|| UNTITLED.to_string());
            Conversation { id, title, updated_at, hivemind_session: None }
        })
        .collect()
}

/// The CLI conversation a session is bound to. Claude: the imported conversation, else the session's own id (Hivemind
/// starts Claude with `--session-id <its id>`). Codex: the thread, once known.
pub fn conversation_id(engine: Engine, info: &SessionInfo) -> Option<&str> {
    match engine {
        Engine::Claude => Some(info.engine_session.as_deref().unwrap_or(&info.id)),
        Engine::Codex => info.engine_session.as_deref(),
    }
}

/// Fill in `hivemind_session`: the newest terminal session of this engine already bound to each conversation.
pub fn bind(list: &mut [Conversation], engine: Engine, sessions: &[SessionInfo]) {
    for conversation in list {
        conversation.hivemind_session = sessions
            .iter()
            .filter(|s| s.interface == Interface::Terminal && Engine::of(&s.adapter) == engine)
            .filter(|s| conversation_id(engine, s) == Some(conversation.id.as_str()))
            .max_by_key(|s| s.started_at)
            .map(|s| s.id.clone());
    }
}

/// The conversations of `engine` in `cwd`, newest first, with the Hivemind sessions that already hold them.
pub fn list(home: &Path, engine: Engine, cwd: &Path, sessions: &[SessionInfo]) -> Vec<Conversation> {
    let cwd = crate::folders::plain(cwd);
    let mut found = match engine {
        Engine::Claude => claude(home, &cwd),
        Engine::Codex => codex(home, &cwd),
    };
    bind(&mut found, engine, sessions);
    found
}

#[cfg(test)]
mod tests {
    use super::super::cli_files::parse_iso_ms;
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{Duration, SystemTime};

    const CWD: &str = "C:\\work\\app";
    const THREAD: &str = "019b0000-aaaa-7bbb-8ccc-ddddeeeeffff";

    fn home(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hivemind-history-{name}-{}", std::process::id()));
        fs::remove_dir_all(&dir).ok();
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(path: &Path, text: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    fn age(path: &Path, seconds_old: u64) {
        let file = fs::OpenOptions::new().write(true).open(path).unwrap();
        file.set_modified(SystemTime::now() - Duration::from_secs(seconds_old)).unwrap();
    }

    fn id(n: u32) -> String {
        format!("{n:08x}-1111-4222-8333-444455556666")
    }

    fn user(text: &str) -> String {
        serde_json::json!({"type": "user", "message": {"role": "user", "content": text}}).to_string()
    }

    fn claude_file(home: &Path, cwd: &str, name: &str, lines: &[String]) -> PathBuf {
        let path = home.join(".claude/projects").join(claude_folder(cwd)).join(format!("{name}.jsonl"));
        write(&path, &lines.join("\n"));
        path
    }

    #[test]
    fn claude_lists_the_folder_newest_first_with_title_fallbacks() {
        let home = home("claude");
        let with_ai = claude_file(&home, CWD, &id(1), &[user("first words"), "{\"type\":\"ai-title\",\"aiTitle\":\"Old\"}".into(), "{\"type\":\"ai-title\",\"aiTitle\":\"Fix the build\"}".into()]);
        let injected_first = claude_file(
            &home,
            CWD,
            &id(2),
            &[
                "{\"type\":\"summary\",\"summary\":\"ai-title is not a record\"}".into(),
                serde_json::json!({"type": "user", "isMeta": true, "message": {"content": "Caveat: meta"}}).to_string(),
                user("<command-name>/clear</command-name>"),
                serde_json::json!({"type": "user", "isSidechain": true, "message": {"content": "a sub-agent's"}}).to_string(),
                serde_json::json!({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "t", "content": "x"}]}}).to_string(),
                serde_json::json!({"type": "user", "message": {"content": [{"type": "text", "text": "Add   a\nlogin page"}]}}).to_string(),
            ],
        );
        let long = claude_file(&home, CWD, &id(3), &[user(&"w".repeat(200))]);
        let empty = claude_file(&home, CWD, &id(4), &["not json".into(), user("<system-reminder>x</system-reminder>")]);
        // A decoy folder, a file whose stem is not an id, and one that is not a log.
        claude_file(&home, "C:\\work\\other", &id(5), &[user("decoy")]);
        claude_file(&home, CWD, "not-an-id", &[user("bad stem")]);
        write(&home.join(".claude/projects").join(claude_folder(CWD)).join(format!("{}.txt", id(6))), "x");
        age(&with_ai, 400);
        age(&injected_first, 300);
        age(&long, 200);
        age(&empty, 100);

        let listed = claude(&home, CWD);
        let got: Vec<(&str, &str)> = listed.iter().map(|c| (c.id.as_str(), c.title.as_str())).collect();
        let long_title = format!("{}\u{2026}", "w".repeat(79));
        assert_eq!(got, vec![(id(4).as_str(), "Untitled"), (id(3).as_str(), long_title.as_str()), (id(2).as_str(), "Add a login page"), (id(1).as_str(), "Fix the build")]);
        assert!(listed[0].updated_at > listed[3].updated_at && listed[0].hivemind_session.is_none());
        assert!(claude(&home, "C:\\nowhere").is_empty());
        fs::remove_dir_all(home).ok();
    }

    #[test]
    fn claude_keeps_only_the_newest_fifty() {
        let home = home("fifty");
        for n in 0..60u32 {
            let path = claude_file(&home, CWD, &id(n), &[user("x")]);
            age(&path, 10_000 - u64::from(n) * 100);
        }
        let listed = claude(&home, CWD);
        assert_eq!(listed.len(), MAX_LISTED);
        assert_eq!((listed[0].id.clone(), listed[49].id.clone()), (id(59), id(10)));
        fs::remove_dir_all(home).ok();
    }

    #[test]
    fn claude_finds_a_folder_named_with_every_symbol_replaced() {
        let home = home("symbols");
        let cwd = "C:\\work\\my app_1";
        let path = home.join(".claude/projects/C--work-my-app-1").join(format!("{}.jsonl", id(1)));
        write(&path, &user("in a spaced folder"));
        assert_eq!(claude(&home, cwd).len(), 1);
        fs::remove_dir_all(home).ok();
    }

    fn rollout(home: &Path, day: &str, time: &str, thread: &str, cwd: &str, lines: &[Value]) -> PathBuf {
        let meta = serde_json::json!({"type": "session_meta", "payload": {"id": thread, "cwd": cwd, "timestamp": "2026-11-15T10:00:00.000Z"}});
        let mut text = meta.to_string();
        for line in lines {
            text.push('\n');
            text.push_str(&line.to_string());
        }
        let path = home.join(".codex/sessions").join(day).join(format!("rollout-{time}-{thread}.jsonl"));
        write(&path, &text);
        path
    }

    fn codex_user(text: &str) -> Value {
        serde_json::json!({"type": "response_item", "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": text}]}})
    }

    #[test]
    fn codex_lists_rollouts_for_the_folder_with_index_titles_and_times() {
        let home = home("codex");
        let named = "019b1111-aaaa-7bbb-8ccc-ddddeeeeffff";
        let unnamed = "019b2222-aaaa-7bbb-8ccc-ddddeeeeffff";
        let bare = "019b3333-aaaa-7bbb-8ccc-ddddeeeeffff";
        rollout(&home, "2026/11/14", "2026-11-14T09-00-00", named, "c:/work/app/", &[codex_user("ignored, the index names it")]);
        let unnamed_file = rollout(
            &home,
            "2026/11/15",
            "2026-11-15T09-00-00",
            unnamed,
            CWD,
            &[codex_user("# AGENTS.md instructions for C:\\work\\app"), codex_user("<environment_context>x</environment_context>"), codex_user("Port the parser")],
        );
        let bare_file = rollout(&home, "2026/11/15", "2026-11-15T08-00-00", bare, CWD, &[]);
        age(&unnamed_file, 200);
        age(&bare_file, 100);
        rollout(&home, "2026/11/15", "2026-11-15T07-00-00", "019b4444-aaaa-7bbb-8ccc-ddddeeeeffff", "C:\\work\\decoy", &[codex_user("decoy")]);
        rollout(&home, "2026/11/15", "2026-11-15T06-00-00", "not valid", CWD, &[]);
        write(
            &home.join(".codex/session_index.jsonl"),
            &format!("{{\"id\":\"{named}\",\"thread_name\":\"Old\",\"updated_at\":\"2026-11-14T12:00:00Z\"}}\n{{\"id\":\"{named}\",\"thread_name\":\"Parser work\",\"updated_at\":\"2026-11-14T13:00:00.5Z\"}}\n"),
        );
        let listed = codex(&home, CWD);
        let got: Vec<(&str, &str)> = listed.iter().map(|c| (c.id.as_str(), c.title.as_str())).collect();
        // Rollouts without an index time use the file's modified time, which is newer than the named one's.
        assert_eq!(got, vec![(bare, "Untitled"), (unnamed, "Port the parser"), (named, "Parser work")]);
        assert_eq!(listed[2].updated_at, parse_iso_ms("2026-11-14T13:00:00.5Z").unwrap());
        assert!(codex(&home, "C:\\elsewhere").is_empty());
        fs::remove_dir_all(home).ok();
    }

    #[test]
    fn codex_stops_after_fifty_matches() {
        let home = home("codex-fifty");
        for n in 0..55u32 {
            let thread = format!("019b{n:04x}-aaaa-7bbb-8ccc-ddddeeeeffff");
            rollout(&home, "2026/11/15", &format!("2026-11-15T10-{n:02}-00"), &thread, CWD, &[]);
        }
        assert_eq!(codex(&home, CWD).len(), MAX_LISTED);
        fs::remove_dir_all(home).ok();
    }

    #[test]
    fn codex_keeps_the_most_recently_updated_not_the_most_recently_created() {
        let home = home("codex-updated");
        let old = "019bffff-aaaa-7bbb-8ccc-ddddeeeeffff";
        rollout(&home, "2026/10/01", "2026-10-01T10-00-00", old, CWD, &[]);
        for n in 0..55u32 {
            let thread = format!("019b{n:04x}-aaaa-7bbb-8ccc-ddddeeeeffff");
            rollout(&home, "2026/11/15", &format!("2026-11-15T10-{n:02}-00"), &thread, CWD, &[]);
        }
        // The October conversation was resumed after all the November ones were last touched.
        let lines: String = (0..55u32)
            .map(|n| format!("{{\"id\":\"019b{n:04x}-aaaa-7bbb-8ccc-ddddeeeeffff\",\"thread_name\":\"n{n}\",\"updated_at\":\"2026-11-15T11:00:00Z\"}}
"))
            .chain(std::iter::once(format!("{{\"id\":\"{old}\",\"thread_name\":\"Old one\",\"updated_at\":\"2026-11-15T12:00:00Z\"}}
")))
            .collect();
        write(&home.join(".codex/session_index.jsonl"), &lines);
        let listed = codex(&home, CWD);
        assert_eq!(listed.len(), MAX_LISTED);
        assert_eq!((listed[0].id.as_str(), listed[0].title.as_str()), (old, "Old one"));
        fs::remove_dir_all(home).ok();
    }

    #[test]
    fn codex_gives_up_after_the_rollout_bound() {
        let home = home("codex-bound");
        // The matching rollout is the oldest of MAX_ROLLOUTS + 1 files; the newer ones are other folders'.
        let thread = |n: usize| format!("019b{n:04x}-aaaa-7bbb-8ccc-ddddeeeeffff");
        rollout(&home, "2026/11/01", "2026-11-01T00-00-00", &thread(0), CWD, &[]);
        let dir = home.join(".codex/sessions/2026/11/15");
        fs::create_dir_all(&dir).unwrap();
        let other = serde_json::json!({"type": "session_meta", "payload": {"id": thread(1), "cwd": "C:\\other"}}).to_string();
        for n in 0..MAX_ROLLOUTS {
            fs::write(dir.join(format!("rollout-2026-11-15T10-00-00-{n:06}.jsonl")), &other).unwrap();
        }
        assert!(codex(&home, CWD).is_empty());
        fs::remove_dir_all(home).ok();
    }

    fn session(id: &str, adapter: &str, engine_session: Option<&str>, started_at: u64, interface: Interface) -> SessionInfo {
        serde_json::from_value(serde_json::json!({
            "id": id, "adapter": adapter, "task": {"kind": "folder", "path": "x"}, "title": "t", "workspace": [], "status": "idle",
            "startedAt": started_at, "interface": interface, "engineSession": engine_session,
        }))
        .unwrap()
    }

    fn one(id: &str) -> Conversation {
        Conversation { id: id.into(), title: "t".into(), updated_at: 1, hivemind_session: None }
    }

    #[test]
    fn a_conversation_is_bound_to_the_newest_session_that_holds_it() {
        let (own, imported, other) = (id(1), id(2), id(3));
        let hive_a = "aaaaaaaa-0000-4000-8000-000000000001";
        let hive_b = "bbbbbbbb-0000-4000-8000-000000000002";
        let sessions = vec![
            session(&own, "claude-code", None, 5, Interface::Terminal),
            session(hive_a, "claude-code", Some(&imported), 5, Interface::Terminal),
            session(hive_b, "claude-code", Some(&imported), 9, Interface::Terminal),
            // A chat session, a Codex session and a session that moved on to another conversation do not bind.
            session(&other, "claude-code", None, 5, Interface::Chat),
            session(&id(4), "codex", None, 5, Interface::Terminal),
        ];
        let mut list = vec![one(&own), one(&imported), one(&other), one(&id(4))];
        bind(&mut list, Engine::Claude, &sessions);
        let bound: Vec<Option<&str>> = list.iter().map(|c| c.hivemind_session.as_deref()).collect();
        assert_eq!(bound, vec![Some(own.as_str()), Some(hive_b), None, None]);

        // Codex binds by thread only; a Claude-style id match does not count.
        let codex_sessions = vec![session(THREAD, "codex", None, 1, Interface::Terminal), session(hive_a, "codex", Some(THREAD), 1, Interface::Terminal)];
        let mut threads = vec![one(THREAD)];
        bind(&mut threads, Engine::Codex, &codex_sessions);
        assert_eq!(threads[0].hivemind_session.as_deref(), Some(hive_a));
    }

    #[test]
    fn a_conversation_serialises_in_camel_case() {
        let value = serde_json::to_value(one("x")).unwrap();
        assert_eq!(value, serde_json::json!({"id": "x", "title": "t", "updatedAt": 1, "hivemindSession": null}));
    }
}
