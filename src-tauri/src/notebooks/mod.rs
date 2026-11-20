//! Folder notebooks: the registry of folders the user picked (`app_data/notebooks.json`) and the page tree of each.
//! Only the native folder dialog adds a notebook, so the webview can never point Hivemind at a folder by itself.
pub mod sidecar;

use crate::files::atomic;
use crate::files::guard::{self, Protected};
use crate::folders::plain;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Text files a notebook shows as editable pages or text files. Everything else opens with the system app.
const PAGE_EXT: &[&str] = &["md", "markdown"];
const TEXT_EXT: &[&str] = &[
    "txt", "log", "json", "yaml", "yml", "toml", "ini", "cfg", "conf", "csv", "tsv", "xml", "html", "css", "js", "ts", "tsx", "jsx", "py", "rs", "go",
    "java", "c", "h", "cpp", "cs", "ps1", "sh", "bat", "sql", "env",
];
const MAX_ENTRIES: usize = 20_000;
const MAX_DEPTH: usize = 12;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Notebook {
    pub id: String,
    pub path: String,
    pub title: String,
    pub added: String,
}

#[derive(Serialize, Deserialize, Default)]
struct File {
    version: u32,
    notebooks: Vec<Notebook>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Dir,
    Page,
    Text,
    Other,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub path: String,
    pub kind: Kind,
    pub size: u64,
    pub mtime_ms: i64,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Tree {
    pub entries: Vec<Entry>,
    /// More than 20,000 entries or deeper than 12 folders: the rest is left out.
    pub truncated: bool,
}

pub struct Registry {
    path: PathBuf,
    lock: Mutex<()>,
}

/// Why `picked` cannot be a notebook beside the registered ones: notebooks may not overlap.
fn overlap(picked: &Path, known: &[Notebook]) -> Option<String> {
    let low = |p: &Path| PathBuf::from(plain(p).to_lowercase());
    let picked_low = low(picked);
    for nb in known {
        let other = low(Path::new(&nb.path));
        if picked_low == other {
            return Some(format!("This folder is already the notebook \"{}\"", nb.title));
        }
        if picked_low.starts_with(&other) || other.starts_with(&picked_low) {
            return Some(format!("This folder overlaps the notebook \"{}\"; notebooks cannot be inside each other", nb.title));
        }
    }
    None
}

/// The vaults Living Memory syncs, from each domain's `sync-state.json`.
pub fn managed_vaults(store: &Path) -> Vec<PathBuf> {
    let Ok(domains) = std::fs::read_dir(store.join("domains")) else { return vec![] };
    domains
        .flatten()
        .filter_map(|d| std::fs::read(d.path().join("sync-state.json")).ok())
        .filter_map(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .filter_map(|state| state.get("vault").and_then(|v| v.as_str()).map(PathBuf::from))
        .collect()
}

fn kind_of(name: &str) -> Kind {
    let ext = Path::new(name).extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    if PAGE_EXT.contains(&ext.as_str()) {
        Kind::Page
    } else if TEXT_EXT.contains(&ext.as_str()) {
        Kind::Text
    } else {
        Kind::Other
    }
}

/// A folder or file the tree never shows.
pub fn hidden(name: &str) -> bool {
    name.starts_with('.') || name.eq_ignore_ascii_case("node_modules") || atomic::is_temp(name)
}

/// Every visible folder and file under `root`, breadth first, folders listed with their contents after them.
pub fn walk(root: &Path) -> Tree {
    let mut entries = Vec::new();
    let mut truncated = false;
    let mut queue = std::collections::VecDeque::from([(root.to_path_buf(), String::new(), 0usize)]);
    while let Some((dir, rel, depth)) = queue.pop_front() {
        let Ok(read) = std::fs::read_dir(&dir) else { continue };
        let mut children: Vec<_> = read.flatten().collect();
        // A page an interrupted save left aside comes back before the folder is listed (Codex review of 32fd236, W2).
        let restored = children.iter().filter_map(|c| atomic::aside_target(&dir, &c.file_name().to_string_lossy())).filter(|page| crate::files::recover(page)).count();
        if restored > 0 {
            let Ok(again) = std::fs::read_dir(&dir) else { continue };
            children = again.flatten().collect();
        }
        children.sort_by_key(|e| e.file_name().to_string_lossy().to_lowercase());
        for child in children {
            let name = child.file_name().to_string_lossy().into_owned();
            if hidden(&name) {
                continue;
            }
            let Ok(meta) = std::fs::symlink_metadata(child.path()) else { continue };
            if meta.file_type().is_symlink() {
                continue;
            }
            // A vault Living Memory manages inside the notebook is not shown (Codex review of 32fd236, P3).
            if meta.is_dir() && guard::is_marked_vault(&child.path()) {
                continue;
            }
            if entries.len() >= MAX_ENTRIES {
                truncated = true;
                break;
            }
            let path = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
            let mtime_ms = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64).unwrap_or(0);
            if meta.is_dir() {
                entries.push(Entry { path: path.clone(), kind: Kind::Dir, size: 0, mtime_ms });
                if depth + 1 < MAX_DEPTH {
                    queue.push_back((child.path(), path, depth + 1));
                } else {
                    truncated = true;
                }
            } else {
                entries.push(Entry { kind: kind_of(&name), path, size: meta.len(), mtime_ms });
            }
        }
    }
    Tree { entries, truncated }
}

/// `nb-` and eight lowercase hex digits, as `Registry::add` makes them.
fn valid_id(id: &str) -> bool {
    id.len() == 11 && id.starts_with("nb-") && id[3..].bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

impl Registry {
    pub fn new(path: PathBuf) -> Self {
        Registry { path, lock: Mutex::new(()) }
    }

    fn load(&self) -> File {
        std::fs::read(&self.path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or(File { version: 1, notebooks: vec![] })
    }

    fn store(&self, file: &File) -> Result<(), String> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let text = serde_json::to_vec_pretty(file).map_err(|e| e.to_string())?;
        atomic::replace(&self.path, &text)
    }

    /// The registered notebooks. An entry whose id is not one Hivemind makes is ignored, since ids name files in app
    /// data (Codex review of 32fd236, P1).
    pub fn list(&self) -> Vec<Notebook> {
        self.load().notebooks.into_iter().filter(|nb| valid_id(&nb.id)).collect()
    }

    pub fn get(&self, id: &str) -> Result<Notebook, String> {
        self.list().into_iter().find(|nb| nb.id == id).ok_or_else(|| "That notebook is no longer registered".to_string())
    }

    /// Register a folder the user picked in the native dialog.
    pub fn add(&self, picked: &Path, store: Option<&Path>, now: &str) -> Result<Notebook, String> {
        let _held = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let real = std::fs::canonicalize(picked).map_err(|e| format!("Could not open {}: {e}", picked.display()))?;
        if !real.is_dir() {
            return Err(format!("{} is not a folder", picked.display()));
        }
        Protected::new(store).check_root(&real)?;
        let mut file = self.load();
        if let Some(why) = overlap(&real, &file.notebooks) {
            return Err(why);
        }
        let path = plain(&real);
        let title = real.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path.clone());
        let id = format!("nb-{}", &uuid::Uuid::new_v4().simple().to_string()[..8]);
        let notebook = Notebook { id, path, title, added: now.to_string() };
        file.version = 1;
        file.notebooks.push(notebook.clone());
        self.store(&file)?;
        Ok(notebook)
    }

    /// Forget a notebook; its files are not touched.
    pub fn remove(&self, id: &str) -> Result<(), String> {
        let _held = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut file = self.load();
        let before = file.notebooks.len();
        file.notebooks.retain(|nb| nb.id != id);
        if file.notebooks.len() == before {
            return Err("That notebook is no longer registered".into());
        }
        self.store(&file)
    }

    pub fn rename(&self, id: &str, title: &str) -> Result<Notebook, String> {
        let title = title.trim();
        if title.is_empty() || title.chars().count() > 120 {
            return Err("A notebook title needs 1 to 120 characters".into());
        }
        let _held = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut file = self.load();
        let nb = file.notebooks.iter_mut().find(|nb| nb.id == id).ok_or("That notebook is no longer registered")?;
        nb.title = title.to_string();
        let done = nb.clone();
        self.store(&file)?;
        Ok(done)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hm-nb-{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::canonicalize(&dir).unwrap()
    }

    #[test]
    fn registering_refuses_the_store_vaults_and_overlaps() {
        let base = scratch("reg");
        let registry = Registry::new(base.join("app").join("notebooks.json"));
        let store = base.join("LivingMemory");
        std::fs::create_dir_all(store.join("domains").join("demo")).unwrap();
        let vault = base.join("Vault");
        std::fs::create_dir_all(vault.join("Domains")).unwrap();
        std::fs::write(store.join("domains/demo/sync-state.json"), serde_json::json!({ "vault": plain(&vault) }).to_string()).unwrap();
        let marked = base.join("Marked");
        std::fs::create_dir_all(marked.join(".living-memory")).unwrap();
        std::fs::write(marked.join(".living-memory/vault.json"), "{}").unwrap();
        let notes = base.join("Notes");
        std::fs::create_dir_all(notes.join("Projects")).unwrap();

        assert!(registry.add(&store, Some(&store), "t").unwrap_err().contains("store"));
        assert!(registry.add(&store.join("domains"), Some(&store), "t").unwrap_err().contains("store"));
        assert!(registry.add(&base, Some(&store), "t").unwrap_err().contains("holds the Living Memory store"));
        assert!(registry.add(&vault, Some(&store), "t").unwrap_err().contains("vault"));
        assert!(registry.add(&vault.join("Domains"), Some(&store), "t").unwrap_err().contains("vault"));
        assert!(registry.add(&marked, Some(&store), "t").unwrap_err().contains("vault"));

        let nb = registry.add(&notes, Some(&store), "2026-11-20T00:00:00Z").unwrap();
        assert!(nb.id.starts_with("nb-") && nb.id.len() == 11 && nb.title == "Notes");
        assert!(registry.add(&notes, Some(&store), "t").unwrap_err().contains("already"));
        assert!(registry.add(&notes.join("Projects"), Some(&store), "t").unwrap_err().contains("overlaps"));
        assert_eq!(registry.list(), vec![nb.clone()]);
        assert_eq!(registry.rename(&nb.id, " Work ").unwrap().title, "Work");
        registry.remove(&nb.id).unwrap();
        assert!(registry.list().is_empty() && notes.join("Projects").is_dir());
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn the_tree_hides_dot_folders_and_classifies_files() {
        let root = scratch("tree");
        for dir in [".git", ".hivemind/trash", ".obsidian", "node_modules/x", "Projects/Roadmap"] {
            std::fs::create_dir_all(root.join(dir)).unwrap();
        }
        for file in ["Inbox.md", "Projects/Roadmap.md", "Projects/Roadmap/Q1.markdown", "notes.txt", "photo.png", ".hidden.md", ".Inbox.md.hm-0a.tmp"] {
            std::fs::write(root.join(file), "x").unwrap();
        }
        let tree = walk(&root);
        let shown: Vec<(&str, &Kind)> = tree.entries.iter().map(|e| (e.path.as_str(), &e.kind)).collect();
        assert_eq!(
            shown,
            vec![
                ("Inbox.md", &Kind::Page),
                ("notes.txt", &Kind::Text),
                ("photo.png", &Kind::Other),
                ("Projects", &Kind::Dir),
                ("Projects/Roadmap", &Kind::Dir),
                ("Projects/Roadmap.md", &Kind::Page),
                ("Projects/Roadmap/Q1.markdown", &Kind::Page),
            ]
        );
        assert!(!tree.truncated);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn the_tree_leaves_out_marked_vaults_and_brings_back_interrupted_saves() {
        let root = scratch("tree2");
        std::fs::create_dir_all(root.join("Area/Vault/.living-memory")).unwrap();
        std::fs::write(root.join("Area/Vault/.living-memory/vault.json"), "{}").unwrap();
        std::fs::write(root.join("Area/Vault/Managed.md"), "x").unwrap();
        std::fs::write(atomic::beside(&root.join("Area/Lost.md"), "old-").unwrap(), "previous").unwrap();
        let shown: Vec<String> = walk(&root).entries.into_iter().map(|e| e.path).collect();
        assert_eq!(shown, ["Area", "Area/Lost.md"]);
        assert_eq!(std::fs::read_to_string(root.join("Area/Lost.md")).unwrap(), "previous");
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn ids_hivemind_did_not_make_are_ignored() {
        let base = scratch("ids");
        let path = base.join("notebooks.json");
        let nb = |id: &str| serde_json::json!({ "id": id, "path": "C:\\x", "title": "x", "added": "t" });
        std::fs::write(&path, serde_json::json!({ "version": 1, "notebooks": [nb("nb-0123abcd"), nb("..\\..\\evil"), nb("nb-XYZ")] }).to_string()).unwrap();
        let ids: Vec<String> = Registry::new(path).list().into_iter().map(|n| n.id).collect();
        assert_eq!(ids, ["nb-0123abcd"]);
        std::fs::remove_dir_all(&base).unwrap();
    }
}
