//! A macOS app started from Finder or the Dock gets launchd's environment: PATH is `/usr/bin:/bin:/usr/sbin:/sbin` and
//! LANG is unset. Then `claude`, `codex`, `gh`, Homebrew `git`, `python3` and `alm` are not found, npm shims cannot find
//! `node`, and terminals start in the C locale. At startup the PATH the user's shell sets is put in front of the inherited
//! one, and LANG gets a UTF-8 default. Nothing changes on other systems.

use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

const MARK: &str = "__HIVEMIND_PATH__";
const WAIT: Duration = Duration::from_secs(4);

/// Call first thing in `run`, before any other thread starts: setting variables races with threads that read them.
pub fn hydrate() {
    if !cfg!(target_os = "macos") {
        return;
    }
    let shell = std::env::var("SHELL").ok().filter(|s| s.starts_with('/')).unwrap_or_else(|| "/bin/zsh".into());
    if let Some(path) = shell_path(&shell, WAIT) {
        let merged = merge(&path, &std::env::var("PATH").unwrap_or_default());
        // SAFETY: no thread that reads the environment has started yet (shell_path's reader only reads a pipe).
        unsafe { std::env::set_var("PATH", merged) };
    }
    if std::env::var_os("LANG").is_none_or(|v| v.is_empty()) {
        // SAFETY: as above.
        unsafe { std::env::set_var("LANG", "en_US.UTF-8") };
    }
}

/// PATH as an interactive login shell sets it (`-ilc`, as VS Code resolves it: version managers such as nvm are often set
/// up in `.zshrc`), or None when the shell fails or takes longer than `wait`. The value is read between markers, so text
/// a profile prints does not end up in PATH.
fn shell_path(shell: &str, wait: Duration) -> Option<String> {
    let script = format!("printf '{MARK}%s{MARK}' \"$PATH\"");
    let mut child = Command::new(shell)
        .args(["-ilc", &script])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let (tx, rx) = mpsc::channel();
    // A reader thread that answers as soon as the second mark arrives: a profile may start something that keeps stdout
    // open, so the start never waits for the pipe to close. Such a reader is left blocked on the pipe, which is harmless.
    std::thread::spawn(move || {
        let mut out = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            match stdout.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => out.extend_from_slice(&chunk[..n]),
            }
            if out.len() > MAX_OUTPUT || between_marks(&String::from_utf8_lossy(&out)).is_some() {
                break;
            }
        }
        let _ = tx.send(String::from_utf8_lossy(&out).into_owned());
    });
    let out = rx.recv_timeout(wait).ok();
    // SIGKILL ends the shell at once, so reaping it does not wait on anything it started.
    let _ = child.kill();
    let _ = child.wait();
    between_marks(&out?)
}

/// More output than any PATH: the profile printed something else, and reading stops.
const MAX_OUTPUT: usize = 256 * 1024;

fn between_marks(out: &str) -> Option<String> {
    let start = out.find(MARK)? + MARK.len();
    let len = out[start..].find(MARK)?;
    Some(out[start..start + len].to_string()).filter(|p| !p.trim().is_empty())
}

/// The shell's PATH entries first, then the inherited ones it lacks; empty entries and repeats dropped.
fn merge(shell: &str, current: &str) -> String {
    let mut seen: Vec<&str> = Vec::new();
    for dir in shell.split(':').chain(current.split(':')) {
        if !dir.is_empty() && !seen.contains(&dir) {
            seen.push(dir);
        }
    }
    seen.join(":")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_shell_path_comes_first_without_repeats() {
        assert_eq!(merge("/opt/homebrew/bin:/usr/bin:", "/usr/bin:/bin::/sbin"), "/opt/homebrew/bin:/usr/bin:/bin:/sbin");
    }

    #[test]
    fn text_a_profile_prints_is_left_out() {
        let out = format!("Welcome!\n{MARK}/a:/b{MARK}\nbye");
        assert_eq!(between_marks(&out).as_deref(), Some("/a:/b"));
        assert_eq!(between_marks("no marks"), None);
        assert_eq!(between_marks(&format!("{MARK}{MARK}")), None);
    }
}
