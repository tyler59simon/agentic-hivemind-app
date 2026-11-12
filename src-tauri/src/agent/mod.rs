//! Coding-agent sessions: a CLI run as a background child process whose output is logged,
//! normalised into events for the UI, and kept as history. The unit is a session: an unattended one is a single
//! prompt, an interactive one takes messages until it is ended, and either may use a process of its own at a time.
pub mod claude;
pub mod events;
pub mod scope;
pub mod store;

use crate::bridge::Bridge;
use crate::settings::Settings;
use crate::worktree::{self, ChangedFiles, FileChange, Totals, Worktree};
use events::{Decision, Mode, Outcome, RunEvent, SeqEvent, Status, TurnEnd};
use scope::{AgentTask, PolicyMode, Scope, Spec};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{Arc, Mutex, TryLockError};
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use store::Record;

/// How many sessions may hold a process that is working or can still take input. A limit the manager enforces, not a
/// property of its data.
pub const MAX_RUNNING: usize = 3;
const END_WAIT: Duration = Duration::from_secs(10); // how long End waits for a clean exit before killing
const DRAIN_WAIT: Duration = Duration::from_secs(10); // how long a resume waits for the old process to go
const STOP_ALL_WAIT: Duration = Duration::from_secs(2); // how long closing the app waits for idle processes to leave
const POLL: Duration = Duration::from_millis(50);
const NO_PLUGIN: &str = "The Architecture Suite plugin is not loaded in Claude Code; install it or set its folder in Settings.";
const LIMIT: &str = "3 agent sessions are already working; wait for one to finish or stop one";
const STOPPED: &str = "The agent process has stopped";
const STDERR_LINES: usize = 5;
const TITLE: usize = 60;

