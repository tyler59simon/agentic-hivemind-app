//! Tauri commands of Notes Studio's folder notebooks. The webview names a notebook by id and a page by a relative
//! path; every command resolves both here, so it can never reach a file outside a folder the user picked.
//!
//! A file opened from outside any notebook (NS-1B) is named as notebook `@<grant id>` with its file name as the path.
//! It reaches exactly the file the user chose: read, save, reveal and `asset_base` take it, every other command refuses.
use crate::files::guard::Protected;
use crate::files::{self, contain, watch, FileFormat, Loaded, SaveOutcome, Stamp};
use crate::notebooks::{self, sidecar, Notebook, Tree};
use crate::{blocking, AppState};
use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager, State};

/// The prefix of a loose file's notebook id.
pub const LOOSE: &str = "@";

fn loose_id(notebook: &str) -> Option<&str> {
    notebook.strip_prefix(LOOSE)
}

/// How the webview names a file: a page of a notebook, or a loose file (`@<grant>` and its file name).
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct OpenRef {
    pub notebook: String,
    pub path: String,
}

/// The protected places now: the store, managed and marked vaults, and Hivemind's own folders.
pub(crate) fn protected(state: &AppState) -> Protected {
    Protected::new(store_root(state).as_deref())
}

/// The loose file granted as `id`, named `name`, still the file the user chose (no link put in its place). The second
/// value says why it may not be written: it lies in a protected place, so it opens read-only (phase 1B, S2).
fn loose(state: &AppState, id: &str, name: &str) -> Result<(PathBuf, Option<String>), String> {
    loose_in(&state.grants, &protected(state), id, name)
}

fn loose_in(grants: &crate::opens::Grants, protected: &Protected, id: &str, name: &str) -> Result<(PathBuf, Option<String>), String> {
    let grant = grants.get(id).ok_or_else(|| "Hivemind no longer has this file in its recent list; open it again".to_string())?;
    let full = PathBuf::from(&grant.path);
    if full.file_name().map(|n| n.to_string_lossy().to_lowercase()) != Some(name.to_lowercase()) {
        return Err(format!("{name} is not the file Hivemind opened"));
    }
    // Its folder is checked first, before anything there is read or put back: still the folder the user chose, with no
    // link put in its place (Codex review of 52051c8, P1). The file itself must not be a link either. A file that is
    // missing passes, so a save reports it gone and offers Save as.
    let folder = full.parent().ok_or_else(|| format!("{} has no folder", grant.path))?;
    let linked = std::fs::symlink_metadata(&full).is_ok_and(|m| m.file_type().is_symlink());
    if linked || !contain::unmoved(folder) {
        return Err(format!("{} was replaced by a link; open the file again", grant.path));
    }
    let locked = protected.check(&full).err().or_else(|| files::guard::reserved(&full));
    // An interrupted save is put back only where Hivemind may write.
    if locked.is_none() && std::fs::symlink_metadata(&full).is_err() {
        files::recover(&full);
    }
    Ok((full, locked))
}

/// How the webview names a file the user chose outside the notebook tree (the open dialog, Explorer, a drop, Save as):
/// a page of the registered notebook it lies in, so its tabs and drafts are the page's (phase 1B, U9), or else a loose
/// file, which also puts it first in the recent list.
pub(crate) fn ref_for(state: &AppState, path: &Path, now: &str) -> Result<OpenRef, String> {
    let opened = ref_in(&state.notebooks, &state.grants, path, now)?;
    // A new recent file may push the oldest off the list.
    crate::opens::prune_assets(state);
    Ok(opened)
}

