mod agent;
mod architecture;
mod bridge;
mod capture;
mod drafts;
mod git;
mod review;
mod settings;
mod term;
mod watcher;
mod worktree;

use bridge::{Bridge, Reply};
use serde::Serialize;
use serde_json::Value;
use settings::Settings;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Manager, State};

struct AppState {
    bridge: Arc<Bridge>,
    settings_path: PathBuf,
    drafts_dir: PathBuf,
    worktrees_dir: PathBuf,
    terminals_dir: PathBuf,
    snapshots_dir: PathBuf,
    agents: agent::Manager,
    terminals: term::Manager,
    watcher: Mutex<Option<notify_debouncer_mini::Debouncer<notify_debouncer_mini::notify::RecommendedWatcher>>>,
    /// Why the quick-capture hotkey could not be registered, for the settings screen.
    shortcut_error: Mutex<Option<String>>,
}

#[derive(Serialize)]
struct CaptureStatus {
    shortcut: Option<String>,
    error: Option<String>,
    close_to_tray: bool,
}

#[derive(Serialize)]
struct ConnectInfo {
    version: Value,
    root: String,
    program: String,
    script: String,
    /// The signed-in OS user, for the sidebar footer.
    user: Option<String>,
}

#[derive(Serialize, Clone)]
struct NotesChanged {
    domains: Vec<String>,
}

#[derive(Serialize, Clone)]
struct StoreChanged {
    files: Vec<String>,
}

async fn blocking<T: Send + 'static>(work: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work).await.map_err(|e| e.to_string())?
}

/// Run one Living Memory command (argv starts with the command) and return its reply.
#[tauri::command]
async fn lm(state: State<'_, AppState>, argv: Vec<String>, stdin: Option<String>) -> Result<Reply, String> {
    let bridge = state.bridge.clone();
    blocking(move || bridge.call(&argv, stdin.as_deref())).await
}

/// Start (or restart) the bridge, report what it connected to, and watch the store for changes.
#[tauri::command]
async fn connect(app: AppHandle, state: State<'_, AppState>) -> Result<ConnectInfo, String> {
    let bridge = state.bridge.clone();
    let (version, doctor) = blocking(move || {
        let version = bridge.call(&["version".into()], None)?;
        let doctor = bridge.call(&["doctor".into(), "--actor".into(), "viewer".into()], None)?;
        Ok((version, doctor))
    })
    .await?;
    let root = doctor.result.get("root").and_then(Value::as_str).ok_or("Living Memory did not report its store root")?.to_string();
    let (notes, store) = (app.clone(), app.clone());
    let debouncer = watcher::watch_all(
        &PathBuf::from(&root),
        move |domains| {
            let _ = notes.emit("notes-changed", NotesChanged { domains });
        },
        move |files| {
            let _ = store.emit("store-changed", StoreChanged { files });
        },
    )?;
    *state.watcher.lock().unwrap() = Some(debouncer);
    let launch = state.bridge.launch();
    let user = std::env::var("USERNAME").or_else(|_| std::env::var("USER")).ok().filter(|name| !name.is_empty());
    Ok(ConnectInfo { version: version.result, root, program: launch.program, script: launch.script.display().to_string(), user })
}

/// Recent commits and pull requests for a project's repos (paths are looked up in Living Memory).
#[tauri::command]
async fn git_activity(state: State<'_, AppState>, slug: String) -> Result<Vec<git::RepoActivity>, String> {
    let bridge = state.bridge.clone();
    blocking(move || git::git_activity(&bridge, &slug)).await
}

/// What a system's Architecture Suite output folder holds (the folder is looked up in Living Memory).
#[tauri::command]
async fn system_architecture(state: State<'_, AppState>, slug: String) -> Result<architecture::Architecture, String> {
    let bridge = state.bridge.clone();
    blocking(move || architecture::for_system(&bridge, &slug)).await
}

/// One diagram from that folder as a data URL; only files the suite's manifest lists are served.
#[tauri::command]
async fn system_diagram(state: State<'_, AppState>, slug: String, path: String) -> Result<String, String> {
    let bridge = state.bridge.clone();
    blocking(move || architecture::diagram_for_system(&bridge, &slug, &path)).await
}

/// The Mermaid source of a diagram in that folder, as text; only `.mmd` files the manifest lists are served.
#[tauri::command]
async fn system_diagram_source(state: State<'_, AppState>, slug: String, path: String) -> Result<String, String> {
    let bridge = state.bridge.clone();
    blocking(move || architecture::source_for_system(&bridge, &slug, &path)).await
}

