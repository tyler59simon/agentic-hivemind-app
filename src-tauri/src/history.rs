//! Versions of the user's files (NS-5). Every save of a page or opened file leaves a snapshot in Hivemind's app data, so
//! an earlier version can be read, compared and restored. A file's history is keyed by its absolute path (normalised as
//! `folders::normal` does, so it is the same history whether the file is opened as a page or from disk; in a case-sensitive
//! folder the file's own name keeps its case, so `A.md` and `a.md` there have a history each):
//! `history/<first 16 hex of sha256(path)>/index.json` lists the versions, and `objects/<sha256>.gz` holds each distinct
//! content once. The index can be rebuilt from the objects, and the whole folder can be deleted without losing a file.
use crate::files::{self, atomic};
use crate::{blocking, AppState};
use flate2::{read::GzDecoder, write::GzEncoder, Compression};
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::State;

/// Files above this are not snapshotted; the timeline says so.
pub const MAX_SNAPSHOT: u64 = 16 * 1024 * 1024;
/// Versions kept per file. A version is dropped only when it is older than `KEEP_DAYS` as well, and never when pinned.
pub const KEEP_VERSIONS: usize = 100;
pub const KEEP_DAYS: i64 = 90;
const DAY_MS: i64 = 86_400_000;

/// What saved a version. `disk` is a version found on disk that Hivemind did not write (the file as it was before its
/// first save here, or after an outside edit); `recovered` is one rebuilt from the objects folder.
pub const SOURCES: &[&str] = &["you", "links", "restore", "replace", "ai", "agent", "capture"];

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: u64,
    /// Milliseconds since the Unix epoch.
    pub time: i64,
    pub sha256: String,
    pub size: u64,
    pub source: String,
    #[serde(default)]
    pub pinned: bool,
}

#[derive(Serialize, Deserialize, Default)]
struct Index {
    version: u32,
    /// The file's path when the index was last written, for a person reading the folder.
    #[serde(default)]
    path: String,
    /// Oldest first.
    entries: Vec<Entry>,
}

/// One lock for every history folder: saves are user-paced and the work is small.
fn lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: Mutex<()> = Mutex::new(());
    LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Whether `dir` is a case-sensitive folder (a Windows folder set with `fsutil file setCaseSensitiveInfo`, where `A.md` and
/// `a.md` are two files). False for a folder that cannot be asked.
#[cfg(windows)]
fn case_sensitive(dir: &Path) -> bool {
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{FileCaseSensitiveInfo, GetFileInformationByHandleEx, FILE_CASE_SENSITIVE_INFO, FILE_FLAG_BACKUP_SEMANTICS};
    /// `FILE_CS_FLAG_CASE_SENSITIVE_DIR`.
    const SENSITIVE: u32 = 1;
    let Ok(handle) = std::fs::OpenOptions::new().read(true).custom_flags(FILE_FLAG_BACKUP_SEMANTICS).open(dir) else { return false };
    let mut info = FILE_CASE_SENSITIVE_INFO::default();
    // SAFETY: the handle is open for the call, and the buffer is a FILE_CASE_SENSITIVE_INFO of the size given.
    let asked = unsafe { GetFileInformationByHandleEx(handle.as_raw_handle(), FileCaseSensitiveInfo, (&raw mut info).cast(), size_of::<FILE_CASE_SENSITIVE_INFO>() as u32) };
    asked != 0 && info.Flags & SENSITIVE != 0
}

/// Paths are compared exactly on other systems already.
#[cfg(not(windows))]
fn case_sensitive(_dir: &Path) -> bool {
    false
}

/// The folder name of a file's history. A file whose folder is case-sensitive keeps the case of its own name, so `A.md` and
/// `a.md` there have a history each (the rest of the path is folded as before, so it is still one history however the folder
/// is spelled). `sensitive` says whether the folder is: a path that no longer exists cannot be asked.
fn key_in(path: &Path, sensitive: bool) -> String {
    let plain = crate::folders::plain(path);
    let text = match path.file_name().filter(|_| sensitive).zip(path.parent()) {
        Some((name, dir)) => format!("{}/{}", crate::folders::normal(&crate::folders::plain(dir)), name.to_string_lossy()),
        None => crate::folders::normal(&plain),
    };
    files::sha256(text.as_bytes())[..16].to_string()
}

fn key(path: &Path) -> String {
    key_in(path, path.parent().is_some_and(case_sensitive))
}

fn folder(root: &Path, path: &Path) -> PathBuf {
    root.join(key(path))
}

fn object(dir: &Path, sha: &str) -> PathBuf {
    dir.join("objects").join(format!("{sha}.gz"))
}

fn is_sha(name: &str) -> bool {
    name.len() == 64 && name.bytes().all(|b| b.is_ascii_hexdigit())
}

fn gzip(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(bytes).and_then(|_| encoder.finish()).map_err(|e| format!("Could not compress a version: {e}"))
}

fn gunzip(packed: &[u8]) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    // One byte over the limit tells a bomb from a big file.
    GzDecoder::new(packed).take(MAX_SNAPSHOT + 1).read_to_end(&mut bytes).map_err(|e| format!("A stored version is damaged: {e}"))?;
    if bytes.len() as u64 > MAX_SNAPSHOT {
        return Err("A stored version is damaged: it is larger than 16 MB".into());
    }
    Ok(bytes)
}

