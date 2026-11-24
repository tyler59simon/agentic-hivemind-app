//! Files opened from outside a notebook (NS-1B): the queue of paths waiting for the webview, and the grants that let the
//! webview name a loose file without ever sending an absolute path. A path becomes a grant only when the user chose it:
//! the open dialog, Explorer ("Open with", a double-click, which arrives as an instance knock or a launch argument), a
//! drop on the window, or the save dialog of a new file.
use crate::files;
use crate::studio::{protected, ref_for, OpenRef};
use crate::{blocking, AppState};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

/// Recent files kept, newest first.
const MAX_GRANTS: usize = 200;
/// Request ids remembered, so a resent knock does not open its files twice.
const MAX_SEEN: usize = 64;
/// Paths one launch may ask to open.
pub const MAX_PATHS: usize = 32;

/// Paths waiting for the webview to take them (`open_pending`).
#[derive(Default)]
pub struct OpenQueue {
    inner: Mutex<(Vec<PathBuf>, VecDeque<String>)>,
}

impl OpenQueue {
    /// Queue paths from one request. False when the request id was seen before (a resend after a lost answer).
    pub fn push(&self, id: Option<&str>, paths: impl IntoIterator<Item = PathBuf>) -> bool {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(id) = id {
            if inner.1.iter().any(|seen| seen == id) {
                return false;
            }
            if inner.1.len() == MAX_SEEN {
                inner.1.pop_front();
            }
            inner.1.push_back(id.to_string());
        }
        for path in paths.into_iter().take(MAX_PATHS) {
            if !inner.0.contains(&path) {
                inner.0.push(path);
            }
        }
        true
    }

    /// Everything queued so far; the queue is empty afterwards.
    pub fn drain(&self) -> Vec<PathBuf> {
        std::mem::take(&mut self.inner.lock().unwrap_or_else(|e| e.into_inner()).0)
    }
}

/// The paths a launch was given: absolute (against `cwd`), existing files only, at most MAX_PATHS. Flags are skipped.
pub fn launch_paths(args: impl IntoIterator<Item = std::ffi::OsString>, cwd: &Path) -> Vec<PathBuf> {
    args.into_iter()
        .filter(|a| !a.to_string_lossy().starts_with('-'))
        .map(|a| cwd.join(a))
        .filter_map(|p| p.canonicalize().ok())
        .filter(|p| p.is_file())
        .map(|p| PathBuf::from(crate::folders::plain(&p)))
        .take(MAX_PATHS)
        .collect()
}

