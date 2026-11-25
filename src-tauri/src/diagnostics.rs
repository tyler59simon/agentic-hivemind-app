//! Logs and diagnostics (DESK-LOGS): the rotating log file, the panic hook, and the text "Copy diagnostics" puts on the
//! clipboard. Nothing here reads a note: the summary has settings and folder paths only, and the log holds what the code
//! chose to log (paths, ids, counts, error kinds).

use crate::settings::{self, Settings};
use crate::AppState;
use serde::Serialize;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
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
/// How much of the end of the log file is read to find those lines.
const TAIL_READ: u64 = 256 * 1024;
/// A panic message is cut here: `str` slicing and `unwrap` messages can quote the text they failed on.
const PANIC_MESSAGE_MAX: usize = 1000;

/// Info in a release build, Debug in a debug build.
pub fn log_level(debug: bool) -> log::LevelFilter {
    if debug { log::LevelFilter::Debug } else { log::LevelFilter::Info }
}

/// The log plugin. It must be the first plugin, so everything after it can log from its setup.
pub fn log_plugin<R: Runtime>() -> TauriPlugin<R> {
    let debug = cfg!(debug_assertions);
    let mut builder = tauri_plugin_log::Builder::new()
        .clear_targets()
        .target(Target::new(TargetKind::LogDir { file_name: Some(LOG_NAME.into()) }))
        .max_file_size(LOG_MAX_BYTES)
        .rotation_strategy(RotationStrategy::KeepSome(LOG_KEEP))
        .timezone_strategy(TimezoneStrategy::UseLocal)
        .level(log_level(debug));
    if debug {
        builder = builder.target(Target::new(TargetKind::Stdout));
    }
    builder.build()
}

/// One log record for a panic: where, on which thread, what it said, and the backtrace.
pub fn format_panic(thread: &str, location: Option<&str>, message: &str, backtrace: &str) -> String {
    let message: String = message.chars().take(PANIC_MESSAGE_MAX).collect();
    format!("panic in thread '{thread}' at {}: {message}\n{backtrace}", location.unwrap_or("an unknown place"))
}

/// Log every panic (including the ones `catch_unwind` takes), then run the hook that was there before. A release build
/// aborts on panic, so the log is flushed before the previous hook runs.
pub fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let thread = std::thread::current();
        let location = info.location().map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()));
        let message = info.payload_as_str().unwrap_or("a payload that is not text");
        let backtrace = std::backtrace::Backtrace::force_capture().to_string();
        log::error!("{}", format_panic(thread.name().unwrap_or("unnamed"), location.as_deref(), message, &backtrace));
        log::logger().flush();
        previous(info);
    }));
}

/// The last `lines` lines of a text file, read from its last `TAIL_READ` bytes. Empty when it cannot be read.
fn tail_lines(path: &Path, lines: usize) -> String {
    let read = || -> std::io::Result<String> {
        let mut file = std::fs::File::open(path)?;
        let start = file.metadata()?.len().saturating_sub(TAIL_READ);
        file.seek(SeekFrom::Start(start))?;
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)?;
        let text = String::from_utf8_lossy(&bytes).into_owned();
        // A read that began mid-file starts mid-line.
        let text = if start > 0 { text.split_once('\n').map(|(_, rest)| rest.to_string()).unwrap_or_default() } else { text };
        let all: Vec<&str> = text.lines().collect();
        Ok(all[all.len().saturating_sub(lines)..].join("\n"))
    };
    read().unwrap_or_default()
}

/// What the app knows about itself and where it keeps things.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    version: String,
    tauri: String,
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
        webview: tauri::webview_version().unwrap_or_else(|_| "unknown".into()),
        os: std::env::consts::OS.into(),
        arch: std::env::consts::ARCH.into(),
        os_version,
        data_dir: shown(paths.app_data_dir())?,
        config_dir: shown(paths.app_config_dir())?,
        log_dir: shown(paths.app_log_dir())?,
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
        ("hidden_engines", count(s.hidden_engines.as_ref().map(Vec::len))),
        ("other_folders", count(s.other_folders.as_ref().map(Vec::len))),
        ("allowed_commands", commands.to_string()),
        ("architecture_rules", count(s.architecture_rules.as_ref().map(|r| r.len()))),
    ];
    lines.iter().map(|(k, v)| format!("{k}: {v}")).collect::<Vec<_>>().join("\n")
}

