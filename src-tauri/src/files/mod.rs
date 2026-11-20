//! Reading and saving the user's own files (notebook pages). Every save is atomic and refuses to overwrite a file
//! that changed since it was read. The webview only ever sees LF text; the file's BOM and line endings are kept in
//! `FileFormat` and written back on save.
pub mod atomic;
pub mod contain;
pub mod guard;
pub mod watch;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::UNIX_EPOCH;

/// Files above this open in the large-file viewer (NS-6B), never in an editor.
pub const MAX_READ: u64 = 64 * 1024 * 1024;
/// A NUL byte this early means the file is binary.
const SNIFF: usize = 8000;
const BOM: &[u8] = b"\xEF\xBB\xBF";

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Eol {
    Lf,
    Crlf,
    /// More than one style, or lone CRs: shown read-only until NS-6A lets the user choose one.
    Mixed,
    /// No line break at all.
    None,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct FileFormat {
    /// An encoding_rs name. Only "UTF-8" is written in NS-1A.
    pub encoding: String,
    pub bom: bool,
    pub eol: Eol,
}

/// What the webview gets for an open file.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Loaded {
    /// LF line endings, no BOM. Empty for a binary file.
    pub text: String,
    #[serde(flatten)]
    pub stamp: Stamp,
    pub format: FileFormat,
    /// Why the file cannot be edited; None when it can.
    pub read_only: Option<String>,
    pub binary: bool,
}

/// The identity of a file's bytes, used as a save precondition.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Stamp {
    pub sha256: String,
    pub size: u64,
    pub mtime_ms: i64,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum SaveOutcome {
    Saved(Stamp),
    /// The file changed since it was read; `sha256` is what is there now.
    Stale { sha256: String },
    /// The file was deleted or moved since it was read.
    Gone,
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn sha256(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

fn mtime_ms(meta: &std::fs::Metadata) -> i64 {
    meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn stamp(bytes: &[u8], path: &Path) -> Stamp {
    let mtime = std::fs::metadata(path).map(|m| mtime_ms(&m)).unwrap_or(0);
    Stamp { sha256: sha256(bytes), size: bytes.len() as u64, mtime_ms: mtime }
}

/// The line-ending style of `text`.
pub fn detect_eol(text: &str) -> Eol {
    let bytes = text.as_bytes();
    let (mut lf, mut crlf, mut cr) = (0usize, 0usize, 0usize);
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'\r' if bytes.get(i + 1) == Some(&b'\n') => {
                crlf += 1;
                i += 1;
            }
            b'\r' => cr += 1,
            b'\n' => lf += 1,
            _ => {}
        }
        i += 1;
    }
    match (lf, crlf, cr) {
        (0, 0, 0) => Eol::None,
        (_, 0, 0) => Eol::Lf,
        (0, _, 0) => Eol::Crlf,
        _ => Eol::Mixed,
    }
}

/// Decode a file's bytes for the editor.
pub fn decode(bytes: &[u8]) -> (String, FileFormat, Option<String>, bool) {
    let utf8 = FileFormat { encoding: "UTF-8".into(), bom: false, eol: Eol::None };
    if bytes.iter().take(SNIFF).any(|b| *b == 0) {
        return (String::new(), utf8, Some("This is not a text file".into()), true);
    }
    let (bom, body) = match bytes.strip_prefix(BOM) {
        Some(rest) => (true, rest),
        None => (false, bytes),
    };
    let (text, read_only) = match std::str::from_utf8(body) {
        Ok(text) => (text.to_string(), None),
        Err(_) => (String::from_utf8_lossy(body).into_owned(), Some("This file is not UTF-8. Other encodings arrive in a later version".to_string())),
    };
    let eol = detect_eol(&text);
    let read_only = read_only.or_else(|| (eol == Eol::Mixed).then(|| "This file mixes line-ending styles".to_string()));
    let text = if eol == Eol::Lf || eol == Eol::None { text } else { text.replace("\r\n", "\n").replace('\r', "\n") };
    (text, FileFormat { encoding: "UTF-8".into(), bom, eol }, read_only, false)
}

/// The bytes to write for editor text in `format`.
pub fn encode(text: &str, format: &FileFormat) -> Result<Vec<u8>, String> {
    if !format.encoding.eq_ignore_ascii_case("UTF-8") {
        return Err(format!("Saving in {} is not supported yet", format.encoding));
    }
    if format.eol == Eol::Mixed {
        return Err("This file mixes line-ending styles, so Hivemind does not save it".into());
    }
    let text = text.replace("\r\n", "\n");
    let text = if format.eol == Eol::Crlf { text.replace('\n', "\r\n") } else { text };
    let mut bytes = Vec::with_capacity(text.len() + 3);
    if format.bom {
        bytes.extend_from_slice(BOM);
    }
    bytes.extend_from_slice(text.as_bytes());
    Ok(bytes)
}

/// Read a file for the editor.
pub fn read(path: &Path) -> Result<Loaded, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("Could not open {}: {e}", path.display()))?;
    if meta.is_dir() {
        return Err(format!("{} is a folder", path.display()));
    }
    if meta.len() > MAX_READ {
        return Err(format!("{} is larger than 64 MB, too large to edit", path.display()));
    }
    let bytes = std::fs::read(path).map_err(|e| format!("Could not read {}: {e}", path.display()))?;
    let (text, format, mut read_only, binary) = decode(&bytes);
    if read_only.is_none() && meta.permissions().readonly() {
        read_only = Some("This file is read-only on disk".into());
    }
    Ok(Loaded { text, stamp: Stamp { sha256: sha256(&bytes), size: bytes.len() as u64, mtime_ms: mtime_ms(&meta) }, format, read_only, binary })
}