/// The paths a knock asked to open, as given: flags skipped, made absolute against the launch's folder (a relative path
/// with no folder is dropped), at most MAX_PATHS. Nothing touches the disk, so the holder answers at once; the paths
/// are checked when the webview takes them (Codex review of 52051c8, I2).
pub fn knock_paths(open: &[String], cwd: Option<&str>) -> Vec<PathBuf> {
    open.iter()
        .filter(|a| !a.starts_with('-'))
        .filter_map(|a| {
            let path = Path::new(a);
            if path.is_absolute() {
                Some(path.to_path_buf())
            } else {
                cwd.map(|c| Path::new(c).join(path))
            }
        })
        .take(MAX_PATHS)
        .collect()
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Grant {
    pub id: String,
    pub path: String,
    pub opened: String,
}

/// A grant id: the first 16 hex characters of the sha256 of the canonical path with forward slashes, so reopening a
/// file gives the same id (and the same tab and draft keys). The path keeps its letter case: canonical paths carry the
/// case on disk, and in a case-sensitive folder `A.txt` and `a.txt` are two files (Codex review of 52051c8, W1).
pub fn grant_id(path: &Path) -> String {
    use sha2::{Digest, Sha256};
    let key = crate::folders::plain(path).replace('\\', "/");
    Sha256::digest(key.as_bytes()).iter().take(8).map(|b| format!("{b:02x}")).collect()
}

#[derive(Serialize, Deserialize, Default)]
struct File {
    version: u32,
    grants: Vec<Grant>,
}

/// The recent loose files, persisted in `app_data/open-files.json`.
pub struct Grants {
    path: PathBuf,
    lock: Mutex<()>,
}

impl Grants {
    pub fn new(path: PathBuf) -> Self {
        Grants { path, lock: Mutex::new(()) }
    }

    fn load(&self) -> Vec<Grant> {
        std::fs::read(&self.path).ok().and_then(|b| serde_json::from_slice::<File>(&b).ok()).map(|f| f.grants).unwrap_or_default()
    }

    fn store(&self, grants: &[Grant]) -> Result<(), String> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let text = serde_json::to_vec_pretty(&File { version: 1, grants: grants.to_vec() }).map_err(|e| e.to_string())?;
        crate::files::atomic::replace(&self.path, &text)
    }

    pub fn list(&self) -> Vec<Grant> {
        let _held = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        self.load()
    }

    pub fn get(&self, id: &str) -> Option<Grant> {
        self.list().into_iter().find(|g| g.id == id)
    }

    /// Grant `path` (or refresh its grant) and put it first. The oldest beyond MAX_GRANTS are forgotten.
    pub fn add(&self, path: &Path, now: &str) -> Result<Grant, String> {
        let _held = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let plain = crate::folders::plain(path);
        let mut grants = self.load();
        // A case-only rename in a case-insensitive folder keeps the file's grant (and with it its tab and draft): the
        // stored spelling still resolves to this file. In a case-sensitive folder it is another file, or none (Codex
        // re-review of fa08348, N5).
        // A stored spelling that now goes through a link is not reused: loose files never open through one (Codex final
        // review of a34fafd, N5a).
        let same = grants.iter().position(|g| {
            g.path != plain
                && g.path.to_lowercase() == plain.to_lowercase()
                && crate::files::contain::unmoved(Path::new(&g.path))
                && std::fs::canonicalize(&g.path).is_ok_and(|real| crate::folders::plain(&real) == plain)
        });
        let grant = match same {
            Some(at) => Grant { opened: now.to_string(), ..grants.remove(at) },
            None => Grant { id: grant_id(path), path: plain, opened: now.to_string() },
        };
        grants.retain(|g| g.id != grant.id && g.path != grant.path);
        grants.insert(0, grant.clone());
        grants.truncate(MAX_GRANTS);
        self.store(&grants)?;
        Ok(grant)
    }

    /// Forget a grant; the file is untouched.
    pub fn forget(&self, id: &str) -> Result<(), String> {
        let _held = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut grants = self.load();
        grants.retain(|g| g.id != id);
        self.store(&grants)
    }
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/// Name every queued or picked path for the webview, dropping the ones that are gone or folders.
fn refs_for(app: &AppHandle, paths: Vec<PathBuf>) -> Vec<OpenRef> {
    let state = app.state::<AppState>();
    let now = now();
    paths.iter().filter_map(|p| ref_for(&state, p, &now).ok()).collect()
}

/// Pick files to open with the native dialog, any kind. Empty when the user cancelled.
#[tauri::command]
pub async fn open_dialog(app: AppHandle) -> Result<Vec<OpenRef>, String> {
    use tauri_plugin_dialog::DialogExt;
    let handle = app.clone();
    blocking(move || {
        let picked = handle.dialog().file().blocking_pick_files().unwrap_or_default();
        Ok(refs_for(&handle, picked.into_iter().filter_map(|p| p.into_path().ok()).take(MAX_PATHS).collect()))
    })
    .await
}

/// Files waiting to open: from Explorer (this launch's arguments or a later launch's knock) and drops on the window.
/// The webview calls it on start and on every `open-requested`, so none is missed while it starts.
#[tauri::command]
pub async fn open_pending(app: AppHandle) -> Result<Vec<OpenRef>, String> {
    let handle = app.clone();
    blocking(move || {
        let paths = handle.state::<AppState>().open_queue.drain();
        Ok(refs_for(&handle, paths))
    })
    .await
}

/// A recent loose file, for Ctrl+O.
#[derive(Serialize)]
pub struct Recent {
    pub id: String,
    pub path: String,
    pub name: String,
    pub opened: String,
    pub exists: bool,
}

#[tauri::command]
pub async fn open_recent(app: AppHandle) -> Result<Vec<Recent>, String> {
    blocking(move || {
        Ok(app
            .state::<AppState>()
            .grants
            .list()
            .into_iter()
            .map(|g| {
                let path = Path::new(&g.path);
                let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                Recent { exists: path.is_file(), id: g.id, name, opened: g.opened, path: g.path }
            })
            .collect())
    })
    .await
}

/// Drop a file from the recent list. Its pictures stop loading once no other recent file shares its folder.
#[tauri::command]
pub fn open_forget(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.grants.forget(&id)?;
    prune_assets(&state);
    Ok(())
}

/// Whether pictures may still load from `root`: it is a registered notebook's folder or the folder of a recent file.
fn in_use(root: &Path, notebooks: &[crate::notebooks::Notebook], grants: &[Grant]) -> bool {
    notebooks.iter().any(|n| Path::new(&n.path) == root) || grants.iter().any(|g| Path::new(&g.path).parent() == Some(root))
}

/// Withdraw picture grants nothing uses any more: after a notebook is removed, or a recent file is forgotten or pushed
/// off the end of the list (phase 1B, S3).
pub(crate) fn prune_assets(state: &AppState) {
    let (notebooks, grants) = (state.notebooks.list(), state.grants.list());
    state.assets.retain(|root| in_use(root, &notebooks, &grants));
}

/// Save a new text file where the user picks with the native dialog (which asks before replacing a file), as UTF-8
/// with LF line breaks. Returns how the webview names it from now on, or None when the user cancelled. Never into the
/// store, a managed vault or Hivemind's own folders.
#[tauri::command]
pub async fn file_save_as(app: AppHandle, text: String, suggested: String) -> Result<Option<OpenRef>, String> {
    use tauri_plugin_dialog::DialogExt;
    let handle = app.clone();
    blocking(move || {
        let Some(picked) = handle.dialog().file().set_file_name(&suggested).blocking_save_file() else { return Ok(None) };
        let path = picked.into_path().map_err(|e| e.to_string())?;
        let state = handle.state::<AppState>();
        may_save_as(&protected(&state), &path)?;
        // A file that is replaced is kept first when it has no history yet (NS-5), and the new version after.
        let history = &state.history_dir;
        if !crate::history::has_history(history, &path) {
            let _ = crate::history::snapshot_file(history, &path, None, "disk", crate::history::now_ms());
        }
        files::save_as(&path, &text)?;
        let _ = crate::history::snapshot_file(history, &path, None, "you", crate::history::now_ms());
        let opened = ref_for(&state, &path, &now())?;
        // A file saved into a notebook is a page of it now.
        crate::studio::indexed(&state, &opened);
        Ok(Some(opened))
    })
    .await
}

/// Whether Save As may write `path`: never into the store, a managed vault, Hivemind's own folders or a reserved folder.
fn may_save_as(protected: &crate::files::guard::Protected, path: &Path) -> Result<(), String> {
    protected.check(path)?;
    files::guard::reserved(path).map_or(Ok(()), Err)
}

/// A folder dropped on the window, offered to the webview as a new notebook.
#[derive(Serialize, Clone)]
struct FolderDropped {
    token: String,
    name: String,
}

/// How long the files of a drop wait for the webview to say what to do with them.
const DROP_PATIENCE: std::time::Duration = std::time::Duration::from_secs(120);

/// The files of recent drops, by the token the webview got for them (NS-3A). The webview names a file only by its
/// token and its index in the drop, so it can read or open only what the user dropped, and each file only once: a
/// mixed drop attaches its pictures while the rest open (Codex review of 398b956, P2). A drop is claimed once, by the
/// `files-dropped` listener or by the drain when the webview starts listening after the event went out (P3).
#[derive(Default)]
pub struct DroppedFiles {
    inner: Mutex<Vec<Drop>>,
}

struct Drop {
    token: String,
    files: Vec<Option<PathBuf>>,
    at: std::time::Instant,
    claimed: bool,
}

/// A drop no listener has claimed yet, for the drain.
#[derive(Serialize, Clone)]
pub struct Unclaimed {
    token: String,
    names: Vec<String>,
}

const GONE: &str = "Those files were dropped too long ago; drop them again";

impl DroppedFiles {
    /// Keep a drop's files; returns its token. Drops older than two minutes go.
    pub fn keep(&self, files: Vec<PathBuf>) -> String {
        let token = uuid::Uuid::new_v4().simple().to_string();
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.retain(|d| d.at.elapsed() < DROP_PATIENCE);
        inner.push(Drop { token: token.clone(), files: files.into_iter().map(Some).collect(), at: std::time::Instant::now(), claimed: false });
        token
    }

    /// Claim the drop `token` for routing; false when it was claimed already or is gone.
    pub fn claim(&self, token: &str) -> bool {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        match inner.iter_mut().find(|d| d.token == token && d.at.elapsed() < DROP_PATIENCE) {
            Some(d) if !d.claimed => { d.claimed = true; true }
            _ => false,
        }
    }

    /// Claim every drop no listener has claimed, with the names of its files.
    pub fn claim_all(&self) -> Vec<Unclaimed> {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.retain(|d| d.at.elapsed() < DROP_PATIENCE);
        inner.iter_mut().filter(|d| !d.claimed).map(|d| {
            d.claimed = true;
            let names = d.files.iter().map(|f| f.as_ref().and_then(|p| p.file_name()).map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()).collect();
            Unclaimed { token: d.token.clone(), names }
        }).collect()
    }

    /// Take the files at `indexes` of the drop `token`, each at most once; the drop goes once all its files are taken.
    pub fn take(&self, token: &str, indexes: &[usize]) -> Result<Vec<PathBuf>, String> {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.retain(|d| d.at.elapsed() < DROP_PATIENCE);
        let at = inner.iter().position(|d| d.token == token).ok_or(GONE)?;
        let drop = &mut inner[at];
        let mut picked: Vec<usize> = indexes.to_vec();
        picked.sort_unstable();
        picked.dedup();
        let taken = picked.into_iter().filter_map(|i| drop.files.get_mut(i).and_then(Option::take)).collect();
        if drop.files.iter().all(Option::is_none) {
            inner.remove(at);
        }
        Ok(taken)
    }

    /// Take the one file at `index` of the drop `token`.
    pub fn file(&self, token: &str, index: usize) -> Result<PathBuf, String> {
        self.take(token, &[index])?.pop().ok_or_else(|| "That file was not part of the drop, or was used already".to_string())
    }
}

/// Files dropped on the window, for the webview to route by where they landed (NS-3A). The position is in physical
/// pixels, as Tauri reports it.
#[derive(Serialize, Clone)]
struct FilesDropped {
    token: String,
    names: Vec<String>,
    x: f64,
    y: f64,
}

/// Files and folders dropped on the main window, seen here in Rust (Tauri's drop event), so the webview never names a
/// path itself. Files are kept under a token and offered to the webview, which attaches pictures dropped on a page,
/// leaves a drop on a terminal to the terminal, and opens the rest with `open_dropped` (NS-3A). Each folder is offered
/// as a new notebook by a token that `notebook_add_dropped` accepts for two minutes.
pub fn dropped(app: &AppHandle, paths: &[PathBuf], position: (f64, f64)) {
    let state = app.state::<AppState>();
    let (folders, found): (Vec<PathBuf>, Vec<PathBuf>) = paths.iter().filter_map(|p| p.canonicalize().ok()).partition(|p| p.is_dir());
    let found: Vec<PathBuf> = found.iter().filter(|p| p.is_file()).map(|p| PathBuf::from(crate::folders::plain(p))).take(MAX_PATHS).collect();
    if !found.is_empty() {
        let names = found.iter().map(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()).collect();
        let token = state.dropped_files.keep(found);
        let _ = app.emit("files-dropped", FilesDropped { token, names, x: position.0, y: position.1 });
    }
    for folder in folders.into_iter().take(4) {
        let token = uuid::Uuid::new_v4().simple().to_string();
        let name = folder.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        state.dropped_folders.lock().unwrap_or_else(|e| e.into_inner()).push((token.clone(), PathBuf::from(crate::folders::plain(&folder)), std::time::Instant::now()));
        let _ = app.emit("folder-dropped", FolderDropped { token, name });
    }
}

/// Open the files of a drop at `indexes` like files from Explorer: the ones the webview did not attach or leave to a
/// terminal (NS-3A).
#[tauri::command]
pub fn open_dropped(app: AppHandle, state: State<'_, AppState>, token: String, indexes: Vec<usize>) -> Result<(), String> {
    let files = state.dropped_files.take(&token, &indexes)?;
    if !files.is_empty() {
        state.open_queue.push(None, files);
        let _ = app.emit("open-requested", ());
    }
    Ok(())
}

/// Claim the drop `token` for routing (NS-3A): false when the drain has it already.
#[tauri::command]
pub fn claim_drop(state: State<'_, AppState>, token: String) -> bool {
    state.dropped_files.claim(&token)
}

/// The drops sent while no listener was in place, claimed for the webview that asks (NS-3A).
#[tauri::command]
pub fn unclaimed_drops(state: State<'_, AppState>) -> Vec<Unclaimed> {
    state.dropped_files.claim_all()
}

#[cfg(test)]
mod prune_tests {
    use super::*;

    #[test]
    fn a_drop_hands_out_only_its_own_files_once() {   // NS-3A
        let drops = DroppedFiles::default();
        let token = drops.keep(vec![PathBuf::from("C:/drops/a.png"), PathBuf::from("C:/drops/b.txt"), PathBuf::from("C:/drops/c.png")]);
        assert!(drops.file(&token, 3).is_err(), "an index past the drop names nothing");
        assert!(drops.file("other", 0).is_err(), "another token names nothing");
        // A mixed drop: the text file opens while the pictures are still being attached (Codex review of 398b956, P2).
        assert_eq!(drops.file(&token, 0).unwrap(), PathBuf::from("C:/drops/a.png"));
        assert_eq!(drops.take(&token, &[1, 1, 7]).unwrap(), vec![PathBuf::from("C:/drops/b.txt")]);
        assert_eq!(drops.file(&token, 2).unwrap(), PathBuf::from("C:/drops/c.png"));
        assert!(drops.file(&token, 0).is_err(), "each file is handed out once");
        assert!(drops.take(&token, &[1]).is_err(), "a drop whose files were all taken is gone");
    }

    #[test]
    fn a_drop_is_claimed_once_by_the_listener_or_the_drain() {   // Codex review of 398b956, P3
        let drops = DroppedFiles::default();
        let early = drops.keep(vec![PathBuf::from("C:/drops/early.md")]);
        let heard = drops.keep(vec![PathBuf::from("C:/drops/heard.md")]);
        assert!(drops.claim(&heard));
        assert!(!drops.claim(&heard), "claimed once");
        let drained = drops.claim_all();
        assert_eq!(drained.len(), 1);
        assert_eq!((drained[0].token.as_str(), drained[0].names.clone()), (early.as_str(), vec!["early.md".to_string()]));
        assert!(drops.claim_all().is_empty() && !drops.claim(&early), "the drain claimed it");
        assert_eq!(drops.take(&early, &[0]).unwrap(), vec![PathBuf::from("C:/drops/early.md")]);
    }

    // Uses Windows paths (C:\...), which are relative elsewhere (MACOS-1D).
    #[cfg(windows)]
    #[test]
    fn knock_paths_touch_nothing_and_keep_only_usable_paths() {   // Codex review of 52051c8, I2
        let open = vec!["--flag".to_string(), "rel.txt".to_string(), r"C:\nowhere\abs.md".to_string()];
        assert_eq!(knock_paths(&open, Some(r"C:\work")), vec![PathBuf::from(r"C:\work\rel.txt"), PathBuf::from(r"C:\nowhere\abs.md")]);
        assert_eq!(knock_paths(&open, None), vec![PathBuf::from(r"C:\nowhere\abs.md")], "a relative path needs the launch's folder");
        let many: Vec<String> = (0..40).map(|i| format!(r"C:\f{i}.txt")).collect();
        assert_eq!(knock_paths(&many, None).len(), MAX_PATHS);
    }

    #[test]
    fn picture_grants_stay_only_for_notebooks_and_folders_of_recent_files() {
        let nb = |p: &str| crate::notebooks::Notebook { id: "nb-1".into(), path: p.into(), ..Default::default() };
        let grant = |p: &str| Grant { id: "g".into(), path: p.into(), opened: String::new() };
        let (notebooks, grants) = (vec![nb(r"C:\nb")], vec![grant(r"C:\docs\a.txt")]);
        assert!(in_use(Path::new(r"C:\nb"), &notebooks, &grants));
        assert!(in_use(Path::new(r"C:\docs"), &notebooks, &grants));
        assert!(!in_use(Path::new(r"C:\old"), &notebooks, &grants), "a folder whose last recent file was forgotten or evicted");
        assert!(!in_use(Path::new(r"C:\nb\sub"), &notebooks, &grants), "only the exact folder");
        let assets = crate::assets::AssetGrants::default();
        let (kept, dropped) = (assets.grant(Path::new(r"C:\docs")), assets.grant(Path::new(r"C:\old")));
        assets.retain(|root| in_use(root, &notebooks, &grants));
        assert_eq!(assets.grant(Path::new(r"C:\docs")), kept);
        assert_ne!(assets.grant(Path::new(r"C:\old")), dropped, "a pruned folder gets a new id, so old URLs stop loading");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hm-opens-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[cfg(windows)]
    fn junction(link: &Path, target: &Path) {
        let made = std::process::Command::new("cmd").args(["/C", "mklink", "/J"]).arg(link).arg(target).output().unwrap();
        assert!(made.status.success(), "mklink /J needs no admin rights: {}", String::from_utf8_lossy(&made.stderr));
    }

    #[cfg(windows)]
    #[test]
    fn save_as_refuses_a_reserved_folder_named_or_reached_through_a_link() {   // Codex final review of a34fafd, P1 and T2
        let dir = scratch();
        std::fs::create_dir_all(dir.join(".git")).unwrap();
        junction(&dir.join("alias"), &dir.join(".git"));
        let open = crate::files::guard::Protected::new(None);
        assert!(may_save_as(&open, &dir.join(".git/config")).unwrap_err().contains(".git"));
        assert!(may_save_as(&open, &dir.join("alias/config")).unwrap_err().contains(".git"));
        assert!(may_save_as(&open, &dir.join("notes.txt")).is_ok());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn a_stored_spelling_that_now_goes_through_a_link_is_not_reused() {   // Codex final review of a34fafd, N5a
        let dir = scratch();
        let made = std::process::Command::new("fsutil").args(["file", "setCaseSensitiveInfo"]).arg(&dir).arg("enable").output().unwrap();
        assert!(made.status.success(), "fsutil could not make a case-sensitive folder: {}", String::from_utf8_lossy(&made.stdout));
        let file = dir.join("sub").join("a.txt");
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(&file, "a").unwrap();
        junction(&dir.join("SUB"), &dir.join("sub"));
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 2, "fsutil could not make a case-sensitive folder");
        let grants = Grants::new(dir.join("open-files.json"));
        let through_link = grants.add(&dir.join("SUB").join("a.txt"), "t").unwrap();
        let picked = grants.add(&file, "t").unwrap();
        assert_ne!(picked.id, through_link.id);
        assert_eq!(picked.path, crate::folders::plain(&file));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_resent_request_is_queued_once_and_drained_once() {
        let q = OpenQueue::default();
        assert!(q.push(Some("r1"), [PathBuf::from(r"C:\a.md"), PathBuf::from(r"C:\b.md")]));
        assert!(!q.push(Some("r1"), [PathBuf::from(r"C:\a.md")]), "the same id again");
        assert!(q.push(None, [PathBuf::from(r"C:\a.md")]), "a launch argument has no id; the path is already queued");
        assert_eq!(q.drain(), vec![PathBuf::from(r"C:\a.md"), PathBuf::from(r"C:\b.md")]);
        assert!(q.drain().is_empty());
    }

    #[test]
    fn launch_paths_are_absolute_existing_files() {
        let dir = scratch();
        std::fs::write(dir.join("page.md"), "x").unwrap();
        std::fs::create_dir_all(dir.join("folder")).unwrap();
        let args = ["--flag", "page.md", "missing.md", "folder"].map(std::ffi::OsString::from);
        let got = launch_paths(args, &dir);
        assert_eq!(got.len(), 1);
        assert!(got[0].is_absolute() && got[0].ends_with("page.md"));
        assert!(!got[0].to_string_lossy().starts_with(r"\\?\"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn grants_are_stable_newest_first_capped_and_forgettable() {
        let dir = scratch();
        let grants = Grants::new(dir.join("open-files.json"));
        // Slashes do not matter; letter case does, since canonical paths carry the case on disk (W1).
        assert_eq!(grant_id(Path::new(r"C:\Notes\A.md")), grant_id(Path::new(r"C:/Notes/A.md")));
        assert_ne!(grant_id(Path::new(r"C:\Notes\A.md")), grant_id(Path::new(r"C:\Notes\a.md")));
        let a = grants.add(Path::new(r"C:\Notes\A.md"), "1").unwrap();
        grants.add(Path::new(r"C:\Notes\B.md"), "2").unwrap();
        grants.add(Path::new(r"C:\Notes\A.md"), "3").unwrap();
        let list = grants.list();
        assert_eq!(list.iter().map(|g| g.path.as_str()).collect::<Vec<_>>(), [r"C:\Notes\A.md", r"C:\Notes\B.md"]);
        assert_eq!(list[0].opened, "3");
        assert_eq!(grants.get(&a.id).unwrap().path, r"C:\Notes\A.md");
        grants.forget(&a.id).unwrap();
        assert!(grants.get(&a.id).is_none());
        for i in 0..(MAX_GRANTS + 5) {
            grants.add(&PathBuf::from(format!(r"C:\many\{i}.txt")), "t").unwrap();
        }
        assert_eq!(grants.list().len(), MAX_GRANTS);
        std::fs::remove_dir_all(&dir).ok();
    }
}
