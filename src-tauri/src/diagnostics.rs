//! Logs and diagnostics (DESK-LOGS): the rotating log file, the panic hook, the webview's log events and the text "Copy
//! diagnostics" puts on the clipboard.
//!
//! The log goes into that text, so a log record holds fixed wording, categories, codes, counts, exit statuses and source
//! locations of this app's own code. Never text that came from a note, a page, a file, a prompt, a child process, a
//! setting or an error message, and never the path of a user's file. The folders the app itself keeps are fine.

use crate::AppState;
use crate::settings::{self, Settings};
use serde::Serialize;
use serde_json::Value;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use tauri::plugin::TauriPlugin;
use tauri::{AppHandle, Manager, Runtime, State};
use tauri_plugin_log::{RotationStrategy, Target, TargetKind, TimezoneStrategy};

/// The log file is `hivemind.log`; rotated ones are `hivemind_<date>.log`.
const LOG_NAME: &str = "hivemind";
/// A file is rotated once it would pass this size.
const LOG_MAX_BYTES: u128 = 1_000_000;
/// The plugin counts the active file in this number while running, and keeps this many rotated files at startup.
const LOG_KEEP: usize = 5;
/// Lines of the log that "Copy diagnostics" includes.
const TAIL_LINES: usize = 300;
/// At most this many characters of log, so the block (info, settings and log) still fits a GitHub issue body, which holds
/// 65,536 characters with the issue template and the user's own text.
const TAIL_CHARS: usize = 40_000;
/// How much of the end of the log file is read to find those lines.
const TAIL_READ: u64 = 256 * 1024;
/// The mark above a tail that does not start at the top of the log.
const CUT_MARK: &str = "[earlier lines cut]";
/// A backtrace is cut here.
const BACKTRACE_MAX: usize = 8 * 1024;
/// What a webview event may carry.
const CLIENT_KINDS: [&str; 4] = ["render_error", "window_error", "unhandled_rejection", "lm_failure"];
const CLIENT_FRAMES: usize = 8;
const CLIENT_COMPONENTS: usize = 12;

/// Info in a release build, Debug in a debug build.
pub fn log_level(debug: bool) -> log::LevelFilter {
    if debug { log::LevelFilter::Debug } else { log::LevelFilter::Info }
}

/// `^[A-Za-z][A-Za-z0-9_]{0,40}$`: a name that cannot carry a sentence.
pub fn identifier(text: &str) -> Option<&str> {
    let mut chars = text.chars();
    let first = chars.next()?;
    (first.is_ascii_alphabetic() && text.len() <= 41 && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')).then_some(text)
}

/// The kind of an I/O error (`NotFound`, `PermissionDenied`): a fixed name, never its message or path.
pub fn io_kind(error: &std::io::Error) -> String {
    format!("{:?}", error.kind())
}

/// Only this app's own records reach the log file: another crate's warning can carry a path or an error message.
fn ours(target: &str) -> bool {
    target == "agentic_hivemind_lib" || target.starts_with("agentic_hivemind_lib::")
}

/// Where the log goes, and why it cannot go to a file when it cannot.
#[derive(Debug, PartialEq, Clone)]
pub struct LogPlan {
    pub file: bool,
    pub stdout: bool,
    /// The I/O error kind that made the log folder unusable.
    pub unavailable: Option<String>,
}

/// The file when the folder was usable; otherwise standard output alone, so the app still starts.
pub fn log_plan(probe: Result<(), std::io::ErrorKind>, debug: bool) -> LogPlan {
    match probe {
        Ok(()) => LogPlan { file: true, stdout: debug, unavailable: None },
        Err(kind) => LogPlan { file: false, stdout: true, unavailable: Some(format!("{kind:?}")) },
    }
}

struct LogState {
    dir: PathBuf,
    unavailable: Option<String>,
}
static LOG_STATE: OnceLock<LogState> = OnceLock::new();

/// The folder the log goes in: where the log plugin would put it, so the folder stays where it was.
fn log_dir_for(identifier: &str) -> PathBuf {
    #[cfg(target_os = "macos")]
    return dirs::home_dir().unwrap_or_default().join("Library").join("Logs").join(identifier);
    #[cfg(not(target_os = "macos"))]
    return dirs::data_local_dir().unwrap_or_default().join(identifier).join("logs");
}

/// The folder exists and the log file opens for appending.
fn probe_log_folder(dir: &Path) -> Result<(), std::io::ErrorKind> {
    std::fs::create_dir_all(dir).map_err(|e| e.kind())?;
    std::fs::OpenOptions::new().create(true).append(true).open(dir.join(format!("{LOG_NAME}.log"))).map(drop).map_err(|e| e.kind())
}

/// Before the builder: make sure the log folder works, and remember the answer for diagnostics.
pub fn prepare_log(identifier: &str) -> LogPlan {
    let dir = log_dir_for(identifier);
    let plan = log_plan(probe_log_folder(&dir), cfg!(debug_assertions));
    let _ = LOG_STATE.set(LogState { dir, unavailable: plan.unavailable.clone() });
    plan
}

fn log_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    match LOG_STATE.get() {
        Some(state) => Ok(state.dir.clone()),
        None => app.path().app_log_dir().map_err(|e| e.to_string()),
    }
}

/// Why the log file is not in use when the plugin's own setup failed after the folder probe passed.
const SETUP_FAILED: &str = "setup failed";
static LOG_FALLBACK: OnceLock<&str> = OnceLock::new();

/// The plan for a second try after the first one's setup failed: the same plan without the file. None when the failed plan
/// had no file (nothing left to give up) or nothing failed.
pub fn retry_plan(plan: &LogPlan, setup_failed: bool) -> Option<LogPlan> {
    (setup_failed && plan.file).then(|| LogPlan { file: false, stdout: true, unavailable: Some(SETUP_FAILED.into()) })
}

/// Run `setup` for `plan`; if it fails and the plan had the file, run it once more for the plan without the file. The plan
/// that worked is returned with the result, and a second failure is returned as it is.
fn setup_with_retry<T, E>(plan: &LogPlan, mut setup: impl FnMut(&LogPlan) -> Result<T, E>) -> Result<(T, LogPlan), E> {
    match setup(plan) {
        Ok(done) => Ok((done, plan.clone())),
        Err(error) => match retry_plan(plan, true) {
            Some(next) => setup(&next).map(|done| (done, next)),
            None => Err(error),
        },
    }
}

