pub mod auth;
pub mod cli_files;
pub mod history;
pub mod launch;
pub mod pricing;
pub mod pty;
pub mod scrollback;
pub mod signal;
pub mod transcript;
pub mod usage;

use crate::agent::events::{SeqEvent, Status};
use crate::agent::access::Access;
use crate::agent::scope;
use crate::agent::{self, Engine, Interface, SessionInfo};
use crate::settings;
use crate::worktree;
use launch::Cli;
use pty::{Spawn, TermEvent};
use scrollback::Scrollback;
use signal::{Intake, Kind, Scanner};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// How many terminal programs may run at once. The sign-in terminals (ids starting `login-`) are not counted.
pub const MAX_TERMINALS: usize = 8;
/// Exit codes that mean the user left, not that something broke: clean exit, SIGHUP, SIGINT, and
/// Windows' STATUS_CONTROL_C_EXIT (what Codex returns after Ctrl+C and what a closed console gives).
pub const QUIET_EXITS: [u32; 4] = [0, 129, 130, 0xC000_013A];

const RESERVED: &str = "A review action is running for this session";
const NOT_RUNNING: &str = "This terminal is not running";
/// How often, and how many times, a running program is checked for its CLI's conversation file and title.
const WATCH_EVERY: Duration = Duration::from_secs(3);
const WATCH_TRIES: u32 = 40;
/// How often a Claude terminal's `signals.jsonl` is looked at for new lines.
const SIGNAL_EVERY: Duration = Duration::from_millis(500);
/// How long `stop_all` waits, after the closes, for the exits to be recorded.
const RECORD_WAIT: Duration = Duration::from_secs(5);

/// What `term_open` should do when the session has no running program.
#[derive(Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum StartMode {
    /// The first-run command line: the briefing prompt, a new conversation.
    Fresh,
    /// The CLI's resume form: continue the session's conversation.
    Resume,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TermInfo {
    /// The session id for a session's terminal; `login-claude` or `login-codex` for a sign-in terminal.
    pub id: String,
    pub session_id: Option<String>,
    pub engine: Engine,
    pub running: bool,
    pub exit_code: Option<u32>,
    /// The Windows build number, for xterm's `windowsPty` option; None on other systems.
    pub windows_build: Option<u32>,
    /// The tab's name for a PowerShell tab (it has no session to name it); None for the others.
    pub label: Option<String>,
    /// The folder a PowerShell tab runs in; None for the others.
    pub cwd: Option<String>,
    /// What the program wants from the user right now; None when nothing.
    pub attention: Option<Kind>,
}

/// Where a PowerShell tab starts. Serde's external tag gives `{ session: id }`, `{ checkout: { project, repo } }` and `{ folder: path }`.
#[derive(Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum ShellTarget {
    /// A session's folder: its worktree, or the folder it was started in.
    Session(String),
    /// A registered repository of a project.
    Checkout { project: String, repo: String },
    /// A folder picked with the folder dialog.
    Folder(String),
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TermExit {
    pub id: String,
    pub session_id: Option<String>,
    pub code: Option<u32>,
}

/// What the terminal manager tells the UI.
#[derive(Clone, Debug)]
pub enum Emit {
    Exit(TermExit),
    /// The terminal's attention changed: `kind` is None when it was cleared. `title` is the tab's name, for a notification.
    Attention { id: String, kind: Option<Kind>, title: String },
}
pub type Sink = Arc<dyn Fn(Emit) + Send + Sync>;

/// Where a terminal's bytes go. Returns false when the receiver is gone (the webview reloaded).
pub type Output = Arc<dyn Fn(Vec<u8>) -> bool + Send + Sync>;

struct Out {
    /// None when the webview's channel is gone; output is still saved.
    output: Option<Output>,
    /// None for a sign-in terminal.
    scrollback: Option<Scrollback>,
}

/// What a terminal wants from the user.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Attention {
    kind: Kind,
}

struct Shared {
    id: String,
    session_id: Option<String>,
    engine: Engine,
    /// Set for a PowerShell tab: its label and folder.
    shell: Option<(String, String)>,
    out: Mutex<Out>,
    close_requested: AtomicBool,
    /// A files-changed refresh is already under way.
    refreshing: AtomicBool,
    /// When the program was started (ms): a Codex conversation older than this is not its own.
    since: u64,
    /// The Codex thread ids that existed when the program started; none of them is its own.
    before: Vec<String>,
    /// Set from a hook line or a bell; a lock of its own, never taken together with `terms`.
    attention: Mutex<Option<Attention>>,
}

struct Entry {
    shared: Arc<Shared>,
    pty: pty::Session,
}

type Terms = HashMap<String, Arc<Entry>>;

struct Inner {
    dir: PathBuf,
    agents: agent::Manager,
    settings_path: PathBuf,
    sink: Sink,
    terms: Mutex<Terms>,
    /// The user's home folder, where the CLIs keep their conversation files; empty when it is unknown.
    home: PathBuf,
}

/// Everything `spawn` needs to start one program.
struct Run {
    id: String,
    session_id: Option<String>,
    engine: Engine,
    cli: Cli,
    cwd: PathBuf,
    /// The tab label of a PowerShell tab; None for every other program.
    label: Option<String>,
    memory_root: Option<PathBuf>,
    cols: u16,
    rows: u16,
    scrollback: Option<Scrollback>,
    output: Output,
    /// A Claude session's folder for hook signals (`HIVEMIND_SIGNAL_DIR`); None for every other program.
    signal_dir: Option<PathBuf>,
    /// The Codex thread ids that existed before the start (read before the map is locked); empty for every other program.
    before: Vec<String>,
}

#[derive(Clone)]
pub struct Manager {
    inner: Arc<Inner>,
}

fn clamp(cols: u16, rows: u16) -> (u16, u16) {
    (cols.clamp(20, 500), rows.clamp(5, 300))
}

fn info_of(shared: &Shared) -> TermInfo {
    TermInfo {
        id: shared.id.clone(),
        session_id: shared.session_id.clone(),
        engine: shared.engine,
        running: true,
        exit_code: None,
        windows_build: launch::windows_build(),
        label: shared.shell.as_ref().map(|(label, _)| label.clone()),
        cwd: shared.shell.as_ref().map(|(_, cwd)| cwd.clone()),
        attention: shared.attention.lock().unwrap().map(|a| a.kind),
    }
}

impl Manager {
    /// `dir` is `<app data>/terminals`. Removes the folders of sessions that are no longer in the history.
    pub fn new(dir: PathBuf, agents: agent::Manager, settings_path: PathBuf, sink: Sink) -> Manager {
        Manager::new_in(dir, agents, settings_path, sink, dirs::home_dir().unwrap_or_default())
    }

