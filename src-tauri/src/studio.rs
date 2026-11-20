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
/// the notebook was registered). The folder must still be the one the user picked: a registered folder that was moved
/// and replaced by a link resolves elsewhere and is refused (Codex review of 32fd236, P4).
fn root_of(state: &AppState, id: &str) -> Result<(PathBuf, Protected), String> {
    let notebook = state.notebooks.get(id)?;
    let root = PathBuf::from(&notebook.path);
    let real = std::fs::canonicalize(&root).map_err(|e| format!("The notebook folder {} is missing ({e})", root.display()))?;
    if crate::folders::plain(&real).to_lowercase() != notebook.path.to_lowercase() {
        return Err(format!(
            "The folder of \"{}\" now leads to {}; it was moved or replaced by a link. Remove the notebook and add its folder again",
            notebook.title,
            crate::folders::plain(&real)
        ));
    }
    let protected = Protected::new(store_root(state).as_deref());
    protected.check_root(&root)?;
    Ok((root, protected))
}

/// `rel` inside the notebook, outside every protected place, and not hidden once links inside the notebook are
/// followed (a link to `.obsidian` is as hidden as `.obsidian`; Codex review of 32fd236, P2).
fn inside(root: &Path, protected: &Protected, rel: &str, for_write: bool) -> Result<PathBuf, String> {
    visible(rel)?;
    let full = contain::resolve_inside(root, rel, for_write)?;
    protected.check(&full)?;
    if contain::resolved_rel(root, &full).is_some_and(|real| real.split('/').any(|p| p.starts_with('.'))) {
        return Err(format!("\"{rel}\" leads to a hidden file or folder, which Hivemind does not open or change"));
    }
    Ok(full)
}

