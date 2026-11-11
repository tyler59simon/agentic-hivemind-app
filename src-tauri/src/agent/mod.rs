//! Coding-agent sessions: a CLI run as a background child process whose output is logged,
//! normalised into events for the UI, and kept as history. The unit is a session, so follow-up
//! prompts and several sessions at once can be added without changing the shape.
pub mod claude;
pub mod events;
pub mod scope;
pub mod store;

use crate::bridge::Bridge;
use crate::settings::Settings;
use crate::worktree::{Totals, Worktree};
use events::{Mode, Outcome, RunEvent, SeqEvent, Status};
use scope::{AgentTask, PolicyMode, Scope, Spec};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdout, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use store::Record;

/// How many sessions may run at once. A limit the manager enforces, not a property of its data.
pub const MAX_RUNNING: usize = 1;
const NO_PLUGIN: &str = "The Architecture Suite plugin is not loaded in Claude Code; install it or set its folder in Settings.";
const STDERR_LINES: usize = 5;
const TITLE: usize = 60;

/// One coding-agent CLI: how to start it and how to read what it prints.
pub trait Adapter: Send + Sync {
    fn name(&self) -> &'static str;
    /// Program, arguments and working directory; the manager sets up the pipes.
    fn command(&self, spec: &Spec) -> Command;
    /// The line that carries a prompt on stdin (without the newline).
    fn first_message(&self, prompt: &str) -> String;
    /// The events in one stdout line. Unknown and malformed lines give none; never `Finished`.
    fn parse_line(&self, line: &str) -> Vec<RunEvent>;
    /// The CLI's closing report, when the line is one.
    fn outcome(&self, line: &str) -> Option<Outcome>;
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: String,
    pub adapter: String,
    pub cli_version: Option<String>,
    pub task: AgentTask,
    pub title: String,
    /// The folders the session may work in; the first is its working directory.
    pub workspace: Vec<String>,
    pub status: Status,
    pub started_at: u64,
    pub ended_at: Option<u64>,
    pub cost_usd: Option<f64>,
    pub error: Option<String>,
    pub structured: Option<Value>,
    // README 7.1, Phase 2
    #[serde(default)]
    pub mode: Mode,
    #[serde(default)]
    pub policy: PolicyMode,
    #[serde(default)]
    pub project: Option<String>,
    #[serde(default)]
    pub worktree: Option<Worktree>,
    #[serde(default)]
    pub turns: u64,
    #[serde(default)]
    pub files_changed: Option<Totals>,
    // Added by the Phase 2 document
    /// Note refs included in the briefing or added later with a message.
    #[serde(default)]
    pub context: Vec<String>,
    /// The model alias the session was started with.
    #[serde(default)]
    pub model: Option<String>,
    /// The system whose architecture line was in the briefing (a slug, for display only).
    #[serde(default)]
    pub system: Option<String>,
}

#[derive(Serialize, Debug)]
pub struct SessionLog {
    pub info: SessionInfo,
    pub events: Vec<SeqEvent>,
}

/// What the manager tells the UI.
#[derive(Clone, Debug)]
pub enum Emit {
    Event(SeqEvent),
    SessionsChanged,
}

pub type Sink = Arc<dyn Fn(Emit) + Send + Sync>;

/// Why a session's process was killed.
#[derive(Clone, Debug, PartialEq)]
pub enum Stop {
    Cancelled,
    Failed(String),
}

struct Live {
    child: Arc<Mutex<Child>>,
    stop: Option<Stop>,
}

struct Session {
    info: SessionInfo,
    /// The process, while there is one.
    live: Option<Live>,
}

struct Inner {
    dir: PathBuf,
    adapter: Arc<dyn Adapter>,
    sink: Sink,
    sessions: Mutex<HashMap<String, Session>>,
}

