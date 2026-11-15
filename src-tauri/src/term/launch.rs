//! Which program to start in a terminal, with which arguments and environment. Pure functions, except the thin
//! wrappers over the real machine (`codex`, `claude`, `windows_build`).
use crate::agent::Engine;
use crate::settings::Settings;
use crate::term::StartMode;
use std::path::{Path, PathBuf};

pub const NO_CODEX: &str = "Codex was not found. Install it, or set the path to its program in Settings.";

/// A program and the arguments that come before the CLI's own (for example `node` and `codex.js`).
/// Named `Cli` because the crate already has `settings::Launch` and Phase 2's `agent::Launch`.
#[derive(Clone, Debug, PartialEq)]
pub struct Cli {
    pub program: String,
    pub args: Vec<String>,
}

impl Cli {
    fn direct(path: &Path) -> Cli {
        Cli { program: path.display().to_string(), args: vec![] }
    }

    fn node(script: &Path) -> Cli {
        Cli { program: "node".into(), args: vec![script.display().to_string()] }
    }
}

fn extension_is(path: &Path, wanted: &str) -> bool {
    path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case(wanted))
}

fn subfolders(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else { return vec![] };
    let mut folders: Vec<PathBuf> = entries.filter_map(Result::ok).map(|entry| entry.path()).filter(|path| path.is_dir()).collect();
    folders.sort();
    folders
}

/// The native Codex binary inside an npm install's `@openai\codex` package folder.
fn native_codex(package: &Path) -> Option<PathBuf> {
    subfolders(&package.join("node_modules").join("@openai"))
        .into_iter()
        .filter(|dir| dir.file_name().is_some_and(|name| name.to_string_lossy().starts_with("codex-win32-")))
        .flat_map(|dir| subfolders(&dir.join("vendor")))
        .map(|triple| triple.join("bin").join("codex.exe"))
        .find(|exe| exe.is_file())
}

/// The Codex program: the saved path, else the npm install's native binary, else `node` and the npm launcher script.
/// `path_dirs` and `home` are parameters so tests never touch the real machine.
pub fn locate_codex(saved: &Settings, path_dirs: &[PathBuf], home: &Path) -> Result<Cli, String> {
    let mut npm_folders: Option<Vec<PathBuf>> = None;
    if let Some(path) = saved.codex_path.as_deref().map(str::trim).map(Path::new).filter(|path| path.is_file()) {
        if !cfg!(windows) || extension_is(path, "exe") {
            return Ok(Cli::direct(path));
        }
        if extension_is(path, "js") {
            return Ok(Cli::node(path));
        }
        if path.file_name().is_some_and(|name| name.eq_ignore_ascii_case("codex.cmd")) {
            npm_folders = path.parent().map(|dir| vec![dir.to_path_buf()]);
        }
    }
    if !cfg!(windows) {
        let usual = [PathBuf::from("/opt/homebrew/bin"), PathBuf::from("/usr/local/bin"), home.join(".local").join("bin")];
        return path_dirs
            .iter()
            .chain(usual.iter())
            .map(|dir| dir.join("codex"))
            .find(|path| path.is_file())
            .map(|path| Cli::direct(&path))
            .ok_or_else(|| NO_CODEX.to_string());
    }
    let folders = npm_folders.unwrap_or_else(|| path_dirs.iter().filter(|dir| dir.join("codex.cmd").is_file()).cloned().collect());
    for dir in folders {
        let package = dir.join("node_modules").join("@openai").join("codex");
        if let Some(exe) = native_codex(&package) {
            return Ok(Cli::direct(&exe));
        }
        let script = package.join("bin").join("codex.js");
        if script.is_file() {
            return Ok(Cli::node(&script));
        }
    }
    path_dirs
        .iter()
        .map(|dir| dir.join("codex.exe"))
        .find(|path| path.is_file())
        .map(|path| Cli::direct(&path))
        .ok_or_else(|| NO_CODEX.to_string())
}

/// `locate_codex` with the real PATH and home folder.
pub fn codex(saved: &Settings) -> Result<Cli, String> {
    let home = dirs::home_dir().ok_or("Could not find your home folder")?;
    let path_dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|path| std::env::split_paths(&path).collect()).unwrap_or_default();
    locate_codex(saved, &path_dirs, &home)
}