/// The logger for a plan: the file (this app's own records only), and standard output when the plan has it.
fn log_builder(plan: &LogPlan) -> tauri_plugin_log::Builder {
    let mut builder = tauri_plugin_log::Builder::new()
        .clear_targets()
        .max_file_size(LOG_MAX_BYTES)
        .rotation_strategy(RotationStrategy::KeepSome(LOG_KEEP))
        .timezone_strategy(TimezoneStrategy::UseLocal)
        .level(log_level(cfg!(debug_assertions)));
    if plan.file
        && let Some(state) = LOG_STATE.get()
    {
        builder = builder.target(Target::new(TargetKind::Folder { path: state.dir.clone(), file_name: Some(LOG_NAME.into()) }).filter(|m| ours(m.target())));
    }
    if plan.stdout {
        builder = builder.target(Target::new(TargetKind::Stdout));
    }
    builder
}

/// The logging plugin. It must be the first plugin, so everything after it can log from its setup. The log plugin's own
/// setup (pruning and rotating the archives) can still fail after the folder probe passed, so this plugin sets the logger up
/// itself with `Builder::split`: on a failure it tries again without the file, and only a second failure stops the start.
/// The log plugin's own command is not registered, so the webview has no way to write text into the log.
pub fn log_plugin<R: Runtime>(plan: LogPlan) -> TauriPlugin<R> {
    tauri::plugin::Builder::new("hivemind-log")
        .setup(move |app, _api| {
            let ((level, logger), used) = setup_with_retry(&plan, |p| log_builder(p).split(app).map(|(_unused_plugin, level, logger)| (level, logger)))?;
            tauri_plugin_log::attach_logger(level, logger)?;
            if used.unavailable.as_deref() == Some(SETUP_FAILED) {
                let _ = LOG_FALLBACK.set(SETUP_FAILED);
                log::warn!("log file: setup failed, logging to standard output only");
            }
            Ok(())
        })
        .build()
}

/// A source file of a panic, without the part of its path that names a user or a machine: a path in this crate stays as
/// it is, one in a dependency starts at the dependency, any other is its file name.
fn safe_location(file: &str) -> String {
    let file = file.replace('\\', "/");
    let tail = match file.find("/registry/src/") {
        Some(at) => file[at + "/registry/src/".len()..].split_once('/').map_or("", |(_, rest)| rest),
        None if file.starts_with('/') || file.as_bytes().get(1) == Some(&b':') => file.rsplit('/').next().unwrap_or(""),
        None => &file,
    };
    tail.chars().filter(|c| c.is_ascii_alphanumeric() || "_./-".contains(*c)).take(120).collect()
}

/// One log record for a panic: the thread and the place, and in a debug build the backtrace too. The panic's own message is
/// left out on purpose: `str` slicing and `unwrap` messages quote the text they failed on. A release build is stripped, so
/// its frames would be addresses, and the symbol and source paths a debug build shows name the developer's machine.
pub fn format_panic(thread: Option<&str>, location: Option<(&str, u32, u32)>, backtrace: &str, debug: bool) -> String {
    let thread = thread.filter(|t| t.len() <= 41 && t.starts_with(|c: char| c.is_ascii_alphabetic()) && t.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')).unwrap_or("other");
    let place = location.map_or("an unknown place".to_string(), |(file, line, column)| format!("{}:{line}:{column}", safe_location(file)));
    let head = format!("panic (message withheld) in thread '{thread}' at {place}");
    if !debug {
        return head;
    }
    let backtrace: String = backtrace.chars().take(BACKTRACE_MAX).collect();
    format!("{head}\n{backtrace}")
}

/// Log every panic (including the ones `catch_unwind` takes), then run the hook that was there before. A release build
/// aborts on panic, so the log is flushed before the previous hook runs.
pub fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let thread = std::thread::current();
        let location = info.location().map(|l| (l.file(), l.line(), l.column()));
        let debug = cfg!(debug_assertions);
        let backtrace = if debug { std::backtrace::Backtrace::force_capture().to_string() } else { String::new() };
        log::error!("{}", format_panic(thread.name(), location, &backtrace, debug));
        log::logger().flush();
        previous(info);
    }));
}

/// The error codes Living Memory sends (`error_code` and `serve` in its core/cli.py).
const LM_CODES: [&str; 6] = ["busy", "hivemind", "stale", "conflict", "invalid", "internal"];
/// The names of the JavaScript and DOM errors a webview can throw, plus Hivemind's own.
const ERROR_NAMES: [&str; 16] = [
    "Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "URIError", "EvalError", "AggregateError",
    "DOMException", "AbortError", "NotAllowedError", "NotFoundError", "SecurityError", "QuotaExceededError",
    "InvalidStateError", "LmError",
];

/// The Living Memory commands `src/lib/lm.ts` sends (the first item of an argv), with `-` written as `_` as the webview
/// writes them. A failed command's name is kept only when it is one of these.
const LM_COMMANDS: [&str; 36] = [
    "apply", "archive", "capture", "check", "confirm", "delete_plan", "diff", "doc", "domains", "history", "inspect_plan", "maintenance",
    "merge_plan", "open", "project", "projects", "proposals", "read", "recap", "reopen", "resolve", "restore", "retag_plan", "review",
    "search", "supersede", "system", "systems", "taxonomy", "timeline", "type", "types", "undo", "update", "views", "wiki",
];

/// `/assets/index-abc.js` or `/src/main.tsx`: a file of this app's own bundle (or of its dev server), by path only.
fn bundle_path(path: &str) -> Option<&str> {
    let rest = path.strip_prefix("/assets/").or_else(|| path.strip_prefix("/src/"))?;
    (!rest.is_empty() && path.len() <= 120 && !path.contains("..") && path.chars().all(|c| c.is_ascii_alphanumeric() || "_./-".contains(c))).then_some(path)
}

/// One event from the webview as a log record, and its level. Every field is checked here again: the webview is not
/// trusted to have left its text out. Anything that is not a known kind, an identifier, a number or one of this app's own
/// bundle files is replaced by `other` or dropped.
pub fn format_client_event(event: &Value) -> (log::Level, String) {
    let kind = event["kind"].as_str().filter(|k| CLIENT_KINDS.contains(k)).unwrap_or("other");
    let mut text = format!("webview {kind}");
    for field in ["name", "code"] {
        if event.get(field).is_some_and(|v| !v.is_null()) {
            // An identifier can still be a word taken from a note, so codes, error names and command names must be known ones.
            let known = |v: &&str| match field {
                "code" => LM_CODES.contains(v),
                _ if kind == "lm_failure" => LM_COMMANDS.contains(v),
                _ => ERROR_NAMES.contains(v),
            };
            text.push_str(&format!(" {field}={}", event[field].as_str().and_then(identifier).filter(known).unwrap_or("other")));
        }
    }
    if let Some(exit) = event["exit"].as_i64().filter(|n| i32::try_from(*n).is_ok()) {
        text.push_str(&format!(" exit={exit}"));
    }
    let frames: Vec<String> = event["frames"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|f| {
            let file = bundle_path(f["file"].as_str()?)?;
            let number = |key: &str| f[key].as_u64().filter(|n| *n <= 10_000_000);
            Some(format!("{file}:{}:{}", number("line")?, number("column")?))
        })
        .take(CLIENT_FRAMES)
        .collect();
    if !frames.is_empty() {
        text.push_str(&format!(" at {}", frames.join(" ")));
    }
    // Component names are identifiers of this app's own code (or DOM tags), at most 40 characters each.
    let components: Vec<&str> = event["component"].as_array().into_iter().flatten().filter_map(|c| identifier(c.as_str()?).filter(|n| n.len() <= 40)).take(CLIENT_COMPONENTS).collect();
    if !components.is_empty() {
        text.push_str(&format!(" in {}", components.join(">")));
    }
    (if kind == "lm_failure" { log::Level::Warn } else { log::Level::Error }, text)
}

