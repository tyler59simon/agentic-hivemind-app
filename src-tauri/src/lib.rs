mod agent;
mod architecture;
mod bridge;
mod capture;
mod drafts;
mod git;
mod settings;
mod watcher;

use bridge::{Bridge, Reply};
use serde::Serialize;
use serde_json::Value;
use settings::Settings;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

struct AppState {
    bridge: Arc<Bridge>,
    settings_path: PathBuf,
    drafts_dir: PathBuf,
    agents: agent::Manager,
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
    Ok(ConnectInfo { version: version.result, root, program: launch.program, script: launch.script.display().to_string() })
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

/// The coding-agent CLI a session would launch, or why there is none.
#[tauri::command]
async fn agent_available(state: State<'_, AppState>) -> Result<String, String> {
    let path = state.settings_path.clone();
    blocking(move || agent::claude::available(&settings::load(&path))).await
}

/// Start an agent session for a task; what it may touch is worked out here, not by the webview.
#[tauri::command]
async fn agent_start(state: State<'_, AppState>, task: agent::scope::AgentTask, prompt: String) -> Result<agent::SessionInfo, String> {
    let (agents, bridge, path) = (state.agents.clone(), state.bridge.clone(), state.settings_path.clone());
    blocking(move || agent::start_task(&agents, &bridge, &settings::load(&path), task, &prompt)).await
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
            let saved = settings::load(&settings_path);
            let launch = settings::resolve(&saved, |k| std::env::var(k).ok());
            // A taken or invalid hotkey must not stop the app; the settings screen shows why.
            let shortcut_error = capture::apply_shortcut(app.handle(), saved.capture_shortcut().as_deref()).err();
            if let Err(e) = capture::tray(app.handle()) {
                eprintln!("Hivemind: no tray icon ({e})");
            }
            let events = app.handle().clone();
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
            app.manage(AppState {
                bridge: Arc::new(Bridge::new(launch)),
                settings_path,
                drafts_dir,
                agents,
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
            lm, connect, git_activity, system_architecture, system_diagram, get_settings, save_settings, capture_status, show_main, draft_put, draft_get, draft_delete, draft_list,
            agent_available, agent_start, agent_cancel, agent_sessions, agent_session
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            // An agent session must not outlive the app that started it.
            if let tauri::RunEvent::Exit = event
                && let Some(state) = app.try_state::<AppState>()
            {
                state.agents.stop_all();
            }
        });
}