/// Claude Code for a PTY: `agent::claude::available`, with the bare name spelled `claude.exe` on Windows
/// (the PTY's own PATH search tries the exact name first and could find an extensionless npm shim).
pub fn claude(saved: &Settings) -> Result<Cli, String> {
    let found = crate::agent::claude::available(saved)?;
    let program = if cfg!(windows) && found == "claude" { "claude.exe".to_string() } else { found };
    Ok(Cli { program, args: vec![] })
}

pub fn program(engine: Engine, saved: &Settings) -> Result<Cli, String> {
    match engine {
        Engine::Claude => claude(saved),
        Engine::Codex => codex(saved),
    }
}

/// The one-line prompt that points the CLI at its briefing file.
pub fn pointer_prompt(briefing: &Path) -> String {
    format!("Read the file {} first. It holds your task and the project context for this session.", briefing.display())
}

/// The CLI's own arguments for a session terminal (section 5.4), without the launch prefix.
pub fn session_args(
    engine: Engine,
    mode: StartMode,
    accept_edits: bool,
    model: Option<&str>,
    deny: &[String],
    session_id: &str,
    context_dir: &Path,
) -> Vec<String> {
    let text = |s: &str| s.to_string();
    let prompt = pointer_prompt(&context_dir.join("briefing.md"));
    match engine {
        Engine::Claude => {
            let mut args = vec![text("--add-dir"), context_dir.display().to_string()];
            if !deny.is_empty() {
                args.push(text("--disallowedTools"));
                args.extend(deny.iter().cloned());
            }
            args.push(text(if mode == StartMode::Fresh { "--session-id" } else { "--resume" }));
            args.push(text(session_id));
            if let Some(model) = model {
                args.extend([text("--model"), text(model)]);
            }
            args.extend([text("--permission-mode"), text(if accept_edits { "acceptEdits" } else { "manual" })]);
            if mode == StartMode::Fresh {
                args.push(prompt);
            }
            args
        }
        Engine::Codex => {
            let mut args = Vec::new();
            if mode == StartMode::Resume {
                args.extend([text("resume"), text("--last")]);
            }
            args.extend([
                text("--no-alt-screen"),
                text("--no-daemon"),
                text("-s"),
                text(if accept_edits { "workspace-write" } else { "read-only" }),
                text("-a"),
                text("on-request"),
            ]);
            if mode == StartMode::Fresh {
                args.push(prompt);
            }
            args
        }
    }
}

/// The CLI's own arguments for its sign-in command.
pub fn login_args(engine: Engine) -> Vec<String> {
    match engine {
        Engine::Claude => vec!["auth".into(), "login".into()],
        Engine::Codex => vec!["login".into()],
    }
}

/// Variables to set and names to remove, given the app's own variable names.
pub fn environment(own: &[String], memory_root: Option<&Path>) -> (Vec<(String, String)>, Vec<String>) {
    let mut set = vec![("TERM".to_string(), "xterm-256color".to_string()), ("COLORTERM".to_string(), "truecolor".to_string())];
    if let Some(root) = memory_root {
        set.push(("LIVING_MEMORY_ROOT".to_string(), root.display().to_string()));
    }
    let remove = if own.iter().any(|name| name == "CLAUDECODE") {
        own.iter().filter(|name| name.starts_with("CLAUDE") || *name == "NO_COLOR").cloned().collect()
    } else {
        vec![]
    };
    (set, remove)
}

/// The build number in the text `cmd /d /c ver` prints, e.g. 26100 from "Microsoft Windows [Version 10.0.26100.9711]".
pub fn parse_build(ver: &str) -> Option<u32> {
    let inside = ver.split_once('[')?.1.split_once(']')?.0;
    let version = inside.split(|c: char| !c.is_ascii_digit() && c != '.').find(|piece| piece.matches('.').count() >= 3)?;
    version.split('.').nth(2)?.parse().ok()
}

