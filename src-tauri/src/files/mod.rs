//! Reading and saving the user's own files (notebook pages). Every save is atomic and refuses to overwrite a file
//! that changed since it was read. The webview only ever sees LF text; the file's BOM and line endings are kept in
//! `FileFormat` and written back on save.
pub mod atomic;
pub mod contain;
pub mod encoding;
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

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Eol {
    Lf,
    Crlf,
    /// Lone carriage returns only (classic Mac OS files).
    Cr,
    /// More than one style: shown read-only until NS-6A lets the user choose one.
    Mixed,
    /// No line break at all.
    None,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct FileFormat {
    /// An encoding_rs name: "UTF-8", "UTF-16LE", "UTF-16BE", "windows-1252", ...
    pub encoding: String,
    pub bom: bool,
    pub eol: Eol,
    /// How the encoding was found: a byte order mark, valid bytes, or a guess.
    #[serde(default)]
    pub confidence: encoding::Confidence,
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
    /// Read-only only because of its encoding, so Convert to UTF-8 makes it editable (NS-1B).
    #[serde(default)]
    pub convertible: bool,
    /// Read-only only because it mixes line endings, so choosing one makes it editable (NS-6A).
    #[serde(default)]
    pub choose_eol: bool,
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
        (0, 0, _) => Eol::Cr,
        _ => Eol::Mixed,
    }
}

/// Decode a file's bytes for the editor (NS-1B: any encoding `files::encoding` detects). The text has LF line breaks;
/// the encoding, byte order mark and line-ending style go into the format and are written back on save.
pub fn decode(bytes: &[u8]) -> (String, FileFormat, Option<String>, bool) {
    shape(encoding::decode(bytes))
}

/// The editor's view of a decoded file: LF text, the format to write it back in, and why it may not be edited.
fn shape(d: encoding::Decoded) -> (String, FileFormat, Option<String>, bool) {
    let mut format = FileFormat { encoding: d.encoding.to_string(), bom: d.bom, eol: Eol::None, confidence: d.confidence };
    if d.binary {
        return (String::new(), format, d.read_only, true);
    }
    format.eol = detect_eol(&d.text);
    let read_only = d.read_only.or_else(|| (format.eol == Eol::Mixed).then(|| "This file mixes line-ending styles".to_string()));
    let text = match format.eol {
        Eol::Lf | Eol::None => d.text,
        _ => d.text.replace("\r\n", "\n").replace('\r', "\n"),
    };
    (text, format, read_only, false)
}

/// The bytes to write for editor text in `format`. Characters the encoding cannot hold refuse the save.
pub fn encode(text: &str, format: &FileFormat) -> Result<Vec<u8>, String> {
    if format.eol == Eol::Mixed {
        return Err("This file mixes line-ending styles, so Hivemind does not save it".into());
    }
    let text = text.replace("\r\n", "\n");
    let text = match format.eol {
        Eol::Crlf => text.replace('\n', "\r\n"),
        Eol::Cr => text.replace('\n', "\r"),
        _ => text,
    };
    encoding::encode(&text, &format.encoding, format.bom)
}

// Tests run code here between a check and the act it guards, to show that nothing slips in between.
#[cfg(test)]
thread_local! {
    static BETWEEN: std::cell::RefCell<Option<Box<dyn Fn()>>> = const { std::cell::RefCell::new(None) };
}

fn between_check_and_act() {
    #[cfg(test)]
    BETWEEN.with(|hook| {
        if let Some(run) = hook.borrow().as_ref() {
            run();
        }
    });
}

/// Put back the previous version of `path` when a save stopped between its two renames and left the page missing
/// (Codex review of 32fd236, W2). The user's newer text is still in its draft. True when something was restored.
pub fn recover(path: &Path) -> bool {
    let lock = lock_for(path);
    let _held = lock.lock().unwrap_or_else(|e| e.into_inner());
    match atomic::orphaned_aside(path) {
        Some(aside) => atomic::move_no_replace(&aside, path).is_ok(),
        None => false,
    }
}

/// Read a file for the editor, putting back a version an interrupted save left aside.
pub fn read(path: &Path) -> Result<Loaded, String> {
    read_inner(path, true, None)
}

/// `read`, decoding the bytes as `encoding` (one of `encoding::EDITABLE`) instead of the detected one (NS-6A).
pub fn read_as(path: &Path, encoding: &str) -> Result<Loaded, String> {
    let chosen = encoding::editable(encoding).ok_or_else(|| format!("Hivemind cannot reopen a file as {encoding}"))?;
    read_inner(path, true, Some(chosen))
}

/// Read a file Hivemind may not write (it lies in a protected place): nothing is put back (Codex review of 52051c8, P1).
pub fn read_view(path: &Path) -> Result<Loaded, String> {
    read_inner(path, false, None)
}

/// `read_view`, decoding the bytes as `encoding`.
pub fn read_view_as(path: &Path, encoding: &str) -> Result<Loaded, String> {
    let chosen = encoding::editable(encoding).ok_or_else(|| format!("Hivemind cannot reopen a file as {encoding}"))?;
    read_inner(path, false, Some(chosen))
}

