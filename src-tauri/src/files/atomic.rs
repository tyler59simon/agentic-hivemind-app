//! Whole-file replacement that never leaves a half-written file and, on Windows, never overwrites bytes other than
//! the ones the caller checked.
use std::io::Write;
use std::path::{Path, PathBuf};

const TEMP_MARK: &str = ".hm-";
const TEMP_END: &str = ".tmp";
/// The tag of the previous version a save moves aside.
const ASIDE: &str = "old-";
/// The most of the original name a temp name keeps, in UTF-16 units, so it stays under the 255-unit NTFS limit
/// (Codex review of 32fd236, W4).
const NAME_KEEP: usize = 100;
/// The most extra data streams a save carries over to the new file.
const MAX_STREAMS: u64 = 16 * 1024 * 1024;

fn short_name(name: &str) -> String {
    let mut units = 0;
    name.chars()
        .take_while(|c| {
            units += c.len_utf16();
            units <= NAME_KEEP
        })
        .collect()
}

/// Eight hex digits naming the whole original file name (lowercase, as Windows compares names), so a temp name cut
/// to NAME_KEEP units still belongs to exactly one file (Codex re-review of c496e1c, N2).
fn name_tag(name: &str) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(name.to_lowercase().as_bytes()).iter().take(4).map(|b| format!("{b:02x}")).collect()
}

/// A hidden file beside `path`: `.<name>.hm-<tag><name hash><uuid>.tmp`, in the same folder so renames stay on one
/// volume. Long names are cut to NAME_KEEP units; the name hash keeps them apart.
pub fn beside(path: &Path, tag: &str) -> Result<PathBuf, String> {
    let name = path.file_name().ok_or_else(|| format!("{} has no file name", path.display()))?.to_string_lossy().into_owned();
    let temp = format!(".{}{TEMP_MARK}{tag}{}{}{TEMP_END}", short_name(&name), name_tag(&name), uuid::Uuid::new_v4().simple());
    Ok(path.with_file_name(temp))
}

/// The previous version of `path` that a save left beside it when it stopped between its two renames (the process
/// was killed or the machine lost power): `path` is missing and exactly one aside made for this exact name is there,
/// and it is a plain file, never a link (Codex re-review of c496e1c, N1).
pub fn orphaned_aside(path: &Path) -> Option<PathBuf> {
    if std::fs::symlink_metadata(path).is_ok() {
        return None;
    }
    let name = path.file_name()?.to_string_lossy().into_owned();
    let prefix = format!(".{}{TEMP_MARK}{ASIDE}{}", short_name(&name), name_tag(&name));
    let dir = path.parent()?;
    let mut found = std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_file() && !t.is_symlink()))
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.len() == prefix.len() + 32 + TEMP_END.len() && n.starts_with(&prefix) && n.ends_with(TEMP_END));
    let first = found.next()?;
    found.next().is_none().then(|| dir.join(first))
}

/// The file an aside named `name` belongs to, when its name was kept whole. A cut name has at least NAME_KEEP - 1
/// units (the cut can stop one short before a two-unit character), so only shorter names count as whole, and the name
/// hash must match.
pub fn aside_target(dir: &Path, name: &str) -> Option<PathBuf> {
    let (kept, tail) = name.strip_prefix('.')?.strip_suffix(TEMP_END)?.rsplit_once(TEMP_MARK)?;
    let rest = tail.strip_prefix(ASIDE)?;
    let whole = kept.encode_utf16().count() < NAME_KEEP - 1;
    let ours = rest.len() == 40 && rest.bytes().all(|b| b.is_ascii_hexdigit()) && rest[..8] == name_tag(kept);
    (whole && ours).then(|| dir.join(kept))
}

/// True for a temp file this module writes; the watcher and the tree skip these.
pub fn is_temp(name: &str) -> bool {
    name.starts_with('.') && name.ends_with(TEMP_END) && name.contains(TEMP_MARK)
}

/// Write `bytes` to a new hidden file beside `path` and flush it to disk.
fn write_temp(path: &Path, bytes: &[u8]) -> Result<PathBuf, String> {
    let temp = beside(path, "")?;
    let written = (|| -> std::io::Result<()> {
        let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()
    })();
    written.map(|_| temp.clone()).map_err(|e| {
        let _ = std::fs::remove_file(&temp);
        format!("Could not save {}: {e}", path.display())
    })
}

/// Replace (or create) `path` with `bytes`, for files no one else edits (Hivemind's own settings).
pub fn replace(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let temp = write_temp(path, bytes)?;
    std::fs::rename(&temp, path).map_err(|e| {
        let _ = std::fs::remove_file(&temp);
        format!("Could not save {}: {e}", path.display())
    })
}

