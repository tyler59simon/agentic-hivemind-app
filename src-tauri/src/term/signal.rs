//! Attention signals: what tells Hivemind that a terminal program needs the user or has finished its turn.
//!
//! Claude Code runs Hivemind's own executable as a hook (`hook_main`), which appends one line to the terminal's
//! `signals.jsonl`; `Intake` reads the new lines. Codex rings the terminal instead (OSC 9 or BEL), which `Scanner`
//! finds in the program's output.
use serde::{Deserialize, Serialize};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

/// What a terminal wants from the user.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    /// The program needs an answer (a permission, a question).
    Waiting,
    /// The program finished its turn.
    Done,
}

/// The file hooks append to, inside the terminal's folder.
pub const SIGNALS: &str = "signals.jsonl";
/// The hook settings Claude Code is started with, inside the terminal's folder.
pub const SETTINGS: &str = "settings.json";
/// The hook helper reads at most this much of its input.
const STDIN_LIMIT: u64 = 64 * 1024;
/// `Intake` reads at most this much per poll.
const POLL_LIMIT: u64 = 256 * 1024;
/// An OSC longer than this is dropped.
const OSC_LIMIT: usize = 4096;

/// The command-line switch that makes the executable a hook helper.
pub const FLAG: &str = "--hivemind-signal";

// ---- Claude Code: the hook helper, its settings file and the reader of its output ----

/// The kind and type a hook event stands for, from the event name the settings pass (`notification`, `stop`) and the
/// hook's JSON. None for notifications that do not need the user (and for anything unknown).
pub fn classify_hook(event: &str, input: &serde_json::Value) -> Option<(Kind, &'static str)> {
    match event {
        "stop" => Some((Kind::Done, "stop")),
        "notification" => match input.get("notification_type")?.as_str()? {
            "permission_prompt" => Some((Kind::Waiting, "permission_prompt")),
            "elicitation_dialog" => Some((Kind::Waiting, "elicitation_dialog")),
            "agent_needs_input" => Some((Kind::Waiting, "agent_needs_input")),
            "idle_prompt" => Some((Kind::Done, "idle_prompt")),
            _ => None,
        },
        _ => None,
    }
}

/// Append one signal line to `<dir>/signals.jsonl`. Only the kind, the type and the time are written: never the hook's
/// message, folder or transcript path. `dir` must be an absolute, existing folder.
fn append_signal(dir: &Path, kind: Kind, kind_type: &str, now_ms: u64) -> Option<()> {
    if !dir.is_absolute() || !dir.is_dir() {
        return None;
    }
    let line = format!("{}\n", serde_json::json!({ "kind": kind, "type": kind_type, "at": now_ms }));
    let mut file = std::fs::OpenOptions::new().create(true).append(true).open(dir.join(SIGNALS)).ok()?;
    file.write_all(line.as_bytes()).ok()
}

/// The hook helper's work, with its inputs given (tests use this).
fn handle(event: &str, mut stdin: impl Read, dir: Option<&Path>, now_ms: u64) -> Option<()> {
    let mut bytes = Vec::new();
    stdin.by_ref().take(STDIN_LIMIT).read_to_end(&mut bytes).ok()?;
    let input: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    let (kind, kind_type) = classify_hook(event, &input)?;
    append_signal(dir?, kind, kind_type, now_ms)
}

/// Hook mode: `Some(exit code)` when `args` (the program's own arguments, the program name first) ask for it, else None
/// and the app starts as usual. Every failure is silent and the code is 0: a hook must never hold the CLI up.
pub fn hook_main(args: &[String]) -> Option<i32> {
    let event = match args.get(1..)? {
        [flag, event, ..] if flag == FLAG => event.as_str(),
        _ => return None,
    };
    let dir = std::env::var_os("HIVEMIND_SIGNAL_DIR").map(PathBuf::from);
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    let _ = handle(event, std::io::stdin().lock(), dir.as_deref(), now);
    Some(0)
}