/// How many commits a system's repository is ahead of its architecture output.
#[tauri::command]
async fn system_staleness(state: State<'_, AppState>, slug: String) -> Result<architecture::Staleness, String> {
    let (bridge, agents) = (state.bridge.clone(), state.agents.clone());
    blocking(move || architecture::staleness(&bridge, &agents.sessions(), &slug)).await
}

/// The stored copies of a system's architecture model, newest first.
#[tauri::command]
async fn system_snapshots(state: State<'_, AppState>, slug: String) -> Result<Vec<architecture::SnapshotInfo>, String> {
    let root = state.snapshots_dir.clone();
    blocking(move || architecture::list_snapshots(&root, &slug)).await
}

/// One stored copy of a system's architecture model; the id must be one the listing gave.
#[tauri::command]
async fn system_snapshot(state: State<'_, AppState>, slug: String, id: String) -> Result<architecture::Snapshot, String> {
    let root = state.snapshots_dir.clone();
    blocking(move || architecture::read_snapshot(&root, &slug, &id)).await
}

/// The coding-agent CLI a session would launch, or why there is none.
#[tauri::command]
async fn agent_available(state: State<'_, AppState>) -> Result<String, String> {
    let path = state.settings_path.clone();
    blocking(move || agent::claude::available(&settings::load(&path))).await
}

/// What the Start screen needs to know about one engine.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct EngineInfo {
    engine: agent::Engine,
    label: String,
    path: Option<String>,
    error: Option<String>,
    chat: bool,
    chat_reason: Option<String>,
}

/// Turn the result of looking for an engine's program into what the webview shows.
fn engine_info(engine: agent::Engine, found: Result<term::launch::Cli, String>) -> EngineInfo {
    let chat = engine == agent::Engine::Claude || agent::CODEX_CHAT;
    let (path, error) = match found {
        Ok(cli) => (Some(cli.args.into_iter().next().unwrap_or(cli.program)), None),
        Err(e) => (None, Some(e)),
    };
    EngineInfo {
        engine,
        label: engine.label().to_string(),
        path,
        error,
        chat,
        chat_reason: (!chat).then(|| "Chat with Codex is not available yet. Use Terminal.".to_string()),
    }
}

/// Which engines can be started, and with which interface: Claude Code first, then Codex.
#[tauri::command]
async fn agent_engines(state: State<'_, AppState>) -> Result<Vec<EngineInfo>, String> {
    let path = state.settings_path.clone();
    blocking(move || {
        let saved = settings::load(&path);
        Ok([agent::Engine::Claude, agent::Engine::Codex].into_iter().map(|e| engine_info(e, term::launch::program(e, &saved))).collect())
    })
    .await
}

/// Start an agent session for a task; what it may touch is worked out here, not by the webview.
#[tauri::command]
async fn agent_start(
    state: State<'_, AppState>,
    task: agent::scope::AgentTask,
    prompt: String,
    options: Option<agent::StartOptions>,
) -> Result<agent::SessionInfo, String> {
    let (agents, bridge, path) = (state.agents.clone(), state.bridge.clone(), state.settings_path.clone());
    let (worktrees, terminals) = (state.worktrees_dir.clone(), state.terminals_dir.clone());
    blocking(move || agent::start_task(&agents, &bridge, &settings::load(&path), &worktrees, &terminals, task, &prompt, options.unwrap_or_default())).await
}

/// Send a message to an idle interactive session.
#[tauri::command]
async fn agent_send(state: State<'_, AppState>, session_id: String, text: String, options: Option<agent::SendOptions>) -> Result<(), String> {
    let (agents, bridge, path) = (state.agents.clone(), state.bridge.clone(), state.settings_path.clone());
    blocking(move || agent::send_task(&agents, &bridge, &settings::load(&path), &session_id, &text, options.unwrap_or_default(), None)).await
}

/// Answer a permission request a session is waiting on.
#[tauri::command]
async fn agent_answer(state: State<'_, AppState>, session_id: String, request_id: String, decision: agent::events::Decision) -> Result<(), String> {
    let agents = state.agents.clone();
    blocking(move || agents.answer(&session_id, &request_id, decision)).await
}

/// Stop the turn a session is working on.
#[tauri::command]
async fn agent_interrupt(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    let agents = state.agents.clone();
    blocking(move || agents.interrupt(&session_id)).await
}

/// End an interactive session.
#[tauri::command]
async fn agent_end(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    let agents = state.agents.clone();
    blocking(move || agents.end(&session_id)).await
}

