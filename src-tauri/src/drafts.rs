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
    let path = file_for(dir, key)?;
    match std::fs::read(&path) {
        Ok(bytes) => match serde_json::from_slice(&bytes) {
            Ok(value) => Ok(Some(value)),
            // A damaged draft is moved aside with its bytes, never reported as "no draft" and then written over (Codex
            // final review of a34fafd, D3a).
            Err(_) => {
                let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
                std::fs::rename(&path, path.with_extension(format!("json.damaged-{stamp}"))).map_err(|e| format!("A draft is damaged and could not be moved aside: {e}"))?;
                Ok(None)
            }
        },
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

/// The notebook and path a page draft belongs to.
fn page_of(draft: &Value) -> Option<(String, String)> {
    if draft.get("kind").and_then(Value::as_str) != Some("file") {
        return None;
    }
    Some((draft["target"]["notebook"].as_str()?.to_string(), draft["target"]["path"].as_str()?.to_string()))
}

/// A page draft that moves with its page: the file it is in, and its new key and content.
pub struct Moving {
    from: PathBuf,
    key: String,
    draft: Value,
}

/// The drafts of every page of `notebook` at or below `from`, as they will be once it has moved to `to`.
pub fn moving(dir: &Path, notebook: &str, from: &str, to: &str) -> Vec<Moving> {
    entries(dir)
        .into_iter()
        .filter_map(|(file, mut draft)| {
            let (nb, path) = page_of(&draft)?;
            if nb != notebook {
                return None;
            }
            let new = if path == from { to.to_string() } else { format!("{to}{}", path.strip_prefix(from).filter(|rest| rest.starts_with('/'))?) };
            let key = file_key(notebook, &new);
            draft["target"]["path"] = Value::from(new);
            draft["key"] = Value::from(key.clone());
            Some(Moving { from: file, key, draft })
        })
        .collect()
}

/// Before a move: write each moved draft under its new key, beside the old one. On a failure the copies already
/// written are removed and the move must not happen, so its unsaved edits are never left behind (Codex final review of
/// a34fafd, W1b).
pub fn copy_moved(dir: &Path, moves: &[Moving]) -> Result<(), String> {
    let mut written = Vec::new();
    for m in moves {
        let to = file_for(dir, &m.key)?;
        if to == m.from {
            continue;
        }
        if let Err(e) = put(dir, &m.key, &m.draft) {
            for path in written {
                let _ = std::fs::remove_file(path);
            }
            return Err(format!("Its unsaved edits could not be moved with it, so nothing moved: {e}"));
        }
        written.push(to);
    }
    Ok(())
}

/// After the move: the old drafts go (one whose key did not change is rewritten in place with its new path).
pub fn finish_moved(dir: &Path, moves: &[Moving]) {
    for m in moves {
        match file_for(dir, &m.key) {
            Ok(to) if to == m.from => {
                let _ = put(dir, &m.key, &m.draft);
            }
            _ => {
                let _ = std::fs::remove_file(&m.from);
            }
        }
    }
}

/// The move failed: the copies written for it go, and every draft stays where it was.
pub fn undo_moved(dir: &Path, moves: &[Moving]) {
    for m in moves {
        if let Some(to) = file_for(dir, &m.key).ok().filter(|to| *to != m.from) {
            let _ = std::fs::remove_file(to);
        }
    }
}

/// Drafts written while page keys ignored letter case sit under a lowercased key, which can now be another file's
/// (Codex re-review of fa08348, W1): move each to its page's key. One whose page already has a draft there is set
/// aside as `.json.legacy`, out of every lookup and never written over (Codex final review of a34fafd, W1a).
pub fn migrate(dir: &Path) {
    for (file, mut draft) in entries(dir) {
        let Some((notebook, path)) = page_of(&draft) else { continue };
        let key = file_key(&notebook, &path);
        let Ok(to) = file_for(dir, &key) else { continue };
        if to == file {
            continue;
        }
        if to.exists() {
            let _ = std::fs::rename(&file, file.with_extension("json.legacy"));
            continue;
        }
        draft["key"] = Value::from(key.clone());
        if put(dir, &key, &draft).is_ok() {
            let _ = std::fs::remove_file(&file);
        }
    }
}

/// Every stored draft with the file it is in.
fn entries(dir: &Path) -> Vec<(PathBuf, Value)> {
    let Ok(entries) = std::fs::read_dir(dir) else { return vec![] };
    entries
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .filter_map(|p| Some((p.clone(), serde_json::from_slice(&std::fs::read(&p).ok()?).ok()?)))
        .collect()
}

/// Every stored draft, for "unsaved drafts" recovery after a crash.
pub fn list(dir: &Path) -> Vec<Value> {
    entries(dir).into_iter().map(|(_, draft)| draft).collect()
}

/// Whether a page draft of `notebook` is kept for `path` or anything below it.
pub fn any_under(dir: &Path, notebook: &str, path: &str) -> bool {
    list(dir).iter().filter_map(page_of).any(|(nb, p)| nb == notebook && (p == path || p.strip_prefix(path).is_some_and(|rest| rest.starts_with('/'))))
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

    /// Move the drafts as `file_rename` does around a successful move.
    fn retarget(dir: &Path, notebook: &str, from: &str, to: &str) {
        let moves = moving(dir, notebook, from, to);
        copy_moved(dir, &moves).unwrap();
        finish_moved(dir, &moves);
    }

    fn page(path: &str) -> Value {
        json!({ "key": file_key("nb-1", path), "kind": "file", "target": { "notebook": "nb-1", "path": path }, "mine": path })
    }

    #[test]
    fn a_move_whose_drafts_cannot_be_copied_changes_no_draft() {   // Codex final review of a34fafd, W1b
        let dir = std::env::temp_dir().join(format!("hivemind-drafts-stuck-{}", uuid::Uuid::new_v4().simple()));
        put(&dir, &file_key("nb-1", "Area/A.md"), &page("Area/A.md")).unwrap();
        put(&dir, &file_key("nb-1", "Area/B.md"), &page("Area/B.md")).unwrap();
        let moves = moving(&dir, "nb-1", "Area", "Moved");
        // The second copy's key is taken by a folder, so it fails after the first copy was written.
        std::fs::create_dir_all(file_for(&dir, &moves[1].key).unwrap()).unwrap();
        assert!(copy_moved(&dir, &moves).unwrap_err().contains("nothing moved"));
        assert_eq!(get(&dir, &moves[0].key).unwrap(), None, "the copy written first is removed");
        assert!(get(&dir, &file_key("nb-1", "Area/A.md")).unwrap().is_some());
        assert!(get(&dir, &file_key("nb-1", "Area/B.md")).unwrap().is_some());
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn drafts_under_the_old_lowercased_keys_move_to_their_pages_keys() {   // Codex final review of a34fafd, W1a
        let dir = std::env::temp_dir().join(format!("hivemind-drafts-legacy-{}", uuid::Uuid::new_v4().simple()));
        let legacy = |path: &str| file_key("nb-1", &path.to_lowercase());
        put(&dir, &legacy("Plan.md"), &json!({ "key": legacy("Plan.md"), "kind": "file", "target": { "notebook": "nb-1", "path": "Plan.md" }, "mine": "old" })).unwrap();
        // Other.md already has a draft under its new key: the legacy one is set aside, not written over it.
        put(&dir, &legacy("Other.md"), &json!({ "key": legacy("Other.md"), "kind": "file", "target": { "notebook": "nb-1", "path": "Other.md" }, "mine": "legacy" })).unwrap();
        put(&dir, &file_key("nb-1", "Other.md"), &page("Other.md")).unwrap();
        migrate(&dir);
        let plan = get(&dir, &file_key("nb-1", "Plan.md")).unwrap().unwrap();
        assert_eq!((plan["mine"].as_str(), plan["key"].as_str()), (Some("old"), Some(file_key("nb-1", "Plan.md").as_str())));
        assert_eq!(get(&dir, &file_key("nb-1", "plan.md")).unwrap(), None, "plan.md, another file, no longer sees Plan.md's draft");
        assert_eq!(get(&dir, &file_key("nb-1", "Other.md")).unwrap().unwrap()["mine"], "Other.md");
        assert_eq!(get(&dir, &file_key("nb-1", "other.md")).unwrap(), None);
        assert!(file_for(&dir, &legacy("Other.md")).unwrap().with_extension("json.legacy").is_file(), "kept aside");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn a_damaged_draft_is_set_aside_not_reported_missing_and_overwritten() {   // Codex final review of a34fafd, D3a
        let dir = std::env::temp_dir().join(format!("hivemind-drafts-damaged-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(file_for(&dir, "file-x").unwrap(), b"{\"mine\": \"half").unwrap();
        assert_eq!(get(&dir, "file-x").unwrap(), None);
        put(&dir, "file-x", &json!({ "mine": "new" })).unwrap();
        let aside: Vec<_> = std::fs::read_dir(&dir).unwrap().filter_map(Result::ok).filter(|e| e.file_name().to_string_lossy().contains(".damaged-")).collect();
        assert_eq!(aside.len(), 1);
        assert_eq!(std::fs::read(aside[0].path()).unwrap(), b"{\"mine\": \"half");
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
