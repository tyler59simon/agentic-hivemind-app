//! One long-lived `living_memory.py serve --stdio` process. Requests are sent one at a time:
//! a request line goes out, then exactly one reply line comes back.
use crate::settings::Launch;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

/// Oldest `serve` API this app speaks (Living Memory's `version` reports it).
pub const MIN_API: u64 = 1;
const REQUIRED: [&str; 4] = ["serve", "list", "domains", "version"];
/// The longest request line Living Memory's `serve` reads (its SERVE_LIMIT); a longer one is never sent (NS-2C, C2).
pub const SERVE_LIMIT: usize = 2 * 1024 * 1024;
/// How much of the server's stderr is kept to explain why it exited.
const STDERR_TAIL: usize = 4096;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Reply {
    pub exit_code: i64,
    pub result: Value,
    pub error: Value,
}

struct Proc {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next: u64,
    /// The last STDERR_TAIL bytes the server wrote to stderr, read on a thread so a full pipe never blocks it.
    stderr: Arc<Mutex<Vec<u8>>>,
    drain: JoinHandle<()>,
}

impl Proc {
    /// `error`, plus the exit code and the server's last stderr output once its stderr has closed (waiting up to a second).
    /// The output is what it wrote last, which is not always why it stopped. `hint` is added only when there was no output.
    fn stopped(&mut self, error: &str, hint: &str) -> String {
        let deadline = Instant::now() + Duration::from_secs(1);
        while !self.drain.is_finished() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        let mut text = error.to_string();
        if let Ok(Some(status)) = self.child.try_wait() {
            text.push_str(&format!(" ({status})"));
        }
        let tail = String::from_utf8_lossy(&self.stderr.lock().unwrap()).trim().to_string();
        if tail.is_empty() {
            text.push_str(hint);
        } else {
            text.push_str(&format!(". Its last error output:\n{tail}"));
        }
        text
    }
}

impl Drop for Proc {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

pub struct Bridge {
    launch: Mutex<Launch>,
    proc: Mutex<Option<Proc>>,
    /// Counts reconfigures. It changes only while `proc` is locked, and `call_at` checks it under that lock, so a request
    /// made for one store never runs in the next (Codex re-review of 75ce884, R2-D1).
    generation: AtomicU64,
    /// The store root `connect` verified for this generation. A process started later in the same generation is given it
    /// with `--root`, so a default store that changed meanwhile (Living Memory's setup picked another) is never served
    /// under the old generation (Codex review of dd4c1b0, R3-D7). Cleared by `reconfigure`.
    pinned: Mutex<Option<PathBuf>>,
}

/// The error of a request made before the bridge switched stores.
pub const STORE_CHANGED: &str = "Living Memory switched to another store while this request waited, so Hivemind did not send it";

impl Bridge {
    pub fn new(launch: Launch) -> Self {
        Bridge { launch: Mutex::new(launch), proc: Mutex::new(None), generation: AtomicU64::new(0), pinned: Mutex::new(None) }
    }

    /// Point at a different interpreter/script/store; the next call starts a fresh process. Requests bound to the
    /// earlier generation are refused from now on.
    pub fn reconfigure(&self, launch: Launch) {
        let mut proc = self.proc.lock().unwrap();
        *self.launch.lock().unwrap() = launch;
        *self.pinned.lock().unwrap() = None;
        self.generation.fetch_add(1, Ordering::SeqCst);
        *proc = None;
    }

    /// Keep `root` as the store of `generation` (when that is still the current one and Settings name no root).
    pub fn pin_root(&self, generation: u64, root: PathBuf) {
        let _proc = self.proc.lock().unwrap();
        if generation == self.generation() && self.launch.lock().unwrap().root.is_none() {
            *self.pinned.lock().unwrap() = Some(root);
        }
    }

    /// The launch a new process uses: the configured one, with the pinned root when Settings name none.
    fn effective_launch(&self) -> Launch {
        let mut launch = self.launch();
        if launch.root.is_none() {
            launch.root = self.pinned.lock().unwrap().clone();
        }
        launch
    }

    /// The current generation, which `connect` reports and the webview sends back with document requests.
    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }

    pub fn launch(&self) -> Launch {
        self.launch.lock().unwrap().clone()
    }

