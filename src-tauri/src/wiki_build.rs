//! The agent-written wiki's build. `living_memory.py wiki --agent --build` runs as a child process of its own, never through the
//! bridge: `serve --stdio` sits behind one Mutex, and a build that takes minutes would block every other call.
//!
//! With `--progress` Living Memory writes one JSON object per line to stderr (`start`, `call`, `end`). Each is forwarded as
//! `wiki-build-progress`, and `wiki-build-done` fires at the end. Lines that are not such objects are ignored (they only feed the
//! error message). One real build runs at a time; a dry run spends nothing and
//! bypasses that slot. `cancel` stops the build's process tree, and the edition keeps the pages already written.
use crate::settings::{Launch, Settings};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

pub const PROGRESS_EVENT: &str = "wiki-build-progress";
pub const DONE_EVENT: &str = "wiki-build-done";
pub const CANCELLED: &str = "Build cancelled.";

/// The real build in the slot. `pid` is None from the moment the slot is taken until the child has started, and a cancel in that
/// window is kept in `cancelled`, which the start checks right before spawning.
struct Running {
    pid: Option<u32>,
    cancelled: bool,
}
static RUNNING: Mutex<Option<Running>> = Mutex::new(None);

fn running() -> MutexGuard<'static, Option<Running>> {
    RUNNING.lock().unwrap_or_else(|e| e.into_inner())
}

/// Clears the running build when the run is over, however it ends.
struct Clear;
impl Drop for Clear {
    fn drop(&mut self) {
        *running() = None;
    }
}

/// `wiki --agent --build --domain D [--project P] [--budget USD] [--restructure] [--dry-run] --progress`. No `--actor`: a build is
/// the main actor's. A manual build passes no budget and gets Living Memory's default; a scheduled one passes its own cap.
pub fn build_argv(domain: &str, project: Option<&str>, budget: Option<f64>, restructure: bool, dry_run: bool) -> Vec<String> {
    let mut argv: Vec<String> = ["wiki", "--agent", "--build", "--domain", domain].map(String::from).into();
    if let Some(project) = project {
        argv.extend(["--project".into(), project.into()]);
    }
    if let Some(budget) = budget {
        argv.extend(["--budget".into(), format!("{budget:.2}")]);
    }
    if restructure {
        argv.push("--restructure".into());
    }
    if dry_run {
        argv.push("--dry-run".into());
    }
    argv.push("--progress".into());
    argv
}

/// A progress line: a JSON object with an `event` name. Anything else on stderr is not one.
pub fn parse_progress(line: &str) -> Option<Value> {
    let value: Value = serde_json::from_str(line.trim()).ok()?;
    value.get("event").and_then(Value::as_str)?;
    Some(value)
}

/// The event payload: the line's own keys plus the domain and scope it belongs to.
fn tagged(mut line: Value, domain: &str, scope: &str) -> Value {
    if let Some(object) = line.as_object_mut() {
        object.insert("domain".into(), json!(domain));
        object.insert("scope".into(), json!(scope));
    }
    line
}

fn error_text(value: &Value) -> Option<String> {
    let error = value.get("error")?;
    error.as_str().or_else(|| error.get("message").and_then(Value::as_str)).map(String::from)
}

/// The result object on stdout: the whole text, or else its last line.
fn parse_result(stdout: &str) -> Option<Value> {
    let text = stdout.trim();
    [text, text.lines().last().unwrap_or("").trim()]
        .into_iter()
        .filter_map(|s| serde_json::from_str::<Value>(s).ok())
        .find(Value::is_object)
}

/// What went wrong when stdout holds no result: an error object on stderr, else its last lines.
fn tail_message(tail: &[String], code: Option<i32>) -> String {
    if let Some(message) = tail.iter().rev().filter_map(|l| serde_json::from_str::<Value>(l.trim()).ok()).find_map(|v| error_text(&v)) {
        return message;
    }
    let last: Vec<&str> = tail.iter().rev().take(3).rev().map(|l| l.trim()).collect();
    if last.is_empty() {
        return format!("Living Memory exited with code {}", code.map_or("unknown".into(), |c| c.to_string()));
    }
    last.join(" ").chars().take(400).collect()
}

