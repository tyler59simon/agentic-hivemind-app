//! Test fixtures written as Windows paths (`C:\Notes\a.md`) become native absolute paths elsewhere (`/C/Notes/a.md`), so
//! the same path tests run on macOS (MACOS-1D).

use std::path::PathBuf;

pub fn native_str(path: &str) -> String {
    if cfg!(windows) {
        return path.to_string();
    }
    let path = path.replace('\\', "/");
    match path.as_bytes() {
        [drive, b':', ..] if drive.is_ascii_alphabetic() => format!("/{}{}", *drive as char, &path[2..]),
        _ => path,
    }
}

pub fn native(path: &str) -> PathBuf {
    PathBuf::from(native_str(path))
}

#[test]
fn a_windows_fixture_is_absolute_everywhere() {
    assert!(native(r"C:\Notes\a.md").is_absolute());
    assert_eq!(native(r"C:\Notes\a.md").parent(), Some(native(r"C:\Notes").as_path()));
}