/// The files changed in a session's worktree, with their patches.
#[tauri::command]
async fn agent_files(state: State<'_, AppState>, session_id: String) -> Result<worktree::ChangedFiles, String> {
    let agents = state.agents.clone();
    blocking(move || agents.files(&session_id)).await
}

/// Change the permission mode of an interactive session.
#[tauri::command]
async fn agent_set_policy(state: State<'_, AppState>, session_id: String, policy: agent::scope::PolicyMode) -> Result<(), String> {
    let agents = state.agents.clone();
    blocking(move || agents.set_policy(&session_id, policy)).await
}

/// Give a session a name (trimmed, at most 80 characters; empty clears it).
#[tauri::command]
async fn agent_rename(state: State<'_, AppState>, session_id: String, name: String) -> Result<(), String> {
    let agents = state.agents.clone();
    blocking(move || agents.amend(&session_id, |info| info.name = agent::clean_name(&name)).map(|_| ())).await
}

/// Remove the worktree of a session that has ended.
#[tauri::command]
async fn agent_remove_worktree(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    let agents = state.agents.clone();
    blocking(move || agents.remove_worktree(&session_id)).await
}

/// The files a work session changed in its worktree since its review base.
#[tauri::command]
async fn review_files(state: State<'_, AppState>, session_id: String) -> Result<Vec<worktree::FileChange>, String> {
    let (agents, root) = (state.agents.clone(), state.worktrees_dir.clone());
    blocking(move || review::files(&agents, &root, &session_id)).await
}

/// The two versions of one file a work session changed.
#[tauri::command]
async fn review_file(state: State<'_, AppState>, session_id: String, path: String) -> Result<review::FileContents, String> {
    let (agents, root) = (state.agents.clone(), state.worktrees_dir.clone());
    blocking(move || review::file(&agents, &root, &session_id, &path)).await
}

/// Commit the session's edits on its own branch. Never merges, never pushes.
#[tauri::command]
async fn review_approve(state: State<'_, AppState>, session_id: String, message: String) -> Result<String, String> {
    let (agents, root) = (state.agents.clone(), state.worktrees_dir.clone());
    blocking(move || review::approve(&agents, &root, &session_id, &message)).await
}

/// Send the session a message asking for changes.
#[tauri::command]
async fn review_request_changes(state: State<'_, AppState>, session_id: String, text: String) -> Result<(), String> {
    let (agents, bridge, path) = (state.agents.clone(), state.bridge.clone(), state.settings_path.clone());
    blocking(move || review::request_changes(&agents, &bridge, &settings::load(&path), &session_id, &text)).await
}

/// Take a session's edits out of the review queue and leave them where they are.
#[tauri::command]
async fn review_dismiss(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    let agents = state.agents.clone();
    blocking(move || review::dismiss(&agents, &session_id)).await
}

/// Throw the session's edits away: reset its worktree to its review base and remove untracked files.
#[tauri::command]
async fn review_discard(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    let (agents, root) = (state.agents.clone(), state.worktrees_dir.clone());
    blocking(move || review::discard(&agents, &root, &session_id)).await
}

/// The full text of one tool result of a session, read back from its raw log.
#[tauri::command]
async fn review_tool_output(state: State<'_, AppState>, session_id: String, tool_use_id: String) -> Result<agent::ToolOutput, String> {
    let agents = state.agents.clone();
    blocking(move || agents.tool_output(&session_id, &tool_use_id)).await
}

/// Look at every session's worktree again, so edits made outside a turn are noticed.
#[tauri::command]
async fn review_refresh(state: State<'_, AppState>) -> Result<usize, String> {
    let (agents, root) = (state.agents.clone(), state.worktrees_dir.clone());
    blocking(move || Ok(review::refresh(&agents, &root))).await
}

/// The local branches of one of a project's repositories (the repository must be registered for the project).
#[tauri::command]
async fn repo_branches(state: State<'_, AppState>, project: String, repo: String) -> Result<git::Branches, String> {
    let bridge = state.bridge.clone();
    blocking(move || {
        let entry = git::project_entry(&bridge, &project)?;
        git::branches(&agent::scope::project_repo(&entry, &repo)?)
    })
    .await
}

#[tauri::command]
async fn agent_cancel(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    let agents = state.agents.clone();
    blocking(move || agents.cancel(&session_id)).await
}

/// Every agent session, newest first.
#[tauri::command]
fn agent_sessions(state: State<'_, AppState>) -> Result<Vec<agent::SessionInfo>, String> {
    Ok(state.agents.sessions())
}

