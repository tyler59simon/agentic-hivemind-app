//! Coding-agent sessions: a CLI run as a background child process whose output is logged,
//! normalised into events for the UI, and kept as history. The unit is a session: an unattended one is a single
//! prompt, an interactive one takes messages until it is ended, and either may use a process of its own at a time.
pub mod access;
pub mod claude;
pub mod direct;
pub mod events;
pub mod models;
pub mod scope;
pub mod store;

use crate::bridge::Bridge;
use access::Access;
use crate::settings::Settings;
use crate::worktree::{self, ChangedFiles, FileChange, Totals, Worktree};
use direct::Direct;
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
const MAX_OUTPUT: usize = 400_000; // characters of one tool result that `tool_output` returns
const RESERVED: &str = "A review action is running for this session";
const BUSY: &str = "This session is busy";
const ALREADY_RESERVED: &str = "A review action is already running for this session";

/// Which coding-agent CLI a session uses. `SessionInfo.adapter` stores the adapter's name; this is the same fact as a type.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum Engine {
    #[default]
    Claude,
    Codex,
}

impl Engine {
    /// The engine of a stored session. Anything that is not Codex is Claude Code, whatever name Phase 1 or 2 stored.
    pub fn of(adapter: &str) -> Engine {
        if adapter == "codex" { Engine::Codex } else { Engine::Claude }
    }

    /// What `SessionInfo.adapter` holds for a new session.
    pub fn adapter_name(self) -> &'static str {
        match self {
            Engine::Claude => claude::ClaudeCode.name(),
            Engine::Codex => "codex",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Engine::Claude => "Claude Code",
            Engine::Codex => "Codex",
        }
    }
}

/// How the user talks to a session.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Interface {
    #[default]
    Chat,
    Terminal,
}

/// Whether a Codex session may use the Chat interface. Part C turns this on.
pub const CODEX_CHAT: bool = false;

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
    /// The whole text and the outcome of the tool result with this id, when the line carries it.
    fn tool_result(&self, _line: &str, _tool_use_id: &str) -> Option<(bool, String)> {
        None
    }
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
    // Phase 4
    /// The user's decision about the proposed edits. None reads as "pending".
    #[serde(default)]
    pub review: Option<Review>,
    /// For a passport session: the repository's HEAD when it succeeded.
    #[serde(default)]
    pub source_sha: Option<String>,
    // Phase 5
    /// README 7.1. Default `chat`, so older indexes load.
    #[serde(default)]
    pub interface: Interface,
    // Phase 6
    /// The name the user gave the session; shown first on its tab.
    #[serde(default)]
    pub name: Option<String>,
    /// The title the CLI gave its conversation (filled from the CLI's own files).
    #[serde(default)]
    pub cli_title: Option<String>,
    /// Set when the session runs in a folder of the user's own (the project checkout or another folder), not in a
    /// worktree of Hivemind's. Such a session has no `worktree`.
    #[serde(default)]
    pub direct: Option<Direct>,
    /// A terminal session started with an empty task: the CLI gets no first prompt.
    #[serde(default)]
    pub no_task: bool,
    /// What a terminal session may do without asking. None (a session from before the modes): the old `policy` decides.
    #[serde(default)]
    pub access: Option<Access>,
    /// The reasoning effort a terminal session was started with; None leaves it to the CLI.
    #[serde(default)]
    pub effort: Option<String>,
    /// The CLI's own id for the conversation, when Hivemind cannot choose it (Codex's thread id).
    #[serde(default)]
    pub engine_session: Option<String>,
}

/// What the user decided about a work session's edits.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ReviewState {
    Pending,
    Approved,
    ChangesRequested,
    Dismissed,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Review {
    pub state: ReviewState,
    /// The commit an approval made (or found); None in every other state.
    pub commit: Option<String>,
    /// When the state last changed, in milliseconds since the epoch.
    pub at: u64,
}

/// What a finished turn does to the review decision: an answer to "request changes", or a different set of edits, puts
/// the session back in the queue.
pub fn review_after_turn(review: Option<Review>, before: Option<&Totals>, after: Option<&Totals>, now: u64) -> Option<Review> {
    let reopened = Some(Review { state: ReviewState::Pending, commit: None, at: now });
    match review.as_ref().map(|review| review.state) {
        Some(ReviewState::ChangesRequested) => reopened,
        Some(ReviewState::Approved | ReviewState::Dismissed)
            if after.is_some_and(|after| after.files > 0 && *after != before.copied().unwrap_or_default()) =>
        {
            reopened
        }
        _ => review,
    }
}

/// The full text of one tool result, read back from the raw log.
#[derive(Serialize, Debug, PartialEq)]
pub struct ToolOutput {
    pub text: String,
    pub ok: bool,
    /// The text was longer than MAX_OUTPUT characters; its end is kept.
    pub truncated: bool,
}

/// What `agent_start` may be told besides the task and the prompt.
#[derive(Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
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
    #[serde(default)]
    pub engine: Engine,
    #[serde(default)]
    pub interface: Interface,
    /// Where a work session runs. None: the checkout for a terminal, a worktree for a chat.
    #[serde(default)]
    pub place: Option<Place>,
    /// Terminal only: the CLI's own permission settings. None: the ones `policy` stands for.
    #[serde(default)]
    pub access: Option<Access>,
    /// Terminal only: the reasoning effort.
    #[serde(default)]
    pub effort: Option<String>,
    /// The user ticked the box that starts a session whose settings never ask.
    #[serde(default)]
    pub confirmed_risky: bool,
}

/// Where a work session runs.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Place {
    /// A new worktree of Hivemind's, on a branch of its own.
    Worktree,
    /// The project's registered repository folder itself.
    Checkout,
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

/// Holds one session for a review action. While it lives, nothing else may start a turn in the session, end it or remove
/// its worktree. Dropping it releases the session.
pub struct Reservation {
    inner: Arc<Inner>,
    id: String,
}

impl Reservation {
    pub fn id(&self) -> &str {
        &self.id
    }
}

