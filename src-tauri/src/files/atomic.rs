//! Whole-file replacement that never leaves a half-written file and, on Windows, never overwrites bytes other than
//! the ones the caller checked.
use std::io::Write;
use std::path::{Path, PathBuf};

const TEMP_MARK: &str = ".hm-";
const TEMP_END: &str = ".tmp";

/// A hidden file beside `path`: `.<name>.hm-<tag><uuid>.tmp`, in the same folder so renames stay on one volume.
fn beside(path: &Path, tag: &str) -> Result<PathBuf, String> {
    let name = path.file_name().ok_or_else(|| format!("{} has no file name", path.display()))?;
    let temp = format!(".{}{TEMP_MARK}{tag}{}{TEMP_END}", name.to_string_lossy(), uuid::Uuid::new_v4().simple());
    Ok(path.with_file_name(temp))
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

#[cfg(windows)]
fn wide(path: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    path.as_os_str().encode_wide().chain(std::iter::once(0)).collect()
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

/// Move `from` to `to`, failing if `to` exists.
#[cfg(windows)]
fn move_no_replace(from: &Path, to: &Path) -> std::io::Result<()> {
    use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_WRITE_THROUGH};
    // SAFETY: both arguments are NUL-terminated wide strings that live until the call returns.
    if unsafe { MoveFileExW(wide(from).as_ptr(), wide(to).as_ptr(), MOVEFILE_WRITE_THROUGH) } == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

impl Held {
    /// Replace the held file with `bytes`. The held file is moved aside through its own handle, so what is replaced
    /// is exactly what the caller read; the new file then takes its name without overwriting anything that appeared
    /// meanwhile, and the old one is deleted.
    #[cfg(windows)]
    pub fn replace(self, bytes: &[u8]) -> Result<(), String> {
        let shown = self.path.display().to_string();
        let temp = write_temp(&self.path, bytes)?;
        let aside = beside(&self.path, "old-")?;
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
