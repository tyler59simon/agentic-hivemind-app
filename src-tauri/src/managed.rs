//! Claude Code's managed (organization) policy. Hivemind runs Claude isolated: the executive chat with `--restricted` and
//! `--strict-mcp-config`, the one-shot calls with `--safe-mode` and `--strict-mcp-config`. Managed policy still applies under
//! all of them, hooks included, and a deployed `managed-mcp.json` makes Claude Code exit on `--strict-mcp-config`. So
//! Hivemind looks for managed policy before each Claude call and refuses the call when it finds one (EXEC-11, EXEC-R7).
//! Server-managed settings from the claude.ai console leave nothing on this computer to find.
use std::path::{Path, PathBuf};

/// The files Claude Code reads in its managed folder, and the folder of drop-in files beside them.
const FILES: [&str; 2] = ["managed-settings.json", "managed-mcp.json"];
const DROP_INS: &str = "managed-settings.d";
/// The registry keys whose `Settings` value holds a managed policy on Windows.
#[cfg_attr(not(any(windows, test)), allow(dead_code))]
const KEYS: [&str; 2] = [r"HKLM\SOFTWARE\Policies\ClaudeCode", r"HKCU\SOFTWARE\Policies\ClaudeCode"];

/// The first managed policy source present: a file in `folder`, a `.json` file in its drop-in folder, a registry key in
/// `keys` for which `has_settings` finds a `Settings` value, or a file in `plists`. Its name, as the user would look for it.
fn found(folder: &Path, keys: &[&str], has_settings: impl Fn(&str) -> bool, plists: &[PathBuf]) -> Option<String> {
    let file = FILES.iter().map(|name| folder.join(name)).find(|path| path.exists());
    let drop_in = || {
        let entries = std::fs::read_dir(folder.join(DROP_INS)).ok()?;
        entries.flatten().map(|entry| entry.path()).find(|path| path.extension().is_some_and(|ext| ext == "json"))
    };
    let path = file.or_else(drop_in).map(|path| path.display().to_string());
    path.or_else(|| keys.iter().find(|key| has_settings(key)).map(|key| format!(r"{key}\Settings")))
        .or_else(|| plists.iter().find(|path| path.exists()).map(|path| path.display().to_string()))
}

/// Whether the registry key has a `Settings` value: `reg query` exits 0 only then.
#[cfg(all(windows, not(test)))]
fn has_settings(key: &str) -> bool {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    Command::new("reg")
        .args(["query", key, "/v", "Settings"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .status()
        .is_ok_and(|status| status.success())
}

/// The managed policy source on this computer, from the places Claude Code's documentation names for each system.
#[cfg(all(windows, not(test)))]
pub fn policy() -> Option<String> {
    found(Path::new(r"C:\Program Files\ClaudeCode"), &KEYS, has_settings, &[])
}

#[cfg(all(target_os = "macos", not(test)))]
pub fn policy() -> Option<String> {
    let mut plists = vec![PathBuf::from("/Library/Managed Preferences/com.anthropic.claudecode.plist")];
    if let Ok(user) = std::env::var("USER") {
        plists.push(PathBuf::from(format!("/Library/Managed Preferences/{user}/com.anthropic.claudecode.plist")));
    }
    found(Path::new("/Library/Application Support/ClaudeCode"), &[], |_| false, &plists)
}

#[cfg(all(not(any(windows, target_os = "macos")), not(test)))]
pub fn policy() -> Option<String> {
    found(Path::new("/etc/claude-code"), &[], |_| false, &[])
}

#[cfg(test)]
thread_local! {
    /// What `policy` reports in a test on this thread: none unless a test sets one, so tests do not depend on the machine.
    pub static FAKE: std::cell::RefCell<Option<String>> = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
pub fn policy() -> Option<String> {
    FAKE.with(|fake| fake.borrow().clone())
}

/// Refuse a Claude call while managed policy is present, naming where it was found.
pub fn refuse() -> Result<(), String> {
    match policy() {
        Some(source) => Err(format!(
            "Hivemind does not start Claude Code on this computer because managed settings are deployed ({source}): they would \
             still apply to Hivemind's isolated calls, hooks included, and a managed MCP file makes those calls exit. Use Codex \
             for the assistant, or ask whoever manages this computer."
        )),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_kind_of_managed_source_is_found() {
        let dir = std::env::temp_dir().join(format!("hivemind-managed-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(DROP_INS)).unwrap();
        let none = |_: &str| false;
        assert_eq!(found(&dir, &KEYS, none, &[]), None, "an empty folder and drop-in folder hold no policy");
        std::fs::write(dir.join(DROP_INS).join("notes.txt"), "x").unwrap();
        assert_eq!(found(&dir, &KEYS, none, &[]), None, "only .json drop-ins count");
        let plist = dir.join("com.anthropic.claudecode.plist");
        std::fs::write(&plist, "x").unwrap();
        assert_eq!(found(&dir, &KEYS, none, std::slice::from_ref(&plist)), Some(plist.display().to_string()));
        let hkcu = |key: &str| key.starts_with("HKCU");
        assert_eq!(found(&dir, &KEYS, hkcu, &[]).as_deref(), Some(r"HKCU\SOFTWARE\Policies\ClaudeCode\Settings"));
        let drop_in = dir.join(DROP_INS).join("10-team.json");
        std::fs::write(&drop_in, "{}").unwrap();
        assert_eq!(found(&dir, &KEYS, hkcu, &[]), Some(drop_in.display().to_string()), "a file comes before the registry");
        std::fs::write(dir.join("managed-mcp.json"), "{}").unwrap();
        assert_eq!(found(&dir, &KEYS, none, &[]), Some(dir.join("managed-mcp.json").display().to_string()));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_refusal_names_the_source() {
        assert_eq!(refuse(), Ok(()));
        FAKE.with(|fake| *fake.borrow_mut() = Some(r"C:\Program Files\ClaudeCode\managed-mcp.json".into()));
        let refused = refuse().unwrap_err();
        FAKE.with(|fake| *fake.borrow_mut() = None);
        assert!(refused.contains(r"(C:\Program Files\ClaudeCode\managed-mcp.json)"), "{refused}");
    }
}
