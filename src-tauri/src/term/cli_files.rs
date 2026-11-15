//! Finding the CLIs' own conversation files. Read-only; every path is built from the home folder (a parameter, so tests
//! use a temp folder) plus an id that was checked to be hex digits and dashes.
use serde_json::Value;
use std::io::BufRead;
use std::path::{Path, PathBuf};

/// A session or thread id: hex digits and dashes only, so it cannot step out of its folder.
pub fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

/// Claude Code's folder name for a working directory: `:`, `\`, `/` and `.` become `-`.
pub fn claude_folder(cwd: &str) -> String {
    cwd.chars().map(|c| if matches!(c, ':' | '\\' | '/' | '.') { '-' } else { c }).collect()
}

/// The transcript Claude Code keeps for a session: `~/.claude/projects/<folder>/<id>.jsonl`. When that file is not there
/// (a folder name this mapping gets wrong, such as one with spaces), the project folders are searched by file name only.
pub fn claude_transcript(home: &Path, cwd: &str, id: &str) -> Option<PathBuf> {
    if !valid_id(id) {
        return None;
    }
    let projects = home.join(".claude").join("projects");
    let direct = projects.join(claude_folder(cwd)).join(format!("{id}.jsonl"));
    if direct.is_file() {
        return Some(direct);
    }
    std::fs::read_dir(&projects)
        .ok()?
        .flatten()
        .map(|entry| entry.path().join(format!("{id}.jsonl")))
        .find(|path| path.is_file())
}

/// The last `ai-title` record of a Claude Code transcript.
pub fn claude_title(path: &Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    String::from_utf8_lossy(&bytes)
        .lines()
        .filter(|line| line.contains("\"ai-title\""))
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|value| value.get("type").and_then(Value::as_str) == Some("ai-title"))
        .filter_map(|value| value.get("aiTitle").and_then(Value::as_str).map(|title| title.trim().to_string()))
        .rfind(|title| !title.is_empty())
}

/// Days since 1970-01-01 of a civil date (Howard Hinnant's algorithm).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// "2026-11-15T20:01:02.123Z" (UTC) as milliseconds since the epoch.
pub fn parse_iso_ms(text: &str) -> Option<u64> {
    let (date, time) = text.split_once('T')?;
    let time = time.strip_suffix('Z').or_else(|| time.strip_suffix("+00:00"))?;
    let mut d = date.split('-').map(|part| part.parse::<i64>().ok());
    let (y, m, day) = (d.next()??, d.next()??, d.next()??);
    let (clock, fraction) = time.split_once('.').unwrap_or((time, ""));
    let mut t = clock.split(':').map(|part| part.parse::<i64>().ok());
    let (h, min, s) = (t.next()??, t.next()??, t.next()??);
    let millis: i64 = format!("{fraction:0<3}")[..3].parse().ok()?;
    let ms = (((days_from_civil(y, m, day) * 24 + h) * 60 + min) * 60 + s) * 1000 + millis;
    u64::try_from(ms).ok()
}

/// A folder path for comparison: slashes forward, no trailing slash, no `\\?\` prefix, lower case on Windows.
fn plain(path: &str) -> String {
    let text = path.replace('\\', "/");
    let text = text.strip_prefix("//?/").unwrap_or(&text).trim_end_matches('/').to_string();
    if cfg!(windows) { text.to_lowercase() } else { text }
}

pub(super) fn same_folder(a: &str, b: &str) -> bool {
    plain(a) == plain(b)
}

/// The rollout folders `YYYY/MM/DD` under `~/.codex/sessions`, with their day number (UTC reading of the folder's date).
pub(super) fn date_folders(home: &Path) -> Vec<(i64, PathBuf)> {
    let number = |path: &Path| path.file_name()?.to_str()?.parse::<i64>().ok();
    let children = |path: &Path| -> Vec<(i64, PathBuf)> {
        std::fs::read_dir(path)
            .into_iter()
            .flatten()
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| path.is_dir())
            .filter_map(|path| Some((number(&path)?, path)))
            .collect()
    };
    let mut found = Vec::new();
    for (year, year_dir) in children(&home.join(".codex").join("sessions")) {
        for (month, month_dir) in children(&year_dir) {
            for (day, day_dir) in children(&month_dir) {
                found.push((days_from_civil(year, month, day), day_dir));
            }
        }
    }
    found
}

pub(super) fn rollouts(dir: &Path) -> impl Iterator<Item = PathBuf> {
    std::fs::read_dir(dir).into_iter().flatten().flatten().map(|entry| entry.path()).filter(|path| {
        path.file_name().and_then(|n| n.to_str()).is_some_and(|name| name.starts_with("rollout-") && name.ends_with(".jsonl"))
    })
}

