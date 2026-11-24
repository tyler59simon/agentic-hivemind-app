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

/// Codex from an npm install in `dir` (the folder that holds `codex.cmd` and `node_modules`): its native binary, else `node` and
/// the launcher script.
fn npm_codex(dir: &Path) -> Option<Cli> {
    let package = dir.join("node_modules").join("@openai").join("codex");
    if let Some(exe) = native_codex(&package) {
        return Some(Cli::direct(&exe));
    }
    let script = package.join("bin").join("codex.js");
    script.is_file().then(|| Cli::node(&script))
}

/// Where a per-machine (all users) install of Codex may be. None of these is documented by Codex or recorded in this
/// repository: `Codex` and `OpenAI\Codex` for a copy of the program, and `nodejs` for an npm install whose prefix an
/// administrator set to Node's own folder. The Codex desktop app's copy under `WindowsApps` is not one of them, because it
/// is not the command line program.
pub fn machine_folders() -> Vec<PathBuf> {
    crate::agent::claude::under_program_files(std::env::var_os("ProgramFiles").map(PathBuf::from), &["Codex", r"OpenAI\Codex", "nodejs"])
}

/// The Codex program: the saved path, else a per-machine install in `machine_dirs` (a `codex.exe`, else an npm install),
/// else the npm install's native binary, else `node` and the npm launcher script. Per-machine folders come first because an
/// application allow list (AppLocker) usually permits them and the user's own npm folders usually are not.
/// `machine_dirs`, `path_dirs` and `home` are parameters so tests never touch the real machine.
pub fn locate_codex(saved: &Settings, machine_dirs: &[PathBuf], path_dirs: &[PathBuf], home: &Path) -> Result<Cli, String> {
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
        return machine_dirs
            .iter()
            .chain(path_dirs.iter())
            .chain(usual.iter())
            .map(|dir| dir.join("codex"))
            .find(|path| path.is_file())
            .map(|path| Cli::direct(&path))
            .ok_or_else(|| NO_CODEX.to_string());
    }
    // A saved `codex.cmd` names the npm folder to use, so it goes before the per-machine folders too.
    for dir in machine_dirs.iter().filter(|_| npm_folders.is_none()) {
        let exe = dir.join("codex.exe");
        if exe.is_file() {
            return Ok(Cli::direct(&exe));
        }
        if let Some(cli) = npm_codex(dir) {
            return Ok(cli);
        }
    }
    let folders = npm_folders.unwrap_or_else(|| path_dirs.iter().filter(|dir| dir.join("codex.cmd").is_file()).cloned().collect());
    if let Some(cli) = folders.iter().find_map(|dir| npm_codex(dir)) {
        return Ok(cli);
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
    locate_codex(saved, &machine_folders(), &path_dirs, &home)
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

/// The one-line prompt that points a resumed CLI at the user's review feedback.
pub fn review_prompt(file: &Path) -> String {
    format!("Read the file {}. It holds review feedback on your changes.", file.display())
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
    thread: Option<&str>,
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
            // A resume continues the imported conversation when there is one; a new conversation is the session's own id.
            args.push(text(if mode == StartMode::Resume { thread.unwrap_or(session_id) } else { session_id }));
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
                // The thread this session started, when it is known; otherwise the folder's newest conversation.
                args.extend([text("resume"), thread.map_or_else(|| text("--last"), text)]);
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

/// The arguments that make a session terminal report attention (section 5.4), placed before the session's own: Claude
/// Code reads its hooks from `settings` (written by `signal::prepare_claude`); Codex rings the terminal with OSC 9.
/// The sign-in terminal gets none of this.
pub fn signal_args(engine: Engine, settings: Option<&Path>) -> Vec<String> {
    match engine {
        Engine::Claude => settings.map(|path| vec!["--settings".to_string(), path.display().to_string()]).unwrap_or_default(),
        // Each value is a TOML value, quoted as the reasoning-effort override above is.
        Engine::Codex => vec![
            "-c".into(),
            "tui.notifications=[\"approval-requested\",\"agent-turn-complete\"]".into(),
            "-c".into(),
            "tui.notification_method=\"osc9\"".into(),
        ],
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
/// plans and direct writes from a shell, and the Living Memory guard refuses them while the variable is set.
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

/// Terminal ids of shell tabs (PowerShell, or the login shell off Windows) start with this.
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

/// The user's login shell off Windows: `$SHELL` when it is an absolute path, else `/bin/zsh` (the macOS default), started
/// with `-l` so it reads the profile a Terminal window reads. The label is the shell's name.
pub fn posix_shell(shell: Option<&str>) -> (Cli, &'static str) {
    let program = shell.filter(|s| s.starts_with('/')).unwrap_or("/bin/zsh").to_string();
    let label = match Path::new(&program).file_name().and_then(|n| n.to_str()) {
        Some("zsh") => "zsh",
        Some("bash") => "bash",
        Some("fish") => "fish",
        _ => "Shell",
    };
    (Cli { program, args: vec!["-l".into()] }, label)
}

/// The shell on this machine: PowerShell on Windows, the login shell elsewhere.
pub fn shell() -> Result<(Cli, &'static str), String> {
    if !cfg!(windows) {
        return Ok(posix_shell(std::env::var("SHELL").ok().as_deref()));
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

    #[test]
    fn attention_arguments_per_engine() {
        let settings = Path::new("C:/data/terminals/x/settings.json");
        assert_eq!(signal_args(Engine::Claude, Some(settings)), strings(&["--settings", &settings.display().to_string()]));
        assert!(signal_args(Engine::Claude, None).is_empty());
        let codex = signal_args(Engine::Codex, None);
        assert_eq!(codex, strings(&["-c", "tui.notifications=[\"approval-requested\",\"agent-turn-complete\"]", "-c", "tui.notification_method=\"osc9\""]));
        assert_eq!(signal_args(Engine::Codex, Some(settings)), codex);
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

        let found = locate_codex(&none, &[], &dirs, &home).unwrap();
        assert_eq!(found, Cli { program: exe.display().to_string(), args: vec![] });
        sane(&found);

        std::fs::remove_file(&exe).unwrap();
        let found = locate_codex(&none, &[], &dirs, &home).unwrap();
        assert_eq!(found, Cli { program: "node".into(), args: vec![script.display().to_string()] });
        sane(&found);

        // A saved path that does not exist falls through to PATH.
        let gone = Settings { codex_path: Some(root.join("gone.exe").display().to_string()), ..Default::default() };
        assert_eq!(locate_codex(&gone, &[], &dirs, &home).unwrap().program, "node");

        std::fs::remove_file(&script).unwrap();
        assert_eq!(locate_codex(&none, &[], &dirs, &home), Err(NO_CODEX.to_string()));

        // A saved program wins, whatever PATH holds.
        std::fs::write(&exe, "").unwrap();
        let chosen = root.join("x.exe");
        std::fs::write(&chosen, "").unwrap();
        let saved = Settings { codex_path: Some(chosen.display().to_string()), ..Default::default() };
        assert_eq!(locate_codex(&saved, &[], &dirs, &home).unwrap(), Cli { program: chosen.display().to_string(), args: vec![] });
        std::fs::remove_dir_all(root).ok();
    }

    #[cfg(windows)]
    #[test]
    fn a_per_machine_codex_comes_before_path_and_npm() {   // REG-17
        let root = temp("codex-machine");
        let (npm, home) = (root.join("npm"), root.join("home"));
        let (copy, prefix) = (root.join("Program Files").join("Codex"), root.join("Program Files").join("nodejs"));
        let npm_script = npm.join("node_modules").join("@openai").join("codex").join("bin").join("codex.js");
        let machine_script = prefix.join("node_modules").join("@openai").join("codex").join("bin").join("codex.js");
        for file in [npm.join("codex.cmd"), npm_script.clone(), machine_script.clone(), copy.join("codex.exe")] {
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(&file, "").unwrap();
        }
        let (none, path_dirs, machine) = (Settings::default(), [npm.clone()], [copy.clone(), prefix.clone()]);
        let node = |script: &Path| Cli { program: "node".into(), args: vec![script.display().to_string()] };
        // A codex.exe in a per-machine folder beats the npm install on PATH.
        assert_eq!(locate_codex(&none, &machine, &path_dirs, &home).unwrap(), Cli { program: copy.join("codex.exe").display().to_string(), args: vec![] });
        // Without it, a machine-wide npm install (here under the folder an administrator set as npm's prefix) still beats PATH.
        std::fs::remove_file(copy.join("codex.exe")).unwrap();
        assert_eq!(locate_codex(&none, &machine, &path_dirs, &home).unwrap(), node(&machine_script));
        // With nothing per machine, PATH and the npm folders work as before.
        assert_eq!(locate_codex(&none, &[], &path_dirs, &home).unwrap(), node(&npm_script));
        assert_eq!(locate_codex(&none, std::slice::from_ref(&copy), &path_dirs, &home).unwrap(), node(&npm_script));
        // The saved program still wins over everything.
        let chosen = root.join("x.exe");
        std::fs::write(&chosen, "").unwrap();
        let saved = Settings { codex_path: Some(chosen.display().to_string()), ..Default::default() };
        assert_eq!(locate_codex(&saved, &machine, &path_dirs, &home).unwrap(), Cli { program: chosen.display().to_string(), args: vec![] });
        // So does a saved codex.cmd, which names the npm folder to use.
        let saved_cmd = Settings { codex_path: Some(npm.join("codex.cmd").display().to_string()), ..Default::default() };
        assert_eq!(locate_codex(&saved_cmd, &machine, &[], &home).unwrap(), node(&npm_script));
        std::fs::remove_dir_all(root).ok();
    }

    #[cfg(not(windows))]
    #[test]
    fn a_per_machine_codex_comes_before_path() {   // REG-17
        let root = temp("codex-machine");
        let (machine, bin, home) = (root.join("opt"), root.join("bin"), root.join("home"));
        for dir in [&machine, &bin] {
            std::fs::create_dir_all(dir).unwrap();
            std::fs::write(dir.join("codex"), "").unwrap();
        }
        let found = locate_codex(&Settings::default(), std::slice::from_ref(&machine), &[bin], &home).unwrap();
        assert_eq!(found, Cli { program: machine.join("codex").display().to_string(), args: vec![] });
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
        assert_eq!(locate_codex(&none, &[], &[bin.clone()], &home).unwrap(), Cli { program: found.display().to_string(), args: vec![] });
        std::fs::remove_file(&found).unwrap();
        // The fixed folders may hold a real codex on this machine, so only check the error without one.
        if !Path::new("/opt/homebrew/bin/codex").exists() && !Path::new("/usr/local/bin/codex").exists() {
            assert_eq!(locate_codex(&none, &[], &[bin], &home), Err(NO_CODEX.to_string()));
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
            session_args(engine, mode, access, model, effort, deny, None, ID, ctx, false, None)
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
    fn claude_resumes_an_imported_conversation_by_its_own_id() {
        let ctx = Path::new("C:/data/terminals/ID/context");
        let access = Access::from_policy(Engine::Claude, PolicyMode::Ask);
        let args = |mode, thread| session_args(Engine::Claude, mode, &access, None, None, &[], None, ID, ctx, true, thread);
        let imported = "0ea3c5d4-1111-4222-8333-444455556666";
        let flag = |args: &Vec<String>, name: &str| args.iter().position(|a| a == name).map(|at| args[at + 1].clone());
        assert_eq!(flag(&args(StartMode::Resume, Some(imported)), "--resume").as_deref(), Some(imported));
        assert_eq!(flag(&args(StartMode::Resume, None), "--resume").as_deref(), Some(ID));
        // A new conversation always takes the session's own id.
        let fresh = args(StartMode::Fresh, Some(imported));
        assert_eq!((flag(&fresh, "--session-id").as_deref(), flag(&fresh, "--resume")), (Some(ID), None));
    }

    #[test]
    fn codex_resumes_a_known_thread_by_id_and_else_the_newest() {
        let ctx = Path::new("C:/data/terminals/ID/context");
        let access = Access::from_policy(Engine::Codex, PolicyMode::Ask);
        let args = |mode, thread| session_args(Engine::Codex, mode, &access, None, None, &[], None, ID, ctx, false, thread);
        let by_id = args(StartMode::Resume, Some("019b0000-aaaa-7bbb-8ccc-ddddeeeeffff"));
        assert_eq!(by_id[..2], strings(&["resume", "019b0000-aaaa-7bbb-8ccc-ddddeeeeffff"])[..]);
        assert_eq!(args(StartMode::Resume, None)[..2], strings(&["resume", "--last"])[..]);
        // A fresh start never resumes, whatever thread is stored.
        assert_eq!(args(StartMode::Fresh, Some("x")), args(StartMode::Fresh, None));
    }

    #[test]
    fn every_permission_setting_has_its_flags() {
        let ctx = Path::new("C:/data/terminals/ID/context");
        let prompt = pointer_prompt(&ctx.join("briefing.md"));
        let build = |engine, mode, access: &Access| session_args(engine, mode, access, None, None, &[], None, ID, ctx, false, None);
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
        let named = |engine, mode| session_args(engine, mode, &Access::from_policy(engine, PolicyMode::Ask), None, None, &[], Some("Fix login"), ID, ctx, false, None);
        let fresh = named(Engine::Claude, StartMode::Fresh);
        assert_eq!(fresh[fresh.len() - 3..], strings(&["--name", "Fix login", &prompt])[..]);
        let resume = named(Engine::Claude, StartMode::Resume);
        assert_eq!(resume[resume.len() - 2..], strings(&["--name", "Fix login"])[..]);
        for mode in [StartMode::Fresh, StartMode::Resume] {
            assert_eq!(named(Engine::Codex, mode), session_args(Engine::Codex, mode, &read_only(), None, None, &[], None, ID, ctx, false, None));
        }
    }

    #[test]
    fn a_session_without_a_task_gets_no_prompt() {
        let ctx = Path::new("C:/data/terminals/ID/context");
        let prompt = pointer_prompt(&ctx.join("briefing.md"));
        for engine in [Engine::Claude, Engine::Codex] {
            let access = Access::from_policy(engine, PolicyMode::Ask);
            let with = session_args(engine, StartMode::Fresh, &access, None, None, &[], None, ID, ctx, false, None);
            let bare = session_args(engine, StartMode::Fresh, &access, None, None, &[], None, ID, ctx, true, None);
            assert_eq!(with.last(), Some(&prompt));
            assert_eq!(bare, with[..with.len() - 1], "only the prompt is left out");
        }
        // The briefing folder stays readable to Claude, and a fresh Claude session still gets its id.
        let bare = session_args(Engine::Claude, StartMode::Fresh, &manual(), None, None, &[], None, ID, ctx, true, None);
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
            let list = session_args(Engine::Claude, StartMode::Fresh, &access, None, None, &[], None, ID, ctx, false, None);
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
    fn the_shell_off_windows_is_the_login_shell() {
        let (cli, label) = posix_shell(Some("/opt/homebrew/bin/fish"));
        assert_eq!((cli.program.as_str(), cli.args, label), ("/opt/homebrew/bin/fish", vec!["-l".to_string()], "fish"));
        assert_eq!(posix_shell(None).0.program, "/bin/zsh");
        assert_eq!(posix_shell(Some("zsh")).0.program, "/bin/zsh");   // not absolute: the default
        assert_eq!(posix_shell(Some("/usr/local/bin/nu")).1, "Shell");
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