/// The command's outcome: its result object, or the reason it failed.
pub fn finish(code: Option<i32>, stdout: &str, tail: &[String], cancelled: bool) -> Result<Value, String> {
    if cancelled {
        return Err(CANCELLED.into());
    }
    match parse_result(stdout) {
        Some(v) if v.get("ok").and_then(Value::as_bool) == Some(false) => Err(error_text(&v).unwrap_or_else(|| "Living Memory reported a failure.".into())),
        Some(v) => Ok(v),
        None => Err(tail_message(tail, code)),
    }
}

/// What a finished build says in an automation's run list, and what it cost. A build with no changed notes writes nothing, asks
/// for no page and costs $0.
pub fn summary(result: &Value) -> (String, f64) {
    let count = |key: &str| result.get(key).and_then(Value::as_array).map_or(0, Vec::len);
    let cost = result.get("cost_usd").and_then(Value::as_f64).unwrap_or(0.0);
    let (written, failed, pending) = (count("written"), count("failed"), count("pending"));
    if written + failed + pending == 0 {
        return ("Nothing changed".into(), cost);
    }
    let mut text = format!("{written} page{} written, ${cost:.2}", if written == 1 { "" } else { "s" });
    if failed > 0 {
        text.push_str(&format!(", {failed} failed"));
    }
    if pending > 0 {
        text.push_str(&format!(", {pending} left"));
    }
    (text, cost)
}

/// A domain or project goes to Living Memory as one argument; one that starts with `-` would read as a flag.
fn check_name(what: &str, value: &str) -> Result<(), String> {
    if value.is_empty() || value.starts_with('-') {
        return Err(format!("Not a valid {what}: {value:?}"));
    }
    Ok(())
}

/// The environment variable that points Living Memory at the native `claude` executable (it otherwise looks only on PATH).
pub const CLAUDE_ENV: &str = "LIVING_MEMORY_CLAUDE";

/// The Claude Code program Hivemind resolved for its own sessions, when it can go in `LIVING_MEMORY_CLAUDE`: an absolute path to
/// the executable. A bare name (found on PATH, so Living Memory finds it too) or a `.cmd` or `.bat` shim is left out.
pub fn claude_override(found: &Result<String, String>) -> Option<&str> {
    let path = found.as_deref().ok()?;
    let at = Path::new(path);
    let shim = at.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat"));
    (at.is_absolute() && !shim).then_some(path)
}

/// A build runs on Claude Code; a user who hid it in Settings has no way to see or stop one, so Rust refuses it (a dry run too).
pub fn check_shown(saved: &Settings) -> Result<(), String> {
    if saved.shows(crate::agent::Engine::Claude) {
        Ok(())
    } else {
        Err("Claude Code is hidden in Settings. Show it again to build the wiki.".into())
    }
}

fn command(launch: &Launch, argv: &[String], claude: Option<&str>) -> Command {
    let mut command = Command::new(&launch.program);
    command.args(&launch.args).arg(&launch.script);
    if let Some(root) = &launch.root {
        command.arg("--root").arg(root);
    }
    command
        .args(argv)
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONUTF8", "1")
        // A build is the main actor's: Living Memory refuses it for a subagent, a viewer and a Hivemind terminal session.
        .env_remove("LIVING_MEMORY_ACTOR")
        .env_remove("HIVEMIND_SESSION")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(claude) = claude {
        command.env(CLAUDE_ENV, claude);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0); // so a cancel that has to force it can address the whole group
    }
    command
}

/// How long the builder gets to end after SIGTERM (Unix) before its whole group is killed. Living Memory starts each `claude`
/// call in a session of its own, so the group kill misses them; on SIGTERM it stops its own provider children and exits.
#[cfg_attr(windows, allow(dead_code))]
const TERM_GRACE: Duration = Duration::from_secs(5);
#[cfg_attr(windows, allow(dead_code))]
const POLL: Duration = Duration::from_millis(100);