/// The settings file for Claude Code's `--settings`: a `Notification` and a `Stop` hook that run `exe` in exec form.
pub fn claude_settings(exe: &Path) -> serde_json::Value {
    let hook = |event: &str| serde_json::json!([{ "hooks": [{ "type": "command", "command": exe.display().to_string(), "args": [FLAG, event] }] }]);
    serde_json::json!({ "hooks": { "Notification": hook("notification"), "Stop": hook("stop") } })
}

/// Prepare a Claude terminal's folder: write its settings file and remove signals left by an earlier run.
/// Returns the settings path.
pub fn prepare_claude(dir: &Path, exe: &Path) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    let _ = std::fs::remove_file(dir.join(SIGNALS));
    let path = dir.join(SETTINGS);
    let text = serde_json::to_string_pretty(&claude_settings(exe)).map_err(|e| e.to_string())?;
    std::fs::write(&path, text).map_err(|e| format!("Could not write {}: {e}", path.display()))?;
    Ok(path)
}

#[derive(Deserialize)]
struct Line {
    kind: Kind,
}

/// Reads the lines hooks append to `signals.jsonl`, each only once.
#[derive(Default)]
pub struct Intake {
    offset: u64,
}

impl Intake {
    /// The kinds of the lines added since the last call. A partial last line waits for its end; a shorter file starts over.
    pub fn poll(&mut self, path: &Path) -> Vec<Kind> {
        let Ok(mut file) = std::fs::File::open(path) else { return vec![] };
        let Ok(len) = file.metadata().map(|m| m.len()) else { return vec![] };
        if len < self.offset {
            self.offset = 0;
        }
        if len == self.offset || file.seek(SeekFrom::Start(self.offset)).is_err() {
            return vec![];
        }
        let mut bytes = Vec::new();
        if file.take((len - self.offset).min(POLL_LIMIT)).read_to_end(&mut bytes).is_err() {
            return vec![];
        }
        let Some(end) = bytes.iter().rposition(|b| *b == b'\n') else {
            // No complete line yet; a line this long can never complete, so it is skipped.
            if bytes.len() as u64 >= POLL_LIMIT {
                self.offset += bytes.len() as u64;
            }
            return vec![];
        };
        self.offset += end as u64 + 1;
        bytes[..end].split(|b| *b == b'\n').filter_map(|line| serde_json::from_slice::<Line>(line).ok()).map(|line| line.kind).collect()
    }
}

// ---- Codex: the terminal bell ----