/// One coding-agent CLI: how to start it and how to read what it prints.
pub trait Adapter: Send + Sync {
    fn name(&self) -> &'static str;
    /// Program, arguments and working directory; the manager sets up the pipes.
    fn command(&self, spec: &Spec) -> Command;
    /// The stdin line that carries one user message (without the newline).
    fn user_line(&self, text: &str) -> String;
    /// The events in one stdout line. Unknown and malformed lines give none; never `Finished` or `TurnFinished`.
    fn parse_line(&self, line: &str) -> Vec<RunEvent>;
    /// The CLI's closing report of a turn, when the line is one.
    fn outcome(&self, line: &str) -> Option<Outcome>;
    /// The stdin line that answers the permission request in `request` (a stdout line as printed).
    fn answer_line(&self, request: &str, decision: Decision) -> Option<String>;
    /// The answer to write at once, without asking the user, when `line` asks for something Hivemind always refuses.
    fn refusal(&self, line: &str) -> Option<String>;
    /// The stdin line that stops the running turn.
    fn interrupt_line(&self) -> String;
    /// The stdin line that changes the permission mode of a running CLI.
    fn mode_line(&self, mode: PolicyMode) -> String;
    /// The permission mode the CLI says it is in now, when the line reports one.
    fn mode_of(&self, line: &str) -> Option<PolicyMode>;
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

/// What `agent_start` may be told besides the task and the prompt.
#[derive(Deserialize, Clone, Debug, Default, PartialEq)]
pub struct StartOptions {
    #[serde(default)]
    pub policy: Option<PolicyMode>,
    #[serde(default)]
    pub context: Vec<String>,
    /// Text put before the prompt in the first message.
    #[serde(default)]
    pub briefing: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub system: Option<String>,
}

/// What `agent_send` may be told besides the text.
#[derive(Deserialize, Clone, Debug, Default, PartialEq)]
pub struct SendOptions {
    #[serde(default)]
    pub context: Vec<String>,
    #[serde(default)]
    pub briefing: Option<String>,
}

/// Everything needed to start a process for a session.
pub struct Launch {
    pub scope: Scope,
    pub program: String,
    pub budget_usd: f64,
    /// The store root the app's bridge is connected to (`bridge.launch().root`); becomes `Spec.memory_root`.
    pub memory_root: Option<PathBuf>,
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
    Ended,
}

struct Live {
    child: Arc<Mutex<Child>>,
    /// The CLI's stdin; `None` inside once it has been closed (one-prompt run, end, budget, giving up a slot).
    stdin: Arc<Mutex<Option<ChildStdin>>>,
    stop: Option<Stop>,
    /// Permission requests not yet answered: request id -> the request line as printed.
    pending: HashMap<String, String>,
    /// The user pressed Stop during the current turn.
    interrupted: bool,
    /// When the last turn ended (or the process started), in ms; the longest-idle process gives up its slot first.
    idle_since: u64,
}

/// Where a session's log stands: the next event number, whether `started` has been reported, and the list of the last
/// `filesChanged` event (empty when there was none).
#[derive(Clone, Default)]
struct Tape {
    seq: u64,
    started: bool,
    files: Vec<FileChange>,
}

impl Tape {
    /// Account for one event of the log.
    fn count(&mut self, event: &RunEvent) {
        self.seq += 1;
        if let RunEvent::FilesChanged { files } = event {
            self.files = files.clone();
        }
    }
}

struct Session {
    info: SessionInfo,
    /// The process, while there is one.
    live: Option<Live>,
    /// `None` until first needed for a session loaded from disk; then counted from its log.
    tape: Option<Tape>,
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

/// Whether a session can never take another message.
fn is_over(status: Status) -> bool {
    matches!(status, Status::Succeeded | Status::Failed | Status::Cancelled | Status::Ended)
}

/// The events one log record stands for. `started` is the session's memory across records: a session reports `started`
/// once, though the CLI prints its init line at the start of every turn.
pub fn events_of(adapter: &dyn Adapter, record: &Record, started: &mut bool) -> Vec<RunEvent> {
    match record {
        Record::Event { event, .. } => vec![event.clone()],
        Record::Raw { raw, .. } => adapter
            .parse_line(raw)
            .into_iter()
            .filter(|event| !matches!(event, RunEvent::Started { .. }) || !std::mem::replace(started, true))
            .collect(),
    }
}

/// Write one line to a CLI. Fails when stdin has been closed or the process is gone.
fn write(stdin: &Mutex<Option<ChildStdin>>, line: &str) -> Result<(), String> {
    let mut slot = stdin.lock().unwrap();
    let pipe = slot.as_mut().ok_or(STOPPED)?;
    pipe.write_all(format!("{line}\n").as_bytes()).and_then(|()| pipe.flush()).map_err(|_| STOPPED.to_string())
}

/// Whether a CLI's stdin is still open. A stdin that a writer holds right now counts as open.
fn is_open(stdin: &Mutex<Option<ChildStdin>>) -> bool {
    match stdin.try_lock() {
        Ok(slot) => slot.is_some(),
        Err(TryLockError::Poisoned(poisoned)) => poisoned.into_inner().is_some(),
        Err(TryLockError::WouldBlock) => true,
    }
}

/// The words for a process that ended without printing a closing report.
fn no_result(exit_code: Option<i32>, stderr: &str) -> String {
    let code = exit_code.map_or("no exit code".to_string(), |code| format!("exit code {code}"));
    let lines: Vec<&str> = stderr.lines().map(str::trim).filter(|line| !line.is_empty()).collect();
    let tail = lines[lines.len().saturating_sub(STDERR_LINES)..].join("\n");
    let said = if tail.is_empty() { String::new() } else { format!(":\n{tail}") };
    format!("The agent stopped without reporting a result ({code}){said}")
}

/// The one `finished` event of a session, from why it was stopped (if it was), the last closing
/// report the CLI printed (if any) and how the process ended.
pub fn finished(stop: Option<Stop>, last: Option<Outcome>, denied: u64, exit_code: Option<i32>, stderr: &str) -> RunEvent {
    let reported = last.is_some();
    let last = last.unwrap_or_default();
    let (status, reason) = match stop {
        Some(Stop::Cancelled) => (Status::Cancelled, None),
        Some(Stop::Ended) => (Status::Ended, None),
        Some(Stop::Failed(reason)) => (Status::Failed, Some(reason)),
        None if last.ok => (Status::Succeeded, None),
        None if reported => (Status::Failed, last.reason),
        None => (Status::Failed, Some(no_result(exit_code, stderr))),
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

/// The `finished` event of an interactive session that was stopped: the cost and turn count are the session's own,
/// since the CLI's last report only knows its own process.
fn stopped(stop: Stop, info: &SessionInfo, exit_code: Option<i32>, stderr: &str) -> RunEvent {
    let mut event = finished(Some(stop), None, 0, exit_code, stderr);
    if let RunEvent::Finished { cost_usd, turns, .. } = &mut event {
        (*cost_usd, *turns) = (info.cost_usd, Some(info.turns));
    }
    event
}

/// Let a session's listed details follow its `finished` event.
fn close(info: &mut SessionInfo, at: u64, event: &RunEvent) {
    if let RunEvent::Finished { status, reason, cost_usd, structured, .. } = event {
        info.status = *status;
        info.ended_at = Some(at);
        info.cost_usd = cost_usd.or(info.cost_usd);
        info.error = reason.clone();
        info.structured = structured.clone();
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

/// The text of a message: the briefing goes in front when there is one.
fn message(briefing: Option<&str>, text: &str) -> String {
    match briefing {
        Some(briefing) => format!("{briefing}\n\n---\n\n{text}"),
        None => text.to_string(),
    }
}

impl Manager {
    /// Load the history from `dir`. Sessions left running by a previous run are closed as failed (unattended) or idle.
    pub fn new(dir: PathBuf, adapter: Arc<dyn Adapter>, sink: Sink) -> Manager {
        let sessions =
            store::recover(&dir, now_ms()).into_iter().map(|info| (info.id.clone(), Session { info, live: None, tape: None })).collect();
        Manager { inner: Arc::new(Inner { dir, adapter, sink, sessions: Mutex::new(sessions) }) }
    }

    /// Start a session in `launch.scope` and send it `prompt`. Returns as soon as the process is running.
    pub fn start(&self, id: String, task: AgentTask, launch: Launch, prompt: &str, options: &StartOptions) -> Result<SessionInfo, String> {
        let inner = &self.inner;
        let scope = &launch.scope;
        let interactive = scope.mode == Mode::Interactive;
        let info = SessionInfo {
            id: id.clone(),
            adapter: inner.adapter.name().to_string(),
            cli_version: None,
            project: match &task {
                AgentTask::Work { project, .. } => Some(project.clone()),
                AgentTask::SystemPassport { .. } => None,
            },
            task,
            title: scope.title.clone(),
            workspace: std::iter::once(&scope.cwd).chain(&scope.add_dirs).map(|dir| dir.display().to_string()).collect(),
            status: Status::Running,
            started_at: now_ms(),
            ended_at: None,
            cost_usd: None,
            error: None,
            structured: None,
            mode: scope.mode,
            policy: scope.policy.mode(),
            worktree: scope.worktree.clone(),
            turns: 0,
            files_changed: None,
            context: if interactive { options.context.clone() } else { vec![] },
            model: options.model.clone().filter(|_| interactive),
            system: options.system.clone().filter(|_| interactive),
        };

        // Without its folder a session could not be logged or replayed, so find that out first.
        std::fs::create_dir_all(&inner.dir).map_err(|e| format!("Could not create {}: {e}", inner.dir.display()))?;
        let mut sessions = inner.sessions.lock().unwrap();
        inner.free_slot(&mut sessions)?;
        let (live, stdout, stderr) = inner.spawn(&id, &launch, false, info.model.clone())?;
        let (child, stdin) = (live.child.clone(), live.stdin.clone());
        sessions.insert(id.clone(), Session { info: info.clone(), live: Some(live), tape: Some(Tape::default()) });
        if interactive {
            let at = now_ms();
            let event = RunEvent::UserMessage { text: prompt.to_string(), context: options.context.clone() };
            inner.record(&mut sessions, &id, at, Record::Event { at, event });
        }
        let _ = inner.persist(&mut sessions);
        drop(sessions);
        (inner.sink)(Emit::SessionsChanged);

        let (pump, required) = (inner.clone(), launch.scope.required_plugin.clone());
        std::thread::spawn(move || pump.pump(&id, stdout, stderr, &child, required.as_deref()));
        // A CLI that has already died shows up as a failed session, not as an error here.
        let _ = write(&stdin, &inner.adapter.user_line(&message(options.briefing.as_deref().filter(|_| interactive), prompt)));
        if !interactive {
            // Closing stdin is what makes this a one-prompt session: the CLI exits when the work is done.
            *stdin.lock().unwrap() = None;
        }
        Ok(info)
    }

    /// Send a message to an idle interactive session, starting a new process for it (resuming the CLI's conversation)
    /// when it has none. `launch` works out how, with no lock held, because it asks Living Memory.
    pub fn send(
        &self,
        id: &str,
        text: &str,
        options: SendOptions,
        launch: impl FnOnce(&SessionInfo) -> Result<Launch, String>,
    ) -> Result<(), String> {
        let inner = &self.inner;
        store::log_path(&inner.dir, id)?;
        if text.trim().is_empty() {
            return Err("Write a message first".into());
        }
        let line = inner.adapter.user_line(&message(options.briefing.as_deref(), text));
        let mut sessions = inner.sessions.lock().unwrap();
        let info = Inner::askable(&sessions, id)?;
        let alive = sessions.get(id).and_then(|session| session.live.as_ref()).filter(|live| is_open(&live.stdin)).map(|live| live.stdin.clone());
        let stdin = match alive {
            Some(stdin) => stdin,
            None => {
                drop(sessions);
                // A process whose stdin is closed is on its way out; a new one may only start when it has gone.
                if !inner.wait_gone(id, DRAIN_WAIT) {
                    return Err("The previous agent process is still shutting down; try again in a moment".into());
                }
                let launch = launch(&info)?;
                sessions = inner.sessions.lock().unwrap();
                let info = Inner::askable(&sessions, id)?;
                if sessions.get(id).is_some_and(|session| session.live.is_some()) {
                    return Err("The previous agent process is still shutting down; try again in a moment".into());
                }
                inner.free_slot(&mut sessions)?;
                let session = sessions.get_mut(id).ok_or("Unknown session")?;
                let tape = session.tape.get_or_insert_with(|| inner.fold(id));
                let (live, stdout, stderr) = inner.spawn(id, &launch, tape.started, info.model.clone())?;
                let (child, stdin) = (live.child.clone(), live.stdin.clone());
                session.live = Some(live);
                let pump = inner.clone();
                let id = id.to_string();
                std::thread::spawn(move || pump.pump(&id, stdout, stderr, &child, None));
                stdin
            }
        };
        let at = now_ms();
        let event = RunEvent::UserMessage { text: text.to_string(), context: options.context.clone() };
        inner.record(&mut sessions, id, at, Record::Event { at, event });
        if let Some(session) = sessions.get_mut(id) {
            for note in &options.context {
                if !session.info.context.contains(note) {
                    session.info.context.push(note.clone());
                }
            }
            session.info.status = Status::Running;
        }
        let _ = inner.persist(&mut sessions);
        drop(sessions);
        (inner.sink)(Emit::SessionsChanged);
        // A failed write is reported; the pump closes the turn when the process has really gone.
        write(&stdin, &line)
    }

    /// Answer the permission request `request_id` of a session.
    pub fn answer(&self, id: &str, request_id: &str, decision: Decision) -> Result<(), String> {
        let inner = &self.inner;
        if decision == Decision::Withdrawn {
            return Err("Invalid decision".into());
        }
        store::log_path(&inner.dir, id)?;
        const GONE: &str = "That request is no longer waiting for an answer";
        let mut sessions = inner.sessions.lock().unwrap();
        let session = sessions.get_mut(id).ok_or("Unknown session")?;
        let live = session.live.as_mut().ok_or(GONE)?;
        let line = live.pending.get(request_id).and_then(|request| inner.adapter.answer_line(request, decision)).ok_or(GONE)?;
        live.pending.remove(request_id);
        let (stdin, none_left) = (live.stdin.clone(), live.pending.is_empty());
        if none_left && session.info.status == Status::Waiting {
            session.info.status = Status::Running;
        }
        let at = now_ms();
        inner.record(&mut sessions, id, at, Record::Event { at, event: RunEvent::ApprovalResolved { request_id: request_id.to_string(), decision } });
        let _ = inner.persist(&mut sessions);
        drop(sessions);
        (inner.sink)(Emit::SessionsChanged);
        write(&stdin, &line)
    }

    /// Stop the turn that is running, if one is.
    pub fn interrupt(&self, id: &str) -> Result<(), String> {
        let inner = &self.inner;
        store::log_path(&inner.dir, id)?;
        let stdin = {
            let mut sessions = inner.sessions.lock().unwrap();
            let session = sessions.get_mut(id).ok_or("Unknown session")?;
            let working = matches!(session.info.status, Status::Running | Status::Waiting);
            session.live.as_mut().filter(|_| working).map(|live| {
                live.interrupted = true;
                live.stdin.clone()
            })
        };
        // The CLI answers with a closing report; if it is gone, the pump closes the turn.
        if let Some(stdin) = stdin {
            let _ = write(&stdin, &inner.adapter.interrupt_line());
        }
        Ok(())
    }

    /// End an interactive session: stop its process (waiting for a clean exit first), write its `finished` event, and
    /// remove its worktree when nothing was changed in it.
    pub fn end(&self, id: &str) -> Result<(), String> {
        let inner = &self.inner;
        store::log_path(&inner.dir, id)?;
        let process = {
            let mut sessions = inner.sessions.lock().unwrap();
            let session = sessions.get_mut(id).ok_or("Unknown session")?;
            if session.info.mode != Mode::Interactive {
                return Err("Only an interactive session can be ended; stop a background session instead".into());
            }
            if is_over(session.info.status) {
                return Ok(());
            }
            let turn = matches!(session.info.status, Status::Running | Status::Waiting);
            session.live.as_mut().map(|live| {
                live.stop.get_or_insert(Stop::Ended);
                live.interrupted |= turn;
                (live.child.clone(), live.stdin.clone(), turn)
            })
        };
        match process {
            Some((child, stdin, turn)) => {
                if turn {
                    let _ = write(&stdin, &inner.adapter.interrupt_line());
                }
                // Without input the CLI finishes and exits by itself; the pump then writes the `finished` event.
                *stdin.lock().unwrap() = None;
                if !inner.wait_gone(id, END_WAIT) {
                    kill(&child);
                    inner.wait_gone(id, END_WAIT);
                }
            }
            None => {
                // The user or a tool may have changed the worktree since the last turn.
                inner.sync_files(id);
                let mut sessions = inner.sessions.lock().unwrap();
                let session = sessions.get(id).ok_or("Unknown session")?;
                if is_over(session.info.status) {
                    return Ok(());
                }
                if session.live.is_some() {
                    drop(sessions);
                    return self.end(id);
                }
                let (at, event) = (now_ms(), stopped(Stop::Ended, &session.info, None, ""));
                inner.record(&mut sessions, id, at, Record::Event { at, event: event.clone() });
                if let Some(session) = sessions.get_mut(id) {
                    close(&mut session.info, at, &event);
                }
                let _ = inner.persist(&mut sessions);
            }
        }
        let tree = inner.sessions.lock().unwrap().get(id).and_then(|session| session.info.worktree.clone());
        // `changes` failing means the worktree is gone or unreadable: leave it alone.
        if let Some(tree) = tree
            && worktree::changes(&tree).is_ok_and(|files| files.is_empty())
            && worktree::ahead(&tree) == Ok(0)
            && worktree::remove(&tree).is_ok()
        {
            inner.update(id, |info| (info.worktree, info.files_changed) = (None, None));
        } else {
            (inner.sink)(Emit::SessionsChanged);
        }
        Ok(())
    }

    /// Change the permission mode of an interactive session, now if it has a process and from the next one on.
    pub fn set_policy(&self, id: &str, mode: PolicyMode) -> Result<(), String> {
        let inner = &self.inner;
        store::log_path(&inner.dir, id)?;
        let mut sessions = inner.sessions.lock().unwrap();
        let session = sessions.get_mut(id).ok_or("Unknown session")?;
        if session.info.mode != Mode::Interactive {
            return Err("Only an interactive session has a permission mode".into());
        }
        if mode == PolicyMode::PreApproved {
            return Err("Unknown policy".into());
        }
        if is_over(session.info.status) {
            return Err("This session has ended".into());
        }
        session.info.policy = mode;
        let stdin = session.live.as_ref().map(|live| live.stdin.clone());
        let _ = inner.persist(&mut sessions);
        drop(sessions);
        (inner.sink)(Emit::SessionsChanged);
        if let Some(stdin) = stdin {
            let _ = write(&stdin, &inner.adapter.mode_line(mode));
        }
        Ok(())
    }

    /// The files changed in a session's worktree, with their patches. Refreshes the totals the session lists.
    pub fn files(&self, id: &str) -> Result<ChangedFiles, String> {
        let inner = &self.inner;
        store::log_path(&inner.dir, id)?;
        let tree = inner.worktree_of(id)?;
        // The totals cover every changed file; the returned list is cut at MAX_FILES.
        let all = worktree::changes(&tree)?;
        let files = worktree::changed_files(&tree)?;
        let total = (!all.is_empty()).then(|| worktree::totals(&all));
        let changed = inner.sessions.lock().unwrap().get(id).is_some_and(|session| session.info.files_changed != total);
        if changed {
            inner.update(id, |info| info.files_changed = total);
        }
        Ok(files)
    }

    /// Remove the worktree of a session that has ended.
    pub fn remove_worktree(&self, id: &str) -> Result<(), String> {
        let inner = &self.inner;
        store::log_path(&inner.dir, id)?;
        let tree = inner.worktree_of(id)?;
        if !inner.sessions.lock().unwrap().get(id).is_some_and(|session| is_over(session.info.status)) {
            return Err("End the session before removing its worktree".into());
        }
        worktree::remove(&tree)?;
        inner.update(id, |info| (info.worktree, info.files_changed) = (None, None));
        Ok(())
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

    /// Stop every process, for when the app closes: nothing would be watching an unattended agent any more. Working
    /// ones are killed at once (each is closed as failed or idle on the next start); idle ones get a moment to leave.
    pub fn stop_all(&self) {
        let inner = &self.inner;
        let mut working = vec![];
        let mut idle = vec![];
        for (id, session) in inner.sessions.lock().unwrap().iter() {
            if let Some(live) = &session.live {
                let target = (id.clone(), live.child.clone(), live.stdin.clone());
                if matches!(session.info.status, Status::Running | Status::Waiting) { working.push(target) } else { idle.push(target) }
            }
        }
        // Idle processes have no writer and leave when their input ends. A working one may have a writer stuck on it, which
        // only the kill frees, so its stdin is closed afterwards.
        for (_, _, stdin) in &idle {
            *stdin.lock().unwrap() = None;
        }
        for (_, child, _) in &working {
            kill(child);
        }
        for (_, _, stdin) in &working {
            *stdin.lock().unwrap() = None;
        }
        let start = Instant::now();
        while start.elapsed() < STOP_ALL_WAIT && idle.iter().any(|(id, ..)| !inner.wait_gone(id, Duration::ZERO)) {
            std::thread::sleep(POLL);
        }
        for (id, child, _) in &idle {
            if !inner.wait_gone(id, Duration::ZERO) {
                kill(child);
            }
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
        let mut started = false;
        let events = records
            .into_iter()
            .flat_map(|record| {
                let at = match &record {
                    Record::Raw { at, .. } | Record::Event { at, .. } => *at,
                };
                events_of(&*inner.adapter, &record, &mut started).into_iter().map(move |event| (at, event)).collect::<Vec<_>>()
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

    /// The details of a session that can take a message now.
    fn askable(sessions: &HashMap<String, Session>, id: &str) -> Result<SessionInfo, String> {
        let info = &sessions.get(id).ok_or("Unknown session")?.info;
        if info.mode != Mode::Interactive {
            return Err("This session does not take messages".into());
        }
        match info.status {
            status if is_over(status) => Err("This session has ended".into()),
            Status::Idle => Ok(info.clone()),
            _ => Err("The agent is still working; wait for this turn to finish or stop it".into()),
        }
    }

    /// The worktree of a session that has one.
    fn worktree_of(&self, id: &str) -> Result<Worktree, String> {
        let sessions = self.sessions.lock().unwrap();
        sessions.get(id).ok_or("Unknown session")?.info.worktree.clone().ok_or_else(|| "This session has no worktree".into())
    }

    /// Wait until a session's process has gone and its pump has closed the books on it; false when `limit` ran out.
    fn wait_gone(&self, id: &str, limit: Duration) -> bool {
        let start = Instant::now();
        loop {
            if self.sessions.lock().unwrap().get(id).is_none_or(|session| session.live.is_none()) {
                return true;
            }
            if start.elapsed() >= limit {
                return false;
            }
            std::thread::sleep(POLL);
        }
    }

    /// Where the session's log stands, counted from the log with the same fold as `Manager::session`.
    fn fold(&self, id: &str) -> Tape {
        let mut tape = Tape::default();
        for record in store::read_log(&self.dir, id).unwrap_or_default() {
            for event in events_of(&*self.adapter, &record, &mut tape.started) {
                tape.count(&event);
            }
        }
        tape
    }

    /// Append one record to the session's log and report its events, numbered. Every writer goes through here, with the
    /// sessions lock held, so the log order and the numbering always agree.
    fn record(&self, sessions: &mut HashMap<String, Session>, id: &str, at: u64, record: Record) -> Vec<RunEvent> {
        let Some(session) = sessions.get_mut(id) else { return vec![] };
        // Counted before the append, or the record would be counted twice.
        let tape = session.tape.get_or_insert_with(|| self.fold(id));
        let _ = store::append(&self.dir, id, &record);
        let events = events_of(&*self.adapter, &record, &mut tape.started);
        for event in &events {
            (self.sink)(Emit::Event(SeqEvent { session_id: id.to_string(), seq: tape.seq, at, event: event.clone() }));
            tape.count(event);
        }
        events
    }

    /// Make room for one more process: close the longest-idle one until a slot is free.
    fn free_slot(&self, sessions: &mut HashMap<String, Session>) -> Result<(), String> {
        let mut busy: Vec<String> = vec![];
        loop {
            let holding = |session: &Session| {
                session.live.as_ref().is_some_and(|live| match session.info.status {
                    Status::Running | Status::Waiting => true,
                    Status::Idle => is_open(&live.stdin),
                    _ => false,
                })
            };
            if sessions.values().filter(|session| holding(session)).count() < MAX_RUNNING {
                return Ok(());
            }
            let idle = sessions
                .iter()
                .filter(|(id, session)| session.info.status == Status::Idle && holding(session) && !busy.contains(id))
                .filter_map(|(id, session)| session.live.as_ref().map(|live| (live.idle_since, id.clone(), live.stdin.clone())))
                .min_by_key(|(idle_since, ..)| *idle_since);
            let Some((_, id, stdin)) = idle else { return Err(LIMIT.into()) };
            // An idle session has no writer; if there is one anyway, waiting for it here would freeze every session.
            match stdin.try_lock() {
                Ok(mut slot) => *slot = None,
                Err(_) => busy.push(id),
            }
        }
    }

    /// Start the CLI for a session. Returns the live handle and the pipes the pump reads.
    fn spawn(&self, id: &str, launch: &Launch, resume: bool, model: Option<String>) -> Result<(Live, Option<ChildStdout>, JoinHandle<String>), String> {
        let spec = Spec {
            session_id: id.to_string(),
            cwd: launch.scope.cwd.clone(),
            add_dirs: launch.scope.add_dirs.clone(),
            policy: launch.scope.policy.clone(),
            plugin_dirs: launch.scope.plugin_dirs.clone(),
            budget_usd: launch.budget_usd,
            schema: launch.scope.schema.clone(),
            program: launch.program.clone(),
            resume,
            model,
            deny: launch.scope.deny.clone(),
            memory_root: launch.memory_root.clone(),
        };
        let mut command = self.adapter.command(&spec);
        command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = command.spawn().map_err(|e| format!("Could not start {}: {e}", spec.program))?;
        let (stdin, stdout) = (child.stdin.take(), child.stdout.take());
        let stderr = crate::git::drain(child.stderr.take());
        let live = Live {
            child: Arc::new(Mutex::new(child)),
            stdin: Arc::new(Mutex::new(stdin)),
            stop: None,
            pending: HashMap::new(),
            interrupted: false,
            idle_since: now_ms(),
        };
        Ok((live, stdout, stderr))
    }

    /// Compare the session's worktree with the list of the last `filesChanged` event and record a new one when they
    /// differ. Runs git with no lock held. Does nothing for a session without a worktree.
    fn sync_files(&self, id: &str) {
        let Some(tree) = self.sessions.lock().unwrap().get(id).and_then(|session| session.info.worktree.clone()) else { return };
        // An error means the worktree may be gone.
        let Ok(files) = worktree::changes(&tree) else { return };
        let mut sessions = self.sessions.lock().unwrap();
        let Some(session) = sessions.get_mut(id) else { return };
        let new = (!files.is_empty()).then(|| worktree::totals(&files));
        let listed = session.tape.get_or_insert_with(|| self.fold(id)).files != files;
        // The stored totals can have been changed by `Manager::files` without an event, so they are reconciled on every
        // call and never inferred from the list.
        let recounted = session.info.files_changed != new;
        session.info.files_changed = new;
        if listed {
            let at = now_ms();
            self.record(&mut sessions, id, at, Record::Event { at, event: RunEvent::FilesChanged { files } });
        }
        if listed || recounted {
            let _ = self.persist(&mut sessions);
        }
    }

    /// The reader thread of one process: log each stdout line, then report its events; when stdout closes, wait for the
    /// process and close the session (unattended) or its turn.
    fn pump(&self, id: &str, stdout: Option<ChildStdout>, stderr: JoinHandle<String>, child: &Mutex<Child>, required_plugin: Option<&str>) {
        let interactive = self.sessions.lock().unwrap().get(id).is_some_and(|session| session.info.mode == Mode::Interactive);
        let (mut denied, mut last) = (0u64, None);
        for bytes in stdout.into_iter().flat_map(|out| BufReader::new(out).split(b'\n')) {
            let Ok(bytes) = bytes else { break };
            let text = String::from_utf8_lossy(&bytes);
            let line = text.trim_end_matches('\r');
            if line.is_empty() {
                continue;
            }
            // Log first: replay parses the same lines in the same order, so it numbers events the same way.
            let at = now_ms();
            let mut sessions = self.sessions.lock().unwrap();
            let events = self.record(&mut sessions, id, at, Record::Raw { at, raw: line.to_string() });
            let (mut changed, mut kill_it, mut answer) = (false, false, None);
            if let Some(session) = sessions.get_mut(id) {
                for event in &events {
                    match event {
                        RunEvent::Started { cli_version, plugins, .. } => {
                            session.info.cli_version = cli_version.clone();
                            changed = true;
                            if required_plugin.is_some_and(|name| !plugins.iter().any(|plugin| plugin == name)) {
                                if let Some(live) = &mut session.live {
                                    live.stop.get_or_insert(Stop::Failed(NO_PLUGIN.into()));
                                }
                                kill_it = true;
                            }
                        }
                        RunEvent::Denied { .. } => denied += 1,
                        RunEvent::ApprovalRequest { request_id, .. } if interactive => {
                            if let Some(live) = &mut session.live {
                                live.pending.insert(request_id.clone(), line.to_string());
                            }
                            session.info.status = Status::Waiting;
                            changed = true;
                        }
                        RunEvent::ApprovalResolved { request_id, .. } if interactive => {
                            if let Some(live) = &mut session.live {
                                live.pending.remove(request_id);
                                if live.pending.is_empty() && session.info.status == Status::Waiting {
                                    session.info.status = Status::Running;
                                    changed = true;
                                }
                            }
                        }
                        _ => {}
                    }
                }
                if interactive && let Some(mode) = self.adapter.mode_of(line).filter(|mode| *mode != session.info.policy) {
                    session.info.policy = mode;
                    changed = true;
                }
                if let (Some(reply), Some(live)) = (self.adapter.refusal(line), &session.live) {
                    answer = Some((live.stdin.clone(), reply));
                }
            }
            if changed {
                let _ = self.persist(&mut sessions);
            }
            drop(sessions);
            if changed {
                (self.sink)(Emit::SessionsChanged);
            }
            if kill_it {
                kill(child);
            }
            // Written with no lock held but the stdin's own.
            if let Some((stdin, reply)) = answer {
                let _ = write(&stdin, &reply);
            }
            if let Some(outcome) = self.adapter.outcome(line) {
                if interactive {
                    self.end_turn(id, outcome);
                } else {
                    self.update(id, |info| info.cost_usd = outcome.cost_usd.or(info.cost_usd));
                    last = Some(outcome);
                }
            }
        }
        let code = exit_code(child);
        let stderr = stderr.join().unwrap_or_default();
        // The process is gone, so the worktree is final for this run: whatever the agent wrote before a cancel, a crash or
        // a failure without a result is reported before any closing event.
        if interactive {
            self.sync_files(id);
        }

        let mut sessions = self.sessions.lock().unwrap();
        let at = now_ms();
        let stop = sessions.get_mut(id).and_then(|session| session.live.take()).and_then(|live| live.stop);
        let Some((info, started)) = sessions.get(id).map(|session| (session.info.clone(), session.tape.as_ref().is_some_and(|tape| tape.started)))
        else {
            return;
        };
        let closing = match stop {
            _ if !interactive => Some(finished(stop, last, denied, code, &stderr)),
            Some(stop) => Some(stopped(stop, &info, code, &stderr)),
            None if !started => Some(finished(None, None, 0, code, &stderr)),
            None => None,
        };
        if let Some(event) = closing {
            self.record(&mut sessions, id, at, Record::Event { at, event: event.clone() });
            if let Some(session) = sessions.get_mut(id) {
                close(&mut session.info, at, &event);
            }
        } else if matches!(info.status, Status::Running | Status::Waiting) {
            // Started, never reported the end of this turn, and nobody asked it to stop: it crashed.
            let event = RunEvent::TurnFinished {
                ok: false,
                reason: Some(no_result(code, &stderr)),
                cost_usd: info.cost_usd,
                duration_ms: None,
                result: None,
                denials: 0,
                outcome: TurnEnd::Error,
            };
            self.record(&mut sessions, id, at, Record::Event { at, event });
            if let Some(session) = sessions.get_mut(id) {
                session.info.status = Status::Idle;
            }
        }
        let _ = self.persist(&mut sessions);
        drop(sessions);
        (self.sink)(Emit::SessionsChanged);
    }

    /// The end of a turn of an interactive session, from the CLI's closing report.
    fn end_turn(&self, id: &str, outcome: Outcome) {
        self.sync_files(id);
        if outcome.budget {
            // A capped process never recovers. Closed while the turn still counts as running, so no message can reach it.
            let stdin = self.sessions.lock().unwrap().get(id).and_then(|session| session.live.as_ref()).map(|live| live.stdin.clone());
            if let Some(stdin) = stdin {
                *stdin.lock().unwrap() = None;
            }
        }
        let mut sessions = self.sessions.lock().unwrap();
        let at = now_ms();
        let interrupted = sessions.get(id).and_then(|session| session.live.as_ref()).is_some_and(|live| live.interrupted);
        let how = if outcome.ok {
            TurnEnd::Completed
        } else if interrupted {
            TurnEnd::Stopped
        } else if outcome.budget {
            TurnEnd::Budget
        } else {
            TurnEnd::Error
        };
        let reason = if matches!(how, TurnEnd::Completed | TurnEnd::Stopped) { None } else { outcome.reason };
        let event = RunEvent::TurnFinished {
            ok: outcome.ok,
            reason,
            cost_usd: outcome.cost_usd,
            duration_ms: outcome.duration_ms,
            result: outcome.result,
            denials: outcome.denials,
            outcome: how,
        };
        self.record(&mut sessions, id, at, Record::Event { at, event });
        if let Some(session) = sessions.get_mut(id) {
            let info = &mut session.info;
            info.cost_usd = outcome.cost_usd.or(info.cost_usd);
            info.turns += 1;
            info.status = Status::Idle;
            if let Some(live) = &mut session.live {
                live.pending.clear();
                live.interrupted = false;
                live.idle_since = at;
            }
        }
        let _ = self.persist(&mut sessions);
        drop(sessions);
        (self.sink)(Emit::SessionsChanged);
    }
}

/// Work out what `task` may touch (from Living Memory and the settings), then start its session. A work session gets a
/// worktree of its own first, which is removed again when the session cannot start.
pub fn start_task(
    manager: &Manager,
    bridge: &Bridge,
    saved: &Settings,
    worktrees: &Path,
    task: AgentTask,
    prompt: &str,
    options: StartOptions,
) -> Result<SessionInfo, String> {
    let program = claude::available(saved)?;
    let id = uuid::Uuid::new_v4().to_string();
    let launch = |scope| Launch { scope, program: program.clone(), budget_usd: saved.agent_budget_usd(), memory_root: bridge.launch().root };
    let AgentTask::Work { project, repo, branch, change } = &task else {
        let home = dirs::home_dir().ok_or("Could not find your home folder")?;
        let scope = scope::for_task(bridge, &task, saved, &home)?;
        return manager.start(id, task, launch(scope), prompt, &options);
    };
    if prompt.trim().is_empty() {
        return Err("Write a task for the session first".into());
    }
    if let Some(model) = options.model.as_deref().filter(|model| !matches!(*model, "sonnet" | "opus" | "haiku")) {
        return Err(format!("Unknown model: {model}"));
    }
    let policy = options.policy.unwrap_or(PolicyMode::Ask);
    let entry = crate::git::project_entry(bridge, project)?;
    let repo = scope::project_repo(&entry, repo)?;
    if let Some(id) = change {
        scope::check_change(&scope::change_entry(bridge, *id)?, project, &repo.to_string_lossy())?;
    }
    let tree = worktree::create(worktrees, &repo, branch.as_deref(), &id)?;
    let started = scope::work(tree.clone(), policy, prompt).and_then(|scope| manager.start(id, task.clone(), launch(scope), prompt, &options));
    if started.is_err() {
        let _ = worktree::remove(&tree);
    }
    started
}

/// Send a message to a session, starting a process for it again when it has none.
pub fn send_task(manager: &Manager, bridge: &Bridge, saved: &Settings, id: &str, text: &str, options: SendOptions) -> Result<(), String> {
    manager.send(id, text, options, |info| {
        Ok(Launch {
            scope: scope::for_session(bridge, info)?,
            program: claude::available(saved)?,
            budget_usd: saved.agent_budget_usd(),
            memory_root: bridge.launch().root,
        })
    })
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

    const TEXT: &str = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"On it."}]}}"#;
    const TOOL_RESULT: &str = r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_01BaUp77S1XfWQ94cYZZXe5W","content":"done"}]}}"#;
    const ASKED: &str = "6c738ff4-3b35-4894-acec-1b2806f0b2f4";
    // Verbatim from the spike (section 5.1 B of the Phase 2 document).
    const BASH_REQUEST: &str = r#"{"type":"control_request","request_id":"6c738ff4-3b35-4894-acec-1b2806f0b2f4","request":{"subtype":"can_use_tool","tool_name":"Bash","display_name":"Bash","input":{"command":"mkdir spike_dir_1","description":"Create directory spike_dir_1"},"description":"Create directory spike_dir_1","permission_suggestions":[{"type":"addRules","rules":[{"toolName":"Bash","ruleContent":"mkdir spike_dir_1"}],"behavior":"allow","destination":"localSettings"},{"type":"addDirectories","directories":["<SCRATCH>\\spike-claude"],"destination":"session"},{"type":"setMode","mode":"acceptEdits","destination":"session"}],"blocked_path":"<SCRATCH>\\spike-claude\\spike_dir_1","tool_use_id":"toolu_01BaUp77S1XfWQ94cYZZXe5W"}}"#;
    const GOVERNED_REQUEST: &str = r#"{"type":"control_request","request_id":"r-gov","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"python living_memory.py apply x --expected-plan-sha256 y"},"permission_suggestions":[]}}"#;
    const CANCEL: &str = r#"{"type":"control_cancel_request","request_id":"6c738ff4-3b35-4894-acec-1b2806f0b2f4"}"#;
    const ABORTED: &str = r#"{"type":"result","subtype":"error_during_execution","is_error":true,"num_turns":1,"total_cost_usd":0.01,"aborted_tools":[{"tool_use_id":"toolu_01"}]}"#;
    const BUDGET: &str = r#"{"type":"result","subtype":"error_max_budget_usd","is_error":true,"num_turns":1,"total_cost_usd":0.0092,"errors":["Reached maximum budget ($0.004)"],"terminal_reason":"budget_exhausted"}"#;

    /// Not a test of its own: with HIVEMIND_FAKE_SCRIPT set, this process is the fake CLI of another test.
    #[test]
    fn fake_cli() {
        let Ok(script) = std::env::var("HIVEMIND_FAKE_SCRIPT") else { return };
        let log = std::env::var("HIVEMIND_FAKE_STDIN").unwrap();
        // Each script line is "<" (wait for one stdin line; stop at end of input) or a line to print.
        // Every stdin line read is appended to the file named by HIVEMIND_FAKE_STDIN.
        let (mut input, mut out) = (std::io::stdin().lock().lines(), std::io::stdout());
        // The harness has just printed "test agent::tests::fake_cli ... " without a newline.
        println!();
        for step in std::fs::read_to_string(script).unwrap().lines() {
            if step == "<" {
                let Some(Ok(line)) = input.next() else { return };
                let mut file = std::fs::OpenOptions::new().create(true).append(true).open(&log).unwrap();
                writeln!(file, "{line}").unwrap();
            } else {
                println!("{step}");
                out.flush().unwrap();
            }
        }
    }

    fn new_id() -> String {
        uuid::Uuid::new_v4().to_string()
    }

    fn work_task() -> AgentTask {
        AgentTask::Work { project: "paystream".into(), repo: "repo".into(), branch: None, change: None }
    }

    fn git_available() -> bool {
        Command::new("git").arg("--version").output().map(|out| out.status.success()).unwrap_or(false)
    }

    fn sh(dir: &Path, args: &[&str]) {
        let out = Command::new("git").arg("-C").arg(dir).args(args).output().unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    }

    /// Until `done` holds for what `seen` collected for a session; fails after 20 seconds.
    fn wait_for(seen: &Mutex<Vec<Emit>>, id: &str, what: &str, done: impl Fn(&[SeqEvent]) -> bool) -> Vec<SeqEvent> {
        let start = Instant::now();
        loop {
            let events: Vec<SeqEvent> = seen
                .lock()
                .unwrap()
                .iter()
                .filter_map(|emit| if let Emit::Event(event) = emit { Some(event) } else { None })
                .filter(|event| event.session_id == id)
                .cloned()
                .collect();
            if done(&events) {
                return events;
            }
            assert!(start.elapsed() < Duration::from_secs(20), "timed out waiting for {what}: {events:?}");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn turn_count(events: &[SeqEvent]) -> usize {
        events.iter().filter(|event| matches!(event.event, RunEvent::TurnFinished { .. })).count()
    }

    fn kinds(events: &[SeqEvent]) -> Vec<&RunEvent> {
        events.iter().map(|event| &event.event).collect()
    }

    /// No process or pump thread of `manager` may outlive the folder they write to.
    fn settle(manager: &Manager) {
        manager.stop_all();
        let start = Instant::now();
        while start.elapsed() < Duration::from_secs(10) && manager.inner.sessions.lock().unwrap().values().any(|session| session.live.is_some()) {
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// Reads Claude Code's output format, but runs a harmless local program instead of the CLI.
    type Seen = Arc<Mutex<Vec<Emit>>>;
    type Specs = Arc<Mutex<Vec<Spec>>>;

    struct Fake {
        program: PathBuf,
        args: Vec<String>,
        /// For the fake CLI (see `fake_cli`): the script of each process in the order they start, the last one repeating.
        scripts: Vec<String>,
        /// Where the scripts and the stdin logs go.
        dir: PathBuf,
        /// Every `Spec` a process was started from.
        specs: Specs,
    }

    impl Fake {
        fn program(program: &str, args: Vec<String>) -> Fake {
            Fake { program: program.into(), args, scripts: vec![], dir: PathBuf::new(), specs: Arc::default() }
        }

        /// This test binary, run as a CLI that follows one of `scripts` (lines of `fake_cli`'s script language).
        fn scripted(name: &str, scripts: &[&[&str]]) -> Fake {
            Fake {
                program: std::env::current_exe().unwrap(),
                args: ["--exact", "agent::tests::fake_cli", "--nocapture", "--test-threads=1"].map(String::from).to_vec(),
                scripts: scripts.iter().map(|lines| lines.join("
")).collect(),
                dir: Rig::folder(name),
                specs: Arc::default(),
            }
        }
    }

    impl Adapter for Fake {
        fn name(&self) -> &'static str {
            "fake"
        }
        fn command(&self, spec: &Spec) -> Command {
            let mut specs = self.specs.lock().unwrap();
            let nth = specs.len();
            specs.push(spec.clone());
            let mut command = Command::new(&self.program);
            command.args(&self.args).current_dir(&spec.cwd);
            if let Some(script) = self.scripts.get(nth).or(self.scripts.last()) {
                let file = self.dir.join(format!("script-{nth}.txt"));
                std::fs::write(&file, script).unwrap();
                command.env("HIVEMIND_FAKE_SCRIPT", file).env("HIVEMIND_FAKE_STDIN", self.dir.join(format!("stdin-{}.txt", spec.session_id)));
            }
            command
        }
        fn user_line(&self, text: &str) -> String {
            ClaudeCode.user_line(text)
        }
        fn parse_line(&self, line: &str) -> Vec<RunEvent> {
            ClaudeCode.parse_line(line)
        }
        fn outcome(&self, line: &str) -> Option<Outcome> {
            ClaudeCode.outcome(line)
        }
        fn answer_line(&self, request: &str, decision: Decision) -> Option<String> {
            ClaudeCode.answer_line(request, decision)
        }
        fn refusal(&self, line: &str) -> Option<String> {
            ClaudeCode.refusal(line)
        }
        fn interrupt_line(&self) -> String {
            ClaudeCode.interrupt_line()
        }
        fn mode_line(&self, mode: PolicyMode) -> String {
            ClaudeCode.mode_line(mode)
        }
        fn mode_of(&self, line: &str) -> Option<PolicyMode> {
            ClaudeCode.mode_of(line)
        }
    }

    struct Rig {
        dir: PathBuf,
        manager: Manager,
        seen: Seen,
        specs: Specs,
    }

    impl Rig {
        fn new(name: &str, adapter: Fake) -> Rig {
            let dir = Rig::folder(name);
            std::fs::create_dir_all(&dir).unwrap();
            let seen: Arc<Mutex<Vec<Emit>>> = Arc::default();
            let (sink, specs) = (seen.clone(), adapter.specs.clone());
            let manager = Manager::new(dir.join("sessions"), Arc::new(adapter), Arc::new(move |emit| sink.lock().unwrap().push(emit)));
            Rig { dir, manager, seen, specs }
        }

        fn folder(name: &str) -> PathBuf {
            std::env::temp_dir().join(format!("hivemind-agent-{name}-{}", std::process::id()))
        }

        /// Sessions print the lines of `output.jsonl` in the rig's folder and exit.
        fn printing(name: &str, lines: &[&str]) -> Rig {
            let file = Rig::folder(name).join("output.jsonl").display().to_string();
            let adapter = if cfg!(windows) {
                Fake::program("cmd", vec!["/C".into(), "type".into(), file])
            } else {
                Fake::program("cat", vec![file])
            };
            let rig = Rig::new(name, adapter);
            std::fs::write(rig.dir.join("output.jsonl"), lines.join("\n") + "\n").unwrap();
            rig
        }

        /// Sessions run for half a minute unless stopped.
        fn lingering(name: &str) -> Rig {
            let args = if cfg!(windows) { vec!["-n", "30", "127.0.0.1"] } else { vec!["30"] };
            Rig::new(name, Fake::program(if cfg!(windows) { "ping" } else { "sleep" }, args.into_iter().map(String::from).collect()))
        }

        fn launch(&self, scope: Scope) -> Launch {
            Launch { scope, program: "unused".into(), budget_usd: 5.0, memory_root: Some(self.dir.join("store")) }
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
            let task = AgentTask::SystemPassport { slug: "billing".into() };
            let id = uuid::Uuid::new_v4().to_string();
            self.manager.start(id, task, self.launch(scope), "Describe the system.", &StartOptions::default())
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

        /// A rig whose sessions run the fake CLI, one of `scripts` per process.
        fn scripted(name: &str, scripts: &[&[&str]]) -> Rig {
            Rig::new(name, Fake::scripted(name, scripts))
        }

        /// What an interactive session in `tree` (or in the rig's folder) may touch.
        fn scope(&self, tree: Option<Worktree>) -> Scope {
            Scope {
                title: "Fix the bug".into(),
                cwd: tree.as_ref().map_or(self.dir.clone(), |tree| PathBuf::from(&tree.path)),
                add_dirs: vec![],
                policy: Policy::Ask { allow: vec![] },
                schema: None,
                plugin_dirs: vec![],
                required_plugin: None,
                mode: Mode::Interactive,
                worktree: tree,
                deny: scope::governed_rules(),
            }
        }

        fn start_work(&self, id: &str, tree: Option<Worktree>, options: &StartOptions) -> Result<SessionInfo, String> {
            self.manager.start(id.to_string(), work_task(), self.launch(self.scope(tree)), "Fix the bug", options)
        }

        fn begin(&self) -> SessionInfo {
            self.start_work(&new_id(), None, &StartOptions::default()).unwrap()
        }

        fn send(&self, id: &str, text: &str) -> Result<(), String> {
            send_on(&self.manager, self, id, text)
        }

        /// What the session has emitted once it has finished `count` turns.
        fn turns(&self, id: &str, count: usize) -> Vec<SeqEvent> {
            wait_for(&self.seen, id, "a turn to finish", |events| turn_count(events) >= count)
        }

        fn gone(&self, id: &str) {
            let start = Instant::now();
            while !self.manager.inner.wait_gone(id, Duration::ZERO) {
                assert!(start.elapsed() < Duration::from_secs(20), "the process did not exit");
                std::thread::sleep(Duration::from_millis(20));
            }
        }

        /// The lines the fake CLI has read from stdin for the session, as JSON.
        fn stdin_lines(&self, id: &str) -> Vec<Value> {
            let text = std::fs::read_to_string(self.dir.join(format!("stdin-{id}.txt"))).unwrap_or_default();
            text.lines().map(|line| serde_json::from_str(line).unwrap()).collect()
        }

        /// Another manager on the same history, as after a restart of the app.
        fn reopened(&self, name: &str, scripts: &[&[&str]]) -> (Manager, Seen, Specs) {
            let fake = Fake::scripted(name, scripts);
            let (seen, specs) = (Seen::default(), fake.specs.clone());
            let sink = seen.clone();
            let manager = Manager::new(self.dir.join("sessions"), Arc::new(fake), Arc::new(move |emit| sink.lock().unwrap().push(emit)));
            (manager, seen, specs)
        }

        /// A git repository with one commit, and a worktree of it for session `id`.
        fn tree(&self, id: &str) -> Worktree {
            let repo = self.dir.join("repo");
            if !repo.exists() {
                std::fs::create_dir_all(&repo).unwrap();
                sh(&repo, &["init", "-q"]);
                sh(&repo, &["symbolic-ref", "HEAD", "refs/heads/main"]);
                sh(&repo, &["config", "user.name", "Tester"]);
                sh(&repo, &["config", "user.email", "t@example.com"]);
                sh(&repo, &["config", "commit.gpgsign", "false"]);
                std::fs::write(repo.join("a.txt"), "one\n").unwrap();
                sh(&repo, &["add", "."]);
                sh(&repo, &["commit", "-q", "-m", "first"]);
            }
            worktree::create(&self.dir.join("worktrees"), &repo, None, id).unwrap()
        }
    }

    impl Drop for Rig {
        fn drop(&mut self) {
            settle(&self.manager);
            std::fs::remove_dir_all(&self.dir).ok();
        }
    }

    /// `Manager::send` with the rig's launch, for either manager.
    fn send_on(manager: &Manager, rig: &Rig, id: &str, text: &str) -> Result<(), String> {
        manager.send(id, text, SendOptions::default(), |info| Ok(rig.launch(rig.scope(info.worktree.clone()))))
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
        let others = [rig.start(None).unwrap(), rig.start(None).unwrap()];
        assert_eq!(rig.start(None).unwrap_err(), LIMIT);
        assert_eq!(rig.manager.sessions().len(), 3);

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

        let fourth = rig.start(None).unwrap();
        for id in others.iter().map(|info| &info.id).chain([&fourth.id]) {
            rig.manager.cancel(id).unwrap();
            rig.finish(id);
        }
        assert_eq!(rig.manager.sessions().iter().map(|info| info.status).collect::<Vec<_>>(), vec![Status::Cancelled; 4]);
    }

    #[test]
    fn interactive_session_runs_two_turns_and_replays_exactly() {
        let rig = Rig::scripted("two-turns", &[&["<", INIT, TEXT, RESULT, "<", INIT, TEXT, RESULT, "<"]]);
        let options = StartOptions {
            briefing: Some("Project briefing".into()),
            context: vec!["paystream:6f0c".into()],
            system: Some("billing".into()),
            ..Default::default()
        };
        let started = rig.start_work(&new_id(), None, &options).unwrap();
        assert_eq!((started.status, started.mode, started.turns, started.policy), (Status::Running, Mode::Interactive, 0, PolicyMode::Ask));
        assert_eq!((started.project.as_deref(), started.title.as_str(), started.system.as_deref()), (Some("paystream"), "Fix the bug", Some("billing")));
        assert_eq!(started.context, vec!["paystream:6f0c".to_string()]);

        let first = rig.turns(&started.id, 1);
        assert!(matches!(
            kinds(&first)[..],
            [RunEvent::UserMessage { .. }, RunEvent::Started { .. }, RunEvent::Text { .. }, RunEvent::TurnFinished { .. }]
        ));
        assert_eq!(first[0].event, RunEvent::UserMessage { text: "Fix the bug".into(), context: vec!["paystream:6f0c".into()] });
        assert!(matches!(
            &first[3].event,
            RunEvent::TurnFinished { ok: true, reason: None, outcome: TurnEnd::Completed, result: Some(result), .. } if result == "Done."
        ));
        let info = rig.info(&started.id);
        assert_eq!((info.status, info.turns, info.cost_usd), (Status::Idle, 1, Some(0.02)));

        rig.send(&started.id, "again").unwrap();
        let live = rig.turns(&started.id, 2);
        assert!(matches!(
            kinds(&live)[4..],
            [RunEvent::UserMessage { .. }, RunEvent::Text { .. }, RunEvent::TurnFinished { .. }]
        ));
        assert_eq!(live.len(), 7);
        assert_eq!(live.iter().map(|event| event.seq).collect::<Vec<_>>(), (0..7).collect::<Vec<_>>());
        assert_eq!(live.iter().filter(|event| matches!(event.event, RunEvent::Started { .. })).count(), 1);
        assert!(!live.iter().any(|event| matches!(event.event, RunEvent::Finished { .. })));
        assert_eq!(rig.info(&started.id).turns, 2);
        assert_eq!(rig.manager.session(&started.id, 0).unwrap().events, live);

        let lines = rig.stdin_lines(&started.id);
        assert_eq!(lines.len(), 2);
        for line in &lines {
            assert_eq!((line["type"].as_str(), line["message"]["role"].as_str()), (Some("user"), Some("user")));
        }
        let text = |line: &Value| line["message"]["content"][0]["text"].as_str().unwrap().to_string();
        assert!(text(&lines[0]).contains("Project briefing") && text(&lines[0]).ends_with("Fix the bug"), "{}", text(&lines[0]));
        assert_eq!(text(&lines[1]), "again");
    }
    #[test]
    fn send_is_refused_while_a_turn_runs() {
        let rig = Rig::scripted("busy", &[&["<", INIT, "<"]]);
        let started = rig.begin();
        wait_for(&rig.seen, &started.id, "started", |events| events.iter().any(|event| matches!(event.event, RunEvent::Started { .. })));
        assert_eq!(rig.send(&started.id, "more").unwrap_err(), "The agent is still working; wait for this turn to finish or stop it");
        assert_eq!(rig.send(&started.id, "  ").unwrap_err(), "Write a message first");
        assert_eq!(rig.send("00000000-0000-4000-8000-000000000009", "x").unwrap_err(), "Unknown session");
        assert_eq!(rig.send("../index", "x").unwrap_err(), "Invalid session id");
        assert_eq!(rig.stdin_lines(&started.id).len(), 1);
        assert_eq!(rig.info(&started.id).status, Status::Running);
    }

    #[test]
    fn approval_waits_for_an_answer() {
        let rig = Rig::scripted("approval", &[&["<", INIT, BASH_REQUEST, "<", TOOL_RESULT, RESULT, "<"]]);
        let started = rig.begin();
        let asked =
            wait_for(&rig.seen, &started.id, "the request", |events| events.iter().any(|event| matches!(event.event, RunEvent::ApprovalRequest { .. })));
        assert!(matches!(&asked.last().unwrap().event, RunEvent::ApprovalRequest { request_id, tool, can_always: true, .. } if request_id == ASKED && tool == "Bash"));
        assert_eq!(rig.info(&started.id).status, Status::Waiting);
        assert_eq!(rig.send(&started.id, "more").unwrap_err(), "The agent is still working; wait for this turn to finish or stop it");

        let gone = "That request is no longer waiting for an answer";
        assert_eq!(rig.manager.answer(&started.id, "nope", Decision::Allow).unwrap_err(), gone);
        assert_eq!(rig.manager.answer(&started.id, ASKED, Decision::Withdrawn).unwrap_err(), "Invalid decision");
        assert_eq!(rig.manager.answer("00000000-0000-4000-8000-000000000009", ASKED, Decision::Allow).unwrap_err(), "Unknown session");
        rig.manager.answer(&started.id, ASKED, Decision::AllowAlways).unwrap();
        assert_eq!(rig.manager.answer(&started.id, ASKED, Decision::Allow).unwrap_err(), gone);

        let live = rig.turns(&started.id, 1);
        assert!(matches!(
            kinds(&live)[..],
            [
                RunEvent::UserMessage { .. },
                RunEvent::Started { .. },
                RunEvent::ApprovalRequest { .. },
                RunEvent::ApprovalResolved { decision: Decision::AllowAlways, .. },
                RunEvent::ToolResult { .. },
                RunEvent::TurnFinished { .. }
            ]
        ));
        let answer = &rig.stdin_lines(&started.id)[1];
        assert_eq!(answer["response"]["request_id"], ASKED);
        assert_eq!(answer["response"]["response"]["updatedPermissions"][0]["destination"], "session");
        assert_eq!(rig.info(&started.id).status, Status::Idle);
        assert_eq!(rig.manager.session(&started.id, 0).unwrap().events, live);
    }

    #[test]
    fn governed_requests_are_refused_by_hivemind() {
        let rig = Rig::scripted("governed", &[&["<", INIT, GOVERNED_REQUEST, "<", RESULT, "<"]]);
        let started = rig.begin();
        let live = rig.turns(&started.id, 1);
        assert!(live.iter().any(|event| matches!(&event.event, RunEvent::Denied { tool, .. } if tool == "Bash")));
        assert!(!live.iter().any(|event| matches!(event.event, RunEvent::ApprovalRequest { .. })));
        let refusal = &rig.stdin_lines(&started.id)[1];
        assert_eq!(*refusal, serde_json::from_str::<Value>(&ClaudeCode.refusal(GOVERNED_REQUEST).unwrap()).unwrap());
        assert_eq!((refusal["response"]["request_id"].as_str(), refusal["response"]["response"]["behavior"].as_str()), (Some("r-gov"), Some("deny")));
        assert_eq!(rig.info(&started.id).status, Status::Idle);
    }

    #[test]
    fn a_withdrawn_request_clears_waiting() {
        let rig = Rig::scripted("withdrawn", &[&["<", INIT, BASH_REQUEST, "<", CANCEL, ABORTED, "<"]]);
        let started = rig.begin();
        wait_for(&rig.seen, &started.id, "the request", |events| events.iter().any(|event| matches!(event.event, RunEvent::ApprovalRequest { .. })));
        assert_eq!(rig.info(&started.id).status, Status::Waiting);
        rig.manager.interrupt(&started.id).unwrap();
        let live = rig.turns(&started.id, 1);
        let stop = &rig.stdin_lines(&started.id)[1];
        assert_eq!((stop["type"].as_str(), stop["request"]["subtype"].as_str()), (Some("control_request"), Some("interrupt")));
        let all = kinds(&live);
        assert!(matches!(
            all[all.len() - 2..],
            [
                RunEvent::ApprovalResolved { decision: Decision::Withdrawn, .. },
                RunEvent::TurnFinished { ok: false, outcome: TurnEnd::Stopped, reason: None, .. }
            ]
        ));
        let info = rig.info(&started.id);
        assert_eq!((info.status, info.turns), (Status::Idle, 1));
        // Stopping with nothing running is not an error.
        rig.manager.interrupt(&started.id).unwrap();
        rig.send(&started.id, "go on").unwrap();
    }

    #[test]
    fn budget_stop_closes_the_process_and_the_next_message_resumes() {
        let rig = Rig::scripted("budget", &[&["<", INIT, BUDGET, "<"], &["<", INIT, RESULT, "<"]]);
        let started = rig.begin();
        let first = rig.turns(&started.id, 1);
        assert!(matches!(
            &first.last().unwrap().event,
            RunEvent::TurnFinished { ok: false, outcome: TurnEnd::Budget, reason: Some(reason), .. } if reason.contains("Reached maximum budget")
        ));
        rig.gone(&started.id);
        assert!(!rig.events(&started.id).iter().any(|event| matches!(event.event, RunEvent::Finished { .. })));
        assert_eq!(rig.info(&started.id).status, Status::Idle);

        rig.send(&started.id, "go on").unwrap();
        let live = rig.turns(&started.id, 2);
        assert_eq!(rig.specs.lock().unwrap().iter().map(|spec| spec.resume).collect::<Vec<_>>(), vec![false, true]);
        assert_eq!(live.iter().filter(|event| matches!(event.event, RunEvent::Started { .. })).count(), 1);
        assert!(matches!(&live.last().unwrap().event, RunEvent::TurnFinished { ok: true, .. }));
        assert_eq!(live.iter().map(|event| event.seq).collect::<Vec<_>>(), (0..live.len() as u64).collect::<Vec<_>>());
        assert_eq!(rig.manager.session(&started.id, 0).unwrap().events, live);
    }

    #[test]
    fn every_process_gets_the_store_and_the_deny_rules() {
        let rig = Rig::scripted("store", &[&["<", INIT, BUDGET, "<"], &["<", INIT, RESULT, "<"]]);
        let started = rig.begin();
        rig.turns(&started.id, 1);
        rig.gone(&started.id);
        rig.send(&started.id, "go on").unwrap();
        rig.turns(&started.id, 2);

        let unattended = Rig::printing("store-unattended", &[INIT, RESULT]);
        let done = unattended.start(None).unwrap();
        unattended.finish(&done.id);
        // A store the app does not know: nothing is set.
        let scope = Scope {
            title: "Unattended".into(),
            cwd: unattended.dir.clone(),
            add_dirs: vec![],
            policy: Policy::PreApproved { allow: vec![] },
            schema: None,
            plugin_dirs: vec![],
            required_plugin: None,
            mode: Mode::Unattended,
            worktree: None,
            deny: scope::governed_rules(),
        };
        let launch = Launch { memory_root: None, ..unattended.launch(scope) };
        let task = AgentTask::SystemPassport { slug: "billing".into() };
        let id = new_id();
        unattended.manager.start(id.clone(), task, launch, "Describe.", &StartOptions::default()).unwrap();
        unattended.finish(&id);

        let store = Some(rig.dir.join("store"));
        let specs = rig.specs.lock().unwrap();
        assert_eq!(specs.len(), 2);
        for spec in specs.iter() {
            assert_eq!((&spec.memory_root, &spec.deny), (&store, &scope::governed_rules()));
        }
        let specs = unattended.specs.lock().unwrap();
        assert_eq!(specs.len(), 2);
        assert_eq!((&specs[0].memory_root, &specs[0].deny), (&Some(unattended.dir.join("store")), &scope::governed_rules()));
        assert_eq!((&specs[1].memory_root, &specs[1].deny), (&None, &scope::governed_rules()));
    }

    #[test]
    fn process_that_dies_mid_turn_leaves_the_session_idle() {
        let rig = Rig::scripted("dies-mid-turn", &[&["<", INIT]]);
        let started = rig.begin();
        let live = rig.turns(&started.id, 1);
        assert!(matches!(
            &live.last().unwrap().event,
            RunEvent::TurnFinished { ok: false, outcome: TurnEnd::Error, reason: Some(reason), .. } if reason.contains("without reporting a result")
        ));
        assert!(!live.iter().any(|event| matches!(event.event, RunEvent::Finished { .. })));
        assert_eq!(rig.info(&started.id).status, Status::Idle);
        assert_eq!(rig.manager.session(&started.id, 0).unwrap().events, live);
    }

    #[test]
    fn process_that_never_starts_fails_the_session() {
        let nothing: &[&str] = &[];
        let rig = Rig::scripted("never-starts", &[nothing]);
        let started = rig.begin();
        let live = rig.finish(&started.id);
        assert!(matches!(kinds(&live)[..], [RunEvent::UserMessage { .. }, RunEvent::Finished { status: Status::Failed, .. }]));
        let info = rig.info(&started.id);
        assert_eq!((info.status, info.ended_at.is_some()), (Status::Failed, true));
        assert!(info.error.as_deref().is_some_and(|error| error.contains("without reporting a result")));
        assert_eq!(rig.send(&started.id, "again").unwrap_err(), "This session has ended");
    }

    #[test]
    fn idle_session_gives_up_its_process_when_a_slot_is_needed() {
        let rig = Rig::scripted("slots", &[&["<", INIT, RESULT, "<"]]);
        let mut ids = vec![];
        for _ in 0..3 {
            let started = rig.begin();
            rig.turns(&started.id, 1);
            ids.push(started.id);
            // The longest-idle session is the one whose turn ended first.
            std::thread::sleep(Duration::from_millis(10));
        }
        let fourth = rig.begin();
        rig.turns(&fourth.id, 1);
        rig.gone(&ids[0]);
        assert_eq!(rig.info(&ids[0]).status, Status::Idle);
        assert!(!rig.events(&ids[0]).iter().any(|event| matches!(event.event, RunEvent::Finished { .. })));
        for id in &ids[1..] {
            assert!(!rig.manager.inner.wait_gone(id, Duration::ZERO), "only the longest-idle process leaves");
        }
        // Its next message resumes it (and takes a slot from another idle session).
        rig.send(&ids[0], "again").unwrap();
        assert_eq!(rig.specs.lock().unwrap().last().map(|spec| spec.resume), Some(true));

        let lingering = Rig::lingering("slots-unattended");
        for _ in 0..3 {
            lingering.start(None).unwrap();
        }
        assert_eq!(lingering.start(None).unwrap_err(), LIMIT);
    }

    #[test]
    fn session_resumes_after_a_restart_with_the_same_numbering() {
        let rig = Rig::scripted("restart", &[&["<", INIT, TEXT, RESULT, "<"]]);
        let started = rig.begin();
        let before = rig.turns(&started.id, 1);
        rig.manager.stop_all();
        rig.gone(&started.id);

        let (manager, seen, specs) = rig.reopened("restart", &[&["<", INIT, TEXT, RESULT, "<"]]);
        let listed: Vec<(String, Status)> = manager.sessions().into_iter().map(|info| (info.id, info.status)).collect();
        assert_eq!(listed, vec![(started.id.clone(), Status::Idle)]);
        send_on(&manager, &rig, &started.id, "again").unwrap();
        let after = wait_for(&seen, &started.id, "the second turn", |events| turn_count(events) >= 1);
        assert_eq!(specs.lock().unwrap().iter().map(|spec| spec.resume).collect::<Vec<_>>(), vec![true]);
        assert!(matches!(kinds(&after)[..], [RunEvent::UserMessage { .. }, RunEvent::Text { .. }, RunEvent::TurnFinished { .. }]));
        assert_eq!(after.iter().map(|event| event.seq).collect::<Vec<_>>(), vec![4, 5, 6]);
        let all: Vec<SeqEvent> = before.into_iter().chain(after).collect();
        assert_eq!(manager.session(&started.id, 0).unwrap().events, all);
        assert_eq!(manager.session(&started.id, 5).unwrap().events, all[5..]);
        settle(&manager);
    }

    #[test]
    fn end_writes_finished_once_and_refuses_more_messages() {
        let rig = Rig::scripted("end", &[&["<", INIT, RESULT, "<"], &["<", INIT, RESULT]]);
        let started = rig.begin();
        rig.turns(&started.id, 1);
        let start = Instant::now();
        rig.manager.end(&started.id).unwrap();
        assert!(start.elapsed() < END_WAIT, "{:?}", start.elapsed());
        let live = rig.events(&started.id);
        assert!(matches!(
            &live.last().unwrap().event,
            RunEvent::Finished { status: Status::Ended, reason: None, turns: Some(1), cost_usd: Some(_), .. }
        ));
        assert_eq!(live.iter().filter(|event| matches!(event.event, RunEvent::Finished { .. })).count(), 1);
        let info = rig.info(&started.id);
        assert_eq!((info.status, info.error, info.ended_at.is_some()), (Status::Ended, None, true));
        rig.manager.end(&started.id).unwrap();
        assert_eq!(rig.events(&started.id).len(), live.len());
        assert_eq!(rig.send(&started.id, "again").unwrap_err(), "This session has ended");
        assert_eq!(rig.manager.session(&started.id, 0).unwrap().events, live);

        // A session whose process is already gone ends the same way.
        let second = rig.begin();
        rig.turns(&second.id, 1);
        rig.gone(&second.id);
        assert_eq!(rig.info(&second.id).status, Status::Idle);
        rig.manager.end(&second.id).unwrap();
        let live = rig.events(&second.id);
        assert!(matches!(
            &live.last().unwrap().event,
            RunEvent::Finished { status: Status::Ended, reason: None, turns: Some(1), cost_usd: Some(_), .. }
        ));
        assert_eq!(rig.info(&second.id).status, Status::Ended);
        assert_eq!(rig.manager.session(&second.id, 0).unwrap().events, live);

        // Only interactive sessions end this way.
        let unattended = Rig::lingering("end-unattended");
        let background = unattended.start(None).unwrap();
        assert_eq!(
            unattended.manager.end(&background.id).unwrap_err(),
            "Only an interactive session can be ended; stop a background session instead"
        );
        assert_eq!(rig.manager.end("00000000-0000-4000-8000-000000000009").unwrap_err(), "Unknown session");
    }

    #[test]
    fn files_changed_follows_the_worktree() {
        if !git_available() {
            return;
        }
        let rig = Rig::scripted("files", &[&["<", INIT, RESULT, "<", INIT, RESULT, "<", INIT, RESULT, "<"]]);
        let id = new_id();
        let tree = rig.tree(&id);
        rig.start_work(&id, Some(tree.clone()), &StartOptions::default()).unwrap();
        let first = rig.turns(&id, 1);
        assert!(!first.iter().any(|event| matches!(event.event, RunEvent::FilesChanged { .. })));
        assert_eq!(rig.info(&id).files_changed, None);

        std::fs::write(Path::new(&tree.path).join("new.txt"), "hello\n").unwrap();
        rig.send(&id, "write it").unwrap();
        let live = rig.turns(&id, 2);
        assert!(matches!(
            kinds(&live)[first.len()..],
            [RunEvent::UserMessage { .. }, RunEvent::FilesChanged { .. }, RunEvent::TurnFinished { .. }]
        ));
        let RunEvent::FilesChanged { files } = &live[first.len() + 1].event else { panic!("no files") };
        assert_eq!(files.len(), 1);
        assert_eq!((files[0].path.as_str(), files[0].status.as_str(), files[0].added), ("new.txt", "A", 1));
        assert_eq!(rig.info(&id).files_changed, Some(Totals { files: 1, added: 1, removed: 0 }));

        // A turn with no further change reports nothing.
        rig.send(&id, "nothing more").unwrap();
        let third = rig.turns(&id, 3);
        assert!(!third[live.len()..].iter().any(|event| matches!(event.event, RunEvent::FilesChanged { .. })));

        let changed = rig.manager.files(&id).unwrap();
        assert_eq!((changed.files.len(), changed.truncated), (1, false));
        assert!(changed.files[0].diff.contains("+hello"), "{}", changed.files[0].diff);
        assert_eq!(rig.manager.files("00000000-0000-4000-8000-000000000009").unwrap_err(), "Unknown session");
        assert_eq!(rig.manager.remove_worktree(&id).unwrap_err(), "End the session before removing its worktree");

        rig.manager.end(&id).unwrap();
        let info = rig.info(&id);
        assert_eq!(info.status, Status::Ended);
        assert!(info.worktree.is_some() && Path::new(&tree.path).is_dir(), "a worktree with changes is kept");
        rig.manager.remove_worktree(&id).unwrap();
        let info = rig.info(&id);
        assert_eq!((info.worktree, info.files_changed), (None, None));
        assert!(!Path::new(&tree.path).exists());
        assert_eq!(rig.manager.remove_worktree(&id).unwrap_err(), "This session has no worktree");

        // A session that changed nothing leaves nothing behind when it ends.
        let clean_id = new_id();
        let clean = rig.tree(&clean_id);
        rig.start_work(&clean_id, Some(clean.clone()), &StartOptions::default()).unwrap();
        rig.turns(&clean_id, 1);
        rig.manager.end(&clean_id).unwrap();
        assert_eq!(rig.info(&clean_id).worktree, None);
        assert!(!Path::new(&clean.path).exists());
    }

    #[test]
    fn a_different_file_with_the_same_counts_is_a_new_event() {
        if !git_available() {
            return;
        }
        let rig = Rig::scripted("same-counts", &[&["<", INIT, RESULT, "<", INIT, RESULT, "<", INIT, RESULT, "<"]]);
        let id = new_id();
        let tree = rig.tree(&id);
        let dir = Path::new(&tree.path);
        let one = Some(Totals { files: 1, added: 1, removed: 0 });
        let changed = |events: &[SeqEvent]| -> Vec<Vec<String>> {
            events
                .iter()
                .filter_map(|event| match &event.event {
                    RunEvent::FilesChanged { files } => Some(files.iter().map(|file| file.path.clone()).collect()),
                    _ => None,
                })
                .collect()
        };
        std::fs::write(dir.join("one.txt"), "x\n").unwrap();
        rig.start_work(&id, Some(tree.clone()), &StartOptions::default()).unwrap();
        let live = rig.turns(&id, 1);
        assert_eq!(changed(&live), vec![vec!["one.txt".to_string()]]);
        assert_eq!(rig.info(&id).files_changed, one);

        std::fs::remove_file(dir.join("one.txt")).unwrap();
        std::fs::write(dir.join("two.txt"), "y\n").unwrap();
        rig.send(&id, "swap").unwrap();
        let live = rig.turns(&id, 2);
        assert_eq!(changed(&live), vec![vec!["one.txt".to_string()], vec!["two.txt".to_string()]]);
        assert_eq!(rig.info(&id).files_changed, one);

        rig.send(&id, "same").unwrap();
        let live = rig.turns(&id, 3);
        assert_eq!(changed(&live).len(), 2);
        assert_eq!(rig.info(&id).files_changed, one);

        // After a restart the last list is counted from the log.
        rig.manager.stop_all();
        rig.gone(&id);
        let (manager, seen, _) = rig.reopened("same-counts", &[&["<", INIT, RESULT, "<", INIT, RESULT, "<"]]);
        send_on(&manager, &rig, &id, "after the restart").unwrap();
        let restarted = wait_for(&seen, &id, "a turn", |events| turn_count(events) >= 1);
        assert!(changed(&restarted).is_empty(), "{restarted:?}");
        std::fs::write(dir.join("three.txt"), "z\n").unwrap();
        send_on(&manager, &rig, &id, "one more").unwrap();
        let restarted = wait_for(&seen, &id, "a second turn", |events| turn_count(events) >= 2);
        assert_eq!(changed(&restarted), vec![vec!["three.txt".to_string(), "two.txt".to_string()]]);
        settle(&manager);
    }

    #[test]
    fn files_written_before_the_process_dies_are_reported() {
        if !git_available() {
            return;
        }
        let nothing: &[&str] = &[];
        let rig = Rig::scripted("dies-with-files", &[&["<", INIT], &["<", INIT, "<"], nothing]);
        let listed =
            |live: &[SeqEvent]| live.iter().filter(|event| matches!(&event.event, RunEvent::FilesChanged { files } if files.len() == 1)).count();
        let begin = |id: &str| {
            let tree = rig.tree(id);
            std::fs::write(Path::new(&tree.path).join("work.txt"), "w\n").unwrap();
            rig.start_work(id, Some(tree), &StartOptions::default()).unwrap();
        };

        // (a) the process ends in the middle of a turn
        let a = new_id();
        begin(&a);
        let live = rig.turns(&a, 1);
        let all = kinds(&live);
        assert!(matches!(all[all.len() - 2..], [RunEvent::FilesChanged { .. }, RunEvent::TurnFinished { outcome: TurnEnd::Error, .. }]), "{live:?}");
        assert_eq!((listed(&live), rig.info(&a).files_changed.map(|totals| totals.files)), (1, Some(1)));
        assert_eq!(rig.manager.session(&a, 0).unwrap().events, live);

        // (b) the session is cancelled
        let b = new_id();
        begin(&b);
        wait_for(&rig.seen, &b, "started", |events| events.iter().any(|event| matches!(event.event, RunEvent::Started { .. })));
        rig.manager.cancel(&b).unwrap();
        let live = rig.finish(&b);
        let all = kinds(&live);
        assert!(matches!(all[all.len() - 2..], [RunEvent::FilesChanged { .. }, RunEvent::Finished { status: Status::Cancelled, .. }]), "{live:?}");
        assert_eq!((listed(&live), rig.info(&b).files_changed.map(|totals| totals.files)), (1, Some(1)));
        assert_eq!(rig.manager.session(&b, 0).unwrap().events, live);

        // (c) the process never starts
        let c = new_id();
        begin(&c);
        let live = rig.finish(&c);
        assert!(matches!(
            kinds(&live)[..],
            [RunEvent::UserMessage { .. }, RunEvent::FilesChanged { .. }, RunEvent::Finished { status: Status::Failed, .. }]
        ));
        assert_eq!(rig.info(&c).files_changed.map(|totals| totals.files), Some(1));
        assert_eq!(rig.manager.session(&c, 0).unwrap().events, live);
    }

    #[test]
    fn policy_changes_reach_the_process_and_the_next_one() {
        let rig = Rig::scripted("policy", &[&["<", INIT, RESULT, "<", "<"]]);
        let started = rig.begin();
        rig.turns(&started.id, 1);
        rig.manager.set_policy(&started.id, PolicyMode::AcceptEdits).unwrap();
        assert_eq!(rig.info(&started.id).policy, PolicyMode::AcceptEdits);
        let start = Instant::now();
        while rig.stdin_lines(&started.id).len() < 2 {
            assert!(start.elapsed() < Duration::from_secs(20), "the mode never arrived");
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(rig.stdin_lines(&started.id)[1]["request"], json!({"subtype": "set_permission_mode", "mode": "acceptEdits"}));
        assert_eq!(rig.manager.set_policy(&started.id, PolicyMode::PreApproved).unwrap_err(), "Unknown policy");
        rig.manager.end(&started.id).unwrap();
        assert_eq!(rig.manager.set_policy(&started.id, PolicyMode::Ask).unwrap_err(), "This session has ended");
    }
}