/// Run `kill` with `args` on the build's process.
#[cfg(unix)]
fn send_signal(args: &[String]) {
    let _ = Command::new("kill").args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status();
}

/// Stop a process and what it started, the Unix way: SIGTERM goes to the build's process group (the launcher and the Python
/// interpreter behind it), so the builder can stop the `claude` calls it started; if it is still running after `grace`, SIGKILL
/// goes to the same group.
#[cfg_attr(windows, allow(dead_code))]
fn terminate_with(pid: u32, gone: &dyn Fn() -> bool, grace: Duration, step: Duration, send: &dyn Fn(&[String])) {
    send(&["-TERM".to_string(), format!("-{pid}")]);
    let started = std::time::Instant::now();
    while started.elapsed() < grace {
        if gone() {
            return;
        }
        std::thread::sleep(step);
    }
    if !gone() {
        send(&["-KILL".to_string(), format!("-{pid}")]);
    }
}

/// Stop a process and everything it started (`claude` children, the Python interpreter behind a launcher).
fn terminate(pid: u32) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .status();
    }
    #[cfg(unix)]
    terminate_with(pid, &|| !running().as_ref().is_some_and(|r| r.pid == Some(pid)), TERM_GRACE, POLL, &send_signal);
}

/// Mark the build cancelled and return its pid; None when none runs, or when its child has not started yet (the start then sees the mark).
fn mark_cancelled() -> Option<u32> {
    let mut slot = running();
    let r = slot.as_mut()?;
    r.cancelled = true;
    r.pid
}

/// Stop the running build, if any. The edition keeps the pages it already wrote. It returns at once; on Unix the stop can take up
/// to `TERM_GRACE`, on a thread of its own.
pub fn cancel() {
    if let Some(pid) = mark_cancelled() {
        std::thread::spawn(move || terminate(pid));
    }
}

/// Stop the running build and wait until it is stopped: the app's exit cleanup, which must not leave a paid build behind.
pub fn stop() {
    if let Some(pid) = mark_cancelled() {
        terminate(pid);
    }
}

/// Start the child. A real build (`track`) first checks its slot for a cancel that came before the child existed, and records the
/// child's pid under the same lock, so a cancel never falls between the two.
fn spawn(launch: &Launch, argv: &[String], claude: Option<&str>, track: bool) -> Result<Child, String> {
    let mut slot = track.then(running);
    if slot.as_deref().and_then(Option::as_ref).is_some_and(|r| r.cancelled) {
        return Err(CANCELLED.into());
    }
    let child = command(launch, argv, claude)
        .spawn()
        .map_err(|e| format!("Could not start {} {}: {e}", launch.program, launch.script.display()))?;
    if let Some(r) = slot.as_deref_mut().and_then(Option::as_mut) {
        r.pid = Some(child.id());
    }
    Ok(child)
}

fn report(emit: &dyn Fn(&str, Value), domain: &str, scope: &str, outcome: &Result<Value, String>) {
    let done = match outcome {
        Ok(result) => json!({ "domain": domain, "scope": scope, "ok": true, "result": result }),
        Err(error) => json!({ "domain": domain, "scope": scope, "ok": false, "error": error }),
    };
    emit(DONE_EVENT, done);
}