/// One session and its events from `from_seq` on, rebuilt from its stored log.
#[tauri::command]
async fn agent_session(state: State<'_, AppState>, session_id: String, from_seq: u64) -> Result<agent::SessionLog, String> {
    let agents = state.agents.clone();
    blocking(move || agents.session(&session_id, from_seq)).await
}

fn raw(output: Channel<InvokeResponseBody>) -> term::Output {
    Arc::new(move |bytes| output.send(InvokeResponseBody::Raw(bytes)).is_ok())
}

/// Attach to a session's terminal, show its saved history, and start its program when asked.
#[tauri::command]
async fn term_open(
    state: State<'_, AppState>,
    session_id: String,
    cols: u16,
    rows: u16,
    start: Option<term::StartMode>,
    replay: bool,
    output: Channel<InvokeResponseBody>,
) -> Result<term::TermInfo, String> {
    let terminals = state.terminals.clone();
    blocking(move || terminals.open(&session_id, cols, rows, start, replay, raw(output))).await
}

/// Open the CLI's own sign-in in a terminal of its own.
#[tauri::command]
async fn term_login(state: State<'_, AppState>, engine: agent::Engine, cols: u16, rows: u16, output: Channel<InvokeResponseBody>) -> Result<term::TermInfo, String> {
    let terminals = state.terminals.clone();
    blocking(move || terminals.login(engine, cols, rows, raw(output))).await
}

#[tauri::command]
async fn term_write(state: State<'_, AppState>, id: String, data: String) -> Result<(), String> {
    let terminals = state.terminals.clone();
    blocking(move || terminals.write(&id, data.as_bytes())).await
}

#[tauri::command]
async fn term_resize(state: State<'_, AppState>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    let terminals = state.terminals.clone();
    blocking(move || terminals.resize(&id, cols, rows)).await
}

/// Close a terminal; this can wait up to 3 seconds for the program to leave.
#[tauri::command]
async fn term_close(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let terminals = state.terminals.clone();
    blocking(move || {
        terminals.close(&id);
        Ok(())
    })
    .await
}

/// The terminals with a running program.
#[tauri::command]
fn term_list(state: State<'_, AppState>) -> Vec<term::TermInfo> {
    state.terminals.list()
}

#[tauri::command]
fn get_settings(state: State<'_, AppState>) -> Settings {
    settings::load(&state.settings_path)
}

#[tauri::command]
fn save_settings(app: AppHandle, state: State<'_, AppState>, value: Settings) -> Result<(), String> {
    let previous = settings::load(&state.settings_path);
    settings::save(&state.settings_path, &value)?;
    *state.shortcut_error.lock().unwrap() = capture::apply_shortcut(&app, value.capture_shortcut().as_deref()).err();
    // Only a change of interpreter, script or store needs a new Living Memory process.
    if (&previous.python, &previous.script, &previous.root) != (&value.python, &value.script, &value.root) {
        *state.watcher.lock().unwrap() = None;
        state.bridge.reconfigure(settings::resolve(&value, |k| std::env::var(k).ok()));
    }
    Ok(())
}

#[tauri::command]
fn capture_status(state: State<'_, AppState>) -> CaptureStatus {
    let saved = settings::load(&state.settings_path);
    CaptureStatus {
        shortcut: saved.capture_shortcut(),
        error: state.shortcut_error.lock().unwrap().clone(),
        close_to_tray: saved.close_to_tray.unwrap_or(true),
    }
}

#[tauri::command]
fn show_main(app: AppHandle) {
    capture::show_main(&app);
}

/// Exit the app; `RunEvent::Exit` stops the programs it started.
#[tauri::command]
fn app_quit(app: AppHandle) {
    app.exit(0);
}

/// The page answered a tray Quit and asks the user itself, so a second tray Quit does not exit without asking.
#[tauri::command]
fn quit_ack() {
    capture::quit_ack();
}

#[tauri::command]
fn draft_put(state: State<'_, AppState>, key: String, value: Value) -> Result<(), String> {
    drafts::put(&state.drafts_dir, &key, &value)
}

#[tauri::command]
fn draft_get(state: State<'_, AppState>, key: String) -> Result<Option<Value>, String> {
    drafts::get(&state.drafts_dir, &key)
}

#[tauri::command]
fn draft_delete(state: State<'_, AppState>, key: String) -> Result<(), String> {
    drafts::delete(&state.drafts_dir, &key)
}

