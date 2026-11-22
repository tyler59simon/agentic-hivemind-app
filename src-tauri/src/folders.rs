//! The "other folders" the user picked with the native folder dialog. A folder path enters the app only through
//! `folder_pick`; `save_settings` never changes this list.
use crate::settings::{self, Settings};
use std::path::Path;

/// A folder as it is compared: forward slashes, no trailing slash, and lower case on Windows.
pub(crate) fn normal(path: &str) -> String {
    let text = path.replace('\\', "/");
    let text = text.trim_end_matches('/');
    if cfg!(windows) { text.to_lowercase() } else { text.to_string() }
}

pub fn same(a: &str, b: &str) -> bool {
    normal(a) == normal(b)
}

/// The saved spelling of `path` when it is one of the picked folders.
pub fn find<'a>(saved: &'a Settings, path: &str) -> Option<&'a str> {
    saved.other_folders.iter().flatten().map(String::as_str).find(|folder| same(folder, path))
}

/// Windows' canonical form starts with `\\?\`; the rest of the app and the CLIs use the plain spelling.
pub fn plain(path: &Path) -> String {
    let text = path.display().to_string();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    match text.strip_prefix(r"\\?\") {
        Some(rest) if rest.as_bytes().get(1) == Some(&b':') => rest.to_string(),
        _ => text,
    }
}

/// Add a picked folder (canonicalised) to the saved list unless it is there; returns the saved spelling.
pub fn add(settings_path: &Path, picked: &Path) -> Result<String, String> {
    let real = std::fs::canonicalize(picked).map_err(|e| format!("Could not open {}: {e}", picked.display()))?;
    if !real.is_dir() {
        return Err(format!("{} is not a folder", picked.display()));
    }
    let real = plain(&real);
    let mut saved = settings::load(settings_path);
    if let Some(known) = find(&saved, &real) {
        return Ok(known.to_string());
    }
    saved.other_folders.get_or_insert_with(Vec::new).push(real.clone());
    settings::save(settings_path, &saved)?;
    Ok(real)
}

/// Take a folder out of the saved list. Forgetting one that is not there is not an error.
pub fn forget(settings_path: &Path, path: &str) -> Result<(), String> {
    let mut saved = settings::load(settings_path);
    let Some(list) = saved.other_folders.as_mut() else { return Ok(()) };
    let before = list.len();
    list.retain(|folder| !same(folder, path));
    if list.len() == before {
        return Ok(());
    }
    settings::save(settings_path, &saved)
}

/// The settings to save when the webview sends `value`: everything it sent except the folder list, which stays as saved.
pub fn keep(previous: &Settings, mut value: Settings) -> Settings {
    value.other_folders = previous.other_folders.clone();
    value
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("hivemind-folders-{name}-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn folders_match_whatever_the_slashes() {
        assert!(same("C:\\Work\\App\\", "C:/Work/App"));
        assert!(!same("C:/Work/App", "C:/Work/App2"));
        assert!(!same("C:/Work", "C:/Work/App"));
        assert_eq!(same("C:/Work/App", "c:/work/app"), cfg!(windows));
    }

    #[test]
    fn finds_the_saved_spelling() {
        let saved = Settings { other_folders: Some(vec!["C:/Notes".into()]), ..Default::default() };
        assert_eq!(find(&saved, "C:\\Notes\\"), Some("C:/Notes"));
        assert_eq!(find(&saved, "C:/Other"), None);
        assert_eq!(find(&Settings::default(), "C:/Notes"), None);
    }

    #[test]
    fn verbatim_prefixes_are_removed() {
        assert_eq!(plain(Path::new(r"\\?\C:\Work\App")), r"C:\Work\App");
        assert_eq!(plain(Path::new(r"\\?\UNC\server\share\x")), r"\\server\share\x");
        assert_eq!(plain(Path::new("/home/me")), "/home/me");
        assert_eq!(plain(Path::new(r"C:\Work")), r"C:\Work");
    }

    #[test]
    fn add_and_forget_change_the_saved_list_once() {
        let dir = temp("add");
        let (settings_path, folder) = (dir.join("settings.json"), dir.join("picked"));
        std::fs::create_dir_all(&folder).unwrap();
        let first = add(&settings_path, &folder).unwrap();
        assert_eq!(add(&settings_path, &folder).unwrap(), first);
        assert_eq!(settings::load(&settings_path).other_folders, Some(vec![first.clone()]));
        assert!(add(&settings_path, &dir.join("missing")).is_err());
        assert!(add(&settings_path, &settings_path).is_err(), "a file is not a folder");

        forget(&settings_path, "C:/never-added").unwrap();
        assert_eq!(settings::load(&settings_path).other_folders, Some(vec![first.clone()]));
        forget(&settings_path, &format!("{first}/")).unwrap();
        assert_eq!(settings::load(&settings_path).other_folders, Some(vec![]));
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn saving_settings_from_the_webview_keeps_the_saved_folders() {
        let previous = Settings { other_folders: Some(vec!["C:/Notes".into()]), ..Default::default() };
        let sent = Settings { python: Some("py".into()), other_folders: Some(vec!["C:/Secrets".into()]), ..Default::default() };
        let kept = keep(&previous, sent);
        assert_eq!((kept.python.as_deref(), kept.other_folders), (Some("py"), Some(vec!["C:/Notes".to_string()])));
    }
}