/// Run one build, or a dry run, and return the parsed stdout object. A real build also reports through `emit`
/// (`wiki-build-progress` per line, `wiki-build-done` at the end); a dry run spends nothing and emits nothing.
/// A second real build while one runs fails at once, without events. A dry run does not use that slot, so previews can overlap
/// each other and a build. `claude` finds the path for `LIVING_MEMORY_CLAUDE` (see `claude_override`); it can be slow (it runs
/// `claude --version`), so it is called only after the real build holds the slot, where a cancel is kept, and never for a dry run.
#[allow(clippy::too_many_arguments)] // each argument is one independent part of the build
pub fn run(emit: &dyn Fn(&str, Value), launch: &Launch, domain: &str, project: Option<&str>, budget: Option<f64>, restructure: bool, dry_run: bool, claude: &dyn Fn() -> Option<String>) -> Result<Value, String> {
    check_name("domain", domain)?;
    if let Some(project) = project {
        check_name("project", project)?;
    }
    let scope = project.unwrap_or("domain");
    let _clear = if dry_run {
        None
    } else {
        let mut slot = running();
        if slot.is_some() {
            return Err("A wiki build is already running.".into());
        }
        *slot = Some(Running { pid: None, cancelled: false });
        Some(Clear)
    };
    let claude = if dry_run { None } else { claude() };
    let mut child = match spawn(launch, &build_argv(domain, project, budget, restructure, dry_run), claude.as_deref(), !dry_run) {
        Ok(child) => child,
        Err(e) => {
            if e == CANCELLED {
                report(emit, domain, scope, &Err(e.clone()));
            }
            return Err(e);
        }
    };
    let mut stdout_pipe = child.stdout.take();
    let stdout = std::thread::spawn(move || {
        let mut text = String::new();
        if let Some(pipe) = stdout_pipe.as_mut() {
            let mut bytes = Vec::new();
            let _ = pipe.read_to_end(&mut bytes);
            text = String::from_utf8_lossy(&bytes).into_owned();
        }
        text
    });
    let mut tail: Vec<String> = Vec::new();
    if let Some(pipe) = child.stderr.take() {
        let mut reader = BufReader::new(pipe);
        let mut bytes = Vec::new();
        // Bytes, not lines: a line that is not UTF-8 must not stop the reading and leave the child blocked on a full pipe.
        while reader.read_until(b'\n', &mut bytes).unwrap_or(0) > 0 {
            let line = String::from_utf8_lossy(&bytes).into_owned();
            bytes.clear();
            match parse_progress(&line) {
                Some(event) => {
                    if !dry_run {
                        emit(PROGRESS_EVENT, tagged(event, domain, scope));
                    }
                }
                None if !line.trim().is_empty() => {
                    tail.push(line);
                    if tail.len() > 20 {
                        tail.remove(0);
                    }
                }
                None => {}
            }
        }
    }
    let stdout = stdout.join().unwrap_or_default();
    let code = child.wait().ok().and_then(|status| status.code());
    let cancelled = !dry_run && running().as_ref().is_some_and(|r| r.cancelled);
    let outcome = finish(code, &stdout, &tail, cancelled);
    if !dry_run {
        report(emit, domain, scope, &outcome);
    }
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn the_build_argv_follows_the_contract() {
        assert_eq!(build_argv("demo", None, None, false, false), ["wiki", "--agent", "--build", "--domain", "demo", "--progress"]);
        assert_eq!(
            build_argv("demo", Some("core"), None, true, true),
            ["wiki", "--agent", "--build", "--domain", "demo", "--project", "core", "--restructure", "--dry-run", "--progress"]
        );
        assert!(!build_argv("demo", None, None, false, false).iter().any(|a| a == "--actor"));
    }

    #[test]
    fn a_scheduled_build_passes_its_budget_and_a_manual_one_none() {
        assert_eq!(
            build_argv("demo", Some("core"), Some(2.0), false, false),
            ["wiki", "--agent", "--build", "--domain", "demo", "--project", "core", "--budget", "2.00", "--progress"]
        );
        assert_eq!(build_argv("demo", None, Some(0.5), false, false)[5..7], ["--budget", "0.50"]);
        assert!(!build_argv("demo", Some("core"), None, true, false).iter().any(|a| a == "--budget"));
    }

    #[test]
    fn progress_lines_are_json_objects_with_an_event_and_the_rest_is_ignored() {
        let call = parse_progress(r#"{"event": "call", "kind": "page", "page": "pg0a1b2c", "title": "Overview", "ok": true, "done": 2, "total": 9, "cost_usd": 0.42}"#).unwrap();
        assert_eq!(call["done"], 2);
        assert_eq!(parse_progress("  {\"event\":\"start\",\"scope\":\"domain\",\"calls\":null}\r\n").unwrap()["event"], "start");
        for line in ["", "Traceback (most recent call last):", "{not json", "[1, 2]", "{\"ok\": false}", "{\"event\": 3}", "42"] {
            assert_eq!(parse_progress(line), None, "{line}");
        }
    }

    #[test]
    fn events_carry_their_domain_and_scope() {
        let event = tagged(parse_progress(r#"{"event":"end","ok":true,"stopped":null,"cost_usd":1.5}"#).unwrap(), "demo", "core");
        assert_eq!(event, json!({ "event": "end", "ok": true, "stopped": null, "cost_usd": 1.5, "domain": "demo", "scope": "core" }));
    }

    #[test]
    fn a_result_is_the_stdout_object_and_a_failure_names_its_reason() {
        let result = r#"{"ok": true, "written": ["pg000001"], "cost_usd": 0.1}"#;
        assert_eq!(finish(Some(0), result, &[], false).unwrap()["written"][0], "pg000001");
        // Output before the object does not hide it.
        assert!(finish(Some(0), &format!("note\n{result}\n"), &[], false).is_ok());
        let refused = r#"{"ok": false, "error": "no agent wiki for domain yet"}"#;
        assert_eq!(finish(Some(2), refused, &[], false), Err("no agent wiki for domain yet".into()));
        assert_eq!(finish(Some(2), r#"{"ok": false, "error": {"code": "x", "message": "refused"}}"#, &[], false), Err("refused".into()));
        let tail = vec!["warming up".to_string(), r#"{"ok": false, "error": "claude is not signed in"}"#.to_string()];
        assert_eq!(finish(Some(1), "", &tail, false), Err("claude is not signed in".into()));
        assert_eq!(finish(Some(1), "", &["boom".to_string()], false), Err("boom".into()));
        assert_eq!(finish(Some(3), "", &[], false), Err("Living Memory exited with code 3".into()));
        assert_eq!(finish(Some(1), result, &[], true), Err(CANCELLED.into()));
    }

    #[test]
    fn the_claude_path_goes_to_living_memory_only_when_it_is_an_executable() {
        let found = |p: &str| -> Result<String, String> { Ok(p.to_string()) };
        let abs = if cfg!(windows) { "C:/Users/me/.local/bin/claude.exe" } else { "/home/me/.local/bin/claude" };
        assert_eq!(claude_override(&found(abs)), Some(abs));
        // Found on PATH by its bare name, so Living Memory finds it as well.
        assert_eq!(claude_override(&found("claude")), None);
        assert_eq!(claude_override(&Err("Claude Code was not found.".to_string())), None);
        let shim = if cfg!(windows) { "C:/Users/me/AppData/Roaming/npm/claude.cmd" } else { "/home/me/bin/claude.CMD" };
        assert_eq!(claude_override(&found(shim)), None);
        assert_eq!(claude_override(&found(&shim.replace(".cmd", ".bat"))), None);
    }

    #[test]
    fn the_build_child_gets_the_claude_path_and_no_session_identity() {
        let launch = Launch { program: "python3".into(), args: vec![], script: PathBuf::from("living_memory.py"), root: None };
        let env = |command: &Command, key: &str| command.get_envs().find(|(k, _)| *k == key).map(|(_, v)| v.map(|v| v.to_string_lossy().into_owned()));
        let with = command(&launch, &["wiki".to_string()], Some("C:/x/claude.exe"));
        assert_eq!(env(&with, CLAUDE_ENV), Some(Some("C:/x/claude.exe".to_string())));
        assert_eq!(env(&with, "HIVEMIND_SESSION"), Some(None)); // removed
        assert_eq!(env(&command(&launch, &["wiki".to_string()], None), CLAUDE_ENV), None);
    }

    #[test]
    fn a_hidden_claude_code_refuses_a_build() {
        assert!(check_shown(&Settings::default()).is_ok());
        assert!(check_shown(&Settings { hidden_engines: Some(vec!["codex".into()]), ..Default::default() }).is_ok());
        let hidden = Settings { hidden_engines: Some(vec!["claude".into()]), ..Default::default() };
        assert_eq!(check_shown(&hidden), Err("Claude Code is hidden in Settings. Show it again to build the wiki.".into()));
    }

    #[test]
    fn a_stop_sends_sigterm_to_the_group_first_and_kills_it_only_when_the_builder_stays() {
        use std::cell::{Cell, RefCell};
        let sent = RefCell::new(Vec::<Vec<String>>::new());
        let send = |args: &[String]| sent.borrow_mut().push(args.to_vec());
        let polls = Cell::new(0);
        // The builder ends on the third look: SIGTERM to the group only.
        terminate_with(77, &|| { polls.set(polls.get() + 1); polls.get() >= 3 }, Duration::from_secs(5), Duration::from_millis(1), &send);
        assert_eq!(*sent.borrow(), [["-TERM", "-77"]]);
        sent.borrow_mut().clear();
        // It never ends: SIGTERM, then SIGKILL to the group once the grace is over.
        terminate_with(77, &|| false, Duration::from_millis(30), Duration::from_millis(1), &send);
        assert_eq!(*sent.borrow(), [vec!["-TERM", "-77"], vec!["-KILL", "-77"]]);
    }

    #[test]
    fn a_finished_build_is_told_in_a_line_and_its_cost() {
        let done = json!({ "ok": true, "written": ["pg000001", "pg000002"], "failed": [], "pending": [], "cost_usd": 0.456 });
        assert_eq!(summary(&done), ("2 pages written, $0.46".to_string(), 0.456));
        assert_eq!(summary(&json!({ "written": ["pg000001"], "failed": [{ "page": "pg000002", "reason": "x" }], "pending": ["pg000003", "pg000004"], "cost_usd": 1.0 })).0, "1 page written, $1.00, 1 failed, 2 left");
        assert_eq!(summary(&json!({ "ok": true, "written": [], "failed": [], "pending": [], "cost_usd": 0 })), ("Nothing changed".to_string(), 0.0));
        assert_eq!(summary(&json!({ "ok": true })), ("Nothing changed".to_string(), 0.0));
    }

    #[test]
    fn a_name_that_reads_as_a_flag_is_refused() {
        assert!(check_name("domain", "demo").is_ok());
        assert!(check_name("domain", "--help").is_err());
        assert!(check_name("project", "").is_err());
    }

    fn python_launch(dir: &std::path::Path, source: &str) -> Option<Launch> {
        let script = dir.join("fake_lm.py");
        std::fs::write(&script, source).unwrap();
        let (program, args) = if cfg!(windows) { ("py", vec!["-3".to_string()]) } else { ("python3", vec![]) };
        Command::new(program).args(&args).arg("--version").output().ok()?;
        Some(Launch { program: program.into(), args, script, root: None })
    }

    /// One test for the real process handling, because the build slot is shared: a build forwards its progress and result, a dry
    /// run emits nothing and does not use the slot, a cancel before the child exists stops it from ever starting, and cancel
    /// ends a long build and frees the slot. Skipped when there is no Python.
    #[test]
    fn a_build_forwards_progress_and_can_be_cancelled() {
        let dir: PathBuf = std::env::temp_dir().join(format!("hivemind-wiki-build-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let finished = concat!(
            "import sys, json\n",
            "sys.stderr.write('not json\\n'); sys.stderr.flush()\n",
            "sys.stderr.write(json.dumps({'event': 'start', 'scope': 'domain', 'calls': 1}) + '\\n'); sys.stderr.flush()\n",
            "sys.stderr.write(json.dumps({'event': 'call', 'kind': 'page', 'page': 'pg000001', 'title': 'T', 'ok': True, 'done': 1, 'total': 1, 'cost_usd': 0.25}) + '\\n'); sys.stderr.flush()\n",
            "dry = '--dry-run' in sys.argv\n",
            "import os\n",
            "print(json.dumps({'ok': True, 'dry_run': dry, 'written': [] if dry else ['pg000001'], 'argv': sys.argv[1:], 'claude': os.environ.get('LIVING_MEMORY_CLAUDE')}))\n",
        );
        let Some(launch) = python_launch(&dir, finished) else { return };
        let seen = Mutex::new(Vec::<(String, Value)>::new());
        let emit = |name: &str, payload: Value| seen.lock().unwrap().push((name.to_string(), payload));

        let result = run(&emit, &launch, "demo", Some("core"), Some(2.0), false, false, &|| Some("C:/x/claude.exe".to_string())).unwrap();
        assert_eq!(result["written"][0], "pg000001");
        assert_eq!(result["claude"], "C:/x/claude.exe");
        let argv = result["argv"].as_array().unwrap();
        assert!(argv.windows(2).any(|w| w[0] == "--budget" && w[1] == "2.00"));
        assert!(result["argv"].as_array().unwrap().iter().any(|a| a == "--progress"));
        let events = seen.lock().unwrap().clone();
        assert_eq!(events.iter().map(|(n, _)| n.as_str()).collect::<Vec<_>>(), [PROGRESS_EVENT, PROGRESS_EVENT, DONE_EVENT]);
        assert_eq!(events[1].1["done"], 1);
        assert_eq!(events[1].1["scope"], "core");
        assert_eq!(events[2].1["ok"], true);
        assert_eq!(events[2].1["result"]["written"][0], "pg000001");

        seen.lock().unwrap().clear();
        let dry = run(&emit, &launch, "demo", None, None, false, true, &|| panic!("a dry run does not look for Claude")).unwrap();
        assert_eq!(dry["dry_run"], true);
        assert_eq!(dry["claude"], std::env::var(CLAUDE_ENV).map_or(Value::Null, Value::from)); // inherited, not set by the run
        assert!(seen.lock().unwrap().is_empty());

        // A cancel that comes while Claude is being looked for (the slot is already taken) is kept: the child never starts.
        let probing = run(&emit, &launch, "demo", None, None, false, false, &|| {
            cancel();
            Some("C:/x/claude.exe".to_string())
        });
        assert_eq!(probing, Err(CANCELLED.into()));
        assert_eq!(seen.lock().unwrap().iter().map(|(n, _)| n.clone()).collect::<Vec<_>>(), [DONE_EVENT]);
        assert!(running().is_none());
        seen.lock().unwrap().clear();

        // A cancel that came before the child existed (the slot is taken, no pid yet) keeps the child from starting.
        *running() = Some(Running { pid: None, cancelled: true });
        assert_eq!(spawn(&launch, &build_argv("demo", None, None, false, false), None, true).err(), Some(CANCELLED.to_string()));
        *running() = None;
        assert_eq!(mark_cancelled(), None); // nothing to cancel when no build runs
        assert!(running().is_none());

        let hanging = concat!(
            "import sys, json, time\n",
            "sys.stderr.write(json.dumps({'event': 'start', 'scope': 'domain', 'calls': 5}) + '\\n'); sys.stderr.flush()\n",
            "time.sleep(120)\n",
        );
        let launch = python_launch(&dir, hanging).unwrap();
        let other = dir.join("preview");
        std::fs::create_dir_all(&other).unwrap();
        let preview = python_launch(&other, finished).unwrap();
        seen.lock().unwrap().clear();
        let cancelling = |name: &str, payload: Value| {
            if name == PROGRESS_EVENT {
                // The child is running; a second real build is refused, a dry run is not, then cancel.
                assert_eq!(run(&|_: &str, _: Value| {}, &launch, "demo", None, None, false, false, &|| None), Err("A wiki build is already running.".into()));
                assert_eq!(run(&|_: &str, _: Value| {}, &preview, "demo", None, None, true, true, &|| None).unwrap()["dry_run"], true);
                assert!(running().is_some(), "the preview left the build's slot alone");
                cancel();
            }
            seen.lock().unwrap().push((name.to_string(), payload));
        };
        let started = std::time::Instant::now();
        assert_eq!(run(&cancelling, &launch, "demo", None, None, false, false, &|| None), Err(CANCELLED.into()));
        assert!(started.elapsed() < std::time::Duration::from_secs(60));
        let events = seen.lock().unwrap().clone();
        assert_eq!(events.last().unwrap().0, DONE_EVENT);
        assert_eq!(events.last().unwrap().1["ok"], false);
        assert!(running().is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