/// The user's file, opened so that no other program can write, rename or delete it until it is dropped.
pub struct Held {
    pub file: std::fs::File,
    path: PathBuf,
}

const SHARING_VIOLATION: i32 = 32;

/// Open `path` for a checked replace. Fails with `ErrorKind::NotFound` when it is gone, and with "in use" when another
/// program has it open for writing (or without sharing). A brief scanner (antivirus, indexer) is waited out.
pub fn hold(path: &Path) -> std::io::Result<Held> {
    let mut tries = 0;
    loop {
        match open_held(path) {
            Err(e) if e.raw_os_error() == Some(SHARING_VIOLATION) && tries < 4 => {
                tries += 1;
                std::thread::sleep(std::time::Duration::from_millis(60));
            }
            other => return other.map(|file| Held { file, path: path.to_path_buf() }),
        }
    }
}

/// Whether an error from `hold` means another program has the file open.
pub fn in_use(e: &std::io::Error) -> bool {
    e.raw_os_error() == Some(SHARING_VIOLATION)
}

#[cfg(windows)]
fn open_held(path: &Path) -> std::io::Result<std::fs::File> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Foundation::GENERIC_READ;
    use windows_sys::Win32::Storage::FileSystem::{DELETE, FILE_SHARE_READ};
    // Readers may share it; writers, renames and deletes by anyone else are refused while it is held.
    std::fs::OpenOptions::new().access_mode(GENERIC_READ | DELETE).share_mode(FILE_SHARE_READ).open(path)
}

#[cfg(not(windows))]
fn open_held(path: &Path) -> std::io::Result<std::fs::File> {
    std::fs::File::open(path)
}

/// `path` as a NUL-terminated wide string for a Win32 call. A long absolute path gets the `\\?\` form, which std
/// adds by itself but raw calls do not, so names near the 255-unit limit still work.
#[cfg(windows)]
fn wide(path: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    let units: Vec<u16> = path.as_os_str().encode_wide().collect();
    let text = String::from_utf16_lossy(&units);
    let prefix: &[u16] = if units.len() < 240 || text.starts_with(r"\\?\") || !path.is_absolute() {
        &[]
    } else if text.starts_with(r"\\") {
        return r"\\?\UNC\".encode_utf16().chain(units[2..].iter().copied()).chain(std::iter::once(0)).collect();
    } else {
        &[92, 92, 63, 92] // \\?\
    };
    prefix.iter().copied().chain(units).chain(std::iter::once(0)).collect()
}

/// Rename the held file to `to` through its own handle; fails if `to` exists.
#[cfg(windows)]
fn rename_held(file: &std::fs::File, to: &Path) -> std::io::Result<()> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{FileRenameInfo, SetFileInformationByHandle, FILE_RENAME_INFO};
    let name = wide(to);
    let name_bytes = (name.len() - 1) * 2;
    let size = std::mem::offset_of!(FILE_RENAME_INFO, FileName) + name_bytes + 2;
    // u64 storage keeps the struct aligned for its HANDLE field.
    let mut buffer = vec![0u64; size.div_ceil(8)];
    let info = buffer.as_mut_ptr() as *mut FILE_RENAME_INFO;
    // SAFETY: `buffer` is zeroed, aligned and large enough for the header plus the name and its terminator.
    unsafe {
        (*info).Anonymous.ReplaceIfExists = false;
        (*info).FileNameLength = name_bytes as u32;
        std::ptr::copy_nonoverlapping(name.as_ptr(), std::ptr::addr_of_mut!((*info).FileName) as *mut u16, name.len());
        if SetFileInformationByHandle(file.as_raw_handle() as _, FileRenameInfo, info as *const _, size as u32) == 0 {
            return Err(std::io::Error::last_os_error());
        }
    }
    Ok(())
}

/// Move `from` (a file or a folder) to `to` on the same volume, failing if `to` exists.
#[cfg(windows)]
pub fn move_no_replace(from: &Path, to: &Path) -> std::io::Result<()> {
    use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_WRITE_THROUGH};
    // SAFETY: both arguments are NUL-terminated wide strings that live until the call returns.
    if unsafe { MoveFileExW(wide(from).as_ptr(), wide(to).as_ptr(), MOVEFILE_WRITE_THROUGH) } == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn move_no_replace(from: &Path, to: &Path) -> std::io::Result<()> {
    if std::fs::symlink_metadata(to).is_ok() {
        return Err(std::io::Error::from(std::io::ErrorKind::AlreadyExists));
    }
    std::fs::rename(from, to)
}

