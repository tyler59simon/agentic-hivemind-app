mod bridge;
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
    watcher: Mutex<Option<notify_debouncer_mini::Debouncer<notify_debouncer_mini::notify::RecommendedWatcher>>>,
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
    let handle = app.clone();
    let debouncer = watcher::watch(&PathBuf::from(&root), move |domains| {
        let _ = handle.emit("notes-changed", NotesChanged { domains });
    })?;
    *state.watcher.lock().unwrap() = Some(debouncer);
    let launch = state.bridge.launch();
    Ok(ConnectInfo { version: version.result, root, program: launch.program, script: launch.script.display().to_string() })
}

#[tauri::command]
fn get_settings(state: State<'_, AppState>) -> Settings {
    settings::load(&state.settings_path)
}

#[tauri::command]
fn save_settings(state: State<'_, AppState>, value: Settings) -> Result<(), String> {
    settings::save(&state.settings_path, &value)?;
    *state.watcher.lock().unwrap() = None;
    state.bridge.reconfigure(settings::resolve(&value, |k| std::env::var(k).ok()));
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let settings_path = app.path().app_config_dir()?.join("settings.json");
            let launch = settings::resolve(&settings::load(&settings_path), |k| std::env::var(k).ok());
            app.manage(AppState { bridge: Arc::new(Bridge::new(launch)), settings_path, watcher: Mutex::new(None) });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![lm, connect, get_settings, save_settings])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