#[tauri::command]
fn draft_list(state: State<'_, AppState>) -> Vec<Value> {
    drafts::list(&state.drafts_dir)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        let _ = capture::show_capture(app);
                    }
                })
                .build(),
        )
        .setup(|app| {
            let settings_path = app.path().app_config_dir()?.join("settings.json");
            let drafts_dir = app.path().app_data_dir()?.join("drafts");
            let sessions_dir = app.path().app_data_dir()?.join("agent-sessions");
            let worktrees_dir = app.path().app_data_dir()?.join("worktrees");
            let terminals_dir = app.path().app_data_dir()?.join("terminals");
            let snapshots_dir = architecture::snapshots_root(&sessions_dir);
            let saved = settings::load(&settings_path);
            let launch = settings::resolve(&saved, |k| std::env::var(k).ok());
            // A taken or invalid hotkey must not stop the app; the settings screen shows why.
            let shortcut_error = capture::apply_shortcut(app.handle(), saved.capture_shortcut().as_deref()).err();
            if let Err(e) = capture::tray(app.handle()) {
                eprintln!("Hivemind: no tray icon ({e})");
            }
            let events = app.handle().clone();
            let exits = app.handle().clone();
            let agents = agent::Manager::new(
                sessions_dir,
                Arc::new(agent::claude::ClaudeCode),
                Arc::new(move |emit| {
                    let _ = match emit {
                        agent::Emit::Event(event) => events.emit("agent-event", event),
                        agent::Emit::SessionsChanged => events.emit("agent-sessions-changed", ()),
                    };
                }),
            );
            let terminals = term::Manager::new(
                terminals_dir.clone(),
                agents.clone(),
                settings_path.clone(),
                Arc::new(move |emit| {
                    let term::Emit::Exit(exit) = emit;
                    let _ = exits.emit("term-exit", exit);
                }),
            );
            app.manage(AppState {
                bridge: Arc::new(Bridge::new(launch)),
                settings_path,
                drafts_dir,
                worktrees_dir,
                terminals_dir,
                snapshots_dir,
                agents,
                terminals,
                watcher: Mutex::new(None),
                shortcut_error: Mutex::new(shortcut_error),
            });
            Ok(())
        })
        // The hidden capture window must not keep the app alive once the main window is really closed.
        .on_window_event(|window, event| {
            if window.label() == "main" && matches!(event, tauri::WindowEvent::Destroyed) {
                window.app_handle().exit(0);
            }
        })
        .invoke_handler(tauri::generate_handler![
            lm, connect, git_activity, system_architecture, system_diagram, system_diagram_source, get_settings, save_settings, capture_status, show_main, app_quit, quit_ack, draft_put, draft_get, draft_delete, draft_list,
            agent_available, agent_start, agent_send, agent_answer, agent_interrupt, agent_end, agent_files, agent_set_policy, agent_rename, agent_remove_worktree, repo_branches,
            agent_cancel, agent_sessions, agent_session, review_files, review_file, review_approve, review_request_changes, review_dismiss, review_discard, review_tool_output, review_refresh,
            system_staleness, system_snapshots, system_snapshot, term_open, term_login, term_write, term_resize, term_close, term_list, agent_engines
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            // An agent session or a terminal must not outlive the app that started it.
            if let tauri::RunEvent::Exit = event
                && let Some(state) = app.try_state::<AppState>()
            {
                state.agents.stop_all();
                state.terminals.stop_all();
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use term::launch::{Cli, NO_CODEX};

    #[test]
    fn engines_report_what_was_found() {
        let claude = engine_info(agent::Engine::Claude, Ok(Cli { program: "C:/x/claude.exe".into(), args: vec![] }));
        assert_eq!(claude.path.as_deref(), Some("C:/x/claude.exe"));
        assert_eq!(claude.error, None);
        assert!(claude.chat);
        assert_eq!(claude.chat_reason, None);

        let codex = engine_info(agent::Engine::Codex, Ok(Cli { program: "node".into(), args: vec!["C:/n/codex.js".into()] }));
        assert_eq!(codex.path.as_deref(), Some("C:/n/codex.js"));
        assert_eq!(codex.chat, agent::CODEX_CHAT);
        assert_eq!(codex.chat_reason.is_some(), !codex.chat);

        let missing = engine_info(agent::Engine::Codex, Err(NO_CODEX.to_string()));
        assert_eq!(missing.path, None);
        assert_eq!(missing.error.as_deref(), Some(NO_CODEX));
    }
}
