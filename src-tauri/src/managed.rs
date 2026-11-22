//! Claude Code's managed (organization) policy. Hivemind runs Claude isolated: the executive chat with `--restricted` and
//! `--strict-mcp-config`, the one-shot calls with `--safe-mode` and `--strict-mcp-config`. Managed policy still applies under
//! all of them, hooks included, and a deployed `managed-mcp.json` makes Claude Code exit on `--strict-mcp-config`. So
//! Hivemind looks for managed policy before each Claude call and refuses the call when it finds one (EXEC-11, EXEC-R7), unless
//! the user turned on "Allow Claude under managed policy" (REG-16): then the calls run, managed hooks included, and a call
//! leaves out `--strict-mcp-config` when a `managed-mcp.json` is deployed.
//! Server-managed settings from the claude.ai console are found only once Claude Code has cached them
//! (`remote-settings.json`); a policy it has not fetched yet leaves nothing to find, nor does a Windows policy that WSL inherits.
use std::path::{Path, PathBuf};

/// The files Claude Code reads in its managed folder, and the folder of drop-in files beside them.
const FILES: [&str; 2] = ["managed-settings.json", "managed-mcp.json"];
const DROP_INS: &str = "managed-settings.d";
/// The registry keys whose `Settings` value holds a managed policy on Windows.
#[cfg_attr(not(any(windows, test)), allow(dead_code))]
const KEYS: [&str; 2] = [r"HKLM\SOFTWARE\Policies\ClaudeCode", r"HKCU\SOFTWARE\Policies\ClaudeCode"];

/// The folder where Claude Code looks for the managed files, by system.
#[cfg(windows)]
#[cfg_attr(test, allow(dead_code))]
const FOLDER: &str = r"C:\Program Files\ClaudeCode";
#[cfg(target_os = "macos")]
#[cfg_attr(test, allow(dead_code))]
const FOLDER: &str = "/Library/Application Support/ClaudeCode";
#[cfg(not(any(windows, target_os = "macos")))]
#[cfg_attr(test, allow(dead_code))]
const FOLDER: &str = "/etc/claude-code";

/// The first managed policy source present: a file in `folder`, a drop-in file Claude Code would read (a `.json` file whose
/// name does not start with a dot), a registry key in `keys` for which `has_settings` finds a `Settings` value, or one of
/// `others` (managed preference files, the server-managed cache). Its name, as the user would look for it.
fn found(folder: &Path, keys: &[&str], has_settings: impl Fn(&str) -> bool, others: &[PathBuf]) -> Option<String> {
    let file = FILES.iter().map(|name| folder.join(name)).find(|path| path.exists());
    let drop_in = || {
        let entries = std::fs::read_dir(folder.join(DROP_INS)).ok()?;
        let read = |entry: &std::fs::DirEntry| !entry.file_name().to_string_lossy().starts_with('.');
        entries.flatten().filter(read).map(|entry| entry.path()).find(|path| path.is_file() && path.extension().is_some_and(|ext| ext == "json"))
    };
    let path = file.or_else(drop_in).map(|path| path.display().to_string());
    path.or_else(|| keys.iter().find(|key| has_settings(key)).map(|key| format!(r"{key}\Settings")))
        .or_else(|| others.iter().find(|path| holds_policy(path)).map(|path| path.display().to_string()))
}

/// Whether one of `others` holds a policy: any file there, except a JSON file that is an empty object, which is how Claude
/// Code records that the server has no policy for the account.
fn holds_policy(path: &Path) -> bool {
    let Ok(bytes) = std::fs::read(path) else { return false };
    path.extension().is_none_or(|ext| ext != "json")
        || serde_json::from_slice::<serde_json::Value>(&bytes).map_or(true, |value| value != serde_json::json!({}))
}

/// Where Claude Code caches server-managed settings in its config folder (`CLAUDE_CONFIG_DIR`, else `~/.claude`):
/// `remote-settings.json`, and `state/hybrid-settings*.json` for an organization sign-in (names as in Claude Code 2.1.329).
#[cfg(not(test))]
fn remote_cache() -> Vec<PathBuf> {
    let dir = std::env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from).or_else(|| dirs::home_dir().map(|home| home.join(".claude")));
    let Some(dir) = dir else { return vec![] };
    let hybrid = std::fs::read_dir(dir.join("state")).into_iter().flatten().flatten().map(|entry| entry.path());
    let hybrid = hybrid.filter(|path| path.file_name().is_some_and(|name| {
        let name = name.to_string_lossy();
        name.starts_with("hybrid-settings") && name.ends_with(".json")
    }));
    std::iter::once(dir.join("remote-settings.json")).chain(hybrid).collect()
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
    found(Path::new(FOLDER), &KEYS, has_settings, &remote_cache())
}