    fn spawn(launch: &Launch) -> Result<Proc, String> {
        if !launch.script.is_file() {
            return Err(format!(
                "Living Memory is not installed at {}. Install it with install.py from the agentic-living-memory repo, or set its script in Settings.",
                launch.script.display()
            ));
        }
        let mut command = Command::new(&launch.program);
        command.args(&launch.args).arg(&launch.script);
        if let Some(root) = &launch.root {
            command.arg("--root").arg(root);
        }
        command
            .args(["serve", "--stdio"])
            .env("PYTHONIOENCODING", "utf-8")
            .env("PYTHONUTF8", "1")
            // The main actor starts the server; each request picks viewer or main.
            .env_remove("LIVING_MEMORY_ACTOR")
            // Living Memory refuses apply, undo and the direct writes (archive, rewrite, remap, promote, taxonomy add, source, project, system, change) when this is set (it marks an agent in a Hivemind terminal); the
            // user's own actions run here, even when Hivemind itself was started from such a terminal.
            .env_remove("HIVEMIND_SESSION")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = command
            .spawn()
            .map_err(|e| format!("Could not start {} {}: {e}", launch.program, launch.script.display()))?;
        let stdin = child.stdin.take().ok_or("no stdin")?;
        let stdout = BufReader::new(child.stdout.take().ok_or("no stdout")?);
        let mut pipe = child.stderr.take().ok_or("no stderr")?;
        let stderr = Arc::new(Mutex::new(Vec::new()));
        let sink = stderr.clone();
        let drain = std::thread::spawn(move || {
            let mut chunk = [0u8; 4096];
            while let Ok(n @ 1..) = pipe.read(&mut chunk) {
                let mut tail = sink.lock().unwrap();
                tail.extend_from_slice(&chunk[..n]);
                let over = tail.len().saturating_sub(STDERR_TAIL);
                tail.drain(..over);
            }
        });
        Ok(Proc { child, stdin, stdout, next: 1, stderr, drain })
    }

    fn exchange(proc: &mut Proc, argv: &[String], stdin: Option<&str>) -> Result<Reply, String> {
        let id = proc.next;
        proc.next += 1;
        let mut request = json!({ "id": id, "argv": argv });
        if let Some(text) = stdin {
            request["stdin"] = Value::String(text.to_string());
        }
        let mut line = serde_json::to_string(&request).map_err(|e| e.to_string())?;
        line.push('\n');
        if let Err(e) = proc.stdin.write_all(line.as_bytes()).and_then(|_| proc.stdin.flush()) {
            return Err(proc.stopped(&format!("Living Memory stopped: {e}"), ""));
        }
        let mut answer = String::new();
        let read = match proc.stdout.read_line(&mut answer) {
            Ok(read) => read,
            Err(e) => return Err(proc.stopped(&format!("Living Memory stopped: {e}"), "")),
        };
        if read == 0 {
            return Err(proc.stopped("Living Memory exited", ". If it is older than the app bridge, update it (needs `serve --stdio`)"));
        }
        let value: Value = serde_json::from_str(&answer).map_err(|e| format!("Unreadable reply from Living Memory: {e}"))?;
        if value.get("id").and_then(Value::as_u64) != Some(id) {
            return Err("Living Memory replied out of order".into());
        }
        serde_json::from_value(value).map_err(|e| e.to_string())
    }

    /// Check a freshly started server speaks a compatible API.
    fn handshake(proc: &mut Proc) -> Result<Value, String> {
        let reply = Self::exchange(proc, &["version".into()], None)?;
        check_version(&reply)?;
        Ok(reply.result)
    }

    /// Run one command. Transport failures drop the process so the next call starts a new one;
    /// a failed request is never retried, because it may already have changed the store.
    pub fn call(&self, argv: &[String], stdin: Option<&str>) -> Result<Reply, String> {
        self.call_at(None, argv, stdin)
    }

