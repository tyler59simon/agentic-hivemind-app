//! Pictures pasted into a page or dropped on it, saved as attachments of its notebook (NS-3A). A folder notebook gets
//! the file in its attachments folder under a name no other file has; a Living Memory page gets it through
//! `doc attach`. Either way the caller links the returned path, relative to the notebook's root.
use std::io::Write;
use std::path::Path;

/// The largest picture Hivemind attaches, as Living Memory's own asset cap.
pub const MAX_BYTES: u64 = 25 * 1024 * 1024;
/// Picture kinds the `hmfile` scheme serves (`assets::content_type`), less icons.
const PICTURES: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "svg"];
/// Characters no file name may hold on Windows, and Living Memory's page-name rules (`docs._check_part`).
const BAD: &[char] = &['/', '\\', ':', '*', '?', '"', '<', '>', '|'];
const DEVICES: &[&str] = &["con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9"];
/// Room for Living Memory's `<sha8>-` prefix and a ` 99` suffix within its 120-character part limit.
const NAME_KEEP: usize = 100;

/// Whether `name` is a picture by its extension.
pub fn is_picture(name: &str) -> bool {
    Path::new(name).extension().map(|e| e.to_string_lossy().to_lowercase()).is_some_and(|e| PICTURES.contains(&e.as_str()))
}

/// A file name both Windows and Living Memory take: forbidden and control characters become `-`, outer spaces and
/// trailing dots go, a device name gets a `_` in front, and a long name is cut before its extension. Only pictures.
pub fn clean_name(name: &str) -> Result<String, String> {
    let mapped: String = name.chars().map(|c| if BAD.contains(&c) || c.is_control() { '-' } else { c }).collect();
    let trimmed = mapped.trim().trim_end_matches(['.', ' ']).to_string();
    let path = Path::new(&trimmed);
    let ext = path.extension().map(|e| e.to_string_lossy().into_owned()).unwrap_or_default();
    let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let stem = stem.trim();
    if stem.is_empty() || !is_picture(&trimmed) {
        return Err(format!("{name} is not a picture Hivemind can attach (PNG, JPEG, GIF, WebP, AVIF, BMP or SVG)"));
    }
    let keep = NAME_KEEP.saturating_sub(ext.chars().count() + 1);
    let mut stem: String = stem.chars().take(keep).collect::<String>().trim_end_matches(['.', ' ']).to_string();
    if DEVICES.contains(&stem.to_lowercase().as_str()) {
        stem.insert(0, '_');
    }
    Ok(format!("{stem}.{ext}"))
}

/// The attachments folder of `page`, relative to the notebook's root, from the notebook's `attachments` setting:
/// unset or empty is `attachments`; `/` is the root itself; `./` and `./sub` are the page's own folder and a folder in
/// it; anything else is a folder from the root. `..` never counts.
pub fn folder_for(setting: Option<&str>, page: &str) -> Result<String, String> {
    let setting = setting.map(str::trim).filter(|s| !s.is_empty()).unwrap_or("attachments").replace('\\', "/");
    let page_folder = page.rsplit_once('/').map(|(f, _)| f).unwrap_or("");
    let (base, rest) = match setting.strip_prefix("./") {
        Some(rest) => (page_folder, rest),
        None if setting == "." => (page_folder, ""),
        None => ("", setting.as_str()),
    };
    let mut parts: Vec<&str> = base.split('/').filter(|p| !p.is_empty()).collect();
    for part in rest.split('/').filter(|p| !p.is_empty() && *p != ".") {
        if part == ".." {
            return Err(format!("The attachments folder \"{setting}\" leads outside the notebook"));
        }
        parts.push(part);
    }
    Ok(parts.join("/"))
}

