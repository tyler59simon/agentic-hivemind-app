//! Watch every registered notebook folder so open pages follow edits made by other programs.
use notify_debouncer_mini::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

/// The sidecar is the one hidden file whose changes the UI hears about (tree order and settings).
pub const SIDECAR: &str = ".hivemind/notebook.json";

#[derive(Clone, Debug)]
pub struct Root {
    pub id: String,
    pub path: PathBuf,
}

/// The `files-changed` event.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Changed {
    pub notebook: String,
    pub paths: Vec<String>,
}

/// The notebook and relative path of a changed file, or None for a path the UI does not show: hidden files and
/// folders (which includes `.git`, `.obsidian`, `.hivemind` and Hivemind's temp files), and `node_modules`.
pub fn locate(roots: &[Root], path: &Path) -> Option<(String, String)> {
    let root = roots.iter().find(|r| path.starts_with(&r.path))?;
    let parts: Vec<String> = path
        .strip_prefix(&root.path)
        .ok()?
        .components()
        .map(|c| match c {
            Component::Normal(s) => Some(s.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect::<Option<_>>()?;
    let rel = parts.join("/");
    if rel.is_empty() {
        return None;
    }
    if rel == SIDECAR {
        return Some((root.id.clone(), rel));
    }
    let hidden = parts.iter().any(|p| p.starts_with('.') || p.eq_ignore_ascii_case("node_modules"));
    (!hidden).then(|| (root.id.clone(), rel))
}

/// Group located paths by notebook.
pub fn group(found: impl IntoIterator<Item = (String, String)>) -> Vec<Changed> {
    let mut by: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for (notebook, rel) in found {
        by.entry(notebook).or_default().insert(rel);
    }
    by.into_iter().map(|(notebook, paths)| Changed { notebook, paths: paths.into_iter().collect() }).collect()
}

/// Watch `roots` recursively; `on_change` gets the changes of one debounce window, one call per notebook (the payload
/// of one `files-changed` event), without Hivemind's own saves.
/// A root that cannot be watched (a removed drive) is skipped and reported in the returned list.
pub fn watch(roots: Vec<Root>, on_change: impl Fn(Changed) + Send + 'static) -> Result<(Debouncer<RecommendedWatcher>, Vec<String>), String> {
    let known = roots.clone();
    let mut debouncer = new_debouncer(Duration::from_millis(400), move |result: DebounceEventResult| {
        if let Ok(events) = result {
            let found = events.iter().filter(|e| !super::is_own_write(&e.path)).filter_map(|e| locate(&known, &e.path));
            for changed in group(found) {
                on_change(changed);
            }
        }
    })
    .map_err(|e| e.to_string())?;
    let mut failed = Vec::new();
    for root in &roots {
        if let Err(e) = debouncer.watcher().watch(&root.path, RecursiveMode::Recursive) {
            failed.push(format!("Cannot watch {}: {e}", root.path.display()));
        }
    }
    Ok((debouncer, failed))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roots() -> Vec<Root> {
        vec![Root { id: "nb-1".into(), path: PathBuf::from(r"C:\Notes") }, Root { id: "nb-2".into(), path: PathBuf::from(r"D:\Journal") }]
    }

    #[test]
    fn an_event_payload_is_one_notebook_object() {
        // src/lib/notebooks.ts FilesChanged: { notebook, paths }, one event per notebook.
        let changed = group([("nb-1".to_string(), "a.md".to_string()), ("nb-2".to_string(), "b.md".to_string())]);
        assert_eq!(serde_json::to_value(&changed[0]).unwrap(), serde_json::json!({ "notebook": "nb-1", "paths": ["a.md"] }));
    }

    // Uses Windows paths (C:\...), which are relative elsewhere (MACOS-1D).
    #[cfg(windows)]
    #[test]
    fn pages_are_located_in_their_notebook() {
        assert_eq!(locate(&roots(), Path::new(r"C:\Notes\Projects\Roadmap.md")), Some(("nb-1".into(), "Projects/Roadmap.md".into())));
        assert_eq!(locate(&roots(), Path::new(r"D:\Journal\2026-11-20.md")), Some(("nb-2".into(), "2026-11-20.md".into())));
        assert_eq!(locate(&roots(), Path::new(r"C:\Notes\.hivemind\notebook.json")), Some(("nb-1".into(), SIDECAR.into())));
    }

    #[test]
    fn hidden_temp_and_outside_paths_are_dropped() {
        for path in [
            r"C:\Notes\.git\index",
            r"C:\Notes\.obsidian\app.json",
            r"C:\Notes\.hivemind\trash\20261120-120000\Old.md",
            r"C:\Notes\.Page.md.hm-0123abcd.tmp",
            r"C:\Notes\.tmpk2j4h1x9.mirror",
            r"C:\Notes\.Page.md.4120-98123456789.aside",
            r"C:\Notes\web\node_modules\x\readme.md",
            r"C:\Other\Page.md",
            r"C:\Notes",
        ] {
            assert_eq!(locate(&roots(), Path::new(path)), None, "{path}");
        }
    }

    #[test]
    fn changes_are_grouped_and_deduplicated() {
        let changed = group(vec![("nb-2".into(), "b.md".into()), ("nb-1".into(), "a.md".into()), ("nb-2".into(), "b.md".into())]);
        assert_eq!(changed, vec![Changed { notebook: "nb-1".into(), paths: vec!["a.md".into()] }, Changed { notebook: "nb-2".into(), paths: vec!["b.md".into()] }]);
    }
}