/// The Windows build number, read once; None on other systems.
pub fn windows_build() -> Option<u32> {
    #[cfg(windows)]
    {
        static BUILD: std::sync::OnceLock<Option<u32>> = std::sync::OnceLock::new();
        *BUILD.get_or_init(|| {
            let mut command = std::process::Command::new("cmd");
            command.args(["/d", "/c", "ver"]);
            crate::git::run_with_timeout(command, std::time::Duration::from_secs(5)).ok().and_then(|text| parse_build(&text))
        })
    }
    #[cfg(not(windows))]
    {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "00000000-0000-4000-8000-000000000001";

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hivemind-launch-{name}-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn strings(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[cfg(windows)]
    #[test]
    fn codex_is_found_in_order() {
        let root = temp("codex");
        let npm = root.join("npm");
        let package = npm.join("node_modules").join("@openai").join("codex");
        let script = package.join("bin").join("codex.js");
        let exe = ["node_modules", "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe"].iter().fold(package.clone(), |path, part| path.join(part));
        for file in [npm.join("codex.cmd"), npm.join("codex"), script.clone(), exe.clone()] {
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(&file, "").unwrap();
        }
        let none = Settings::default();
        let dirs = [npm.clone()];
        let home = root.join("home");
        let sane = |cli: &Cli| {
            assert!(!cli.program.to_lowercase().contains("cmd"), "{}", cli.program);
            assert!(!cli.program.ends_with("codex"), "{}", cli.program);
        };

        let found = locate_codex(&none, &dirs, &home).unwrap();
        assert_eq!(found, Cli { program: exe.display().to_string(), args: vec![] });
        sane(&found);

        std::fs::remove_file(&exe).unwrap();
        let found = locate_codex(&none, &dirs, &home).unwrap();
        assert_eq!(found, Cli { program: "node".into(), args: vec![script.display().to_string()] });
        sane(&found);

        // A saved path that does not exist falls through to PATH.
        let gone = Settings { codex_path: Some(root.join("gone.exe").display().to_string()), ..Default::default() };
        assert_eq!(locate_codex(&gone, &dirs, &home).unwrap().program, "node");

        std::fs::remove_file(&script).unwrap();
        assert_eq!(locate_codex(&none, &dirs, &home), Err(NO_CODEX.to_string()));

        // A saved program wins, whatever PATH holds.
        std::fs::write(&exe, "").unwrap();
        let chosen = root.join("x.exe");
        std::fs::write(&chosen, "").unwrap();
        let saved = Settings { codex_path: Some(chosen.display().to_string()), ..Default::default() };
        assert_eq!(locate_codex(&saved, &dirs, &home).unwrap(), Cli { program: chosen.display().to_string(), args: vec![] });
        std::fs::remove_dir_all(root).ok();
    }

    #[cfg(not(windows))]
    #[test]
    fn codex_on_other_systems_is_the_file_on_path() {
        let root = temp("codex");
        let bin = root.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let none = Settings::default();
        let home = root.join("home");
        let found = bin.join("codex");
        std::fs::write(&found, "").unwrap();
        assert_eq!(locate_codex(&none, &[bin.clone()], &home).unwrap(), Cli { program: found.display().to_string(), args: vec![] });
        std::fs::remove_file(&found).unwrap();
        // The fixed folders may hold a real codex on this machine, so only check the error without one.
        if !Path::new("/opt/homebrew/bin/codex").exists() && !Path::new("/usr/local/bin/codex").exists() {
            assert_eq!(locate_codex(&none, &[bin], &home), Err(NO_CODEX.to_string()));
        }
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn session_command_lines() {
        let ctx = Path::new("C:/data/terminals/ID/context");
        let c = ctx.display().to_string();
        let prompt = pointer_prompt(&ctx.join("briefing.md"));
        let args = |engine, mode, edits, model: Option<&str>, deny: &[String]| session_args(engine, mode, edits, model, deny, ID, ctx);
        let (fresh, resume) = (StartMode::Fresh, StartMode::Resume);
        let none: Vec<String> = vec![];

        assert_eq!(
            args(Engine::Claude, fresh, false, None, &none),
            vec!["--add-dir", &c, "--session-id", ID, "--permission-mode", "manual", &prompt]
        );
        assert_eq!(args(Engine::Claude, resume, true, None, &none), vec!["--add-dir", &c, "--resume", ID, "--permission-mode", "acceptEdits"]);
        assert_eq!(
            args(Engine::Codex, fresh, false, None, &none),
            vec!["--no-alt-screen", "--no-daemon", "-s", "read-only", "-a", "on-request", &prompt]
        );
        assert_eq!(
            args(Engine::Codex, resume, true, None, &none),
            vec!["resume", "--last", "--no-alt-screen", "--no-daemon", "-s", "workspace-write", "-a", "on-request"]
        );

        // A model is for Claude Code only.
        assert_eq!(
            args(Engine::Claude, fresh, false, Some("opus"), &none),
            vec!["--add-dir", &c, "--session-id", ID, "--model", "opus", "--permission-mode", "manual", &prompt]
        );
        assert_eq!(args(Engine::Codex, fresh, false, Some("opus"), &none), args(Engine::Codex, fresh, false, None, &none));
        assert_eq!(args(Engine::Codex, resume, true, Some("opus"), &none), args(Engine::Codex, resume, true, None, &none));

        // Deny rules follow `--add-dir` and never sit directly before the prompt.
        let deny = strings(&["Bash(x *)", "PowerShell(x *)"]);
        let fresh_deny = args(Engine::Claude, fresh, false, None, &deny);
        assert_eq!(fresh_deny[..6], strings(&["--add-dir", &c, "--disallowedTools", "Bash(x *)", "PowerShell(x *)", "--session-id"])[..]);
        assert_eq!(fresh_deny[6], ID);
        let resume_deny = args(Engine::Claude, resume, true, None, &deny);
        assert_eq!(resume_deny[..6], strings(&["--add-dir", &c, "--disallowedTools", "Bash(x *)", "PowerShell(x *)", "--resume"])[..]);
        for list in [&fresh_deny, &resume_deny] {
            let after = list.iter().position(|a| a == "PowerShell(x *)").unwrap() + 1;
            assert_ne!(list[after], prompt);
        }
        assert_eq!(args(Engine::Codex, fresh, false, None, &deny), args(Engine::Codex, fresh, false, None, &none));
        assert_eq!(args(Engine::Codex, resume, true, None, &deny), args(Engine::Codex, resume, true, None, &none));
    }

    #[test]
    fn the_prompt_is_one_line_without_quotes() {
        let ctx = Path::new("C:/data/terminals/ID/context");
        let prompt = pointer_prompt(&ctx.join("briefing.md"));
        assert!(prompt.contains(&ctx.join("briefing.md").display().to_string()));
        assert!(!prompt.contains('"') && !prompt.contains('\n') && !prompt.contains('\r'));
        assert!(prompt.starts_with("Read the file "));
        for accept_edits in [false, true] {
            let list = session_args(Engine::Claude, StartMode::Fresh, accept_edits, None, &[], ID, ctx);
            assert_eq!(list.last(), Some(&prompt));
            assert_eq!(list[list.len() - 2], if accept_edits { "acceptEdits" } else { "manual" });
        }
    }

    #[test]
    fn login_command_lines() {
        assert_eq!(login_args(Engine::Claude), vec!["auth", "login"]);
        assert_eq!(login_args(Engine::Codex), vec!["login"]);
    }

    #[test]
    fn environment_adds_colour_and_strips_a_nested_session() {
        let colour = vec![("TERM".to_string(), "xterm-256color".to_string()), ("COLORTERM".to_string(), "truecolor".to_string())];
        assert_eq!(environment(&strings(&["PATH", "CLAUDE_CONFIG_DIR"]), None), (colour.clone(), vec![]));
        let (set, remove) = environment(&strings(&["PATH", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CONFIG_DIR", "NO_COLOR"]), None);
        assert_eq!(set, colour);
        assert_eq!(remove, strings(&["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CONFIG_DIR", "NO_COLOR"]));
    }

    #[test]
    fn environment_names_the_store_the_app_uses() {
        let (set, remove) = environment(&strings(&["PATH"]), Some(Path::new("C:/demo/store")));
        assert_eq!(set.len(), 3);
        assert!(set.contains(&("LIVING_MEMORY_ROOT".to_string(), "C:/demo/store".to_string())));
        assert!(set.iter().any(|(k, _)| k == "TERM") && set.iter().any(|(k, _)| k == "COLORTERM"));
        assert!(remove.is_empty());
        let (_, remove) = environment(&strings(&["CLAUDECODE", "LIVING_MEMORY_ROOT"]), None);
        assert!(!remove.contains(&"LIVING_MEMORY_ROOT".to_string()));
    }

    #[test]
    fn build_number_is_read_from_ver() {
        assert_eq!(parse_build("\r\nMicrosoft Windows [Version 10.0.26100.9711]\r\n"), Some(26100));
        assert_eq!(parse_build("Microsoft Windows [version 10.0.19045.5131]"), Some(19045));
        assert_eq!(parse_build("nothing"), None);
    }
}
