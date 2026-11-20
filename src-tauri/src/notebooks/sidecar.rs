//! The notebook's own settings file, `.hivemind/notebook.json`, written only when the user changes a setting.
//! A folder Hivemind cannot write keeps the same JSON in `app_data/notebook-meta/<id>.json` instead.
use crate::files::{atomic, contain};
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};

pub const REL: &str = ".hivemind/notebook.json";
const MAX_BYTES: usize = 1024 * 1024;

fn read_object(path: &Path) -> Option<Map<String, Value>> {
    let bytes = std::fs::read(path).ok()?;
    match serde_json::from_slice(&bytes).ok()? {
        Value::Object(map) => Some(map),
        _ => None,
    }
}

/// Beside the fallback: the sha256 of the notebook copy the fallback replaced ("none" when there was none).
fn base_of(fallback: &Path) -> PathBuf {
    fallback.with_extension("base")
}

fn sha_of(path: Option<&Path>) -> String {
    path.and_then(|p| std::fs::read(p).ok()).map(|b| crate::files::sha256(&b)).unwrap_or_else(|| "none".into())
}

/// The settings of the notebook at `root`; `fallback` is its app-data copy. The fallback counts while the notebook
/// copy is still the one it replaced; once the notebook copy changes (another machine, a git pull), the notebook copy
/// counts. Recorded by content, not by modification time, so clock skew cannot pick the wrong one (Codex reviews of
/// 32fd236 and c496e1c, P5). An unreadable file reads as empty.
pub fn read(root: &Path, fallback: &Path) -> Value {
    let inside = contain::resolve_inside(root, REL, false).ok();
    let replaced = std::fs::read_to_string(base_of(fallback)).ok();
    let fallback_counts = fallback.is_file() && replaced.is_some_and(|sha| sha.trim() == sha_of(inside.as_deref()));
    let (first, second) = if fallback_counts { (Some(fallback.to_path_buf()), inside) } else { (inside, Some(fallback.to_path_buf())) };
    Value::Object(first.and_then(|p| read_object(&p)).or_else(|| second.and_then(|p| read_object(&p))).unwrap_or_default())
}

/// Merge `patch` (an object) into the settings: a key set to null is removed, every other key replaces the old
/// value, and keys Hivemind does not know are kept. Returns the merged settings.
pub fn merge(current: Value, patch: &Value) -> Result<Value, String> {
    let Value::Object(patch) = patch else { return Err("Notebook settings must be a JSON object".into()) };
    let mut map = match current {
        Value::Object(map) => map,
        _ => Map::new(),
    };
    for (key, value) in patch {
        if key == "version" {
            continue;
        }
        if value.is_null() {
            map.remove(key);
        } else {
            map.insert(key.clone(), value.clone());
        }
    }
    map.insert("version".into(), Value::from(1));
    Ok(Value::Object(map))
}