/// A path any file command may name: no part may be hidden, which keeps `.git`, `.obsidian` and `.hivemind` out of
/// reach (the sidecar is read and written by `notebook_meta_get` and `notebook_meta_set` only).
fn visible(rel: &str) -> Result<(), String> {
    let parts = contain::check_rel(rel)?;
    if parts.iter().any(|p| p.starts_with('.')) {
        return Err(format!("\"{rel}\" is a hidden file or folder, which Hivemind does not open or change"));
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
    let (root, protected) = root_of(&state, &notebook)?;
    blocking(move || files::save(&inside(&root, &protected, &path, true)?, &text, &pre, &format)).await
}

#[tauri::command]
pub async fn file_create(state: State<'_, AppState>, notebook: String, path: String, text: String) -> Result<Stamp, String> {
    let (root, protected) = root_of(&state, &notebook)?;
    blocking(move || files::create(&inside(&root, &protected, &path, true)?, &text)).await
}

#[tauri::command]
pub async fn file_mkdir(state: State<'_, AppState>, notebook: String, path: String) -> Result<(), String> {
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
    if to.to_lowercase().starts_with(&format!("{}/", from.to_lowercase())) {
        return Err("A folder cannot move into itself".into());
    }
    let (root, protected) = root_of(&state, &notebook)?;
    let drafts_dir = state.drafts_dir.clone();
    blocking(move || {
        // Resolved as a write, so neither end goes through a link (Codex review of 32fd236, P2).
        let source = inside(&root, &protected, &from, true)?;
        if source.is_dir() {
            crate::files::guard::check_no_vault_inside(&source)?;
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
    let (root, protected) = root_of(&state, &notebook)?;
    blocking(move || {
        let full = inside(&root, &protected, &path, true)?;
        if full.is_dir() {
            crate::files::guard::check_no_vault_inside(&full)?;
        }
        let moved = files::trash(&root, &path, &chrono::Local::now().format("%Y%m%d-%H%M%S").to_string(), pre.as_ref())?;
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
        if let Some(why) = refuse_to_run(&full) {
            return Err(why);
        }
        app.opener().open_path(full.display().to_string(), None::<&str>).map_err(|e| e.to_string())
    } else {
        app.opener().reveal_item_in_dir(&full).map_err(|e| e.to_string())
    }
}

/// Kinds of file that run code when Windows opens them. Opening one from a notebook would run whatever a synced or
/// downloaded folder put there, so Hivemind shows it in Explorer instead (Claude's review of 32fd236, C1).
const RUNS_CODE: &[&str] = &[
    "exe", "com", "scr", "pif", "cpl", "msi", "msp", "msix", "msixbundle", "appx", "appxbundle", "appinstaller", "application", "appref-ms", "bat", "cmd",
    "ps1", "psm1", "psd1", "ps1xml", "psc1", "vbs", "vbe", "js", "jse", "wsf", "wsh", "ws", "hta", "jar", "lnk", "url", "website", "reg", "inf", "scf",
    "msc", "gadget", "chm", "settingcontent-ms", "library-ms", "search-ms", "searchconnector-ms", "diagcab", "xll", "iqy", "slk", "py", "pyw", "sh",
];

/// Why Hivemind will not open `path` with its associated program, or None.
fn refuse_to_run(path: &Path) -> Option<String> {
    let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    if path.is_dir() {
        return None;
    }
    if RUNS_CODE.contains(&ext.as_str()) || dangerous_to_windows(&ext) {
        return Some(format!("{} is a program or script, so Hivemind does not open it; use Show in Explorer", path.file_name().unwrap_or_default().to_string_lossy()));
    }
    None
}

/// What Windows itself counts as dangerous to open (the list behind its download warnings).
#[cfg(windows)]
fn dangerous_to_windows(ext: &str) -> bool {
    if ext.is_empty() {
        return false;
    }
    let wide: Vec<u16> = format!(".{ext}").encode_utf16().chain(std::iter::once(0)).collect();
    // SAFETY: a NUL-terminated wide string that lives until the call returns.
    unsafe { windows_sys::Win32::UI::Shell::AssocIsDangerous(wide.as_ptr()) != 0 }
}

#[cfg(not(windows))]
fn dangerous_to_windows(_ext: &str) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hidden_parts_are_never_named() {
        assert!(visible("Projects/Page.md").is_ok());
        for bad in [".obsidian/app.json", ".git/config", ".hivemind/notebook.json", "a/.hidden/b.md", "../x.md", ""] {
            assert!(visible(bad).is_err(), "{bad}");
        }
    }

    #[cfg(windows)]
    #[test]
    fn a_link_to_a_hidden_folder_is_hidden_too() {
        let root = std::fs::canonicalize(std::env::temp_dir()).unwrap().join(format!("hm-studio-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join(".obsidian")).unwrap();
        std::fs::write(root.join(".obsidian/app.json"), "{}").unwrap();
        let made = std::process::Command::new("cmd").args(["/C", "mklink", "/J"]).arg(root.join("cfg")).arg(root.join(".obsidian")).output();
        if made.map(|o| o.status.success()).unwrap_or(false) {
            let protected = Protected::new(None);
            assert!(inside(&root, &protected, "cfg/app.json", false).unwrap_err().contains("hidden"), "read through the link");
            assert!(inside(&root, &protected, "cfg/app.json", true).is_err(), "write through the link");
        }
        std::fs::write(root.join("Page.md"), "x").unwrap();
        assert!(inside(&root, &Protected::new(None), "Page.md", true).is_ok());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn programs_and_scripts_are_not_opened() {
        for name in ["setup.exe", "run.CMD", "x.ps1", "Shortcut.lnk", "page.url", "tool.msi", "a.hta"] {
            assert!(refuse_to_run(Path::new(name)).is_some(), "{name}");
        }
        for name in ["report.pdf", "photo.png", "sheet.xlsx", "notes.docx", "README"] {
            assert!(refuse_to_run(Path::new(name)).is_none(), "{name}");
        }
    }
}
