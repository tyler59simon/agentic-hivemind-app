//! Places no file command may touch, whatever path led there: the Living Memory store (only Living Memory writes
//! it), the Obsidian vaults Living Memory manages (it rewrites their files), and Hivemind's own data folders (the
//! notebook registry decides which folders the webview may reach).
use crate::folders::plain;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// Folders checked before deciding a folder holds no managed vault.
const MAX_SCAN: usize = 200_000;

pub struct Protected {
    store: Option<PathBuf>,
    vaults: Vec<PathBuf>,
    app: Vec<PathBuf>,
}

static APP_DIRS: OnceLock<Vec<PathBuf>> = OnceLock::new();

/// Hivemind's own data, config and webview folders, set once at startup (Codex review of 32fd236, P1).
pub fn set_app_dirs(dirs: Vec<PathBuf>) {
    let _ = APP_DIRS.set(dirs);
}

/// A comparable spelling: canonical where the path exists (else its deepest existing ancestor plus the rest),
/// without the `\\?\` prefix, in lowercase.
fn key(path: &Path) -> PathBuf {
    PathBuf::from(real(path).to_string_lossy().to_lowercase())
}

/// The canonical spelling of `path` (its deepest existing ancestor plus the rest) without the `\\?\` prefix, in the
/// case the file system has: probes for marker files use it, since a case-sensitive folder would not find them under
/// the lowercase spelling (Codex review of 52051c8, P3).
fn real(path: &Path) -> PathBuf {
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
    PathBuf::from(plain(&full))
}

/// A folder carrying the markers Living Memory writes into a vault it manages.
pub fn is_marked_vault(dir: &Path) -> bool {
    ["vault.json", "copies.json"].iter().any(|m| dir.join(".living-memory").join(m).is_file())
}

/// A folder (or an ancestor) that is a marked vault.
fn marked_vault(path: &Path) -> bool {
    path.ancestors().any(is_marked_vault)
}

/// Refuse moving or deleting `dir` while a vault Living Memory manages is anywhere inside it (Codex review of
/// 32fd236, P3). Links are not followed. A folder that cannot be read refuses too, since it was not checked (Codex
/// re-review of c496e1c, P3).
pub fn check_no_vault_inside(dir: &Path) -> Result<(), String> {
    let unreadable = |p: &Path, e: std::io::Error| format!("Hivemind could not check {} for a managed vault before moving or deleting it: {e}", p.display());
    let mut stack = vec![dir.to_path_buf()];
    let mut seen = 0usize;
    while let Some(next) = stack.pop() {
        if is_marked_vault(&next) {
            return Err("This folder holds an Obsidian vault that Living Memory manages, so Hivemind does not move or delete it".into());
        }
        for entry in std::fs::read_dir(&next).map_err(|e| unreadable(&next, e))? {
            let entry = entry.map_err(|e| unreadable(&next, e))?;
            seen += 1;
            if seen > MAX_SCAN {
                return Err("This folder is too large for Hivemind to check before moving or deleting it".into());
            }
            let kind = entry.file_type().map_err(|e| unreadable(&entry.path(), e))?;
            if kind.is_dir() && !kind.is_symlink() {
                stack.push(entry.path());
            }
        }
    }
    Ok(())
}

const RESERVED: &[&str] = &[".git", ".obsidian", ".hivemind"];

/// Why `path` lies in a reserved folder (`.git`, `.obsidian`, `.hivemind`), which the file service writes only for the
/// sidecar and the trash (README 5.3). Loose files there open read-only, and Save As refuses them (Codex re-review of
/// fa08348, P1).
pub fn reserved(path: &Path) -> Option<String> {
    path.components().find_map(|part| match part {
        std::path::Component::Normal(name) => {
            let name = name.to_string_lossy().to_lowercase();
            RESERVED.contains(&name.as_str()).then(|| format!("This is inside a {name} folder, which Hivemind does not edit"))
        }
        _ => None,
    })
}

impl Protected {
    /// The protected places for the store at `store` (None when Hivemind does not know it).
    pub fn new(store: Option<&Path>) -> Self {
        let vaults = store.map(crate::notebooks::managed_vaults).unwrap_or_default().iter().map(|v| key(v)).collect();
        let app = APP_DIRS.get().map(|dirs| dirs.iter().map(|d| key(d)).collect()).unwrap_or_default();
        Protected { store: store.map(key), vaults, app }
    }

    /// Also protect `dir` as one of Hivemind's own folders.
    #[cfg(test)]
    pub fn with_app(mut self, dir: &Path) -> Self {
        self.app.push(key(dir));
        self
    }