/// One lock per file, so two saves of the same path never interleave between the hash check and the rename.
fn lock_for(path: &Path) -> Arc<Mutex<()>> {
    static LOCKS: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
    let key = path.to_string_lossy().to_lowercase();
    let mut locks = LOCKS.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner());
    if locks.len() > 512 {
        locks.retain(|_, lock| Arc::strong_count(lock) > 1);
    }
    locks.entry(key).or_default().clone()
}

/// The hashes Hivemind wrote most recently, so the watcher can drop the echo of its own saves.
fn written() -> &'static Mutex<VecDeque<(String, String)>> {
    static WRITTEN: OnceLock<Mutex<VecDeque<(String, String)>>> = OnceLock::new();
    WRITTEN.get_or_init(Default::default)
}

fn remember_written(path: &Path, sha: &str) {
    let mut list = written().lock().unwrap_or_else(|e| e.into_inner());
    let key = path.to_string_lossy().to_lowercase();
    list.retain(|(p, _)| *p != key);
    list.push_back((key, sha.to_string()));
    while list.len() > 256 {
        list.pop_front();
    }
}

/// True when `path` now holds exactly what Hivemind last wrote there.
pub fn is_own_write(path: &Path) -> bool {
    let key = path.to_string_lossy().to_lowercase();
    let Some(expected) = written().lock().unwrap_or_else(|e| e.into_inner()).iter().rev().find(|(p, _)| *p == key).map(|(_, s)| s.clone()) else {
        return false;
    };
    std::fs::read(path).map(|bytes| sha256(&bytes) == expected).unwrap_or(false)
}

/// Save editor text over a file that still holds the bytes the editor loaded.
pub fn save(path: &Path, text: &str, pre: &Stamp, format: &FileFormat) -> Result<SaveOutcome, String> {
    let bytes = encode(text, format)?;
    let lock = lock_for(path);
    let _held = lock.lock().unwrap_or_else(|e| e.into_inner());
    // Held from the check to the replace: no other program can write, rename or delete it in between.
    let mut held = match atomic::hold(path) {
        Ok(held) => held,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(SaveOutcome::Gone),
        Err(e) if atomic::in_use(&e) => return Err(format!("{} is in use by another program; try again", path.display())),
        Err(e) => return Err(format!("Could not read {}: {e}", path.display())),
    };
    let mut current = Vec::new();
    std::io::Read::read_to_end(&mut held.file, &mut current).map_err(|e| format!("Could not read {}: {e}", path.display()))?;
    let sha = sha256(&current);
    if sha != pre.sha256 {
        return Ok(SaveOutcome::Stale { sha256: sha });
    }
    if held.file.metadata().map(|m| m.permissions().readonly()).unwrap_or(false) {
        return Err(format!("{} is read-only on disk", path.display()));
    }
    held.replace(&bytes)?;
    let done = stamp(&bytes, path);
    remember_written(path, &done.sha256);
    Ok(SaveOutcome::Saved(done))
}