pub(super) fn first_line(path: &Path) -> Option<Value> {
    let mut line = String::new();
    std::io::BufReader::new(std::fs::File::open(path).ok()?).read_line(&mut line).ok()?;
    serde_json::from_str(&line).ok()
}

/// The thread ids of the rollouts filed on or after the day before `since_ms`, from the file names alone
/// (`rollout-<time>-<id>.jsonl`), so nothing is read. Taken before a Codex terminal starts, to tell its own thread apart.
pub fn codex_thread_ids(home: &Path, since_ms: u64) -> Vec<String> {
    let first_day = (since_ms / 86_400_000) as i64 - 1;
    date_folders(home)
        .into_iter()
        .filter(|(day, _)| *day >= first_day)
        .flat_map(|(_, dir)| rollouts(&dir).collect::<Vec<_>>())
        .filter_map(|path| {
            let name = path.file_name()?.to_str()?;
            let stem = name.strip_suffix(".jsonl")?;
            // `rollout-` + `YYYY-MM-DDThh-mm-ss` (19 characters) + `-` + the id.
            let id = stem.get("rollout-".len() + 19 + 1..)?;
            valid_id(id).then(|| id.to_string())
        })
        .collect()
}

/// The thread a Codex session started: the rollout filed on or after the day before `since_ms` whose first
/// `session_meta` names this folder and starts at or after `since_ms` (less a few seconds). Threads in `taken` belong to
/// other sessions and threads in `before` existed when the terminal started. When more than one candidate is left the
/// answer is None (it is looked for again later). The date folders are in local time, so a day of slack is read on each
/// side of the UTC date.
pub fn codex_thread(home: &Path, cwd: &str, since_ms: u64, taken: &[String], before: &[String]) -> Option<String> {
    const SLACK_MS: u64 = 5_000;
    let first_day = (since_ms / 86_400_000) as i64 - 1;
    let mut found: Vec<String> = Vec::new();
    for (day, dir) in date_folders(home) {
        if day < first_day {
            continue;
        }
        for path in rollouts(&dir) {
            let Some(meta) = first_line(&path) else { continue };
            if meta.get("type").and_then(Value::as_str) != Some("session_meta") {
                continue;
            }
            let payload = &meta["payload"];
            let (Some(id), Some(folder), Some(at)) = (
                payload.get("id").and_then(Value::as_str).filter(|id| valid_id(id)),
                payload.get("cwd").and_then(Value::as_str),
                payload.get("timestamp").and_then(Value::as_str).and_then(parse_iso_ms),
            ) else {
                continue;
            };
            if !same_folder(folder, cwd) || at + SLACK_MS < since_ms || taken.iter().chain(before).any(|t| t == id) {
                continue;
            }
            if !found.iter().any(|f| f == id) {
                found.push(id.to_string());
            }
        }
    }
    if found.len() == 1 { found.pop() } else { None }
}

/// The rollout file of a known thread, from any date folder.
pub fn codex_rollout(home: &Path, id: &str) -> Option<PathBuf> {
    if !valid_id(id) {
        return None;
    }
    let tail = format!("-{id}.jsonl");
    date_folders(home)
        .into_iter()
        .flat_map(|(_, dir)| rollouts(&dir).collect::<Vec<_>>())
        .find(|path| path.file_name().and_then(|n| n.to_str()).is_some_and(|name| name.ends_with(&tail)))
}

/// The thread's name from `~/.codex/session_index.jsonl`; the last line for the id wins.
pub fn codex_title(home: &Path, thread_id: &str) -> Option<String> {
    let bytes = std::fs::read(home.join(".codex").join("session_index.jsonl")).ok()?;
    String::from_utf8_lossy(&bytes)
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|value| value.get("id").and_then(Value::as_str) == Some(thread_id))
        .filter_map(|value| value.get("thread_name").and_then(Value::as_str).map(|name| name.trim().to_string()))
        .next_back()
        .filter(|name| !name.is_empty())
}