fn read_inner(path: &Path, may_recover: bool, chosen: Option<&'static encoding_rs::Encoding>) -> Result<Loaded, String> {
    let meta = match std::fs::metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound && may_recover && recover(path) => std::fs::metadata(path),
        other => other,
    };
    let meta = meta.map_err(|e| format!("Could not open {}: {e}", path.display()))?;
    if meta.is_dir() {
        return Err(format!("{} is a folder", path.display()));
    }
    if meta.len() > MAX_READ {
        return Err(format!("{} is larger than 64 MB, too large to edit", path.display()));
    }
    let bytes = std::fs::File::open(path)
        .and_then(|mut file| read_capped(&mut file))
        .map_err(|e| format!("Could not read {}: {e}", path.display()))?
        .ok_or_else(|| format!("{} is larger than 64 MB, too large to edit", path.display()))?;
    let decoded = match chosen {
        Some(encoding) => encoding::decode_as(&bytes, encoding)?,
        None => encoding::decode(&bytes),
    };
    let encoding_fine = decoded.read_only.is_none();
    let (text, format, mut read_only, binary) = shape(decoded);
    let attribute = meta.permissions().readonly();
    // Converting helps only when the encoding is the reason: not for a binary file, mixed line endings or a file
    // marked read-only.
    let convertible = read_only.is_some() && !binary && format.eol != Eol::Mixed && !attribute;
    // Mixed line endings alone: choosing a line ending makes the file editable (NS-6A).
    let choose_eol = encoding_fine && !binary && format.eol == Eol::Mixed && !attribute;
    if read_only.is_none() && attribute {
        read_only = Some("This file is read-only on disk".into());
    }
    Ok(Loaded { text, stamp: Stamp { sha256: sha256(&bytes), size: bytes.len() as u64, mtime_ms: mtime_ms(&meta) }, format, read_only, binary, convertible, choose_eol })
}

/// Read at most 64 MB: None when there is more, however large the file looked a moment before (Codex final review of
/// a34fafd, N2).
fn read_capped(reader: &mut impl std::io::Read) -> std::io::Result<Option<Vec<u8>>> {
    let mut bytes = Vec::new();
    std::io::Read::read_to_end(&mut std::io::Read::take(reader, MAX_READ + 1), &mut bytes)?;
    Ok((bytes.len() as u64 <= MAX_READ).then_some(bytes))
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
    // Exact, not lowercased: in a case-sensitive folder `a.md` is another file than `A.md` (Codex final review of
    // a34fafd, W1c). A spelling that differs only costs one needless check of an unchanged file.
    let key = path.to_string_lossy().into_owned();
    list.retain(|(p, _)| *p != key);
    list.push_back((key, sha.to_string()));
    while list.len() > 256 {
        list.pop_front();
    }
}

/// True when `path` now holds exactly what Hivemind last wrote there. Once the file is seen holding anything else,
/// the write is forgotten, so a later outside restore of the same bytes is not mistaken for an echo (Codex review of
/// 32fd236, S4).
pub fn is_own_write(path: &Path) -> bool {
    let key = path.to_string_lossy().into_owned();
    let Some(expected) = written().lock().unwrap_or_else(|e| e.into_inner()).iter().rev().find(|(p, _)| *p == key).map(|(_, s)| s.clone()) else {
        return false;
    };
    let own = std::fs::read(path).map(|bytes| sha256(&bytes) == expected).unwrap_or(false);
    if !own {
        written().lock().unwrap_or_else(|e| e.into_inner()).retain(|(p, _)| *p != key);
    }
    own
}

/// Why bytes on disk must not be replaced by editor text: they are not text Hivemind can edit, so the text the user
/// merged against was not their real content (Codex review of 32fd236, D3). With `convert` (the user chose Convert to
/// UTF-8 for this file), text that does not decode may be replaced; a binary file never is.
fn not_editable(bytes: &[u8], convert: bool) -> Option<String> {
    let (_, _, read_only, binary) = decode(bytes);
    if binary {
        return Some("The file on disk is no longer a text file. Your edits are kept as a draft".into());
    }
    if convert {
        return None;
    }
    read_only.map(|why| format!("The file on disk changed to something Hivemind cannot save over ({why}). Your edits are kept as a draft"))
}

