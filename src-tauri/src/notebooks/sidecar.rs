//! The notebook's own settings file, `.hivemind/notebook.json`, written only when the user changes a setting.
//! A folder Hivemind cannot write keeps the same JSON in `app_data/notebook-meta/<id>.json` instead.
use crate::files::{atomic, contain};
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};

pub const REL: &str = ".hivemind/notebook.json";
const MAX_BYTES: usize = 1024 * 1024;

/// In the fallback only: the sha256 of the notebook copy it replaced ("none" when there was none). Kept inside the
/// fallback's own JSON, so the two are always written together (Codex re-review of b82e9ab, P5b).
const BASE_KEY: &str = "hivemindReplaced";

fn parse_object(bytes: &[u8]) -> Option<Map<String, Value>> {
    match serde_json::from_slice(bytes).ok()? {
        Value::Object(map) => Some(map),
        _ => None,
    }
}

/// Where b82e9ab kept the base hash, beside the fallback. Read for fallbacks it wrote, removed on the next write.
fn old_base_of(fallback: &Path) -> PathBuf {
    fallback.with_extension("base")
}

fn sha_of(bytes: Option<&[u8]>) -> String {
    bytes.map(crate::files::sha256).unwrap_or_else(|| "none".into())
}

/// The notebook copy as read now: its path and bytes.
fn notebook_copy(root: &Path) -> (Option<PathBuf>, Option<Vec<u8>>) {
    let path = contain::resolve_inside(root, REL, false).ok();
    let bytes = path.as_deref().and_then(|p| std::fs::read(p).ok());
    (path, bytes)
}

/// The settings that count, given the notebook copy's bytes. The fallback counts while the notebook copy is still the
/// one it replaced; once the notebook copy changes (another machine, a git pull), the notebook copy counts. Recorded
/// by content, not by modification time, so clock skew cannot pick the wrong one (Codex reviews of 32fd236 and
/// c496e1c, P5). A fallback from before the hash (c496e1c) keeps its old rule: it counts when it is at least as new as
/// the notebook copy (Codex re-review of b82e9ab, P5a).
fn current(copy: (Option<&Path>, Option<&[u8]>), fallback: &Path) -> Map<String, Value> {
    let (copy_path, copy_bytes) = copy;
    let notebook = copy_bytes.and_then(parse_object);
    let Some(mut saved) = std::fs::read(fallback).ok().and_then(|b| parse_object(&b)) else { return notebook.unwrap_or_default() };
    let replaced = match saved.remove(BASE_KEY) {
        Some(Value::String(sha)) => Some(sha),
        _ => std::fs::read_to_string(old_base_of(fallback)).ok().map(|s| s.trim().to_string()),
    };
    let counts = match replaced {
        Some(sha) => sha == sha_of(copy_bytes),
        None => {
            let modified = |p: &Path| std::fs::metadata(p).and_then(|m| m.modified()).ok();
            match (copy_path.and_then(modified), modified(fallback)) {
                (Some(notebook), Some(app)) => app >= notebook,
                _ => true,
            }
        }
    };
    if counts { saved } else { notebook.unwrap_or(saved) }
}

/// The settings of the notebook at `root`; `fallback` is its app-data copy (see `current`). An unreadable file reads
/// as empty.
pub fn read(root: &Path, fallback: &Path) -> Value {
    let (path, bytes) = notebook_copy(root);
    Value::Object(current((path.as_deref(), bytes.as_deref()), fallback))
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
    // One read of the notebook copy decides both what is merged and which copy the fallback replaces.
    let (copy_path, copy_bytes) = notebook_copy(root);
    let merged = merge(Value::Object(current((copy_path.as_deref(), copy_bytes.as_deref()), fallback)), patch)?;
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
            let _ = std::fs::remove_file(old_base_of(fallback));
            Ok((merged, path))
        }
        Err(_) => {
            if let Some(parent) = fallback.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let mut record = merged.clone();
            if let Value::Object(map) = &mut record {
                map.insert(BASE_KEY.into(), Value::from(sha_of(copy_bytes.as_deref())));
            }
            let mut text = serde_json::to_vec_pretty(&record).map_err(|e| e.to_string())?;
            text.push(b'\n');
            atomic::replace(fallback, &text)?;
            let _ = std::fs::remove_file(old_base_of(fallback));
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
    fn the_fallback_keeps_its_base_inside_and_a_fallback_from_before_the_hash_keeps_the_old_rule() {
        let root = scratch();
        let fallback = root.join("app").join("nb-1.json");
        std::fs::create_dir_all(root.join(".hivemind")).unwrap();
        std::fs::create_dir_all(root.join("app")).unwrap();
        // c496e1c wrote a plain fallback, newer than the notebook copy, and its reader chose it.
        std::fs::write(root.join(".hivemind/notebook.json"), r#"{"version":1,"inbox":"Old.md"}"#).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(&fallback, r#"{"version":1,"inbox":"Kept.md","daily":"YYYY"}"#).unwrap();
        assert_eq!(read(&root, &fallback), json!({ "version": 1, "inbox": "Kept.md", "daily": "YYYY" }));
        // A patch while the folder cannot be written starts from it and records the base inside the same file.
        let notebook_copy = root.join(".hivemind").join("notebook.json");
        #[cfg(windows)]
        let lock = {
            use std::os::windows::fs::OpenOptionsExt;
            std::fs::OpenOptions::new().read(true).share_mode(1).open(&notebook_copy).unwrap()
        };
        write(&root, &fallback, &json!({ "templates": "T" })).unwrap();
        #[cfg(windows)]
        drop(lock);
        let saved: Value = serde_json::from_slice(&std::fs::read(&fallback).unwrap()).unwrap();
        assert_eq!(saved[BASE_KEY], crate::files::sha256(&std::fs::read(&notebook_copy).unwrap()));
        assert!(!old_base_of(&fallback).exists());
        assert_eq!(read(&root, &fallback), json!({ "version": 1, "inbox": "Kept.md", "daily": "YYYY", "templates": "T" }));
        std::fs::remove_dir_all(&root).unwrap();
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
