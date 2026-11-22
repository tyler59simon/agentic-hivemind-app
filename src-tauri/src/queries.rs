//! Saved views of a folder notebook (NS-7B): one JSON file per view in `.hivemind/queries/<name>.json`, so a view travels with
//! the folder (git, sync) and two views never share a file. The file is the query of the Notes page's "Views" (see
//! `src/features/notes/queries.ts`); this module only keeps and lists the files and checks their names, and reads and writes
//! them as it does the other settings in `.hivemind`: nothing goes through a link or junction.
use crate::files::{atomic, contain};
use serde::Serialize;
use serde_json::Value;
use std::path::Path;

const DIR: &str = ".hivemind/queries";
/// The longest view name, and the most one view file may hold.
const NAME_MAX: usize = 80;
const FILE_MAX: usize = 64 * 1024;
/// The most views a notebook lists.
const LIST_MAX: usize = 500;

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct SavedView {
    pub name: String,
    pub spec: Value,
}

/// A name that is safe as a file name on every system Hivemind runs on, and plain enough to show: no path separator, no
/// character Windows refuses, no leading dot, no trailing space or dot, not a reserved device name.
pub fn check_name(name: &str) -> Result<(), String> {
    let bad = name.is_empty()
        || name.chars().count() > NAME_MAX
        || name != name.trim()
        || name.starts_with('.')
        || name.ends_with('.')
        || name.chars().any(|c| c.is_control() || matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|'));
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    let device = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL") || (stem.len() == 4 && (stem.starts_with("COM") || stem.starts_with("LPT")) && stem.ends_with(|c: char| c.is_ascii_digit()));
    if bad || device {
        return Err(format!("\"{name}\" is not a name a saved view can have: use up to {NAME_MAX} letters, digits, spaces and dashes, with no slash, colon or leading dot"));
    }
    Ok(())
}

/// The views of the notebook at `root`, by name. A file that is not JSON, too large or not an object is left out.
pub fn list(root: &Path) -> Result<Vec<SavedView>, String> {
    let dir = contain::resolve_inside(root, DIR, true)?;
    let read = match std::fs::read_dir(&dir) {
        Ok(read) => read,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("Could not read the saved views: {e}")),
    };
    let mut out = Vec::new();
    for entry in read.flatten() {
        let file = entry.file_name().to_string_lossy().into_owned();
        let Some(name) = file.strip_suffix(".json") else { continue };
        let Ok(meta) = std::fs::symlink_metadata(entry.path()) else { continue };
        if !meta.is_file() || meta.len() as usize > FILE_MAX || check_name(name).is_err() {
            continue;
        }
        let Ok(bytes) = std::fs::read(entry.path()) else { continue };
        if let Ok(spec @ Value::Object(_)) = serde_json::from_slice(bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(&bytes)) {
            out.push(SavedView { name: name.to_string(), spec });
        }
        if out.len() >= LIST_MAX {
            break;
        }
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()).then(a.name.cmp(&b.name)));
    Ok(out)
}

/// Save `spec` as the view `name`, replacing a view of that name.
pub fn save(root: &Path, name: &str, spec: &Value) -> Result<(), String> {
    check_name(name)?;
    if !spec.is_object() {
        return Err("A saved view is a JSON object".into());
    }
    let mut bytes = serde_json::to_vec_pretty(spec).map_err(|e| e.to_string())?;
    bytes.push(b'\n');
    if bytes.len() > FILE_MAX {
        return Err("That view is larger than 64 KB".into());
    }
    let path = contain::resolve_inside(root, &format!("{DIR}/{name}.json"), true)?;
    std::fs::create_dir_all(path.parent().unwrap_or(root)).map_err(|e| format!("Could not make the folder for saved views: {e}"))?;
    atomic::replace(&path, &bytes)
}

/// Remove the view `name`; a view that is not there is already gone.
pub fn delete(root: &Path, name: &str) -> Result<(), String> {
    check_name(name)?;
    let path = contain::resolve_inside(root, &format!("{DIR}/{name}.json"), true)?;
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Could not remove the view {name}: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn scratch() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("hm-views-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_view_is_saved_listed_replaced_and_deleted() {
        let root = scratch();
        assert!(list(&root).unwrap().is_empty(), "no folder yet");
        save(&root, "Active projects", &json!({ "version": 1, "view": "table" })).unwrap();
        save(&root, "board", &json!({ "version": 1, "view": "board" })).unwrap();
        save(&root, "Active projects", &json!({ "version": 1, "view": "board" })).unwrap();
        let views = list(&root).unwrap();
        assert_eq!(views.iter().map(|v| (v.name.as_str(), v.spec["view"].as_str().unwrap())).collect::<Vec<_>>(), [("Active projects", "board"), ("board", "board")]);
        assert!(root.join(".hivemind/queries/Active projects.json").is_file());
        // Files that are not views are left out, not an error.
        std::fs::write(root.join(".hivemind/queries/notes.txt"), "x").unwrap();
        std::fs::write(root.join(".hivemind/queries/broken.json"), "{ not json").unwrap();
        std::fs::write(root.join(".hivemind/queries/list.json"), "[1]").unwrap();
        assert_eq!(list(&root).unwrap().len(), 2);
        delete(&root, "board").unwrap();
        delete(&root, "board").unwrap();
        assert_eq!(list(&root).unwrap().len(), 1);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_name_that_could_leave_the_folder_or_break_on_windows_is_refused() {
        for bad in ["", " lead", "trail ", ".hidden", "dot.", "a/b", "a\\b", "..", "../x", "a:b", "a*b", "a?b", "a\"b", "a<b", "a|b", "CON", "con.txt", "NUL", "COM1", "lpt9", "tab\there", &"x".repeat(81)] {
            assert!(check_name(bad).is_err(), "{bad:?}");
        }
        for ok in ["Active projects", "Q4 plan - 2026", "ünï", "COM10", "console", "a.b"] {
            assert!(check_name(ok).is_ok(), "{ok:?}");
        }
        let root = scratch();
        assert!(save(&root, "../escape", &json!({})).is_err());
        assert!(!root.join("escape.json").exists());
        assert!(save(&root, "ok", &json!([1])).unwrap_err().contains("object"));
        assert!(save(&root, "big", &json!({ "text": "x".repeat(FILE_MAX) })).unwrap_err().contains("64 KB"));
        assert!(!root.join(".hivemind/queries/big.json").exists());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn a_junction_in_place_of_the_folder_is_not_followed() {
        let root = scratch();
        let outside = scratch();
        std::fs::write(outside.join("Stolen.json"), "{}").unwrap();
        std::fs::create_dir_all(root.join(".hivemind")).unwrap();
        let made = std::process::Command::new("cmd").args(["/C", "mklink", "/J"]).arg(root.join(".hivemind/queries")).arg(&outside).output();
        if !made.is_ok_and(|o| o.status.success()) {
            std::fs::remove_dir_all(&root).ok();
            std::fs::remove_dir_all(&outside).ok();
            return;
        }
        assert!(list(&root).is_err());
        assert!(save(&root, "x", &json!({})).is_err());
        assert!(!outside.join("x.json").exists());
        std::fs::remove_dir(root.join(".hivemind/queries")).ok();
        std::fs::remove_dir_all(&root).ok();
        std::fs::remove_dir_all(&outside).ok();
    }
}