/// Write `bytes` as a new file in `dir`, named `name` or, when that is taken, `stem 1.ext`, `stem 2.ext` and so on.
/// A file is created only where none exists, so nothing is ever replaced. Returns the name used.
pub fn write_unique(dir: &Path, name: &str, bytes: &[u8]) -> Result<String, String> {
    let path = Path::new(name);
    let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let ext = path.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    for n in 0..1000 {
        let candidate = if n == 0 { name.to_string() } else { format!("{stem} {n}{ext}") };
        let full = dir.join(&candidate);
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&full) {
            Ok(mut file) => {
                let written = file.write_all(bytes).and_then(|_| file.sync_all());
                if let Err(e) = written {
                    drop(file);
                    std::fs::remove_file(&full).ok();
                    return Err(format!("Could not save {candidate}: {e}"));
                }
                return Ok(candidate);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("Could not save {candidate} in {}: {e}", dir.display())),
        }
    }
    Err(format!("{name} and a thousand numbered copies already exist in {}", dir.display()))
}

/// Refuse a picture over the cap before anything is copied.
pub fn check_size(len: u64) -> Result<(), String> {
    if len > MAX_BYTES {
        return Err(format!("A picture is attached only up to {} MB; this one is {:.1} MB", MAX_BYTES / (1024 * 1024), len as f64 / (1024.0 * 1024.0)));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_made_safe_for_windows_and_living_memory() {
        assert_eq!(clean_name("Pasted image 20261121135501.png").unwrap(), "Pasted image 20261121135501.png");
        assert_eq!(clean_name("a/b\\c:d*e?f\"g<h>i|j.PNG").unwrap(), "a-b-c-d-e-f-g-h-i-j.PNG");
        assert_eq!(clean_name("  shot.jpg  ").unwrap(), "shot.jpg");
        assert_eq!(clean_name("con.png").unwrap(), "_con.png");
        assert_eq!(clean_name("tab\there.gif").unwrap(), "tab-here.gif");
        let long = format!("{}.webp", "x".repeat(300));
        let cut = clean_name(&long).unwrap();
        assert_eq!(cut.chars().count(), NAME_KEEP);
        assert!(cut.ends_with(".webp"));
        assert!(clean_name("notes.md").is_err(), "only pictures");
        assert!(clean_name("run.exe").is_err());
        assert!(clean_name(".png").is_err(), "a name needs a stem");
        assert!(clean_name("png").is_err());
    }

    #[test]
    fn the_attachments_folder_follows_the_notebook_setting() {
        assert_eq!(folder_for(None, "Plans/Q1.md").unwrap(), "attachments");
        assert_eq!(folder_for(Some(""), "Q1.md").unwrap(), "attachments");
        assert_eq!(folder_for(Some("Assets/img"), "Plans/Q1.md").unwrap(), "Assets/img");
        assert_eq!(folder_for(Some("/"), "Plans/Q1.md").unwrap(), "");
        assert_eq!(folder_for(Some("./"), "Plans/Q1.md").unwrap(), "Plans");
        assert_eq!(folder_for(Some("."), "Plans/Q1.md").unwrap(), "Plans");
        assert_eq!(folder_for(Some("./img"), "Plans/Sub/Q1.md").unwrap(), "Plans/Sub/img");
        assert_eq!(folder_for(Some("./img"), "Q1.md").unwrap(), "img");
        assert_eq!(folder_for(Some("Assets\\img"), "Q1.md").unwrap(), "Assets/img");
        assert!(folder_for(Some("../outside"), "Q1.md").is_err());
        assert!(folder_for(Some("./../x"), "Plans/Q1.md").is_err());
    }

    #[test]
    fn a_taken_name_gets_a_number_and_nothing_is_replaced() {
        let dir = std::env::temp_dir().join(format!("hm-attach-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(write_unique(&dir, "a.png", b"one").unwrap(), "a.png");
        assert_eq!(write_unique(&dir, "a.png", b"two").unwrap(), "a 1.png");
        assert_eq!(write_unique(&dir, "a.png", b"three").unwrap(), "a 2.png");
        assert_eq!(std::fs::read(dir.join("a.png")).unwrap(), b"one");
        assert_eq!(std::fs::read(dir.join("a 1.png")).unwrap(), b"two");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn pictures_over_the_cap_are_refused() {
        assert!(check_size(MAX_BYTES).is_ok());
        assert!(check_size(MAX_BYTES + 1).is_err());
    }
}