/// The webview reports what went wrong, as a structured event and never as text (see `format_client_event`).
#[tauri::command]
pub fn log_client(event: Value) {
    let (level, text) = format_client_event(&event);
    log::log!(level, "{text}");
}

/// The last `lines` lines of a text file, from at most its last `window` bytes. A tail that does not reach the top of the
/// file starts with `CUT_MARK`. A first line is kept when the window begins right after a newline, and dropped when it is
/// only the end of a line, unless that is all the window holds (a last line longer than the window: its end is returned).
fn tail_of(path: &Path, lines: usize, window: u64) -> std::io::Result<String> {
    let mut file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(_) => std::fs::File::open(path)?,
    };
    let start = file.metadata()?.len().saturating_sub(window);
    // One byte before the window, to know whether the window begins on a line. No more than the window and that byte is
    // read, whatever the file grew to meanwhile.
    file.seek(SeekFrom::Start(start.saturating_sub(1)))?;
    let mut bytes = Vec::new();
    file.take(window + 1).read_to_end(&mut bytes)?;
    Ok(tail_of_bytes(bytes, start > 0, lines))
}

/// The tail of what was read. `behind` is whether the first byte is the one just before the window (the file went on above
/// it): it only says whether the window begins on a line, and is not part of the text. A read that came back short, or
/// empty, because the file shrank since its size was asked, is taken as it is.
fn tail_of_bytes(mut bytes: Vec<u8>, behind: bool, lines: usize) -> String {
    let aligned = !behind || bytes.first() == Some(&b'\n');
    if behind && !bytes.is_empty() {
        bytes.remove(0);
    }
    // A window that begins inside a multibyte character skips the rest of it.
    let skip = bytes.iter().take_while(|b| (**b & 0xC0) == 0x80).count();
    let text = String::from_utf8_lossy(&bytes[skip..]).into_owned();
    let mut all: Vec<&str> = text.lines().collect();
    let mut cut = behind;
    if behind && !aligned && all.len() > 1 {
        all.remove(0);
    }
    if all.len() > lines {
        all.drain(..all.len() - lines);
        cut = true;
    }
    cut |= fit_chars(&mut all, TAIL_CHARS - CUT_MARK.len() - 1);
    let body = all.join("\n");
    if cut && !body.is_empty() { format!("{CUT_MARK}\n{body}") } else { body }
}

/// Drop lines from the front until the newest ones, joined by newlines, are at most `budget` characters. A last line that
/// is longer than that keeps its end, as a byte window does. Returns whether anything was dropped.
fn fit_chars(lines: &mut Vec<&str>, budget: usize) -> bool {
    let mut total = 0;
    let mut keep = 0;
    for line in lines.iter().rev() {
        let size = line.chars().count() + usize::from(keep > 0);
        if total + size > budget {
            break;
        }
        total += size;
        keep += 1;
    }
    if keep == lines.len() {
        return false;
    }
    if keep == 0 {
        let last = lines[lines.len() - 1];
        let skip = last.chars().count() - budget;
        let start = last.char_indices().nth(skip).map_or(last.len(), |(i, _)| i);
        *lines = vec![&last[start..]];
    } else {
        lines.drain(..lines.len() - keep);
    }
    true
}

/// `tail_of` for the log file, with a fixed line when it cannot be read.
fn tail_lines(path: &Path, lines: usize) -> String {
    tail_of(path, lines, TAIL_READ).unwrap_or_else(|e| format!("Log not readable: {:?}", e.kind()))
}

/// The engine behind the webview, by target: WebView2 on Windows, WebKit on macOS.
fn engine_label(os: &str) -> &'static str {
    match os {
        "windows" => "WebView2",
        "macos" => "WebKit",
        _ => "Webview",
    }
}

/// What the app knows about itself and where it keeps things.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    version: String,
    tauri: String,
    webview_engine: String,
    webview: String,
    os: String,
    arch: String,
    os_version: Option<String>,
    data_dir: String,
    config_dir: String,
    log_dir: String,
}

fn app_info_of(app: &AppHandle) -> Result<AppInfo, String> {
    let paths = app.path();
    let shown = |p: Result<PathBuf, tauri::Error>| p.map(|p| p.display().to_string()).map_err(|e| e.to_string());
    let os_version = match (sysinfo::System::long_os_version(), sysinfo::System::kernel_version()) {
        (Ok(name), Ok(build)) => Some(format!("{name} (build {build})")),
        (Ok(name), Err(_)) => Some(name),
        _ => None,
    };
    Ok(AppInfo {
        version: app.package_info().version.to_string(),
        tauri: tauri::VERSION.to_string(),
        webview_engine: engine_label(std::env::consts::OS).into(),
        webview: tauri::webview_version().unwrap_or_else(|_| "unknown".into()),
        os: std::env::consts::OS.into(),
        arch: std::env::consts::ARCH.into(),
        os_version,
        data_dir: shown(paths.app_data_dir())?,
        config_dir: shown(paths.app_config_dir())?,
        log_dir: log_dir(app)?.display().to_string(),
    })
}

