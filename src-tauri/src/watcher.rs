//! Watch the store's note folders (read-only) so the UI refreshes when agents write.
use notify_debouncer_mini::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use std::collections::BTreeSet;
use std::path::{Component, Path};
use std::time::Duration;

/// The domain a changed path belongs to, if it is a note under domains/<d>/notes|archive.
pub fn note_domain(domains_dir: &Path, path: &Path) -> Option<String> {
    let rel = path.strip_prefix(domains_dir).ok()?;
    let parts: Vec<String> = rel
        .components()
        .filter_map(|c| match c {
            Component::Normal(s) => Some(s.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect();
    let is_note = parts.len() >= 3
        && (parts[1] == "notes" || parts[1] == "archive")
        && parts.last().is_some_and(|name| name.ends_with(".md"));
    is_note.then(|| parts[0].clone())
}

/// Store-level config files the UI cares about, when a changed path is one of them directly under the store root.
pub fn store_file(root: &Path, path: &Path) -> Option<String> {
    let name = path.file_name()?.to_str()?;
    (path.parent()? == root && (name == "projects.json" || name == "tag_taxonomy.json")).then(|| name.to_string())
}

/// Watch note folders (recursively) and the store root (non-recursively, for config files).
/// `on_change` gets affected domains; `on_store` gets changed config file names.
pub fn watch_all(
    root: &Path,
    on_change: impl Fn(Vec<String>) + Send + 'static,
    on_store: impl Fn(Vec<String>) + Send + 'static,
) -> Result<Debouncer<RecommendedWatcher>, String> {
    let domains_dir = root.join("domains");
    let base = domains_dir.clone();
    let store = root.to_path_buf();
    let mut debouncer = new_debouncer(Duration::from_millis(400), move |result: DebounceEventResult| {
        if let Ok(events) = result {
            let changed: BTreeSet<String> = events.iter().filter_map(|e| note_domain(&base, &e.path)).collect();
            if !changed.is_empty() {
                on_change(changed.into_iter().collect());
            }
            let files: BTreeSet<String> = events.iter().filter_map(|e| store_file(&store, &e.path)).collect();
            if !files.is_empty() {
                on_store(files.into_iter().collect());
            }
        }
    })
    .map_err(|e| e.to_string())?;
    debouncer
        .watcher()
        .watch(&domains_dir, RecursiveMode::Recursive)
        .map_err(|e| format!("Cannot watch {}: {e}", domains_dir.display()))?;
    debouncer
        .watcher()
        .watch(root, RecursiveMode::NonRecursive)
        .map_err(|e| format!("Cannot watch {}: {e}", root.display()))?;
    Ok(debouncer)
}

pub fn watch(root: &Path, on_change: impl Fn(Vec<String>) + Send + 'static) -> Result<Debouncer<RecommendedWatcher>, String> {
    watch_all(root, on_change, |_| {})
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn only_note_files_count() {
        let base = PathBuf::from("store").join("domains");
        let note = base.join("demo").join("notes").join("KNOWLEDGE - x-1234abcd.md");
        assert_eq!(note_domain(&base, &note).as_deref(), Some("demo"));
        assert_eq!(note_domain(&base, &base.join("demo").join("archive").join("a.md")).as_deref(), Some("demo"));
        assert_eq!(note_domain(&base, &base.join("demo").join("search.sqlite3")), None);
        assert_eq!(note_domain(&base, &base.join("demo").join("staged").join("a.md")), None);
        assert_eq!(note_domain(&base, &base.join("demo").join("INDEX.md")), None);
    }

    #[test]
    fn only_store_config_files_count() {
        let root = PathBuf::from("store");
        assert_eq!(store_file(&root, &root.join("projects.json")).as_deref(), Some("projects.json"));
        assert_eq!(store_file(&root, &root.join("tag_taxonomy.json")).as_deref(), Some("tag_taxonomy.json"));
        assert_eq!(store_file(&root, &root.join(".projects.json.tmp")), None);
        assert_eq!(store_file(&root, &root.join(".tag_taxonomy.json")), None);
        assert_eq!(store_file(&root, &root.join("projects.json.bak")), None);
        assert_eq!(store_file(&root, &root.join("domains").join("projects.json")), None);
    }
}