#[cfg(all(target_os = "macos", not(test)))]
pub fn policy() -> Option<String> {
    let mut others = vec![PathBuf::from("/Library/Managed Preferences/com.anthropic.claudecode.plist")];
    if let Ok(user) = std::env::var("USER") {
        others.push(PathBuf::from(format!("/Library/Managed Preferences/{user}/com.anthropic.claudecode.plist")));
    }
    others.extend(remote_cache());
    found(Path::new(FOLDER), &[], |_| false, &others)
}

#[cfg(all(not(any(windows, target_os = "macos")), not(test)))]
pub fn policy() -> Option<String> {
    found(Path::new(FOLDER), &[], |_| false, &remote_cache())
}

/// Whether a `managed-mcp.json` is deployed in the managed folder.
#[cfg(not(test))]
fn mcp_file() -> bool {
    Path::new(FOLDER).join("managed-mcp.json").is_file()
}

#[cfg(test)]
thread_local! {
    /// What `policy` reports in a test on this thread: none unless a test sets one, so tests do not depend on the machine.
    pub static FAKE: std::cell::RefCell<Option<String>> = const { std::cell::RefCell::new(None) };
    /// Whether `mcp_file` finds a managed MCP file in a test on this thread: no unless a test says so.
    pub static FAKE_MCP: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

#[cfg(test)]
pub fn policy() -> Option<String> {
    FAKE.with(|fake| fake.borrow().clone())
}

#[cfg(test)]
fn mcp_file() -> bool {
    FAKE_MCP.with(|fake| fake.get())
}

/// Whether a Claude call that isolates itself from MCP servers should pass `--strict-mcp-config`. Not when the user allowed
/// Claude under managed policy and a managed MCP file is deployed: Claude Code exits on the flag then.
pub fn strict_mcp(allowed: bool) -> bool {
    !(allowed && mcp_file())
}

/// Refuse a Claude call while managed policy is present, naming where it was found. `allowed` is the user's setting to run
/// Claude under managed policy anyway; the call then goes ahead.
pub fn refuse(allowed: bool) -> Result<(), String> {
    if allowed {
        return Ok(());
    }
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
        std::fs::write(dir.join(DROP_INS).join(".old.json"), "{}").unwrap();
        std::fs::create_dir(dir.join(DROP_INS).join("folder.json")).unwrap();
        assert_eq!(found(&dir, &KEYS, none, &[]), None, "only .json files Claude Code reads count: no dot files, no folders");
        let plist = dir.join("com.anthropic.claudecode.plist");
        std::fs::write(&plist, "x").unwrap();
        assert_eq!(found(&dir, &KEYS, none, std::slice::from_ref(&plist)), Some(plist.display().to_string()));
        let cache = dir.join("remote-settings.json");
        std::fs::write(&cache, "{ }").unwrap();
        assert_eq!(found(&dir, &KEYS, none, std::slice::from_ref(&cache)), None, "an empty cache records that there is no policy");
        std::fs::write(&cache, r#"{"hooks": {}}"#).unwrap();
        assert_eq!(found(&dir, &KEYS, none, std::slice::from_ref(&cache)), Some(cache.display().to_string()));
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
        assert_eq!(refuse(false), Ok(()));
        FAKE.with(|fake| *fake.borrow_mut() = Some(r"C:\Program Files\ClaudeCode\managed-mcp.json".into()));
        let refused = refuse(false).unwrap_err();
        FAKE.with(|fake| *fake.borrow_mut() = None);
        assert!(refused.contains(r"(C:\Program Files\ClaudeCode\managed-mcp.json)"), "{refused}");
    }

    #[test]
    fn the_setting_lets_a_call_run_under_managed_policy() {   // REG-16
        FAKE.with(|fake| *fake.borrow_mut() = Some("/etc/claude-code/managed-settings.json".into()));
        let (off, on) = (refuse(false), refuse(true));
        FAKE.with(|fake| *fake.borrow_mut() = None);
        assert!(off.is_err(), "off: the refusal stays");
        assert_eq!(on, Ok(()), "on: no refusal");
    }

    #[test]
    fn strict_mcp_is_dropped_only_for_a_managed_mcp_file_the_user_allowed() {   // REG-16
        assert!(strict_mcp(false) && strict_mcp(true), "no managed MCP file: the flag stays");
        FAKE_MCP.with(|fake| fake.set(true));
        let (off, on) = (strict_mcp(false), strict_mcp(true));
        FAKE_MCP.with(|fake| fake.set(false));
        assert!(off, "a managed MCP file with the setting off: the call is refused before it gets here, the flag stays");
        assert!(!on, "a managed MCP file with the setting on: Claude Code would exit on the flag");
    }
}