/// Settings as `name: value` lines. Only booleans, numbers, the checked appearance values and counts: no path, command or
/// shortcut the user typed, and no list contents.
fn settings_summary(s: &Settings) -> String {
    let text = |v: Option<&str>| v.unwrap_or("default").to_string();
    let number = |v: Option<f64>| v.map_or("default".to_string(), |v| v.to_string());
    let set = |v: &Option<String>| v.as_ref().is_some_and(|v| !v.is_empty()).to_string();
    let count = |v: Option<usize>| v.unwrap_or(0).to_string();
    let commands: usize = s.allowed_commands.iter().flat_map(|all| all.values()).map(Vec::len).sum();
    let lines = [
        ("theme", text(s.theme())),
        ("document_background", text(s.document_background())),
        ("document_size", number(s.document_size())),
        ("default_mode", text(s.default_mode())),
        ("spellcheck", s.spellcheck().map_or("default".to_string(), |v| v.to_string())),
        ("ui_font", text(s.ui_font())),
        ("doc_font", text(s.doc_font())),
        ("mono_font", text(s.mono_font())),
        ("doc_line_height", number(s.doc_line_height())),
        ("doc_width", text(s.doc_width())),
        ("density", text(s.density())),
        ("ui_zoom", s.ui_zoom().to_string()),
        ("close_to_tray", s.close_to_tray.unwrap_or(true).to_string()),
        ("learning_reviewer", s.learning_reviewer().to_string()),
        ("skills_auto_patch", s.skills_auto_patch().to_string()),
        ("claude_under_managed_policy", s.claude_under_managed_policy().to_string()),
        ("agent_budget_usd", s.agent_budget_usd().to_string()),
        ("learning_daily_usd", s.learning_daily_usd().to_string()),
        ("automation_daily_usd", s.automation_daily_usd().to_string()),
        ("review_call_usd", s.review_call_usd().to_string()),
        ("python_set", set(&s.python)),
        ("script_set", set(&s.script)),
        ("root_set", set(&s.root)),
        ("claude_path_set", set(&s.claude_path)),
        ("codex_path_set", set(&s.codex_path)),
        ("capture_shortcut_custom", s.capture_shortcut.is_some().to_string()),
        ("shortcut_overrides", crate::shortcuts::get(s).len().to_string()),
        ("hidden_engines", count(s.hidden_engines.as_ref().map(Vec::len))),
        ("other_folders", count(s.other_folders.as_ref().map(Vec::len))),
        ("allowed_commands", commands.to_string()),
        ("architecture_rules", count(s.architecture_rules.as_ref().map(|r| r.len()))),
    ];
    lines.iter().map(|(k, v)| format!("{k}: {v}")).collect::<Vec<_>>().join("\n")
}

/// The block "Copy diagnostics" puts on the clipboard. `unavailable` is why there is no log file, when there is none.
fn render(info: &AppInfo, settings: &str, log: &str, unavailable: Option<&str>) -> String {
    let os = info.os_version.as_deref().map(|v| format!(", {v}")).unwrap_or_default();
    let log = match unavailable {
        Some(kind) => format!("Log file unavailable: {kind}"),
        None => format!("Log (newest lines)\n{log}"),
    };
    format!(
        "Hivemind {}\nTauri {}\n{} {}\n{} {}{os}\nData folder: {}\nConfig folder: {}\nLog folder: {}\n\nSettings\n{settings}\n\n{log}\n",
        info.version, info.tauri, info.webview_engine, info.webview, info.os, info.arch, info.data_dir, info.config_dir, info.log_dir
    )
}

/// `text` with the user's home folder written as `~` wherever a path starts with it, in either slash form. A path that only
/// begins with the same letters (`/home/ann2`) is left alone. `ignore_case` is for file systems that do not tell
/// `C:\Users\Ann` from `c:\users\ann` (Windows).
#[cfg(test)]
fn hide_home(text: &str, home: &str, ignore_case: bool) -> String {
    hide_root(text, home, "~", ignore_case)
}

/// `text` with every path that starts with `root` written as `label` instead, by the rules of `hide_home`.
fn hide_root(text: &str, root: &str, label: &str, ignore_case: bool) -> String {
    let home = root.trim_end_matches(['/', '\\']);
    if home.is_empty() {
        return text.to_string();
    }
    // Both sides with `/` for `\` (and lower case when asked): the same byte length, so offsets are the text's own.
    let fold = |s: &str| {
        let s = s.replace('\\', "/");
        if ignore_case { s.to_ascii_lowercase() } else { s }
    };
    let (hay, needle) = (fold(text), fold(home));
    let mut out = String::with_capacity(text.len());
    let mut from = 0;
    while let Some(at) = hay[from..].find(&needle).map(|i| i + from) {
        let end = at + needle.len();
        let ends_here = hay[end..].chars().next().is_none_or(|c| !(c.is_alphanumeric() || "_-.".contains(c)));
        out.push_str(&text[from..at]);
        out.push_str(if ends_here { label } else { &text[at..end] });
        from = end;
    }
    out.push_str(&text[from..]);
    out
}

#[tauri::command]
pub fn app_info(app: AppHandle) -> Result<AppInfo, String> {
    app_info_of(&app)
}

/// One plain-text block for a bug report: the app info, a settings summary and the end of the current log.
#[tauri::command]
pub fn diagnostics(app: AppHandle, state: State<'_, AppState>) -> Result<String, String> {
    let info = app_info_of(&app)?;
    log::logger().flush();
    let unavailable = LOG_STATE.get().and_then(|s| s.unavailable.as_deref()).or(LOG_FALLBACK.get().copied());
    let log = if unavailable.is_some() { String::new() } else { tail_lines(&Path::new(&info.log_dir).join(format!("{LOG_NAME}.log")), TAIL_LINES) };
    let text = render(&info, &settings_summary(&settings::load(&state.settings_path)), &log, unavailable);
    // The About dialog shows full paths; the block that is pasted into a public issue does not carry the user's name.
    Ok(hide_paths(&text, &known_roots(), cfg!(windows)))
}

/// The folders whose paths can name the user or a server (Windows can redirect AppData to a network share, outside the
/// home folder), each with the label diagnostics writes instead. Most specific first; the home folder last.
fn known_roots() -> Vec<(String, &'static str)> {
    [(dirs::data_local_dir(), "<local app data>"), (dirs::data_dir(), "<app data>"), (dirs::config_dir(), "<config>"), (dirs::home_dir(), "~")]
        .into_iter()
        .filter_map(|(dir, label)| dir.map(|d| (d.display().to_string(), label)))
        .collect()
}

fn hide_paths(text: &str, roots: &[(String, &str)], ignore_case: bool) -> String {
    roots.iter().fold(text.to_string(), |text, (root, label)| hide_root(&text, root, label, ignore_case))
}

/// Open the log folder in the file manager. Done here so the webview's opener scope stays as narrow as it is.
#[tauri::command]
pub fn open_logs_folder(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let dir = log_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    app.opener().open_path(dir.display().to_string(), None::<&str>).map_err(|e| e.to_string())
}

/// The repository's New issue page, opened by "Report a problem".
const ISSUE_PAGE: &str = "https://github.com/tyler59simon/agentic-hivemind-app/issues/new";
/// What the new issue starts with: fixed wording, nothing from the user's data.
const ISSUE_BODY: &str = "What happened:


Diagnostics (paste the copied text here):
";

/// The same, for when the diagnostics could not be copied: it does not ask to paste what is not on the clipboard.
const ISSUE_BODY_NO_COPY: &str = "What happened:\n\n\nDiagnostics could not be copied. Use Help > Copy diagnostics and paste them here:\n";

/// `ISSUE_PAGE` with one of the two fixed bodies as the `body` query value, percent-encoded.
fn issue_url(with_diagnostics: bool) -> String {
    let body = if with_diagnostics { ISSUE_BODY } else { ISSUE_BODY_NO_COPY };
    let encoded: String = body
        .bytes()
        .map(|b| if b.is_ascii_alphanumeric() || b"-._~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") })
        .collect();
    format!("{ISSUE_PAGE}?body={encoded}")
}

/// Open the New issue page in the browser. The address and both bodies are fixed here: the webview passes only whether the
/// diagnostics were copied, never text, so its opener scope stays as narrow as it is.
#[tauri::command]
pub fn open_issue_page(app: AppHandle, with_diagnostics: bool) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener().open_url(issue_url(with_diagnostics), None::<&str>).map_err(|e| e.to_string())
}

/// A logger that keeps what the app logs, so a test can look at the records of the code under test.
#[cfg(test)]
pub mod capture {
    use std::sync::{Mutex, Once};

    static RECORDS: Mutex<Vec<String>> = Mutex::new(Vec::new());
    struct Capture;
    impl log::Log for Capture {
        fn enabled(&self, _: &log::Metadata) -> bool {
            true
        }
        fn log(&self, record: &log::Record) {
            RECORDS.lock().unwrap_or_else(|e| e.into_inner()).push(format!("{} {}", record.level(), record.args()));
        }
        fn flush(&self) {}
    }

    /// Start keeping records (once for the test process).
    pub fn install() {
        static ONCE: Once = Once::new();
        ONCE.call_once(|| {
            let _ = log::set_logger(&Capture);
            log::set_max_level(log::LevelFilter::Trace);
        });
    }