/// The content of the object `sha`, checked against its name.
fn read_object(dir: &Path, sha: &str) -> Result<Vec<u8>, String> {
    let packed = std::fs::read(object(dir, sha)).map_err(|e| format!("That version is no longer stored: {e}"))?;
    let bytes = gunzip(&packed)?;
    if files::sha256(&bytes) != sha {
        return Err("A stored version is damaged: its content does not match its name".into());
    }
    Ok(bytes)
}

/// Store `bytes` as the object `sha` unless it is there already.
fn put_object(dir: &Path, sha: &str, bytes: &[u8]) -> Result<(), String> {
    let at = object(dir, sha);
    if at.is_file() {
        return Ok(());
    }
    std::fs::create_dir_all(dir.join("objects")).map_err(|e| format!("Could not store a version: {e}"))?;
    atomic::replace(&at, &gzip(bytes)?)
}

/// Rebuild an index from the objects folder: one entry per readable object, its time the object's modified time. Pins
/// and sources are not recorded in an object, so they are lost.
fn rebuild(dir: &Path) -> Index {
    let mut found: Vec<(i64, String, u64)> = Vec::new();
    for entry in std::fs::read_dir(dir.join("objects")).into_iter().flatten().flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(sha) = name.strip_suffix(".gz").filter(|s| is_sha(s)) else { continue };
        let Ok(bytes) = read_object(dir, sha) else { continue };
        let time = entry.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64).unwrap_or(0);
        found.push((time, sha.to_string(), bytes.len() as u64));
    }
    found.sort();
    let entries = found.into_iter().enumerate().map(|(i, (time, sha256, size))| Entry { id: i as u64 + 1, time, sha256, size, source: "recovered".into(), pinned: false }).collect();
    Index { version: 1, path: String::new(), entries }
}

/// The index of a history folder, and whether it had to be rebuilt (it was damaged, or missing next to objects).
fn load(dir: &Path) -> (Index, bool) {
    match std::fs::read(dir.join("index.json")) {
        Ok(bytes) => match serde_json::from_slice::<Index>(&bytes) {
            Ok(index) => (index, false),
            Err(_) => (rebuild(dir), true),
        },
        Err(_) => {
            let index = rebuild(dir);
            let rebuilt = !index.entries.is_empty();
            (index, rebuilt)
        }
    }
}

fn store(dir: &Path, index: &Index) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("Could not keep a version: {e}"))?;
    let text = serde_json::to_vec_pretty(index).map_err(|e| e.to_string())?;
    atomic::replace(&dir.join("index.json"), &text)
}

/// Drop what retention no longer keeps: a version goes only when it is not pinned, is not among the newest
/// `KEEP_VERSIONS` and is older than `KEEP_DAYS` (so whichever rule keeps more wins).
fn prune(entries: &mut Vec<Entry>, now: i64) {
    let total = entries.len();
    let cutoff = now - KEEP_DAYS * DAY_MS;
    let mut at = 0;
    entries.retain(|e| {
        let newest_rank = total - 1 - at;
        at += 1;
        e.pinned || newest_rank < KEEP_VERSIONS || e.time >= cutoff
    });
}

