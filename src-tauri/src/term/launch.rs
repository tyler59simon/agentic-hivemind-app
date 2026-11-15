//! Which program to start in a terminal, with which arguments and environment. Pure functions, except the thin
//! wrappers over the real machine (`codex`, `claude`, `windows_build`).
use crate::agent::access::{Access, Approval};
use crate::agent::scope::PolicyMode;
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
#[allow(clippy::too_many_arguments)] // each argument is one independent launch setting
pub fn session_args(
    engine: Engine,
    mode: StartMode,
    access: &Access,
    model: Option<&str>,
    effort: Option<&str>,
    deny: &[String],
    name: Option<&str>,
    session_id: &str,
    context_dir: &Path,
    no_task: bool,
) -> Vec<String> {
    let text = |s: &str| s.to_string();
    let prompt = pointer_prompt(&context_dir.join("briefing.md"));
    // Without a task the CLI starts bare: the briefing file exists, but nothing points the CLI at it.
    let fresh = mode == StartMode::Fresh && !no_task;
    // Another engine's settings cannot be launched; the start checks make that unreachable, and the safe default stands in.
    let own = Access::from_policy(engine, PolicyMode::Ask);
    let access = if access.engine() == engine { access } else { &own };
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
            if let Some(effort) = effort {
                args.extend([text("--effort"), text(effort)]);
            }
            if let Access::Claude { mode } = access {
                args.extend([text("--permission-mode"), text(mode.name())]);
            }
            if let Some(name) = name {
                args.extend([text("--name"), text(name)]);
            }
            if fresh {
                args.push(prompt);
            }
            args
        }
        Engine::Codex => {
            let mut args = Vec::new();
            if mode == StartMode::Resume {
                args.extend([text("resume"), text("--last")]);
            }
            args.extend([text("--no-alt-screen"), text("--no-daemon")]);
            if let Some(model) = model {
                args.extend([text("-m"), text(model)]);
            }
            if let Some(effort) = effort {
                // The value is a TOML string. The PTY quotes the argument for the Windows command line, so the inner
                // quotes arrive at Codex as they are written here.
                args.extend([text("-c"), format!("model_reasoning_effort=\"{effort}\"")]);
            }
            if let Access::Codex { sandbox, approval } = access {
                match approval {
                    // Approvals go to Codex's automatic reviewer, which only exists in the workspace-write sandbox.
                    // codex-cli 0.169.0 refuses `-s` next to `--approve-for-me`, which picks the workspace-write sandbox itself.
                    Approval::ApproveForMe => args.push(text("--approve-for-me")),
                    approval => args.extend([text("-s"), text(sandbox.name()), text("-a"), text(approval.name())]),
                }
            }
            if fresh {
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

/// Variables to set and names to remove, given the app's own variable names and the terminal's id.
///
/// A shell tab (id starting `shell-`) gets no `HIVEMIND_SESSION`, and an inherited one is removed: the user applies memory
/// plans from a shell, and the Living Memory guard refuses `apply` while the variable is set.
pub fn environment(own: &[String], memory_root: Option<&Path>, terminal_id: &str) -> (Vec<(String, String)>, Vec<String>) {
    let shell = terminal_id.starts_with(SHELL_PREFIX);
    let mut set = vec![("TERM".to_string(), "xterm-256color".to_string()), ("COLORTERM".to_string(), "truecolor".to_string())];
    if !shell {
        set.push(("HIVEMIND_SESSION".to_string(), terminal_id.to_string()));
    }
    if let Some(root) = memory_root {
        set.push(("LIVING_MEMORY_ROOT".to_string(), root.display().to_string()));
    }
    let mut remove: Vec<String> = if own.iter().any(|name| name == "CLAUDECODE") {
        own.iter().filter(|name| name.starts_with("CLAUDE") || *name == "NO_COLOR").cloned().collect()
    } else {
        vec![]
    };
    if shell && own.iter().any(|name| name == "HIVEMIND_SESSION") {
        remove.push("HIVEMIND_SESSION".to_string());
    }
    (set, remove)
}

/// Terminal ids of PowerShell tabs start with this.
pub const SHELL_PREFIX: &str = "shell-";

/// The shell to start and its tab label: PowerShell 7 when `pwsh` is the path of one, else Windows PowerShell under
/// `system_root`. Both start with `-NoLogo`.
pub fn shell_program(pwsh: Option<PathBuf>, system_root: &Path) -> (Cli, &'static str) {
    match pwsh {
        Some(path) => (Cli { program: path.display().to_string(), args: vec!["-NoLogo".into()] }, "PowerShell"),
        None => {
            let exe = system_root.join("System32").join("WindowsPowerShell").join("v1.0").join("powershell.exe");
            (Cli { program: exe.display().to_string(), args: vec!["-NoLogo".into()] }, "Windows PowerShell")
        }
    }
}

/// The shell on this machine; an error on systems other than Windows.
pub fn shell() -> Result<(Cli, &'static str), String> {
    if !cfg!(windows) {
        return Err("PowerShell tabs are for Windows".into());
    }
    let on_path = std::env::var_os("PATH").and_then(|path| std::env::split_paths(&path).map(|dir| dir.join("pwsh.exe")).find(|exe| exe.is_file()));
    let installed = std::env::var_os("ProgramFiles").map(|dir| PathBuf::from(dir).join("PowerShell").join("7").join("pwsh.exe")).filter(|exe| exe.is_file());
    let root = std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    Ok(shell_program(on_path.or(installed), &root))
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
    use crate::agent::access::{ClaudeMode, Sandbox};

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

    fn claude(mode: ClaudeMode) -> Access {
        Access::Claude { mode }
    }

    fn codex(sandbox: Sandbox, approval: Approval) -> Access {
        Access::Codex { sandbox, approval }
    }

    fn manual() -> Access {
        Access::from_policy(Engine::Claude, PolicyMode::Ask)
    }

    fn read_only() -> Access {
        Access::from_policy(Engine::Codex, PolicyMode::Ask)
    }

    #[test]
    fn session_command_lines() {
        let ctx = Path::new("C:/data/terminals/ID/context");
        let c = ctx.display().to_string();
        let prompt = pointer_prompt(&ctx.join("briefing.md"));
        let args = |engine, mode, access: &Access, model: Option<&str>, effort: Option<&str>, deny: &[String]| {
            session_args(engine, mode, access, model, effort, deny, None, ID, ctx, false)
        };
        let (fresh, resume) = (StartMode::Fresh, StartMode::Resume);
        let none: Vec<String> = vec![];
        let edits = Access::from_policy(Engine::Claude, PolicyMode::AcceptEdits);
        let writes = Access::from_policy(Engine::Codex, PolicyMode::AcceptEdits);

        assert_eq!(
            args(Engine::Claude, fresh, &manual(), None, None, &none),
            vec!["--add-dir", &c, "--session-id", ID, "--permission-mode", "manual", &prompt]
        );
        assert_eq!(args(Engine::Claude, resume, &edits, None, None, &none), vec!["--add-dir", &c, "--resume", ID, "--permission-mode", "acceptEdits"]);
        assert_eq!(
            args(Engine::Codex, fresh, &read_only(), None, None, &none),
            vec!["--no-alt-screen", "--no-daemon", "-s", "read-only", "-a", "on-request", &prompt]
        );
        assert_eq!(
            args(Engine::Codex, resume, &writes, None, None, &none),
            vec!["resume", "--last", "--no-alt-screen", "--no-daemon", "-s", "workspace-write", "-a", "on-request"]
        );

        // A Claude model and effort come before the permission mode.
        assert_eq!(
            args(Engine::Claude, fresh, &manual(), Some("fable"), Some("xhigh"), &none),
            vec!["--add-dir", &c, "--session-id", ID, "--model", "fable", "--effort", "xhigh", "--permission-mode", "manual", &prompt]
        );
        assert_eq!(
            args(Engine::Claude, resume, &manual(), None, Some("low"), &none),
            vec!["--add-dir", &c, "--resume", ID, "--effort", "low", "--permission-mode", "manual"]
        );
        // A Codex model is `-m`; its effort is one `-c` argument holding a TOML string.
        assert_eq!(
            args(Engine::Codex, fresh, &read_only(), Some("gpt-6.1-sol"), Some("high"), &none),
            vec![
                "--no-alt-screen", "--no-daemon", "-m", "gpt-6.1-sol", "-c", "model_reasoning_effort=\"high\"", "-s", "read-only", "-a", "on-request",
                &prompt
            ]
        );
        assert_eq!(
            args(Engine::Codex, resume, &writes, None, Some("low"), &none),
            vec!["resume", "--last", "--no-alt-screen", "--no-daemon", "-c", "model_reasoning_effort=\"low\"", "-s", "workspace-write", "-a", "on-request"]
        );

        // Deny rules follow `--add-dir` and never sit directly before the prompt.
        let deny = strings(&["Bash(x *)", "PowerShell(x *)"]);
        let fresh_deny = args(Engine::Claude, fresh, &manual(), None, None, &deny);
        assert_eq!(fresh_deny[..6], strings(&["--add-dir", &c, "--disallowedTools", "Bash(x *)", "PowerShell(x *)", "--session-id"])[..]);
        assert_eq!(fresh_deny[6], ID);
        let resume_deny = args(Engine::Claude, resume, &edits, None, None, &deny);
        assert_eq!(resume_deny[..6], strings(&["--add-dir", &c, "--disallowedTools", "Bash(x *)", "PowerShell(x *)", "--resume"])[..]);
        for list in [&fresh_deny, &resume_deny] {
            let after = list.iter().position(|a| a == "PowerShell(x *)").unwrap() + 1;
            assert_ne!(list[after], prompt);
        }
        assert_eq!(args(Engine::Codex, fresh, &read_only(), None, None, &deny), args(Engine::Codex, fresh, &read_only(), None, None, &none));
        assert_eq!(args(Engine::Codex, resume, &writes, None, None, &deny), args(Engine::Codex, resume, &writes, None, None, &none));
    }

    #[test]
    fn every_permission_setting_has_its_flags() {
        let ctx = Path::new("C:/data/terminals/ID/context");
        let prompt = pointer_prompt(&ctx.join("briefing.md"));
        let build = |engine, mode, access: &Access| session_args(engine, mode, access, None, None, &[], None, ID, ctx, false);
        for (mode, name) in [
            (ClaudeMode::Manual, "manual"),
            (ClaudeMode::AcceptEdits, "acceptEdits"),
            (ClaudeMode::Plan, "plan"),
            (ClaudeMode::Auto, "auto"),
            (ClaudeMode::DontAsk, "dontAsk"),
            (ClaudeMode::BypassPermissions, "bypassPermissions"),
        ] {
            let fresh = build(Engine::Claude, StartMode::Fresh, &claude(mode));
            assert_eq!(fresh[fresh.len() - 3..], strings(&["--permission-mode", name, &prompt])[..]);
            let resume = build(Engine::Claude, StartMode::Resume, &claude(mode));
            assert_eq!(resume[resume.len() - 2..], strings(&["--permission-mode", name])[..]);
        }
        for sandbox in [Sandbox::ReadOnly, Sandbox::WorkspaceWrite, Sandbox::DangerFullAccess] {
            for approval in [Approval::OnRequest, Approval::Never] {
                let access = codex(sandbox, approval);
                let want = strings(&["--no-alt-screen", "--no-daemon", "-s", sandbox.name(), "-a", approval.name()]);
                let fresh = build(Engine::Codex, StartMode::Fresh, &access);
                assert_eq!(fresh, [want.clone(), vec![prompt.clone()]].concat());
                let resume = build(Engine::Codex, StartMode::Resume, &access);
                assert_eq!(resume, [strings(&["resume", "--last"]), want].concat());
            }
        }
        // Approve for me has no `-a`, and always runs in workspace-write.
        for sandbox in [Sandbox::WorkspaceWrite, Sandbox::ReadOnly] {
            let access = codex(sandbox, Approval::ApproveForMe);
            let want = strings(&["--no-alt-screen", "--no-daemon", "--approve-for-me"]);
            assert_eq!(build(Engine::Codex, StartMode::Fresh, &access), [want.clone(), vec![prompt.clone()]].concat());
            assert_eq!(build(Engine::Codex, StartMode::Resume, &access), [strings(&["resume", "--last"]), want].concat());
        }
        // Settings of the other engine fall back to the safe default.
        assert_eq!(build(Engine::Codex, StartMode::Fresh, &claude(ClaudeMode::BypassPermissions)), build(Engine::Codex, StartMode::Fresh, &read_only()));
        assert_eq!(build(Engine::Claude, StartMode::Fresh, &codex(Sandbox::DangerFullAccess, Approval::Never)), build(Engine::Claude, StartMode::Fresh, &manual()));
    }

    #[test]
    fn a_session_name_goes_to_claude_only() {
        let ctx = Path::new("C:/data/terminals/ID/context");
        let prompt = pointer_prompt(&ctx.join("briefing.md"));
        let named = |engine, mode| session_args(engine, mode, &Access::from_policy(engine, PolicyMode::Ask), None, None, &[], Some("Fix login"), ID, ctx, false);
        let fresh = named(Engine::Claude, StartMode::Fresh);
        assert_eq!(fresh[fresh.len() - 3..], strings(&["--name", "Fix login", &prompt])[..]);
        let resume = named(Engine::Claude, StartMode::Resume);
        assert_eq!(resume[resume.len() - 2..], strings(&["--name", "Fix login"])[..]);
        for mode in [StartMode::Fresh, StartMode::Resume] {
            assert_eq!(named(Engine::Codex, mode), session_args(Engine::Codex, mode, &read_only(), None, None, &[], None, ID, ctx, false));
        }
    }

    #[test]
    fn a_session_without_a_task_gets_no_prompt() {
        let ctx = Path::new("C:/data/terminals/ID/context");
        let prompt = pointer_prompt(&ctx.join("briefing.md"));
        for engine in [Engine::Claude, Engine::Codex] {
            let access = Access::from_policy(engine, PolicyMode::Ask);
            let with = session_args(engine, StartMode::Fresh, &access, None, None, &[], None, ID, ctx, false);
            let bare = session_args(engine, StartMode::Fresh, &access, None, None, &[], None, ID, ctx, true);
            assert_eq!(with.last(), Some(&prompt));
            assert_eq!(bare, with[..with.len() - 1], "only the prompt is left out");
        }
        // The briefing folder stays readable to Claude, and a fresh Claude session still gets its id.
        let bare = session_args(Engine::Claude, StartMode::Fresh, &manual(), None, None, &[], None, ID, ctx, true);
        assert!(bare.contains(&"--add-dir".to_string()) && bare.contains(&"--session-id".to_string()));
    }

    #[test]
    fn the_prompt_is_one_line_without_quotes() {
        let ctx = Path::new("C:/data/terminals/ID/context");
        let prompt = pointer_prompt(&ctx.join("briefing.md"));
        assert!(prompt.contains(&ctx.join("briefing.md").display().to_string()));
        assert!(!prompt.contains('"') && !prompt.contains('\n') && !prompt.contains('\r'));
        assert!(prompt.starts_with("Read the file "));
        for policy in [PolicyMode::Ask, PolicyMode::AcceptEdits] {
            let access = Access::from_policy(Engine::Claude, policy);
            let list = session_args(Engine::Claude, StartMode::Fresh, &access, None, None, &[], None, ID, ctx, false);
            assert_eq!(list.last(), Some(&prompt));
            assert_eq!(list[list.len() - 2], if policy == PolicyMode::AcceptEdits { "acceptEdits" } else { "manual" });
        }
    }

    #[test]
    fn login_command_lines() {
        assert_eq!(login_args(Engine::Claude), vec!["auth", "login"]);
        assert_eq!(login_args(Engine::Codex), vec!["login"]);
    }

    #[test]
    fn environment_adds_colour_and_strips_a_nested_session() {
        let colour = vec![
            ("TERM".to_string(), "xterm-256color".to_string()),
            ("COLORTERM".to_string(), "truecolor".to_string()),
            ("HIVEMIND_SESSION".to_string(), ID.to_string()),
        ];
        assert_eq!(environment(&strings(&["PATH", "CLAUDE_CONFIG_DIR"]), None, ID), (colour.clone(), vec![]));
        let (set, remove) = environment(&strings(&["PATH", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CONFIG_DIR", "NO_COLOR"]), None, ID);
        assert_eq!(set, colour);
        assert_eq!(remove, strings(&["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CONFIG_DIR", "NO_COLOR"]));
    }

    #[test]
    fn a_shell_gets_no_session_variable_and_loses_an_inherited_one() {
        let (set, remove) = environment(&strings(&["PATH", "HIVEMIND_SESSION"]), Some(Path::new("C:/demo/store")), "shell-1");
        assert!(set.iter().all(|(k, _)| k != "HIVEMIND_SESSION"));
        for key in ["TERM", "COLORTERM", "LIVING_MEMORY_ROOT"] {
            assert!(set.iter().any(|(k, _)| k == key), "{key}");
        }
        assert_eq!(remove, strings(&["HIVEMIND_SESSION"]));
        let (set, remove) = environment(&strings(&["PATH"]), None, "shell-1");
        assert!(set.iter().all(|(k, _)| k != "HIVEMIND_SESSION") && remove.is_empty());
        // Programs of agents still get it, and it is not removed from them.
        let (set, remove) = environment(&strings(&["HIVEMIND_SESSION"]), None, ID);
        assert!(set.contains(&("HIVEMIND_SESSION".to_string(), ID.to_string())));
        assert!(remove.is_empty());
    }

    #[test]
    fn the_shell_is_pwsh_when_found_else_windows_powershell() {
        let (cli, label) = shell_program(Some(PathBuf::from("C:/Program Files/PowerShell/7/pwsh.exe")), Path::new("C:/Windows"));
        assert_eq!((cli.program.as_str(), cli.args, label), ("C:/Program Files/PowerShell/7/pwsh.exe", vec!["-NoLogo".to_string()], "PowerShell"));
        let (cli, label) = shell_program(None, Path::new("C:/Windows"));
        assert!(cli.program.replace('\\', "/").ends_with("Windows/System32/WindowsPowerShell/v1.0/powershell.exe"), "{}", cli.program);
        assert_eq!((cli.args, label), (vec!["-NoLogo".to_string()], "Windows PowerShell"));
    }

    #[test]
    #[cfg(not(windows))]
    fn shell_tabs_are_for_windows() {
        assert_eq!(shell().unwrap_err(), "PowerShell tabs are for Windows");
    }

    #[test]
    fn environment_names_the_store_the_app_uses() {
        let (set, remove) = environment(&strings(&["PATH"]), Some(Path::new("C:/demo/store")), "login-claude");
        assert_eq!(set.len(), 4);
        assert!(set.contains(&("HIVEMIND_SESSION".to_string(), "login-claude".to_string())));
        assert!(set.contains(&("LIVING_MEMORY_ROOT".to_string(), "C:/demo/store".to_string())));
        assert!(set.iter().any(|(k, _)| k == "TERM") && set.iter().any(|(k, _)| k == "COLORTERM"));
        assert!(remove.is_empty());
        let (_, remove) = environment(&strings(&["CLAUDECODE", "LIVING_MEMORY_ROOT"]), None, ID);
        assert!(!remove.contains(&"LIVING_MEMORY_ROOT".to_string()));
    }

    #[test]
    fn build_number_is_read_from_ver() {
        assert_eq!(parse_build("\r\nMicrosoft Windows [Version 10.0.26100.9711]\r\n"), Some(26100));
        assert_eq!(parse_build("Microsoft Windows [version 10.0.19045.5131]"), Some(19045));
        assert_eq!(parse_build("nothing"), None);
    }
}