    pub fn records() -> Vec<String> {
        RECORDS.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::BTreeMap;

    const MARKER: &str = "SECRET-MARKER-1";

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hivemind-diagnostics-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn info() -> AppInfo {
        AppInfo {
            version: "0.1.0".into(), tauri: "2.12.5".into(), webview_engine: "WebView2".into(), webview: "140.0".into(), os: "windows".into(), arch: "x86_64".into(),
            os_version: Some("Windows 11 (build 26100)".into()), data_dir: "D".into(), config_dir: "C".into(), log_dir: "L".into(),
        }
    }

    #[test]
    fn the_issue_url_is_the_fixed_new_issue_page_with_an_encoded_fixed_body() {
        let url = issue_url(true);
        let body = url.strip_prefix("https://github.com/tyler59simon/agentic-hivemind-app/issues/new?body=").expect("the fixed page and a body");
        assert!(body.chars().all(|c| c.is_ascii_alphanumeric() || "-._~%".contains(c)), "{body}");
        assert!(body.starts_with("What%20happened%3A%0A%0A%0A"), "{body}");
        assert!(body.ends_with("here%29%3A%0A"), "{body}");
    }

    #[test]
    fn the_issue_url_without_diagnostics_does_not_ask_to_paste_the_copied_text() {
        let url = issue_url(false);
        let body = url.strip_prefix("https://github.com/tyler59simon/agentic-hivemind-app/issues/new?body=").expect("the fixed page and a body");
        assert!(body.chars().all(|c| c.is_ascii_alphanumeric() || "-._~%".contains(c)), "{body}");
        assert!(body.starts_with("What%20happened%3A%0A%0A%0A"), "{body}");
        assert!(body.contains("could%20not%20be%20copied"), "{body}");
        assert!(!body.contains("copied%20text"), "{body}");
        assert_ne!(url, issue_url(true));
    }

    #[test]
    fn a_redirected_app_data_folder_is_hidden_as_well_as_the_home_folder() {   // Codex review of d831d7e
        let roots = vec![("\\\\fileserver\\profiles$\\ann\\AppData\\Roaming".to_string(), "<app data>"), ("C:\\Users\\Ann".to_string(), "~")];
        let text = "Data folder: \\\\fileserver\\profiles$\\ann\\AppData\\Roaming\\dev.hivemind.app\nLog folder: C:\\Users\\Ann\\AppData\\Local\\dev.hivemind.app\\logs";
        let out = hide_paths(text, &roots, true);
        assert_eq!(out, "Data folder: <app data>\\dev.hivemind.app\nLog folder: ~\\AppData\\Local\\dev.hivemind.app\\logs");
        assert!(!out.to_lowercase().contains("ann") && !out.contains("fileserver"), "{out}");
    }

    #[test]
    fn the_home_folder_becomes_a_tilde_in_every_path_and_slash_form() {
        let home = "C:\\Users\\Ann";
        let text = "Data: C:\\Users\\Ann\\AppData\\hm\nLog: C:/Users/Ann/AppData/logs\nHome: C:\\Users\\Ann\nOther: C:\\Users\\Ann2\\x and D:\\Users\\Ann\\y";
        let out = hide_home(text, home, false);
        assert_eq!(out, "Data: ~\\AppData\\hm\nLog: ~/AppData/logs\nHome: ~\nOther: C:\\Users\\Ann2\\x and D:\\Users\\Ann\\y");
        // A home written with `/` or a trailing slash matches the same text.
        assert_eq!(hide_home(text, "C:/Users/Ann/", false), out);
        // Case matters unless asked to be ignored.
        assert_eq!(hide_home("c:\\users\\ann\\x", home, false), "c:\\users\\ann\\x");
        assert_eq!(hide_home("c:\\users\\ann\\x and C:\\USERS\\ANN", home, true), "~\\x and ~");
        assert_eq!(hide_home("/home/ann/.config and /home/ann2/x", "/home/ann", false), "~/.config and /home/ann2/x");
        assert_eq!(hide_home("nothing here", "", true), "nothing here");
    }

    #[test]
    fn a_diagnostics_block_keeps_no_home_path_but_keeps_the_rest() {
        let mut i = info();
        i.data_dir = "C:\\Users\\Ann\\AppData\\Roaming\\hm".into();
        i.config_dir = "C:\\Users\\Ann\\AppData\\Roaming\\hm-config".into();
        i.log_dir = "C:\\Users\\Ann\\AppData\\Local\\hm\\logs".into();
        let text = hide_home(&render(&i, "theme: emerald", "[INFO] wrote C:\\Users\\Ann\\AppData\\x", None), "C:\\Users\\Ann", true);
        assert!(!text.contains("Ann"), "{text}");
        assert!(text.contains("Data folder: ~\\AppData\\Roaming\\hm\n"), "{text}");
        assert!(text.contains("Log folder: ~\\AppData\\Local\\hm\\logs\n"), "{text}");
        assert!(text.contains("[INFO] wrote ~\\AppData\\x"), "{text}");
        assert!(text.contains("Hivemind 0.1.0") && text.contains("theme: emerald"));
    }

    #[test]
    fn a_debug_build_logs_debug_and_a_release_build_logs_info() {
        assert_eq!(log_level(true), log::LevelFilter::Debug);
        assert_eq!(log_level(false), log::LevelFilter::Info);
    }

    #[test]
    fn a_log_folder_that_works_gets_the_file_and_one_that_does_not_gets_stdout_and_a_reason() {
        assert_eq!(log_plan(Ok(()), false), LogPlan { file: true, stdout: false, unavailable: None });
        assert_eq!(log_plan(Ok(()), true), LogPlan { file: true, stdout: true, unavailable: None });
        let plan = log_plan(Err(std::io::ErrorKind::PermissionDenied), false);
        assert_eq!(plan, LogPlan { file: false, stdout: true, unavailable: Some("PermissionDenied".into()) });
    }

    #[test]
    fn the_probe_fails_for_a_folder_that_cannot_be_made_and_works_for_one_that_can() {
        let dir = scratch("probe");
        assert_eq!(probe_log_folder(&dir.join("logs")), Ok(()));
        assert!(dir.join("logs").join("hivemind.log").is_file());
        // A file where the folder should be.
        std::fs::write(dir.join("blocked"), "x").unwrap();
        assert!(probe_log_folder(&dir.join("blocked").join("logs")).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn only_this_apps_own_records_reach_the_file() {
        assert!(ours("agentic_hivemind_lib"));
        assert!(ours("agentic_hivemind_lib::studio"));
        assert!(!ours("tauri_runtime_wry"));
        assert!(!ours("agentic_hivemind_lib_other"));
    }

    #[test]
    fn a_panic_record_has_the_thread_place_and_backtrace_and_no_message() {
        let text = format_panic(Some("main"), Some(("src/lib.rs", 10, 5)), "0: frame", true);
        assert_eq!(text, "panic (message withheld) in thread 'main' at src/lib.rs:10:5\n0: frame");
        assert!(format_panic(None, None, "", true).contains("thread 'other' at an unknown place"));
        assert!(format_panic(Some(&format!("t {MARKER}")), None, "", true).contains("thread 'other'"));
    }

    #[test]
    fn a_release_panic_record_has_no_backtrace() {
        // A release build is stripped: its frames are addresses, and a debug build's name the developer's machine.
        let release = format_panic(Some("main"), Some(("src\\lib.rs", 10, 5)), "0: frame at C:\\Users\\someone\\x.rs", false);
        assert_eq!(release, "panic (message withheld) in thread 'main' at src/lib.rs:10:5");
        let debug = format_panic(Some("main"), Some(("src\\lib.rs", 10, 5)), "0: frame", true);
        assert!(debug.starts_with(&release) && debug.ends_with("\n0: frame"), "{debug}");
    }

    #[test]
    fn a_failed_file_setup_is_tried_again_without_the_file_and_only_that_once() {
        let file = LogPlan { file: true, stdout: false, unavailable: None };
        let retry = retry_plan(&file, true).unwrap();
        assert_eq!(retry, LogPlan { file: false, stdout: true, unavailable: Some("setup failed".into()) });
        assert_eq!(retry_plan(&file, false), None, "nothing failed");
        assert_eq!(retry_plan(&retry, true), None, "a plan without the file has nothing to give up");
        // The first setup fails for the plan with the file, the second works.
        let mut plans = vec![];
        let done = setup_with_retry(&file, |p| { plans.push(p.clone()); if p.file { Err("no rotate") } else { Ok(7) } });
        assert_eq!(done, Ok((7, retry.clone())));
        assert_eq!(plans, vec![file.clone(), retry.clone()]);
        // Both fail: the second failure is the answer, and there is no third try.
        let mut tries = 0;
        let failed: Result<((), LogPlan), &str> = setup_with_retry(&file, |_| { tries += 1; Err("still no") });
        assert_eq!((failed, tries), (Err("still no"), 2));
        // A plan that never had the file is not tried again.
        let mut tries = 0;
        let failed: Result<((), LogPlan), &str> = setup_with_retry(&retry, |_| { tries += 1; Err("no") });
        assert_eq!((failed, tries), (Err("no"), 1));
        // A setup that works the first time is used as it is.
        assert_eq!(setup_with_retry(&file, |_| Ok::<_, &str>(1)), Ok((1, file)));
    }

    #[test]
    fn a_panic_place_loses_the_part_of_the_path_that_names_a_machine() {
        assert_eq!(safe_location("src\\notes_index\\mod.rs"), "src/notes_index/mod.rs");
        assert_eq!(safe_location("C:\\Users\\someone\\.cargo\\registry\\src\\index.crates.io-1949cf8c6b5b557f\\fern-0.7.1\\src\\lib.rs"), "fern-0.7.1/src/lib.rs");
        assert_eq!(safe_location("C:\\Users\\someone\\projects\\x\\src\\lib.rs"), "lib.rs");
        assert_eq!(safe_location("/home/someone/x/src/lib.rs"), "lib.rs");
    }

    #[test]
    fn a_webview_event_keeps_only_checked_fields() {
        let event = json!({
            "kind": "render_error", "name": "TypeError", "code": "invalid", "exit": 2,
            "frames": [{ "file": "/assets/index-abc.js", "line": 10, "column": 20 }, { "file": "/src/main.tsx", "line": 1, "column": 2 }],
            "component": ["Bomb", "ErrorBoundary", "div"],
        });
        assert_eq!(format_client_event(&event), (log::Level::Error, "webview render_error name=TypeError code=invalid exit=2 at /assets/index-abc.js:10:20 /src/main.tsx:1:2 in Bomb>ErrorBoundary>div".into()));
        assert_eq!(format_client_event(&json!({ "kind": "lm_failure", "name": "read", "code": "stale", "exit": 6 })), (log::Level::Warn, "webview lm_failure name=read code=stale exit=6".into()));
    }

    #[test]
    fn a_failed_command_is_named_only_when_lm_ts_sends_it() {
        for known in ["read", "delete_plan", "doc", "search"] {
            assert_eq!(format_client_event(&json!({ "kind": "lm_failure", "name": known })).1, format!("webview lm_failure name={known}"));
        }
        // An identifier that is not a command (a word from a note), and an error name sent as a command.
        for other in ["Quarterly_budget", "list", "TypeError", "delete-plan", MARKER] {
            assert_eq!(format_client_event(&json!({ "kind": "lm_failure", "name": other })).1, "webview lm_failure name=other", "{other}");
        }
        // A command is not an error name.
        assert_eq!(format_client_event(&json!({ "kind": "window_error", "name": "read" })).1, "webview window_error name=other");
    }

    /// Every command `src/lib/lm.ts` puts first in an argv is in LM_COMMANDS: the first item of `view([...])`, `direct([...])`,
    /// `run<T>([...])`, `runBody<T>([...])` and `scopeArgs("...")`, and the literal `const argv = ["..."]` of the builders.
    #[test]
    fn the_command_list_has_every_command_lm_ts_sends() {
        let source = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/lib/lm.ts")).unwrap();
        let re = regex::Regex::new(r#"(?:view\(\s*\[|direct\(\s*\[|run(?:Body)?<[^()]*>\(\s*\[|scopeArgs\(\s*|argv = \[\s*|return \[\s*)"([a-z-]+)""#).unwrap();
        let mut found: Vec<String> = re.captures_iter(&source).map(|c| c[1].replace('-', "_")).collect();
        found.sort();
        found.dedup();
        assert!(found.len() > 25, "the pattern found only {found:?}");
        for name in &found {
            assert!(LM_COMMANDS.contains(&name.as_str()), "{name} is sent by lm.ts but is not in LM_COMMANDS");
        }
        // And the list has nothing lm.ts does not send (Codex review of 4b05d93: compared as sets, so a missed shape fails here).
        let mut listed: Vec<String> = LM_COMMANDS.iter().map(|s| s.to_string()).collect();
        listed.sort();
        assert_eq!(listed, found);
    }

    #[test]
    fn a_component_name_is_kept_up_to_forty_characters() {
        let (long, ok) = ("A".repeat(41), "B".repeat(40));
        assert_eq!(format_client_event(&json!({ "kind": "render_error", "component": [long, ok] })).1, format!("webview render_error in {ok}"));
    }

    #[test]
    fn an_unknown_code_or_error_name_is_other_even_when_it_looks_like_an_identifier() {   // Claude review of c6af9b6
        // A word from a note title can pass the identifier check; only known codes and names are kept.
        assert_eq!(format_client_event(&json!({ "kind": "lm_failure", "name": "read", "code": "Quarterly_budget", "exit": 2 })).1,
            "webview lm_failure name=read code=other exit=2");
        assert_eq!(format_client_event(&json!({ "kind": "window_error", "name": "MyDiaryEntry" })).1, "webview window_error name=other");
    }

    #[test]
    fn a_webview_event_with_text_in_any_field_logs_none_of_it() {
        let event = json!({
            "kind": MARKER, "name": format!("Error: {MARKER}"), "code": MARKER, "exit": 99999999999i64, "message": MARKER, "reason": MARKER, "stack": MARKER,
            "frames": [
                { "file": format!("http://evil.example/{MARKER}.js"), "line": 1, "column": 1 },
                { "file": format!("/assets/{MARKER}/../../x.js"), "line": 1, "column": 1 },
                { "file": "/node_modules/x.js", "line": 1, "column": 1 },
                { "file": "/assets/ok.js", "line": MARKER, "column": 1 },
                { "file": "/assets/ok.js", "line": 3, "column": 4 },
            ],
            "component": [MARKER, "Fine", format!("Name {MARKER}")],
        });
        let (level, text) = format_client_event(&event);
        assert_eq!(level, log::Level::Error);
        assert_eq!(text, "webview other name=other code=other at /assets/ok.js:3:4 in Fine");
        assert!(!text.contains(MARKER));
    }

    #[test]
    fn an_event_that_is_not_an_object_is_still_a_fixed_record() {
        for event in [json!(null), json!(MARKER), json!([MARKER]), json!(5)] {
            assert_eq!(format_client_event(&event), (log::Level::Error, "webview other".into()));
        }
    }

    #[test]
    fn at_most_eight_frames_and_twelve_components_are_kept() {
        let frames: Vec<_> = (1..=20).map(|n| json!({ "file": "/assets/a.js", "line": n, "column": 1 })).collect();
        let component: Vec<_> = (1..=20).map(|n| json!(format!("C{n}"))).collect();
        let (_, text) = format_client_event(&json!({ "kind": "window_error", "frames": frames, "component": component }));
        assert_eq!(text.matches("/assets/a.js").count(), 8);
        assert_eq!(text.split(" in ").nth(1).unwrap().split('>').count(), 12);
    }

    #[test]
    fn nothing_that_carries_text_reaches_the_log_or_the_diagnostics() {
        capture::install();
        install_panic_hook();
        // A panic whose payload quotes text, caught as the skill sync does.
        let caught = std::panic::catch_unwind(|| {
            let page = format!("a page about {MARKER}");
            panic!("{page}");
        });
        assert!(caught.is_err());
        log_client(json!({ "kind": "render_error", "name": MARKER, "message": MARKER, "frames": [{ "file": format!("/{MARKER}.js"), "line": 1, "column": 1 }] }));
        let records = capture::records();
        assert!(records.iter().any(|r| r.contains("panic (message withheld)")), "{records:?}");
        assert!(records.iter().any(|r| r.contains("webview render_error")), "{records:?}");
        assert!(records.iter().all(|r| !r.contains(MARKER)), "{records:?}");
        // What Copy diagnostics would hold: the log file's end, with those records in it.
        let dir = scratch("privacy");
        let file = dir.join("hivemind.log");
        std::fs::write(&file, records.join("\n")).unwrap();
        let text = render(&info(), &settings_summary(&Settings::default()), &tail_lines(&file, 300), None);
        assert!(text.contains("panic (message withheld)") && !text.contains(MARKER), "{text}");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_tail_is_at_most_n_lines_from_the_end_and_says_when_it_is_cut() {
        let dir = scratch("tail");
        let file = dir.join("hivemind.log");
        std::fs::write(&file, (1..=10).map(|n| format!("line {n}\n")).collect::<String>()).unwrap();
        assert_eq!(tail_lines(&file, 3), "[earlier lines cut]\nline 8\nline 9\nline 10");
        let all = tail_lines(&file, 50);
        assert_eq!(all.lines().count(), 10);
        assert!(!all.contains("cut"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_tail_keeps_the_newest_lines_that_fit_the_character_budget() {
        // 300 lines of 330 characters would be about 99,000 characters: only the newest that fit are kept, and the cut says so.
        let text: String = (1..=300).map(|n| format!("{n:04} {}\n", "x".repeat(325))).collect();
        let tail = tail_of_bytes(text.into_bytes(), false, TAIL_LINES);
        assert!(tail.chars().count() <= TAIL_CHARS, "{} characters", tail.chars().count());
        assert!(tail.starts_with("[earlier lines cut]\n") && tail.ends_with(&format!("0300 {}", "x".repeat(325))));
        assert!(tail.lines().nth(1).is_some_and(|l| l.len() == 330), "a kept line is whole");
        // A short log is left as it is.
        assert_eq!(tail_of_bytes(b"one\ntwo\n".to_vec(), false, TAIL_LINES), "one\ntwo");
    }

    #[test]
    fn a_line_over_the_character_budget_keeps_its_end() {
        let mut lines = vec!["older", "\u{20ac}abcdefgh"];
        assert!(fit_chars(&mut lines, 4));
        assert_eq!(lines, vec!["efgh"]);
        let mut lines = vec!["ab", "cd", "ef"];
        assert!(fit_chars(&mut lines, 5));
        assert_eq!(lines, vec!["cd", "ef"]);
        let mut lines = vec!["ab", "cd"];
        assert!(!fit_chars(&mut lines, 5));
        assert_eq!(lines, vec!["ab", "cd"]);
    }

    #[test]
    fn a_missing_log_is_a_fixed_line_not_an_empty_string() {
        let dir = scratch("missing");
        assert_eq!(tail_lines(&dir.join("missing.log"), 3), "Log not readable: NotFound");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_window_that_begins_right_after_a_newline_keeps_its_first_line() {
        let dir = scratch("aligned");
        let file = dir.join("hivemind.log");
        std::fs::write(&file, "aaaa\nbbbb\ncccc\n").unwrap();
        // 15 bytes in all; a window of 10 begins at byte 5, right after the first newline.
        assert_eq!(tail_of(&file, 10, 10).unwrap(), "[earlier lines cut]\nbbbb\ncccc");
        // A window of 9 begins inside bbbb: its end is not a line, so it is dropped.
        assert_eq!(tail_of(&file, 10, 9).unwrap(), "[earlier lines cut]\ncccc");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_last_line_longer_than_the_window_returns_its_end() {
        let dir = scratch("long");
        let file = dir.join("hivemind.log");
        std::fs::write(&file, format!("first\n{}END\n", "x".repeat(100))).unwrap();
        let tail = tail_of(&file, 10, 20).unwrap();
        assert_eq!(tail, format!("[earlier lines cut]\n{}END", "x".repeat(16)));
        // And with no newline at the end.
        std::fs::write(&file, format!("{}END", "x".repeat(100))).unwrap();
        assert_eq!(tail_of(&file, 10, 20).unwrap(), format!("[earlier lines cut]\n{}END", "x".repeat(17)));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_read_that_came_back_short_or_empty_is_taken_as_it_is() {
        // The file shrank after its size was asked: nothing came back, or less than the window and its look-behind byte.
        assert_eq!(tail_of_bytes(vec![], true, 10), "");
        assert_eq!(tail_of_bytes(vec![], false, 10), "");
        assert_eq!(tail_of_bytes(b"\nonly\n".to_vec(), true, 10), "[earlier lines cut]\nonly");
        assert_eq!(tail_of_bytes(b"x".to_vec(), true, 10), "");
        assert_eq!(tail_of_bytes(b"xpartial\nwhole\n".to_vec(), true, 10), "[earlier lines cut]\nwhole");
    }

    #[test]
    fn crlf_lines_come_back_without_the_carriage_return() {
        let dir = scratch("crlf");
        let file = dir.join("hivemind.log");
        std::fs::write(&file, "one\r\ntwo\r\nthree\r\n").unwrap();
        assert_eq!(tail_of(&file, 2, 1000).unwrap(), "[earlier lines cut]\ntwo\nthree");
        assert_eq!(tail_of(&file, 5, 1000).unwrap(), "one\ntwo\nthree");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_window_that_begins_inside_a_multibyte_character_leaves_no_replacement_character() {
        let dir = scratch("multibyte");
        let file = dir.join("hivemind.log");
        // "aaaa\n" is 5 bytes; the euro sign is 3 bytes (bytes 5..8); "\nz\n" follows.
        std::fs::write(&file, "aaaa\n\u{20ac}\u{20ac}\nz\n").unwrap();
        for window in 1..=15 {
            let tail = tail_of(&file, 10, window).unwrap();
            assert!(!tail.contains('\u{fffd}'), "window {window}: {tail:?}");
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_webview_engine_is_named_by_target() {
        assert_eq!(engine_label("windows"), "WebView2");
        assert_eq!(engine_label("macos"), "WebKit");
        assert_eq!(engine_label("linux"), "Webview");
    }

    #[test]
    fn the_summary_counts_allowed_commands_and_shows_the_appearance() {
        let s = Settings {
            theme: Some("emerald".into()),
            density: Some("compact".into()),
            python: Some("C:\\Users\\someone\\python.exe".into()),
            capture_shortcut: Some("Ctrl+Shift+Q".into()),
            allowed_commands: Some(BTreeMap::from([("proj".to_string(), vec!["npm test".to_string(), "secret-command --token abc".to_string()])])),
            shortcuts: Some(BTreeMap::from([("note.new".to_string(), "Mod+J".to_string()), ("tab.close".to_string(), "Mod+Shift+J".to_string())])),
            ..Settings::default()
        };
        let text = settings_summary(&s);
        for key in ["theme: emerald", "density: compact", "document_background:", "ui_font:", "doc_width:", "default_mode:", "allowed_commands: 2", "shortcut_overrides: 2", "python_set: true", "script_set: false"] {
            assert!(text.contains(key), "{key} is missing from:\n{text}");
        }
        for leaked in ["npm test", "secret-command", "someone", "Ctrl+Shift+Q", "proj", "Mod+J", "note.new"] {
            assert!(!text.contains(leaked), "{leaked} leaked into:\n{text}");
        }
    }

    #[test]
    fn the_report_has_the_info_the_settings_and_the_log_or_why_there_is_none() {
        let text = render(&info(), "theme: emerald", "[INFO] started", None);
        for part in ["Hivemind 0.1.0", "WebView2 140.0", "windows x86_64, Windows 11 (build 26100)", "Log folder: L", "theme: emerald", "Log (newest lines)\n[INFO] started"] {
            assert!(text.contains(part), "{part} is missing from:\n{text}");
        }
        let text = render(&info(), "theme: emerald", "", Some("PermissionDenied"));
        assert!(text.contains("Log file unavailable: PermissionDenied") && !text.contains("Log (newest"), "{text}");
    }
}