/// What a Codex notification text means. Codex's OSC 9 text for an approval request and for a finished turn is not
/// known until it is seen in the running app (check U5): text with "approv" in it (any case) is taken as waiting, and
/// anything else as done.
pub fn classify_text(text: &[u8]) -> Kind {
    if text.windows(6).any(|w| w.eq_ignore_ascii_case(b"approv")) {
        Kind::Waiting
    } else {
        Kind::Done
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum State {
    Ground,
    /// Saw ESC.
    Esc,
    /// Inside `ESC ]`, collecting the text.
    Osc,
    /// Inside an OSC, saw ESC (the start of `ESC \`).
    OscEsc,
    /// Inside an OSC that grew too long: skipped up to its end.
    Skip,
    SkipEsc,
}

/// Finds OSC 9 notifications (`ESC ] 9 ; text BEL` or `... ESC \`) and bare BELs in a byte stream fed in chunks of any
/// size. It never allocates after `new` and keeps at most `OSC_LIMIT` bytes of an unfinished OSC.
pub struct Scanner {
    state: State,
    buf: Vec<u8>,
}

impl Default for Scanner {
    fn default() -> Self {
        Scanner { state: State::Ground, buf: Vec::with_capacity(OSC_LIMIT) }
    }
}

impl Scanner {
    /// Feed the next bytes; `found` is called once for each OSC 9 (kind from its text) and each bare BEL (done).
    pub fn feed(&mut self, bytes: &[u8], mut found: impl FnMut(Kind)) {
        for &b in bytes {
            self.state = match (self.state, b) {
                (State::Ground, 0x1b) => State::Esc,
                (State::Ground, 0x07) => {
                    found(Kind::Done);
                    State::Ground
                }
                (State::Ground, _) => State::Ground,
                (State::Esc, b']') => {
                    self.buf.clear();
                    State::Osc
                }
                (State::Esc, 0x1b) => State::Esc,
                (State::Esc, _) => State::Ground,
                (State::Osc, 0x07) | (State::OscEsc, b'\\') => {
                    if let Some(text) = self.buf.strip_prefix(b"9;") {
                        found(classify_text(text));
                    }
                    State::Ground
                }
                (State::Osc, 0x1b) => State::OscEsc,
                (State::Osc, _) => {
                    if self.buf.len() >= OSC_LIMIT {
                        State::Skip
                    } else {
                        self.buf.push(b);
                        State::Osc
                    }
                }
                // An ESC that is not followed by `\` ends the OSC unfinished and starts another sequence.
                (State::OscEsc, 0x1b) => State::OscEsc,
                (State::OscEsc, b']') => {
                    self.buf.clear();
                    State::Osc
                }
                (State::OscEsc, _) => State::Ground,
                (State::Skip, 0x07) | (State::SkipEsc, b'\\') => State::Ground,
                (State::Skip, 0x1b) => State::SkipEsc,
                (State::Skip, _) => State::Skip,
                (State::SkipEsc, 0x1b) => State::SkipEsc,
                (State::SkipEsc, _) => State::Ground,
            };
        }
    }
}

/// Whether bytes sent to a terminal came from the user. xterm also sends focus reports and answers to the program's
/// queries (cursor position, device attributes, OSC replies); those are not the user answering.
pub fn is_user_input(data: &[u8]) -> bool {
    if data == b"\x1b[I" || data == b"\x1b[O" || data.starts_with(b"\x1b]") {
        return false;
    }
    let reply = data.strip_prefix(b"\x1b[").is_some_and(|rest| {
        matches!(rest.last(), Some(b'R' | b'c')) && rest[..rest.len() - 1].iter().all(|b| b.is_ascii_digit() || matches!(b, b';' | b'?' | b'>'))
    });
    !reply
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn scan(chunks: &[&[u8]]) -> Vec<Kind> {
        let mut scanner = Scanner::default();
        let mut out = vec![];
        for chunk in chunks {
            scanner.feed(chunk, |k| out.push(k));
        }
        out
    }

    #[test]
    fn osc_9_with_bel_or_st_is_found() {
        assert_eq!(scan(&[b"x\x1b]9;Turn complete\x07y"]), vec![Kind::Done]);
        assert_eq!(scan(&[b"\x1b]9;Turn complete\x1b\\"]), vec![Kind::Done]);
        assert_eq!(scan(&[b"\x1b]9;Approval requested: run ls\x07"]), vec![Kind::Waiting]);
        assert_eq!(scan(&[b"\x1b]9;APPROVE this?\x1b\\"]), vec![Kind::Waiting]);
    }

    #[test]
    fn a_sequence_split_anywhere_is_found_once() {
        let whole: &[u8] = b"ab\x1b]9;Approval requested\x1b\\cd";
        for cut in 0..=whole.len() {
            assert_eq!(scan(&[&whole[..cut], &whole[cut..]]), vec![Kind::Waiting], "cut at {cut}");
        }
        let bytes: Vec<&[u8]> = whole.chunks(1).collect();
        assert_eq!(scan(&bytes), vec![Kind::Waiting]);
    }

    #[test]
    fn a_bare_bel_counts_but_a_bel_ending_another_osc_does_not() {
        assert_eq!(scan(&[b"done\x07"]), vec![Kind::Done]);
        assert_eq!(scan(&[b"\x1b]0;window title\x07"]), vec![]);
        assert_eq!(scan(&[b"\x1b]0;title\x07\x07"]), vec![Kind::Done]);
        assert_eq!(scan(&[b"\x1b]52;c;aGk=\x07"]), vec![]);
        assert_eq!(scan(&[b"\x1b[31mred\x1b[0m"]), vec![]);
    }

    #[test]
    fn several_signals_and_an_interrupted_osc() {
        assert_eq!(scan(&[b"\x07\x1b]9;a\x07\x1b]9;approval\x07"]), vec![Kind::Done, Kind::Done, Kind::Waiting]);
        // An OSC cut off by another escape sequence is dropped; the next one still works.
        assert_eq!(scan(&[b"\x1b]9;lost\x1b[0m\x1b]9;kept\x07"]), vec![Kind::Done]);
        assert_eq!(scan(&[b"\x1b]9;lost\x1b]9;approve\x07"]), vec![Kind::Waiting]);
    }

    #[test]
    fn an_unterminated_osc_is_dropped_after_4_kb() {
        let mut scanner = Scanner::default();
        let mut found = vec![];
        scanner.feed(b"\x1b]9;", |k| found.push(k));
        for _ in 0..10 {
            scanner.feed(&[b'a'; 1000], |k| found.push(k));
        }
        assert!(scanner.buf.len() <= OSC_LIMIT);
        assert!(scanner.buf.capacity() <= OSC_LIMIT * 2);
        // Its late terminator reports nothing, and the scanner works again afterwards.
        scanner.feed(b"\x07", |k| found.push(k));
        assert_eq!(found, vec![]);
        scanner.feed(b"\x1b]9;ok\x07", |k| found.push(k));
        assert_eq!(found, vec![Kind::Done]);
    }

    #[test]
    fn text_is_classified_by_approv() {
        assert_eq!(classify_text(b"Approval requested"), Kind::Waiting);
        assert_eq!(classify_text(b"please APPROVE"), Kind::Waiting);
        assert_eq!(classify_text(b"Agent turn complete"), Kind::Done);
        assert_eq!(classify_text(b""), Kind::Done);
    }

    #[test]
    fn replies_and_focus_reports_are_not_user_input() {
        for reply in [&b"\x1b[I"[..], b"\x1b[O", b"\x1b[12;40R", b"\x1b[?1;2c", b"\x1b[>0;276;0c", b"\x1b]11;rgb:0000/0000/0000\x07"] {
            assert!(!is_user_input(reply), "{reply:?}");
        }
        for typed in [&b"a"[..], b"\r", b"\x1b", b"\x1b[A", b"\x1b[1;5C", b"\x03", "é".as_bytes(), b"\x1bv"] {
            assert!(is_user_input(typed), "{typed:?}");
        }
    }

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hivemind-signal-{name}-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn hook(event: &str, input: serde_json::Value, dir: Option<&Path>) -> Option<()> {
        handle(event, input.to_string().as_bytes(), dir, 1234)
    }

    #[test]
    fn hook_events_map_to_kinds() {
        let n = |t: &str| json!({ "notification_type": t });
        assert_eq!(classify_hook("notification", &n("permission_prompt")), Some((Kind::Waiting, "permission_prompt")));
        assert_eq!(classify_hook("notification", &n("elicitation_dialog")).map(|k| k.0), Some(Kind::Waiting));
        assert_eq!(classify_hook("notification", &n("agent_needs_input")).map(|k| k.0), Some(Kind::Waiting));
        assert_eq!(classify_hook("notification", &n("idle_prompt")).map(|k| k.0), Some(Kind::Done));
        assert_eq!(classify_hook("notification", &n("auth_success")), None);
        assert_eq!(classify_hook("notification", &json!({})), None);
        assert_eq!(classify_hook("stop", &json!({})), Some((Kind::Done, "stop")));
        assert_eq!(classify_hook("other", &json!({})), None);
    }

    #[test]
    fn the_hook_writes_one_line_without_the_hook_text() {
        let dir = temp("hook");
        let input = json!({
            "hook_event_name": "Notification", "notification_type": "permission_prompt", "session_id": "s1",
            "message": "Claude needs your permission to run SECRET-MESSAGE", "cwd": "C:\\SECRET-CWD", "transcript_path": "C:\\SECRET-TRANSCRIPT.jsonl",
        });
        assert!(hook("notification", input, Some(&dir)).is_some());
        let text = std::fs::read_to_string(dir.join(SIGNALS)).unwrap();
        assert_eq!(text.lines().count(), 1);
        assert_eq!(serde_json::from_str::<serde_json::Value>(text.trim()).unwrap(), json!({ "kind": "waiting", "type": "permission_prompt", "at": 1234 }));
        assert!(!text.contains("SECRET"));
        assert!(hook("stop", json!({ "session_id": "s1", "cwd": "x" }), Some(&dir)).is_some());
        assert_eq!(std::fs::read_to_string(dir.join(SIGNALS)).unwrap().lines().count(), 2);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_hook_ignores_bad_input_and_bad_folders() {
        let dir = temp("bad");
        assert!(handle("stop", &b"not json"[..], Some(&dir), 1).is_none());
        assert!(handle("stop", &b""[..], Some(&dir), 1).is_none());
        assert!(hook("notification", json!({ "notification_type": "auth_success" }), Some(&dir)).is_none());
        assert!(hook("stop", json!({}), Some(Path::new("relative-folder"))).is_none());
        assert!(hook("stop", json!({}), Some(&dir.join("missing"))).is_none());
        assert!(hook("stop", json!({}), None).is_none());
        assert!(!dir.join(SIGNALS).exists());
        assert!(!Path::new("relative-folder").join(SIGNALS).exists());
        // Input over the limit is cut, which leaves invalid JSON.
        let big = format!("{{\"message\":\"{}\"}}", "x".repeat(100_000));
        assert!(handle("stop", big.as_bytes(), Some(&dir), 1).is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn hook_main_answers_only_to_its_flag() {
        let args = |list: &[&str]| list.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(hook_main(&args(&["hivemind"])), None);
        assert_eq!(hook_main(&args(&["hivemind", "--other", "stop"])), None);
        assert_eq!(hook_main(&args(&["hivemind", FLAG])), None);
    }

    #[test]
    fn the_settings_hold_two_exec_form_hooks() {
        let exe = Path::new("C:\\Apps\\Hivemind\\hivemind.exe");
        let settings = claude_settings(exe);
        let hooks = settings["hooks"].as_object().unwrap();
        assert_eq!(hooks.len(), 2);
        for (name, event) in [("Notification", "notification"), ("Stop", "stop")] {
            assert_eq!(settings["hooks"][name], json!([{ "hooks": [{ "type": "command", "command": exe.display().to_string(), "args": ["--hivemind-signal", event] }] }]));
        }
        let dir = temp("prepare");
        std::fs::write(dir.join(SIGNALS), "{\"kind\":\"done\"}\n").unwrap();
        let path = prepare_claude(&dir, exe).unwrap();
        assert_eq!(path, dir.join(SETTINGS));
        assert_eq!(serde_json::from_str::<serde_json::Value>(&std::fs::read_to_string(&path).unwrap()).unwrap(), settings);
        assert!(!dir.join(SIGNALS).exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn intake_reads_new_lines_once() {
        let dir = temp("intake");
        let path = dir.join(SIGNALS);
        let mut intake = Intake::default();
        assert_eq!(intake.poll(&path), vec![]);
        std::fs::write(&path, "{\"kind\":\"waiting\",\"type\":\"x\",\"at\":1}\n{\"kind\":\"done\",\"at\":2}\n").unwrap();
        assert_eq!(intake.poll(&path), vec![Kind::Waiting, Kind::Done]);
        assert_eq!(intake.poll(&path), vec![]);
        // A partial line waits; a bad line is skipped.
        let mut file = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
        file.write_all(b"{\"kind\":\"wait").unwrap();
        assert_eq!(intake.poll(&path), vec![]);
        file.write_all(b"ing\"}\nnot json\n{\"kind\":\"done\"}\n").unwrap();
        assert_eq!(intake.poll(&path), vec![Kind::Waiting, Kind::Done]);
        // A file that was replaced by a shorter one is read from the start.
        std::fs::write(&path, "{\"kind\":\"done\"}\n").unwrap();
        assert_eq!(intake.poll(&path), vec![Kind::Done]);
        std::fs::remove_dir_all(&dir).ok();
    }
}
