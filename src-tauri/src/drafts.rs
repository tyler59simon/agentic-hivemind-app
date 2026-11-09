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

pub fn put(dir: &Path, key: &str, value: &Value) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let path = file_for(dir, key)?;
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, serde_json::to_vec(value).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
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
}