/// Create a new file; refuses when anything is already there. Missing parent folders are created.
pub fn create(path: &Path, text: &str) -> Result<Stamp, String> {
    let lock = lock_for(path);
    let _held = lock.lock().unwrap_or_else(|e| e.into_inner());
    if std::fs::symlink_metadata(path).is_ok() {
        return Err(format!("{} already exists", path.display()));
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Could not create {}: {e}", parent.display()))?;
    }
    let bytes = text.as_bytes();
    let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(path).map_err(|e| format!("Could not create {}: {e}", path.display()))?;
    std::io::Write::write_all(&mut file, bytes).map_err(|e| format!("Could not write {}: {e}", path.display()))?;
    file.sync_all().map_err(|e| format!("Could not write {}: {e}", path.display()))?;
    drop(file);
    let done = stamp(bytes, path);
    remember_written(path, &done.sha256);
    Ok(done)
}

/// Rename or move a file or folder. Refuses when the target exists, except a change of letter case only, which
/// goes through a temporary name.
pub fn rename(from: &Path, to: &Path) -> Result<(), String> {
    if std::fs::symlink_metadata(from).is_err() {
        return Err(format!("{} no longer exists", from.display()));
    }
    let same_but_case = from.to_string_lossy().to_lowercase() == to.to_string_lossy().to_lowercase();
    if same_but_case {
        if from == to {
            return Ok(());
        }
        let step = from.with_file_name(format!(".{}.hm-rename-{}", from.file_name().unwrap_or_default().to_string_lossy(), uuid::Uuid::new_v4().simple()));
        std::fs::rename(from, &step).map_err(|e| format!("Could not rename {}: {e}", from.display()))?;
        return std::fs::rename(&step, to).map_err(|e| {
            let _ = std::fs::rename(&step, from);
            format!("Could not rename {}: {e}", from.display())
        });
    }
    if std::fs::symlink_metadata(to).is_ok() {
        return Err(format!("{} already exists", to.display()));
    }
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Could not create {}: {e}", parent.display()))?;
    }
    std::fs::rename(from, to).map_err(|e| format!("Could not move {}: {e}", from.display()))
}

