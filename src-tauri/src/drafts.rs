//! Unsaved edits, kept in the app's data folder (never in the Living Memory store) so they survive a crash.
//! One JSON file per draft key (a note ref, or `new-<tab>` for a note not captured yet).
use serde_json::Value;
use std::path::{Path, PathBuf};

fn file_for(dir: &Path, key: &str) -> Result<PathBuf, String> {
    if key.is_empty() || key.len() > 200 {
        return Err("Invalid draft key".into());
    }
    // Refs look like `domain:uuid`; keep the name readable and portable.
    let name: String = key.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect();
    Ok(dir.join(format!("{name}.json")))
}

/// A draft larger than this is refused (a page's draft holds the text and, under 2 MB, its base too).
pub const MAX_BYTES: usize = 32 * 1024 * 1024;

pub fn put(dir: &Path, key: &str, value: &Value) -> Result<(), String> {
    let bytes = serde_json::to_vec(value).map_err(|e| e.to_string())?;
    if bytes.len() > MAX_BYTES {
        return Err("This draft is larger than 32 MB, so it is not kept".into());
    }
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let path = file_for(dir, key)?;
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&temp, &path).map_err(|e| e.to_string())
}

pub fn get(dir: &Path, key: &str) -> Result<Option<Value>, String> {
    match std::fs::read(file_for(dir, key)?) {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes).ok()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

pub fn delete(dir: &Path, key: &str) -> Result<(), String> {
    match std::fs::remove_file(file_for(dir, key)?) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}

/// The draft key of a notebook page, as `src/documents/keys.ts` computes it: `file-` and the sha256 of its document key.
pub fn file_key(notebook: &str, path: &str) -> String {
    use sha2::{Digest, Sha256};
    // The path keeps its letter case, as the webview's keys do (Codex re-review of fa08348, W1).
    let digest = Sha256::digest(format!("file:{notebook}:{path}").as_bytes());
    format!("file-{}", digest.iter().map(|b| format!("{b:02x}")).collect::<String>())
}

/// After a page or folder of `notebook` moved from `from` to `to`, move the drafts of every page it held, so unsaved
/// edits follow the file even if the app stops before the webview catches up.
pub fn retarget(dir: &Path, notebook: &str, from: &str, to: &str) {
    let moved = |path: &str| {
        if path == from {
            Some(to.to_string())
        } else {
            path.strip_prefix(from).filter(|rest| rest.starts_with('/')).map(|rest| format!("{to}{rest}"))
        }
    };
    for mut draft in list(dir) {
        let Some(target) = draft.get("target").filter(|_| draft.get("kind").and_then(Value::as_str) == Some("file")) else { continue };
        if target.get("notebook").and_then(Value::as_str) != Some(notebook) {
            continue;
        }
        let Some(old) = target.get("path").and_then(Value::as_str).map(str::to_string) else { continue };
        let Some(new) = moved(&old) else { continue };
        let key = file_key(notebook, &new);
        draft["target"]["path"] = Value::from(new);
        draft["key"] = Value::from(key.clone());
        if put(dir, &key, &draft).is_ok() && key != file_key(notebook, &old) {
            let _ = delete(dir, &file_key(notebook, &old));
        }
    }
}

/// Every stored draft, for "unsaved drafts" recovery after a crash.
pub fn list(dir: &Path) -> Vec<Value> {
    let Ok(entries) = std::fs::read_dir(dir) else { return vec![] };
    entries
        .filter_map(Result::ok)
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .filter_map(|e| std::fs::read(e.path()).ok())
        .filter_map(|bytes| serde_json::from_slice(&bytes).ok())
        .collect()
}

/// Whether a page draft of `notebook` is kept for `path` or anything below it.
pub fn any_under(dir: &Path, notebook: &str, path: &str) -> bool {
    list(dir).iter().any(|draft| {
        draft.get("kind").and_then(Value::as_str) == Some("file")
            && draft["target"]["notebook"].as_str() == Some(notebook)
            && draft["target"]["path"].as_str().is_some_and(|p| p == path || p.strip_prefix(path).is_some_and(|rest| rest.starts_with('/')))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn round_trip_list_and_delete() {
        let dir = std::env::temp_dir().join(format!("hivemind-drafts-{}", std::process::id()));
        let value = json!({"key": "demo:1234", "mine": {"body": "text"}});
        put(&dir, "demo:1234", &value).unwrap();
        assert_eq!(get(&dir, "demo:1234").unwrap(), Some(value.clone()));
        assert_eq!(list(&dir), vec![value]);
        delete(&dir, "demo:1234").unwrap();
        delete(&dir, "demo:1234").unwrap(); // deleting twice is fine
        assert_eq!(get(&dir, "demo:1234").unwrap(), None);
        assert!(get(&dir, "").is_err());
        assert!(file_for(&dir, "../../etc/passwd").unwrap().starts_with(&dir));
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn file_drafts_follow_a_move() {
        let dir = std::env::temp_dir().join(format!("hivemind-drafts-move-{}", std::process::id()));
        let draft = |path: &str| json!({ "key": file_key("nb-1", path), "kind": "file", "target": { "notebook": "nb-1", "path": path }, "mine": "x" });
        put(&dir, &file_key("nb-1", "Projects/A.md"), &draft("Projects/A.md")).unwrap();
        put(&dir, &file_key("nb-1", "Other.md"), &draft("Other.md")).unwrap();
        retarget(&dir, "nb-1", "Projects", "Archive/Projects");
        assert_eq!(get(&dir, &file_key("nb-1", "Projects/A.md")).unwrap(), None);
        let moved = get(&dir, &file_key("nb-1", "Archive/Projects/A.md")).unwrap().unwrap();
        assert_eq!(moved["target"]["path"], "Archive/Projects/A.md");
        assert!(get(&dir, &file_key("nb-1", "Other.md")).unwrap().is_some());
        // A case-only rename moves the draft to the new spelling's key.
        retarget(&dir, "nb-1", "Other.md", "other.md");
        assert_eq!(get(&dir, &file_key("nb-1", "other.md")).unwrap().unwrap()["target"]["path"], "other.md");
        assert_eq!(get(&dir, &file_key("nb-1", "Other.md")).unwrap(), None);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn the_file_key_matches_the_webview() {
        // sha256 of "file:nb-1:Projects/A.md", computed outside Rust; src/documents/keys.test.ts checks the same value.
        assert_eq!(file_key("nb-1", "Projects/A.md"), "file-16d2a638270cf6584f1fae6209b8cae20d85327e77e3f1371b6172d17e4f491c");
        assert_ne!(file_key("nb-1", "A.txt"), file_key("nb-1", "a.txt"), "two files in a case-sensitive folder");
    }

    #[test]
    fn a_draft_at_or_below_a_path_is_found() {   // Codex re-review of fa08348, F2
        let dir = std::env::temp_dir().join(format!("hivemind-drafts-under-{}", std::process::id()));
        let draft = |path: &str| json!({ "key": file_key("nb-1", path), "kind": "file", "target": { "notebook": "nb-1", "path": path }, "mine": "x" });
        put(&dir, &file_key("nb-1", "Area/B.md"), &draft("Area/B.md")).unwrap();
        assert!(any_under(&dir, "nb-1", "Area/B.md"));
        assert!(any_under(&dir, "nb-1", "Area"));
        assert!(!any_under(&dir, "nb-1", "Are"));
        assert!(!any_under(&dir, "nb-2", "Area"));
        assert!(!any_under(&dir, "nb-1", "area/b.md"), "letter case counts, as in the keys");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn drafts_over_the_cap_are_refused() {
        let dir = std::env::temp_dir().join(format!("hivemind-drafts-cap-{}", std::process::id()));
        let big = json!({ "mine": "x".repeat(MAX_BYTES) });
        assert!(put(&dir, "file-abc", &big).unwrap_err().contains("32 MB"));
        assert_eq!(get(&dir, "file-abc").unwrap(), None);
        std::fs::remove_dir_all(dir).ok();
    }
}
