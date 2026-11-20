//! Tauri commands of Notes Studio's folder notebooks. The webview names a notebook by id and a page by a relative
//! path; every command resolves both here, so it can never reach a file outside a folder the user picked.
use crate::files::guard::Protected;
use crate::files::{self, contain, watch, FileFormat, Loaded, SaveOutcome, Stamp};
use crate::notebooks::{self, sidecar, Notebook, Tree};
use crate::{blocking, AppState};
use serde_json::Value;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager, State};

/// The notebook folder for `id`, checked against the current store and vaults (the store may have changed since
/// the notebook was registered).
fn root_of(state: &AppState, id: &str) -> Result<(PathBuf, Protected), String> {
    let root = PathBuf::from(state.notebooks.get(id)?.path);
    let protected = Protected::new(store_root(state).as_deref());
    protected.check_root(&root)?;
    Ok((root, protected))
}

/// `rel` inside the notebook, outside every protected place.
fn inside(root: &Path, protected: &Protected, rel: &str, for_write: bool) -> Result<PathBuf, String> {
    let full = contain::resolve_inside(root, rel, for_write)?;
    protected.check(&full)?;
    Ok(full)
}

/// A path the user may create, change, move or delete: no part may be hidden, which keeps `.git`, `.obsidian` and
/// `.hivemind` out of reach of every file command (the sidecar is written by `notebook_meta_set` only).
fn writable(rel: &str) -> Result<(), String> {
    let parts = contain::check_rel(rel)?;
    if parts.iter().any(|p| p.starts_with('.')) {
        return Err(format!("\"{rel}\" is a hidden file or folder, which Hivemind does not change"));
    }
    Ok(())
}

fn store_root(state: &AppState) -> Option<PathBuf> {
    if let Some(root) = state.store_root.lock().unwrap_or_else(|e| e.into_inner()).clone() {
        return Some(root);
    }
    state.bridge.launch().root.or_else(|| dirs::home_dir().map(|h| h.join("LivingMemory")))
}

/// Watch every registered notebook again (after the list changed, and at startup).
pub fn rewatch(app: &AppHandle) {
    let Some(state) = app.try_state::<AppState>() else { return };
    let roots: Vec<watch::Root> = state.notebooks.list().into_iter().map(|nb| watch::Root { id: nb.id, path: PathBuf::from(nb.path) }).collect();
    let mut slot = state.notebook_watcher.lock().unwrap_or_else(|e| e.into_inner());
    *slot = None;
    if roots.is_empty() {
        return;
    }
    let emitter = app.clone();
    match watch::watch(roots, move |changed| {
        let _ = emitter.emit("files-changed", changed);
    }) {
        Ok((debouncer, failed)) => {
            for why in failed {
                eprintln!("Hivemind: {why}");
            }
            *slot = Some(debouncer);
        }
        Err(e) => eprintln!("Hivemind: cannot watch notebooks ({e})"),
    }
}

#[tauri::command]
pub fn notebooks_list(state: State<'_, AppState>) -> Vec<Notebook> {
    state.notebooks.list()
}

/// Ask for a folder with the native dialog and register it. None when the user cancelled.
#[tauri::command]
pub async fn notebook_add(app: AppHandle) -> Result<Option<Notebook>, String> {
    use tauri_plugin_dialog::DialogExt;
    let handle = app.clone();
    let added = blocking(move || {
        let Some(picked) = handle.dialog().file().blocking_pick_folder() else { return Ok(None) };
        let picked = picked.into_path().map_err(|e| e.to_string())?;
        let state = handle.state::<AppState>();
        let store = store_root(&state);
        state.notebooks.add(&picked, store.as_deref(), &chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)).map(Some)
    })
    .await?;
    if added.is_some() {
        rewatch(&app);
    }
    Ok(added)
}

#[tauri::command]
pub fn notebook_remove(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.notebooks.remove(&id)?;
    rewatch(&app);
    Ok(())
}

#[tauri::command]
pub fn notebook_rename(state: State<'_, AppState>, id: String, title: String) -> Result<Notebook, String> {
    state.notebooks.rename(&id, &title)
}

#[tauri::command]
pub async fn notebook_tree(state: State<'_, AppState>, id: String) -> Result<Tree, String> {
    let (root, _) = root_of(&state, &id)?;
    blocking(move || {
        if !root.is_dir() {
            return Err(format!("The notebook folder {} is missing", root.display()));
        }
        Ok(notebooks::walk(&root))
    })
    .await
}

fn meta_fallback(state: &AppState, id: &str) -> PathBuf {
    state.notebook_meta_dir.join(format!("{id}.json"))
}

#[tauri::command]
pub async fn notebook_meta_get(state: State<'_, AppState>, id: String) -> Result<Value, String> {
    let (root, _) = root_of(&state, &id)?;
    let fallback = meta_fallback(&state, &id);
    blocking(move || Ok(sidecar::read(&root, &fallback))).await
}