    /// `call`, refused when `generation` is given and the bridge has been reconfigured since.
    pub fn call_at(&self, generation: Option<u64>, argv: &[String], stdin: Option<&str>) -> Result<Reply, String> {
        // Measured before the process is touched, so a request that is too large never costs a restart. Its arguments count
        // as much as its stdin (Codex review of 32fee20, B1); JSON escaping at most sextuples a byte, so a request whose
        // raw size is under an eighth of the limit is never measured.
        let raw = argv.iter().map(String::len).sum::<usize>() + stdin.map_or(0, str::len);
        if raw > SERVE_LIMIT / 8 && too_large(argv, stdin) {
            return Err("This request is larger than the 2 MiB Living Memory accepts".into());
        }
        let mut guard = self.proc.lock().unwrap();
        if generation.is_some_and(|g| g != self.generation()) {
            return Err(STORE_CHANGED.into());
        }
        if guard.is_none() {
            let mut proc = Self::spawn(&self.effective_launch())?;
            Self::handshake(&mut proc)?;
            *guard = Some(proc);
        }
        let outcome = Self::exchange(guard.as_mut().unwrap(), argv, stdin);
        if outcome.is_err() {
            *guard = None;
        }
        outcome
    }
}

/// Whether the request line for `argv` and `stdin` would exceed SERVE_LIMIT.
fn too_large(argv: &[String], stdin: Option<&str>) -> bool {
    serde_json::to_string(&json!({ "id": u64::MAX, "argv": argv, "stdin": stdin })).map(|line| line.len() + 1 > SERVE_LIMIT).unwrap_or(true)
}