/// Delete the objects no entry names.
fn sweep(dir: &Path, index: &Index) {
    for entry in std::fs::read_dir(dir.join("objects")).into_iter().flatten().flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let wanted = name.strip_suffix(".gz").is_some_and(|sha| index.entries.iter().any(|e| e.sha256 == sha));
        if !wanted {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// Keep `bytes` as a version of `path` made by `source`. Nothing is added when the file's newest version is the same
/// content (a save that changed nothing), or when the content is over 16 MB. Identical content in two versions is stored
/// once. Retention is applied on every write.
pub fn snapshot(root: &Path, path: &Path, bytes: &[u8], source: &str, now: i64) -> Result<Option<Entry>, String> {
    if bytes.len() as u64 > MAX_SNAPSHOT {
        return Ok(None);
    }
    let _held = lock();
    let dir = folder(root, path);
    let (mut index, _) = load(&dir);
    let sha = files::sha256(bytes);
    if index.entries.last().is_some_and(|e| e.sha256 == sha) {
        return Ok(None);
    }
    put_object(&dir, &sha, bytes)?;
    let entry = Entry { id: index.entries.iter().map(|e| e.id).max().unwrap_or(0) + 1, time: now, sha256: sha, size: bytes.len() as u64, source: source.to_string(), pinned: false };
    index.version = 1;
    index.path = crate::folders::plain(path);
    index.entries.push(entry.clone());
    prune(&mut index.entries, now);
    store(&dir, &index)?;
    sweep(&dir, &index);
    Ok(Some(entry))
}

/// Keep the file as it is on disk now as a version. With `expect`, only when it still holds those bytes (the ones a save
/// is about to replace; a file that changed makes the save stale, and nothing is written). A file over 16 MB, or one
/// that is not there, adds nothing.
pub fn snapshot_file(root: &Path, path: &Path, expect: Option<&str>, source: &str, now: i64) -> Result<Option<Entry>, String> {
    let Ok(meta) = std::fs::metadata(path) else { return Ok(None) };
    if !meta.is_file() || meta.len() > MAX_SNAPSHOT {
        return Ok(None);
    }
    let Ok(bytes) = std::fs::read(path) else { return Ok(None) };
    if expect.is_some_and(|sha| files::sha256(&bytes) != sha) {
        return Ok(None);
    }
    snapshot(root, path, &bytes, source, now)
}

/// Whether the file has any version kept.
pub fn has_history(root: &Path, path: &Path) -> bool {
    let _held = lock();
    !load(&folder(root, path)).0.entries.is_empty()
}

/// The versions of a file, newest first. A damaged index is rebuilt and written back.
pub fn list(root: &Path, path: &Path) -> Vec<Entry> {
    let _held = lock();
    let dir = folder(root, path);
    let (index, rebuilt) = load(&dir);
    if rebuilt {
        let _ = store(&dir, &index);
    }
    let mut entries = index.entries;
    entries.reverse();
    entries
}

/// The bytes of one version.
pub fn read(root: &Path, path: &Path, id: u64) -> Result<Vec<u8>, String> {
    let _held = lock();
    let dir = folder(root, path);
    let (index, _) = load(&dir);
    let entry = index.entries.iter().find(|e| e.id == id).ok_or("That version is no longer kept")?;
    read_object(&dir, &entry.sha256)
}

/// Keep a version past retention, or let retention take it again.
pub fn pin(root: &Path, path: &Path, id: u64, pinned: bool) -> Result<(), String> {
    let _held = lock();
    let dir = folder(root, path);
    let (mut index, _) = load(&dir);
    index.entries.iter_mut().find(|e| e.id == id).ok_or("That version is no longer kept")?.pinned = pinned;
    store(&dir, &index)
}

/// Whether the file is too large to snapshot (the timeline says so).
pub fn too_large(path: &Path) -> bool {
    std::fs::metadata(path).is_ok_and(|m| m.len() > MAX_SNAPSHOT)
}

/// The history of `from` becomes part of the history of `to`: the old versions come first, so the page's history is
/// continuous across a rename or move. Nothing happens when the two keys are the same (a change of letter case only, on
/// Windows) or `from` has no history.
///
/// `old_sensitive`: whether the folder `from` was in is case-sensitive, which it can no longer be asked once it has moved.
fn carry(root: &Path, from: &Path, to: &Path, old_sensitive: bool) -> Result<(), String> {
    let (old, new) = (root.join(key_in(from, old_sensitive)), folder(root, to));
    if old == new || !old.is_dir() {
        return Ok(());
    }
    let (before, rebuilt) = load(&old);
    if rebuilt {
        store(&old, &before)?;
    }
    let (mut index, _) = load(&new);
    let mut merged: Vec<Entry> = Vec::new();
    for entry in before.entries {
        put_object(&new, &entry.sha256, &read_object(&old, &entry.sha256)?)?;
        merged.push(entry);
    }
    merged.extend(index.entries);
    merged.sort_by_key(|e| e.time);
    for (i, entry) in merged.iter_mut().enumerate() {
        entry.id = i as u64 + 1;
    }
    index.version = 1;
    index.path = crate::folders::plain(to);
    index.entries = merged;
    store(&new, &index)?;
    std::fs::remove_dir_all(&old).map_err(|e| format!("Could not remove the old history folder: {e}"))
}

/// Folders and files walked at most, for a moved folder.
const MAX_WALK: usize = 200_000;

/// A file (or folder) moved from `from` to `to`: its history, or the history of every file now under the folder, follows.
/// A move that cannot carry some history is reported, but the move itself stands.
pub fn moved(root: &Path, from: &Path, to: &Path, was_dir: bool) -> Result<(), String> {
    let _held = lock();
    if !was_dir {
        return carry(root, from, to, from.parent().is_some_and(case_sensitive));
    }
    let mut failed = Vec::new();
    let mut stack = vec![to.to_path_buf()];
    let mut seen = 0usize;
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
            seen += 1;
            if seen > MAX_WALK {
                return Err("The folder is too large to carry every file's history to its new place".into());
            }
            let Ok(kind) = entry.file_type() else { continue };
            if kind.is_symlink() {
                continue;
            }
            if kind.is_dir() {
                stack.push(entry.path());
            } else if let Ok(rel) = entry.path().strip_prefix(to)
                && let Err(e) = carry(root, &from.join(rel), &entry.path(), entry.path().parent().is_some_and(case_sensitive))
            {
                failed.push(e);
            }
        }
    }
    if failed.is_empty() { Ok(()) } else { Err(failed.join("; ")) }
}

