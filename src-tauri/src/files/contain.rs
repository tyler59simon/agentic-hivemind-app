//! Paths the webview names inside a folder the user registered. The webview only ever sends a notebook id and a
//! relative, forward-slash path; this module turns that into a real path or refuses it.
use std::path::{Path, PathBuf};

/// Longest name of one path part, in characters.
const MAX_PART: usize = 240;

/// Names Windows maps to devices whatever the extension (`con.txt` opens the console). Includes the superscript
/// digit forms Windows also reserves.
const DEVICES: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$", "COM0", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
    "COM\u{b9}", "COM\u{b2}", "COM\u{b3}", "LPT0", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9", "LPT\u{b9}",
    "LPT\u{b2}", "LPT\u{b3}",
];

/// The parts of a relative path: forward slashes only, every part a plain file name that Windows stores as written.
pub fn check_rel(rel: &str) -> Result<Vec<String>, String> {
    if rel.is_empty() {
        return Err("The path is empty".into());
    }
    rel.split('/').map(|part| check_part(part).map(str::to_string).map_err(|why| format!("\"{rel}\": {why}"))).collect()
}

/// One file or folder name.
pub fn check_part(part: &str) -> Result<&str, &'static str> {
    if part.is_empty() || part == "." || part == ".." {
        return Err("only plain names are allowed, without empty parts, . or ..");
    }
    if part.chars().count() > MAX_PART {
        return Err("a name is longer than 240 characters");
    }
    if part.chars().any(|c| (c as u32) < 32 || matches!(c, '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')) {
        return Err("a name holds a character Windows does not allow (\\ : * ? \" < > | or a control character)");
    }
    if part.ends_with('.') || part.ends_with(' ') {
        return Err("a name ends with a dot or a space, which Windows drops");
    }
    let stem = part.split('.').next().unwrap_or_default().trim_end().to_uppercase();
    if DEVICES.contains(&stem.as_str()) {
        return Err("a name is reserved by Windows for a device");
    }
    Ok(part)
}

/// A symbolic link or junction (a name-surrogate reparse point). Other reparse points, such as OneDrive
/// placeholders, are ordinary files and folders here: notebooks in OneDrive must stay writable.
pub fn is_link(path: &Path) -> bool {
    std::fs::symlink_metadata(path).map(|meta| meta.file_type().is_symlink()).unwrap_or(false)
}

/// `rel` inside `root`. The canonical form of the deepest part that exists must stay inside the canonical root,
/// so a link or junction cannot lead out. For a write (`for_write`), no part below the root may be a link at all.
pub fn resolve_inside(root: &Path, rel: &str, for_write: bool) -> Result<PathBuf, String> {
    let parts = check_rel(rel)?;
    let real_root = std::fs::canonicalize(root).map_err(|e| format!("The notebook folder {} cannot be opened: {e}", root.display()))?;
    let mut full = root.to_path_buf();
    let mut deepest = real_root.clone();
    let mut exists = true;
    for part in &parts {
        full.push(part);
        // Below the first missing part nothing exists, so there is nothing left to check.
        if !exists {
            continue;
        }
        if for_write && is_link(&full) {
            return Err(format!("\"{rel}\" goes through a link or junction, which Hivemind does not write through"));
        }
        match std::fs::canonicalize(&full) {
            Ok(real) => deepest = real,
            Err(_) => exists = false,
        }
    }
    if !deepest.starts_with(&real_root) {
        return Err(format!("\"{rel}\" leads outside the notebook"));
    }
    Ok(full)
}

/// `full` (a path below `root`) as the file system resolves it, relative to the canonical root: the canonical form of
/// its deepest existing part plus the rest. A link inside the notebook shows here as the place it leads to. None when
/// it does not lead below the root.
pub fn resolved_rel(root: &Path, full: &Path) -> Option<String> {
    let real_root = std::fs::canonicalize(root).ok()?;
    let mut existing = full.to_path_buf();
    let mut rest = Vec::new();
    while std::fs::canonicalize(&existing).is_err() {
        rest.push(existing.file_name()?.to_os_string());
        existing = existing.parent()?.to_path_buf();
    }
    let mut real = std::fs::canonicalize(&existing).ok()?;
    for part in rest.into_iter().rev() {
        real.push(part);
    }
    relative(&real_root, &real)
}

/// Whether `path`, a folder recorded earlier in its canonical plain spelling, still names the same place: no folder on
/// it is a link or junction now, and it resolves to itself apart from letter case (a case-only rename keeps it).
pub fn unmoved(path: &Path) -> bool {
    let linked = path.ancestors().any(|p| std::fs::symlink_metadata(p).is_ok_and(|m| m.file_type().is_symlink()));
    !linked && std::fs::canonicalize(path).is_ok_and(|real| crate::folders::plain(&real).to_lowercase() == crate::folders::plain(path).to_lowercase())
}