/// Save editor text over a file that still holds the bytes the editor loaded. `convert` is set once the user chose
/// Convert to UTF-8 for a file that opened read-only.
pub fn save(path: &Path, text: &str, pre: &Stamp, format: &FileFormat, convert: bool) -> Result<SaveOutcome, String> {
    let bytes = encode(text, format)?;
    let lock = lock_for(path);
    let _held = lock.lock().unwrap_or_else(|e| e.into_inner());
    // Held from the check to the replace: no other program can write, rename or delete it in between.
    let held = match atomic::hold(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound && atomic::orphaned_aside(path).is_some() => {
            if let Some(aside) = atomic::orphaned_aside(path) {
                let _ = atomic::move_no_replace(&aside, path);
            }
            atomic::hold(path)
        }
        other => other,
    };
    let mut held = match held {
        Ok(held) => held,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(SaveOutcome::Gone),
        Err(e) if atomic::in_use(&e) => return Err(format!("{} is in use by another program; try again", path.display())),
        Err(e) => return Err(format!("Could not read {}: {e}", path.display())),
    };
    let current = read_capped(&mut held.file)
        .map_err(|e| format!("Could not read {}: {e}", path.display()))?
        .ok_or_else(|| format!("{} is now larger than 64 MB, so Hivemind does not replace it", path.display()))?;
    let sha = sha256(&current);
    if sha != pre.sha256 {
        return Ok(SaveOutcome::Stale { sha256: sha });
    }
    if let Some(why) = not_editable(&current, convert) {
        return Err(why);
    }
    if held.file.metadata().map(|m| m.permissions().readonly()).unwrap_or(false) {
        return Err(format!("{} is read-only on disk", path.display()));
    }
    held.replace(&bytes)?;
    let done = stamp(&bytes, path);
    remember_written(path, &done.sha256);
    Ok(SaveOutcome::Saved(done))
}

/// Save raw binary bytes (such as `.docx` or `.pdf`) over a file that still holds `pre.sha256`, using the same
/// lock, exclusive hold, size cap, read-only check, and atomic replace as `save`.
pub fn save_bytes(path: &Path, bytes: &[u8], pre: &Stamp) -> Result<SaveOutcome, String> {
    let lock = lock_for(path);
    let _held = lock.lock().unwrap_or_else(|e| e.into_inner());
    let held = match atomic::hold(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound && atomic::orphaned_aside(path).is_some() => {
            if let Some(aside) = atomic::orphaned_aside(path) {
                let _ = atomic::move_no_replace(&aside, path);
            }
            atomic::hold(path)
        }
        other => other,
    };
    let mut held = match held {
        Ok(held) => held,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(SaveOutcome::Gone),
        Err(e) if atomic::in_use(&e) => return Err(format!("{} is in use by another program; try again", path.display())),
        Err(e) => return Err(format!("Could not read {}: {e}", path.display())),
    };
    let current = read_capped(&mut held.file)
        .map_err(|e| format!("Could not read {}: {e}", path.display()))?
        .ok_or_else(|| format!("{} is now larger than 64 MB, so Hivemind does not replace it", path.display()))?;
    let sha = sha256(&current);
    if sha != pre.sha256 {
        return Ok(SaveOutcome::Stale { sha256: sha });
    }
    if held.file.metadata().map(|m| m.permissions().readonly()).unwrap_or(false) {
        return Err(format!("{} is read-only on disk", path.display()));
    }
    held.replace(bytes)?;
    let done = stamp(bytes, path);
    remember_written(path, &done.sha256);
    Ok(SaveOutcome::Saved(done))
}

/// Create a new binary file; refuses when anything already exists at `path`.
pub fn create_bytes(path: &Path, bytes: &[u8]) -> Result<Stamp, String> {
    let lock = lock_for(path);
    let _held = lock.lock().unwrap_or_else(|e| e.into_inner());
    if std::fs::symlink_metadata(path).is_ok() {
        return Err(format!("{} already exists", path.display()));
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Could not create {}: {e}", parent.display()))?;
    }
    let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(path).map_err(|e| format!("Could not create {}: {e}", path.display()))?;
    std::io::Write::write_all(&mut file, bytes).map_err(|e| format!("Could not write {}: {e}", path.display()))?;
    file.sync_all().map_err(|e| format!("Could not write {}: {e}", path.display()))?;
    drop(file);
    let done = stamp(bytes, path);
    remember_written(path, &done.sha256);
    Ok(done)
}

/// Read raw binary bytes up to `MAX_READ` along with their `Stamp` and on-disk read-only status.
pub fn read_bytes(path: &Path) -> Result<(Vec<u8>, Stamp, bool), String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("Could not open {}: {e}", path.display()))?;
    if meta.is_dir() {
        return Err(format!("{} is a folder", path.display()));
    }
    if meta.len() > MAX_READ {
        return Err(format!("{} is larger than 64 MB, too large to edit", path.display()));
    }
    let bytes = std::fs::File::open(path)
        .and_then(|mut file| read_capped(&mut file))
        .map_err(|e| format!("Could not read {}: {e}", path.display()))?
        .ok_or_else(|| format!("{} is larger than 64 MB, too large to edit", path.display()))?;
    let st = Stamp { sha256: sha256(&bytes), size: bytes.len() as u64, mtime_ms: mtime_ms(&meta) };
    Ok((bytes, st, meta.permissions().readonly()))
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