/// How the webview sees a file's history.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    pub entries: Vec<Entry>,
    /// The file is over 16 MB now, so its saves are not kept.
    pub too_large: bool,
}

/// One version's text for the screen: LF line breaks, whatever the file's own.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Version {
    pub text: String,
    pub binary: bool,
    /// Why this version cannot be restored as text, or None.
    pub read_only: Option<String>,
    pub size: u64,
}

fn version_of(bytes: &[u8]) -> Version {
    let (text, _, read_only, binary) = files::decode(bytes);
    Version { text, binary, read_only, size: bytes.len() as u64 }
}

#[tauri::command]
pub async fn history_list(state: State<'_, AppState>, notebook: String, path: String) -> Result<Listing, String> {
    let (full, _) = crate::studio::resolve_file(&state, &notebook, &path, false)?;
    let root = state.history_dir.clone();
    blocking(move || Ok(Listing { entries: list(&root, &full), too_large: too_large(&full) })).await
}

/// A version of the file: `id` is a snapshot's number, or `git:<commit>` for a commit of the file's repository.
#[tauri::command]
pub async fn history_read(state: State<'_, AppState>, notebook: String, path: String, id: String) -> Result<Version, String> {
    let (full, _) = crate::studio::resolve_file(&state, &notebook, &path, false)?;
    let root = state.history_dir.clone();
    blocking(move || {
        if let Some(sha) = id.strip_prefix("git:") {
            let (dir, name) = crate::git::beside(&full)?;
            let text = crate::git::file_version(&dir, &name, sha)?;
            let mut version = version_of(text.as_bytes());
            // Git's output reached Hivemind as text: bytes that were not UTF-8 were replaced, so this is not the version.
            if version.read_only.is_none() && text.contains('\u{FFFD}') {
                version.read_only = Some("This version is not valid UTF-8, so Hivemind cannot restore it exactly".into());
            }
            return Ok(version);
        }
        let id: u64 = id.parse().map_err(|_| "That is not a version of this file".to_string())?;
        Ok(version_of(&read(&root, &full, id)?))
    })
    .await
}

#[tauri::command]
pub async fn history_pin(state: State<'_, AppState>, notebook: String, path: String, id: u64, pinned: bool) -> Result<(), String> {
    let (full, _) = crate::studio::resolve_file(&state, &notebook, &path, false)?;
    let root = state.history_dir.clone();
    blocking(move || pin(&root, &full, id, pinned)).await
}