/// What `~/.codex/session_index.jsonl` says about each thread: its name and when it was last updated (ms). The last
/// line for an id wins.
pub fn codex_index(home: &Path) -> std::collections::HashMap<String, (Option<String>, Option<u64>)> {
    let mut index = std::collections::HashMap::new();
    let Ok(bytes) = std::fs::read(home.join(".codex").join("session_index.jsonl")) else { return index };
    for value in String::from_utf8_lossy(&bytes).lines().filter_map(|line| serde_json::from_str::<Value>(line).ok()) {
        let Some(id) = value.get("id").and_then(Value::as_str) else { continue };
        let name = value.get("thread_name").and_then(Value::as_str).map(|name| name.trim().to_string()).filter(|name| !name.is_empty());
        let at = value.get("updated_at").and_then(Value::as_str).and_then(parse_iso_ms);
        index.insert(id.to_string(), (name, at));
    }
    index
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    const ID: &str = "0ea3c5d4-1111-4222-8333-444455556666";
    const THREAD: &str = "019b0000-aaaa-7bbb-8ccc-ddddeeeeffff";

    fn home(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hivemind-clifiles-{name}-{}", std::process::id()));
        fs::remove_dir_all(&dir).ok();
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn direct_path(home: &Path, cwd: &str) -> PathBuf {
        home.join(".claude/projects").join(claude_folder(cwd)).join(format!("{ID}.jsonl"))
    }

    fn write(path: &Path, text: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    fn rollout(home: &Path, day: &str, name_time: &str, id: &str, cwd: &str, timestamp: &str) {
        let meta = serde_json::json!({"type": "session_meta", "payload": {"id": id, "cwd": cwd, "timestamp": timestamp, "source": "cli"}});
        write(&home.join(".codex/sessions").join(day).join(format!("rollout-{name_time}-{id}.jsonl")), &format!("{meta}\n{{\"type\":\"turn_context\"}}\n"));
    }

    #[test]
    fn a_folder_name_replaces_colon_slashes_and_dots() {
        assert_eq!(
            claude_folder("C:\\Users\\tyler\\AppData\\Roaming\\dev.hivemind.app\\worktrees\\paystream-22d58047\\0ea3c5d4"),
            "C--Users-tyler-AppData-Roaming-dev-hivemind-app-worktrees-paystream-22d58047-0ea3c5d4"
        );
        assert_eq!(claude_folder("/home/a.b/c"), "-home-a-b-c");
    }

    #[test]
    fn ids_are_checked_before_they_make_a_path() {
        assert!(valid_id(ID));
        for bad in ["", "..", "../x", "a/b", "a\\b", "zz", "ab.jsonl"] {
            assert!(!valid_id(bad), "{bad}");
        }
        let home = home("ids");
        assert_eq!(claude_transcript(&home, "C:\\x", "../../etc"), None);
        assert_eq!(codex_rollout(&home, "../x"), None);
        fs::remove_dir_all(home).ok();
    }

    #[test]
    fn the_claude_transcript_is_found_by_folder_then_by_scan() {
        let home = home("claude");
        let cwd = "C:\\Users\\tyler\\wt\\one";
        let direct = direct_path(&home, cwd);
        write(&direct, "{}\n");
        assert_eq!(claude_transcript(&home, cwd, ID), Some(direct.clone()));
        // A folder the mapping gets wrong (a space, say) is found by scanning the project folders for the name.
        let odd = home.join(".claude/projects/C--with-space-in-it").join(format!("{ID}.jsonl"));
        write(&odd, "{}\n");
        fs::remove_file(&direct).unwrap();
        assert_eq!(claude_transcript(&home, cwd, ID), Some(odd));
        assert_eq!(claude_transcript(&home, cwd, "3333c5d4-1111-4222-8333-444455556666"), None);
        fs::remove_dir_all(home).ok();
    }

    #[test]
    fn the_last_ai_title_wins() {
        let home = home("title");
        let path = home.join("t.jsonl");
        write(
            &path,
            "{\"type\":\"user\",\"message\":{\"content\":\"ai-title is not a record\"}}\n{\"type\":\"ai-title\",\"aiTitle\":\"First\"}\nnot json ai-title\n{\"type\":\"ai-title\",\"aiTitle\":\"Second title\"}\n{\"type\":\"last-prompt\"}\n",
        );
        assert_eq!(claude_title(&path).as_deref(), Some("Second title"));
        write(&path, "{\"type\":\"user\"}\n");
        assert_eq!(claude_title(&path), None);
        assert_eq!(claude_title(&home.join("missing.jsonl")), None);
        fs::remove_dir_all(home).ok();
    }

    #[test]
    fn iso_times_parse_to_epoch_milliseconds() {
        assert_eq!(parse_iso_ms("1970-01-01T00:00:01.500Z"), Some(1500));
        assert_eq!(parse_iso_ms("2026-11-15T00:00:00Z"), Some(1_794_700_800_000));
        assert_eq!(parse_iso_ms("2026-11-15T00:00:00.1Z"), Some(1_794_700_800_100));
        assert_eq!(parse_iso_ms("yesterday"), None);
    }

    #[test]
    fn a_codex_thread_is_the_earliest_rollout_for_the_folder_after_the_start() {
        let home = home("codex");
        let cwd = "C:\\Users\\tyler\\wt\\one";
        let start = parse_iso_ms("2026-11-15T23:30:00Z").unwrap();
        // The local date (UTC-7) of a 23:31 UTC start is the 15th; a rollout filed on the 15th and a decoy in another folder.
        rollout(&home, "2026/11/15", "2026-11-15T16-31-00", THREAD, "c:/users/tyler/wt/one/", "2026-11-15T23:31:00.000Z");
        rollout(&home, "2026/11/15", "2026-11-15T16-30-30", "019b1111-aaaa-7bbb-8ccc-ddddeeeeffff", "C:\\Users\\tyler\\wt\\two", "2026-11-15T23:30:30.000Z");
        // Too early (before the session), and a later one for the same folder.
        rollout(&home, "2026/11/14", "2026-11-14T10-00-00", "019b2222-aaaa-7bbb-8ccc-ddddeeeeffff", cwd, "2026-11-14T17:00:00.000Z");
        rollout(&home, "2026/11/15", "2026-11-15T17-00-00", "019b3333-aaaa-7bbb-8ccc-ddddeeeeffff", cwd, "2026-11-16T00:00:00.000Z");
        // Two candidates are left (the earlier one and the later one): none is chosen.
        assert_eq!(codex_thread(&home, cwd, start, &[], &[]), None);
        // Another session already holds one of them: the other is taken.
        assert_eq!(codex_thread(&home, cwd, start, &[THREAD.to_string()], &[]).as_deref(), Some("019b3333-aaaa-7bbb-8ccc-ddddeeeeffff"));
        assert_eq!(codex_thread(&home, cwd, start, &[], &["019b3333-aaaa-7bbb-8ccc-ddddeeeeffff".to_string()]).as_deref(), Some(THREAD));
        assert_eq!(codex_thread(&home, "C:\\elsewhere", start, &[], &[]), None);
        assert!(codex_rollout(&home, THREAD).is_some());
        assert_eq!(codex_rollout(&home, "019bffff-aaaa-7bbb-8ccc-ddddeeeeffff"), None);
        fs::remove_dir_all(home).ok();
    }

    #[test]
    fn a_rollout_in_the_next_local_day_folder_is_still_read() {
        let home = home("codex-day");
        let cwd = "/work/one";
        // Started 01:00 UTC on the 16th; local time (UTC+10) files it under the 16th, and UTC-8 under the 15th.
        let start = parse_iso_ms("2026-11-16T01:00:00Z").unwrap();
        rollout(&home, "2026/11/15", "2026-11-15T17-00-10", THREAD, cwd, "2026-11-16T01:00:10.000Z");
        assert_eq!(codex_thread(&home, cwd, start, &[], &[]).as_deref(), Some(THREAD));
        fs::remove_dir_all(home).ok();
    }

    #[test]
    fn a_conversation_that_existed_before_the_start_is_not_the_terminals() {
        let home = home("codex-before");
        let cwd = "/work/one";
        let start = parse_iso_ms("2026-11-16T10:00:00Z").unwrap();
        // Another conversation in the same folder began 3 s before the terminal: inside the slack, so it passes the time check.
        let other = "019b4444-aaaa-7bbb-8ccc-ddddeeeeffff";
        rollout(&home, "2026/11/16", "2026-11-16T09-59-57", other, cwd, "2026-11-16T09:59:57.000Z");
        let before = codex_thread_ids(&home, start);
        assert_eq!(before, vec![other.to_string()]);
        rollout(&home, "2026/11/16", "2026-11-16T10-00-02", THREAD, cwd, "2026-11-16T10:00:02.000Z");
        assert_eq!(codex_thread(&home, cwd, start, &[], &before).as_deref(), Some(THREAD));
        // Without the list, both look like candidates and none is chosen.
        assert_eq!(codex_thread(&home, cwd, start, &[], &[]), None);
        fs::remove_dir_all(home).ok();
    }

    #[test]
    fn the_codex_title_is_the_last_index_line_for_the_thread() {
        let home = home("index");
        write(
            &home.join(".codex/session_index.jsonl"),
            &format!(
                "{{\"id\":\"{THREAD}\",\"thread_name\":\"Old name\",\"updated_at\":\"x\"}}\n{{\"id\":\"019b9999-aaaa-7bbb-8ccc-ddddeeeeffff\",\"thread_name\":\"Other\"}}\nbroken\n{{\"id\":\"{THREAD}\",\"thread_name\":\"New name\",\"updated_at\":\"y\"}}\n"
            ),
        );
        assert_eq!(codex_title(&home, THREAD).as_deref(), Some("New name"));
        assert_eq!(codex_title(&home, "019bfeed-aaaa-7bbb-8ccc-ddddeeeeffff"), None);
        fs::remove_dir_all(home).ok();
    }
}