fn ref_in(notebooks: &notebooks::Registry, grants: &crate::opens::Grants, path: &Path, now: &str) -> Result<OpenRef, String> {
    let real = std::fs::canonicalize(path).map_err(|e| format!("Could not open {}: {e}", path.display()))?;
    if real.is_dir() {
        return Err(format!("{} is a folder", path.display()));
    }
    for notebook in notebooks.list() {
        if let Some(rel) = contain::resolved_rel(Path::new(&notebook.path), &real)
            && visible(&rel).is_ok()
            && unmoved(&notebook).is_ok()
        {
            return Ok(OpenRef { notebook: notebook.id, path: rel });
        }
    }
    let grant = grants.add(&real, now)?;
    // The name the grant was made with: after a case-only rename the file keeps its grant, and so its tab and draft.
    let name = Path::new(&grant.path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    Ok(OpenRef { notebook: format!("{LOOSE}{}", grant.id), path: name })
}

/// The notebook folder for `id`, checked against the current store and vaults (the store may have changed since
/// the notebook was registered). The folder must still be the one the user picked: a registered folder that was moved
/// and replaced by a link resolves elsewhere and is refused (Codex review of 32fd236, P4).
fn root_of(state: &AppState, id: &str) -> Result<(PathBuf, Protected), String> {
    if loose_id(id).is_some() {
        return Err("This file is not in a notebook".into());
    }
    let root = unmoved(&state.notebooks.get(id)?)?;
    let protected = Protected::new(store_root(state).as_deref());
    protected.check_root(&root)?;
    Ok((root, protected))
}

/// The notebook's folder, still the one that was registered. The registered path is canonical, so no folder on it was
/// a link then; one that is a link now (a junction put in its place, perhaps to a sibling spelled with other case) is
/// refused. With no link on the path, the canonical path differs from the registered one only by a case-only rename,
/// which keeps the notebook (Codex re-reviews of c496e1c and b82e9ab, P4).
fn unmoved(notebook: &Notebook) -> Result<PathBuf, String> {
    let root = PathBuf::from(&notebook.path);
    let real = std::fs::canonicalize(&root).map_err(|e| format!("The notebook folder {} is missing ({e})", root.display()))?;
    let linked = root.ancestors().any(|p| std::fs::symlink_metadata(p).is_ok_and(|m| m.file_type().is_symlink()));
    if linked || crate::folders::plain(&real).to_lowercase() != notebook.path.to_lowercase() {
        return Err(format!(
            "The folder of \"{}\" now leads to {}; it was moved or replaced by a link. Remove the notebook and add its folder again",
            notebook.title,
            crate::folders::plain(&real)
        ));
    }
    Ok(root)
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
    // Its pictures stop loading at once (phase 1B, S3).
    crate::opens::prune_assets(&state);
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
    if let Some(id) = loose_id(&notebook) {
        let (full, locked) = loose(&state, id, &path)?;
        return blocking(move || {
            let mut loaded = if locked.is_some() { files::read_view(&full)? } else { files::read(&full)? };
            if locked.is_some() {
                loaded.convertible = false;
                if loaded.read_only.is_none() {
                    loaded.read_only = locked;
                }
            }
            Ok(loaded)
        })
        .await;
    }
    let (root, protected) = root_of(&state, &notebook)?;
    blocking(move || files::read(&inside(&root, &protected, &path, false)?)).await
}

/// `convert`: the user chose Convert to UTF-8 for a page that opened read-only, so its undecodable text may be replaced.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn file_save(
    state: State<'_, AppState>,
    notebook: String,
    path: String,
    text: String,
    pre: Stamp,
    format: FileFormat,
    convert: Option<bool>,
) -> Result<SaveOutcome, String> {
    let convert = convert.unwrap_or(false);
    if let Some(id) = loose_id(&notebook) {
        let (full, locked) = loose(&state, id, &path)?;
        if let Some(why) = locked {
            return Err(why);
        }
        return blocking(move || files::save(&full, &text, &pre, &format, convert)).await;
    }
    let (root, protected) = root_of(&state, &notebook)?;
    blocking(move || files::save(&inside(&root, &protected, &path, true)?, &text, &pre, &format, convert)).await
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
        // The moved drafts would overwrite unsaved edits kept for a page at the destination (Codex re-review of fa08348,
        // F2).
        if crate::drafts::any_under(&drafts_dir, &notebook, &to) {
            return Err(format!("{to} has unsaved edits kept as a draft; open it and save or discard them first"));
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
    let state = app.state::<AppState>();
    let full = match (loose_id(&notebook), path.as_deref()) {
        (Some(id), Some(name)) => loose(&state, id, name)?.0,
        (Some(_), None) => return Err("This file is not in a notebook".into()),
        (None, path) => {
            let (root, protected) = root_of(&state, &notebook)?;
            match path {
                Some(rel) => inside(&root, &protected, rel, false)?,
                None => root,
            }
        }
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

/// The URL prefix pictures beside a page load from (`hmfile`, phase 1B): the notebook's root for a notebook page, the
/// file's folder for a loose file. The webview adds the picture's path relative to that folder.
#[tauri::command]
pub fn asset_base(state: State<'_, AppState>, notebook: String, path: String) -> Result<String, String> {
    let root = match loose_id(&notebook) {
        Some(id) => loose(&state, id, &path)?.0.parent().map(Path::to_path_buf).ok_or("This file has no folder")?,
        None => root_of(&state, &notebook)?.0,
    };
    Ok(crate::assets::base_url(&state.assets.grant(&root)))
}

/// How long a dropped folder can still be added as a notebook.
const DROP_PATIENCE: std::time::Duration = std::time::Duration::from_secs(120);

/// Add a folder the user dropped on the window as a notebook, after they confirmed it. Only folders Rust saw dropped in
/// the last two minutes are accepted, by the token it gave the webview (`folder-dropped`).
#[tauri::command]
pub async fn notebook_add_dropped(app: AppHandle, token: String) -> Result<Notebook, String> {
    let handle = app.clone();
    let added = blocking(move || {
        let state = handle.state::<AppState>();
        let folder = take_dropped(&state.dropped_folders, &token)?;
        let store = store_root(&state);
        state.notebooks.add(&folder, store.as_deref(), &chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
    })
    .await?;
    rewatch(&app);
    Ok(added)
}

/// The folder dropped under `token`, if it was dropped in the last two minutes and is still the folder that was dropped:
/// a junction put in its place while the user read the question would register another folder (Codex review of
/// 52051c8, P2).
fn take_dropped(dropped: &std::sync::Mutex<Vec<(String, PathBuf, std::time::Instant)>>, token: &str) -> Result<PathBuf, String> {
    let mut dropped = dropped.lock().unwrap_or_else(|e| e.into_inner());
    dropped.retain(|(_, _, at)| at.elapsed() < DROP_PATIENCE);
    let at = dropped.iter().position(|(t, ..)| t == token).ok_or("That folder was dropped too long ago; drop it again")?;
    let folder = dropped.remove(at).1;
    if !contain::unmoved(&folder) {
        return Err(format!("{} changed after it was dropped; drop it again", folder.display()));
    }
    Ok(folder)
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

    fn temp_dir() -> PathBuf {
        let dir = std::fs::canonicalize(std::env::temp_dir()).unwrap().join(format!("hm-studio-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_file_inside_a_notebook_opens_as_its_page_and_any_other_gets_a_grant() {
        let base = temp_dir();
        std::fs::create_dir_all(base.join("nb/Sub")).unwrap();
        std::fs::create_dir_all(base.join("nb/.git")).unwrap();
        std::fs::create_dir_all(base.join("other")).unwrap();
        for f in ["nb/Sub/Page.md", "nb/.git/config", "other/run.log"] {
            std::fs::write(base.join(f), "x").unwrap();
        }
        let registry = notebooks::Registry::new(base.join("app/notebooks.json"));
        let notebook = registry.add(&base.join("nb"), None, "t").unwrap();
        let grants = crate::opens::Grants::new(base.join("app/open-files.json"));
        assert_eq!(ref_in(&registry, &grants, &base.join("nb/Sub/Page.md"), "t").unwrap(), OpenRef { notebook: notebook.id.clone(), path: "Sub/Page.md".into() });
        let log = ref_in(&registry, &grants, &base.join("other/run.log"), "t").unwrap();
        assert!(log.notebook.starts_with(LOOSE) && log.path == "run.log");
        assert_eq!(grants.get(&log.notebook[1..]).unwrap().path, crate::folders::plain(&base.join("other/run.log")));
        // A hidden file of a notebook is not a page; the user chose it, so it opens as a loose file.
        assert!(ref_in(&registry, &grants, &base.join("nb/.git/config"), "t").unwrap().notebook.starts_with(LOOSE));
        assert!(ref_in(&registry, &grants, &base.join("nb/Sub"), "t").is_err(), "a folder is not opened");
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn nothing_is_put_back_through_a_moved_folder_and_a_dropped_folder_must_stay_put() {   // Codex review of 52051c8, P1 and P2
        let junction = |link: &Path, target: &Path| {
            let made = std::process::Command::new("cmd").args(["/C", "mklink", "/J"]).arg(link).arg(target).output().unwrap();
            assert!(made.status.success(), "mklink /J needs no admin rights: {}", String::from_utf8_lossy(&made.stderr));
        };
        let base = temp_dir();
        std::fs::create_dir_all(base.join("docs")).unwrap();
        std::fs::write(base.join("docs/a.txt"), "a").unwrap();
        let grants = crate::opens::Grants::new(base.join("open-files.json"));
        let grant = grants.add(&base.join("docs/a.txt"), "t").unwrap();
        // The folder replaced by a junction to one holding an interrupted save of the same name.
        std::fs::create_dir_all(base.join("elsewhere")).unwrap();
        let aside = files::atomic::beside(&base.join("elsewhere/a.txt"), "old-").unwrap();
        std::fs::write(&aside, "theirs").unwrap();
        std::fs::rename(base.join("docs"), base.join("docs-old")).unwrap();
        junction(&base.join("docs"), &base.join("elsewhere"));
        assert!(loose_in(&grants, &Protected::new(None), &grant.id, "a.txt").unwrap_err().contains("link"));
        assert!(aside.exists() && !base.join("elsewhere/a.txt").exists(), "nothing was put back in the other folder");
        std::fs::remove_dir(base.join("docs")).unwrap();
        // A dropped folder that became a junction before the user confirmed.
        let list = std::sync::Mutex::new(vec![("t1".to_string(), PathBuf::from(crate::folders::plain(&base.join("docs-old"))), std::time::Instant::now())]);
        std::fs::rename(base.join("docs-old"), base.join("docs-moved")).unwrap();
        junction(&base.join("docs-old"), &base.join("elsewhere"));
        assert!(take_dropped(&list, "t1").unwrap_err().contains("changed"));
        std::fs::remove_dir(base.join("docs-old")).unwrap();
        let list = std::sync::Mutex::new(vec![("t2".to_string(), PathBuf::from(crate::folders::plain(&base.join("docs-moved"))), std::time::Instant::now())]);
        assert!(take_dropped(&list, "t2").is_ok());
        assert!(take_dropped(&list, "t2").is_err(), "a token is taken once");
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn a_loose_file_in_a_reserved_folder_is_read_only() {   // Codex re-review of fa08348, P1
        let base = temp_dir();
        std::fs::create_dir_all(base.join(".git")).unwrap();
        std::fs::write(base.join(".git/config"), "[core]\n").unwrap();
        let grants = crate::opens::Grants::new(base.join("open-files.json"));
        let grant = grants.add(&base.join(".git").join("config"), "t").unwrap();
        let (_, locked) = loose_in(&grants, &Protected::new(None), &grant.id, "config").unwrap();
        assert!(locked.unwrap().contains(".git folder"));
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn a_case_only_rename_keeps_a_loose_files_grant_and_tab() {   // Codex re-review of fa08348, N5
        let base = temp_dir();
        std::fs::write(base.join("note.txt"), "x").unwrap();
        let registry = notebooks::Registry::new(base.join("app/notebooks.json"));
        let grants = crate::opens::Grants::new(base.join("app/open-files.json"));
        let first = ref_in(&registry, &grants, &base.join("note.txt"), "t").unwrap();
        std::fs::rename(base.join("note.txt"), base.join("Note.txt")).unwrap();
        let again = ref_in(&registry, &grants, &base.join("Note.txt"), "t").unwrap();
        assert_eq!(again, first, "the same grant and name, so the same tab and draft");
        assert_eq!(grants.list().len(), 1);
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn two_files_differing_only_in_case_get_their_own_grants() {   // Codex review of 52051c8, W1
        let base = temp_dir();
        let made = std::process::Command::new("fsutil").args(["file", "setCaseSensitiveInfo"]).arg(&base).arg("enable").output().unwrap();
        assert!(made.status.success(), "fsutil could not make a case-sensitive folder: {}", String::from_utf8_lossy(&made.stdout));
        std::fs::write(base.join("A.txt"), "same").unwrap();
        std::fs::write(base.join("a.txt"), "same").unwrap();
        let registry = notebooks::Registry::new(base.join("app/notebooks.json"));
        let grants = crate::opens::Grants::new(base.join("app/open-files.json"));
        let upper = ref_in(&registry, &grants, &base.join("A.txt"), "t").unwrap();
        let lower = ref_in(&registry, &grants, &base.join("a.txt"), "t").unwrap();
        assert_ne!(upper.notebook, lower.notebook);
        assert_eq!(grants.list().len(), 2);
        // Reopening the same file gives the same grant.
        assert_eq!(ref_in(&registry, &grants, &base.join("A.txt"), "t").unwrap(), upper);
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn a_loose_file_reaches_only_its_own_file_and_one_in_a_protected_place_is_read_only() {
        let base = temp_dir();
        std::fs::create_dir_all(base.join("docs")).unwrap();
        std::fs::write(base.join("docs/a.txt"), "a").unwrap();
        let grants = crate::opens::Grants::new(base.join("open-files.json"));
        let grant = grants.add(&base.join("docs/a.txt"), "t").unwrap();
        let open = Protected::new(None);
        let (full, locked) = loose_in(&grants, &open, &grant.id, "A.TXT").unwrap();
        assert_eq!(full, PathBuf::from(crate::folders::plain(&base.join("docs/a.txt"))));
        assert_eq!(locked, None);
        assert!(loose_in(&grants, &open, &grant.id, "b.txt").is_err(), "another name in the same folder");
        assert!(loose_in(&grants, &open, "0000000000000000", "a.txt").is_err(), "an unknown grant");
        // Deleted: still its own path, so a save answers Gone instead of failing.
        std::fs::remove_file(base.join("docs/a.txt")).unwrap();
        let (gone, _) = loose_in(&grants, &open, &grant.id, "a.txt").unwrap();
        let pre = Stamp { sha256: String::new(), size: 1, mtime_ms: 0 };
        let format = FileFormat { encoding: "UTF-8".into(), bom: false, eol: files::Eol::Lf, confidence: Default::default() };
        assert!(matches!(files::save(&gone, "a", &pre, &format, false).unwrap(), SaveOutcome::Gone));
        std::fs::write(base.join("docs/a.txt"), "a").unwrap();
        // Inside the store: readable, never writable.
        let store = Protected::new(Some(&base.join("docs")));
        assert!(loose_in(&grants, &store, &grant.id, "a.txt").unwrap().1.unwrap().contains("Living Memory store"));
        // Its folder replaced by a junction to another folder holding the same name.
        std::fs::create_dir_all(base.join("elsewhere")).unwrap();
        std::fs::write(base.join("elsewhere/a.txt"), "other").unwrap();
        std::fs::rename(base.join("docs"), base.join("docs-old")).unwrap();
        let made = std::process::Command::new("cmd").args(["/C", "mklink", "/J"]).arg(base.join("docs")).arg(base.join("elsewhere")).output().unwrap();
        assert!(made.status.success(), "mklink /J needs no admin rights: {}", String::from_utf8_lossy(&made.stderr));
        assert!(loose_in(&grants, &open, &grant.id, "a.txt").unwrap_err().contains("link"));
        std::fs::remove_dir(base.join("docs")).unwrap();
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn a_notebook_folder_is_found_by_its_own_spelling_and_survives_a_case_only_rename() {
        let scratch = || {
            let dir = std::fs::canonicalize(std::env::temp_dir()).unwrap().join(format!("hm-studio-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            dir
        };
        let register = |dir: &Path| Notebook { id: "nb-00000001".into(), path: crate::folders::plain(&std::fs::canonicalize(dir).unwrap()), title: "Notes".into(), added: String::new() };
        // A case-sensitive parent with two spellings: the registered one is found, and once it is gone the other
        // spelling is not taken for it.
        let sensitive = scratch();
        let made = std::process::Command::new("fsutil").args(["file", "setCaseSensitiveInfo"]).arg(&sensitive).arg("enable").output().unwrap();
        assert!(made.status.success(), "fsutil could not make a case-sensitive folder: {}", String::from_utf8_lossy(&made.stdout));
        std::fs::create_dir(sensitive.join("Notes")).unwrap();
        std::fs::create_dir(sensitive.join("notes")).unwrap();
        let notebook = register(&sensitive.join("Notes"));
        assert_eq!(unmoved(&notebook).unwrap(), PathBuf::from(&notebook.path));
        std::fs::remove_dir(sensitive.join("Notes")).unwrap();
        assert!(unmoved(&notebook).is_err(), "the other spelling is another folder");
        // A junction put in its place that leads to the other spelling is refused too.
        let made = std::process::Command::new("cmd").args(["/C", "mklink", "/J"]).arg(sensitive.join("Notes")).arg(sensitive.join("notes")).output().unwrap();
        assert!(made.status.success(), "mklink /J needs no admin rights: {}", String::from_utf8_lossy(&made.stderr));
        assert!(unmoved(&notebook).unwrap_err().contains("link"));
        // An ordinary folder renamed by case only is the same notebook.
        let ordinary = scratch();
        std::fs::create_dir(ordinary.join("Notes")).unwrap();
        let notebook = register(&ordinary.join("Notes"));
        std::fs::rename(ordinary.join("Notes"), ordinary.join("NOTES")).unwrap();
        assert!(unmoved(&notebook).is_ok());
        std::fs::remove_dir_all(&sensitive).unwrap();
        std::fs::remove_dir_all(&ordinary).unwrap();
    }

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
        let made = std::process::Command::new("cmd").args(["/C", "mklink", "/J"]).arg(root.join("cfg")).arg(root.join(".obsidian")).output().unwrap();
        assert!(made.status.success(), "mklink /J needs no admin rights: {}", String::from_utf8_lossy(&made.stderr));
        let protected = Protected::new(None);
        assert!(inside(&root, &protected, "cfg/app.json", false).unwrap_err().contains("hidden"), "read through the link");
        assert!(inside(&root, &protected, "cfg/app.json", true).is_err(), "write through the link");
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
