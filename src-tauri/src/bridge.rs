//! One long-lived `living_memory.py serve --stdio` process. Requests are sent one at a time:
//! a request line goes out, then exactly one reply line comes back.
//!
//! The process is written to and read on threads of its own, and the caller waits for a reply with a time limit. A reply
//! that does not come in time ends the process (and, on Windows, everything it started), so one stalled server can hold
//! the request lock for at most that limit, and the next call starts a new one (Codex review of 7320d7f, LM-1).
use crate::jobs::Job;
use crate::settings::Launch;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, Weak};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

/// Oldest `serve` API this app speaks (Living Memory's `version` reports it).
pub const MIN_API: u64 = 3;
const REQUIRED: [&str; 4] = ["serve", "search", "domains", "version"];
/// The longest request line Living Memory's `serve` reads (its SERVE_LIMIT); a longer one is never sent (NS-2C, C2).
pub const SERVE_LIMIT: usize = 2 * 1024 * 1024;
/// How much of the server's stderr is kept to explain why it exited.
const STDERR_TAIL: usize = 4096;

/// What a request that gets no reply in time fails with. The process was ended, so trying again starts a new one.
pub const NO_ANSWER: &str = "Living Memory isn't answering, so Hivemind restarted it. Try again.";

/// Commands that read or rewrite a whole store (indexes, merges and retags, backups, imports and exports, the wiki, model
/// work). They get the slow limit; every other command is quick.
const SLOW: [&str; 30] = [
    "rebuild", "doctor", "backup", "restore-backup", "export", "import", "ingest", "ingest-scan", "source-sync", "migrate", "retag", "merge",
    "rebaseline", "semantic", "validate", "maintenance", "wiki", "sync", "overlay-build", "overlay-sync-all", "overlay-teardown",
    "recover", "remap", "promote", "rewrite", "undo", "batch", "ask", "stats", "query",
];

/// How long a request may wait for its reply.
#[derive(Clone, Copy, Debug)]
pub struct Limits {
    /// An ordinary request (a read, a save, a capture).
    pub quick: Duration,
    /// A request that works over the whole store (see `SLOW`).
    pub slow: Duration,
    /// A new server's `version` reply. Short, so a server that starts and stalls cannot hold up the workspace.
    pub start: Duration,
    /// The longest reply line read, in bytes. A reply is a note, a page or a list, far below the default; a server that
    /// sends more is stopped instead of filling memory.
    pub reply: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Limits { quick: Duration::from_secs(30), slow: Duration::from_secs(600), start: Duration::from_secs(10), reply: 64 * 1024 * 1024 }
    }
}

