//! The agent-written wiki's build. `living_memory.py wiki --agent --build` runs as a child process of its own, never through the
//! bridge: `serve --stdio` sits behind one Mutex, and a build that takes minutes would block every other call.
//!
//! With `--progress` Living Memory writes one JSON object per line to stderr (`start`, `call`, `end`). Each is forwarded as
//! `wiki-build-progress`, and `wiki-build-done` fires at the end. Lines that are not such objects are ignored (they only feed the
//! error message). One build runs at a time; `cancel` kills its process tree, and the edition keeps the pages already written.
use crate::settings::Launch;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read};
use std::process::{Command, Stdio};
use std::sync::{Mutex, MutexGuard};

pub const PROGRESS_EVENT: &str = "wiki-build-progress";
pub const DONE_EVENT: &str = "wiki-build-done";
pub const CANCELLED: &str = "Build cancelled.";

struct Running {
    pid: u32,
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

/// `wiki --agent --build --domain D [--project P] [--restructure] [--dry-run] --progress`. No `--actor`: a build is the main actor's.
pub fn build_argv(domain: &str, project: Option<&str>, restructure: bool, dry_run: bool) -> Vec<String> {
    let mut argv: Vec<String> = ["wiki", "--agent", "--build", "--domain", domain].map(String::from).into();
    if let Some(project) = project {
        argv.extend(["--project".into(), project.into()]);
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

/// A domain or project goes to Living Memory as one argument; one that starts with `-` would read as a flag.
fn check_name(what: &str, value: &str) -> Result<(), String> {
    if value.is_empty() || value.starts_with('-') {
        return Err(format!("Not a valid {what}: {value:?}"));
    }
    Ok(())
}

fn command(launch: &Launch, argv: &[String]) -> Command {
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
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0); // so cancel can address the whole group
    }
    command
}

/// Kill a process and everything it started (`claude` children, the Python interpreter behind a launcher).
fn kill_tree(pid: u32) {
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
    #[cfg(not(windows))]
    {
        let _ = Command::new("kill").args(["-KILL", &format!("-{pid}")]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status();
    }
}

/// Stop the running build, if any. The edition keeps the pages it already wrote.
pub fn cancel() {
    if let Some(r) = running().as_mut() {
        r.cancelled = true;
        kill_tree(r.pid);
    }
}

/// Run one build, or a dry run, and return the parsed stdout object. A real build also reports through `emit`
/// (`wiki-build-progress` per line, `wiki-build-done` at the end); a dry run spends nothing and emits nothing.
/// A second start while one runs fails at once, without events.
pub fn run(emit: &dyn Fn(&str, Value), launch: &Launch, domain: &str, project: Option<&str>, restructure: bool, dry_run: bool) -> Result<Value, String> {
    check_name("domain", domain)?;
    if let Some(project) = project {
        check_name("project", project)?;
    }
    let scope = project.unwrap_or("domain");
    let mut child = {
        let mut slot = running();
        if slot.is_some() {
            return Err("A wiki build is already running.".into());
        }
        let child = command(launch, &build_argv(domain, project, restructure, dry_run))
            .spawn()
            .map_err(|e| format!("Could not start {} {}: {e}", launch.program, launch.script.display()))?;
        *slot = Some(Running { pid: child.id(), cancelled: false });
        child
    };
    let _clear = Clear;
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
    let cancelled = running().as_ref().is_some_and(|r| r.cancelled);
    let outcome = finish(code, &stdout, &tail, cancelled);
    if !dry_run {
        let done = match &outcome {
            Ok(result) => json!({ "domain": domain, "scope": scope, "ok": true, "result": result }),
            Err(error) => json!({ "domain": domain, "scope": scope, "ok": false, "error": error }),
        };
        emit(DONE_EVENT, done);
    }
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn the_build_argv_follows_the_contract() {
        assert_eq!(build_argv("demo", None, false, false), ["wiki", "--agent", "--build", "--domain", "demo", "--progress"]);
        assert_eq!(
            build_argv("demo", Some("core"), true, true),
            ["wiki", "--agent", "--build", "--domain", "demo", "--project", "core", "--restructure", "--dry-run", "--progress"]
        );
        assert!(!build_argv("demo", None, false, false).iter().any(|a| a == "--actor"));
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
    /// run emits nothing, and cancel ends a long build and frees the slot. Skipped when there is no Python.
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
            "print(json.dumps({'ok': True, 'dry_run': dry, 'written': [] if dry else ['pg000001'], 'argv': sys.argv[1:]}))\n",
        );
        let Some(launch) = python_launch(&dir, finished) else { return };
        let seen = Mutex::new(Vec::<(String, Value)>::new());
        let emit = |name: &str, payload: Value| seen.lock().unwrap().push((name.to_string(), payload));

        let result = run(&emit, &launch, "demo", Some("core"), false, false).unwrap();
        assert_eq!(result["written"][0], "pg000001");
        assert!(result["argv"].as_array().unwrap().iter().any(|a| a == "--progress"));
        let events = seen.lock().unwrap().clone();
        assert_eq!(events.iter().map(|(n, _)| n.as_str()).collect::<Vec<_>>(), [PROGRESS_EVENT, PROGRESS_EVENT, DONE_EVENT]);
        assert_eq!(events[1].1["done"], 1);
        assert_eq!(events[1].1["scope"], "core");
        assert_eq!(events[2].1["ok"], true);
        assert_eq!(events[2].1["result"]["written"][0], "pg000001");

        seen.lock().unwrap().clear();
        let dry = run(&emit, &launch, "demo", None, false, true).unwrap();
        assert_eq!(dry["dry_run"], true);
        assert!(seen.lock().unwrap().is_empty());

        let hanging = concat!(
            "import sys, json, time\n",
            "sys.stderr.write(json.dumps({'event': 'start', 'scope': 'domain', 'calls': 5}) + '\\n'); sys.stderr.flush()\n",
            "time.sleep(120)\n",
        );
        let launch = python_launch(&dir, hanging).unwrap();
        seen.lock().unwrap().clear();
        let cancelling = |name: &str, payload: Value| {
            if name == PROGRESS_EVENT {
                // The child is running; a second start is refused, then cancel.
                assert_eq!(run(&|_: &str, _: Value| {}, &launch, "demo", None, false, true), Err("A wiki build is already running.".into()));
                cancel();
            }
            seen.lock().unwrap().push((name.to_string(), payload));
        };
        let started = std::time::Instant::now();
        assert_eq!(run(&cancelling, &launch, "demo", None, false, false), Err(CANCELLED.into()));
        assert!(started.elapsed() < std::time::Duration::from_secs(60));
        let events = seen.lock().unwrap().clone();
        assert_eq!(events.last().unwrap().0, DONE_EVENT);
        assert_eq!(events.last().unwrap().1["ok"], false);
        assert!(running().is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