/// Whether an error from `move_no_replace` means the target exists.
pub fn exists_error(e: &std::io::Error) -> bool {
    // ERROR_FILE_EXISTS and ERROR_ALREADY_EXISTS.
    e.kind() == std::io::ErrorKind::AlreadyExists || matches!(e.raw_os_error(), Some(80) | Some(183))
}

/// The extra data streams of `path` (NTFS alternate data streams such as `Zone.Identifier`), by name and size.
#[cfg(windows)]
fn named_streams(path: &Path) -> std::io::Result<Vec<(String, u64)>> {
    use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
    use windows_sys::Win32::Storage::FileSystem::{FindClose, FindFirstStreamW, FindNextStreamW, FindStreamInfoStandard, WIN32_FIND_STREAM_DATA};
    let mut data = WIN32_FIND_STREAM_DATA::default();
    // SAFETY: the path is a NUL-terminated wide string and `data` is the struct FindStreamInfoStandard fills.
    let find = unsafe { FindFirstStreamW(wide(path).as_ptr(), FindStreamInfoStandard, &mut data as *mut _ as *mut _, 0) };
    if find == INVALID_HANDLE_VALUE {
        let e = std::io::Error::last_os_error();
        // No stream at all (ERROR_HANDLE_EOF), or a file system without streams (FAT, exFAT, some shares).
        return match e.raw_os_error() {
            Some(38) | Some(1) | Some(50) | Some(87) => Ok(vec![]),
            _ => Err(e),
        };
    }
    let mut found = Vec::new();
    loop {
        let len = data.cStreamName.iter().position(|c| *c == 0).unwrap_or(data.cStreamName.len());
        let full = String::from_utf16_lossy(&data.cStreamName[..len]);
        // "::$DATA" is the file's own content; the others read ":<name>:$DATA".
        if let Some(name) = full.strip_prefix(':').and_then(|s| s.strip_suffix(":$DATA")).filter(|n| !n.is_empty()) {
            found.push((name.to_string(), data.StreamSize.max(0) as u64));
        }
        // SAFETY: `find` is the open search handle and `data` is the struct it fills.
        if unsafe { FindNextStreamW(find, &mut data as *mut _ as *mut _) } == 0 {
            let e = std::io::Error::last_os_error();
            // SAFETY: `find` came from FindFirstStreamW and is closed once.
            unsafe { FindClose(find) };
            // Only the end of the list (ERROR_HANDLE_EOF) is success; a partial list would drop streams (Codex
            // re-review of c496e1c, W3).
            return if e.raw_os_error() == Some(38) { Ok(found) } else { Err(e) };
        }
    }
}

#[cfg(windows)]
fn stream_path(path: &Path, name: &str) -> PathBuf {
    let mut full = path.as_os_str().to_os_string();
    full.push(":");
    full.push(name);
    PathBuf::from(full)
}

/// Copy the extra data streams of `from` onto `to`, so a save keeps what other programs stored beside the content
/// (Codex review of 32fd236, W3).
#[cfg(windows)]
fn copy_streams(from: &Path, to: &Path) -> Result<(), String> {
    let streams = named_streams(from).map_err(|e| format!("Could not list the data streams of {}: {e}", from.display()))?;
    if streams.iter().map(|(_, size)| size).sum::<u64>() > MAX_STREAMS {
        return Err(format!("{} carries more than 16 MB of extra data streams, which Hivemind would not keep; it does not save it", from.display()));
    }
    for (name, _) in streams {
        let copied = (|| -> std::io::Result<()> {
            let bytes = std::fs::read(stream_path(from, &name))?;
            let mut out = std::fs::OpenOptions::new().write(true).create_new(true).open(stream_path(to, &name))?;
            out.write_all(&bytes)?;
            out.sync_all()
        })();
        copied.map_err(|e| format!("Could not keep the data stream {name} of {}: {e}", from.display()))?;
    }
    Ok(())
}

impl Held {
    /// Move the held file to `to` through its own handle, failing if `to` exists. What moves is exactly what the
    /// caller read (Codex review of 32fd236, W5).
    #[cfg(windows)]
    pub fn move_to(self, to: &Path) -> std::io::Result<()> {
        rename_held(&self.file, to)
    }

    #[cfg(not(windows))]
    pub fn move_to(self, to: &Path) -> std::io::Result<()> {
        drop(self.file);
        move_no_replace(&self.path, to)
    }