/// The block "Copy diagnostics" puts on the clipboard.
fn render(info: &AppInfo, settings: &str, log: &str) -> String {
    let os = info.os_version.as_deref().map(|v| format!(", {v}")).unwrap_or_default();
    format!(
        "Hivemind {}\nTauri {}\nWebView2 {}\n{} {}{os}\nData folder: {}\nConfig folder: {}\nLog folder: {}\n\nSettings\n{settings}\n\nLog (last {TAIL_LINES} lines)\n{log}\n",
        info.version, info.tauri, info.webview, info.os, info.arch, info.data_dir, info.config_dir, info.log_dir
    )
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
    let log = tail_lines(&Path::new(&info.log_dir).join(format!("{LOG_NAME}.log")), TAIL_LINES);
    Ok(render(&info, &settings_summary(&settings::load(&state.settings_path)), &log))
}

/// Open the log folder in the file manager. Done here so the webview's opener scope stays as narrow as it is.
#[tauri::command]
pub fn open_logs_folder(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    app.opener().open_path(dir.display().to_string(), None::<&str>).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hivemind-diagnostics-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_debug_build_logs_debug_and_a_release_build_logs_info() {
        assert_eq!(log_level(true), log::LevelFilter::Debug);
        assert_eq!(log_level(false), log::LevelFilter::Info);
    }

    #[test]
    fn a_panic_record_has_the_thread_place_message_and_backtrace() {
        let text = format_panic("main", Some("src/lib.rs:10:5"), "boom", "0: frame");
        assert_eq!(text, "panic in thread 'main' at src/lib.rs:10:5: boom\n0: frame");
        assert!(format_panic("t", None, "m", "").contains("an unknown place"));
    }

    #[test]
    fn a_long_panic_message_is_cut() {
        let text = format_panic("t", None, &"é".repeat(PANIC_MESSAGE_MAX + 50), "");
        assert_eq!(text.matches('é').count(), PANIC_MESSAGE_MAX);
    }

    #[test]
    fn the_tail_is_at_most_n_lines_from_the_end() {
        let dir = scratch("tail");
        let file = dir.join("hivemind.log");
        std::fs::write(&file, (1..=10).map(|n| format!("line {n}\n")).collect::<String>()).unwrap();
        assert_eq!(tail_lines(&file, 3), "line 8\nline 9\nline 10");
        assert_eq!(tail_lines(&file, 50).lines().count(), 10);
        assert_eq!(tail_lines(&dir.join("missing.log"), 3), "");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_tail_of_a_large_file_starts_on_a_whole_line() {
        let dir = scratch("large");
        let file = dir.join("hivemind.log");
        let line = format!("{}\n", "x".repeat(99));
        std::fs::write(&file, line.repeat(5000)).unwrap();
        let tail = tail_lines(&file, 10_000);
        assert!(tail.lines().count() < 5000);
        assert!(tail.lines().all(|l| l.len() == 99));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_summary_counts_allowed_commands_and_shows_the_appearance() {
        let s = Settings {
            theme: Some("emerald".into()),
            density: Some("compact".into()),
            python: Some("C:\\Users\\someone\\python.exe".into()),
            capture_shortcut: Some("Ctrl+Shift+Q".into()),
            allowed_commands: Some(BTreeMap::from([("proj".to_string(), vec!["npm test".to_string(), "secret-command --token abc".to_string()])])),
            ..Settings::default()
        };
        let text = settings_summary(&s);
        for key in ["theme: emerald", "density: compact", "document_background:", "ui_font:", "doc_width:", "default_mode:", "allowed_commands: 2", "python_set: true", "script_set: false"] {
            assert!(text.contains(key), "{key} is missing from:\n{text}");
        }
        for leaked in ["npm test", "secret-command", "someone", "Ctrl+Shift+Q", "proj"] {
            assert!(!text.contains(leaked), "{leaked} leaked into:\n{text}");
        }
    }

    #[test]
    fn the_report_has_the_info_the_settings_and_the_log() {
        let info = AppInfo {
            version: "0.1.0".into(), tauri: "2.12.5".into(), webview: "140.0".into(), os: "windows".into(), arch: "x86_64".into(),
            os_version: Some("Windows 11 (build 26100)".into()), data_dir: "D".into(), config_dir: "C".into(), log_dir: "L".into(),
        };
        let text = render(&info, "theme: dark", "[INFO] started");
        for part in ["Hivemind 0.1.0", "WebView2 140.0", "windows x86_64, Windows 11 (build 26100)", "Log folder: L", "theme: dark", "[INFO] started"] {
            assert!(text.contains(part), "{part} is missing from:\n{text}");
        }
    }
}