impl Drop for Reservation {
    fn drop(&mut self) {
        // A destructor must not panic, so a poisoned mutex is taken as it is.
        let mut sessions = self.inner.sessions.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(session) = sessions.get_mut(&self.id) {
            session.reserved = false;
        }
    }
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
    /// A review action holds this session: no turn may start and it may not be ended or lose its worktree. Memory only.
    reserved: bool,
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

pub(crate) fn now_ms() -> u64 {
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

/// The text of a session's first message: the briefing, a rule, and what the user typed. A later message has the same shape.
pub fn first_text(briefing: Option<&str>, prompt: &str) -> String {
    match briefing {
        Some(briefing) => format!("{briefing}\n\n---\n\n{prompt}"),
        None => prompt.to_string(),
    }
}

/// A new session as it is first listed, before it has a process.
fn session_info(id: &str, adapter: &str, task: AgentTask, scope: &Scope, options: &StartOptions) -> SessionInfo {
    let interactive = scope.mode == Mode::Interactive;
    SessionInfo {
        id: id.to_string(),
        adapter: adapter.to_string(),
        cli_version: None,
        project: match &task {
            AgentTask::Work { project, .. } => Some(project.clone()),
            AgentTask::SystemPassport { .. } | AgentTask::Folder { .. } => None,
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
        review: None,
        source_sha: None,
        interface: Interface::Chat,
        name: None,
        cli_title: None,
        direct: None,
        no_task: false,
        access: None,
        effort: None,
        engine_session: None,
    }
}

/// Refuse the combinations of task, engine and interface that cannot be started.
/// The most characters a session name keeps.
pub const NAME_MAX: usize = 80;

/// A session name as stored: trimmed, at most `NAME_MAX` characters; None when empty.
pub fn clean_name(name: &str) -> Option<String> {
    let name: String = name.trim().chars().take(NAME_MAX).collect();
    let name = name.trim_end().to_string();
    (!name.is_empty()).then_some(name)
}

fn check_combination(task: &AgentTask, engine: Engine, interface: Interface) -> Result<(), String> {
    let work = matches!(task, AgentTask::Work { .. });
    let folder = matches!(task, AgentTask::Folder { .. });
    if folder && interface != Interface::Terminal {
        return Err("A session in another folder runs in the terminal.".into());
    }
    if interface == Interface::Terminal && !work && !folder {
        return Err("A terminal session needs a project repository.".into());
    }
    if engine == Engine::Codex && !work && !folder {
        return Err("System passports run with Claude Code.".into());
    }
    if engine == Engine::Codex && interface == Interface::Chat && !CODEX_CHAT {
        return Err("Chat with Codex is not available yet. Use Terminal.".into());
    }
    Ok(())
}

impl Manager {
    /// Load the history from `dir`. Sessions left running by a previous run are closed as failed (unattended) or idle.
    pub fn new(dir: PathBuf, adapter: Arc<dyn Adapter>, sink: Sink) -> Manager {
        let sessions =
            store::recover(&dir, now_ms()).into_iter().map(|info| (info.id.clone(), Session { info, reserved: false, live: None, tape: None })).collect();
        Manager { inner: Arc::new(Inner { dir, adapter, sink, sessions: Mutex::new(sessions) }) }
    }

    /// Start a session in `launch.scope` and send it `prompt`. Returns as soon as the process is running.
    pub fn start(&self, id: String, task: AgentTask, launch: Launch, prompt: &str, options: &StartOptions) -> Result<SessionInfo, String> {
        let inner = &self.inner;
        let scope = &launch.scope;
        let interactive = scope.mode == Mode::Interactive;
        let info = session_info(&id, inner.adapter.name(), task, scope, options);

        // Without its folder a session could not be logged or replayed, so find that out first.
        std::fs::create_dir_all(&inner.dir).map_err(|e| format!("Could not create {}: {e}", inner.dir.display()))?;
        let mut sessions = inner.sessions.lock().unwrap();
        inner.free_slot(&mut sessions)?;
        let (live, stdout, stderr) = inner.spawn(&id, &launch, false, info.model.clone())?;
        let (child, stdin) = (live.child.clone(), live.stdin.clone());
        sessions.insert(id.clone(), Session { info: info.clone(), reserved: false, live: Some(live), tape: Some(Tape::default()) });
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
        let _ = write(&stdin, &inner.adapter.user_line(&first_text(options.briefing.as_deref().filter(|_| interactive), prompt)));
        if !interactive {
            // Closing stdin is what makes this a one-prompt session: the CLI exits when the work is done.
            *stdin.lock().unwrap() = None;
        }
        Ok(info)
    }

    /// Add a session that has no headless process (a terminal session). Saves the index and tells the UI.
    pub fn register(&self, info: SessionInfo) -> Result<SessionInfo, String> {
        let inner = &self.inner;
        std::fs::create_dir_all(&inner.dir).map_err(|e| format!("Could not create {}: {e}", inner.dir.display()))?;
        let mut sessions = inner.sessions.lock().unwrap();
        sessions.insert(info.id.clone(), Session { info: info.clone(), reserved: false, live: None, tape: None });
        let saved = inner.persist(&mut sessions);
        drop(sessions);
        (inner.sink)(Emit::SessionsChanged);
        saved.map_err(|e| format!("Could not save the session list: {e}"))?;
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
        held: Option<&Reservation>,
    ) -> Result<(), String> {
        let inner = &self.inner;
        store::log_path(&inner.dir, id)?;
        if text.trim().is_empty() {
            return Err("Write a message first".into());
        }
        let line = inner.adapter.user_line(&first_text(options.briefing.as_deref(), text));
        let mut sessions = inner.sessions.lock().unwrap();
        if sessions.get(id).is_some_and(|session| session.info.interface == Interface::Terminal) {
            return Err("This session runs in the terminal. Resume it there and type your request.".into());
        }
        let info = Inner::askable(&sessions, id)?;
        if sessions.get(id).is_some_and(|session| session.reserved) && held.is_none_or(|h| h.id() != id) {
            return Err(RESERVED.into());
        }
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
                if sessions.get(id).is_some_and(|session| session.reserved) && held.is_none_or(|h| h.id() != id) {
                    return Err(RESERVED.into());
                }
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
            if session.info.interface == Interface::Terminal {
                return Err("This session runs in the terminal. Stop it there.".into());
            }
            if session.reserved {
                return Err(RESERVED.into());
            }
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
        if session.info.interface == Interface::Terminal {
            return Err("A terminal session keeps the permission mode it was started with.".into());
        }
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
            inner.update(id, |info| {
                info.review = review_after_turn(info.review.take(), info.files_changed.as_ref(), total.as_ref(), now_ms());
                info.files_changed = total;
            });
        }
        Ok(files)
    }

    /// Remove the worktree of a session that has ended.
    pub fn remove_worktree(&self, id: &str) -> Result<(), String> {
        let inner = &self.inner;
        store::log_path(&inner.dir, id)?;
        if inner.sessions.lock().unwrap().get(id).is_some_and(|session| session.reserved) {
            return Err(RESERVED.into());
        }
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

    /// One session's details, as listed.
    pub fn info(&self, id: &str) -> Result<SessionInfo, String> {
        store::log_path(&self.inner.dir, id)?;
        self.inner.sessions.lock().unwrap().get(id).map(|session| session.info.clone()).ok_or_else(|| "Unknown session".into())
    }

    /// Change a session's details, save the index and tell the UI. A failed save is an error: the change then lives only
    /// in memory and is gone after a restart (for an approval, its review base with it).
    pub fn amend(&self, id: &str, change: impl FnOnce(&mut SessionInfo)) -> Result<SessionInfo, String> {
        self.amend_checked(id, None, change)
    }

    /// `amend`, refused with `refusal` while a review action holds the session. The check and the change happen under one
    /// lock, so a review action cannot reserve the session between them.
    pub fn amend_unreserved(&self, id: &str, refusal: &str, change: impl FnOnce(&mut SessionInfo)) -> Result<SessionInfo, String> {
        self.amend_checked(id, Some(refusal), change)
    }

    fn amend_checked(&self, id: &str, refusal: Option<&str>, change: impl FnOnce(&mut SessionInfo)) -> Result<SessionInfo, String> {
        let inner = &self.inner;
        store::log_path(&inner.dir, id)?;
        let mut sessions = inner.sessions.lock().unwrap();
        let session = sessions.get_mut(id).ok_or("Unknown session")?;
        if let Some(refusal) = refusal.filter(|_| session.reserved) {
            return Err(refusal.to_string());
        }
        change(&mut session.info);
        let info = session.info.clone();
        let saved = inner.persist(&mut sessions);
        drop(sessions);
        (inner.sink)(Emit::SessionsChanged);
        saved.map_err(|e| format!("Could not save the session list: {e}"))?;
        Ok(info)
    }

    /// The full text of one tool result, read back from the raw log. The summary in the event is clipped from the start; a
    /// test run's totals are at the end, so only the end of a very long result is kept.
    pub fn tool_output(&self, id: &str, tool_use_id: &str) -> Result<ToolOutput, String> {
        self.info(id)?;
        let records = store::read_log(&self.inner.dir, id)?;
        let found = records.iter().rev().find_map(|record| match record {
            Record::Raw { raw, .. } => self.inner.adapter.tool_result(raw, tool_use_id),
            Record::Event { .. } => None,
        });
        let (ok, text) = found.ok_or("That tool call has no result in this session's log")?;
        let length = text.chars().count();
        if length <= MAX_OUTPUT {
            return Ok(ToolOutput { text, ok, truncated: false });
        }
        Ok(ToolOutput { text: text.chars().skip(length - MAX_OUTPUT).collect(), ok, truncated: true })
    }

    /// Whether a review action holds the session.
    pub fn is_reserved(&self, id: &str) -> bool {
        self.inner.sessions.lock().unwrap().get(id).is_some_and(|session| session.reserved)
    }

    /// Reserve a session for one review action: it must not be mid-turn or already reserved.
    pub fn reserve(&self, id: &str) -> Result<Reservation, String> {
        store::log_path(&self.inner.dir, id)?;
        let mut sessions = self.inner.sessions.lock().unwrap();
        let session = sessions.get_mut(id).ok_or("Unknown session")?;
        if matches!(session.info.status, Status::Running | Status::Waiting) {
            return Err(BUSY.into());
        }
        if session.reserved {
            return Err(ALREADY_RESERVED.into());
        }
        session.reserved = true;
        Ok(Reservation { inner: self.inner.clone(), id: id.to_string() })
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
            // A terminal session has no headless process and its own limit (decision D14).
            let holding = |session: &Session| {
                session.info.interface == Interface::Chat
                    && session.live.as_ref().is_some_and(|live| match session.info.status {
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
        let review = review_after_turn(session.info.review.clone(), session.info.files_changed.as_ref(), new.as_ref(), now_ms());
        let reopened = session.info.review != review;
        session.info.review = review;
        session.info.files_changed = new;
        if listed {
            let at = now_ms();
            self.record(&mut sessions, id, at, Record::Event { at, event: RunEvent::FilesChanged { files } });
        }
        if listed || recounted || reopened {
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

        // A system passport records the commit its output was generated from. The first of `workspace` is the system's
        // first repository and the last is its architecture folder (`scope.rs` builds it in that order).
        let passport = self.sessions.lock().unwrap().get(id).and_then(|session| match &session.info.task {
            AgentTask::SystemPassport { slug } => {
                Some((slug.clone(), session.info.workspace.first().cloned(), session.info.workspace.last().cloned()))
            }
            _ => None,
        });
        let head = passport.as_ref().and_then(|(_, repo, _)| repo.as_ref()).and_then(|repo| crate::git::head_sha(Path::new(repo)).ok());
        let mut succeeded = false;

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
                succeeded = session.info.status == Status::Succeeded;
                if succeeded {
                    session.info.source_sha = head.clone();
                }
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
        if let (true, Some((slug, _, Some(folder)))) = (succeeded, &passport) {
            // A snapshot that cannot be saved is not a session failure.
            let _ = crate::architecture::save_snapshot(&crate::architecture::snapshots_root(&self.dir), slug, id, at, head.as_deref(), Path::new(folder));
        }
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

/// Refuse a model, effort or permission setting the engine does not have; a terminal session gets its access resolved.
/// A chat session takes none of the terminal's settings, and a system passport keeps the model check it always had.
fn check_launch_options(saved: &Settings, mut options: StartOptions) -> Result<StartOptions, String> {
    if options.interface == Interface::Terminal {
        // Codex's list comes from running Codex, so it is only asked for when there is something to check.
        if options.model.is_some() || options.effort.is_some() {
            models::check(&models::list(options.engine, saved), options.model.as_deref(), options.effort.as_deref())?;
        }
        let policy = options.policy.unwrap_or(PolicyMode::Ask);
        options.access = Some(Access::resolve(options.engine, options.access, policy, options.confirmed_risky)?);
    } else {
        if options.access.is_some() || options.effort.is_some() {
            return Err("Permission modes and effort are for terminal sessions.".into());
        }
        models::check(&models::list(Engine::Claude, saved), options.model.as_deref(), None)?;
    }
    Ok(options)
}

/// Where a work session runs, from what the user asked for and the interface.
fn place_of(options: &StartOptions) -> Result<Place, String> {
    match (options.place, options.interface) {
        (Some(Place::Checkout), Interface::Chat) => Err("A chat session always works in a worktree.".into()),
        (Some(Place::Worktree) | None, Interface::Chat) | (Some(Place::Worktree), Interface::Terminal) => Ok(Place::Worktree),
        (Some(Place::Checkout) | None, Interface::Terminal) => Ok(Place::Checkout),
    }
}

/// The title of a session started with no task: the engine and the folder's name.
fn bare_title(engine: Engine, folder: &Path) -> String {
    let name = folder.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_else(|| folder.display().to_string());
    format!("{} \u{b7} {name}", engine.label())
}

/// List a terminal session at rest, with its briefing written; the program starts when the terminal is opened.
#[allow(clippy::too_many_arguments)] // each argument is one independent part of the new session
fn register_terminal(
    manager: &Manager,
    terminals: &Path,
    id: &str,
    task: AgentTask,
    scope: &Scope,
    direct: Option<Direct>,
    prompt: &str,
    options: &StartOptions,
) -> Result<SessionInfo, String> {
    let mut info = session_info(id, options.engine.adapter_name(), task, scope, options);
    info.status = Status::Idle;
    info.interface = Interface::Terminal;
    info.direct = direct;
    info.no_task = prompt.trim().is_empty();
    info.access = options.access;
    info.effort = options.effort.clone();
    let context = crate::term::write_briefing(terminals, id, &first_text(options.briefing.as_deref(), prompt))?;
    info.workspace.push(context.display().to_string());
    manager.register(info)
}

/// Start a terminal session in `folder` itself: no worktree is made, and nothing here changes the folder. When it is
/// inside a git work tree, the files it holds now are recorded so a later review can tell what the session changed.
fn start_direct(manager: &Manager, terminals: &Path, id: &str, task: AgentTask, folder: &Path, prompt: &str, options: &StartOptions) -> Result<SessionInfo, String> {
    if !folder.is_dir() {
        return Err(format!("The folder does not exist: {}", folder.display()));
    }
    let title = if prompt.trim().is_empty() { bare_title(options.engine, folder) } else { scope::task_title(prompt) };
    let scope = scope::direct(folder, options.policy.unwrap_or(PolicyMode::Ask), title)?;
    register_terminal(manager, terminals, id, task, &scope, Some(direct::describe(folder)), prompt, options)
}

/// Work out what `task` may touch (from Living Memory and the settings), then start its session. A work session in a
/// worktree gets one of its own first, which is removed again when the session cannot start. A terminal session may run
/// in the project's checkout or in a picked folder instead; nothing is created or removed for those.
#[allow(clippy::too_many_arguments)] // the signature section 6.6 of the Phase 5 plan fixes
pub fn start_task(
    manager: &Manager,
    bridge: &Bridge,
    saved: &Settings,
    worktrees: &Path,
    terminals: &Path,
    task: AgentTask,
    prompt: &str,
    options: StartOptions,
) -> Result<SessionInfo, String> {
    check_combination(&task, options.engine, options.interface)?;
    let terminal = options.interface == Interface::Terminal;
    let options = check_launch_options(saved, options)?;
    // A terminal session starts no process here; the lookup only reports a missing CLI on the Start screen.
    let program = if terminal { crate::term::launch::program(options.engine, saved).map(|_| String::new())? } else { claude::available(saved)? };
    let id = uuid::Uuid::new_v4().to_string();
    let launch = |scope| Launch { scope, program: program.clone(), budget_usd: saved.agent_budget_usd(), memory_root: bridge.launch().root };
    let (project, repo, branch, change) = match &task {
        AgentTask::Work { project, repo, branch, change } => (project, repo, branch, change),
        AgentTask::Folder { path } => {
            let folder = scope::other_folder(saved, path)?;
            return start_direct(manager, terminals, &id, task.clone(), &folder, prompt, &options);
        }
        AgentTask::SystemPassport { .. } => {
            let home = dirs::home_dir().ok_or("Could not find your home folder")?;
            let scope = scope::for_task(bridge, &task, saved, &home)?;
            return manager.start(id, task, launch(scope), prompt, &options);
        }
    };
    let place = place_of(&options)?;
    // A terminal can start bare; a chat session needs its first message.
    if prompt.trim().is_empty() && !terminal {
        return Err("Write a task for the session first".into());
    }
    let policy = options.policy.unwrap_or(PolicyMode::Ask);
    let entry = crate::git::project_entry(bridge, project)?;
    let repo = scope::project_repo(&entry, repo)?;
    if let Some(id) = change {
        scope::check_change(&scope::change_entry(bridge, *id)?, project, &repo.to_string_lossy())?;
    }
    if place == Place::Checkout {
        return start_direct(manager, terminals, &id, task.clone(), &repo, prompt, &options);
    }
    let tree = worktree::create(worktrees, &repo, branch.as_deref(), &id)?;
    let started = scope::work(tree.clone(), policy, prompt).and_then(|mut scope| {
        if !terminal {
            return manager.start(id.clone(), task.clone(), launch(scope), prompt, &options);
        }
        if prompt.trim().is_empty() {
            scope.title = bare_title(options.engine, &repo);
        }
        register_terminal(manager, terminals, &id, task.clone(), &scope, None, prompt, &options)
    });
    if started.is_err() {
        let _ = worktree::remove(&tree);
    }
    started
}

/// The task an imported CLI conversation runs under: the project checkout or a folder from the picker. A session target
/// is refused (nothing is imported into a session's own folder), and so is an id that is not a plain conversation id.
pub fn import_task(cli_id: &str, target: &crate::term::ShellTarget) -> Result<AgentTask, String> {
    use crate::term::ShellTarget;
    if !crate::term::cli_files::valid_id(cli_id) {
        return Err("That is not a conversation id".into());
    }
    match target {
        ShellTarget::Checkout { project, repo } => Ok(AgentTask::Work { project: project.clone(), repo: repo.clone(), branch: None, change: None }),
        ShellTarget::Folder(path) => Ok(AgentTask::Folder { path: path.clone() }),
        ShellTarget::Session(_) => Err("Pick a project or a folder".into()),
    }
}

/// Make a terminal session of a conversation a CLI saved: a direct session with no task, bound to the conversation and
/// titled with the CLI's title. The terminal opens it in Resume mode. `options` carries the access, model and effort.
#[allow(clippy::too_many_arguments)] // the same independent parts as start_task, plus the conversation
pub fn import_session(
    manager: &Manager,
    bridge: &Bridge,
    saved: &Settings,
    worktrees: &Path,
    terminals: &Path,
    cli_id: &str,
    title: &str,
    target: &crate::term::ShellTarget,
    options: StartOptions,
) -> Result<SessionInfo, String> {
    let task = import_task(cli_id, target)?;
    let options = StartOptions { interface: Interface::Terminal, place: Some(Place::Checkout), ..options };
    let started = start_task(manager, bridge, saved, worktrees, terminals, task, "", options)?;
    manager.amend(&started.id, |info| {
        info.engine_session = Some(cli_id.to_string());
        info.title = title.to_string();
        info.cli_title = Some(title.to_string());
    })
}

/// Send a message to a session, starting a process for it again when it has none.
pub fn send_task(
    manager: &Manager,
    bridge: &Bridge,
    saved: &Settings,
    id: &str,
    text: &str,
    options: SendOptions,
    held: Option<&Reservation>,
) -> Result<(), String> {
    manager.send(
        id,
        text,
        options,
        |info| {
            Ok(Launch {
                scope: scope::for_session(bridge, info)?,
                program: claude::available(saved)?,
                budget_usd: saved.agent_budget_usd(),
                memory_root: bridge.launch().root,
            })
        },
        held,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use claude::ClaudeCode;
    use scope::Policy;
    use serde_json::json;
    use std::time::Instant;

    #[test]
    fn engine_serialises_in_lowercase() {
        assert_eq!(serde_json::to_value(Engine::Codex).unwrap(), json!("codex"));
        assert_eq!(serde_json::to_value(Engine::Claude).unwrap(), json!("claude"));
        assert_eq!(Engine::default(), Engine::Claude);
        assert_eq!(Engine::of("codex"), Engine::Codex);
        assert_eq!(Engine::of("claude-code"), Engine::Claude);
        assert_eq!(Engine::of("claude"), Engine::Claude);
        assert_eq!(Engine::Claude.adapter_name(), "claude-code");
        assert_eq!(Engine::Codex.label(), "Codex");
    }

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
        fn tool_result(&self, line: &str, id: &str) -> Option<(bool, String)> {
            ClaudeCode.tool_result(line, id)
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
        manager.send(id, text, SendOptions::default(), |info| Ok(rig.launch(rig.scope(info.worktree.clone()))), None)
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
    fn a_succeeded_passport_records_its_source_and_a_snapshot() {
        if !git_available() {
            return;
        }
        let lines: Vec<&str> = [BARE_INIT].into_iter().chain(WORK).chain([RESULT]).collect();
        let repo_with_model = |rig: &Rig| {
            sh(&rig.dir, &["init", "-q"]);
            sh(&rig.dir, &["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "one"]);
            std::fs::create_dir_all(rig.dir.join("arch")).unwrap();
            std::fs::write(rig.dir.join("arch/architecture-model.json"), r#"{"schema_version":"2.0","elements":[]}"#).unwrap();
        };
        let snapshots = |rig: &Rig| crate::architecture::list_snapshots(&crate::architecture::snapshots_root(&rig.dir.join("sessions")), "billing").unwrap();

        let rig = Rig::printing("passport-source", &lines);
        repo_with_model(&rig);
        let started = rig.start(None).unwrap();
        rig.finish(&started.id);
        let head = crate::git::head_sha(&rig.dir).unwrap();
        let info = rig.info(&started.id);
        assert_eq!((info.status, info.source_sha.as_deref()), (Status::Succeeded, Some(head.as_str())));
        let listed = snapshots(&rig);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].session_id, started.id);

        let failing = Rig::printing("passport-source-fails", &lines);
        repo_with_model(&failing);
        let started = failing.start(Some("architecture-suite")).unwrap();
        failing.finish(&started.id);
        assert_eq!((failing.info(&started.id).status, failing.info(&started.id).source_sha), (Status::Failed, None));
        assert!(snapshots(&failing).is_empty());
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

    #[test]
    fn tool_output_is_read_from_the_log() {
        let rig = Rig::printing("tool-output", &WORK);
        let started = rig.start(None).unwrap();
        rig.finish(&started.id);
        assert_eq!(
            rig.manager.tool_output(&started.id, "toolu_01"),
            Ok(ToolOutput { text: "print('hi') # 100% <ok> | done".into(), ok: true, truncated: false })
        );
        assert_eq!(
            rig.manager.tool_output(&started.id, "toolu_99"),
            Err("That tool call has no result in this session's log".to_string())
        );
        assert_eq!(rig.manager.tool_output("../index", "toolu_01"), Err("Invalid session id".to_string()));
        assert_eq!(rig.manager.tool_output("00000000-0000-4000-8000-000000000009", "toolu_01"), Err("Unknown session".to_string()));

        // A result above MAX_OUTPUT keeps its end.
        let long = format!("{}{}", "a".repeat(10), "é".repeat(MAX_OUTPUT));
        let line = json!({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "toolu_07", "content": long, "is_error": true}]}}).to_string();
        let big = Rig::printing("tool-output-big", &[line.as_str()]);
        let started = big.start(None).unwrap();
        big.finish(&started.id);
        let output = big.manager.tool_output(&started.id, "toolu_07").unwrap();
        assert_eq!((output.ok, output.truncated, output.text.chars().count()), (false, true, MAX_OUTPUT));
        assert!(output.text.chars().all(|c| c == 'é'));
    }

    #[test]
    fn review_json_is_the_contract_shape() {
        let review = Review { state: ReviewState::ChangesRequested, commit: None, at: 5 };
        let text = serde_json::to_string(&review).unwrap();
        assert_eq!(text, r#"{"state":"changes_requested","commit":null,"at":5}"#);
        assert_eq!(serde_json::from_str::<Review>(&text).unwrap(), review);
        let states = [ReviewState::Pending, ReviewState::Approved, ReviewState::ChangesRequested, ReviewState::Dismissed];
        let names: Vec<String> = states.iter().map(|state| serde_json::to_string(state).unwrap()).collect();
        assert_eq!(names, [r#""pending""#, r#""approved""#, r#""changes_requested""#, r#""dismissed""#]);
    }

    #[test]
    fn a_turn_reopens_the_review_when_it_should() {
        let f = |files: u64| Totals { files, added: files, removed: 0 };
        let with = |state, commit: Option<&str>| Some(Review { state, commit: commit.map(String::from), at: 1 });
        assert_eq!(review_after_turn(None, Some(&f(1)), Some(&f(2)), 9), None);
        let pending = with(ReviewState::Pending, None);
        for totals in [None, Some(f(0)), Some(f(3))] {
            let reopened = review_after_turn(with(ReviewState::ChangesRequested, None), totals.as_ref(), totals.as_ref(), 9);
            assert_eq!(reopened, Some(Review { state: ReviewState::Pending, commit: None, at: 9 }));
        }
        let approved = with(ReviewState::Approved, Some("abc"));
        assert_eq!(
            review_after_turn(approved.clone(), Some(&f(0)), Some(&f(2)), 9),
            Some(Review { state: ReviewState::Pending, commit: None, at: 9 })
        );
        assert_eq!(review_after_turn(approved.clone(), None, Some(&f(2)), 9), Some(Review { state: ReviewState::Pending, commit: None, at: 9 }));
        assert_eq!(review_after_turn(approved.clone(), Some(&f(2)), Some(&f(0)), 9), approved);
        assert_eq!(review_after_turn(approved.clone(), Some(&f(2)), None, 9), approved);
        let dismissed = with(ReviewState::Dismissed, None);
        assert_eq!(review_after_turn(dismissed.clone(), Some(&f(3)), Some(&f(3)), 9), dismissed);
        assert_eq!(
            review_after_turn(dismissed, Some(&f(3)), Some(&f(4)), 9),
            Some(Review { state: ReviewState::Pending, commit: None, at: 9 })
        );
        assert_eq!(review_after_turn(pending.clone(), Some(&f(0)), Some(&f(4)), 9), pending);
    }

    #[test]
    fn amend_changes_saves_and_announces() {
        let rig = Rig::printing("amend", &WORK);
        let started = rig.start(None).unwrap();
        rig.finish(&started.id);
        let seen_before = rig.seen.lock().unwrap().len();
        let review = Review { state: ReviewState::Approved, commit: Some("abc".into()), at: 7 };
        let changed = rig.manager.amend(&started.id, |info| info.review = Some(review.clone())).unwrap();
        assert_eq!(changed.review, Some(review.clone()));
        assert_eq!(rig.info(&started.id).review, Some(review.clone()));
        let (reopened, ..) = rig.reopened("amend", &[]);
        assert_eq!(reopened.sessions().into_iter().find(|info| info.id == started.id).map(|info| info.review), Some(Some(review)));
        assert!(rig.seen.lock().unwrap()[seen_before..].iter().any(|emit| matches!(emit, Emit::SessionsChanged)));
        assert_eq!(rig.manager.amend("../index", |_| {}).unwrap_err(), "Invalid session id");
        assert_eq!(rig.manager.amend("00000000-0000-4000-8000-000000000009", |_| {}).unwrap_err(), "Unknown session");
        // A folder where the index's temporary file goes makes the save fail; amend says so instead of reporting success.
        let blocker = rig.dir.join("sessions").join("index.json.tmp");
        std::fs::create_dir_all(&blocker).unwrap();
        let failed = rig.manager.amend(&started.id, |info| info.review = None).unwrap_err();
        assert!(failed.starts_with("Could not save the session list:"), "{failed}");
        std::fs::remove_dir_all(&blocker).unwrap();
    }

    #[test]
    fn rename_trims_caps_and_clears() {
        let rig = Rig::printing("rename", &WORK);
        let started = rig.start(None).unwrap();
        rig.finish(&started.id);
        let rename = |name: &str| rig.manager.amend(&started.id, |info| info.name = clean_name(name)).unwrap().name;
        assert_eq!(rename("  Fix login  "), Some("Fix login".to_string()));
        assert_eq!(rig.info(&started.id).name, Some("Fix login".to_string()));
        assert_eq!(rename(&"é".repeat(100)), Some("é".repeat(NAME_MAX)));
        assert_eq!(rename("   "), None);
        assert_eq!(rename("Again"), Some("Again".to_string()));
        assert_eq!(rename(""), None);
        let (reopened, ..) = rig.reopened("rename", &[]);
        assert_eq!(reopened.sessions().into_iter().find(|info| info.id == started.id).map(|info| info.name), Some(None));
    }

    /// An interactive work session at rest, as an index written by an earlier run holds it.
    fn resting(id: &str) -> SessionInfo {
        SessionInfo {
            id: id.to_string(),
            adapter: "fake".into(),
            cli_version: None,
            task: work_task(),
            title: "Fix the bug".into(),
            workspace: vec![],
            status: Status::Idle,
            started_at: 1,
            ended_at: None,
            cost_usd: None,
            error: None,
            structured: None,
            mode: Mode::Interactive,
            policy: PolicyMode::Ask,
            project: Some("paystream".into()),
            worktree: None,
            turns: 1,
            files_changed: None,
            context: vec![],
            model: None,
            system: None,
            review: None,
            source_sha: None,
            interface: Interface::Chat,
            name: None,
            cli_title: None,
            direct: None,
            no_task: false,
            access: None,
            effort: None,
            engine_session: None,
        }
    }

    /// A manager on a history that holds `sessions`.
    fn loaded(name: &str, sessions: &[SessionInfo]) -> (Rig, Manager) {
        let rig = Rig::new(name, Fake::scripted(name, &[]));
        store::save_index(&rig.dir.join("sessions"), sessions).unwrap();
        let (manager, ..) = rig.reopened(name, &[]);
        (rig, manager)
    }

    #[test]
    fn reserve_refuses_a_busy_or_reserved_session() {
        let id = new_id();
        let (_rig, manager) = loaded("reserve", &[resting(&id)]);
        let held = manager.reserve(&id).unwrap();
        assert_eq!(held.id(), id);
        assert_eq!(manager.reserve(&id).err(), Some("A review action is already running for this session".to_string()));
        drop(held);
        assert!(manager.reserve(&id).is_ok());

        let busy = Rig::lingering("reserve-busy");
        let running = busy.start(None).unwrap();
        assert_eq!(busy.manager.reserve(&running.id).err(), Some("This session is busy".to_string()));
        assert_eq!(manager.reserve("../index").err(), Some("Invalid session id".to_string()));
        assert_eq!(manager.reserve("00000000-0000-4000-8000-000000000009").err(), Some("Unknown session".to_string()));
    }

    #[test]
    fn a_reserved_session_refuses_send_end_and_remove() {
        let id = new_id();
        let (_rig, manager) = loaded("reserved-refuses", &[resting(&id)]);
        let called = Mutex::new(0);
        let attempt = |held: Option<&Reservation>| {
            manager.send(
                &id,
                "x",
                SendOptions::default(),
                |_| {
                    *called.lock().unwrap() += 1;
                    Err("no launch".into())
                },
                held,
            )
        };
        let held = manager.reserve(&id).unwrap();
        let running = "A review action is running for this session".to_string();
        assert_eq!(attempt(None), Err(running.clone()));
        assert_eq!(*called.lock().unwrap(), 0);
        assert_eq!(manager.end(&id), Err(running.clone()));
        assert_eq!(manager.remove_worktree(&id), Err(running));
        assert_eq!(attempt(Some(&held)), Err("no launch".to_string()));
        drop(held);
        assert_eq!(attempt(None), Err("no launch".to_string()));
        assert_eq!(*called.lock().unwrap(), 2);
    }

    #[test]
    fn a_reservation_is_released_when_its_holder_fails() {
        let id = new_id();
        let (_rig, manager) = loaded("reserve-release", &[resting(&id)]);
        fn fails(manager: &Manager, id: &str) -> Result<(), String> {
            let _held = manager.reserve(id)?;
            Err("the action failed".to_string())
        }
        assert_eq!(fails(&manager, &id), Err("the action failed".to_string()));
        assert!(manager.reserve(&id).is_ok());
        let (other, other_id) = (manager.clone(), id.clone());
        let panicked = std::thread::spawn(move || {
            let _held = other.reserve(&other_id).unwrap();
            panic!("the action panicked");
        })
        .join();
        assert!(panicked.is_err());
        assert!(manager.reserve(&id).is_ok());
    }

    /// A terminal session at rest, as `start_task` registers it.
    fn terminal(id: &str) -> SessionInfo {
        SessionInfo { interface: Interface::Terminal, status: Status::Idle, turns: 0, ..resting(id) }
    }

    fn terminal_options(engine: Engine) -> StartOptions {
        StartOptions { engine, interface: Interface::Terminal, ..Default::default() }
    }

    #[test]
    fn a_folder_task_is_for_terminals_only() {
        let folder = AgentTask::Folder { path: "C:/notes".into() };
        assert!(check_combination(&folder, Engine::Claude, Interface::Terminal).is_ok());
        assert!(check_combination(&folder, Engine::Codex, Interface::Terminal).is_ok());
        for engine in [Engine::Claude, Engine::Codex] {
            assert_eq!(check_combination(&folder, engine, Interface::Chat).unwrap_err(), "A session in another folder runs in the terminal.");
        }
        assert_eq!(serde_json::to_value(&folder).unwrap(), json!({"kind": "folder", "path": "C:/notes"}));
    }

    #[test]
    fn terminals_default_to_the_checkout_and_chats_to_a_worktree() {
        let place = |place, interface| place_of(&StartOptions { place, interface, ..Default::default() });
        assert_eq!(place(None, Interface::Terminal), Ok(Place::Checkout));
        assert_eq!(place(Some(Place::Worktree), Interface::Terminal), Ok(Place::Worktree));
        assert_eq!(place(Some(Place::Checkout), Interface::Terminal), Ok(Place::Checkout));
        assert_eq!(place(None, Interface::Chat), Ok(Place::Worktree));
        assert_eq!(place(Some(Place::Worktree), Interface::Chat), Ok(Place::Worktree));
        assert_eq!(place(Some(Place::Checkout), Interface::Chat), Err("A chat session always works in a worktree.".to_string()));
        let options: StartOptions = serde_json::from_value(json!({"place": "checkout"})).unwrap();
        assert_eq!(options.place, Some(Place::Checkout));
        assert!(serde_json::from_value::<StartOptions>(json!({"place": "elsewhere"})).is_err());
    }

    #[test]
    fn a_checkout_session_runs_in_the_repository_without_a_worktree() {
        if !git_available() {
            return;
        }
        let rig = Rig::new("checkout", Fake::scripted("checkout", &[]));
        rig.tree("other"); // makes `repo` with one commit
        let repo = rig.dir.join("repo");
        std::fs::write(repo.join("scratch.txt"), "untracked\n").unwrap();
        let status = |dir: &Path| Command::new("git").arg("-C").arg(dir).args(["status", "--porcelain"]).output().unwrap().stdout;
        let before = status(&repo);
        let worktrees_before = std::fs::read_dir(rig.dir.join("worktrees")).unwrap().count();
        let (terminals, id) = (rig.dir.join("terminals"), new_id());
        let options = StartOptions { briefing: Some("Project briefing".into()), ..terminal_options(Engine::Claude) };

        let info = start_direct(&rig.manager, &terminals, &id, work_task(), &repo, "Fix the bug\nsecond line", &options).unwrap();
        assert_eq!((info.status, info.interface, info.worktree.is_none(), info.no_task), (Status::Idle, Interface::Terminal, true, false));
        assert_eq!((info.title.as_str(), info.project.as_deref()), ("Fix the bug", Some("paystream")));
        assert_eq!(info.workspace[0], repo.display().to_string());
        let direct = info.direct.clone().expect("a direct session");
        assert_eq!(direct.path, repo.display().to_string());
        assert!(direct.repo.is_some() && direct.head_sha.is_some());
        let tree = direct.start_tree.expect("a start tree");
        let listed = Command::new("git").arg("-C").arg(&repo).args(["ls-tree", "-r", "--name-only", &tree]).output().unwrap().stdout;
        assert!(String::from_utf8_lossy(&listed).lines().any(|name| name == "scratch.txt"));
        assert_eq!(rig.manager.info(&id).unwrap(), info);

        let briefing = std::fs::read_to_string(terminals.join(&id).join("context").join("briefing.md")).unwrap();
        assert_eq!(briefing, "Project briefing\n\n---\n\nFix the bug\nsecond line");
        assert_eq!(status(&repo), before, "the user's folder is unchanged");
        assert_eq!(std::fs::read_dir(rig.dir.join("worktrees")).unwrap().count(), worktrees_before, "no worktree was made");
        let scope = scope::direct(&repo, PolicyMode::Ask, String::new()).unwrap();
        assert_eq!((scope.cwd, scope.worktree, scope.deny), (repo.clone(), None, scope::governed_rules()));
    }

    #[test]
    fn a_session_with_no_task_is_titled_by_engine_and_folder() {
        let rig = Rig::new("no-task", Fake::scripted("no-task", &[]));
        let folder = rig.dir.join("Notes");
        std::fs::create_dir_all(&folder).unwrap();
        let terminals = rig.dir.join("terminals");
        for (engine, label) in [(Engine::Claude, "Claude Code"), (Engine::Codex, "Codex")] {
            let id = new_id();
            let task = AgentTask::Folder { path: folder.display().to_string() };
            let info = start_direct(&rig.manager, &terminals, &id, task, &folder, "  \n", &terminal_options(engine)).unwrap();
            assert_eq!(info.title, format!("{label} \u{b7} Notes"));
            assert!(info.no_task);
            assert!(terminals.join(&id).join("context").join("briefing.md").is_file(), "the briefing is still written");
            assert_eq!(info.direct.map(|direct| direct.path), Some(folder.display().to_string()));
        }
        let missing = start_direct(&rig.manager, &terminals, &new_id(), work_task(), &rig.dir.join("gone"), "x", &terminal_options(Engine::Claude));
        assert!(missing.unwrap_err().starts_with("The folder does not exist: "));
    }

    #[test]
    fn start_task_runs_a_folder_session_only_for_a_picked_folder() {
        let rig = Rig::new("folder-task", Fake::scripted("folder-task", &[]));
        let folder = rig.dir.join("picked");
        std::fs::create_dir_all(&folder).unwrap();
        // A program that exists and is harmless: start_task only looks the CLI up.
        let harmless = if cfg!(windows) { std::env::var("ComSpec").unwrap_or_else(|_| "C:\\Windows\\System32\\cmd.exe".into()) } else { "/bin/sh".into() };
        let spelled = folder.display().to_string();
        let saved = Settings { claude_path: Some(harmless), other_folders: Some(vec![spelled.clone()]), ..Default::default() };
        let bridge = Bridge::new(crate::settings::resolve(&saved, |_| None));
        let (worktrees, terminals) = (rig.dir.join("worktrees"), rig.dir.join("terminals"));
        let start = |path: &str, prompt: &str, options: StartOptions| {
            start_task(&rig.manager, &bridge, &saved, &worktrees, &terminals, AgentTask::Folder { path: path.into() }, prompt, options)
        };

        let loud = format!("{}/", spelled.to_uppercase().replace('\\', "/"));
        let bare = start(&loud, "", terminal_options(Engine::Claude));
        if cfg!(windows) {
            let info = bare.unwrap();
            assert!(info.no_task && info.worktree.is_none() && info.project.is_none());
            assert_eq!(info.direct.unwrap().path, spelled, "the saved spelling is used");
        } else {
            assert!(bare.is_err());
        }
        let elsewhere = rig.dir.join("elsewhere");
        std::fs::create_dir_all(&elsewhere).unwrap();
        let refused = start(&elsewhere.display().to_string(), "Do it", terminal_options(Engine::Claude));
        assert_eq!(refused.unwrap_err(), "That folder was not chosen with the folder picker");
        let chat = start(&spelled, "Do it", StartOptions::default());
        assert_eq!(chat.unwrap_err(), "A session in another folder runs in the terminal.");
        let task = start(&spelled, "Do it", terminal_options(Engine::Claude)).unwrap();
        assert_eq!((task.title.as_str(), task.no_task), ("Do it", false));
    }

    #[test]
    fn importing_a_cli_conversation_checks_the_id_and_the_target() {
        use crate::term::ShellTarget;
        let good = "0ea3c5d4-1111-4222-8333-444455556666";
        let folder = ShellTarget::Folder("C:/picked".into());
        for bad in ["", "../x", "a/b", "zz", "ab.jsonl"] {
            assert_eq!(import_task(bad, &folder).unwrap_err(), "That is not a conversation id", "{bad}");
        }
        assert_eq!(import_task(good, &folder).unwrap(), AgentTask::Folder { path: "C:/picked".into() });
        let checkout = ShellTarget::Checkout { project: "paystream".into(), repo: "C:/repo".into() };
        assert_eq!(import_task(good, &checkout).unwrap(), AgentTask::Work { project: "paystream".into(), repo: "C:/repo".into(), branch: None, change: None });
        assert!(import_task(good, &ShellTarget::Session("x".into())).is_err());

        // A folder the picker never gave is refused before anything is made.
        let rig = Rig::new("import", Fake::scripted("import", &[]));
        let picked = rig.dir.join("picked");
        let elsewhere = rig.dir.join("elsewhere");
        std::fs::create_dir_all(&picked).unwrap();
        std::fs::create_dir_all(&elsewhere).unwrap();
        let harmless = if cfg!(windows) { std::env::var("ComSpec").unwrap_or_else(|_| r"C:\Windows\System32\cmd.exe".into()) } else { "/bin/sh".into() };
        let saved = Settings { claude_path: Some(harmless), other_folders: Some(vec![picked.display().to_string()]), ..Default::default() };
        let bridge = Bridge::new(crate::settings::resolve(&saved, |_| None));
        let (worktrees, terminals) = (rig.dir.join("worktrees"), rig.dir.join("terminals"));
        let import = |path: &Path, id: &str| {
            import_session(&rig.manager, &bridge, &saved, &worktrees, &terminals, id, "Fix the build", &ShellTarget::Folder(path.display().to_string()), terminal_options(Engine::Claude))
        };
        assert_eq!(import(&elsewhere, good).unwrap_err(), "That folder was not chosen with the folder picker");
        assert_eq!(import(&picked, "../x").unwrap_err(), "That is not a conversation id");
        assert!(rig.manager.sessions().is_empty());
        if cfg!(windows) {
            let info = import(&picked, good).unwrap();
            assert_eq!((info.engine_session.as_deref(), info.title.as_str(), info.cli_title.as_deref()), (Some(good), "Fix the build", Some("Fix the build")));
            assert!(info.no_task && info.worktree.is_none() && info.interface == Interface::Terminal && info.status == Status::Idle);
            assert_eq!(info.direct.map(|direct| direct.path), Some(picked.display().to_string()));
            assert_eq!(rig.manager.info(&info.id).unwrap().engine_session.as_deref(), Some(good));
        }
    }

    #[test]
    fn a_direct_session_is_never_reached_by_worktree_code() {
        let rig = Rig::new("direct-guards", Fake::scripted("direct-guards", &[]));
        let folder = rig.dir.join("mine");
        std::fs::create_dir_all(&folder).unwrap();
        let task = AgentTask::Folder { path: "x".into() };
        let info = start_direct(&rig.manager, &rig.dir.join("terminals"), &new_id(), task, &folder, "task", &terminal_options(Engine::Claude)).unwrap();
        rig.manager.amend(&info.id, |info| info.status = Status::Ended).unwrap();
        assert_eq!(rig.manager.remove_worktree(&info.id).unwrap_err(), "This session has no worktree");
        assert_eq!(rig.manager.files(&info.id).unwrap_err(), "This session has no worktree");
        assert!(folder.is_dir());
    }

    #[test]
    fn old_session_records_load_without_the_new_fields() {
        let info = serde_json::to_value(terminal("00000000-0000-4000-8000-000000000001")).unwrap();
        let mut old = info.as_object().unwrap().clone();
        old.remove("direct");
        old.remove("noTask");
        old.remove("access");
        old.remove("effort");
        let loaded: SessionInfo = serde_json::from_value(Value::Object(old)).unwrap();
        assert_eq!((loaded.direct, loaded.no_task, loaded.access, loaded.effort), (None, false, None, None));
    }

    #[test]
    fn start_task_checks_access_model_and_effort() {
        use access::{ClaudeMode, Sandbox, Approval};
        let rig = Rig::new("access", Fake::scripted("access", &[]));
        let folder = rig.dir.join("picked");
        std::fs::create_dir_all(&folder).unwrap();
        let harmless = if cfg!(windows) { std::env::var("ComSpec").unwrap_or_else(|_| "C:\\Windows\\System32\\cmd.exe".into()) } else { "/bin/sh".into() };
        let spelled = folder.display().to_string();
        let saved = Settings { claude_path: Some(harmless), other_folders: Some(vec![spelled.clone()]), ..Default::default() };
        let bridge = Bridge::new(crate::settings::resolve(&saved, |_| None));
        let (worktrees, terminals) = (rig.dir.join("worktrees"), rig.dir.join("terminals"));
        let start = |options: StartOptions| {
            start_task(&rig.manager, &bridge, &saved, &worktrees, &terminals, AgentTask::Folder { path: spelled.clone() }, "Do it", options)
        };
        let claude = |mode| Some(Access::Claude { mode });
        let with = |access: Option<Access>, confirmed_risky: bool| StartOptions { access, confirmed_risky, ..terminal_options(Engine::Claude) };
        if !cfg!(windows) {
            return; // the picked folder is only accepted on Windows spellings in this rig
        }

        // Nothing asked for: the old policy decides, and the session records it.
        assert_eq!(start(terminal_options(Engine::Claude)).unwrap().access, claude(ClaudeMode::Manual));
        assert_eq!(start(StartOptions { policy: Some(PolicyMode::AcceptEdits), ..terminal_options(Engine::Claude) }).unwrap().access, claude(ClaudeMode::AcceptEdits));
        // A mode that never asks needs the tick.
        let refused = start(with(claude(ClaudeMode::BypassPermissions), false)).unwrap_err();
        assert!(refused.contains("Tick the box to start without asking"), "{refused}");
        assert_eq!(start(with(claude(ClaudeMode::BypassPermissions), true)).unwrap().access, claude(ClaudeMode::BypassPermissions));
        assert_eq!(start(with(claude(ClaudeMode::Plan), false)).unwrap().access, claude(ClaudeMode::Plan));
        // The engine's own settings only.
        let codex_access = Some(Access::Codex { sandbox: Sandbox::ReadOnly, approval: Approval::OnRequest });
        assert!(start(with(codex_access, true)).is_err());
        // Model and effort come from the engine's list.
        let info = start(StartOptions { model: Some("fable".into()), effort: Some("max".into()), ..terminal_options(Engine::Claude) }).unwrap();
        assert_eq!((info.model.as_deref(), info.effort.as_deref()), (Some("fable"), Some("max")));
        let bad_model = start(StartOptions { model: Some("gpt-6".into()), ..terminal_options(Engine::Claude) });
        assert_eq!(bad_model.unwrap_err(), "Unknown model: gpt-6");
        let bad_effort = start(StartOptions { effort: Some("ultra".into()), ..terminal_options(Engine::Claude) });
        assert_eq!(bad_effort.unwrap_err(), "Unknown effort: ultra");
        // A chat session takes none of this.
        let chat = start_task(&rig.manager, &bridge, &saved, &worktrees, &terminals, work_task(), "x", StartOptions { access: claude(ClaudeMode::Plan), ..Default::default() });
        assert_eq!(chat.unwrap_err(), "Permission modes and effort are for terminal sessions.");
    }

    #[test]
    fn interface_serialises_in_lowercase() {
        assert_eq!(serde_json::to_value(Interface::Terminal).unwrap(), json!("terminal"));
        assert_eq!(serde_json::to_value(Interface::Chat).unwrap(), json!("chat"));
        assert_eq!(Interface::default(), Interface::Chat);
        let options: StartOptions = serde_json::from_value(json!({})).unwrap();
        assert_eq!((options.engine, options.interface), (Engine::Claude, Interface::Chat));
        let options: StartOptions = serde_json::from_value(json!({"engine": "codex", "interface": "terminal"})).unwrap();
        assert_eq!((options.engine, options.interface), (Engine::Codex, Interface::Terminal));
    }

    #[test]
    fn a_terminal_session_is_registered_without_a_process() {
        let rig = Rig::new("register", Fake::scripted("register", &[]));
        let id = new_id();
        let registered = rig.manager.register(terminal(&id)).unwrap();
        assert_eq!(registered, terminal(&id));
        let listed = rig.manager.sessions();
        assert_eq!(listed.len(), 1);
        assert_eq!((listed[0].id.as_str(), listed[0].status, listed[0].interface), (id.as_str(), Status::Idle, Interface::Terminal));
        assert!(rig.seen.lock().unwrap().iter().any(|emit| matches!(emit, Emit::SessionsChanged)));
        assert!(store::read_log(&rig.dir.join("sessions"), &id).unwrap().is_empty());
        rig.manager.amend(&id, |info| info.status = Status::Running).unwrap();
        let (again, ..) = rig.reopened("register-again", &[]);
        let reloaded = again.sessions();
        assert_eq!(reloaded.len(), 1);
        assert_eq!(reloaded[0].id, id);
    }

    #[test]
    fn terminal_sessions_do_not_hold_a_slot() {
        let rig = Rig::lingering("terminal-slots");
        let ids: Vec<String> = (0..MAX_RUNNING).map(|_| new_id()).collect();
        for id in &ids {
            rig.manager.register(terminal(id)).unwrap();
            rig.manager.amend(id, |info| info.status = Status::Running).unwrap();
        }
        let started = rig.begin();
        assert_eq!(started.status, Status::Running);
        for id in &ids {
            let info = rig.info(id);
            assert_eq!((info.status, info.interface), (Status::Running, Interface::Terminal));
        }
    }

    #[test]
    fn the_first_text_is_the_briefing_a_rule_and_the_task() {
        assert_eq!(first_text(Some("B"), "T"), "B\n\n---\n\nT");
        assert_eq!(first_text(None, "T"), "T");
    }

    #[test]
    fn start_refuses_unsupported_combinations() {
        let passport = AgentTask::SystemPassport { slug: "billing".into() };
        assert_eq!(check_combination(&passport, Engine::Claude, Interface::Terminal).unwrap_err(), "A terminal session needs a project repository.");
        assert_eq!(check_combination(&passport, Engine::Codex, Interface::Chat).unwrap_err(), "System passports run with Claude Code.");
        assert_eq!(check_combination(&work_task(), Engine::Codex, Interface::Chat).unwrap_err(), "Chat with Codex is not available yet. Use Terminal.");
        assert!(check_combination(&work_task(), Engine::Codex, Interface::Terminal).is_ok());
        assert!(check_combination(&passport, Engine::Claude, Interface::Chat).is_ok());
    }

    #[test]
    fn chat_only_commands_refuse_a_terminal_session() {
        let id = new_id();
        let (rig, manager) = loaded("terminal-refuses", &[terminal(&id)]);
        let before = manager.info(&id).unwrap();
        assert_eq!(send_on(&manager, &rig, &id, "hello").unwrap_err(), "This session runs in the terminal. Resume it there and type your request.");
        assert_eq!(manager.end(&id).unwrap_err(), "This session runs in the terminal. Stop it there.");
        assert_eq!(manager.set_policy(&id, PolicyMode::AcceptEdits).unwrap_err(), "A terminal session keeps the permission mode it was started with.");
        assert_eq!(manager.info(&id).unwrap(), before);
        assert!(store::read_log(&rig.dir.join("sessions"), &id).unwrap().is_empty());
        assert!(manager.cancel(&id).is_ok());
        assert!(manager.interrupt(&id).is_ok());
    }
}