/// The commits that touched the file, when it is inside a git work tree.
#[tauri::command]
pub async fn git_file_log(state: State<'_, AppState>, notebook: String, path: String) -> Result<crate::git::FileLog, String> {
    let (full, _) = crate::studio::resolve_file(&state, &notebook, &path, false)?;
    blocking(move || {
        let (dir, name) = crate::git::beside(&full)?;
        crate::git::file_log(&dir, &name)
    })
    .await
}

/// Commit this file alone, with `message`; returns the commit's id. Never pushes. A file Hivemind may not write (a
/// protected place) is not committed either.
#[tauri::command]
pub async fn git_file_commit(state: State<'_, AppState>, notebook: String, path: String, message: String) -> Result<String, String> {
    let (full, locked) = crate::studio::resolve_file(&state, &notebook, &path, true)?;
    if let Some(why) = locked {
        return Err(why);
    }
    blocking(move || {
        let (dir, name) = crate::git::beside(&full)?;
        crate::git::file_commit(&dir, &name, &message)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> PathBuf {
        let dir = std::fs::canonicalize(std::env::temp_dir()).unwrap().join(format!("hm-history-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn objects(root: &Path, file: &Path) -> usize {
        std::fs::read_dir(folder(root, file).join("objects")).map(|d| d.count()).unwrap_or(0)
    }

    #[test]
    fn a_version_is_kept_and_read_back_and_identical_content_is_stored_once() {
        let (root, file) = (scratch(), Path::new("C:/notes/Page.md"));
        let first = snapshot(&root, file, b"one\n", "you", 1000).unwrap().unwrap();
        assert_eq!((first.id, first.size, first.source.as_str(), first.pinned), (1, 4, "you", false));
        // Saving what is already the newest version adds nothing.
        assert_eq!(snapshot(&root, file, b"one\n", "you", 2000).unwrap(), None);
        snapshot(&root, file, b"two\n", "ai", 3000).unwrap().unwrap();
        // Back to the first content: a new version, but the same object.
        let third = snapshot(&root, file, b"one\n", "restore", 4000).unwrap().unwrap();
        assert_eq!(third.sha256, first.sha256);
        assert_eq!(list(&root, file).iter().map(|e| e.id).collect::<Vec<_>>(), [3, 2, 1], "newest first");
        assert_eq!(objects(&root, file), 2);
        assert_eq!(read(&root, file, 1).unwrap(), b"one\n");
        assert_eq!(read(&root, file, 2).unwrap(), b"two\n");
        assert!(read(&root, file, 9).is_err());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn the_same_file_has_one_history_however_its_path_is_spelled() {
        let (root, a) = (scratch(), Path::new("C:\\Notes\\Sub\\Page.md"));
        snapshot(&root, a, b"x", "you", 1).unwrap();
        let found = |p: &Path| list(&root, p).len();
        assert_eq!(found(Path::new("C:/Notes/Sub/Page.md")), 1, "slashes do not matter");
        if cfg!(windows) {
            assert_eq!(found(Path::new("c:/notes/sub/page.md")), 1, "case is folded on Windows");
        }
        assert_eq!(found(Path::new("C:/Notes/Other.md")), 0);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn retention_keeps_the_newest_hundred_or_ninety_days_whichever_keeps_more_and_never_a_pin() {
        let (root, file) = (scratch(), Path::new("C:/notes/Old.md"));
        let day = DAY_MS;
        let now = 1000 * day;
        // 150 old versions (a year ago), the 3rd pinned: only the newest 100 and the pin remain after the next write.
        for i in 0..150 {
            snapshot(&root, file, format!("old {i}").as_bytes(), "you", now - 365 * day + i).unwrap();
        }
        pin(&root, file, 3, true).unwrap();
        snapshot(&root, file, b"new", "you", now).unwrap();
        let kept = list(&root, file);
        // 151 written; the newest 100 stay (ids 52 to 151), plus the pin.
        assert_eq!(kept.len(), 101);
        assert!(kept.iter().any(|e| e.id == 3 && e.pinned), "the pinned version stays");
        assert!(!kept.iter().any(|e| e.id == 4), "an old unpinned version beyond 100 goes");
        assert_eq!(kept.iter().filter(|e| e.id >= 52).count(), 100);
        // Its object is gone with the entry, the pinned one is not.
        assert_eq!(objects(&root, file), 101);
        assert_eq!(read(&root, file, 3).unwrap(), b"old 2");
        // Within ninety days nothing is dropped, however many there are.
        let file2 = Path::new("C:/notes/Busy.md");
        for i in 0..130 {
            snapshot(&root, file2, format!("busy {i}").as_bytes(), "you", now - 10 * day + i).unwrap();
        }
        assert_eq!(list(&root, file2).len(), 130);
        // A pin can be taken off, and then retention may drop it.
        pin(&root, file, 3, false).unwrap();
        snapshot(&root, file, b"newer", "you", now + 1).unwrap();
        assert!(!list(&root, file).iter().any(|e| e.id == 3));
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_damaged_or_missing_index_is_rebuilt_from_the_objects() {
        let (root, file) = (scratch(), Path::new("C:/notes/Hurt.md"));
        snapshot(&root, file, b"alpha", "you", 1000).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(30));
        snapshot(&root, file, b"beta", "you", 2000).unwrap();
        let index = folder(&root, file).join("index.json");
        std::fs::write(&index, b"{ not json").unwrap();
        let rebuilt = list(&root, file);
        assert_eq!(rebuilt.len(), 2);
        assert!(rebuilt.iter().all(|e| e.source == "recovered"));
        assert_eq!(read(&root, file, rebuilt[1].id).unwrap(), b"alpha", "oldest object first, by modified time");
        // It was written back, so the next read does not rebuild again.
        assert!(serde_json::from_slice::<Index>(&std::fs::read(&index).unwrap()).is_ok());
        // A missing index next to objects is rebuilt too, and a damaged object is left out.
        std::fs::remove_file(&index).unwrap();
        std::fs::write(folder(&root, file).join("objects").join(format!("{}.gz", "0".repeat(64))), b"junk").unwrap();
        assert_eq!(list(&root, file).len(), 2);
        // A file with no folder at all has no versions, and a later snapshot still works after a rebuild.
        assert!(list(&root, Path::new("C:/notes/Never.md")).is_empty());
        snapshot(&root, file, b"gamma", "you", 3000).unwrap().unwrap();
        assert_eq!(list(&root, file).len(), 3);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_file_over_sixteen_megabytes_is_not_snapshotted() {
        let (root, file) = (scratch(), Path::new("C:/notes/Huge.txt"));
        assert_eq!(snapshot(&root, file, &vec![b'a'; MAX_SNAPSHOT as usize + 1], "you", 1).unwrap(), None);
        assert!(list(&root, file).is_empty());
        assert!(snapshot(&root, file, &vec![b'a'; MAX_SNAPSHOT as usize], "you", 2).unwrap().is_some(), "exactly 16 MB is kept");
        let big = root.join("big.txt");
        std::fs::write(&big, vec![b'a'; MAX_SNAPSHOT as usize + 1]).unwrap();
        assert!(too_large(&big));
        assert_eq!(snapshot_file(&root, &big, None, "you", 3).unwrap(), None);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_snapshot_of_the_file_on_disk_checks_the_bytes_it_expects() {
        let (root, base) = (scratch(), scratch());
        let file = base.join("Page.md");
        std::fs::write(&file, "on disk").unwrap();
        assert_eq!(snapshot_file(&root, &file, Some(&files::sha256(b"something else")), "disk", 1).unwrap(), None);
        assert!(!has_history(&root, &file));
        let kept = snapshot_file(&root, &file, Some(&files::sha256(b"on disk")), "disk", 2).unwrap().unwrap();
        assert_eq!(kept.source, "disk");
        assert!(has_history(&root, &file));
        assert_eq!(snapshot_file(&root, &base.join("missing.md"), None, "disk", 3).unwrap(), None);
        std::fs::remove_dir_all(&root).unwrap();
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn two_files_differing_only_in_case_in_a_case_sensitive_folder_have_a_history_each() {   // NOTES-3
        let (root, base) = (scratch(), scratch());
        let made = std::process::Command::new("fsutil").args(["file", "setCaseSensitiveInfo"]).arg(&base).arg("enable").output().unwrap();
        assert!(made.status.success(), "fsutil could not make a case-sensitive folder: {}", String::from_utf8_lossy(&made.stdout));
        assert!(case_sensitive(&base));
        let (upper, lower) = (base.join("Draft.md"), base.join("draft.md"));
        std::fs::write(&upper, "upper").unwrap();
        std::fs::write(&lower, "lower").unwrap();
        snapshot_file(&root, &upper, None, "you", 1).unwrap().unwrap();
        snapshot_file(&root, &lower, None, "you", 2).unwrap().unwrap();
        assert_eq!(list(&root, &upper).len(), 1);
        assert_eq!(read(&root, &upper, 1).unwrap(), b"upper");
        assert_eq!(list(&root, &lower).len(), 1);
        assert_eq!(read(&root, &lower, 1).unwrap(), b"lower");
        // A rename that changes only the case is a rename of one of the two: its history follows it.
        std::fs::remove_file(&lower).unwrap();
        std::fs::rename(&upper, base.join("DRAFT.md")).unwrap();
        moved(&root, &upper, &base.join("DRAFT.md"), false).unwrap();
        assert_eq!(read(&root, &base.join("DRAFT.md"), 1).unwrap(), b"upper");
        assert!(list(&root, &upper).is_empty());
        // The folder is not special for a folder that is not case-sensitive: one history however the name is spelled.
        let plain_dir = scratch();
        assert!(!case_sensitive(&plain_dir));
        std::fs::write(plain_dir.join("Page.md"), "x").unwrap();
        snapshot_file(&root, &plain_dir.join("Page.md"), None, "you", 3).unwrap().unwrap();
        assert_eq!(list(&root, &plain_dir.join("PAGE.md")).len(), 1);
        for dir in [root, base, plain_dir] {
            std::fs::remove_dir_all(dir).unwrap();
        }
    }

    #[test]
    fn a_renamed_file_carries_its_history_and_a_case_only_rename_keeps_it() {
        let (root, base) = (scratch(), scratch());
        let (old, new) = (base.join("Old.md"), base.join("sub").join("New.md"));
        snapshot(&root, &old, b"v1", "you", 1000).unwrap();
        snapshot(&root, &old, b"v2", "you", 2000).unwrap();
        pin(&root, &old, 1, true).unwrap();
        std::fs::create_dir_all(new.parent().unwrap()).unwrap();
        // The page already had a version under its new name (a file once moved there).
        snapshot(&root, &new, b"v3", "you", 3000).unwrap();
        moved(&root, &old, &new, false).unwrap();
        let versions = list(&root, &new);
        assert_eq!(versions.iter().map(|e| e.time).collect::<Vec<_>>(), [3000, 2000, 1000], "the old key's entries come first");
        assert!(versions.iter().find(|e| e.time == 1000).unwrap().pinned, "a pin goes with the version");
        assert_eq!(read(&root, &new, versions[2].id).unwrap(), b"v1");
        assert!(list(&root, &old).is_empty() && !folder(&root, &old).exists(), "the old folder is gone");
        // A case-only rename is the same key on Windows: nothing moves and nothing is lost.
        let lower = base.join("sub").join("new.md");
        moved(&root, &new, &lower, false).unwrap();
        if cfg!(windows) {
            assert_eq!(list(&root, &lower).len(), 3);
        }
        std::fs::remove_dir_all(&root).unwrap();
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn a_renamed_folder_carries_the_history_of_every_file_in_it() {
        let (root, base) = (scratch(), scratch());
        let (from, to) = (base.join("Area"), base.join("Archive").join("Area"));
        std::fs::create_dir_all(from.join("deep")).unwrap();
        for (name, text) in [("A.md", "a"), ("deep/B.md", "b"), ("deep/NoHistory.md", "c")] {
            std::fs::write(from.join(name), text).unwrap();
        }
        snapshot(&root, &from.join("A.md"), b"a1", "you", 1).unwrap();
        snapshot(&root, &from.join("deep").join("B.md"), b"b1", "you", 2).unwrap();
        std::fs::create_dir_all(to.parent().unwrap()).unwrap();
        std::fs::rename(&from, &to).unwrap();
        moved(&root, &from, &to, true).unwrap();
        assert_eq!(list(&root, &to.join("A.md")).len(), 1);
        assert_eq!(read(&root, &to.join("deep").join("B.md"), 1).unwrap(), b"b1");
        assert!(list(&root, &from.join("A.md")).is_empty());
        assert!(list(&root, &to.join("deep").join("NoHistory.md")).is_empty());
        std::fs::remove_dir_all(&root).unwrap();
        std::fs::remove_dir_all(&base).unwrap();
    }
}