/// Save As, as UTF-8 with LF line breaks. A new file is created only if nothing took its name meanwhile. A file the user
/// chose to replace is saved over like a page: held from the check to the replace (named streams, times and attributes
/// kept), against the version on disk now, and never when it is not text (Codex review of 52051c8, D2 and W2).
pub fn save_as(path: &Path, text: &str) -> Result<(), String> {
    let lf = text.replace("\r\n", "\n");
    let fresh = |lf: &str| {
        between_check_and_act();
        create(path, lf).map(|_| ())
    };
    // A link is refused, since the held replace would move the file it points to; so is a file too large to read
    // (Codex re-review of fa08348, N1 and N2).
    let meta = match std::fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return fresh(&lf),
        Err(e) => return Err(format!("Could not read {}: {e}", path.display())),
    };
    if meta.file_type().is_symlink() {
        return Err(format!("{} is a link; choose another name", path.display()));
    }
    if meta.len() > MAX_READ {
        return Err(format!("{} is larger than 64 MB, so Hivemind does not replace it", path.display()));
    }
    let bytes = match std::fs::File::open(path).and_then(|mut file| read_capped(&mut file)) {
        Ok(Some(bytes)) => bytes,
        Ok(None) => return Err(format!("{} is larger than 64 MB, so Hivemind does not replace it", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return fresh(&lf),
        Err(e) => return Err(format!("Could not read {}: {e}", path.display())),
    };
    between_check_and_act();
    let format = FileFormat { encoding: "UTF-8".into(), bom: false, eol: Eol::Lf, confidence: Default::default() };
    match save(path, &lf, &stamp(&bytes, path), &format, true)? {
        SaveOutcome::Saved(_) => Ok(()),
        SaveOutcome::Stale { .. } => Err(format!("{} changed while Hivemind was saving over it; try again", path.display())),
        SaveOutcome::Gone => create(path, &lf).map(|_| ()),
    }
}

/// Rename or move a file or folder. Refuses when the target exists, except a change of letter case only, which
/// goes through a temporary name.
pub fn rename(from: &Path, to: &Path) -> Result<(), String> {
    if std::fs::symlink_metadata(from).is_err() {
        return Err(format!("{} no longer exists", from.display()));
    }
    let taken = |e: std::io::Error| if atomic::exists_error(&e) { format!("{} already exists", to.display()) } else { format!("Could not move {}: {e}", from.display()) };
    let same_but_case = from.to_string_lossy().to_lowercase() == to.to_string_lossy().to_lowercase();
    if same_but_case {
        if from == to {
            return Ok(());
        }
        // In a case-sensitive folder the new spelling can be a different file; it is never replaced (Codex review of
        // 32fd236, W1).
        let name = to.file_name().unwrap_or_default();
        let entries = to.parent().and_then(|dir| std::fs::read_dir(dir).ok());
        if entries.is_some_and(|mut list| list.any(|e| e.is_ok_and(|e| e.file_name() == name))) {
            return Err(format!("{} already exists", to.display()));
        }
        let step = atomic::beside(from, "rename-")?;
        atomic::move_no_replace(from, &step).map_err(|e| format!("Could not rename {}: {e}", from.display()))?;
        return atomic::move_no_replace(&step, to).map_err(|e| {
            let _ = atomic::move_no_replace(&step, from);
            taken(e)
        });
    }
    if std::fs::symlink_metadata(to).is_ok() {
        return Err(format!("{} already exists", to.display()));
    }
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Could not create {}: {e}", parent.display()))?;
    }
    between_check_and_act();
    // Never replaces: a file that appeared at `to` since the check above stays (Codex review of 32fd236, W1).
    atomic::move_no_replace(from, to).map_err(taken)
}

