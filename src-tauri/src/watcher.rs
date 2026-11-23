//! Watch the store's note folders (read-only) so the UI refreshes when agents write.
use notify_debouncer_mini::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
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
        && (parts[1] == "notes" || parts[1] == "archive") && parts.last().is_some_and(|name| name.ends_with(".md"));
    is_note.then(|| parts[0].clone())
}

/// Files of one Living Memory notebook that changed (NS-2C): paths inside the notebook, `/`-separated.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct DocsChanged {
    pub domain: String,
    pub notebook: String,
    pub paths: Vec<String>,
}

/// The notebook a changed path belongs to, if it lies under `domains/<d>/notebooks/<nb>/` or `domains/<d>/folder-proposals/<nb>/`:
/// its domain, notebook and path. Folder proposals carry a `.folder-proposals/` prefix so the UI refreshes proposals without
/// treating the folder notebook's `nb-` id as a store notebook.
pub fn doc_change(domains_dir: &Path, path: &Path) -> Option<(String, String, String)> {
    let rel = path.strip_prefix(domains_dir).ok()?;
    let parts: Vec<String> = rel
        .components()
        .filter_map(|c| match c {
            Component::Normal(s) => Some(s.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect();
    if parts.len() < 4 {
        return None;
    }
    if parts[1] == "notebooks" {
        return Some((parts[0].clone(), parts[2].clone(), parts[3..].join("/")));
    }
    if parts[1] == "folder-proposals" {
        return Some((parts[0].clone(), parts[2].clone(), format!(".folder-proposals/{}", parts[3..].join("/"))));
    }
    None
}

/// Changed notebook files grouped by notebook.
pub fn docs_changed(domains_dir: &Path, paths: impl IntoIterator<Item = impl AsRef<Path>>) -> Vec<DocsChanged> {
    let mut by: BTreeMap<(String, String), BTreeSet<String>> = BTreeMap::new();
    for path in paths {
        if let Some((domain, notebook, rel)) = doc_change(domains_dir, path.as_ref()) {
            by.entry((domain, notebook)).or_default().insert(rel);
        }
    }
    by.into_iter().map(|((domain, notebook), paths)| DocsChanged { domain, notebook, paths: paths.into_iter().collect() }).collect()
}

/// Store-level config files the UI cares about, when a changed path is one of them directly under the store root.
pub fn store_file(root: &Path, path: &Path) -> Option<String> {
    let name = path.file_name()?.to_str()?;
    (path.parent()? == root && matches!(name, "projects.json" | "systems.json" | "views.json" | "tag_taxonomy.json" | "note_types.json")).then(|| name.to_string())
}

/// Watch note folders (recursively) and the store root (non-recursively, for config files).
/// `on_change` gets affected domains; `on_store` gets changed config file names; `on_docs` gets changed notebook files.
pub fn watch_all(
    root: &Path,
    on_change: impl Fn(Vec<String>) + Send + 'static,
    on_store: impl Fn(Vec<String>) + Send + 'static,
    on_docs: impl Fn(Vec<DocsChanged>) + Send + 'static,
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
            let docs = docs_changed(&base, events.iter().map(|e| e.path.as_path()));
            if !docs.is_empty() {
                on_docs(docs);
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
    fn notebook_files_map_to_their_notebook() {
        let base = PathBuf::from("store").join("domains");
        let nb = base.join("demo").join("notebooks").join("plans");
        assert_eq!(doc_change(&base, &nb.join("Ideas").join("First.md")), Some(("demo".into(), "plans".into(), "Ideas/First.md".into())));
        assert_eq!(doc_change(&base, &nb.join("assets").join("1a2b-pic.png")).map(|c| c.2).as_deref(), Some("assets/1a2b-pic.png"));
        assert_eq!(doc_change(&base, &nb.join("notebook.json")).map(|c| c.2).as_deref(), Some("notebook.json"));
        assert_eq!(doc_change(&base, &nb.join(".proposals").join("abc.json")).map(|c| c.2).as_deref(), Some(".proposals/abc.json"));
        assert_eq!(
            doc_change(&base, &base.join("demo").join("folder-proposals").join("nb-1234567890").join("abcdef123456.json")),
            Some(("demo".into(), "nb-1234567890".into(), ".folder-proposals/abcdef123456.json".into())),
        );
        assert_eq!(doc_change(&base, &nb), None, "the notebook folder itself");
        assert_eq!(doc_change(&base, &base.join("demo").join("docs.sqlite3")), None);
        assert_eq!(doc_change(&base, &base.join("demo").join("docs.sqlite3-wal")), None);
        assert_eq!(doc_change(&base, &base.join("demo").join("notebook-sync.json")), None);
        assert_eq!(doc_change(&base, &base.join("demo").join("notes").join("a.md")), None, "notes are not pages");
        assert_eq!(note_domain(&base, &nb.join("Ideas").join("First.md")), None, "pages are not notes");
        let grouped = docs_changed(&base, [nb.join("B.md"), nb.join("A.md"), nb.join("A.md"), base.join("jot").join("notebooks").join("daily").join("Today.md")]);
        assert_eq!(grouped.len(), 2);
        assert_eq!(grouped[0], DocsChanged { domain: "demo".into(), notebook: "plans".into(), paths: vec!["A.md".into(), "B.md".into()] });
    }

    #[test]
    fn only_store_config_files_count() {
        let root = PathBuf::from("store");
        assert_eq!(store_file(&root, &root.join("projects.json")).as_deref(), Some("projects.json"));
        assert_eq!(store_file(&root, &root.join("systems.json")).as_deref(), Some("systems.json"));
        assert_eq!(store_file(&root, &root.join("tag_taxonomy.json")).as_deref(), Some("tag_taxonomy.json"));
        assert_eq!(store_file(&root, &root.join("views.json")).as_deref(), Some("views.json"));
        assert_eq!(store_file(&root, &root.join("note_types.json")).as_deref(), Some("note_types.json"));
        assert_eq!(store_file(&root, &root.join(".projects.json.tmp")), None);
        assert_eq!(store_file(&root, &root.join(".changes.json.tmp")), None);
        assert_eq!(store_file(&root, &root.join("changes.json")), None);
        assert_eq!(store_file(&root, &root.join(".tag_taxonomy.json")), None);
        assert_eq!(store_file(&root, &root.join("projects.json.bak")), None);
        assert_eq!(store_file(&root, &root.join("domains").join("projects.json")), None);
    }
}