/// The path of `full` relative to `root`, with forward slashes; None when it is not below `root`.
pub fn relative(root: &Path, full: &Path) -> Option<String> {
    let rest = full.strip_prefix(root).ok()?;
    let parts: Vec<String> = rest.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect();
    (!parts.is_empty()).then(|| parts.join("/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hm-contain-{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn plain_relative_paths_pass() {
        assert_eq!(check_rel("Projects/Roadmap.md").unwrap(), vec!["Projects", "Roadmap.md"]);
        assert_eq!(check_rel(".hivemind/notebook.json").unwrap().len(), 2);
        assert!(check_rel("a b/c.d.md").is_ok());
        assert!(check_rel("console.md").is_ok(), "only the whole stem is a device name");
        assert!(check_rel("COM10.md").is_ok());
    }

    #[test]
    fn anything_else_is_refused() {
        for bad in [
            "", "/abs.md", "a//b.md", "./a.md", "../a.md", "a/../b.md", "a/..", r"a\b.md", "C:x.md", "C:/x.md", "a.md:ads", "CON", "con.txt",
            "Nul .md", "lpt1.log", "COM\u{b9}.md", "CONIN$", "trailing.", "trailing ", "tab\t.md", "q?.md", "star*.md", "pipe|.md",
        ] {
            assert!(check_rel(bad).is_err(), "{bad:?} should be refused");
        }
        assert!(check_rel(&"x".repeat(241)).is_err());
        assert!(check_rel(&"x".repeat(240)).is_ok());
    }

    #[test]
    fn resolves_inside_and_for_new_files() {
        let root = scratch("in");
        std::fs::create_dir_all(root.join("Projects")).unwrap();
        std::fs::write(root.join("Projects/Roadmap.md"), "x").unwrap();
        assert_eq!(resolve_inside(&root, "Projects/Roadmap.md", false).unwrap(), root.join("Projects").join("Roadmap.md"));
        assert_eq!(resolve_inside(&root, "Projects/New.md", true).unwrap(), root.join("Projects").join("New.md"));
        assert_eq!(resolve_inside(&root, "Missing/Deeper/New.md", true).unwrap(), root.join("Missing").join("Deeper").join("New.md"));
        assert!(resolve_inside(&root, "Projects", false).is_ok());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_junction_out_of_the_notebook_is_refused() {
        let root = scratch("junction");
        let outside = scratch("outside");
        std::fs::write(outside.join("secret.md"), "s").unwrap();
        let made = std::process::Command::new("cmd")
            .args(["/d", "/c", "mklink", "/J"])
            .arg(root.join("escape"))
            .arg(&outside)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if made {
            assert!(resolve_inside(&root, "escape/secret.md", false).unwrap_err().contains("outside"));
            assert!(resolve_inside(&root, "escape/new.md", true).unwrap_err().contains("link"));
            assert!(resolve_inside(&root, "escape/new.md", false).unwrap_err().contains("outside"));
        } else {
            eprintln!("skipped: mklink /J is not available here");
        }
        let _ = std::fs::remove_dir(root.join("escape"));
        std::fs::remove_dir_all(&root).unwrap();
        std::fs::remove_dir_all(&outside).unwrap();
    }

    #[test]
    fn a_junction_inside_the_notebook_is_readable_but_not_writable() {
        let root = scratch("inner");
        std::fs::create_dir_all(root.join("real")).unwrap();
        std::fs::write(root.join("real/page.md"), "p").unwrap();
        let made = std::process::Command::new("cmd")
            .args(["/d", "/c", "mklink", "/J"])
            .arg(root.join("alias"))
            .arg(root.join("real"))
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if made {
            assert!(resolve_inside(&root, "alias/page.md", false).is_ok());
            assert!(resolve_inside(&root, "alias/page.md", true).is_err());
        }
        let _ = std::fs::remove_dir(root.join("alias"));
        std::fs::remove_dir_all(&root).unwrap();
    }

    // Uses Windows paths (C:\...), which are relative elsewhere (MACOS-1D).
    #[cfg(windows)]
    #[test]
    fn relative_paths_use_forward_slashes() {
        let root = Path::new(r"C:\nb");
        assert_eq!(relative(root, Path::new(r"C:\nb\a\b.md")).as_deref(), Some("a/b.md"));
        assert_eq!(relative(root, Path::new(r"C:\nb")), None);
        assert_eq!(relative(root, Path::new(r"C:\other\b.md")), None);
    }
}