#[derive(Clone)]
pub struct Manager {
    inner: Arc<Inner>,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

/// The one `finished` event of a session, from why it was stopped (if it was), the last closing
/// report the CLI printed (if any) and how the process ended.
pub fn finished(stop: Option<Stop>, last: Option<Outcome>, denied: u64, exit_code: Option<i32>, stderr: &str) -> RunEvent {
    let reported = last.is_some();
    let last = last.unwrap_or_default();
    let (status, reason) = match stop {
        Some(Stop::Cancelled) => (Status::Cancelled, None),
        Some(Stop::Failed(reason)) => (Status::Failed, Some(reason)),
        None if last.ok => (Status::Succeeded, None),
        None if reported => (Status::Failed, last.reason),
        None => {
            let code = exit_code.map_or("no exit code".to_string(), |code| format!("exit code {code}"));
            let lines: Vec<&str> = stderr.lines().map(str::trim).filter(|line| !line.is_empty()).collect();
            let tail = lines[lines.len().saturating_sub(STDERR_LINES)..].join("\n");
            let said = if tail.is_empty() { String::new() } else { format!(":\n{tail}") };
            (Status::Failed, Some(format!("The agent stopped without reporting a result ({code}){said}")))
        }
    };
    RunEvent::Finished {
        status,
        reason,
        cost_usd: last.cost_usd,
        duration_ms: last.duration_ms,
        turns: last.turns,
        result: last.result,
        structured: last.structured,
        denials: if reported { last.denials } else { denied },
    }
}

fn kill(child: &Mutex<Child>) {
    let mut child = child.lock().unwrap();
    if cfg!(windows) {
        // The CLI has child processes of its own (cmd.exe, conhost.exe); /T takes the whole tree.
        let mut command = Command::new("taskkill");
        command.args(["/PID", &child.id().to_string(), "/T", "/F"]);
        let _ = crate::git::run_with_timeout(command, Duration::from_secs(10));
    }
    let _ = child.kill();
}

/// Wait for the process without holding its lock, so a cancel can still reach it.
fn exit_code(child: &Mutex<Child>) -> Option<i32> {
    loop {
        match child.lock().unwrap().try_wait() {
            Ok(Some(status)) => return status.code(),
            Ok(None) => {}
            Err(_) => return None,
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

impl Manager {
    /// Load the history from `dir`. Sessions left running by a previous run are closed as failed.
    pub fn new(dir: PathBuf, adapter: Arc<dyn Adapter>, sink: Sink) -> Manager {
        let sessions = store::recover(&dir, now_ms()).into_iter().map(|info| (info.id.clone(), Session { info, live: None })).collect();
        Manager { inner: Arc::new(Inner { dir, adapter, sink, sessions: Mutex::new(sessions) }) }
    }

    /// Start a session in `scope` and send it `prompt`. Returns as soon as the process is running.
    pub fn start(&self, task: AgentTask, scope: Scope, program: String, budget_usd: f64, prompt: &str) -> Result<SessionInfo, String> {
        let inner = &self.inner;
        let id = uuid::Uuid::new_v4().to_string();
        let workspace = std::iter::once(&scope.cwd).chain(&scope.add_dirs).map(|dir| dir.display().to_string()).collect();
        let spec = Spec {
            session_id: id.clone(),
            cwd: scope.cwd,
            add_dirs: scope.add_dirs,
            policy: scope.policy.clone(),
            plugin_dirs: scope.plugin_dirs,
            budget_usd,
            schema: scope.schema,
            program,
            resume: false,
            model: None,
            deny: scope.deny.clone(),
            memory_root: None,
        };
        let mut command = inner.adapter.command(&spec);
        command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        let info = SessionInfo {
            id: id.clone(),
            adapter: inner.adapter.name().to_string(),
            cli_version: None,
            task,
            title: scope.title,
            workspace,
            status: Status::Running,
            started_at: now_ms(),
            ended_at: None,
            cost_usd: None,
            error: None,
            structured: None,
            mode: scope.mode,
            policy: scope.policy.mode(),
            project: None,
            worktree: scope.worktree.clone(),
            turns: 0,
            files_changed: None,
            context: vec![],
            model: None,
            system: None,
        };

        // Without its folder a session could not be logged or replayed, so find that out first.
        std::fs::create_dir_all(&inner.dir).map_err(|e| format!("Could not create {}: {e}", inner.dir.display()))?;
        let mut sessions = inner.sessions.lock().unwrap();
        if sessions.values().filter(|session| session.live.is_some()).count() >= MAX_RUNNING {
            return Err("Another agent session is already running".into());
        }
        let mut child = command.spawn().map_err(|e| format!("Could not start {}: {e}", spec.program))?;
        let (stdin, stdout) = (child.stdin.take(), child.stdout.take());
        let stderr = crate::git::drain(child.stderr.take());
        let child = Arc::new(Mutex::new(child));
        sessions.insert(id.clone(), Session { info: info.clone(), live: Some(Live { child: child.clone(), stop: None }) });
        let _ = inner.persist(&mut sessions);
        drop(sessions);
        (inner.sink)(Emit::SessionsChanged);

        let (pump, required) = (inner.clone(), scope.required_plugin);
        std::thread::spawn(move || pump.pump(&id, stdout, stderr, &child, required.as_deref()));
        if let Some(mut stdin) = stdin {
            // A CLI that has already died shows up as a failed session, not as an error here.
            let _ = stdin.write_all(format!("{}\n", inner.adapter.first_message(prompt)).as_bytes());
            // Closing stdin is what makes this a one-prompt session: the CLI exits when the work
            // is done. Follow-up prompts need this handle kept open instead.
            drop(stdin);
        }
        Ok(info)
    }

    /// Stop a running session. Its `finished` event follows when the process has gone.
    pub fn cancel(&self, id: &str) -> Result<(), String> {
        store::log_path(&self.inner.dir, id)?;
        let child = {
            let mut sessions = self.inner.sessions.lock().unwrap();
            let session = sessions.get_mut(id).ok_or("Unknown session")?;
            // Cancelling a session that has already ended is not an error: there is nothing to do.
            let Some(live) = &mut session.live else { return Ok(()) };
            live.stop.get_or_insert(Stop::Cancelled);
            live.child.clone()
        };
        kill(&child);
        Ok(())
    }

    /// Kill every running session's process, for when the app closes: nothing would be watching an
    /// unattended agent any more. Each is closed as failed on the next start.
    pub fn stop_all(&self) {
        let running: Vec<_> =
            self.inner.sessions.lock().unwrap().values().filter_map(|session| session.live.as_ref().map(|live| live.child.clone())).collect();
        for child in running {
            kill(&child);
        }
    }

    /// Every session, newest first.
    pub fn sessions(&self) -> Vec<SessionInfo> {
        let mut all: Vec<SessionInfo> = self.inner.sessions.lock().unwrap().values().map(|session| session.info.clone()).collect();
        store::newest_first(&mut all);
        all
    }

    /// One session and its events from `from_seq` on, rebuilt from the log. The numbering is the
    /// live one, so a UI can load this and then keep applying live events by `seq`.
    pub fn session(&self, id: &str, from_seq: u64) -> Result<SessionLog, String> {
        let inner = &self.inner;
        // The lock is held across the read so the details and the log agree on whether it has finished.
        let sessions = inner.sessions.lock().unwrap();
        let info = sessions.get(id).map(|session| session.info.clone()).ok_or("Unknown session")?;
        let records = store::read_log(&inner.dir, id)?;
        drop(sessions);
        let events = records
            .into_iter()
            .flat_map(|record| match record {
                Record::Raw { at, raw } => inner.adapter.parse_line(&raw).into_iter().map(|event| (at, event)).collect(),
                Record::Event { at, event } => vec![(at, event)],
            })
            .zip(0u64..)
            .filter(|(_, seq)| *seq >= from_seq)
            .map(|((at, event), seq)| SeqEvent { session_id: id.to_string(), seq, at, event })
            .collect();
        Ok(SessionLog { info, events })
    }
}

impl Inner {
    /// Write the index, dropping the oldest sessions beyond the store's limit.
    fn persist(&self, sessions: &mut HashMap<String, Session>) -> Result<(), String> {
        let mut infos: Vec<SessionInfo> = sessions.values().map(|session| session.info.clone()).collect();
        for id in store::prune(&self.dir, &mut infos) {
            sessions.remove(&id);
        }
        store::save_index(&self.dir, &infos)
    }

    /// Change a session's listed details and tell the UI.
    fn update(&self, id: &str, change: impl FnOnce(&mut SessionInfo)) {
        let mut sessions = self.sessions.lock().unwrap();
        if let Some(session) = sessions.get_mut(id) {
            change(&mut session.info);
        }
        let _ = self.persist(&mut sessions);
        drop(sessions);
        (self.sink)(Emit::SessionsChanged);
    }

    /// The session's reader thread: log each stdout line, then report its events; when stdout
    /// closes, wait for the process and finish the session.
    fn pump(&self, id: &str, stdout: Option<ChildStdout>, stderr: JoinHandle<String>, child: &Mutex<Child>, required_plugin: Option<&str>) {
        let (mut seq, mut denied, mut last) = (0u64, 0u64, None);
        let mut emit = |at: u64, event: RunEvent| {
            (self.sink)(Emit::Event(SeqEvent { session_id: id.to_string(), seq, at, event }));
            seq += 1;
        };
        for bytes in stdout.into_iter().flat_map(|out| BufReader::new(out).split(b'\n')) {
            let Ok(bytes) = bytes else { break };
            let text = String::from_utf8_lossy(&bytes);
            let line = text.trim_end_matches('\r');
            if line.is_empty() {
                continue;
            }
            // Log first: replay parses the same lines in the same order, so it numbers events the same way.
            let at = now_ms();
            let _ = store::append(&self.dir, id, &Record::Raw { at, raw: line.to_string() });
            if let Some(outcome) = self.adapter.outcome(line) {
                self.update(id, |info| info.cost_usd = outcome.cost_usd.or(info.cost_usd));
                last = Some(outcome);
            }
            for event in self.adapter.parse_line(line) {
                match &event {
                    RunEvent::Started { cli_version, plugins, .. } => {
                        self.update(id, |info| info.cli_version = cli_version.clone());
                        if required_plugin.is_some_and(|name| !plugins.iter().any(|plugin| plugin == name)) {
                            self.stop(id, Stop::Failed(NO_PLUGIN.into()));
                            kill(child);
                        }
                    }
                    RunEvent::Denied { .. } => denied += 1,
                    _ => {}
                }
                emit(at, event);
            }
        }
        let code = exit_code(child);
        let stderr = stderr.join().unwrap_or_default();

        let mut sessions = self.sessions.lock().unwrap();
        let stop = sessions.get_mut(id).and_then(|session| session.live.take()).and_then(|live| live.stop);
        let (at, event) = (now_ms(), finished(stop, last, denied, code, &stderr));
        let _ = store::append(&self.dir, id, &Record::Event { at, event: event.clone() });
        if let (Some(session), RunEvent::Finished { status, reason, cost_usd, structured, .. }) = (sessions.get_mut(id), &event) {
            let info = &mut session.info;
            info.status = *status;
            info.ended_at = Some(at);
            info.cost_usd = cost_usd.or(info.cost_usd);
            info.error = reason.clone();
            info.structured = structured.clone();
        }
        let _ = self.persist(&mut sessions);
        drop(sessions);
        emit(at, event);
        (self.sink)(Emit::SessionsChanged);
    }

    /// Record why a session is being killed; the first reason given stands.
    fn stop(&self, id: &str, stop: Stop) {
        if let Some(live) = self.sessions.lock().unwrap().get_mut(id).and_then(|session| session.live.as_mut()) {
            live.stop.get_or_insert(stop);
        }
    }
}

/// Work out what `task` may touch (from Living Memory and the settings), then start its session.
pub fn start_task(manager: &Manager, bridge: &Bridge, saved: &Settings, task: AgentTask, prompt: &str) -> Result<SessionInfo, String> {
    let home = dirs::home_dir().ok_or("Could not find your home folder")?;
    let program = claude::available(saved)?;
    let scope = scope::for_task(bridge, &task, saved, &home)?;
    manager.start(task, scope, program, saved.agent_budget_usd(), prompt)
}

#[cfg(test)]
mod tests {
    use super::*;
    use claude::ClaudeCode;
    use scope::Policy;
    use serde_json::json;
    use std::time::Instant;

    const INIT: &str = r#"{"type":"system","subtype":"init","session_id":"00000000-0000-4000-8000-000000000001","model":"claude-test-1","claude_code_version":"2.1.321","plugins":[{"name":"architecture-suite","path":"/plugins/architecture-suite","source":"architecture-suite@local"}]}"#;
    const BARE_INIT: &str = r#"{"type":"system","subtype":"init","model":"claude-test-1","claude_code_version":"2.1.321","plugins":[{"name":"something-else","path":"/plugins/else","source":"else@local"}]}"#;
    const WORK: [&str; 5] = [
        r#"{"type":"system","subtype":"hook_started","hook_name":"SessionStart"}"#,
        r#"{"type":"assistant","parent_tool_use_id":null,"message":{"content":[{"type":"text","text":"Reading the code."},{"type":"tool_use","id":"toolu_01","name":"Read","input":{"file_path":"/work/app/main.py"}}]}}"#,
        r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_01","content":"print('hi') # 100% <ok> | done"}]}}"#,
        "this line is not JSON",
        r#"{"type":"system","subtype":"permission_denied","tool_name":"Bash","tool_use_id":"toolu_02","message":"Permission to use Bash has been denied."}"#,
    ];
    const EARLY_RESULT: &str =
        r#"{"type":"result","subtype":"error_during_execution","is_error":true,"num_turns":1,"total_cost_usd":0.01}"#;
    const RESULT: &str = r#"{"type":"result","subtype":"success","is_error":false,"num_turns":3,"duration_ms":4670,"total_cost_usd":0.02,"result":"Done.","structured_output":{"summary":"Billing takes payments."},"permission_denials":[{"tool_name":"Bash","tool_use_id":"toolu_02","tool_input":{}}]}"#;

    /// Reads Claude Code's output format, but runs a harmless local program instead of the CLI.
    struct Fake {
        program: &'static str,
        args: Vec<String>,
    }

    impl Adapter for Fake {
        fn name(&self) -> &'static str {
            "fake"
        }
        fn command(&self, spec: &Spec) -> Command {
            let mut command = Command::new(self.program);
            command.args(&self.args).current_dir(&spec.cwd);
            command
        }
        fn first_message(&self, prompt: &str) -> String {
            ClaudeCode.first_message(prompt)
        }
        fn parse_line(&self, line: &str) -> Vec<RunEvent> {
            ClaudeCode.parse_line(line)
        }
        fn outcome(&self, line: &str) -> Option<Outcome> {
            ClaudeCode.outcome(line)
        }
    }

    struct Rig {
        dir: PathBuf,
        manager: Manager,
        seen: Arc<Mutex<Vec<Emit>>>,
    }

    impl Rig {
        fn new(name: &str, adapter: Fake) -> Rig {
            let dir = Rig::folder(name);
            std::fs::create_dir_all(&dir).unwrap();
            let seen: Arc<Mutex<Vec<Emit>>> = Arc::default();
            let sink = seen.clone();
            let manager = Manager::new(dir.join("sessions"), Arc::new(adapter), Arc::new(move |emit| sink.lock().unwrap().push(emit)));
            Rig { dir, manager, seen }
        }

        fn folder(name: &str) -> PathBuf {
            std::env::temp_dir().join(format!("hivemind-agent-{name}-{}", std::process::id()))
        }

        /// Sessions print the lines of `output.jsonl` in the rig's folder and exit.
        fn printing(name: &str, lines: &[&str]) -> Rig {
            let file = Rig::folder(name).join("output.jsonl").display().to_string();
            let adapter = if cfg!(windows) {
                Fake { program: "cmd", args: vec!["/C".into(), "type".into(), file] }
            } else {
                Fake { program: "cat", args: vec![file] }
            };
            let rig = Rig::new(name, adapter);
            std::fs::write(rig.dir.join("output.jsonl"), lines.join("\n") + "\n").unwrap();
            rig
        }

        /// Sessions run for half a minute unless stopped.
        fn lingering(name: &str) -> Rig {
            let args = if cfg!(windows) { vec!["-n", "30", "127.0.0.1"] } else { vec!["30"] };
            Rig::new(
                name,
                Fake { program: if cfg!(windows) { "ping" } else { "sleep" }, args: args.into_iter().map(String::from).collect() },
            )
        }

        fn start(&self, required_plugin: Option<&str>) -> Result<SessionInfo, String> {
            let scope = Scope {
                title: "System passport: Billing".into(),
                cwd: self.dir.clone(),
                add_dirs: vec![self.dir.join("arch")],
                policy: Policy::PreApproved { allow: vec![] },
                schema: None,
                plugin_dirs: vec![],
                required_plugin: required_plugin.map(str::to_string),
                mode: Mode::Unattended,
                worktree: None,
                deny: scope::governed_rules(),
            };
            self.manager.start(AgentTask::SystemPassport { slug: "billing".into() }, scope, "unused".into(), 5.0, "Describe the system.")
        }

        fn events(&self, id: &str) -> Vec<SeqEvent> {
            let seen = self.seen.lock().unwrap();
            seen.iter()
                .filter_map(|emit| if let Emit::Event(event) = emit { Some(event) } else { None })
                .filter(|event| event.session_id == id)
                .cloned()
                .collect()
        }

        /// Wait for the session's `finished` event and return everything it emitted.
        fn finish(&self, id: &str) -> Vec<SeqEvent> {
            let start = Instant::now();
            loop {
                let events = self.events(id);
                if matches!(events.last(), Some(SeqEvent { event: RunEvent::Finished { .. }, .. })) {
                    return events;
                }
                assert!(start.elapsed() < Duration::from_secs(20), "the session did not finish: {events:?}");
                std::thread::sleep(Duration::from_millis(20));
            }
        }

        fn info(&self, id: &str) -> SessionInfo {
            self.manager.sessions().into_iter().find(|info| info.id == id).unwrap()
        }
    }

    impl Drop for Rig {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.dir).ok();
        }
    }

    fn last_outcome(lines: &[&str]) -> Option<Outcome> {
        lines.iter().filter_map(|line| ClaudeCode.outcome(line)).next_back()
    }

    fn status_and_reason(event: &RunEvent) -> (Status, Option<&str>) {
        match event {
            RunEvent::Finished { status, reason, .. } => (*status, reason.as_deref()),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn finished_follows_the_last_result() {
        let done = finished(None, last_outcome(&[EARLY_RESULT, RESULT]), 4, Some(0), "");
        assert_eq!(
            done,
            RunEvent::Finished {
                status: Status::Succeeded,
                reason: None,
                cost_usd: Some(0.02),
                duration_ms: Some(4670),
                turns: Some(3),
                result: Some("Done.".into()),
                structured: Some(json!({"summary": "Billing takes payments."})),
                denials: 1,
            }
        );
        let failed_last = finished(None, last_outcome(&[RESULT, EARLY_RESULT]), 0, Some(0), "");
        assert_eq!(status_and_reason(&failed_last), (Status::Failed, Some("Claude Code hit an error while working")));
        let over = r#"{"type":"result","subtype":"error_max_budget_usd","is_error":false,"total_cost_usd":5.02}"#;
        let over = finished(None, last_outcome(&[over]), 0, Some(0), "");
        assert_eq!(status_and_reason(&over), (Status::Failed, Some("Claude Code reached the budget limit for this session")));
        assert!(matches!(over, RunEvent::Finished { cost_usd: Some(usd), .. } if usd == 5.02));
    }

    #[test]
    fn finished_without_a_result_reports_the_exit_and_stderr() {
        let stderr = "one\ntwo\n\nthree\nfour\nfive\nsix\n  Error: not logged in  \n";
        let event = finished(None, None, 2, Some(1), stderr);
        let expected = "The agent stopped without reporting a result (exit code 1):\nthree\nfour\nfive\nsix\nError: not logged in";
        assert_eq!(status_and_reason(&event), (Status::Failed, Some(expected)));
        assert!(matches!(event, RunEvent::Finished { denials: 2, cost_usd: None, structured: None, .. }));
        let silent = finished(None, None, 0, None, "");
        assert_eq!(status_and_reason(&silent), (Status::Failed, Some("The agent stopped without reporting a result (no exit code)")));
    }

    #[test]
    fn finished_after_a_stop_says_why() {
        assert_eq!(status_and_reason(&finished(Some(Stop::Cancelled), None, 0, Some(1), "killed")), (Status::Cancelled, None));
        // A result that arrived before the cancel still gives the cost.
        let late = finished(Some(Stop::Cancelled), last_outcome(&[RESULT]), 0, Some(1), "");
        assert!(matches!(late, RunEvent::Finished { status: Status::Cancelled, reason: None, cost_usd: Some(_), .. }));
        let stopped = finished(Some(Stop::Failed(NO_PLUGIN.into())), last_outcome(&[RESULT]), 0, Some(1), "");
        assert_eq!(status_and_reason(&stopped), (Status::Failed, Some(NO_PLUGIN)));
    }

    #[test]
    fn session_runs_to_success_and_replays_exactly() {
        let lines: Vec<&str> = [INIT].into_iter().chain(WORK).chain([EARLY_RESULT, RESULT]).collect();
        let rig = Rig::printing("run", &lines);
        let started = rig.start(Some("architecture-suite")).unwrap();
        assert_eq!((started.status, started.adapter.as_str(), started.ended_at), (Status::Running, "fake", None));
        assert_eq!(started.workspace, vec![rig.dir.display().to_string(), rig.dir.join("arch").display().to_string()]);
        assert!(store::log_path(&rig.dir, &started.id).is_ok(), "the id is a plain UUID");

        let live = rig.finish(&started.id);
        assert!(matches!(rig.seen.lock().unwrap().first(), Some(Emit::SessionsChanged)));
        assert_eq!(live.iter().map(|event| event.seq).collect::<Vec<_>>(), (0..6).collect::<Vec<_>>());
        let kinds: Vec<&RunEvent> = live.iter().map(|event| &event.event).collect();
        assert!(matches!(
            kinds[..],
            [
                RunEvent::Started { .. },
                RunEvent::Text { .. },
                RunEvent::ToolUse { .. },
                RunEvent::ToolResult { ok: true, .. },
                RunEvent::Denied { .. },
                RunEvent::Finished { status: Status::Succeeded, denials: 1, .. }
            ]
        ));

        let info = rig.info(&started.id);
        assert_eq!(
            (info.status, info.cli_version.as_deref(), info.cost_usd, &info.error),
            (Status::Succeeded, Some("2.1.321"), Some(0.02), &None)
        );
        assert_eq!(info.structured, Some(json!({"summary": "Billing takes payments."})));
        assert!(info.ended_at.is_some_and(|ended| ended >= info.started_at));

        let replay = rig.manager.session(&started.id, 0).unwrap();
        assert_eq!(replay.info, info);
        assert_eq!(replay.events, live);
        assert_eq!(rig.manager.session(&started.id, 4).unwrap().events, live[4..]);
        assert!(rig.manager.session(&started.id, 6).unwrap().events.is_empty());
        assert!(rig.manager.session("../index", 0).is_err());
        assert!(rig.manager.session("00000000-0000-4000-8000-000000000009", 0).is_err());
        // The raw lines are kept as printed, and the history survives a restart.
        assert_eq!(store::read_log(&rig.dir.join("sessions"), &started.id).unwrap().len(), lines.len() + 1);
        let reopened = Manager::new(rig.dir.join("sessions"), Arc::new(ClaudeCode), Arc::new(|_| {}));
        assert_eq!(reopened.sessions(), vec![info]);
        assert_eq!(reopened.session(&started.id, 0).unwrap().events, live);
    }

    #[test]
    fn session_without_the_required_plugin_fails() {
        let lines: Vec<&str> = [BARE_INIT].into_iter().chain(WORK).chain([RESULT]).collect();
        let rig = Rig::printing("plugin", &lines);
        let started = rig.start(Some("architecture-suite")).unwrap();
        let live = rig.finish(&started.id);
        assert_eq!(status_and_reason(&live.last().unwrap().event), (Status::Failed, Some(NO_PLUGIN)));
        let info = rig.info(&started.id);
        assert_eq!((info.status, info.error.as_deref()), (Status::Failed, Some(NO_PLUGIN)));
        assert_eq!(rig.manager.session(&started.id, 0).unwrap().events, live);
    }

    #[test]
    fn session_that_dies_without_a_result_fails_with_its_stderr() {
        let rig = Rig::printing("dies", &[]);
        std::fs::remove_file(rig.dir.join("output.jsonl")).unwrap();
        let started = rig.start(None).unwrap();
        let live = rig.finish(&started.id);
        assert_eq!(live.len(), 1);
        let (status, reason) = status_and_reason(&live[0].event);
        let reason = reason.unwrap();
        assert_eq!(status, Status::Failed);
        assert!(reason.contains("exit code 1") && reason.lines().count() > 1, "{reason}");
        assert_eq!(rig.info(&started.id).error.as_deref(), Some(reason));
    }

    #[test]
    fn cancel_stops_a_running_session_and_frees_the_limit() {
        let rig = Rig::lingering("cancel");
        let first = rig.start(None).unwrap();
        assert_eq!(rig.start(None).unwrap_err(), "Another agent session is already running");
        assert_eq!(rig.manager.sessions().len(), 1);

        let start = Instant::now();
        rig.manager.cancel(&first.id).unwrap();
        let live = rig.finish(&first.id);
        assert!(start.elapsed() < Duration::from_secs(10), "{:?}", start.elapsed());
        assert_eq!(status_and_reason(&live.last().unwrap().event), (Status::Cancelled, None));
        let info = rig.info(&first.id);
        assert_eq!((info.status, &info.error, info.ended_at.is_some()), (Status::Cancelled, &None, true));
        // The cancelled session keeps its id and log.
        assert_eq!(rig.manager.session(&first.id, 0).unwrap().events, live);
        rig.manager.cancel(&first.id).unwrap(); // already over: nothing to do
        assert!(rig.manager.cancel("00000000-0000-4000-8000-000000000009").is_err());
        assert!(rig.manager.cancel("../index").is_err());

        let second = rig.start(None).unwrap();
        rig.manager.cancel(&second.id).unwrap();
        rig.finish(&second.id);
        assert_eq!(rig.manager.sessions().iter().map(|info| info.status).collect::<Vec<_>>(), vec![Status::Cancelled; 2]);
    }
}
