//! Places no file command may touch, whatever path led there: the Living Memory store (only Living Memory writes
//! it) and the Obsidian vaults Living Memory manages (it rewrites their files).
use crate::folders::plain;
use std::path::{Path, PathBuf};

pub struct Protected {
    store: Option<PathBuf>,
    vaults: Vec<PathBuf>,
}

/// A comparable spelling: canonical where the path exists (else its deepest existing ancestor plus the rest),
/// without the `\\?\` prefix, in lowercase.
fn key(path: &Path) -> PathBuf {
    let mut existing = path.to_path_buf();
    let mut rest = Vec::new();
    while std::fs::canonicalize(&existing).is_err() {
        match (existing.file_name().map(|n| n.to_os_string()), existing.parent()) {
            (Some(name), Some(parent)) => {
                rest.push(name);
                existing = parent.to_path_buf();
            }
            _ => break,
        }
    }
    let mut full = std::fs::canonicalize(&existing).unwrap_or(existing);
    for part in rest.into_iter().rev() {
        full.push(part);
    }
    PathBuf::from(plain(&full).to_lowercase())
}

/// A folder (or an ancestor) carrying the markers Living Memory writes into a vault it manages.
fn marked_vault(path: &Path) -> bool {
    path.ancestors().any(|dir| ["vault.json", "copies.json"].iter().any(|m| dir.join(".living-memory").join(m).is_file()))
}

impl Protected {
    /// The protected places for the store at `store` (None when Hivemind does not know it).
    pub fn new(store: Option<&Path>) -> Self {
        let vaults = store.map(crate::notebooks::managed_vaults).unwrap_or_default().iter().map(|v| key(v)).collect();
        Protected { store: store.map(key), vaults }
    }

    /// Refuse a path inside the store or a managed vault.
    pub fn check(&self, path: &Path) -> Result<(), String> {
        let path = key(path);
        if self.store.as_ref().is_some_and(|store| path.starts_with(store)) {
            return Err("This is inside the Living Memory store, which only Living Memory changes".into());
        }
        if self.vaults.iter().any(|v| path.starts_with(v)) || marked_vault(&path) {
            return Err("This is inside an Obsidian vault that Living Memory manages; edit those notes on the Memory page".into());
        }
        Ok(())
    }

    /// Refuse a notebook root that overlaps the store or a managed vault in either direction.
    pub fn check_root(&self, root: &Path) -> Result<(), String> {
        self.check(root)?;
        let root = key(root);
        if self.store.as_ref().is_some_and(|store| store.starts_with(&root)) {
            return Err("This folder holds the Living Memory store, which Hivemind does not edit as files".into());
        }
        if self.vaults.iter().any(|v| v.starts_with(&root)) {
            return Err("This folder holds an Obsidian vault that Living Memory manages".into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_store_and_managed_vaults_are_protected() {
        let base = std::fs::canonicalize(std::env::temp_dir()).unwrap().join(format!("hm-guard-{}", uuid::Uuid::new_v4()));
        let store = base.join("LivingMemory");
        let vault = base.join("Vault");
        let notes = base.join("Notes");
        for dir in [store.join("domains/demo"), vault.join("Domains"), notes.clone(), base.join("Marked/.living-memory")] {
            std::fs::create_dir_all(dir).unwrap();
        }
        std::fs::write(store.join("domains/demo/sync-state.json"), serde_json::json!({ "vault": plain(&vault) }).to_string()).unwrap();
        std::fs::write(base.join("Marked/.living-memory/copies.json"), "{}").unwrap();
        let protected = Protected::new(Some(&store));

        assert!(protected.check(&store.join("domains/demo/notes/new.md")).is_err(), "inside the store, even where nothing exists yet");
        assert!(protected.check(&vault.join("Domains/x.md")).is_err());
        assert!(protected.check(&base.join("Marked/page.md")).is_err());
        assert!(protected.check(&notes.join("Page.md")).is_ok());
        assert!(protected.check_root(&notes).is_ok());
        assert!(protected.check_root(&base).is_err(), "a folder holding the store");
        assert!(Protected::new(None).check(&store.join("x.md")).is_ok(), "nothing is known without a store");
        std::fs::remove_dir_all(&base).unwrap();
    }
}
