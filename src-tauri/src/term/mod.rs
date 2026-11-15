pub mod launch;
pub mod pty;
pub mod scrollback;

use crate::agent::events::Status;
use crate::agent::scope::{self, PolicyMode};
use crate::agent::{self, Engine, Interface};
use crate::settings;
use crate::worktree;
use launch::Cli;
use pty::{Spawn, TermEvent};
use scrollback::Scrollback;
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

struct Shared {
    id: String,
    session_id: Option<String>,
    engine: Engine,
    out: Mutex<Out>,
    close_requested: AtomicBool,
    /// A files-changed refresh is already under way.
    refreshing: AtomicBool,
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
}

/// Everything `spawn` needs to start one program.
struct Run {
    id: String,
    session_id: Option<String>,
    engine: Engine,
    cli: Cli,
    cwd: PathBuf,
    memory_root: Option<PathBuf>,
    cols: u16,
    rows: u16,
    scrollback: Option<Scrollback>,
    output: Output,
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
    }
}

impl Manager {
    /// `dir` is `<app data>/terminals`. Removes the folders of sessions that are no longer in the history.
    pub fn new(dir: PathBuf, agents: agent::Manager, settings_path: PathBuf, sink: Sink) -> Manager {
        let known: HashSet<String> = agents.sessions().into_iter().map(|info| info.id).collect();
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if session_dir(&dir, &name).is_ok() && !known.contains(&name) && entry.path().is_dir() {
                    let _ = std::fs::remove_dir_all(entry.path());
                }
            }
        }
        Manager { inner: Arc::new(Inner { dir, agents, settings_path, sink, terms: Mutex::new(HashMap::new()) }) }
    }

    /// `term_open` (section 4.3 of the Phase 5 plan).
    pub fn open(&self, session_id: &str, cols: u16, rows: u16, start: Option<StartMode>, replay: bool, output: Output) -> Result<TermInfo, String> {
        let inner = &self.inner;
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
        };
        let Some((mode, found)) = start else {
            drop(terms);
            if replay {
                send_saved(&scrollback_path, &output);
            }
            return Ok(view);
        };
        let tree = info.worktree.as_ref().ok_or("This session has no worktree")?;
        let cwd = PathBuf::from(&tree.path);
        if !cwd.is_dir() {
            return Err(format!("The session's worktree folder is missing: {}", tree.path));
        }
        let mut cli = found?;
        let context = session_dir(&inner.dir, session_id)?.join("context");
        cli.args.extend(launch::session_args(
            engine,
            mode,
            info.policy == PolicyMode::AcceptEdits,
            info.model.as_deref(),
            &scope::governed_rules(),
            info.name.as_deref(),
            session_id,
            &context,
        ));
        if replay {
            send_saved(&scrollback_path, &output);
        }
        // Running is set before the spawn, and put back if the spawn fails, so an early exit is never overwritten. The
        // reservation is checked again in the same step: the check above and this change take the session lock separately,
        // and once the session is running Phase 4 cannot reserve it.
        let before = (info.status, info.ended_at, info.error.clone());
        inner.agents.amend_unreserved(session_id, RESERVED, |info| {
            info.status = Status::Running;
            info.ended_at = None;
            info.error = None;
        })?;
        let run = Run {
            id: session_id.to_string(),
            session_id: Some(session_id.to_string()),
            engine,
            cli,
            cwd,
            memory_root: settings::resolve(&saved, |k| std::env::var(k).ok()).root,
            cols,
            rows,
            scrollback: Scrollback::open(scrollback_path, scrollback::KEEP).ok(),
            output,
        };
        match self.spawn_in(&mut terms, run) {
            Ok(started) => Ok(started),
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
            memory_root: settings::resolve(&saved, |k| std::env::var(k).ok()).root,
            cols,
            rows,
            scrollback: None,
            output,
        };
        self.spawn_in(&mut terms, run)
    }

    pub fn write(&self, id: &str, data: &[u8]) -> Result<(), String> {
        let entry = self.inner.terms.lock().unwrap().get(id).cloned().ok_or(NOT_RUNNING)?;
        entry.pty.write(data).map_err(|_| NOT_RUNNING.to_string())
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
        let (env, env_remove) = launch::environment(&own, run.memory_root.as_deref(), &run.id);
        let shared = Arc::new(Shared {
            id: run.id,
            session_id: run.session_id,
            engine: run.engine,
            out: Mutex::new(Out { output: Some(run.output), scrollback: run.scrollback }),
            close_requested: AtomicBool::new(false),
            refreshing: AtomicBool::new(false),
        });
        let (inner, handler) = (self.inner.clone(), shared.clone());
        let sink: pty::Sink = Arc::new(move |event| match event {
            TermEvent::Data(bytes) => {
                let mut out = handler.out.lock().unwrap();
                if let Some(scrollback) = out.scrollback.as_mut() {
                    scrollback.append(&bytes);
                }
                if let Some(output) = &out.output
                    && !output(bytes)
                {
                    out.output = None;
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
        terms.insert(shared.id.clone(), Arc::new(Entry { shared, pty }));
        Ok(started)
    }
}

impl Inner {
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

    /// No output for a while: look at what the program changed, on a thread of its own because it runs git.
    fn quiet(self: &Arc<Self>, shared: &Arc<Shared>) {
        let Some(session_id) = shared.session_id.clone() else { return };
        if shared.refreshing.swap(true, Ordering::SeqCst) {
            return;
        }
        let (inner, shared) = (self.clone(), shared.clone());
        std::thread::spawn(move || {
            inner.refresh_files(&session_id);
            shared.refreshing.store(false, Ordering::SeqCst);
        });
    }

    /// Store the worktree's current totals when they differ from the stored ones. Errors leave the stored value.
    fn refresh_files(&self, session_id: &str) {
        let Ok(info) = self.agents.info(session_id) else { return };
        let Some(tree) = info.worktree.as_ref() else { return };
        let Ok(files) = worktree::changes(tree) else { return };
        let new = worktree::totals(&files);
        if new == info.files_changed.unwrap_or_default() {
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
            self.refresh_files(session_id);
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
    use crate::agent::scope::AgentTask;
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
                Arc::new(move |emit| {
                    if matches!(emit, agent::Emit::SessionsChanged) {
                        *counted.lock().unwrap() += 1;
                    }
                }),
            );
            let exits: Arc<Mutex<Vec<TermExit>>> = Arc::default();
            let terms = Manager::new(dir.join("terminals"), agents.clone(), settings_path, rig_sink(&exits));
            Rig { dir, agents, terms, exits, changed }
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
                memory_root: None,
                cols: 200,
                rows: 24,
                scrollback: Scrollback::open(self.terms.inner.scrollback_path(session).unwrap(), scrollback::KEEP).ok(),
                output,
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

    fn rig_sink(exits: &Arc<Mutex<Vec<TermExit>>>) -> Sink {
        let exits = exits.clone();
        Arc::new(move |emit| {
            let Emit::Exit(exit) = emit;
            exits.lock().unwrap().push(exit);
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
                .spawn(Run { id: session.into(), session_id: Some(session.into()), engine: Engine::Claude, cli: echo.clone(), cwd, memory_root, cols: 300, rows: 24, scrollback: None, output })
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
                memory_root: None,
                cols: 200,
                rows: 24,
                scrollback: None,
                output,
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
        Manager::new(terminals.clone(), rig.agents.clone(), rig.dir.join("settings.json"), rig_sink(&rig.exits));
        assert!(terminals.join(&kept).is_dir());
        assert!(!terminals.join(&stale).exists());
        assert!(terminals.join("login-claude").is_dir());
        rig.clean();
    }
}