#[tauri::command]
pub async fn notebook_meta_set(state: State<'_, AppState>, id: String, patch: Value) -> Result<Value, String> {
    let (root, _) = root_of(&state, &id)?;
    let fallback = meta_fallback(&state, &id);
    blocking(move || sidecar::write(&root, &fallback, &patch).map(|(merged, _)| merged)).await
}

#[tauri::command]
pub async fn file_read(state: State<'_, AppState>, notebook: String, path: String) -> Result<Loaded, String> {
    let (root, protected) = root_of(&state, &notebook)?;
    blocking(move || files::read(&inside(&root, &protected, &path, false)?)).await
}

#[tauri::command]
pub async fn file_save(state: State<'_, AppState>, notebook: String, path: String, text: String, pre: Stamp, format: FileFormat) -> Result<SaveOutcome, String> {
    writable(&path)?;
    let (root, protected) = root_of(&state, &notebook)?;
    blocking(move || files::save(&inside(&root, &protected, &path, true)?, &text, &pre, &format)).await
}

#[tauri::command]
pub async fn file_create(state: State<'_, AppState>, notebook: String, path: String, text: String) -> Result<Stamp, String> {
    writable(&path)?;
    let (root, protected) = root_of(&state, &notebook)?;
    blocking(move || files::create(&inside(&root, &protected, &path, true)?, &text)).await
}

#[tauri::command]
pub async fn file_mkdir(state: State<'_, AppState>, notebook: String, path: String) -> Result<(), String> {
    writable(&path)?;
    let (root, protected) = root_of(&state, &notebook)?;
    blocking(move || {
        let full = inside(&root, &protected, &path, true)?;
        if std::fs::symlink_metadata(&full).is_ok() {
            return Err(format!("\"{path}\" already exists"));
        }
        std::fs::create_dir_all(&full).map_err(|e| format!("Could not create {}: {e}", full.display()))
    })
    .await
}

#[tauri::command]
pub async fn file_rename(state: State<'_, AppState>, notebook: String, from: String, to: String) -> Result<(), String> {
    writable(&from)?;
    writable(&to)?;
    if to.to_lowercase().starts_with(&format!("{}/", from.to_lowercase())) {
        return Err("A folder cannot move into itself".into());
    }
    let (root, protected) = root_of(&state, &notebook)?;
    let drafts_dir = state.drafts_dir.clone();
    blocking(move || {
        let source = inside(&root, &protected, &from, false)?;
        // Moving a folder: its own path must not be a link either.
        if std::fs::symlink_metadata(&source).map(|m| m.file_type().is_symlink()).unwrap_or(false) {
            return Err(format!("\"{from}\" is a link or junction, which Hivemind does not move"));
        }
        files::rename(&source, &inside(&root, &protected, &to, true)?)?;
        crate::drafts::retarget(&drafts_dir, &notebook, &from, &to);
        Ok(())
    })
    .await
}

/// Move a page or folder to the notebook's trash. With `pre`, a page is only trashed while it still holds those bytes.
#[tauri::command]
pub async fn file_delete(state: State<'_, AppState>, notebook: String, path: String, pre: Option<Stamp>) -> Result<String, String> {
    writable(&path)?;
    let (root, protected) = root_of(&state, &notebook)?;
    blocking(move || {
        let full = inside(&root, &protected, &path, false)?;
        if let Some(pre) = pre {
            let now = std::fs::read(&full).map_err(|e| format!("Could not read {}: {e}", full.display()))?;
            if files::sha256(&now) != pre.sha256 {
                return Err(format!("\"{path}\" changed on disk since it was opened; reopen it before deleting"));
            }
        }
        let moved = files::trash(&root, &path, &chrono::Local::now().format("%Y%m%d-%H%M%S").to_string())?;
        Ok(contain::relative(&root, &moved).unwrap_or_default())
    })
    .await
}

/// Show a page or folder in Explorer, or open a file with the program Windows associates with it.
#[tauri::command]
pub async fn file_reveal(app: AppHandle, notebook: String, path: Option<String>, open: bool) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let (root, protected) = root_of(&app.state::<AppState>(), &notebook)?;
    let full = match path.as_deref() {
        Some(rel) => inside(&root, &protected, rel, false)?,
        None => root,
    };
    if open {
        app.opener().open_path(full.display().to_string(), None::<&str>).map_err(|e| e.to_string())
    } else {
        app.opener().reveal_item_in_dir(&full).map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hidden_parts_are_not_writable() {
        assert!(writable("Projects/Page.md").is_ok());
        for bad in [".obsidian/app.json", ".git/config", ".hivemind/notebook.json", "a/.hidden/b.md", "../x.md", ""] {
            assert!(writable(bad).is_err(), "{bad}");
        }
    }
}