    /// Refuse a path inside the store, a managed vault or Hivemind's own data.
    pub fn check(&self, path: &Path) -> Result<(), String> {
        let real = real(path);
        let path = PathBuf::from(real.to_string_lossy().to_lowercase());
        if self.app.iter().any(|app| path.starts_with(app)) {
            return Err("This is inside Hivemind's own data folder, which notebooks cannot reach".into());
        }
        if self.store.as_ref().is_some_and(|store| path.starts_with(store)) {
            return Err("This is inside the Living Memory store, which only Living Memory changes".into());
        }
        if self.vaults.iter().any(|v| path.starts_with(v)) || marked_vault(&real) {
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
        if self.app.iter().any(|app| app.starts_with(&root)) {
            return Err("This folder holds Hivemind's own data, so it cannot be a notebook".into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reserved_folders_are_named_whatever_their_case() {   // Codex re-review of fa08348, P1
        assert!(reserved(Path::new(r"C:\code\repo\.git\config")).unwrap().contains(".git folder"));
        assert!(reserved(Path::new(r"C:\vault\.Obsidian\app.json")).unwrap().contains(".obsidian folder"));
        assert!(reserved(Path::new(r"C:\code\repo\.github\ci.yml")).is_none());
    }

    #[cfg(windows)]
    #[test]
    fn a_marked_vault_in_a_case_sensitive_folder_is_protected() {   // Codex review of 52051c8, P3
        let base = std::fs::canonicalize(std::env::temp_dir()).unwrap().join(format!("hm-guard-case-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&base).unwrap();
        let made = std::process::Command::new("fsutil").args(["file", "setCaseSensitiveInfo"]).arg(&base).arg("enable").output().unwrap();
        assert!(made.status.success(), "fsutil could not make a case-sensitive folder: {}", String::from_utf8_lossy(&made.stdout));
        std::fs::create_dir_all(base.join("CaseVault/.living-memory")).unwrap();
        std::fs::write(base.join("CaseVault/.living-memory/vault.json"), "{}").unwrap();
        let none = Protected::new(None);
        assert!(none.check(&base.join("CaseVault/note.md")).unwrap_err().contains("Obsidian vault"));
        assert!(none.check(&base.join("Other/note.md")).is_ok());
        std::fs::remove_dir_all(&base).unwrap();
    }

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

    #[test]
    fn hiveminds_own_data_cannot_be_a_notebook_or_reached_from_one() {
        let base = std::fs::canonicalize(std::env::temp_dir()).unwrap().join(format!("hm-guard-app-{}", uuid::Uuid::new_v4()));
        let app = base.join("Roaming").join("dev.hivemind.app");
        std::fs::create_dir_all(&app).unwrap();
        std::fs::write(app.join("notebooks.json"), "{}").unwrap();
        let protected = Protected::new(None).with_app(&app);
        assert!(protected.check_root(&app).is_err(), "the data folder itself");
        assert!(protected.check_root(&base.join("Roaming")).unwrap_err().contains("own data"), "a folder holding it");
        assert!(protected.check(&app.join("notebooks.json")).is_err());
        assert!(protected.check_root(&base.join("Notes")).is_ok());
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn a_folder_holding_a_marked_vault_cannot_move() {
        let base = std::env::temp_dir().join(format!("hm-guard-tree-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(base.join("Area/Deep/Vault/.living-memory")).unwrap();
        std::fs::create_dir_all(base.join("Plain/Sub")).unwrap();
        std::fs::write(base.join("Area/Deep/Vault/.living-memory/copies.json"), "{}").unwrap();
        assert!(check_no_vault_inside(&base.join("Area")).is_err());
        assert!(check_no_vault_inside(&base.join("Plain")).is_ok());
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn a_folder_hivemind_cannot_list_is_not_moved_unchecked() {
        // Codex re-review of c496e1c, P3: the user denies themselves listing one subfolder (no admin rights needed).
        let base = std::env::temp_dir().join(format!("hm-guard-closed-{}", uuid::Uuid::new_v4()));
        let closed = base.join("Area/Closed");
        std::fs::create_dir_all(&closed).unwrap();
        let user = std::env::var("USERNAME").unwrap();
        let icacls = |args: &[&str]| std::process::Command::new("icacls").arg(&closed).args(args).output().unwrap();
        assert!(icacls(&["/deny", &format!("{user}:(RD)")]).status.success());
        let checked = check_no_vault_inside(&base.join("Area"));
        icacls(&["/remove:d", &user]);
        assert!(checked.unwrap_err().contains("could not check"));
        std::fs::remove_dir_all(&base).unwrap();
    }
}