/// Move `rel` (a file or folder of the notebook at `root`) to `.hivemind/trash/<stamp>/<rel>`; returns the trash path.
/// With `pre`, the file is held from the hash check to the move, so only those bytes go (Codex review of 32fd236, W5).
pub fn trash(root: &Path, rel: &str, now: &str, pre: Option<&Stamp>) -> Result<PathBuf, String> {
    let from = contain::resolve_inside(root, rel, true)?;
    // Resolved as a write, so a `.hivemind` link cannot carry the file out of the notebook.
    let to = contain::resolve_inside(root, &format!(".hivemind/trash/{now}/{rel}"), true)?;
    let mut target = to.clone();
    let mut n = 1;
    while std::fs::symlink_metadata(&target).is_ok() {
        n += 1;
        target = to.with_file_name(format!("{} ({n})", to.file_name().unwrap_or_default().to_string_lossy()));
    }
    let Some(pre) = pre else {
        rename(&from, &target)?;
        return Ok(target);
    };
    let lock = lock_for(&from);
    let _locked = lock.lock().unwrap_or_else(|e| e.into_inner());
    let mut held = match atomic::hold(&from) {
        Ok(held) => held,
        Err(e) if atomic::in_use(&e) => return Err(format!("{} is in use by another program; try again", from.display())),
        Err(e) => return Err(format!("Could not read {}: {e}", from.display())),
    };
    let mut now_bytes = Vec::new();
    std::io::Read::read_to_end(&mut held.file, &mut now_bytes).map_err(|e| format!("Could not read {}: {e}", from.display()))?;
    if sha256(&now_bytes) != pre.sha256 {
        return Err(format!("\"{rel}\" changed on disk since it was opened; reopen it before deleting"));
    }
    between_check_and_act();
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Could not create {}: {e}", parent.display()))?;
    }
    held.move_to(&target).map_err(|e| format!("Could not move {} to the trash: {e}", from.display()))?;
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
        assert_eq!(detect_eol("a\rb"), Eol::Cr);
        assert_eq!(detect_eol("a\rb\n"), Eol::Mixed);
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
    fn binary_undecodable_and_mixed_files_are_read_only() {
        assert!(decode(b"PK\x03\x04\x00\x00").3);
        assert!(decode(b"caf\xc3\xa9 na\xc3\xafve \xff").2.unwrap().contains("not valid UTF-8"));
        let (_, format, read_only, _) = decode(b"a\r\nb\n");
        assert!(read_only.unwrap().contains("line-ending"));
        assert!(encode("a\nb", &format).is_err());
    }

    #[test]
    fn a_mixed_file_can_be_saved_once_a_line_ending_is_chosen() {   // NS-6A
        let dir = scratch();
        let page = dir.join("mixed.txt");
        std::fs::write(&page, b"one\r\ntwo\nthree\r\n").unwrap();
        let loaded = read(&page).unwrap();
        assert_eq!((loaded.text.as_str(), loaded.format.eol, loaded.choose_eol, loaded.convertible), ("one\ntwo\nthree\n", Eol::Mixed, true, false));
        assert!(loaded.read_only.clone().unwrap().contains("line-ending"));
        // Mixed endings and bytes that do not decode: choosing a line ending alone would not make it editable.
        std::fs::write(dir.join("bad.txt"), b"caf\xc3\xa9 na\xc3\xafve\r\ntwo\n\xff").unwrap();
        let bad = read(&dir.join("bad.txt")).unwrap();
        assert!(!bad.choose_eol && !bad.convertible);
        // The webview saves it with the chosen line ending, as a conversion: the file on disk is read-only for Hivemind
        // only because of the mix, and the hash check still guards it.
        let crlf = FileFormat { eol: Eol::Crlf, ..loaded.format.clone() };
        assert!(save(&page, &loaded.text, &loaded.stamp, &crlf, false).is_err());
        assert!(matches!(save(&page, &loaded.text, &loaded.stamp, &crlf, true).unwrap(), SaveOutcome::Saved(_)));
        assert_eq!(std::fs::read(&page).unwrap(), b"one\r\ntwo\r\nthree\r\n");
        assert!(matches!(save(&page, "x", &loaded.stamp, &crlf, true).unwrap(), SaveOutcome::Stale { .. }));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_text_with_no_line_break_gains_lf_breaks() {
        let format = FileFormat { encoding: "UTF-8".into(), bom: false, eol: Eol::None, confidence: Default::default() };
        assert_eq!(encode("a\nb", &format).unwrap(), b"a\nb");
    }

    #[test]
    fn save_refuses_a_stale_or_deleted_file() {
        let dir = scratch();
        let page = dir.join("Page.md");
        std::fs::write(&page, "one\n").unwrap();
        let loaded = read(&page).unwrap();
        assert_eq!(save(&page, "two\n", &loaded.stamp, &loaded.format, false).unwrap(), SaveOutcome::Saved(read(&page).unwrap().stamp));
        assert_eq!(std::fs::read_to_string(&page).unwrap(), "two\n");
        // The first stamp is now stale.
        match save(&page, "three\n", &loaded.stamp, &loaded.format, false).unwrap() {
            SaveOutcome::Stale { sha256: now } => assert_eq!(now, sha256(b"two\n")),
            other => panic!("{other:?}"),
        }
        assert_eq!(std::fs::read_to_string(&page).unwrap(), "two\n");
        std::fs::remove_file(&page).unwrap();
        assert_eq!(save(&page, "four\n", &loaded.stamp, &loaded.format, false).unwrap(), SaveOutcome::Gone);
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
        assert!(save(&page, "two\n", &loaded.stamp, &loaded.format, false).unwrap_err().contains("in use"));
        drop(writer);
        assert_eq!(std::fs::read_to_string(&page).unwrap(), "one\n");
        assert!(matches!(save(&page, "two\n", &loaded.stamp, &loaded.format, false).unwrap(), SaveOutcome::Saved(_)));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_reader_does_not_block_a_save() {
        let dir = scratch();
        let page = dir.join("Read.md");
        std::fs::write(&page, "one\n").unwrap();
        let loaded = read(&page).unwrap();
        let reader = std::fs::File::open(&page).unwrap();
        assert!(matches!(save(&page, "two\n", &loaded.stamp, &loaded.format, false).unwrap(), SaveOutcome::Saved(_)));
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
    fn reads_stop_after_64_mb_whatever_the_size_looked_like() {   // Codex final review of a34fafd, N2
        struct Counting<R>(R, u64);
        impl<R: std::io::Read> std::io::Read for Counting<R> {
            fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                let n = self.0.read(buf)?;
                self.1 += n as u64;
                Ok(n)
            }
        }
        let mut growing = Counting(std::io::Read::take(std::io::repeat(b'x'), MAX_READ * 2), 0);
        assert!(read_capped(&mut growing).unwrap().is_none());
        assert!(growing.1 <= MAX_READ + 1, "read {} bytes", growing.1);
        assert_eq!(read_capped(&mut std::io::Read::take(std::io::repeat(b'x'), 5)).unwrap(), Some(b"xxxxx".to_vec()));
    }

    #[cfg(windows)]
    #[test]
    fn a_write_to_one_file_is_not_the_echo_of_another_differing_in_case() {   // Codex final review of a34fafd, W1c
        let dir = scratch();
        let made = std::process::Command::new("fsutil").args(["file", "setCaseSensitiveInfo"]).arg(&dir).arg("enable").output().unwrap();
        assert!(made.status.success(), "fsutil could not make a case-sensitive folder: {}", String::from_utf8_lossy(&made.stdout));
        let (upper, lower) = (dir.join("A.md"), dir.join("a.md"));
        create(&upper, "same").unwrap();
        std::fs::write(&lower, "same").unwrap();
        assert!(!is_own_write(&lower), "a.md changed on its own");
        assert!(is_own_write(&upper));
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
        let moved = trash(&dir, "Projects/Old.md", "20261120-120000", None).unwrap();
        assert_eq!(moved, dir.join(".hivemind/trash/20261120-120000/Projects/Old.md"));
        assert!(moved.is_file() && !dir.join("Projects/Old.md").exists());
        std::fs::write(dir.join("Projects/Old.md"), "again").unwrap();
        let second = trash(&dir, "Projects/Old.md", "20261120-120000", None).unwrap();
        assert_eq!(second.file_name().unwrap(), "Old.md (2)");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    fn between(run: impl Fn() + 'static) {
        BETWEEN.with(|hook| *hook.borrow_mut() = Some(Box::new(run)));
    }

    fn no_between() {
        BETWEEN.with(|hook| *hook.borrow_mut() = None);
    }

    #[cfg(windows)]
    #[test]
    fn nothing_changes_the_page_between_trashs_hash_check_and_its_move() {
        // Codex re-review of c496e1c, T2: another program tries to write the page after the hash matched.
        let dir = scratch();
        std::fs::write(dir.join("Page.md"), "checked").unwrap();
        let seen = read(&dir.join("Page.md")).unwrap().stamp;
        let page = dir.join("Page.md");
        let blocked = std::rc::Rc::new(std::cell::Cell::new(false));
        let flag = blocked.clone();
        between(move || flag.set(std::fs::write(&page, "slipped in").is_err() && std::fs::remove_file(&page).is_err()));
        let moved = trash(&dir, "Page.md", "t", Some(&seen)).unwrap();
        no_between();
        assert!(blocked.get(), "the held page refused the write and the delete");
        assert_eq!(std::fs::read_to_string(moved).unwrap(), "checked");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_target_that_appears_during_a_rename_is_never_replaced() {
        // Codex re-review of c496e1c, T1: the destination is created after the existence check.
        let dir = scratch();
        std::fs::write(dir.join("a.md"), "mine").unwrap();
        let target = dir.join("b.md");
        let racer = target.clone();
        between(move || std::fs::write(&racer, "theirs").unwrap());
        let out = rename(&dir.join("a.md"), &target);
        no_between();
        assert!(out.unwrap_err().contains("already exists"));
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "theirs");
        assert_eq!(std::fs::read_to_string(dir.join("a.md")).unwrap(), "mine");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn save_as_over_a_file_keeps_its_streams_and_never_replaces_binary() {   // Codex review of 52051c8, D2 and W2
        let dir = scratch();
        // A new file gets LF line breaks; one that appeared at the name meanwhile is not created over.
        save_as(&dir.join("New.txt"), "one\r\ntwo\n").unwrap();
        assert_eq!(std::fs::read(dir.join("New.txt")).unwrap(), b"one\ntwo\n");
        let path = dir.join("Old.txt");
        std::fs::write(&path, "old\r\n").unwrap();
        std::fs::write(format!("{}:extra", path.display()), "stream").unwrap();
        save_as(&path, "new text\r\n").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "new text\n");
        assert_eq!(std::fs::read_to_string(format!("{}:extra", path.display())).unwrap(), "stream", "the named stream is kept");
        let picture = dir.join("pic.png");
        std::fs::write(&picture, b"\x89PNG\r\n\x1a\n\x00\x00").unwrap();
        assert!(save_as(&picture, "text").is_err());
        assert_eq!(std::fs::read(&picture).unwrap(), b"\x89PNG\r\n\x1a\n\x00\x00");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn save_as_never_replaces_what_appeared_or_changed_after_it_looked() {   // Codex re-review of fa08348, D2 and W2
        let dir = scratch();
        let fresh = dir.join("Fresh.txt");
        let racer = fresh.clone();
        between(move || {
            if !racer.exists() {
                std::fs::write(&racer, "theirs\n").unwrap();
            }
        });
        assert!(save_as(&fresh, "mine\n").unwrap_err().contains("already exists"));
        assert_eq!(std::fs::read_to_string(&fresh).unwrap(), "theirs\n");
        let old = dir.join("Old.txt");
        std::fs::write(&old, "before\n").unwrap();
        let racer = old.clone();
        between(move || {
            if std::fs::read_to_string(&racer).unwrap() == "before\n" {
                std::fs::write(&racer, "theirs\n").unwrap();
            }
        });
        let err = save_as(&old, "mine\n").unwrap_err();
        no_between();
        assert!(err.contains("changed"), "{err}");
        assert_eq!(std::fs::read_to_string(&old).unwrap(), "theirs\n");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn neither_save_nor_save_as_reads_a_file_over_64_mb() {   // Codex re-review of fa08348, N2
        let dir = scratch();
        let path = dir.join("big.log");
        std::fs::write(&path, "small\n").unwrap();
        let stamp = read(&path).unwrap().stamp;
        std::fs::OpenOptions::new().write(true).open(&path).unwrap().set_len(MAX_READ + 1).unwrap();
        let utf8 = FileFormat { encoding: "UTF-8".into(), bom: false, eol: Eol::Lf, confidence: Default::default() };
        assert!(save(&path, "x", &stamp, &utf8, false).unwrap_err().contains("64 MB"));
        // Refused before reading it ("is larger"), not after reading it all through the held save ("is now larger").
        assert!(save_as(&path, "x").unwrap_err().contains("is larger than 64 MB"));
        assert_eq!(std::fs::metadata(&path).unwrap().len(), MAX_READ + 1);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn save_as_refuses_a_link() {   // Codex re-review of fa08348, N1
        let dir = scratch();
        std::fs::write(dir.join("target.txt"), "kept\n").unwrap();
        if let Err(e) = std::os::windows::fs::symlink_file(dir.join("target.txt"), dir.join("link.txt")) {
            // A file symlink needs Developer Mode or admin rights; a junction is the same kind of link to this check.
            eprintln!("a file symlink could not be made ({e}); checking with a junction");
            std::fs::create_dir_all(dir.join("folder")).unwrap();
            let made = std::process::Command::new("cmd").args(["/C", "mklink", "/J"]).arg(dir.join("link.txt")).arg(dir.join("folder")).output().unwrap();
            assert!(made.status.success(), "mklink /J needs no admin rights: {}", String::from_utf8_lossy(&made.stderr));
        }
        assert!(save_as(&dir.join("link.txt"), "new\n").unwrap_err().contains("is a link"));
        assert_eq!(std::fs::read_to_string(dir.join("target.txt")).unwrap(), "kept\n");
        assert!(std::fs::symlink_metadata(dir.join("link.txt")).unwrap().file_type().is_symlink());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_read_of_a_file_hivemind_may_not_write_puts_nothing_back() {   // Codex review of 52051c8, P1
        let dir = scratch();
        let path = dir.join("Page.md");
        let aside = atomic::beside(&path, "old-").unwrap();
        std::fs::write(&aside, "earlier").unwrap();
        assert!(read_view(&path).is_err());
        assert!(aside.exists() && !path.exists(), "the aside stays where it is");
        assert_eq!(read(&path).unwrap().text, "earlier", "an ordinary read still puts it back");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn a_case_only_rename_in_a_case_sensitive_folder_keeps_both_files() {
        let dir = scratch();
        let made = std::process::Command::new("fsutil").args(["file", "setCaseSensitiveInfo"]).arg(&dir).arg("enable").output().unwrap();
        assert!(made.status.success(), "fsutil could not make a case-sensitive folder: {}", String::from_utf8_lossy(&made.stdout));
        std::fs::write(dir.join("note.md"), "lower").unwrap();
        std::fs::write(dir.join("NOTE.md"), "upper").unwrap();
        assert!(rename(&dir.join("note.md"), &dir.join("NOTE.md")).unwrap_err().contains("already exists"));
        assert_eq!(std::fs::read_to_string(dir.join("NOTE.md")).unwrap(), "upper");
        assert_eq!(std::fs::read_to_string(dir.join("note.md")).unwrap(), "lower");
        // With only one spelling present, the case change goes ahead.
        std::fs::remove_file(dir.join("NOTE.md")).unwrap();
        rename(&dir.join("note.md"), &dir.join("Note.md")).unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("Note.md")).unwrap(), "lower");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn every_supported_encoding_saves_one_changed_line_and_nothing_else() {
        // NS-1B exit criterion: windows-1252, UTF-16 LE with a BOM and CRLF UTF-8 each change one line on save.
        let dir = scratch();
        let cases: [(&str, Vec<u8>); 3] = [
            ("cp1252.txt", b"caf\xe9 one\r\nna\xefve two\r\nthree\r\n".to_vec()),
            ("utf16.txt", [&[0xFF, 0xFE][..], &"one \u{e9}\r\ntwo\r\nthree\r\n".encode_utf16().flat_map(u16::to_le_bytes).collect::<Vec<u8>>()].concat()),
            ("crlf.md", b"# one\r\ntwo\r\nthree".to_vec()),
        ];
        for (name, bytes) in cases {
            let path = dir.join(name);
            std::fs::write(&path, &bytes).unwrap();
            let loaded = read(&path).unwrap();
            assert_eq!(loaded.read_only, None, "{name}");
            assert_eq!(encode(&loaded.text, &loaded.format).unwrap(), bytes, "{name}: unchanged text gives the same bytes");
            let edited = loaded.text.replacen("two", "TWO", 1);
            assert!(matches!(save(&path, &edited, &loaded.stamp, &loaded.format, false).unwrap(), SaveOutcome::Saved(_)));
            let after = std::fs::read(&path).unwrap();
            let expected = encode(&edited, &loaded.format).unwrap();
            assert_eq!(after, expected, "{name}");
            let changed = after.iter().zip(&bytes).filter(|(a, b)| a != b).count();
            assert!(changed > 0 && changed <= 6, "{name}: only the edited letters changed ({changed} bytes)");
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn convert_to_utf8_saves_over_undecodable_text_but_never_binary() {
        let dir = scratch();
        let path = dir.join("Broken.txt");
        let bytes = b"caf\xc3\xa9 na\xc3\xafve \xff\n".to_vec();
        std::fs::write(&path, &bytes).unwrap();
        let loaded = read(&path).unwrap();
        assert!(loaded.read_only.is_some() && loaded.convertible);
        let utf8 = FileFormat { encoding: "UTF-8".into(), bom: false, eol: loaded.format.eol, confidence: Default::default() };
        assert!(save(&path, &loaded.text, &loaded.stamp, &utf8, false).is_err(), "not without Convert");
        assert!(matches!(save(&path, &loaded.text, &loaded.stamp, &utf8, true).unwrap(), SaveOutcome::Saved(_)));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "café naïve \u{fffd}\n");
        std::fs::write(&path, b"PK\x03\x04\x00\x00").unwrap();
        let stamp = Stamp { sha256: sha256(b"PK\x03\x04\x00\x00"), size: 6, mtime_ms: 0 };
        assert!(save(&path, "x", &stamp, &utf8, true).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn trash_with_a_stamp_moves_only_those_bytes() {
        let dir = scratch();
        std::fs::write(dir.join("Page.md"), "seen").unwrap();
        let seen = read(&dir.join("Page.md")).unwrap().stamp;
        std::fs::write(dir.join("Page.md"), "newer").unwrap();
        assert!(trash(&dir, "Page.md", "t1", Some(&seen)).unwrap_err().contains("changed on disk"));
        assert_eq!(std::fs::read_to_string(dir.join("Page.md")).unwrap(), "newer");
        let now = read(&dir.join("Page.md")).unwrap().stamp;
        let moved = trash(&dir, "Page.md", "t2", Some(&now)).unwrap();
        assert_eq!(std::fs::read_to_string(moved).unwrap(), "newer");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn an_outside_restore_of_hiveminds_last_bytes_is_not_an_echo() {
        let dir = scratch();
        let page = dir.join("Restore.md");
        create(&page, "A").unwrap();
        assert!(is_own_write(&page), "the echo of Hivemind's own write");
        std::fs::write(&page, "B").unwrap();
        assert!(!is_own_write(&page));
        std::fs::write(&page, "A").unwrap();
        assert!(!is_own_write(&page), "A again, written by someone else");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_save_never_replaces_a_file_that_became_binary_or_undecodable() {
        let dir = scratch();
        let page = dir.join("Turned.md");
        let format = FileFormat { encoding: "UTF-8".into(), bom: false, eol: Eol::Lf, confidence: Default::default() };
        // Since NS-1B Latin-1 bytes are an editable windows-1252 page; UTF-8 with a bad byte is still not editable.
        for bytes in [&b"PK\x03\x04\x00\x00"[..], &b"caf\xc3\xa9 na\xc3\xafve \xff\n"[..]] {
            std::fs::write(&page, bytes).unwrap();
            // The stamp of the bytes now on disk, as a merge against them would carry.
            let stamp = Stamp { sha256: sha256(bytes), size: bytes.len() as u64, mtime_ms: 0 };
            assert!(save(&page, "merged text\n", &stamp, &format, false).unwrap_err().contains("draft"));
            assert_eq!(std::fs::read(&page).unwrap(), bytes);
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_page_left_aside_by_an_interrupted_save_comes_back() {
        let dir = scratch();
        let page = dir.join("Crash.md");
        std::fs::write(atomic::beside(&page, "old-").unwrap(), "previous\n").unwrap();
        std::fs::write(atomic::beside(&page, "").unwrap(), "unfinished\n").unwrap();
        let loaded = read(&page).unwrap();
        assert_eq!(loaded.text, "previous\n");
        assert_eq!(std::fs::read_to_string(&page).unwrap(), "previous\n");
        std::fs::remove_file(&page).unwrap();
        std::fs::write(atomic::beside(&page, "old-").unwrap(), "previous\n").unwrap();
        assert!(matches!(save(&page, "next\n", &loaded.stamp, &loaded.format, false).unwrap(), SaveOutcome::Saved(_)));
        assert_eq!(std::fs::read_to_string(&page).unwrap(), "next\n");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_case_only_rename_never_takes_a_different_file() {
        let dir = scratch();
        std::fs::write(dir.join("note.md"), "n").unwrap();
        // A folder whose entries keep their case apart is rare on Windows; the listing check covers it, and here the
        // same entry is found in a case-insensitive folder, so the rename goes ahead.
        rename(&dir.join("note.md"), &dir.join("NOTE.md")).unwrap();
        let names: Vec<String> = std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(names, ["NOTE.md"]);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