/// Write the merged settings: into the notebook when possible, else into `fallback`. Returns the settings and where
/// they went.
pub fn write(root: &Path, fallback: &Path, patch: &Value) -> Result<(Value, PathBuf), String> {
    let merged = merge(read(root, fallback), patch)?;
    let mut text = serde_json::to_vec_pretty(&merged).map_err(|e| e.to_string())?;
    text.push(b'\n');
    if text.len() > MAX_BYTES {
        return Err("Notebook settings are larger than 1 MB".into());
    }
    let inside = contain::resolve_inside(root, REL, true).and_then(|path| {
        std::fs::create_dir_all(path.parent().unwrap_or(root)).map_err(|e| e.to_string())?;
        atomic::replace(&path, &text).map(|_| path)
    });
    match inside {
        Ok(path) => {
            // The notebook copy is now the newer one.
            let _ = std::fs::remove_file(fallback);
            let _ = std::fs::remove_file(base_of(fallback));
            Ok((merged, path))
        }
        Err(_) => {
            if let Some(parent) = fallback.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let notebook_copy = contain::resolve_inside(root, REL, false).ok();
            atomic::replace(&base_of(fallback), sha_of(notebook_copy.as_deref()).as_bytes())?;
            atomic::replace(fallback, &text)?;
            Ok((merged, fallback.to_path_buf()))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hm-sidecar-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn unknown_keys_are_kept_and_null_removes() {
        let merged = merge(json!({ "version": 1, "future": { "a": 1 }, "pinned": ["A.md"] }), &json!({ "pinned": null, "icons": { "P": "x" }, "version": 9 })).unwrap();
        assert_eq!(merged, json!({ "version": 1, "future": { "a": 1 }, "icons": { "P": "x" } }));
        assert!(merge(json!({}), &json!([1])).is_err());
    }

    #[test]
    fn writes_into_the_notebook_and_reads_back() {
        let root = scratch();
        let fallback = root.join("app").join("nb-1.json");
        assert_eq!(read(&root, &fallback), json!({}));
        let (merged, path) = write(&root, &fallback, &json!({ "inbox": "Inbox.md" })).unwrap();
        assert_eq!(path, root.join(".hivemind").join("notebook.json"));
        assert_eq!(read(&root, &fallback), merged);
        assert!(!fallback.exists());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn a_fallback_written_beside_a_readable_notebook_copy_is_the_one_read() {
        use std::os::windows::fs::OpenOptionsExt;
        let root = scratch();
        let fallback = root.join("app").join("nb-1.json");
        write(&root, &fallback, &json!({ "inbox": "Inbox.md" })).unwrap();
        // Another program has the notebook copy open without letting anyone replace it.
        let notebook_copy = root.join(".hivemind").join("notebook.json");
        let lock = std::fs::OpenOptions::new().read(true).share_mode(1).open(&notebook_copy).unwrap();
        let (_, path) = write(&root, &fallback, &json!({ "templates": "Templates" })).unwrap();
        assert_eq!(path, fallback);
        assert_eq!(read(&root, &fallback), json!({ "version": 1, "inbox": "Inbox.md", "templates": "Templates" }), "the setting does not revert");
        let (merged, _) = write(&root, &fallback, &json!({ "daily": "YYYY-MM-DD" })).unwrap();
        assert_eq!(merged["templates"], "Templates", "the next patch starts from the fallback");
        drop(lock);
        let (_, path) = write(&root, &fallback, &json!({ "pinned": ["A.md"] })).unwrap();
        assert_eq!(path, notebook_copy);
        assert!(!fallback.exists());
        assert_eq!(read(&root, &fallback)["daily"], "YYYY-MM-DD");
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn the_fallback_wins_whatever_the_clocks_say_until_the_notebook_copy_changes() {
        use std::os::windows::fs::OpenOptionsExt;
        let root = scratch();
        let fallback = root.join("app").join("nb-1.json");
        write(&root, &fallback, &json!({ "inbox": "Inbox.md" })).unwrap();
        let notebook_copy = root.join(".hivemind").join("notebook.json");
        let lock = std::fs::OpenOptions::new().read(true).share_mode(1).open(&notebook_copy).unwrap();
        write(&root, &fallback, &json!({ "templates": "Templates" })).unwrap();
        drop(lock);
        // A synced notebook copy with a timestamp far in the future, but the same content.
        let future = std::time::SystemTime::now() + std::time::Duration::from_secs(86_400 * 365);
        std::fs::File::options().write(true).open(&notebook_copy).unwrap().set_modified(future).unwrap();
        assert_eq!(read(&root, &fallback)["templates"], "Templates");
        // Another machine changed the notebook copy: it counts again.
        std::fs::write(&notebook_copy, r#"{"version":1,"inbox":"Elsewhere.md"}"#).unwrap();
        assert_eq!(read(&root, &fallback), json!({ "version": 1, "inbox": "Elsewhere.md" }));
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_folder_that_refuses_the_write_uses_the_fallback() {
        let root = scratch();
        // A file where the .hivemind folder should be makes the notebook copy impossible.
        std::fs::write(root.join(".hivemind"), "not a folder").unwrap();
        let fallback = root.join("app").join("nb-1.json");
        let (merged, path) = write(&root, &fallback, &json!({ "templates": "Templates" })).unwrap();
        assert_eq!(path, fallback);
        assert_eq!(read(&root, &fallback), merged);
        std::fs::remove_dir_all(&root).unwrap();
    }
}