pub fn check_version(reply: &Reply) -> Result<(), String> {
    if reply.exit_code != 0 {
        return Err(format!("Living Memory `version` failed: {}", reply.error));
    }
    let api = reply.result.get("api").and_then(Value::as_u64).unwrap_or(0);
    let commands: Vec<&str> = reply.result.get("commands").and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
    let missing: Vec<&str> = REQUIRED.iter().copied().filter(|c| !commands.contains(c)).collect();
    if api < MIN_API || !missing.is_empty() {
        return Err(format!("Living Memory is too old for Hivemind (api {api}, needs {MIN_API}; missing: {})", missing.join(", ")));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reply(result: Value) -> Reply {
        Reply { exit_code: 0, result, error: Value::Null }
    }

    /// Codex re-review of 75ce884, R2-D1: a request made for the bridge before Settings pointed it at another store is
    /// refused before any process is picked; one made for the current generation goes on (here to the missing script).
    #[test]
    fn a_request_for_an_earlier_store_is_refused() {
        let launch = |root: &str| Launch { program: "py".into(), args: vec![], script: "no-such-living_memory.py".into(), root: Some(root.into()) };
        let bridge = Bridge::new(launch("a"));
        let before = bridge.generation();
        bridge.reconfigure(launch("b"));
        let argv = ["version".to_string()];
        assert_eq!(bridge.call_at(Some(before), &argv, None).unwrap_err(), STORE_CHANGED);
        assert!(bridge.call_at(Some(bridge.generation()), &argv, None).unwrap_err().contains("not installed"));
        assert!(bridge.call(&argv, None).unwrap_err().contains("not installed"), "an unbound request is not checked");
    }

    /// Codex review of dd4c1b0, R3-D7: the root `connect` verified is used by every process of its generation, unless
    /// Settings name one; a reconfigure drops it, and a pin for an earlier generation is ignored.
    #[test]
    fn the_verified_root_is_pinned_for_its_generation() {
        let launch = |root: Option<&str>| Launch { program: "py".into(), args: vec![], script: "x.py".into(), root: root.map(PathBuf::from) };
        let bridge = Bridge::new(launch(None));
        let g = bridge.generation();
        bridge.pin_root(g, PathBuf::from("C:/stores/a"));
        assert_eq!(bridge.effective_launch().root, Some(PathBuf::from("C:/stores/a")));
        bridge.reconfigure(launch(None));
        assert_eq!(bridge.effective_launch().root, None);
        bridge.pin_root(g, PathBuf::from("C:/stores/a"));
        assert_eq!(bridge.effective_launch().root, None, "a pin for an earlier generation");
        bridge.reconfigure(launch(Some("C:/stores/b")));
        bridge.pin_root(bridge.generation(), PathBuf::from("C:/stores/a"));
        assert_eq!(bridge.effective_launch().root, Some(PathBuf::from("C:/stores/b")), "Settings name the root");
    }

    #[test]
    fn version_check_accepts_current_api() {
        let ok = reply(json!({"api": 1, "commands": ["serve", "list", "domains", "version", "read"]}));
        assert!(check_version(&ok).is_ok());
    }

    fn python() -> Option<(String, Vec<String>)> {
        let (program, args) = match std::env::var("HIVEMIND_TEST_PYTHON") {
            Ok(p) => (p, vec![]),
            Err(_) if cfg!(windows) => ("py".to_string(), vec!["-3".to_string()]),
            Err(_) => ("python3".to_string(), vec![]),
        };
        let works = Command::new(&program).args(&args).arg("--version").output().is_ok_and(|o| o.status.success());
        works.then_some((program, args))
    }

    #[test]
    fn a_missing_script_says_living_memory_is_not_installed() {   // REG-6
        let script = std::env::temp_dir().join("hivemind-no-such-dir").join("living_memory.py");
        let bridge = Bridge::new(Launch { program: "py".into(), args: vec![], script: script.clone(), root: None });
        let error = bridge.call(&["list".into()], None).unwrap_err();
        assert!(error.starts_with(&format!("Living Memory is not installed at {}", script.display())), "{error}");
    }

    /// NS-2C: a request line longer than Living Memory reads is refused before any process starts, so it never
    /// costs a restart (the script here does not even exist).
    #[test]
    fn a_request_over_the_serve_limit_is_refused_before_it_is_sent() {
        let script = std::env::temp_dir().join("hivemind-no-such-dir").join("living_memory.py");
        let bridge = Bridge::new(Launch { program: "py".into(), args: vec![], script, root: None });
        let error = bridge.call(&["doc".into(), "write".into()], Some(&"a".repeat(SERVE_LIMIT))).unwrap_err();
        assert!(error.contains("larger than the 2 MiB"), "{error}");
        // Escaping counts: a body of control characters is six times longer on the line.
        let error = bridge.call(&["doc".into()], Some(&"\u{1}".repeat(SERVE_LIMIT / 6 + 1))).unwrap_err();
        assert!(error.contains("larger than the 2 MiB"), "{error}");
        // Arguments count too, with or without stdin (Codex review of 32fee20, B1).
        let error = bridge.call(&["capture".into(), "--summary".into(), "a".repeat(SERVE_LIMIT)], None).unwrap_err();
        assert!(error.contains("larger than the 2 MiB"), "{error}");
        let error = bridge.call(&["doc".into(), "a".repeat(SERVE_LIMIT / 2)], Some(&"\u{1}".repeat(SERVE_LIMIT / 8))).unwrap_err();
        assert!(error.contains("larger than the 2 MiB"), "{error}");
        // A smaller request goes on to start the process.
        let error = bridge.call(&["doc".into()], Some(&"a".repeat(SERVE_LIMIT / 2))).unwrap_err();
        assert!(error.starts_with("Living Memory is not installed"), "{error}");
    }

    #[test]
    fn a_script_that_fails_shows_its_stderr() {   // REG-6
        let Some((program, args)) = python() else { return };
        let dir = std::env::temp_dir().join(format!("hivemind-bridge-fail-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("living_memory.py");
        std::fs::write(&script, "import sys\nsys.stderr.write('x' * 9000)\nraise SystemExit('boom: no module named core')\n").unwrap();
        let bridge = Bridge::new(Launch { program, args, script, root: None });
        let error = bridge.call(&["list".into()], None).unwrap_err();
        assert!(error.starts_with("Living Memory exited (") && error.contains("1). Its last error output:\n"), "{error}");
        assert!(error.ends_with("boom: no module named core"), "{error}");
        assert!(!error.contains("update it"), "{error}");
        assert!(error.len() <= 100 + STDERR_TAIL, "only the tail is kept");
        drop(bridge);
        std::fs::remove_dir_all(dir).ok();
    }

    /// End to end against a real Living Memory in a temporary store. Runs only when
    /// HIVEMIND_TEST_LM_SCRIPT points at a living_memory.py with `serve` (optionally HIVEMIND_TEST_PYTHON).
    #[test]
    fn live_round_trip_through_serve() {
        let Ok(script) = std::env::var("HIVEMIND_TEST_LM_SCRIPT") else { return };
        let base = std::env::temp_dir().join(format!("hivemind-bridge-{}", std::process::id()));
        let (store, project) = (base.join("store"), base.join("project"));
        std::fs::create_dir_all(&project).unwrap();
        std::fs::create_dir_all(&store).unwrap(); // `serve` needs an existing store: a folder with bindings.json
        std::fs::write(store.join("bindings.json"), "{}").unwrap();
        let (program, args) = match std::env::var("HIVEMIND_TEST_PYTHON") {
            Ok(p) => (p, vec![]),
            Err(_) if cfg!(windows) => ("py".to_string(), vec!["-3".to_string()]),
            Err(_) => ("python3".to_string(), vec![]),
        };
        let bridge = Bridge::new(Launch { program, args, script: script.into(), root: Some(store.clone()) });
        let call = |argv: &[&str], stdin: Option<&str>| bridge.call(&argv.iter().map(|s| s.to_string()).collect::<Vec<_>>(), stdin).unwrap();

        assert_eq!(call(&["bind", "demo", project.to_str().unwrap()], None).exit_code, 0);
        std::fs::write(store.join("tag_taxonomy.json"), r#"{"tags":["subject/project","concern/architecture"]}"#).unwrap();
        let payload = r#"{"title":"Cache","body":"The local cache is rebuildable.","tags":["subject/project","concern/architecture"]}"#;
        let created = call(&["capture", "--domain", "demo"], Some(payload));
        assert_eq!(created.exit_code, 0, "{:?}", created.error);
        let id = created.result["id"].as_str().unwrap().to_string();

        let page = call(&["list", "--domain", "demo", "--actor", "viewer"], None);
        let revision = page.result["notes"][0]["revision"].as_str().unwrap().to_string();
        assert_eq!(page.result["total"], 1);

        let note = call(&["read", &id, "--domain", "demo", "--actor", "viewer"], None);
        assert!(note.result["body"].as_str().unwrap().contains("rebuildable"));
        assert_eq!(call(&["update", &id, "--domain", "demo", "--body", "x", "--actor", "viewer"], None).exit_code, 2);

        let stale = call(&["update", &id, "--domain", "demo", "--body", "Stale.", "--expected-revision", &"0".repeat(64)], None);
        assert_eq!((stale.exit_code, stale.error["code"].as_str()), (6, Some("stale")));
        let saved = call(&["update", &id, "--domain", "demo", "--body", "The cache is rebuilt nightly.", "--expected-revision", &revision], None);
        assert_eq!(saved.exit_code, 0, "{:?}", saved.error);

        let history = call(&["history", "--note", &id, "--actor", "viewer"], None);
        assert_eq!(history.exit_code, 0);
        drop(bridge);
        std::fs::remove_dir_all(base).ok();
    }

    /// The Phase 2 write paths Hivemind uses, end to end (same gating as the test above).
    #[test]
    fn live_phase2_writes_plans_links_and_history() {
        let Ok(script) = std::env::var("HIVEMIND_TEST_LM_SCRIPT") else { return };
        let base = std::env::temp_dir().join(format!("hivemind-bridge2-{}", std::process::id()));
        let (store, project) = (base.join("store"), base.join("project"));
        std::fs::create_dir_all(&project).unwrap();
        std::fs::create_dir_all(&store).unwrap(); // `serve` needs an existing store: a folder with bindings.json
        std::fs::write(store.join("bindings.json"), "{}").unwrap();
        let (program, args) = match std::env::var("HIVEMIND_TEST_PYTHON") {
            Ok(p) => (p, vec![]),
            Err(_) if cfg!(windows) => ("py".to_string(), vec!["-3".to_string()]),
            Err(_) => ("python3".to_string(), vec![]),
        };
        let bridge = Bridge::new(Launch { program, args, script: script.into(), root: Some(store.clone()) });
        let call = |argv: &[&str], stdin: Option<&str>| bridge.call(&argv.iter().map(|s| s.to_string()).collect::<Vec<_>>(), stdin).unwrap();
        let ok = |r: Reply| { assert_eq!(r.exit_code, 0, "{:?}", r.error); r.result };

        ok(call(&["bind", "demo", project.to_str().unwrap()], None));
        std::fs::write(store.join("tag_taxonomy.json"), r#"{"tags":["subject/project","concern/architecture"]}"#).unwrap();
        let tags = r#"["subject/project","concern/architecture"]"#;
        let target = ok(call(&["capture", "--domain", "demo"], Some(&format!(
            r#"{{"title":"Cache","body":"The cache is rebuildable.","tags":{tags},"type":"knowledge","origin":"hivemind:local"}}"#))));
        let plan_note = ok(call(&["capture", "--domain", "demo"], Some(&format!(
            r###"{{"title":"Rollout","body":"## 📌 Executive Summary\nShip it, see [[cache]].\n\n## 🟩 Action Items\n- [x] build\n- [ ] ship","tags":{tags},"type":"plan"}}"###))));
        let (cache, rollout) = (format!("demo:{}", target["id"].as_str().unwrap()), format!("demo:{}", plan_note["id"].as_str().unwrap()));

        let note = ok(call(&["read", &cache, "--actor", "viewer"], None));
        assert_eq!(note["origin"], "hivemind:local");
        // Payload update with only the changed field, guarded by the revision.
        let payload = format!(r#"{{"body":"The cache is rebuilt nightly.","expected_revision":"{}"}}"#, note["revision"].as_str().unwrap());
        let updated = ok(call(&["update", &cache, "--domain", "demo"], Some(&payload)));
        assert_eq!(updated["status"], "update");
        // check --index counts ticked items too: item 2 is "ship".
        let ticked = ok(call(&["check", &rollout, "--index", "2", "--domain", "demo"], None));
        assert_eq!((ticked["item"].as_str(), ticked["open"].as_i64()), (Some("ship"), Some(0)));

        let links = ok(call(&["links", "--domain", "demo", "--actor", "viewer"], None));
        assert_eq!(links["edges"][0]["from"], rollout.as_str());
        assert_eq!(links["edges"][0]["to"], cache.as_str());

        // Archive is a direct write: one journaled step, a receipt and no plan.
        let archived = ok(call(&["archive", &rollout, "--domain", "demo"], None));
        assert!(archived.get("plan_id").is_none(), "{archived}");
        let archive_op = archived["operation_id"].as_str().unwrap().to_string();
        assert_eq!(ok(call(&["read", &rollout, "--actor", "viewer"], None))["status"], "archived");

        let history = ok(call(&["history", "--note", plan_note["id"].as_str().unwrap(), "--actor", "viewer"], None));
        assert_eq!(history[0]["operation_id"], archive_op.as_str());
        let diff = ok(call(&["diff", &archive_op, "--actor", "viewer"], None));
        assert!(!diff.as_array().unwrap().is_empty());
        // Undoing a direct write is direct too.
        let undone = ok(call(&["undo", &archive_op], None));
        assert!(undone.get("plan_id").is_none(), "{undone}");
        assert_eq!(ok(call(&["read", &rollout, "--actor", "viewer"], None))["status"], "active");
        assert_eq!(ok(call(&["validate", "demo"], None))["issues"].as_array().unwrap().len(), 0);
        drop(bridge);
        std::fs::remove_dir_all(base).ok();
    }

    /// Project command centers, end to end (same gating; needs an LM with api 2 and `projects`).
    #[test]
    fn live_projects_write_and_cross_domain_reads() {
        let Ok(script) = std::env::var("HIVEMIND_TEST_LM_SCRIPT") else { return };
        let base = std::env::temp_dir().join(format!("hivemind-bridge3-{}", std::process::id()));
        let (store, demo, other) = (base.join("store"), base.join("demo"), base.join("other"));
        let repo = demo.join("app");
        std::fs::create_dir_all(&repo).unwrap();
        std::fs::create_dir_all(&store).unwrap(); // `serve` needs an existing store: a folder with bindings.json
        std::fs::write(store.join("bindings.json"), "{}").unwrap();
        std::fs::create_dir_all(&other).unwrap();
        let (program, args) = match std::env::var("HIVEMIND_TEST_PYTHON") {
            Ok(p) => (p, vec![]),
            Err(_) if cfg!(windows) => ("py".to_string(), vec!["-3".to_string()]),
            Err(_) => ("python3".to_string(), vec![]),
        };
        let bridge = Bridge::new(Launch { program, args, script: script.into(), root: Some(store.clone()) });
        let call = |argv: &[&str], stdin: Option<&str>| bridge.call(&argv.iter().map(|s| s.to_string()).collect::<Vec<_>>(), stdin).unwrap();
        let ok = |r: Reply| { assert_eq!(r.exit_code, 0, "{:?}", r.error); r.result };

        let version = ok(call(&["version"], None));
        if version["api"].as_i64().unwrap_or(0) < 2 { eprintln!("skipping: LM api < 2"); return; }
        ok(call(&["bind", "demo", demo.to_str().unwrap()], None));
        ok(call(&["bind", "other", other.to_str().unwrap()], None));
        std::fs::write(store.join("tag_taxonomy.json"), r#"{"tags":["subject/project","concern/knowledge","concern/decision"]}"#).unwrap();

        // One direct write: taxonomy tag, registry entry and charter note.
        let create = json!({"slug": "app", "name": "App", "repos": [repo.to_str().unwrap()],
            "charter": {"body": "## 📌 Executive Summary\nBuild the app.\n\n---\n\n## 📝 Key Details\n* **Agent guidance:** run tests first."}});
        let created = ok(call(&["project", "create"], Some(&create.to_string())));
        assert!(created.get("plan_id").is_none(), "{created}");
        assert_eq!(created["kind"], "project_create");
        let listed = ok(call(&["projects", "--actor", "viewer"], None));
        assert_eq!((listed["projects"][0]["slug"].as_str(), listed["projects"][0]["tag_registered"].as_bool()), (Some("app"), Some(true)));
        assert_eq!(call(&["project", "archive", "--actor", "viewer"], Some(r#"{"slug":"app"}"#)).exit_code, 2);

        // A tagged plan in another domain, and an untagged note to triage.
        let rollout = ok(call(&["capture", "--domain", "other"], Some(
            r###"{"title":"Rollout","body":"## 📌 Executive Summary\nShip it.\n\n## 🟩 Action Items\n- [x] build\n- [ ] ship","tags":["subject/project","concern/decision","project/app"],"type":"plan"}"###)));
        let rollout = format!("other:{}", rollout["id"].as_str().unwrap());
        let loose = ok(call(&["capture", "--domain", "demo"], Some(
            r#"{"title":"App cache","body":"The app caches reads.","tags":["subject/project","concern/knowledge"]}"#)));
        let loose = format!("demo:{}", loose["id"].as_str().unwrap());

        let page = ok(call(&["list", "--all-domains", "--status", "any", "--tag", "project/app", "--with-summary", "--actor", "viewer"], None));
        assert_eq!(page["total"], 2);
        let plan_row = page["notes"].as_array().unwrap().iter().find(|n| n["ref"] == rollout.as_str()).unwrap();
        assert_eq!((plan_row["actions"]["open"].as_i64(), plan_row["actions"]["done"].as_i64()), (Some(1), Some(1)));
        assert_eq!(plan_row["summary"], "Ship it.");

        let open = ok(call(&["open", "--all-domains", "--tag", "project/app", "--actor", "viewer"], None));
        assert_eq!((open["domain"].is_null(), open["count"].as_i64()), (true, Some(1)));
        ok(call(&["check", &rollout, "--index", "2"], None));
        assert_eq!(ok(call(&["open", "--all-domains", "--tag", "project/app", "--actor", "viewer"], None))["count"], 0);
        assert_eq!(ok(call(&["review", "--all-domains", "--tag", "project/app", "--actor", "viewer"], None))["domain"], Value::Null);

        // Triage: a tag-only update joins the project without bumping `updated`.
        let before = ok(call(&["read", &loose, "--actor", "viewer"], None));
        let payload = json!({"tags": ["concern/knowledge", "project/app", "subject/project"], "expected_revision": before["revision"]});
        ok(call(&["update", &loose], Some(&payload.to_string())));
        let after = ok(call(&["read", &loose, "--actor", "viewer"], None));
        assert_eq!(after["updated"], before["updated"]);
        assert_eq!(ok(call(&["list", "--all-domains", "--tag", "project/app", "--actor", "viewer"], None))["total"], 3);
        drop(bridge);
        std::fs::remove_dir_all(base).ok();
    }

    #[test]
    fn version_check_names_missing_commands() {
        let old = reply(json!({"api": 1, "commands": ["serve", "version"]}));
        let message = check_version(&old).unwrap_err();
        assert!(message.contains("list") && message.contains("domains"), "{message}");
        assert!(check_version(&reply(json!({"commands": REQUIRED}))).is_err());
    }
}