impl Limits {
    fn for_argv(&self, argv: &[String]) -> Duration {
        if argv.first().is_some_and(|command| SLOW.contains(&command.as_str())) { self.slow } else { self.quick }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Reply {
    pub exit_code: i64,
    pub result: Value,
    pub error: Value,
}

/// The server process, reachable from any thread so a stalled one can be ended without the request lock.
struct Handle {
    child: Mutex<Child>,
    /// Ends the whole process tree on Windows (the `py` launcher starts the real Python as a child).
    job: Option<Job>,
}

impl Handle {
    /// End the process and what it started. Never blocks, and can be called at any time.
    fn kill(&self) {
        if let Some(job) = &self.job {
            job.end();
        }
        let _ = self.child.lock().unwrap().kill();
    }
}

/// What the reader thread heard on the server's stdout.
enum Heard {
    Line(Vec<u8>),
    /// The pipe closed (None) or could not be read.
    Closed(Option<std::io::Error>),
    /// A reply line longer than `Limits::reply`. The rest of the stream is not read.
    TooLong,
}

struct Proc {
    handle: Arc<Handle>,
    /// Request lines for the writer thread, which owns stdin: a full pipe stalls that thread, never the caller.
    requests: mpsc::Sender<String>,
    /// Reply lines from the reader thread, which owns stdout.
    replies: mpsc::Receiver<Heard>,
    next: u64,
    /// The bridge generation this process was started for. A process from an earlier generation is never used.
    generation: u64,
    /// The last STDERR_TAIL bytes the server wrote to stderr, read on a thread so a full pipe never blocks it.
    stderr: Arc<Mutex<Vec<u8>>>,
    drain: JoinHandle<()>,
}

/// The log record for a server that stopped: a fixed kind, the exit code when known, and whether stderr had output and how
/// many bytes. Never the output itself: it is the child's text, and the log goes into Copy diagnostics.
fn stop_record(kind: &str, exit: Option<i32>, stderr_bytes: usize) -> String {
    let exit = exit.map_or("unknown".to_string(), |code| code.to_string());
    format!("Living Memory stopped: kind={kind} exit={exit} stderr_bytes={stderr_bytes}")
}

impl Proc {
    /// `error`, plus the exit code and the server's last stderr output once its stderr has closed (waiting up to a second),
    /// and then the exit code once the process has been reaped (up to another second: the pipes close a moment before the
    /// system reports the exit). The output is what it wrote last, which is not always why it stopped. `hint` is added
    /// only when there was no output. `kind` is a fixed word for the log.
    fn stopped(&mut self, kind: &str, error: &str, hint: &str) -> String {
        let deadline = Instant::now() + Duration::from_secs(1);
        while !self.drain.is_finished() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        let mut text = error.to_string();
        let mut exit = None;
        // A server whose stderr is still open has not stopped, so it is asked once and not waited for.
        let reaped = Instant::now() + if self.drain.is_finished() { Duration::from_secs(1) } else { Duration::ZERO };
        loop {
            match self.handle.child.lock().unwrap().try_wait() {
                Ok(Some(status)) => {
                    exit = status.code();
                    text.push_str(&format!(" ({status})"));
                    break;
                }
                Ok(None) if Instant::now() < reaped => {}
                _ => break,
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let tail = String::from_utf8_lossy(&self.stderr.lock().unwrap()).trim().to_string();
        log::error!("{}", stop_record(kind, exit, tail.len()));
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
        self.handle.kill();
        // Reaped, but not waited for without end: the process was told to stop and the caller has other work.
        let until = Instant::now() + Duration::from_secs(2);
        while Instant::now() < until && matches!(self.handle.child.lock().unwrap().try_wait(), Ok(None)) {
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

pub struct Bridge {
    launch: Mutex<Launch>,
    /// Held for one request at a time, and no longer than that request's time limit.
    proc: Mutex<Option<Proc>>,
    /// The process in `proc`, kept apart from its lock so `reconfigure` can end a stuck one without waiting for it.
    running: Mutex<Weak<Handle>>,
    limits: Limits,
    /// Counts reconfigures. `call_at` checks it under the `proc` lock, so a request made for one store never runs in the
    /// next (Codex re-review of 75ce884, R2-D1); a process started for an earlier generation is dropped, not reused.
    generation: AtomicU64,
    /// The store root `connect` verified for this generation. A process started later in the same generation is given it
    /// with `--root`, so a default store that changed meanwhile (Living Memory's setup picked another) is never served
    /// under the old generation (Codex review of dd4c1b0, R3-D7). Cleared by `reconfigure`, which holds this lock while it
    /// changes the launch and the generation, so the three always change together.
    pinned: Mutex<Option<PathBuf>>,
}

/// The error of a request made before the bridge switched stores.
pub const STORE_CHANGED: &str = "Living Memory switched to another store while this request waited, so Hivemind did not send it";

impl Bridge {
    pub fn new(launch: Launch) -> Self {
        Self::with_limits(launch, Limits::default())
    }

    pub fn with_limits(launch: Launch, limits: Limits) -> Self {
        Bridge {
            launch: Mutex::new(launch),
            proc: Mutex::new(None),
            running: Mutex::new(Weak::new()),
            limits,
            generation: AtomicU64::new(0),
            pinned: Mutex::new(None),
        }
    }

    pub fn limits(&self) -> Limits {
        self.limits
    }

    /// Point at a different interpreter/script/store; the next call starts a fresh process. Requests bound to the
    /// earlier generation are refused from now on. It never waits for a request in progress: the old process is ended,
    /// so a request waiting on it fails at once and Settings can always be saved (LM-1).
    pub fn reconfigure(&self, launch: Launch) {
        {
            let mut pinned = self.pinned.lock().unwrap();
            *self.launch.lock().unwrap() = launch;
            *pinned = None;
            self.generation.fetch_add(1, Ordering::SeqCst);
        }
        let old = self.running.lock().unwrap().upgrade();
        if let Some(old) = old {
            old.kill();
        }
    }

    /// Keep `root` as the store of `generation` (when that is still the current one and Settings name no root).
    pub fn pin_root(&self, generation: u64, root: PathBuf) {
        let mut pinned = self.pinned.lock().unwrap();
        if generation == self.generation() && self.launch.lock().unwrap().root.is_none() {
            *pinned = Some(root);
        }
    }

    /// The launch a new process uses: the configured one, with the pinned root when Settings name none.
    fn effective_launch(&self) -> Launch {
        let pinned = self.pinned.lock().unwrap();
        let mut launch = self.launch.lock().unwrap().clone();
        if launch.root.is_none() {
            launch.root = pinned.clone();
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

    fn spawn(launch: &Launch, generation: u64, reply_limit: usize) -> Result<Proc, String> {
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
        crate::jobs::own_group(&mut command);
        let mut child = command
            .spawn()
            .map_err(|e| format!("Could not start {} {}: {e}", launch.program, launch.script.display()))?;
        let job = Job::new().filter(|job| job.add(&child));
        let mut stdin = child.stdin.take().ok_or("no stdin")?;
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
        // A failed write ends this thread; the caller then hears the pipe close, or waits out its limit.
        let (requests, outgoing) = mpsc::channel::<String>();
        std::thread::spawn(move || {
            for line in outgoing {
                if stdin.write_all(line.as_bytes()).and_then(|_| stdin.flush()).is_err() {
                    break;
                }
            }
        });
        let (heard, replies) = mpsc::channel();
        std::thread::spawn(move || read_replies(stdout, heard, reply_limit));
        Ok(Proc { handle: Arc::new(Handle { child: Mutex::new(child), job }), requests, replies, next: 1, generation, stderr, drain })
    }

    fn exchange(proc: &mut Proc, argv: &[String], stdin: Option<&str>, limit: Duration) -> Result<Reply, String> {
        let id = proc.next;
        proc.next += 1;
        let mut request = json!({ "id": id, "argv": argv });
        if let Some(text) = stdin {
            request["stdin"] = Value::String(text.to_string());
        }
        let mut line = serde_json::to_string(&request).map_err(|e| e.to_string())?;
        line.push('\n');
        if proc.requests.send(line).is_err() {
            return Err(proc.stopped("request_not_sent", "Living Memory stopped", ""));
        }
        let answer = match proc.replies.recv_timeout(limit) {
            Ok(Heard::Line(answer)) => answer,
            Ok(Heard::Closed(Some(e))) => return Err(proc.stopped("pipe_error", &format!("Living Memory stopped: {e}"), "")),
            Ok(Heard::Closed(None)) | Err(RecvTimeoutError::Disconnected) => {
                return Err(proc.stopped("exited", "Living Memory exited", ". If it is older than the app bridge, update it (needs `serve --stdio`)"));
            }
            Ok(Heard::TooLong) => {
                log::error!("{}", stop_record("reply_too_large", None, 0));
                proc.handle.kill();
                return Err("Living Memory sent a reply that is too large to read, so Hivemind restarted it. Try again.".into());
            }
            Err(RecvTimeoutError::Timeout) => {
                log::error!("{}", stop_record("no_answer", None, 0));
                proc.handle.kill();
                return Err(NO_ANSWER.into());
            }
        };
        let value: Value = serde_json::from_slice(&answer).map_err(|e| format!("Unreadable reply from Living Memory: {e}"))?;
        if value.get("id").and_then(Value::as_u64) != Some(id) {
            return Err("Living Memory replied out of order".into());
        }
        serde_json::from_value(value).map_err(|e| e.to_string())
    }

    /// Check a freshly started server speaks a compatible API.
    fn handshake(proc: &mut Proc, limit: Duration) -> Result<Value, String> {
        let reply = Self::exchange(proc, &["version".into()], None, limit)?;
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
        self.call_within(generation, argv, stdin, self.limits.for_argv(argv))
    }

    /// `call_at` with its own reply limit, for a caller that knows how long its command may take.
    pub fn call_within(&self, generation: Option<u64>, argv: &[String], stdin: Option<&str>, limit: Duration) -> Result<Reply, String> {
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
        if guard.as_ref().is_some_and(|proc| proc.generation != self.generation()) {
            *guard = None;
        }
        if guard.is_none() {
            let started_in = self.generation();
            let mut proc = Self::spawn(&self.effective_launch(), started_in, self.limits.reply)?;
            *self.running.lock().unwrap() = Arc::downgrade(&proc.handle);
            Self::handshake(&mut proc, self.limits.start)?;
            // Settings were saved while it started, so it may be for the old store: it is not used.
            if started_in != self.generation() {
                return Err(STORE_CHANGED.into());
            }
            *guard = Some(proc);
        }
        let outcome = Self::exchange(guard.as_mut().unwrap(), argv, stdin, limit);
        if outcome.is_err() {
            *guard = None;
        }
        outcome
    }
}

/// Read reply lines from the server's stdout and hand them on, until it closes or sends a line over `limit` bytes.
fn read_replies(mut out: BufReader<ChildStdout>, heard: mpsc::Sender<Heard>, limit: usize) {
    loop {
        let mut line = Vec::new();
        let outcome = loop {
            let chunk = match out.fill_buf() {
                Ok([]) => break Heard::Closed(None),
                Ok(chunk) => chunk,
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(e) => break Heard::Closed(Some(e)),
            };
            let end = chunk.iter().position(|&b| b == b'\n');
            let take = end.map_or(chunk.len(), |at| at + 1);
            if line.len() + take > limit {
                break Heard::TooLong;
            }
            line.extend_from_slice(&chunk[..take]);
            out.consume(take);
            if end.is_some() {
                break Heard::Line(std::mem::take(&mut line));
            }
        };
        let done = !matches!(outcome, Heard::Line(_));
        if heard.send(outcome).is_err() || done {
            return;
        }
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

    #[test]
    fn a_stop_is_logged_as_a_kind_an_exit_status_and_a_byte_count() {
        assert_eq!(stop_record("exited", Some(1), 120), "Living Memory stopped: kind=exited exit=1 stderr_bytes=120");
        assert_eq!(stop_record("no_answer", None, 0), "Living Memory stopped: kind=no_answer exit=unknown stderr_bytes=0");
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
        let ok = reply(json!({"api": 3, "commands": ["serve", "search", "domains", "version", "read"]}));
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
        let error = bridge.call(&["search".into()], None).unwrap_err();
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
        std::fs::write(&script, "import sys\nsys.stderr.write('x' * 9000)\nraise SystemExit('boom: no module named core SECRET-MARKER-1')\n").unwrap();
        crate::diagnostics::capture::install();
        let bridge = Bridge::new(Launch { program, args, script, root: None });
        let error = bridge.call(&["search".into()], None).unwrap_err();
        assert!(error.starts_with("Living Memory exited (") && error.contains("1). Its last error output:\n"), "{error}");
        assert!(error.ends_with("boom: no module named core SECRET-MARKER-1"), "{error}");
        assert!(!error.contains("update it"), "{error}");
        // The error that goes to the screen has the child's text; the log record has only a kind, a status and a count.
        let records = crate::diagnostics::capture::records();
        assert!(records.iter().any(|r| r.contains("Living Memory stopped: kind=exited exit=1 stderr_bytes=")), "{records:?}");
        assert!(records.iter().all(|r| !r.contains("SECRET-MARKER-1") && !r.contains("boom") && !r.contains("xxxx")), "{records:?}");
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

        let page = call(&["search", "--domain", "demo", "--actor", "viewer"], None);
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
        // check --index counts ticked items too: item 2 is "ship". Every write to an existing note carries the revision read.
        let revision_of = |r: &str| ok(call(&["read", r, "--metadata-only", "--actor", "viewer"], None))["revision"].as_str().unwrap().to_string();
        assert_eq!(call(&["check", &rollout, "--index", "2", "--domain", "demo"], None).error["code"], "revision_required");
        let ticked = ok(call(&["check", &rollout, "--index", "2", "--domain", "demo", "--expected-revision", &revision_of(&rollout)], None));
        assert_eq!((ticked["item"].as_str(), ticked["open"].as_i64()), (Some("ship"), Some(0)));

        let links = ok(call(&["search", "--links", "--domain", "demo", "--actor", "viewer"], None));
        assert_eq!(links["edges"][0]["from"], rollout.as_str());
        assert_eq!(links["edges"][0]["to"], cache.as_str());

        // Archive is a direct write: one journaled step, a receipt and no plan.
        let archived = ok(call(&["archive", &rollout, "--domain", "demo", "--expected-revision", &revision_of(&rollout)], None));
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

        let page = ok(call(&["search", "--all-domains", "--status", "any", "--tag", "project/app", "--with-summary", "--actor", "viewer"], None));
        assert_eq!(page["total"], 2);
        let plan_row = page["notes"].as_array().unwrap().iter().find(|n| n["ref"] == rollout.as_str()).unwrap();
        assert_eq!((plan_row["actions"]["open"].as_i64(), plan_row["actions"]["done"].as_i64()), (Some(1), Some(1)));
        assert_eq!(plan_row["summary"], "Ship it.");

        let open = ok(call(&["open", "--all-domains", "--tag", "project/app", "--actor", "viewer"], None));
        assert_eq!((open["domain"].is_null(), open["count"].as_i64()), (true, Some(1)));
        let revision = ok(call(&["read", &rollout, "--metadata-only", "--actor", "viewer"], None))["revision"].as_str().unwrap().to_string();
        ok(call(&["check", &rollout, "--index", "2", "--expected-revision", &revision], None));
        assert_eq!(ok(call(&["open", "--all-domains", "--tag", "project/app", "--actor", "viewer"], None))["count"], 0);
        assert_eq!(ok(call(&["review", "--all-domains", "--tag", "project/app", "--actor", "viewer"], None))["domain"], Value::Null);

        // Triage: a tag-only update joins the project without bumping `updated`.
        let before = ok(call(&["read", &loose, "--actor", "viewer"], None));
        let payload = json!({"tags": ["concern/knowledge", "project/app", "subject/project"], "expected_revision": before["revision"]});
        ok(call(&["update", &loose], Some(&payload.to_string())));
        let after = ok(call(&["read", &loose, "--actor", "viewer"], None));
        assert_eq!(after["updated"], before["updated"]);
        assert_eq!(ok(call(&["search", "--all-domains", "--tag", "project/app", "--actor", "viewer"], None))["total"], 3);
        drop(bridge);
        std::fs::remove_dir_all(base).ok();
    }

    // LM-1: a request that gets no reply in time ends the process and fails; nothing waits for a stalled server.

    /// What a fake server script starts with: a reply helper and the `version` answer Hivemind checks.
    const FAKE: &str = r#"
import sys, json, os, time
here = os.path.dirname(os.path.abspath(__file__))
def reply(id, result):
    sys.stdout.write(json.dumps({"id": id, "exit_code": 0, "result": result, "error": None}) + "\n")
    sys.stdout.flush()
VERSION = {"api": 3, "commands": ["serve", "search", "domains", "version"]}
def mark(name):
    open(os.path.join(here, name), "w").close()
def marked(name):
    return os.path.exists(os.path.join(here, name))
"#;

    /// A folder holding a fake `living_memory.py`: FAKE followed by `body`.
    fn fake(name: &str, body: &str) -> (PathBuf, PathBuf) {
        let dir = std::env::temp_dir().join(format!("hivemind-bridge-{name}-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("living_memory.py");
        std::fs::write(&script, format!("{FAKE}{body}")).unwrap();
        (dir, script)
    }

    /// The server's own process id, from a reply.
    fn pid(bridge: &Bridge, command: &str) -> Result<u32, String> {
        bridge.call(&[command.into()], None).map(|reply| reply.result["pid"].as_u64().unwrap() as u32)
    }

    fn gone(pid: u32) -> bool {
        (0..60).any(|_| {
            let gone = !crate::jobs::alive(pid);
            if !gone {
                std::thread::sleep(Duration::from_millis(100));
            }
            gone
        })
    }

    fn limits(quick_ms: u64, start_ms: u64) -> Limits {
        Limits { quick: Duration::from_millis(quick_ms), slow: Duration::from_millis(quick_ms * 4), start: Duration::from_millis(start_ms), reply: 1000 }
    }

    const ECHO_OR_STALL: &str = r#"
first = not marked("stalled")
for line in sys.stdin:
    req = json.loads(line)
    command = req["argv"][0]
    if command == "version":
        reply(req["id"], VERSION)
    elif command == "stall" and first:
        mark("stalled")
        time.sleep(600)
    elif command == "huge":
        sys.stdout.write("x" * 5000 + "\n")
        sys.stdout.flush()
    else:
        reply(req["id"], {"pid": os.getpid()})
"#;

    /// A reply that never comes fails after the limit with a plain message, the stalled process is gone, and the next
    /// call starts a new one that works.
    #[test]
    fn a_stalled_reply_times_out_and_the_next_call_starts_a_new_process() {
        let Some((program, args)) = python() else { return };
        let (dir, script) = fake("stall", ECHO_OR_STALL);
        let bridge = Bridge::with_limits(Launch { program, args, script, root: None }, limits(1500, 20_000));
        let first = pid(&bridge, "echo").unwrap();
        let began = Instant::now();
        let error = bridge.call(&["stall".into()], None).unwrap_err();
        assert_eq!(error, NO_ANSWER);
        assert!(began.elapsed() >= Duration::from_millis(1500) && began.elapsed() < Duration::from_secs(15), "{:?}", began.elapsed());
        assert!(gone(first), "the stalled server is still running");
        let second = pid(&bridge, "echo").unwrap();
        assert_ne!(first, second);
        // The stall happened once; a new process answers the same command.
        assert_eq!(bridge.call(&["stall".into()], None).unwrap().exit_code, 0);
        drop(bridge);
        std::fs::remove_dir_all(dir).ok();
    }

    /// A slow command gets the slow limit and an ordinary one the quick limit.
    #[test]
    fn a_slow_command_waits_longer_than_a_quick_one() {
        let l = Limits::default();
        let argv = |c: &str| vec![c.to_string()];
        assert_eq!(l.for_argv(&argv("read")), l.quick);
        assert_eq!(l.for_argv(&argv("doc")), l.quick);
        for slow in ["rebuild", "doctor", "wiki", "export", "import", "semantic", "merge", "retag"] {
            assert_eq!(l.for_argv(&argv(slow)), l.slow, "{slow}");
        }
        assert!(l.quick < l.slow && l.start <= l.quick);
    }

    /// A server that starts and never answers `version` fails within the start limit, every time, without keeping a process.
    #[test]
    fn a_stalled_start_times_out() {
        let Some((program, args)) = python() else { return };
        let (dir, script) = fake("start", "mark('started')\ntime.sleep(600)\n");
        let bridge = Bridge::with_limits(Launch { program, args, script, root: None }, limits(30_000, 700));
        for _ in 0..2 {
            let began = Instant::now();
            assert_eq!(bridge.call(&["version".into()], None).unwrap_err(), NO_ANSWER);
            assert!(began.elapsed() < Duration::from_secs(15), "{:?}", began.elapsed());
        }
        drop(bridge);
        std::fs::remove_dir_all(dir).ok();
    }

    /// A server that stops reading while a large request is being written is not waited for either (the write is on its
    /// own thread, and the process is ended so the write ends).
    #[test]
    fn a_stalled_write_times_out() {
        let Some((program, args)) = python() else { return };
        let body = r#"
first = not marked("deaf")
line = sys.stdin.readline()
reply(json.loads(line)["id"], VERSION)
if first:
    mark("deaf")
    time.sleep(600)
for line in sys.stdin:
    reply(json.loads(line)["id"], {"pid": os.getpid()})
"#;
        let (dir, script) = fake("deaf", body);
        let bridge = Bridge::with_limits(Launch { program, args, script, root: None }, limits(1500, 20_000));
        let big = "a".repeat(SERVE_LIMIT / 2);
        let began = Instant::now();
        assert_eq!(bridge.call(&["doc".into(), "write".into()], Some(&big)).unwrap_err(), NO_ANSWER);
        assert!(began.elapsed() < Duration::from_secs(15), "{:?}", began.elapsed());
        assert!(pid(&bridge, "echo").is_ok(), "the next call starts a new process");
        drop(bridge);
        std::fs::remove_dir_all(dir).ok();
    }

    /// A reply line over the limit stops the server instead of filling memory, and the next call works.
    #[test]
    fn a_reply_over_the_size_limit_stops_the_server() {
        let Some((program, args)) = python() else { return };
        let (dir, script) = fake("huge", ECHO_OR_STALL);
        let bridge = Bridge::with_limits(Launch { program, args, script, root: None }, limits(20_000, 20_000));
        let first = pid(&bridge, "echo").unwrap();
        let error = bridge.call(&["huge".into()], None).unwrap_err();
        assert!(error.contains("too large to read"), "{error}");
        assert!(gone(first));
        assert!(pid(&bridge, "echo").is_ok());
        drop(bridge);
        std::fs::remove_dir_all(dir).ok();
    }

    /// Saving Settings must not wait for a request that is stuck: `reconfigure` returns at once, the stuck request
    /// fails, and the next call runs under the new launch.
    #[test]
    fn reconfigure_returns_while_a_request_is_stuck() {
        let Some((program, args)) = python() else { return };
        let (dir, script) = fake("reconf", ECHO_OR_STALL);
        let launch = Launch { program, args, script, root: None };
        // A long limit: only reconfigure can end the stuck request in time.
        let bridge = Arc::new(Bridge::with_limits(launch.clone(), limits(120_000, 20_000)));
        let first = pid(&bridge, "echo").unwrap();
        let stuck = { let bridge = bridge.clone(); std::thread::spawn(move || bridge.call(&["stall".into()], None)) };
        while !dir.join("stalled").exists() {
            std::thread::sleep(Duration::from_millis(20));
        }
        let (done, heard) = mpsc::channel();
        let again = {
            let bridge = bridge.clone();
            let launch = Launch { root: Some(dir.clone()), ..launch.clone() };
            std::thread::spawn(move || { bridge.reconfigure(launch); let _ = done.send(()); })
        };
        assert!(heard.recv_timeout(Duration::from_secs(5)).is_ok(), "reconfigure waited for the stuck request");
        again.join().unwrap();
        let began = Instant::now();
        assert!(stuck.join().unwrap().is_err(), "the stuck request ends when its process does");
        assert!(began.elapsed() < Duration::from_secs(15));
        assert!(gone(first));
        assert_eq!(bridge.generation(), 1);
        assert!(pid(&bridge, "echo").is_ok(), "the next call starts a process under the new launch");
        drop(bridge);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn version_check_names_missing_commands() {
        let old = reply(json!({"api": 3, "commands": ["serve", "version"]}));
        let message = check_version(&old).unwrap_err();
        assert!(message.contains("search") && message.contains("domains"), "{message}");
        let older = reply(json!({"api": 2, "commands": REQUIRED}));
        assert!(check_version(&older).unwrap_err().contains("api 2, needs 3"));
        assert!(check_version(&reply(json!({"commands": REQUIRED}))).is_err());
    }
}