    /// Replace the held file with `bytes`. The held file is moved aside through its own handle, so what is replaced
    /// is exactly what the caller read; the new file then takes its name without overwriting anything that appeared
    /// meanwhile, and the old one is deleted.
    #[cfg(windows)]
    pub fn replace(self, bytes: &[u8]) -> Result<(), String> {
        let shown = self.path.display().to_string();
        let temp = write_temp(&self.path, bytes)?;
        if let Err(e) = copy_streams(&self.path, &temp) {
            let _ = std::fs::remove_file(&temp);
            return Err(e);
        }
        let aside = beside(&self.path, ASIDE)?;
        if let Err(e) = rename_held(&self.file, &aside) {
            let _ = std::fs::remove_file(&temp);
            return Err(format!("Could not save {shown}: {e}"));
        }
        if let Err(e) = move_no_replace(&temp, &self.path) {
            let _ = std::fs::remove_file(&temp);
            return Err(match rename_held(&self.file, &self.path) {
                Ok(()) => format!("Could not save {shown}: {e}"),
                Err(_) => format!("Could not save {shown}: another program created it meanwhile. Your previous version is in {}", aside.display()),
            });
        }
        drop(self.file);
        let _ = std::fs::remove_file(&aside);
        Ok(())
    }

    #[cfg(not(windows))]
    pub fn replace(self, bytes: &[u8]) -> Result<(), String> {
        drop(self.file);
        replace(&self.path, bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hm-atomic-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn leftovers(dir: &Path) -> Vec<String> {
        std::fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).filter(|n| is_temp(n)).collect()
    }

    #[test]
    fn replaces_and_creates_without_leaving_a_temp() {
        let dir = scratch();
        let page = dir.join("Page.md");
        replace(&page, b"first").unwrap();
        replace(&page, b"second").unwrap();
        assert_eq!(std::fs::read(&page).unwrap(), b"second");
        assert!(leftovers(&dir).is_empty());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_failed_replace_removes_its_temp() {
        let dir = scratch();
        // A folder in the way makes the rename fail after the temp file was written.
        std::fs::create_dir_all(dir.join("Taken.md")).unwrap();
        assert!(replace(&dir.join("Taken.md"), b"x").is_err());
        assert!(leftovers(&dir).is_empty());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_held_replace_swaps_the_file_and_cleans_up() {
        let dir = scratch();
        let page = dir.join("Held.md");
        std::fs::write(&page, "old").unwrap();
        let mut held = hold(&page).unwrap();
        let mut seen = String::new();
        held.file.read_to_string(&mut seen).unwrap();
        assert_eq!(seen, "old");
        held.replace(b"new").unwrap();
        assert_eq!(std::fs::read_to_string(&page).unwrap(), "new");
        assert!(leftovers(&dir).is_empty(), "{:?}", leftovers(&dir));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn while_held_no_one_else_can_write_rename_or_delete_it() {
        let dir = scratch();
        let page = dir.join("Locked.md");
        std::fs::write(&page, "mine").unwrap();
        let held = hold(&page).unwrap();
        assert!(std::fs::OpenOptions::new().append(true).open(&page).is_err(), "a writer is refused");
        std::fs::write(dir.join("other.md"), "theirs").unwrap();
        assert!(std::fs::rename(dir.join("other.md"), &page).is_err(), "a save by rename is refused");
        assert!(std::fs::remove_file(&page).is_err(), "a delete is refused");
        assert!(std::fs::read_to_string(&page).is_ok(), "a reader is fine");
        drop(held);
        assert_eq!(std::fs::read_to_string(&page).unwrap(), "mine");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn an_open_writer_makes_hold_report_in_use() {
        let dir = scratch();
        let page = dir.join("Busy.md");
        std::fs::write(&page, "x").unwrap();
        let writer = std::fs::OpenOptions::new().append(true).open(&page).unwrap();
        assert!(in_use(&hold(&page).err().unwrap()));
        drop(writer);
        assert!(hold(&page).is_ok());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn a_save_keeps_the_files_extra_data_streams() {
        let dir = scratch();
        let page = dir.join("Downloaded.md");
        std::fs::write(&page, "old").unwrap();
        std::fs::write(stream_path(&page, "Zone.Identifier"), "[ZoneTransfer]\r\nZoneId=3\r\n").unwrap();
        std::fs::write(stream_path(&page, "app.data"), "kept").unwrap();
        hold(&page).unwrap().replace(b"new").unwrap();
        assert_eq!(std::fs::read_to_string(&page).unwrap(), "new");
        assert_eq!(std::fs::read_to_string(stream_path(&page, "Zone.Identifier")).unwrap(), "[ZoneTransfer]\r\nZoneId=3\r\n");
        assert_eq!(std::fs::read_to_string(stream_path(&page, "app.data")).unwrap(), "kept");
        let mut names: Vec<String> = named_streams(&page).unwrap().into_iter().map(|(n, _)| n).collect();
        names.sort();
        assert_eq!(names, ["Zone.Identifier", "app.data"]);
        assert!(leftovers(&dir).is_empty());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_long_name_gets_a_temp_name_windows_accepts() {
        let dir = scratch();
        let page = dir.join(format!("{}.md", "n".repeat(220)));
        std::fs::write(&page, "old").unwrap();
        hold(&page).unwrap().replace(b"new").unwrap();
        assert_eq!(std::fs::read_to_string(&page).unwrap(), "new");
        let temp = beside(&page, ASIDE).unwrap();
        assert!(temp.file_name().unwrap().to_string_lossy().encode_utf16().count() < 255);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn asides_of_long_names_sharing_a_prefix_stay_apart() {
        let dir = scratch();
        let long_a = dir.join(format!("{}A.md", "n".repeat(120)));
        let long_b = dir.join(format!("{}B.md", "n".repeat(120)));
        std::fs::write(beside(&long_b, ASIDE).unwrap(), "b's previous").unwrap();
        assert_eq!(orphaned_aside(&long_a), None, "B's aside is not A's");
        assert!(orphaned_aside(&long_b).is_some());
        // A name cut at 99 units (an emoji did not fit) is not mistaken for a whole name.
        let cut = dir.join(format!("{}\u{1F600}tail.md", "x".repeat(99)));
        let aside = beside(&cut, ASIDE).unwrap();
        assert_eq!(aside_target(&dir, &aside.file_name().unwrap().to_string_lossy()), None);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn an_aside_that_is_a_link_is_not_restored() {
        let dir = scratch();
        let outside = scratch();
        let page = dir.join("Page.md");
        let made = std::process::Command::new("cmd").args(["/C", "mklink", "/J"]).arg(beside(&page, ASIDE).unwrap()).arg(&outside).output().unwrap();
        assert!(made.status.success(), "mklink /J needs no admin rights: {}", String::from_utf8_lossy(&made.stderr));
        assert_eq!(orphaned_aside(&page), None);
        std::fs::remove_dir_all(&dir).unwrap();
        std::fs::remove_dir_all(&outside).unwrap();
    }

    #[test]
    fn an_interrupted_save_leaves_an_aside_that_is_found() {
        let dir = scratch();
        let page = dir.join("Page.md");
        let aside = beside(&page, ASIDE).unwrap();
        std::fs::write(&aside, "previous").unwrap();
        std::fs::write(beside(&page, "").unwrap(), "new").unwrap();
        assert_eq!(orphaned_aside(&page), Some(aside.clone()));
        let name = aside.file_name().unwrap().to_string_lossy().into_owned();
        assert_eq!(aside_target(&dir, &name), Some(page.clone()));
        assert_eq!(aside_target(&dir, ".Page.md.hm-0123.tmp"), None, "a new-version temp is not an aside");
        std::fs::write(&page, "x").unwrap();
        assert_eq!(orphaned_aside(&page), None, "the page is there");
        std::fs::remove_file(&page).unwrap();
        std::fs::write(beside(&page, ASIDE).unwrap(), "another").unwrap();
        assert_eq!(orphaned_aside(&page), None, "two asides: not guessed");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn move_no_replace_refuses_an_existing_target() {
        let dir = scratch();
        std::fs::write(dir.join("a.md"), "a").unwrap();
        std::fs::write(dir.join("b.md"), "b").unwrap();
        let e = move_no_replace(&dir.join("a.md"), &dir.join("b.md")).unwrap_err();
        assert!(exists_error(&e), "{e}");
        assert_eq!(std::fs::read_to_string(dir.join("b.md")).unwrap(), "b");
        std::fs::create_dir_all(dir.join("folder")).unwrap();
        move_no_replace(&dir.join("folder"), &dir.join("moved")).unwrap();
        assert!(dir.join("moved").is_dir());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn temp_names_are_recognised() {
        for tag in ["", "old-"] {
            let temp = beside(Path::new(r"C:\nb\Page.md"), tag).unwrap();
            let name = temp.file_name().unwrap().to_string_lossy().into_owned();
            assert!(is_temp(&name), "{name}");
        }
        assert!(!is_temp("Page.md"));
        assert!(!is_temp(".hidden.tmp"));
    }
}