    /// `new` with the home folder given (tests use a temp folder).
    pub fn new_in(dir: PathBuf, agents: agent::Manager, settings_path: PathBuf, sink: Sink, home: PathBuf) -> Manager {
        let known: HashSet<String> = agents.sessions().into_iter().map(|info| info.id).collect();
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if session_dir(&dir, &name).is_ok() && !known.contains(&name) && entry.path().is_dir() {
                    let _ = std::fs::remove_dir_all(entry.path());
                }
            }
        }
        Manager { inner: Arc::new(Inner { dir, agents, settings_path, sink, terms: Mutex::new(HashMap::new()), home }) }
    }

    /// `term_open` (section 4.3 of the Phase 5 plan).
    pub fn open(&self, session_id: &str, cols: u16, rows: u16, start: Option<StartMode>, replay: bool, output: Output) -> Result<TermInfo, String> {
        let inner = &self.inner;
        if session_id.starts_with(launch::SHELL_PREFIX) {
            return inner.attach_shell(session_id, cols, rows, output);
        }
        let info = inner.agents.info(session_id)?;
        if info.interface != Interface::Terminal {
            return Err("This session is not a terminal session".into());
        }
        let (cols, rows) = clamp(cols, rows);
        let engine = Engine::of(&info.adapter);
        let scrollback_path = inner.scrollback_path(session_id)?;
        // Done before the lock, which every terminal's input waits for: finding a program can run it for seconds
        // (`claude --version`), and `windows_build` runs `ver` the first time. A lookup error is reported in its place below.
        let build = launch::windows_build();
        let saved = settings::load(&inner.settings_path);
        let start = start.map(|mode| (mode, launch::program(engine, &saved)));
        // Also before the lock: it reads the CLI's files.
        let thread = match &start {
            Some((StartMode::Resume, _)) if engine == Engine::Codex => inner.known_thread(&info),
            // An imported conversation: Claude resumes it by its own id, not by the session's.
            Some((StartMode::Resume, _)) => info.engine_session.clone(),
            _ => None,
        };
        // Also before the lock: the threads that exist already, so a new Codex conversation can be told from them.
        let existing = match &start {
            Some(_) if engine == Engine::Codex && !inner.home.as_os_str().is_empty() => cli_files::codex_thread_ids(&inner.home, agent::now_ms()),
            _ => Vec::new(),
        };
        // Held from the limit check until the new entry is inserted, so an exit cannot be handled before its entry exists.
        let mut terms = inner.terms.lock().unwrap();
        let running = terms.get(session_id).cloned();
        if (running.is_some() || start.is_some()) && inner.agents.is_reserved(session_id) {
            return Err(RESERVED.into());
        }
        if let Some(entry) = running {
            drop(terms);
            inner.attach(&entry, cols, rows, replay.then_some(scrollback_path.as_path()), output);
            return Ok(info_of(&entry.shared));
        }
        let view = TermInfo {
            id: session_id.to_string(),
            session_id: Some(session_id.to_string()),
            engine,
            running: false,
            exit_code: None,
            windows_build: build,
            label: None,
            cwd: None,
            attention: None,
        };
        let Some((mode, found)) = start else {
            drop(terms);
            if replay {
                send_saved(&scrollback_path, &output);
            }
            return Ok(view);
        };
        self.launch(&mut terms, &info, mode, found?, thread, existing, &saved, (cols, rows), output, replay, None)
    }

    /// Start the program of a session whose terminal map is locked by the caller (`terms`). `feedback` is set only by
    /// `resume_with`, which holds the session's reservation: the final argument then points the CLI at that file, and the
    /// reservation is not a reason to refuse.
    #[allow(clippy::too_many_arguments)] // each argument is one independent part of one start
    fn launch(
        &self,
        terms: &mut Terms,
        info: &SessionInfo,
        mode: StartMode,
        mut cli: Cli,
        thread: Option<String>,
        existing: Vec<String>,
        saved: &settings::Settings,
        (cols, rows): (u16, u16),
        output: Output,
        replay: bool,
        feedback: Option<&Path>,
    ) -> Result<TermInfo, String> {
        let inner = &self.inner;
        let session_id = info.id.as_str();
        let engine = Engine::of(&info.adapter);
        let scrollback_path = inner.scrollback_path(session_id)?;
        let cwd = session_cwd(info)?;
        let own_dir = session_dir(&inner.dir, session_id)?;
        // Claude reports attention through hooks in a settings file of its own. If it cannot be written the terminal
        // still starts, only without dots and notifications.
        let signals = match engine {
            Engine::Claude => std::env::current_exe().map_err(|e| e.to_string()).and_then(|exe| signal::prepare_claude(&own_dir, &exe)).ok(),
            Engine::Codex => None,
        };
        cli.args.extend(start_args(info, mode, signals.as_deref(), &own_dir.join("context"), thread.as_deref(), feedback));
        if replay {
            send_saved(&scrollback_path, &output);
        }
        // Running is set before the spawn, and put back if the spawn fails, so an early exit is never overwritten. The
        // reservation is checked again in the same step: the check above and this change take the session lock separately,
        // and once the session is running Phase 4 cannot reserve it.
        let before = (info.status, info.ended_at, info.error.clone());
        let set_running = |info: &mut SessionInfo| {
            info.status = Status::Running;
            info.ended_at = None;
            info.error = None;
            if mode == StartMode::Fresh {
                // A new conversation: the old one's thread and title are not its own.
                info.engine_session = None;
                info.cli_title = None;
            }
        };
        if feedback.is_some() {
            inner.agents.amend(session_id, set_running)?;
        } else {
            inner.agents.amend_unreserved(session_id, RESERVED, set_running)?;
        }
        let run = Run {
            id: session_id.to_string(),
            session_id: Some(session_id.to_string()),
            engine,
            cli,
            cwd,
            label: None,
            memory_root: settings::resolve(saved, |k| std::env::var(k).ok()).root,
            cols,
            rows,
            scrollback: Scrollback::open(scrollback_path, scrollback::KEEP).ok(),
            output,
            signal_dir: signals.map(|_| own_dir),
            before: existing,
        };
        match self.spawn_in(terms, run) {
            Ok(started) => {
                if let Some(entry) = terms.get(session_id) {
                    inner.watch(entry.shared.clone());
                }
                Ok(started)
            }
            Err(error) => {
                let _ = inner.agents.amend(session_id, |info| {
                    info.status = before.0;
                    info.ended_at = before.1;
                    info.error = before.2;
                });
                Err(error)
            }
        }
    }

    /// Close a session's program and wait up to `timeout` for it to leave. Returns at once when nothing runs. The close
    /// runs on a thread of its own, so the wait is bounded even when the program ignores the close for a while.
    pub fn stop(&self, id: &str, timeout: Duration) -> Result<(), String> {
        // The close and the wait are bound to this run's entry, not to the id: once it exits, a new run may take the id
        // over (Request changes starts one), and that one must not be closed or waited for.
        let Some(entry) = self.inner.terms.lock().unwrap().get(id).cloned() else { return Ok(()) };
        let closing = entry.clone();
        std::thread::spawn(move || {
            closing.shared.close_requested.store(true, Ordering::SeqCst);
            closing.pty.close();
        });
        let waited = Instant::now();
        // The exit handler removes the entry and stores the status under one lock, so a missing entry means the status is set.
        while self.inner.terms.lock().unwrap().get(id).is_some_and(|now| Arc::ptr_eq(now, &entry)) {
            if waited.elapsed() >= timeout {
                return Err(format!("The program did not stop within {} seconds.", timeout.as_secs()));
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        Ok(())
    }

    /// Start the session's program again in the CLI's resume form, with one more final argument that points it at
    /// `feedback`. The caller holds the session's reservation (`held`). Nothing is attached to the program yet: its output
    /// goes to the saved history, and the view shows it when the terminal is opened.
    pub fn resume_with(&self, id: &str, feedback: &Path, held: &agent::Reservation) -> Result<TermInfo, String> {
        if held.id() != id {
            return Err("The reservation is for another session".into());
        }
        let inner = &self.inner;
        let info = inner.agents.info(id)?;
        if info.interface != Interface::Terminal {
            return Err("This session is not a terminal session".into());
        }
        let engine = Engine::of(&info.adapter);
        // Before the lock: finding a program and reading the CLI's files can take a while.
        let saved = settings::load(&inner.settings_path);
        let cli = launch::program(engine, &saved)?;
        let thread = match engine {
            Engine::Codex => inner.known_thread(&info),
            Engine::Claude => info.engine_session.clone(),
        };
        let existing = if engine == Engine::Codex && !inner.home.as_os_str().is_empty() { cli_files::codex_thread_ids(&inner.home, agent::now_ms()) } else { Vec::new() };
        let mut terms = inner.terms.lock().unwrap();
        if terms.contains_key(id) {
            return Err("This terminal is still running".into());
        }
        // Nobody looks at it yet; the view fits the program when it attaches.
        let nobody: Output = Arc::new(|_| false);
        self.launch(&mut terms, &info, StartMode::Resume, cli, thread, existing, &saved, (120, 30), nobody, false, Some(feedback))
    }

    /// The CLI's own conversation file for a terminal session: its engine and path, None while there is no file yet.
    fn conversation_file(&self, session_id: &str) -> Result<Option<(Engine, PathBuf)>, String> {
        let inner = &self.inner;
        let info = inner.agents.info(session_id)?;
        if info.interface != Interface::Terminal {
            return Err("This session is not a terminal session".into());
        }
        let engine = Engine::of(&info.adapter);
        if inner.home.as_os_str().is_empty() {
            return Ok(None);
        }
        let cwd = session_cwd(&info).map(|path| path.display().to_string()).unwrap_or_default();
        let path = match engine {
            Engine::Claude => cli_files::claude_transcript(&inner.home, &cwd, history::conversation_id(engine, &info).unwrap_or(session_id)),
            Engine::Codex => info.engine_session.as_deref().and_then(|id| cli_files::codex_rollout(&inner.home, id)),
        };
        Ok(path.map(|path| (engine, path)))
    }

    /// The conversation of a terminal session as chat events, read from the CLI's own file. Empty while there is no file.
    pub fn transcript(&self, session_id: &str) -> Result<Vec<SeqEvent>, String> {
        let Some((engine, path)) = self.conversation_file(session_id)? else { return Ok(vec![]) };
        let bytes = std::fs::read(&path).map_err(|e| format!("Could not read the conversation file: {e}"))?;
        let text = String::from_utf8_lossy(&bytes);
        Ok(match engine {
            Engine::Claude => transcript::claude(session_id, &text),
            Engine::Codex => transcript::codex(session_id, &text),
        })
    }

    /// Tokens, cost and plan limits of a terminal session, read from the CLI's own file. Zeros while there is no file.
    pub fn usage(&self, session_id: &str) -> Result<usage::Usage, String> {
        let Some((engine, path)) = self.conversation_file(session_id)? else { return Ok(usage::Usage::default()) };
        Ok(match engine {
            Engine::Claude => {
                let mut counter = usage::ClaudeUsage::default();
                usage::read_lines(&path, |line| counter.feed(line))?;
                counter.finish()
            }
            Engine::Codex => {
                let mut counter = usage::CodexUsage::default();
                usage::read_lines(&path, |line| counter.feed(line))?;
                counter.finish()
            }
        })
    }

    /// The conversations `engine` saved for `cwd`, newest first, with the Hivemind sessions that already hold them.
    pub fn history(&self, engine: Engine, cwd: &Path) -> Vec<history::Conversation> {
        let inner = &self.inner;
        if inner.home.as_os_str().is_empty() {
            return vec![];
        }
        history::list(&inner.home, engine, cwd, &inner.agents.sessions())
    }

    /// `term_login`.
    pub fn login(&self, engine: Engine, cols: u16, rows: u16, output: Output) -> Result<TermInfo, String> {
        let inner = &self.inner;
        let id = format!("login-{}", if engine == Engine::Codex { "codex" } else { "claude" });
        let (cols, rows) = clamp(cols, rows);
        // Before the lock, as in `open`.
        launch::windows_build();
        let saved = settings::load(&inner.settings_path);
        let found = launch::program(engine, &saved);
        let mut terms = inner.terms.lock().unwrap();
        if let Some(entry) = terms.get(&id).cloned() {
            drop(terms);
            inner.attach(&entry, cols, rows, None, output);
            return Ok(info_of(&entry.shared));
        }
        let mut cli = found?;
        cli.args.extend(launch::login_args(engine));
        let cwd = dirs::home_dir().ok_or("Could not find your home folder")?;
        let run = Run {
            id,
            session_id: None,
            engine,
            cli,
            cwd,
            label: None,
            memory_root: settings::resolve(&saved, |k| std::env::var(k).ok()).root,
            cols,
            rows,
            scrollback: None,
            output,
            signal_dir: None, before: Vec::new(),
        };
        self.spawn_in(&mut terms, run)
    }

    /// `term_shell`: a PowerShell tab in `cwd` (from `shell_cwd`). No session and no saved history.
    pub fn shell(&self, cwd: PathBuf, cols: u16, rows: u16, output: Output) -> Result<TermInfo, String> {
        // Before the lock, as in `open`: looking for `pwsh` touches the disk.
        let (cli, label) = launch::shell()?;
        self.start_shell(cli, label, cwd, cols, rows, output)
    }

    fn start_shell(&self, cli: Cli, label: &str, cwd: PathBuf, cols: u16, rows: u16, output: Output) -> Result<TermInfo, String> {
        let (cols, rows) = clamp(cols, rows);
        launch::windows_build();
        let saved = settings::load(&self.inner.settings_path);
        let run = Run {
            id: format!("{}{}", launch::SHELL_PREFIX, uuid::Uuid::new_v4()),
            session_id: None,
            engine: Engine::Claude,
            cli,
            cwd,
            label: Some(label.to_string()),
            memory_root: settings::resolve(&saved, |k| std::env::var(k).ok()).root,
            cols,
            rows,
            scrollback: None,
            output,
            signal_dir: None, before: Vec::new(),
        };
        let mut terms = self.inner.terms.lock().unwrap();
        self.spawn_in(&mut terms, run)
    }

    pub fn write(&self, id: &str, data: &[u8]) -> Result<(), String> {
        let entry = self.inner.terms.lock().unwrap().get(id).cloned().ok_or(NOT_RUNNING)?;
        entry.pty.write(data).map_err(|_| NOT_RUNNING.to_string())?;
        if signal::is_user_input(data) {
            self.inner.clear_attention(&entry.shared);
        }
        Ok(())
    }

    /// `term_seen`: the user has looked at the terminal, so its attention is cleared.
    pub fn seen(&self, id: &str) {
        let entry = self.inner.terms.lock().unwrap().get(id).cloned();
        if let Some(entry) = entry {
            self.inner.clear_attention(&entry.shared);
        }
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let entry = self.inner.terms.lock().unwrap().get(id).cloned();
        if let Some(entry) = entry {
            let (cols, rows) = clamp(cols, rows);
            let _ = entry.pty.resize(cols, rows);
        }
        Ok(())
    }

    /// Ask the program to leave; the exit handler records the rest. The entry is cloned out of the map first because
    /// `close` can wait for seconds.
    pub fn close(&self, id: &str) {
        let terms = self.inner.terms.lock().unwrap();
        let Some(entry) = terms.get(id).cloned() else {
            // Nothing runs: a terminal session that never started (its first start failed) is ended, so its tab goes away
            // and its worktree can be removed. Done under `terms`, so a start cannot begin in between.
            let agents = &self.inner.agents;
            if agents.info(id).is_ok_and(|info| info.interface == Interface::Terminal && info.status == Status::Idle) {
                let _ = agents.amend(id, |info| {
                    info.status = Status::Ended;
                    info.ended_at = Some(agent::now_ms());
                });
            }
            return;
        };
        drop(terms);
        entry.shared.close_requested.store(true, Ordering::SeqCst);
        entry.pty.close();
    }

    /// The process id of every session terminal whose program runs now (sign-in and PowerShell tabs have no session).
    pub fn pids(&self) -> Vec<(String, u32)> {
        let terms = self.inner.terms.lock().unwrap();
        terms.values().filter_map(|entry| Some((entry.shared.session_id.clone()?, entry.pty.pid()?))).collect()
    }

    pub fn list(&self) -> Vec<TermInfo> {
        let mut all: Vec<TermInfo> = self.inner.terms.lock().unwrap().values().map(|entry| info_of(&entry.shared)).collect();
        all.sort_by(|a, b| a.id.cmp(&b.id));
        all
    }

    /// Close every terminal, for when the app exits. Runs the closes side by side and waits for them.
    pub fn stop_all(&self) {
        let entries: Vec<Arc<Entry>> = self.inner.terms.lock().unwrap().values().cloned().collect();
        let closes: Vec<_> = entries
            .into_iter()
            .map(|entry| {
                std::thread::spawn(move || {
                    entry.shared.close_requested.store(true, Ordering::SeqCst);
                    entry.pty.close();
                })
            })
            .collect();
        for close in closes {
            let _ = close.join();
        }
        // Each exit handler removes its entry and records the status; give them a moment.
        let waited = Instant::now();
        while waited.elapsed() < RECORD_WAIT && !self.inner.terms.lock().unwrap().is_empty() {
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// Start one program, for tests with a harmless one (`open` and `login` call `spawn_in`).
    #[cfg(test)]
    fn spawn(&self, run: Run) -> Result<TermInfo, String> {
        let mut terms = self.inner.terms.lock().unwrap();
        self.spawn_in(&mut terms, run)
    }

    /// Start one program with the map already locked. Rejects when `MAX_TERMINALS` are running.
    fn spawn_in(&self, terms: &mut Terms, run: Run) -> Result<TermInfo, String> {
        if terms.contains_key(&run.id) {
            return Err("This terminal is already running".into());
        }
        if !run.id.starts_with("login-") && terms.keys().filter(|id| !id.starts_with("login-")).count() >= MAX_TERMINALS {
            return Err(format!("Close a terminal first: {MAX_TERMINALS} are already running"));
        }
        let own: Vec<String> = std::env::vars_os().map(|(name, _)| name.to_string_lossy().into_owned()).collect();
        let (mut env, env_remove) = launch::environment(&own, run.memory_root.as_deref(), &run.id);
        if let Some(dir) = &run.signal_dir {
            env.push(("HIVEMIND_SIGNAL_DIR".to_string(), dir.display().to_string()));
        }
        // Codex rings the terminal; only its session terminals are scanned (not the sign-in and not PowerShell).
        let scanner = (run.engine == Engine::Codex && run.session_id.is_some()).then(|| Mutex::new(Scanner::default()));
        let shared = Arc::new(Shared {
            id: run.id,
            session_id: run.session_id,
            engine: run.engine,
            shell: run.label.map(|label| (label, run.cwd.display().to_string())),
            out: Mutex::new(Out { output: Some(run.output), scrollback: run.scrollback }),
            close_requested: AtomicBool::new(false),
            refreshing: AtomicBool::new(false),
            since: agent::now_ms(),
            before: run.before,
            attention: Mutex::new(None),
        });
        let (inner, handler) = (self.inner.clone(), shared.clone());
        let sink: pty::Sink = Arc::new(move |event| match event {
            TermEvent::Data(bytes) => {
                // One signal per batch at most (a waiting one wins), raised after `out` is released.
                let mut rung: Option<Kind> = None;
                if let Some(scanner) = &scanner {
                    scanner.lock().unwrap().feed(&bytes, |kind| {
                        if rung != Some(Kind::Waiting) {
                            rung = Some(kind);
                        }
                    });
                }
                let mut out = handler.out.lock().unwrap();
                if let Some(scrollback) = out.scrollback.as_mut() {
                    scrollback.append(&bytes);
                }
                if let Some(output) = &out.output
                    && !output(bytes)
                {
                    out.output = None;
                }
                drop(out);
                if let Some(kind) = rung {
                    inner.raise_attention(&handler, kind);
                }
            }
            TermEvent::Quiet => inner.quiet(&handler),
            TermEvent::Exit(code) => inner.finish(&handler, code),
        });
        let pty = pty::Session::open(
            Spawn { program: &run.cli.program, args: &run.cli.args, cwd: &run.cwd, env: &env, env_remove: &env_remove, cols: run.cols, rows: run.rows },
            sink,
        )
        .map_err(|e| format!("Could not start {}: {e}", run.cli.program))?;
        let started = info_of(&shared);
        if let Some(dir) = &run.signal_dir {
            self.inner.watch_signals(shared.clone(), dir.join(signal::SIGNALS));
        }
        terms.insert(shared.id.clone(), Arc::new(Entry { shared, pty }));
        Ok(started)
    }
}

impl Inner {
    /// Re-attach to a running PowerShell tab after the page reloaded. It has no saved history, so nothing is replayed.
    fn attach_shell(&self, id: &str, cols: u16, rows: u16, output: Output) -> Result<TermInfo, String> {
        let (cols, rows) = clamp(cols, rows);
        let entry = self.terms.lock().unwrap().get(id).filter(|entry| entry.shared.shell.is_some()).cloned().ok_or(NOT_RUNNING)?;
        self.attach(&entry, cols, rows, None, output);
        Ok(info_of(&entry.shared))
    }

    fn scrollback_path(&self, session_id: &str) -> Result<PathBuf, String> {
        Ok(session_dir(&self.dir, session_id)?.join("scrollback.bin"))
    }

    /// Make `output` the terminal's output and fit the PTY to it. The saved history and the swap happen under one lock,
    /// so no byte is lost or sent twice between them.
    fn attach(&self, entry: &Entry, cols: u16, rows: u16, replay: Option<&Path>, output: Output) {
        {
            let mut out = entry.shared.out.lock().unwrap();
            let delivered = replay.is_none_or(|path| send_saved(path, &output));
            out.output = delivered.then_some(output);
        }
        let _ = entry.pty.resize(cols, rows);
    }

    /// The thread a Codex resume continues: the stored one when its rollout still exists (else it is cleared), or, for a
    /// session from before threads were stored, the one found by folder and start time (and stored).
    fn known_thread(&self, info: &SessionInfo) -> Option<String> {
        if self.home.as_os_str().is_empty() {
            return None;
        }
        let found = match &info.engine_session {
            Some(id) if cli_files::codex_rollout(&self.home, id).is_some() => return Some(id.clone()),
            Some(_) => None,
            None => self.find_thread(info, info.started_at, &[]),
        };
        if found != info.engine_session {
            let _ = self.agents.amend(&info.id, |info| info.engine_session = found.clone());
        }
        found
    }

    /// The Codex thread started in the session's folder at or after `since`, leaving out the other sessions' threads and
    /// those in `before`. None when it is not there yet or more than one is left.
    fn find_thread(&self, info: &SessionInfo, since: u64, before: &[String]) -> Option<String> {
        let cwd = session_cwd(info).ok()?.display().to_string();
        let taken: Vec<String> = self.agents.sessions().into_iter().filter(|s| s.id != info.id).filter_map(|s| s.engine_session).collect();
        cli_files::codex_thread(&self.home, &cwd, since, &taken, before)
    }

    /// Fill `engine_session` (Codex) and `cli_title` from the CLI's files. True when there is nothing more to find.
    /// Reads files and takes the session lock only; call it without the terminal map locked.
    fn discover(&self, session_id: &str, since: u64, before: &[String]) -> bool {
        if self.home.as_os_str().is_empty() {
            return true;
        }
        let Ok(info) = self.agents.info(session_id) else { return true };
        let engine = Engine::of(&info.adapter);
        let (thread, title) = match engine {
            Engine::Claude => {
                let cwd = session_cwd(&info).map(|path| path.display().to_string()).unwrap_or_default();
                let conversation = history::conversation_id(engine, &info).unwrap_or(session_id);
                (None, cli_files::claude_transcript(&self.home, &cwd, conversation).and_then(|path| cli_files::claude_title(&path)))
            }
            Engine::Codex => {
                let thread = info.engine_session.clone().or_else(|| self.find_thread(&info, since, before));
                let title = thread.as_deref().and_then(|id| cli_files::codex_title(&self.home, id));
                (thread, title)
            }
        };
        let new_thread = thread.clone().filter(|_| info.engine_session.is_none());
        let new_title = title.clone().filter(|title| info.cli_title.as_ref() != Some(title));
        if new_thread.is_some() || new_title.is_some() {
            let _ = self.agents.amend(session_id, |info| {
                if let Some(thread) = new_thread {
                    info.engine_session = Some(thread);
                }
                if let Some(title) = new_title {
                    info.cli_title = Some(title);
                }
            });
        }
        title.is_some() && (engine == Engine::Claude || thread.is_some())
    }

    /// Look for the CLI's conversation file and title every few seconds while the program runs, on a thread of its own.
    /// The exit handler looks once more.
    fn watch(self: &Arc<Self>, shared: Arc<Shared>) {
        let Some(session_id) = shared.session_id.clone() else { return };
        let inner = self.clone();
        std::thread::spawn(move || {
            for _ in 0..WATCH_TRIES {
                std::thread::sleep(WATCH_EVERY);
                let alive = inner.terms.lock().unwrap().get(&shared.id).is_some_and(|entry| Arc::ptr_eq(&entry.shared, &shared));
                if !alive || inner.discover(&session_id, shared.since, &shared.before) {
                    return;
                }
            }
        });
    }

    /// The tab's name for a notification: the session's name, the CLI's title, its task, else the program's name.
    fn notice_title(&self, shared: &Shared) -> String {
        let info = shared.session_id.as_deref().and_then(|id| self.agents.info(id).ok());
        let fallback = if shared.engine == Engine::Codex { "Codex" } else { "Claude Code" };
        info.and_then(|info| [info.name, info.cli_title, Some(info.title)].into_iter().flatten().map(|t| t.trim().to_string()).find(|t| !t.is_empty()))
            .unwrap_or_else(|| fallback.to_string())
    }

    /// The program needs the user or has finished. Nothing happens when that kind is already set, so a repeated
    /// signal does not notify twice. Takes no lock but the attention's own, and the session lock for the title.
    fn raise_attention(&self, shared: &Shared, kind: Kind) {
        {
            let mut attention = shared.attention.lock().unwrap();
            if attention.is_some_and(|a| a.kind == kind) {
                return;
            }
            *attention = Some(Attention { kind });
        }
        let title = self.notice_title(shared);
        (self.sink)(Emit::Attention { id: shared.id.clone(), kind: Some(kind), title });
    }

    fn clear_attention(&self, shared: &Shared) {
        if shared.attention.lock().unwrap().take().is_some() {
            (self.sink)(Emit::Attention { id: shared.id.clone(), kind: None, title: String::new() });
        }
    }

    /// Follow a Claude terminal's `signals.jsonl` while it runs, on a thread of its own.
    fn watch_signals(self: &Arc<Self>, shared: Arc<Shared>, path: PathBuf) {
        let inner = self.clone();
        std::thread::spawn(move || {
            let mut intake = Intake::default();
            loop {
                std::thread::sleep(SIGNAL_EVERY);
                let alive = inner.terms.lock().unwrap().get(&shared.id).is_some_and(|entry| Arc::ptr_eq(&entry.shared, &shared));
                if !alive {
                    return;
                }
                for kind in intake.poll(&path) {
                    inner.raise_attention(&shared, kind);
                }
            }
        });
    }

    /// No output for a while: look at what the program changed, on a thread of its own because it runs git.
    fn quiet(self: &Arc<Self>, shared: &Arc<Shared>) {
        let Some(session_id) = shared.session_id.clone() else { return };
        if shared.refreshing.swap(true, Ordering::SeqCst) {
            return;
        }
        let (inner, shared) = (self.clone(), shared.clone());
        std::thread::spawn(move || {
            inner.refresh_files(&session_id, false);
            shared.refreshing.store(false, Ordering::SeqCst);
        });
    }

    /// Store the current totals when they differ from the stored ones. Errors leave the stored value. A session in the
    /// user's own folder is looked at only when its program has ended (`ended`): that takes a snapshot of the folder, too
    /// slow to repeat while the program runs.
    fn refresh_files(&self, session_id: &str, ended: bool) {
        let Ok(info) = self.agents.info(session_id) else { return };
        let files = match (&info.worktree, &info.direct) {
            (Some(tree), _) => worktree::changes(tree),
            (None, Some(direct)) if ended => crate::review::direct_files_now(direct),
            _ => return,
        };
        let Ok(files) = files else { return };
        let new = worktree::totals(&files);
        // When the program ends after Request changes, the session waits for review again even if the revision kept the
        // totals (a rename changes no counts).
        let answered = ended && info.review.as_ref().is_some_and(|review| review.state == agent::ReviewState::ChangesRequested);
        if new == info.files_changed.unwrap_or_default() && !answered {
            return;
        }
        let _ = self.agents.amend(session_id, |info| {
            let old = info.files_changed;
            info.files_changed = Some(new);
            info.review = agent::review_after_turn(info.review.take(), old.as_ref(), Some(&new), agent::now_ms());
        });
    }

    /// The program has exited and all its output was handled. The files are looked at first, without any lock, because
    /// that runs git; then the entry leaves the map and the status is stored under the map's lock, so a start that
    /// follows the removal cannot be overwritten by this status.
    fn finish(&self, shared: &Shared, code: Option<u32>) {
        if let Some(session_id) = &shared.session_id {
            self.refresh_files(session_id, true);
            self.discover(session_id, shared.since, &shared.before);
        }
        let mut terms = self.terms.lock().unwrap();
        terms.remove(&shared.id);
        if let Some(session_id) = &shared.session_id {
            let quiet = shared.close_requested.load(Ordering::SeqCst) || code.is_some_and(|code| QUIET_EXITS.contains(&code));
            let _ = self.agents.amend(session_id, |info| {
                info.status = if quiet { Status::Ended } else { Status::Failed };
                info.ended_at = Some(agent::now_ms());
                info.error = (!quiet).then(|| match code {
                    Some(code) => format!("The program exited with code {code}."),
                    None => "The program ended without an exit code.".to_string(),
                });
            });
        }
        drop(terms);
        (self.sink)(Emit::Exit(TermExit { id: shared.id.clone(), session_id: shared.session_id.clone(), code }));
    }
}

/// A session terminal's arguments after the launch prefix: attention, then the session's own (section 5.4), then, for a
/// resume that carries review feedback, the prompt that points the CLI at that file.
fn start_args(info: &SessionInfo, mode: StartMode, signals: Option<&Path>, context: &Path, thread: Option<&str>, feedback: Option<&Path>) -> Vec<String> {
    let engine = Engine::of(&info.adapter);
    let mut args = launch::signal_args(engine, signals);
    args.extend(launch::session_args(
        engine,
        mode,
        &info.access.unwrap_or_else(|| Access::from_policy(engine, info.policy)),
        info.model.as_deref(),
        info.effort.as_deref(),
        &scope::governed_rules(),
        info.name.as_deref(),
        &info.id,
        context,
        info.no_task,
        thread,
    ));
    if let Some(file) = feedback {
        args.push(launch::review_prompt(file));
    }
    args
}

/// Send the saved history as one message; false when the receiver is gone. Nothing is sent when there is none.
fn send_saved(path: &Path, output: &Output) -> bool {
    let saved = Scrollback::read(path);
    saved.is_empty() || output(saved)
}

/// The session's folder under `dir`; only a plain UUID names one.
pub fn session_dir(dir: &Path, session_id: &str) -> Result<PathBuf, String> {
    crate::agent::store::log_path(dir, session_id)?;
    Ok(dir.join(session_id))
}

/// The folder a session's program runs in: its worktree, or else the folder it was started in.
fn session_cwd(info: &SessionInfo) -> Result<PathBuf, String> {
    let (path, missing) = match (&info.worktree, &info.direct) {
        (Some(tree), _) => (&tree.path, "The session's worktree folder is missing"),
        (None, Some(direct)) => (&direct.path, "The session's folder is missing"),
        (None, None) => return Err("This session has no worktree".into()),
    };
    let cwd = PathBuf::from(path);
    if cwd.is_dir() { Ok(cwd) } else { Err(format!("{missing}: {path}")) }
}

/// The folder a PowerShell tab starts in, which must exist. `checkout` looks up a project's registered repository
/// (it needs the bridge, so the caller passes it in).
pub fn shell_cwd(
    target: &ShellTarget,
    agents: &agent::Manager,
    saved: &settings::Settings,
    checkout: impl FnOnce(&str, &str) -> Result<PathBuf, String>,
) -> Result<PathBuf, String> {
    let folder = match target {
        ShellTarget::Session(id) => return session_cwd(&agents.info(id)?),
        ShellTarget::Checkout { project, repo } => checkout(project, repo)?,
        ShellTarget::Folder(path) => return scope::other_folder(saved, path),
    };
    if folder.is_dir() { Ok(folder) } else { Err(format!("The folder no longer exists: {}", folder.display())) }
}

/// Write the user's review comments to `<dir>/<session id>/context/review-<n>.md`, n being the next free number from 1, and
/// return the file's path. The file holds the comments as they are written.
pub fn write_feedback(dir: &Path, session_id: &str, text: &str) -> Result<PathBuf, String> {
    let context = session_dir(dir, session_id)?.join("context");
    std::fs::create_dir_all(&context).map_err(|e| format!("Could not create {}: {e}", context.display()))?;
    let taken = std::fs::read_dir(&context)
        .map_err(|e| format!("Could not read {}: {e}", context.display()))?
        .flatten()
        .filter_map(|entry| entry.file_name().to_string_lossy().strip_prefix("review-")?.strip_suffix(".md")?.parse::<u32>().ok())
        .max()
        .unwrap_or(0);
    let file = context.join(format!("review-{}.md", taken + 1));
    std::fs::write(&file, text).map_err(|e| format!("Could not write {}: {e}", file.display()))?;
    Ok(file)
}

impl Manager {
    /// `write_feedback` into this manager's folder.
    pub fn feedback_file(&self, session_id: &str, text: &str) -> Result<PathBuf, String> {
        write_feedback(&self.inner.dir, session_id, text)
    }
}

/// Write `<dir>/<session id>/context/briefing.md` and return the `context` folder.
pub fn write_briefing(dir: &Path, session_id: &str, text: &str) -> Result<PathBuf, String> {
    let context = session_dir(dir, session_id)?.join("context");
    std::fs::create_dir_all(&context).map_err(|e| format!("Could not create {}: {e}", context.display()))?;
    let file = context.join("briefing.md");
    std::fs::write(&file, text).map_err(|e| format!("Could not write {}: {e}", file.display()))?;
    Ok(context)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::events::Mode;
    use crate::agent::scope::{AgentTask, PolicyMode};
    use crate::agent::{Review, ReviewState, SessionInfo};
    use crate::worktree::{Totals, Worktree};
    use serde_json::json;
    use std::process::Command;

    #[test]
    fn start_mode_reads_lowercase() {
        assert_eq!(serde_json::from_value::<StartMode>(json!("fresh")).unwrap(), StartMode::Fresh);
        assert_eq!(serde_json::from_value::<StartMode>(json!("resume")).unwrap(), StartMode::Resume);
        assert!(serde_json::from_value::<StartMode>(json!("other")).is_err());
    }

    #[test]
    fn only_plain_uuids_name_a_terminal_folder() {
        let dir = std::env::temp_dir().join(format!("hivemind-term-dir-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        let id = "00000000-0000-4000-8000-000000000001";
        assert_eq!(session_dir(&dir, id).unwrap(), dir.join(id));
        for bad in ["", "../x", "login-claude", "00000000-0000-4000-8000-00000000000A"] {
            assert!(session_dir(&dir, bad).is_err(), "{bad}");
            assert!(write_briefing(&dir, bad, "x").is_err(), "{bad}");
        }
        let context = write_briefing(&dir, id, "Briefing\n\n---\n\nTask").unwrap();
        assert_eq!(context, dir.join(id).join("context"));
        assert_eq!(std::fs::read_to_string(context.join("briefing.md")).unwrap(), "Briefing\n\n---\n\nTask");
        std::fs::remove_dir_all(&dir).ok();
    }

    fn git_available() -> bool {
        Command::new("git").arg("--version").output().map(|o| o.status.success()).unwrap_or(false)
    }

    fn git(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git").arg("-C").arg(dir).args(args).output().unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    /// A harmless program: the first script runs under `cmd.exe` on Windows, the second under `sh` elsewhere.
    fn shell(windows: &str, unix: &str) -> Cli {
        if cfg!(windows) {
            Cli { program: "cmd.exe".into(), args: vec!["/d".into(), "/c".into(), windows.into()] }
        } else {
            Cli { program: "sh".into(), args: vec!["-c".into(), unix.into()] }
        }
    }

    /// A program that prints nothing and stays for a minute.
    fn lingering() -> Cli {
        shell("ping -n 60 127.0.0.1 >nul", "sleep 60")
    }

    type Bytes = Arc<Mutex<Vec<u8>>>;

    fn collector() -> (Output, Bytes) {
        let bytes: Bytes = Arc::default();
        let into = bytes.clone();
        (
            Arc::new(move |chunk| {
                into.lock().unwrap().extend_from_slice(&chunk);
                true
            }),
            bytes,
        )
    }

    fn text(bytes: &Bytes) -> String {
        String::from_utf8_lossy(&bytes.lock().unwrap()).into_owned()
    }

    struct Rig {
        dir: PathBuf,
        agents: agent::Manager,
        terms: Manager,
        exits: Arc<Mutex<Vec<TermExit>>>,
        changed: Arc<Mutex<usize>>,
        attention: Attentions,
    }

    impl Rig {
        fn new(name: &str) -> Rig {
            let dir = std::env::temp_dir().join(format!("hivemind-term-{name}-{}", std::process::id()));
            std::fs::remove_dir_all(&dir).ok();
            std::fs::create_dir_all(&dir).unwrap();
            // A program that exists and is harmless, so `open` never reaches the real Claude Code.
            let harmless = if cfg!(windows) { std::env::var("ComSpec").unwrap_or_else(|_| "C:\\Windows\\System32\\cmd.exe".into()) } else { "/bin/sh".into() };
            let settings_path = dir.join("settings.json");
            settings::save(&settings_path, &settings::Settings { claude_path: Some(harmless), ..Default::default() }).unwrap();
            let changed: Arc<Mutex<usize>> = Arc::default();
            let counted = changed.clone();
            let agents = agent::Manager::new(
                dir.join("sessions"),
                Arc::new(agent::claude::ClaudeCode),
                Arc::new(agent::codex::Codex),
                Arc::new(move |emit| {
                    if matches!(emit, agent::Emit::SessionsChanged) {
                        *counted.lock().unwrap() += 1;
                    }
                }),
            );
            let exits: Arc<Mutex<Vec<TermExit>>> = Arc::default();
            let attention: Attentions = Arc::default();
            let terms = Manager::new_in(dir.join("terminals"), agents.clone(), settings_path, rig_sink(&exits, &attention), dir.join("home"));
            Rig { dir, agents, terms, exits, changed, attention }
        }

        fn info(id: &str, tree: Option<Worktree>) -> SessionInfo {
            SessionInfo {
                id: id.to_string(),
                adapter: "claude".into(),
                cli_version: None,
                task: AgentTask::Work { project: "paystream".into(), repo: "api".into(), branch: None, change: None },
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
                worktree: tree,
                turns: 0,
                files_changed: None,
                context: vec![],
                model: None,
                system: None,
                review: None,
                source_sha: None,
                interface: Interface::Terminal,
                name: None,
                cli_title: None,
                direct: None,
                no_task: false,
                access: None,
                effort: None,
                engine_session: None,
                role: None,
                profile: None,
                summary: None,
                verdict: None,
                origin: None,
            }
        }

        /// A terminal session over `tree`, registered as `agent_start` does.
        fn session(&self, tree: Option<Worktree>) -> String {
            let id = uuid::Uuid::new_v4().to_string();
            self.agents.register(Rig::info(&id, tree)).unwrap();
            id
        }

        /// A worktree over a plain folder (no git).
        fn plain_tree(&self) -> Worktree {
            let path = self.dir.join("work");
            std::fs::create_dir_all(&path).unwrap();
            let path = path.display().to_string();
            Worktree { repo: path.clone(), path, branch: "hivemind/test".into(), base_branch: "main".into(), base_sha: "0".into(), reviewed_sha: None }
        }

        /// A worktree over a temp repository with one commit; None when git is missing.
        fn git_tree(&self) -> Option<Worktree> {
            if !git_available() {
                return None;
            }
            let path = self.dir.join("repo");
            std::fs::create_dir_all(&path).unwrap();
            git(&path, &["init", "-q"]);
            git(&path, &["config", "user.name", "Tester"]);
            git(&path, &["config", "user.email", "t@example.com"]);
            git(&path, &["config", "commit.gpgsign", "false"]);
            std::fs::write(path.join("f.txt"), "base\n").unwrap();
            git(&path, &["add", "."]);
            git(&path, &["commit", "-q", "-m", "first"]);
            let base_sha = git(&path, &["rev-parse", "HEAD"]);
            let path = path.display().to_string();
            Some(Worktree { repo: path.clone(), path, branch: "hivemind/test".into(), base_branch: "main".into(), base_sha, reviewed_sha: None })
        }

        fn run_with(&self, session: &str, cli: Cli, output: Output) -> Result<TermInfo, String> {
            let info = self.agents.info(session).unwrap();
            let cwd = PathBuf::from(&info.worktree.as_ref().unwrap().path);
            self.agents.amend(session, |info| info.status = Status::Running).unwrap();
            self.terms.spawn(Run {
                id: session.to_string(),
                session_id: Some(session.to_string()),
                engine: Engine::Claude,
                cli,
                cwd,
                label: None,
                memory_root: None,
                cols: 200,
                rows: 24,
                scrollback: Scrollback::open(self.terms.inner.scrollback_path(session).unwrap(), scrollback::KEEP).ok(),
                output,
                signal_dir: None, before: Vec::new(),
            })
        }

        fn run(&self, session: &str, cli: Cli) -> (TermInfo, Bytes) {
            let (output, bytes) = collector();
            (self.run_with(session, cli, output).unwrap(), bytes)
        }

        /// Wait for the `count`th exit.
        fn wait_exits(&self, count: usize) -> Vec<TermExit> {
            let start = Instant::now();
            loop {
                let exits = self.exits.lock().unwrap().clone();
                if exits.len() >= count {
                    return exits;
                }
                assert!(start.elapsed() < Duration::from_secs(20), "no exit within 20 s: {exits:?}");
                std::thread::sleep(Duration::from_millis(20));
            }
        }

        fn saved(&self, session: &str) -> Vec<u8> {
            Scrollback::read(&self.terms.inner.scrollback_path(session).unwrap())
        }

        fn clean(self) {
            std::fs::remove_dir_all(&self.dir).ok();
        }
    }

    /// The attention changes the sink saw: terminal id, kind, title.
    type Attentions = Arc<Mutex<Vec<(String, Option<Kind>, String)>>>;

    fn rig_sink(exits: &Arc<Mutex<Vec<TermExit>>>, attention: &Attentions) -> Sink {
        let (exits, attention) = (exits.clone(), attention.clone());
        Arc::new(move |emit| {
            match emit {
                Emit::Exit(exit) => exits.lock().unwrap().push(exit),
                Emit::Attention { id, kind, title } => attention.lock().unwrap().push((id, kind, title)),
            }
        })
    }

    #[test]
    fn a_terminal_runs_and_ends_its_session() {
        let rig = Rig::new("runs");
        let id = rig.session(Some(rig.plain_tree()));
        let (started, bytes) = rig.run(&id, shell("echo hello", "echo hello"));
        assert!(started.running);
        assert_eq!((started.id.as_str(), started.session_id.as_deref()), (id.as_str(), Some(id.as_str())));
        let exits = rig.wait_exits(1);
        assert_eq!(exits, vec![TermExit { id: id.clone(), session_id: Some(id.clone()), code: Some(0) }]);
        let info = rig.agents.info(&id).unwrap();
        assert_eq!(info.status, Status::Ended);
        assert!(info.ended_at.is_some());
        assert_eq!(info.error, None);
        assert!(rig.terms.list().is_empty());
        assert!(text(&bytes).contains("hello"));
        assert!(String::from_utf8_lossy(&rig.saved(&id)).contains("hello"));
        rig.clean();
    }

    fn write_file(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    const THREAD: &str = "019b0000-aaaa-7bbb-8ccc-ddddeeeeffff";

    /// A Codex rollout and index entry for `cwd`, filed far in the future so it is after any session's start.
    fn codex_files(rig: &Rig, cwd: &str, thread: &str, name: &str) {
        let meta = json!({"type": "session_meta", "payload": {"id": thread, "cwd": cwd, "timestamp": "2099-01-01T00:00:00.000Z"}});
        write_file(&rig.dir.join("home/.codex/sessions/2099/01/01").join(format!("rollout-2099-01-01T00-00-00-{thread}.jsonl")), &format!("{meta}\n"));
        write_file(&rig.dir.join("home/.codex/session_index.jsonl"), &format!("{}\n", json!({"id": thread, "thread_name": name})));
    }

    #[test]
    fn the_exit_fills_a_claude_session_title_from_its_transcript() {
        let rig = Rig::new("title-claude");
        let tree = rig.plain_tree();
        let id = rig.session(Some(tree.clone()));
        let file = cli_files::claude_folder(&tree.path);
        write_file(
            &rig.dir.join("home/.claude/projects").join(file).join(format!("{id}.jsonl")),
            "{\"type\":\"ai-title\",\"aiTitle\":\"Old\"}\n{\"type\":\"ai-title\",\"aiTitle\":\"Fix the importer\"}\n{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"hi\"}}\n",
        );
        rig.run(&id, shell("echo hi", "echo hi"));
        rig.wait_exits(1);
        assert_eq!(rig.agents.info(&id).unwrap().cli_title.as_deref(), Some("Fix the importer"));
        let events = rig.terms.transcript(&id).unwrap();
        assert_eq!(events.len(), 1);
        assert!(matches!(&events[0].event, crate::agent::events::RunEvent::UserMessage { text, .. } if text == "hi"));
        rig.clean();
    }

    #[test]
    fn the_exit_stores_a_codex_thread_and_its_name_and_the_transcript_follows_it() {
        let rig = Rig::new("title-codex");
        let tree = rig.plain_tree();
        let id = rig.session(Some(tree.clone()));
        rig.agents.amend(&id, |info| info.adapter = "codex".into()).unwrap();
        assert!(rig.terms.transcript(&id).unwrap().is_empty());
        codex_files(&rig, &tree.path, THREAD, "Add a retry");
        rig.run(&id, shell("echo hi", "echo hi"));
        rig.wait_exits(1);
        let info = rig.agents.info(&id).unwrap();
        assert_eq!(info.engine_session.as_deref(), Some(THREAD));
        assert_eq!(info.cli_title.as_deref(), Some("Add a retry"));
        assert!(rig.terms.transcript(&id).unwrap().is_empty());
        rig.clean();
    }

    #[test]
    fn a_stale_thread_is_cleared_and_a_missing_one_is_looked_up() {
        let rig = Rig::new("stale-thread");
        let tree = rig.plain_tree();
        let id = rig.session(Some(tree.clone()));
        rig.agents.amend(&id, |info| {
            info.adapter = "codex".into();
            info.engine_session = Some(THREAD.into());
            info.started_at = 1;
        })
        .unwrap();
        // No rollout under the home folder has that id: the id is cleared, so the resume uses --last.
        assert_eq!(rig.terms.inner.known_thread(&rig.agents.info(&id).unwrap()), None);
        assert_eq!(rig.agents.info(&id).unwrap().engine_session, None);
        // A session without a stored thread finds its rollout by folder and time, and stores it.
        codex_files(&rig, &tree.path, THREAD, "Name");
        assert_eq!(rig.terms.inner.known_thread(&rig.agents.info(&id).unwrap()).as_deref(), Some(THREAD));
        assert_eq!(rig.agents.info(&id).unwrap().engine_session.as_deref(), Some(THREAD));
        // A stored thread whose rollout exists is kept.
        assert_eq!(rig.terms.inner.known_thread(&rig.agents.info(&id).unwrap()).as_deref(), Some(THREAD));
        rig.clean();
    }

    #[test]
    fn a_terminal_program_gets_the_store_root() {
        let rig = Rig::new("root");
        let id = rig.session(Some(rig.plain_tree()));
        let root = rig.dir.join("store");
        std::fs::create_dir_all(&root).unwrap();
        let echo = shell("echo %LIVING_MEMORY_ROOT%", "echo $LIVING_MEMORY_ROOT");
        let (output, bytes) = collector();
        let run = |session: &str, memory_root: Option<PathBuf>, output: Output| {
            let cwd = PathBuf::from(&rig.agents.info(session).unwrap().worktree.unwrap().path);
            rig.terms
                .spawn(Run { id: session.into(), session_id: Some(session.into()), engine: Engine::Claude, cli: echo.clone(), cwd, label: None, memory_root, cols: 300, rows: 24, scrollback: None, output, signal_dir: None, before: Vec::new() })
                .unwrap()
        };
        run(&id, Some(root.clone()), output);
        rig.wait_exits(1);
        assert!(text(&bytes).contains(&root.display().to_string()), "{}", text(&bytes));
        if std::env::var_os("LIVING_MEMORY_ROOT").is_none() {
            let (output, bytes) = collector();
            run(&id, None, output);
            rig.wait_exits(2);
            assert!(!text(&bytes).contains(&root.display().to_string()), "{}", text(&bytes));
        }
        rig.clean();
    }

    #[test]
    fn a_bad_exit_fails_the_session() {
        let rig = Rig::new("bad-exit");
        let id = rig.session(Some(rig.plain_tree()));
        rig.run(&id, shell("exit 3", "exit 3"));
        assert_eq!(rig.wait_exits(1)[0].code, Some(3));
        let info = rig.agents.info(&id).unwrap();
        assert_eq!(info.status, Status::Failed);
        assert_eq!(info.error.as_deref(), Some("The program exited with code 3."));
        assert!(info.ended_at.is_some());
        rig.clean();
    }

    #[test]
    fn an_answered_request_waits_for_review_again_with_the_same_totals() {
        let rig = Rig::new("answered");
        let Some(tree) = rig.git_tree() else { return };
        let id = rig.session(Some(tree));
        rig.agents.amend(&id, |info| info.review = Some(Review { state: ReviewState::ChangesRequested, commit: None, at: 1 })).unwrap();
        // The revision changed no counts (here: nothing at all); the end of the program still reopens the review.
        rig.run(&id, shell("exit 0", "exit 0"));
        rig.wait_exits(1);
        assert_eq!(rig.agents.info(&id).unwrap().review.map(|review| review.state), Some(ReviewState::Pending));
        rig.clean();
    }

    #[test]
    fn files_changed_follows_the_worktree() {
        let rig = Rig::new("files");
        let Some(tree) = rig.git_tree() else { return };
        let id = rig.session(Some(tree));
        rig.agents.amend(&id, |info| info.review = Some(Review { state: ReviewState::Approved, commit: None, at: 1 })).unwrap();
        let before = *rig.changed.lock().unwrap();
        rig.run(&id, shell("echo x>> f.txt & echo done & ping -n 8 127.0.0.1 >nul", "echo x >> f.txt; echo done; sleep 7"));
        // The program stays about 7 s; two quiet seconds after its output is when the refresh runs.
        let start = Instant::now();
        let found = loop {
            let info = rig.agents.info(&id).unwrap();
            if info.files_changed.is_some() {
                break info;
            }
            assert!(start.elapsed() < Duration::from_secs(6), "files_changed was not refreshed: {info:?}");
            std::thread::sleep(Duration::from_millis(50));
        };
        assert!(rig.exits.lock().unwrap().is_empty(), "the refresh must come before the exit");
        assert_eq!(found.files_changed, Some(Totals { files: 1, added: 1, removed: 0 }));
        assert_eq!(found.review.map(|review| review.state), Some(ReviewState::Pending));
        assert!(*rig.changed.lock().unwrap() > before);
        rig.wait_exits(1);
        assert_eq!(rig.agents.info(&id).unwrap().files_changed, Some(Totals { files: 1, added: 1, removed: 0 }));
        rig.clean();
    }

    #[test]
    fn closing_is_not_a_failure() {
        let rig = Rig::new("closing");
        let id = rig.session(Some(rig.plain_tree()));
        rig.run(&id, lingering());
        rig.terms.close(&id);
        rig.wait_exits(1);
        assert_eq!(rig.agents.info(&id).unwrap().status, Status::Ended);
        assert_eq!(rig.agents.info(&id).unwrap().error, None);
        rig.terms.close(&id);
        assert_eq!(rig.exits.lock().unwrap().len(), 1);
        assert_eq!(rig.terms.write(&id, b"x"), Err("This terminal is not running".to_string()));
        rig.clean();
    }

    #[test]
    fn open_refuses_what_it_must() {
        let rig = Rig::new("refuses");
        let (output, bytes) = collector();
        let open = |id: &str, start: Option<StartMode>| rig.terms.open(id, 80, 24, start, false, output.clone());
        assert_eq!(open("../x", None).unwrap_err(), "Invalid session id");
        assert_eq!(open(&uuid::Uuid::new_v4().to_string(), None).unwrap_err(), "Unknown session");
        let chat = uuid::Uuid::new_v4().to_string();
        rig.agents.register(SessionInfo { interface: Interface::Chat, ..Rig::info(&chat, None) }).unwrap();
        assert_eq!(open(&chat, None).unwrap_err(), "This session is not a terminal session");
        let bare = rig.session(None);
        assert_eq!(open(&bare, Some(StartMode::Fresh)).unwrap_err(), "This session has no worktree");
        let gone = rig.dir.join("gone");
        let missing = Worktree { path: gone.display().to_string(), repo: gone.display().to_string(), ..rig.plain_tree() };
        let lost = rig.session(Some(missing));
        let error = open(&lost, Some(StartMode::Resume)).unwrap_err();
        assert!(error.starts_with("The session's worktree folder is missing: "), "{error}");
        assert!(bytes.lock().unwrap().is_empty());
        assert!(rig.terms.list().is_empty());
        assert_eq!(rig.agents.info(&lost).unwrap().status, Status::Idle);
        rig.clean();
    }

    #[test]
    fn a_session_without_a_worktree_can_still_be_viewed() {
        let rig = Rig::new("view-bare");
        let id = rig.session(Some(rig.plain_tree()));
        rig.run(&id, shell("echo hello", "echo hello"));
        rig.wait_exits(1);
        rig.agents.amend(&id, |info| info.worktree = None).unwrap();
        let (output, bytes) = collector();
        let view = rig.terms.open(&id, 80, 24, None, true, output).unwrap();
        assert!(!view.running);
        let saved = rig.saved(&id);
        assert!(!saved.is_empty());
        assert_eq!(*bytes.lock().unwrap(), saved);
        rig.clean();
    }

    #[test]
    fn a_session_runs_in_its_worktree_else_in_its_own_folder() {
        let rig = Rig::new("cwd");
        let tree = rig.plain_tree();
        let folder = rig.dir.join("mine");
        std::fs::create_dir_all(&folder).unwrap();
        let direct = |path: &std::path::Path| Some(crate::agent::direct::Direct { path: path.display().to_string(), repo: None, head_sha: None, start_tree: None });
        let with = |tree: Option<Worktree>, direct| SessionInfo { direct, ..Rig::info("x", tree) };

        assert_eq!(session_cwd(&with(Some(tree.clone()), None)), Ok(PathBuf::from(&tree.path)));
        assert_eq!(session_cwd(&with(None, direct(&folder))), Ok(folder.clone()));
        assert_eq!(session_cwd(&with(Some(tree.clone()), direct(&folder))), Ok(PathBuf::from(&tree.path)), "a worktree wins");
        assert_eq!(session_cwd(&with(None, None)), Err("This session has no worktree".to_string()));
        let gone = rig.dir.join("gone");
        assert_eq!(session_cwd(&with(None, direct(&gone))), Err(format!("The session's folder is missing: {}", gone.display())));
        rig.clean();
    }

    #[test]
    fn opening_a_session_with_no_place_says_so() {
        let rig = Rig::new("no-place");
        let id = rig.session(None);
        let (output, _) = collector();
        assert_eq!(rig.terms.open(&id, 80, 24, Some(StartMode::Fresh), false, output).unwrap_err(), "This session has no worktree");
        rig.clean();
    }

    #[test]
    fn a_reserved_session_cannot_be_started() {
        let rig = Rig::new("reserved");
        let id = rig.session(Some(rig.plain_tree()));
        let reservation = rig.agents.reserve(&id).unwrap();
        let (output, bytes) = collector();
        let error = rig.terms.open(&id, 80, 24, Some(StartMode::Resume), false, output.clone()).unwrap_err();
        assert_eq!(error, "A review action is running for this session");
        assert!(rig.terms.list().is_empty());
        assert_eq!(rig.agents.info(&id).unwrap().status, Status::Idle);
        assert!(bytes.lock().unwrap().is_empty());
        let view = rig.terms.open(&id, 80, 24, None, true, output.clone()).unwrap();
        assert!(!view.running);
        drop(reservation);
        let started = rig.terms.open(&id, 80, 24, Some(StartMode::Resume), false, output).unwrap();
        assert!(started.running);
        assert_eq!(rig.agents.info(&id).unwrap().status, Status::Running);
        rig.terms.close(&id);
        rig.wait_exits(1);
        assert!(rig.terms.list().is_empty());
        rig.clean();
    }

    #[test]
    fn the_running_change_is_refused_under_a_reservation() {
        let rig = Rig::new("claim");
        let id = rig.session(Some(rig.plain_tree()));
        let reservation = rig.agents.reserve(&id).unwrap();
        let refused = rig.agents.amend_unreserved(&id, RESERVED, |info| info.status = Status::Running);
        assert_eq!(refused.unwrap_err(), RESERVED);
        assert_eq!(rig.agents.info(&id).unwrap().status, Status::Idle);
        drop(reservation);
        rig.agents.amend_unreserved(&id, RESERVED, |info| info.status = Status::Running).unwrap();
        assert_eq!(rig.agents.info(&id).unwrap().status, Status::Running);
        rig.clean();
    }

    #[test]
    fn closing_a_session_that_never_started_ends_it() {
        let rig = Rig::new("close-idle");
        let id = rig.session(Some(rig.plain_tree()));
        assert_eq!(rig.agents.info(&id).unwrap().status, Status::Idle);
        rig.terms.close(&id);
        let info = rig.agents.info(&id).unwrap();
        assert_eq!(info.status, Status::Ended);
        assert!(info.ended_at.is_some());
        // A failed session stays failed.
        let failed = rig.session(Some(rig.plain_tree()));
        rig.agents.amend(&failed, |info| info.status = Status::Failed).unwrap();
        rig.terms.close(&failed);
        assert_eq!(rig.agents.info(&failed).unwrap().status, Status::Failed);
        // A sign-in terminal id is not a session; closing it with nothing running does nothing.
        rig.terms.close("login-claude");
        rig.clean();
    }

    #[test]
    fn open_without_start_only_replays() {
        let rig = Rig::new("replay");
        let id = rig.session(Some(rig.plain_tree()));
        rig.run(&id, shell("echo hello", "echo hello"));
        rig.wait_exits(1);
        let saved = rig.saved(&id);
        assert!(!saved.is_empty());
        let before = rig.agents.info(&id).unwrap();
        let (output, bytes) = collector();
        let view = rig.terms.open(&id, 80, 24, None, true, output).unwrap();
        assert!(!view.running);
        assert_eq!(*bytes.lock().unwrap(), saved);
        assert!(rig.terms.list().is_empty());
        assert_eq!(rig.agents.info(&id).unwrap(), before);
        let (output, bytes) = collector();
        assert!(!rig.terms.open(&id, 80, 24, None, false, output).unwrap().running);
        assert!(bytes.lock().unwrap().is_empty());
        rig.clean();
    }

    #[test]
    fn attaching_swaps_the_output_and_loses_nothing() {
        let rig = Rig::new("attach");
        let id = rig.session(Some(rig.plain_tree()));
        let (first, first_bytes) = collector();
        rig.run_with(
            &id,
            shell("ping -n 4 127.0.0.1", "for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do echo line $i; sleep 0.2; done"),
            first,
        )
        .unwrap();
        std::thread::sleep(Duration::from_secs(1));
        let (second, second_bytes) = collector();
        let attached = rig.terms.open(&id, 100, 30, None, true, second).unwrap();
        assert!(attached.running);
        let swapped = first_bytes.lock().unwrap().len();
        rig.wait_exits(1);
        assert_eq!(first_bytes.lock().unwrap().len(), swapped, "the first output received bytes after the swap");
        let saved = rig.saved(&id);
        assert!(!saved.is_empty());
        assert_eq!(*second_bytes.lock().unwrap(), saved);
        rig.clean();
    }

    #[test]
    fn a_dead_output_does_not_stop_the_terminal() {
        let rig = Rig::new("dead-output");
        let id = rig.session(Some(rig.plain_tree()));
        let calls = Arc::new(Mutex::new(0));
        let counted = calls.clone();
        rig.run_with(
            &id,
            shell("echo hello", "echo hello"),
            Arc::new(move |_| {
                *counted.lock().unwrap() += 1;
                false
            }),
        )
        .unwrap();
        rig.wait_exits(1);
        assert_eq!(rig.agents.info(&id).unwrap().status, Status::Ended);
        assert!(String::from_utf8_lossy(&rig.saved(&id)).contains("hello"));
        assert_eq!(*calls.lock().unwrap(), 1, "a dead output is dropped after its first failure");
        rig.clean();
    }

    #[test]
    fn the_limit_is_enforced() {
        let rig = Rig::new("limit");
        let ids: Vec<String> = (0..=MAX_TERMINALS).map(|_| rig.session(Some(rig.plain_tree()))).collect();
        for id in &ids[..MAX_TERMINALS] {
            rig.run(id, lingering());
        }
        let (output, _) = collector();
        assert_eq!(rig.run_with(&ids[MAX_TERMINALS], lingering(), output.clone()).unwrap_err(), "Close a terminal first: 8 are already running");
        rig.terms.close(&ids[0]);
        rig.wait_exits(1);
        assert!(rig.run_with(&ids[MAX_TERMINALS], lingering(), output).is_ok());
        assert_eq!(rig.terms.list().len(), MAX_TERMINALS);
        let stopped = Instant::now();
        rig.terms.stop_all();
        assert!(stopped.elapsed() < Duration::from_secs(10));
        assert!(rig.terms.list().is_empty());
        assert_eq!(rig.exits.lock().unwrap().len(), MAX_TERMINALS + 1);
        rig.clean();
    }

    #[test]
    fn a_login_terminal_does_not_count() {
        let rig = Rig::new("login-limit");
        let ids: Vec<String> = (0..MAX_TERMINALS).map(|_| rig.session(Some(rig.plain_tree()))).collect();
        let (output, _) = collector();
        let login = |id: &str, output: Output| {
            rig.terms.spawn(Run {
                id: id.into(),
                session_id: None,
                engine: Engine::Claude,
                cli: lingering(),
                cwd: rig.dir.clone(),
                label: None,
                memory_root: None,
                cols: 200,
                rows: 24,
                scrollback: None,
                output,
                signal_dir: None, before: Vec::new(),
            })
        };
        login("login-claude", output.clone()).unwrap();
        for id in &ids {
            rig.run(id, lingering());
        }
        // A full house plus the sign-in terminal; another sign-in still starts, another session does not.
        assert_eq!(rig.terms.list().len(), MAX_TERMINALS + 1);
        login("login-codex", output).unwrap();
        let extra = rig.session(Some(rig.plain_tree()));
        let (output, _) = collector();
        assert!(rig.run_with(&extra, lingering(), output).is_err());
        rig.terms.stop_all();
        rig.clean();
    }

    fn start_shell(rig: &Rig, cli: Cli, cwd: PathBuf, output: Output) -> Result<TermInfo, String> {
        rig.terms.start_shell(cli, "PowerShell", cwd, 200, 24, output)
    }

    #[test]
    fn a_shell_tab_is_listed_with_its_label_and_folder_and_leaves_when_it_exits() {
        let rig = Rig::new("shell");
        let (output, bytes) = collector();
        let started = start_shell(&rig, shell("echo hi-from-shell & ping -n 4 127.0.0.1 >nul", "echo hi-from-shell; sleep 3"), rig.dir.clone(), output).unwrap();
        assert!(started.id.starts_with("shell-") && started.running && started.session_id.is_none());
        assert_eq!(started.label.as_deref(), Some("PowerShell"));
        assert_eq!(started.cwd, Some(rig.dir.display().to_string()));
        assert_eq!(rig.terms.list(), vec![started.clone()]);
        // A page reload: the same id re-attaches to the running tab, with the new output.
        let (second, second_bytes) = collector();
        let again = rig.terms.open(&started.id, 100, 30, None, true, second).unwrap();
        assert_eq!(again, started);
        let exits = rig.wait_exits(1);
        assert_eq!(exits, vec![TermExit { id: started.id.clone(), session_id: None, code: Some(0) }]);
        assert!(rig.terms.list().is_empty());
        assert!(text(&bytes).contains("hi-from-shell") || text(&second_bytes).contains("hi-from-shell"));
        assert_eq!(rig.terms.write(&started.id, b"x"), Err(NOT_RUNNING.to_string()));
        assert_eq!(rig.terms.open(&started.id, 80, 24, None, true, collector().0).unwrap_err(), NOT_RUNNING);
        assert!(!rig.dir.join("terminals").join(&started.id).exists());
        rig.clean();
    }

    #[test]
    fn a_shell_tab_has_no_session_variable_and_counts_toward_the_limit() {
        let rig = Rig::new("shell-env");
        let (output, bytes) = collector();
        let echo = shell("echo session=[%HIVEMIND_SESSION%]", "echo session=[$HIVEMIND_SESSION]");
        let first = start_shell(&rig, echo, rig.dir.clone(), output).unwrap();
        rig.wait_exits(1);
        let seen = text(&bytes);
        assert!(!seen.contains(&first.id), "{seen}");
        // An agent terminal does get it.
        let id = rig.session(Some(rig.plain_tree()));
        let (output, bytes) = collector();
        rig.run_with(&id, shell("echo session=[%HIVEMIND_SESSION%]", "echo session=[$HIVEMIND_SESSION]"), output).unwrap();
        rig.wait_exits(2);
        assert!(text(&bytes).contains(&format!("session=[{id}]")), "{}", text(&bytes));
        // Shells count toward the limit and close like the others.
        let mut shells = vec![];
        for _ in 0..MAX_TERMINALS {
            shells.push(start_shell(&rig, lingering(), rig.dir.clone(), collector().0).unwrap());
        }
        let error = start_shell(&rig, lingering(), rig.dir.clone(), collector().0).unwrap_err();
        assert_eq!(error, "Close a terminal first: 8 are already running");
        rig.terms.close(&shells[0].id);
        rig.wait_exits(3);
        assert_eq!(rig.terms.list().len(), MAX_TERMINALS - 1);
        rig.terms.stop_all();
        rig.clean();
    }

    #[test]
    fn a_shell_target_must_name_a_folder_that_exists() {
        let rig = Rig::new("shell-target");
        let picked = rig.dir.join("picked");
        std::fs::create_dir_all(&picked).unwrap();
        let gone = rig.dir.join("gone");
        let saved = settings::Settings { other_folders: Some(vec![picked.display().to_string(), gone.display().to_string()]), ..Default::default() };
        let cwd = |target: ShellTarget, repo: PathBuf| shell_cwd(&target, &rig.agents, &saved, |_, _| Ok(repo));
        let folder = |path: &Path| ShellTarget::Folder(path.display().to_string());
        assert_eq!(cwd(folder(&picked), PathBuf::new()), Ok(picked.clone()));
        assert_eq!(cwd(folder(&rig.dir), PathBuf::new()), Err("That folder was not chosen with the folder picker".to_string()));
        assert!(cwd(folder(&gone), PathBuf::new()).unwrap_err().starts_with("The folder no longer exists: "));
        let checkout = ShellTarget::Checkout { project: "p".into(), repo: "r".into() };
        assert_eq!(cwd(checkout.clone(), picked.clone()), Ok(picked.clone()));
        assert!(cwd(checkout.clone(), gone.clone()).unwrap_err().starts_with("The folder no longer exists: "));
        let unregistered = shell_cwd(&checkout, &rig.agents, &saved, |_, _| Err("That repository is not registered for this project".into()));
        assert_eq!(unregistered, Err("That repository is not registered for this project".to_string()));
        let tree = rig.plain_tree();
        let id = rig.session(Some(tree.clone()));
        assert_eq!(cwd(ShellTarget::Session(id), PathBuf::new()), Ok(PathBuf::from(tree.path)));
        assert_eq!(cwd(ShellTarget::Session(uuid::Uuid::new_v4().to_string()), PathBuf::new()), Err("Unknown session".to_string()));
        assert_eq!(cwd(ShellTarget::Session(rig.session(None)), PathBuf::new()), Err("This session has no worktree".to_string()));
        rig.clean();
    }

    #[test]
    fn a_shell_target_reads_its_tagged_form() {
        assert_eq!(serde_json::from_value::<ShellTarget>(json!({ "session": "a" })).unwrap(), ShellTarget::Session("a".into()));
        assert_eq!(serde_json::from_value::<ShellTarget>(json!({ "folder": "C:/x" })).unwrap(), ShellTarget::Folder("C:/x".into()));
        assert_eq!(
            serde_json::from_value::<ShellTarget>(json!({ "checkout": { "project": "p", "repo": "r" } })).unwrap(),
            ShellTarget::Checkout { project: "p".into(), repo: "r".into() }
        );
        assert!(serde_json::from_value::<ShellTarget>(json!({ "other": "x" })).is_err());
    }

    /// The running terminal's shared state, for tests that raise attention by hand.
    fn shared_of(rig: &Rig, id: &str) -> Arc<Shared> {
        rig.terms.inner.terms.lock().unwrap().get(id).unwrap().shared.clone()
    }

    fn wait_for(what: &str, mut done: impl FnMut() -> bool) {
        let start = Instant::now();
        while !done() {
            assert!(start.elapsed() < Duration::from_secs(20), "timed out: {what}");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    #[test]
    fn attention_is_set_once_per_kind_and_cleared_by_seen_or_typing() {
        let rig = Rig::new("attention");
        let id = rig.session(Some(rig.plain_tree()));
        rig.run(&id, lingering());
        let shared = shared_of(&rig, &id);
        let seen = |n: usize| {
            let all = rig.attention.lock().unwrap();
            assert_eq!(all.len(), n, "{all:?}");
        };
        assert_eq!(rig.terms.list()[0].attention, None);
        rig.terms.inner.raise_attention(&shared, Kind::Done);
        seen(1);
        assert_eq!(rig.attention.lock().unwrap()[0], (id.clone(), Some(Kind::Done), "Fix the bug".to_string()));
        assert_eq!(rig.terms.list()[0].attention, Some(Kind::Done));
        // The same kind again says nothing; another kind does.
        rig.terms.inner.raise_attention(&shared, Kind::Done);
        seen(1);
        rig.terms.inner.raise_attention(&shared, Kind::Waiting);
        seen(2);
        assert_eq!(rig.terms.list()[0].attention, Some(Kind::Waiting));
        rig.terms.seen(&id);
        seen(3);
        assert_eq!(rig.attention.lock().unwrap()[2].1, None);
        assert_eq!(rig.terms.list()[0].attention, None);
        // Clearing what is not set is silent; so is a second `seen`.
        rig.terms.seen(&id);
        seen(3);
        // Typing clears it, an automatic reply from the terminal does not.
        rig.terms.inner.raise_attention(&shared, Kind::Waiting);
        seen(4);
        rig.terms.write(&id, b"[I").unwrap();
        assert_eq!(rig.terms.list()[0].attention, Some(Kind::Waiting));
        rig.terms.write(&id, b"y").unwrap();
        seen(5);
        assert_eq!(rig.terms.list()[0].attention, None);
        // A named tab uses its name for the notification.
        rig.agents.amend(&id, |info| info.name = Some("Importer".into())).unwrap();
        rig.terms.inner.raise_attention(&shared, Kind::Done);
        assert_eq!(rig.attention.lock().unwrap()[5].2, "Importer");
        rig.terms.close(&id);
        rig.wait_exits(1);
        rig.clean();
    }

    #[test]
    fn a_claude_start_writes_its_hooks_and_follows_its_signals() {
        let rig = Rig::new("hooks");
        let id = rig.session(Some(rig.plain_tree()));
        let (output, _) = collector();
        let folder = rig.dir.join("terminals").join(&id);
        // Left over from an earlier run: removed at the start.
        write_file(&folder.join(signal::SIGNALS), "{\"kind\":\"done\"}
");
        rig.terms.open(&id, 80, 24, Some(StartMode::Fresh), false, output).unwrap();
        let settings: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(folder.join(signal::SETTINGS)).unwrap()).unwrap();
        assert_eq!(settings, signal::claude_settings(&std::env::current_exe().unwrap()));
        assert!(!folder.join(signal::SIGNALS).exists());
        assert!(rig.attention.lock().unwrap().is_empty());
        // A hook line becomes the terminal's attention within a second or so.
        write_file(&folder.join(signal::SIGNALS), "{\"kind\":\"waiting\",\"type\":\"permission_prompt\",\"at\":1}
");
        wait_for("the signal", || rig.terms.list().first().is_some_and(|t| t.attention == Some(Kind::Waiting)));
        assert_eq!(rig.attention.lock().unwrap().len(), 1);
        rig.terms.close(&id);
        rig.wait_exits(1);
        rig.clean();
    }

    #[test]
    fn a_codex_osc_9_sets_attention() {
        let rig = Rig::new("osc9");
        let id = rig.session(Some(rig.plain_tree()));
        let cwd = PathBuf::from(&rig.agents.info(&id).unwrap().worktree.as_ref().unwrap().path);
        rig.agents.amend(&id, |info| info.status = Status::Running).unwrap();
        // Windows: an interactive `cmd` whose prompt is the notification. Elsewhere: printf.
        let cli = if cfg!(windows) {
            Cli { program: "cmd.exe".into(), args: vec!["/d".into(), "/k".into(), "prompt $E]9;Approval requested$E\\".into()] }
        } else {
            Cli { program: "sh".into(), args: vec!["-c".into(), "printf '\\033]9;Approval requested\\007'; sleep 60".into()] }
        };
        let run = |engine, output| Run {
            id: id.clone(), session_id: Some(id.clone()), engine, cli: cli.clone(), cwd: cwd.clone(), label: None, memory_root: None,
            cols: 200, rows: 24, scrollback: None, output, signal_dir: None, before: Vec::new(),
        };
        rig.terms.spawn(run(Engine::Codex, collector().0)).unwrap();
        wait_for("the notification", || rig.terms.list().first().is_some_and(|t| t.attention == Some(Kind::Waiting)));
        rig.terms.close(&id);
        rig.wait_exits(1);
        // Claude's output is not scanned: the same program raises nothing.
        rig.attention.lock().unwrap().clear();
        rig.agents.amend(&id, |info| info.status = Status::Running).unwrap();
        rig.terms.spawn(run(Engine::Claude, collector().0)).unwrap();
        std::thread::sleep(Duration::from_millis(1500));
        assert!(rig.attention.lock().unwrap().is_empty());
        rig.terms.close(&id);
        rig.wait_exits(2);
        rig.clean();
    }

    #[test]
    fn stale_folders_are_removed_at_start() {
        let rig = Rig::new("stale");
        let kept = rig.session(None);
        let stale = uuid::Uuid::new_v4().to_string();
        let terminals = rig.dir.join("terminals");
        for id in [&kept, &stale] {
            write_briefing(&terminals, id, "Briefing").unwrap();
        }
        std::fs::create_dir_all(terminals.join("login-claude")).unwrap();
        Manager::new(terminals.clone(), rig.agents.clone(), rig.dir.join("settings.json"), rig_sink(&rig.exits, &rig.attention));
        assert!(terminals.join(&kept).is_dir());
        assert!(!terminals.join(&stale).exists());
        assert!(terminals.join("login-claude").is_dir());
        rig.clean();
    }

    #[test]
    fn stop_waits_for_the_program_to_leave() {
        let rig = Rig::new("stop");
        let id = rig.session(Some(rig.plain_tree()));
        assert_eq!(rig.terms.stop(&id, Duration::from_secs(1)), Ok(()));
        assert_eq!(rig.agents.info(&id).unwrap().status, Status::Idle);
        rig.run(&id, lingering());
        assert_eq!(rig.terms.stop(&id, Duration::from_secs(10)), Ok(()));
        assert!(rig.terms.list().is_empty());
        let info = rig.agents.info(&id).unwrap();
        assert_eq!((info.status, info.error), (Status::Ended, None));
        rig.clean();
    }

    #[test]
    fn stop_gives_up_when_the_program_stays() {
        let rig = Rig::new("stop-late");
        let id = rig.session(Some(rig.plain_tree()));
        rig.run(&id, lingering());
        // The close needs a moment (the program is asked first); no time at all is never enough.
        assert_eq!(rig.terms.stop(&id, Duration::ZERO), Err("The program did not stop within 0 seconds.".to_string()));
        rig.wait_exits(1);
        assert_eq!(rig.agents.info(&id).unwrap().status, Status::Ended);
        rig.clean();
    }

    #[test]
    fn feedback_files_are_numbered_and_hold_the_comments_only() {
        let dir = std::env::temp_dir().join(format!("hivemind-feedback-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        let id = uuid::Uuid::new_v4().to_string();
        let first = write_feedback(&dir, &id, "Rename `a` to `b`.

- src/x.rs: add a test").unwrap();
        let context = dir.join(&id).join("context");
        assert_eq!(first, context.join("review-1.md"));
        assert_eq!(std::fs::read_to_string(&first).unwrap(), "Rename `a` to `b`.

- src/x.rs: add a test");
        std::fs::write(context.join("briefing.md"), "Briefing").unwrap();
        std::fs::write(context.join("review-4.md"), "old").unwrap();
        let next = write_feedback(&dir, &id, "More").unwrap();
        assert_eq!(next, context.join("review-5.md"));
        assert!(!std::fs::read_to_string(context.join("review-1.md")).unwrap().contains("Briefing"));
        assert_eq!(write_feedback(&dir, "../x", "no").unwrap_err(), "Invalid session id");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_resume_with_feedback_ends_with_the_pointer_prompt() {
        let rig = Rig::new("resume-args");
        let id = rig.session(Some(rig.plain_tree()));
        let file = Path::new("C:/data/terminals/x/context/review-2.md");
        let pointer = format!("Read the file {}. It holds review feedback on your changes.", file.display());
        let context = Path::new("C:/data/terminals/x/context");
        let claude = SessionInfo { id: id.clone(), ..Rig::info(&id, None) };
        let args = start_args(&claude, StartMode::Resume, Some(Path::new("C:/data/signals.json")), context, None, Some(file));
        assert_eq!(args.last(), Some(&pointer));
        assert_eq!(&args[..2], ["--settings", "C:/data/signals.json"]);
        let at = args.iter().position(|a| a == "--resume").unwrap();
        assert_eq!(args[at + 1], id);
        // An imported conversation resumes by its own id.
        let args = start_args(&claude, StartMode::Resume, None, context, Some("conv-1"), Some(file));
        assert_eq!(args[args.iter().position(|a| a == "--resume").unwrap() + 1], "conv-1");
        assert_eq!(args.last(), Some(&pointer));
        // Without feedback nothing is added.
        assert_ne!(start_args(&claude, StartMode::Resume, None, context, None, None).last(), Some(&pointer));

        let codex = SessionInfo { adapter: "codex".into(), ..claude.clone() };
        let args = start_args(&codex, StartMode::Resume, None, context, Some("thread-9"), Some(file));
        let at = args.iter().position(|a| a == "resume").unwrap();
        assert_eq!(args[at + 1], "thread-9");
        assert_eq!(args.last(), Some(&pointer));
        let args = start_args(&codex, StartMode::Resume, None, context, None, Some(file));
        assert_eq!(args[args.iter().position(|a| a == "resume").unwrap() + 1], "--last");
        assert_eq!(args.last(), Some(&pointer));
        assert!(args.contains(&"--no-alt-screen".to_string()));
        rig.clean();
    }

    #[test]
    fn resume_with_starts_the_program_unattached_under_the_reservation() {
        let rig = Rig::new("resume-with");
        let id = rig.session(Some(rig.plain_tree()));
        let other = rig.session(Some(rig.plain_tree()));
        let file = rig.terms.feedback_file(&id, "Fix it").unwrap();
        // Another session's reservation is no reason to start this one; nor is none.
        let wrong = rig.agents.reserve(&other).unwrap();
        assert_eq!(rig.terms.resume_with(&id, &file, &wrong).unwrap_err(), "The reservation is for another session");
        drop(wrong);
        assert!(rig.terms.list().is_empty());

        let held = rig.agents.reserve(&id).unwrap();
        // `open` still refuses to start it while the reservation is held; `resume_with` is the holder's way in.
        let (output, _) = collector();
        assert_eq!(rig.terms.open(&id, 80, 24, Some(StartMode::Resume), false, output.clone()).unwrap_err(), RESERVED);
        let started = rig.terms.resume_with(&id, &file, &held).unwrap();
        assert!(started.running);
        assert_eq!(rig.agents.info(&id).unwrap().status, Status::Running);
        assert_eq!(rig.terms.resume_with(&id, &file, &held).unwrap_err(), "This terminal is still running");
        // Its output is saved although nothing is attached; the view attaches later and replays it.
        wait_for("output saved", || !rig.saved(&id).is_empty());
        drop(held);
        let view = rig.terms.open(&id, 80, 24, None, true, output).unwrap();
        assert!(view.running || rig.agents.info(&id).unwrap().status != Status::Running);
        rig.terms.close(&id);
        rig.wait_exits(1);
        rig.clean();
    }
}