/// Move `rel` (a file or folder of the notebook at `root`) to `.hivemind/trash/<stamp>/<rel>`; returns the trash path.
pub fn trash(root: &Path, rel: &str, now: &str) -> Result<PathBuf, String> {
    let from = contain::resolve_inside(root, rel, false)?;
    // Resolved as a write, so a `.hivemind` link cannot carry the file out of the notebook.
    let to = contain::resolve_inside(root, &format!(".hivemind/trash/{now}/{rel}"), true)?;
    let mut target = to.clone();
    let mut n = 1;
    while std::fs::symlink_metadata(&target).is_ok() {
        n += 1;
        target = to.with_file_name(format!("{} ({n})", to.file_name().unwrap_or_default().to_string_lossy()));
    }
    rename(&from, &target)?;
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hm-files-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn line_endings_are_detected() {
        assert_eq!(detect_eol("a\nb\n"), Eol::Lf);
        assert_eq!(detect_eol("a\r\nb\r\n"), Eol::Crlf);
        assert_eq!(detect_eol("a\r\nb\n"), Eol::Mixed);
        assert_eq!(detect_eol("a\rb"), Eol::Mixed);
        assert_eq!(detect_eol("one line"), Eol::None);
    }

    #[test]
    fn crlf_and_bom_survive_a_round_trip() {
        let original = b"\xEF\xBB\xBF# Title\r\n\r\nBody line\r\nlast".to_vec();
        let (text, format, read_only, binary) = decode(&original);
        assert_eq!(text, "# Title\n\nBody line\nlast");
        assert!(format.bom && format.eol == Eol::Crlf && read_only.is_none() && !binary);
        assert_eq!(encode(&text, &format).unwrap(), original);
        let edited = encode(&text.replace("Body", "New body"), &format).unwrap();
        assert_eq!(edited, b"\xEF\xBB\xBF# Title\r\n\r\nNew body line\r\nlast".to_vec());
    }

    #[test]
    fn binary_non_utf8_and_mixed_files_are_read_only() {
        assert!(decode(b"PK\x03\x04\x00\x00").3);
        assert!(decode(b"caf\xe9").2.unwrap().contains("not UTF-8"));
        let (_, format, read_only, _) = decode(b"a\r\nb\n");
        assert!(read_only.unwrap().contains("line-ending"));
        assert!(encode("a\nb", &format).is_err());
    }

    #[test]
    fn a_text_with_no_line_break_gains_lf_breaks() {
        let format = FileFormat { encoding: "UTF-8".into(), bom: false, eol: Eol::None };
        assert_eq!(encode("a\nb", &format).unwrap(), b"a\nb");
    }

    #[test]
    fn save_refuses_a_stale_or_deleted_file() {
        let dir = scratch();
        let page = dir.join("Page.md");
        std::fs::write(&page, "one\n").unwrap();
        let loaded = read(&page).unwrap();
        assert_eq!(save(&page, "two\n", &loaded.stamp, &loaded.format).unwrap(), SaveOutcome::Saved(read(&page).unwrap().stamp));
        assert_eq!(std::fs::read_to_string(&page).unwrap(), "two\n");
        // The first stamp is now stale.
        match save(&page, "three\n", &loaded.stamp, &loaded.format).unwrap() {
            SaveOutcome::Stale { sha256: now } => assert_eq!(now, sha256(b"two\n")),
            other => panic!("{other:?}"),
        }
        assert_eq!(std::fs::read_to_string(&page).unwrap(), "two\n");
        std::fs::remove_file(&page).unwrap();
        assert_eq!(save(&page, "four\n", &loaded.stamp, &loaded.format).unwrap(), SaveOutcome::Gone);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn a_save_while_another_program_writes_the_file_fails_and_keeps_its_bytes() {
        let dir = scratch();
        let page = dir.join("Busy.md");
        std::fs::write(&page, "one\n").unwrap();
        let loaded = read(&page).unwrap();
        let writer = std::fs::OpenOptions::new().append(true).open(&page).unwrap();
        assert!(save(&page, "two\n", &loaded.stamp, &loaded.format).unwrap_err().contains("in use"));
        drop(writer);
        assert_eq!(std::fs::read_to_string(&page).unwrap(), "one\n");
        assert!(matches!(save(&page, "two\n", &loaded.stamp, &loaded.format).unwrap(), SaveOutcome::Saved(_)));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_reader_does_not_block_a_save() {
        let dir = scratch();
        let page = dir.join("Read.md");
        std::fs::write(&page, "one\n").unwrap();
        let loaded = read(&page).unwrap();
        let reader = std::fs::File::open(&page).unwrap();
        assert!(matches!(save(&page, "two\n", &loaded.stamp, &loaded.format).unwrap(), SaveOutcome::Saved(_)));
        drop(reader);
        assert_eq!(std::fs::read_to_string(&page).unwrap(), "two\n");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn own_writes_are_recognised_until_someone_else_writes() {
        let dir = scratch();
        let page = dir.join("Echo.md");
        create(&page, "mine").unwrap();
        assert!(is_own_write(&page));
        std::fs::write(&page, "theirs").unwrap();
        assert!(!is_own_write(&page));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn create_refuses_an_existing_file_and_makes_parents() {
        let dir = scratch();
        create(&dir.join("A/B/New.md"), "x").unwrap();
        assert!(create(&dir.join("A/B/New.md"), "y").unwrap_err().contains("already exists"));
        assert_eq!(std::fs::read_to_string(dir.join("A/B/New.md")).unwrap(), "x");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn rename_handles_case_only_changes_and_refuses_targets() {
        let dir = scratch();
        std::fs::write(dir.join("page.md"), "p").unwrap();
        std::fs::write(dir.join("other.md"), "o").unwrap();
        rename(&dir.join("page.md"), &dir.join("Page.md")).unwrap();
        let names: Vec<String> = std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        assert!(names.contains(&"Page.md".to_string()), "{names:?}");
        assert!(rename(&dir.join("Page.md"), &dir.join("other.md")).unwrap_err().contains("already exists"));
        rename(&dir.join("Page.md"), &dir.join("Sub/Page.md")).unwrap();
        assert!(dir.join("Sub/Page.md").is_file());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn trash_keeps_the_relative_path() {
        let dir = scratch();
        std::fs::create_dir_all(dir.join("Projects")).unwrap();
        std::fs::write(dir.join("Projects/Old.md"), "o").unwrap();
        let moved = trash(&dir, "Projects/Old.md", "20261120-120000").unwrap();
        assert_eq!(moved, dir.join(".hivemind/trash/20261120-120000/Projects/Old.md"));
        assert!(moved.is_file() && !dir.join("Projects/Old.md").exists());
        std::fs::write(dir.join("Projects/Old.md"), "again").unwrap();
        let second = trash(&dir, "Projects/Old.md", "20261120-120000").unwrap();
        assert_eq!(second.file_name().unwrap(), "Old.md (2)");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
