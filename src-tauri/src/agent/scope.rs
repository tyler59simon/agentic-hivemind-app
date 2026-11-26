//! What a task may touch. The folders and permissions come from Living Memory's registry and from
//! this file, never from the webview: the webview only names the task.
use super::SessionInfo;
use super::TITLE;
use super::events::{Mode, clip};
use super::roles::Profile;
use crate::bridge::Bridge;
use crate::settings::Settings;
use crate::worktree::Worktree;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};

pub const SUITE_PLUGIN: &str = "architecture-suite";

/// The structured result a system passport session must end with.
const PASSPORT_SCHEMA: &str = r#"{
  "type": "object",
  "required": ["summary"],
  "properties": {
    "summary": {"type": "string"},
    "registry": {
      "type": "object",
      "properties": {
        "description": {"type": "string"},
        "capabilities": {"type": "array", "items": {"type": "string"}},
        "owners": {"type": "array", "items": {"type": "string"}},
        "depends_on": {"type": "array", "items": {"type": "string"}}
      }
    },
    "notes": {"type": "array", "items": {"type": "string"}},
    "gaps": {"type": "array", "items": {"type": "string"}}
  }
}"#;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AgentTask {
    /// Describe one registered system with the Architecture Suite.
    SystemPassport { slug: String },
    /// Work on a project's repository, in a worktree, with the user answering prompts.
    Work {
        project: String,
        repo: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        branch: Option<String>,
    },
    /// Work in a folder the user picked with the native dialog, in place. Terminal only.
    Folder { path: String },
    /// The executive workspace's chat: no repository, Living Memory read only, about one project or all of them.
    Executive {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        project: Option<String>,
    },
}

/// How gated actions are decided, as stored on a session.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum PolicyMode {
    #[default]
    PreApproved,
    Ask,
    AcceptEdits,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Policy {
    /// Nothing is asked: the listed rules are allowed and every other gated tool call is denied.
    PreApproved { allow: Vec<String> },
    /// The user is asked about every gated call the rules do not cover.
    Ask { allow: Vec<String> },
    /// As `Ask`, but file edits inside the working folder are not asked about.
    AcceptEdits { allow: Vec<String> },
}

impl Policy {
    pub fn mode(&self) -> PolicyMode {
        match self {
            Policy::PreApproved { .. } => PolicyMode::PreApproved,
            Policy::Ask { .. } => PolicyMode::Ask,
            Policy::AcceptEdits { .. } => PolicyMode::AcceptEdits,
        }
    }

    pub fn allow(&self) -> &[String] {
        match self {
            Policy::PreApproved { allow } | Policy::Ask { allow } | Policy::AcceptEdits { allow } => allow,
        }
    }
}

/// Everything an adapter needs to build its command line.
#[derive(Clone, Debug, PartialEq)]
pub struct Spec {
    pub session_id: String,
    pub cwd: PathBuf,
    pub add_dirs: Vec<PathBuf>,
    pub policy: Policy,
    pub plugin_dirs: Vec<PathBuf>,
    pub budget_usd: f64,
    pub schema: Option<Value>,
    pub program: String,
    /// Arguments that go between the program and the CLI's own: empty for Claude Code, `codex.js` for Codex run through `node`.
    pub program_args: Vec<String>,
    /// Continue the CLI's own conversation `session_id` instead of creating it.
    pub resume: bool,
    /// A model alias for `--model`, or None for the user's Claude Code default.
    pub model: Option<String>,
    /// Rules the CLI must refuse whatever else allows them (`--disallowedTools`). Copied from the scope.
    pub deny: Vec<String>,
    /// Start the CLI without the user's settings, skills or MCP servers, and with only the shell and its to-do list. Copied
    /// from the scope.
    pub isolated: bool,
    /// Whether an isolated session passes `--strict-mcp-config`. False when a managed MCP file is deployed and the user
    /// allowed Claude under managed policy: Claude Code exits on the flag then. Copied from the launch.
    pub strict_mcp: bool,
    /// The Living Memory store the app is connected to; the CLI's hooks must use the same one. None when the app uses
    /// Living Memory's own default.
    pub memory_root: Option<PathBuf>,
}

/// A task resolved against the registry.
#[derive(Clone, Debug, PartialEq)]
pub struct Scope {
    pub title: String,
    pub cwd: PathBuf,
    pub add_dirs: Vec<PathBuf>,
    pub policy: Policy,
    pub schema: Option<Value>,
    pub plugin_dirs: Vec<PathBuf>,
    /// A plugin the CLI must report as loaded, or the session is stopped.
    pub required_plugin: Option<String>,
    pub mode: Mode,
    pub worktree: Option<Worktree>,
    /// Rules denied in every session: `deny_rules()`. Set for passport and work scopes alike.
    pub deny: Vec<String>,
    /// No user settings, skills, MCP servers or file tools: only the allow rules here decide what runs. The executive chat.
    pub isolated: bool,
}

/// A folder as Claude Code's permission rules spell it: POSIX separators and one extra leading
/// slash, with a Windows drive as `//c/`.
pub fn rule_path(path: &str) -> String {
    let bytes = path.as_bytes();
    let spelled = if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        format!("//{}{}", path[..1].to_ascii_lowercase(), path[2..].replace('\\', "/"))
    } else {
        format!("/{path}")
    };
    spelled.trim_end_matches('/').to_string()
}

/// The only things a passport session may do beyond reading. Provisional until verified against
/// a real Architecture Suite run. Living Memory's own hook allows its read and capture commands;
/// its governed commands must stay denied, so nothing here may match them.
fn passport_rules(architecture: &Path) -> Vec<String> {
    vec![
        format!("Edit({}/**)", rule_path(&architecture.display().to_string())),
        "Bash(*architecture-suite.py *)".into(),
        "PowerShell(*architecture-suite.py *)".into(),
    ]
}

/// The interpreter the Architecture Suite's one-time setup installs.
pub fn suite_runtime(home: &Path) -> Result<PathBuf, String> {
    let runtime = home.join(".architecture-suite").join("runtime");
    let python = if cfg!(windows) { runtime.join("Scripts").join("python.exe") } else { runtime.join("bin").join("python") };
    if python.is_file() {
        Ok(python)
    } else {
        Err(format!("The Architecture Suite's one-time setup has not been run: there is no interpreter at {}", python.display()))
    }
}

fn system_passport(entry: &Value, saved: &Settings, home: &Path) -> Result<Scope, String> {
    let mut repos = entry.get("repos").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(PathBuf::from);
    let cwd = repos.next().ok_or("This system has no repositories; add one to the system first.")?;
    let architecture = entry
        .get("architecture")
        .and_then(Value::as_str)
        .filter(|folder| !folder.trim().is_empty())
        .map(PathBuf::from)
        .ok_or("This system has no architecture folder set; choose one for the system first.")?;
    if !cwd.is_dir() {
        return Err(format!("The system's first repository folder does not exist: {}", cwd.display()));
    }
    suite_runtime(home)?;
    // The output folder: the session may only write here.
    std::fs::create_dir_all(&architecture)
        .map_err(|e| format!("Could not create the architecture folder {}: {e}", architecture.display()))?;
    let name = entry.get("name").or_else(|| entry.get("slug")).and_then(Value::as_str).unwrap_or("system");
    Ok(Scope {
        title: format!("System passport: {name}"),
        cwd,
        add_dirs: repos.chain([architecture.clone()]).collect(),
        policy: Policy::PreApproved { allow: passport_rules(&architecture) },
        schema: Some(serde_json::from_str(PASSPORT_SCHEMA).map_err(|e| e.to_string())?),
        plugin_dirs: saved.architecture_suite_plugin.iter().filter(|dir| !dir.trim().is_empty()).map(PathBuf::from).collect(),
        required_plugin: Some(SUITE_PLUGIN.into()),
        mode: Mode::Unattended,
        worktree: None,
        deny: deny_rules(),
        isolated: false,
    })
}

/// Look the task's subject up in Living Memory and work out what the session may touch.
pub fn for_task(bridge: &Bridge, task: &AgentTask, saved: &Settings, home: &Path) -> Result<Scope, String> {
    match task {
        AgentTask::SystemPassport { slug } => system_passport(&crate::architecture::system_entry(bridge, slug)?, saved, home),
        AgentTask::Work { .. } | AgentTask::Folder { .. } => Err("A work session is started with start_task".into()),
        AgentTask::Executive { .. } => Err("An executive session is started with start_executive".into()),
    }
}

/// Compare two folder spellings the way README 7.1 says: slashes and case do not matter.
pub fn same_path(a: &str, b: &str) -> bool {
    let normal = |path: &str| path.replace('\\', "/").trim_end_matches('/').to_lowercase();
    normal(a) == normal(b)
}

/// The registry's own spelling of `repo` when it is one of the project's repositories.
pub fn project_repo(entry: &Value, repo: &str) -> Result<PathBuf, String> {
    let repos = entry.get("repos").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str);
    let mut found = repos.filter(|candidate| same_path(candidate, repo));
    found.next().map(PathBuf::from).ok_or_else(|| "That repository is not registered for this project".into())
}

/// What a work session may touch: its worktree, and nothing without asking beyond reading it.
pub fn work(tree: Worktree, policy: PolicyMode, prompt: &str) -> Result<Scope, String> {
    let (cwd, title) = (PathBuf::from(&tree.path), task_title(prompt));
    place(cwd, Some(tree), policy, title)
}

/// Tools every profile may use without asking: reading, searching, the agent's own to-do list and installed skills.
const READ_TOOLS: [&str; 5] = ["Read", "Glob", "Grep", "TodoWrite", "Skill"];

/// Git commands that only read, which every profile may run: reviewers and testers need the history and the diff.
const READ_GIT: [&str; 5] = ["git log", "git show", "git diff", "git status", "git blame"];

/// The longest command the user may allow for a project.
const COMMAND_MAX: usize = 120;

/// A command the user allows for a project, checked: one plain command line with no way to chain another after it.
pub fn check_command(command: &str) -> Result<String, String> {
    let command = command.trim();
    if command.is_empty() || command.chars().count() > COMMAND_MAX {
        return Err(format!("An allowed command must be 1 to {COMMAND_MAX} characters"));
    }
    if command.contains(['\n', '\r', ';', '|', '&', '`', '>', '<', '(', ')', '*']) || command.contains("$(") {
        return Err(format!("An allowed command must be one plain command, without ; | & ` > < ( ) or *: {command}"));
    }
    Ok(command.to_string())
}

/// The allow rules for a project's commands: the command alone or followed by arguments, in either shell.
fn command_rules(commands: &[String]) -> Result<Vec<String>, String> {
    let mut rules = vec![];
    for command in commands {
        let command = check_command(command)?;
        for tool in ["Bash", "PowerShell"] {
            rules.push(format!("{tool}({command})"));
            rules.push(format!("{tool}({command} *)"));
        }
    }
    Ok(rules)
}

/// The rules a profile stands for in the folder `cwd`. Read-only profiles never ask, attended or not. An unattended
/// editing session is pre-approved to edit inside `cwd` and run the allowed commands; everything else is refused. An attended
/// one accepts edits and asks about the rest.
pub fn profile_policy(profile: Profile, cwd: &Path, attended: bool, commands: &[String]) -> Result<Policy, String> {
    let read_git = command_rules(&READ_GIT.map(String::from))?;
    let mut allow: Vec<String> = READ_TOOLS.iter().map(|tool| tool.to_string()).collect();
    allow.extend(read_git.iter().cloned());
    Ok(match profile {
        Profile::ReadOnly => Policy::PreApproved { allow },
        Profile::Research => {
            allow.extend(["WebFetch".to_string(), "WebSearch".to_string()]);
            Policy::PreApproved { allow }
        }
        Profile::EditWorktree if attended => Policy::AcceptEdits { allow: [read_git, command_rules(commands)?].concat() },
        Profile::EditWorktree => {
            allow.push(format!("Edit({}/**)", rule_path(&cwd.display().to_string())));
            allow.extend(command_rules(commands)?);
            Policy::PreApproved { allow }
        }
    })
}

/// Git commands no agent session may run, whatever it is allowed otherwise: they publish, or destroy work Hivemind cannot
/// get back. A rule matches the words anywhere in the command line, so a quoted mention is refused too (the safe side).
const DESTRUCTIVE_GIT: [&str; 5] = ["git push", "git reset --hard", "git clean", "git branch -D", "git branch --delete"];

/// Git options that turn a reading command (READ_GIT) into one that writes a file (`--output=<file>` or `--output <file>`)
/// or runs a program the repository names (`--ext-diff`, `--textconv`). Refused with any git command; `--no-ext-diff`,
/// `--no-textconv` and the read-only `--output-indicator-*` options do not contain them.
const UNSAFE_GIT_OPTIONS: [&str; 4] = ["--output=", "--output ", "--ext-diff", "--textconv"];

/// Every rule a session is denied: Living Memory's governed commands, the destructive git commands and the unsafe git
/// options.
pub fn deny_rules() -> Vec<String> {
    let mut rules = governed_rules();
    for tool in ["Bash", "PowerShell"] {
        rules.extend(DESTRUCTIVE_GIT.iter().map(|command| format!("{tool}(*{command}*)")));
        rules.extend(UNSAFE_GIT_OPTIONS.iter().map(|option| format!("{tool}(*git *{option}*)")));
    }
    rules
}

/// Give a session an extra folder it may read but not edit. The folder's files are denied to every editing tool (an `Edit`
/// rule covers them all), and deny wins over allow, so a broad allow rule of the user's own, such as `Edit(**)`, cannot
/// open it. An attended editing session accepts edits in every folder it was given, so it gets no extra folder. Nor does a
/// folder whose path has a pattern character (`*?[]{}`): the rule is a gitignore-style pattern and might not match the
/// folder, so the session goes without it rather than risk it being writable.
pub fn read_only_folder(scope: &mut Scope, folder: &Path) {
    let path = folder.display().to_string();
    if matches!(scope.policy, Policy::AcceptEdits { .. }) || path.contains(['*', '?', '[', ']', '{', '}']) {
        return;
    }
    scope.deny.push(format!("Edit({}/**)", rule_path(&path)));
    scope.add_dirs.push(folder.to_path_buf());
}

/// What a session in a role may touch: its worktree, with the rules of `profile`.
pub fn work_as(tree: Worktree, profile: Profile, attended: bool, commands: &[String], prompt: &str) -> Result<Scope, String> {
    let cwd = PathBuf::from(&tree.path);
    let policy = profile_policy(profile, &cwd, attended, commands)?;
    Ok(Scope {
        title: task_title(prompt),
        cwd,
        add_dirs: vec![],
        policy,
        schema: None,
        plugin_dirs: vec![],
        required_plugin: None,
        mode: Mode::Interactive,
        worktree: Some(tree),
        deny: deny_rules(),
        isolated: false,
    })
}

/// What a session in a folder of the user's own may touch: that folder, with the same rules as a worktree session and no
/// worktree. `title` is what the tab shows.
pub fn direct(folder: &Path, policy: PolicyMode, title: String) -> Result<Scope, String> {
    place(folder.to_path_buf(), None, policy, title)
}

/// The first line of the task, as a session title.
pub fn task_title(prompt: &str) -> String {
    clip(prompt.lines().map(str::trim).find(|line| !line.is_empty()).unwrap_or_default(), TITLE)
}

fn place(cwd: PathBuf, worktree: Option<Worktree>, policy: PolicyMode, title: String) -> Result<Scope, String> {
    let policy = match policy {
        PolicyMode::Ask => Policy::Ask { allow: vec![] },
        PolicyMode::AcceptEdits => Policy::AcceptEdits { allow: vec![] },
        PolicyMode::PreApproved => return Err("A work session needs the ask or accept_edits policy".into()),
    };
    Ok(Scope {
        title,
        cwd,
        add_dirs: vec![],
        policy,
        schema: None,
        plugin_dirs: vec![],
        required_plugin: None,
        mode: Mode::Interactive,
        worktree,
        deny: deny_rules(),
        isolated: false,
    })
}

/// The picked folder `path` names, in its saved spelling. Anything not picked with the native dialog is refused.
pub fn other_folder(saved: &Settings, path: &str) -> Result<PathBuf, String> {
    let folder = crate::folders::find(saved, path).ok_or("That folder was not chosen with the folder picker")?;
    let folder = PathBuf::from(folder);
    if folder.is_dir() { Ok(folder) } else { Err(format!("The folder no longer exists: {}", folder.display())) }
}

/// Living Memory's read commands, which the executive chat may run without asking.
const MEMORY_READS: [&str; 9] = ["search", "ask", "read", "open", "recap", "log", "timeline", "projects", "history"];
/// Living Memory's writes the executive chat may not run: what it learns reaches memory only through the user's review.
const MEMORY_WRITES: [&str; 12] = ["capture", "update", "propose", "check", "confirm", "resolve", "reopen", "supersede", "restore", "batch", "distinct", "proposals"];

/// Deny rules only: a rule matches the CLI's name anywhere in the command, which over-denies (the safe side) and would
/// over-allow. Allow rules are exact command prefixes (`memory_reads`).
fn memory_rules(verbs: &[&str]) -> Vec<String> {
    ["Bash", "PowerShell"]
        .into_iter()
        .flat_map(|tool| {
            verbs.iter().flat_map(move |verb| {
                ["*alm*", "*living_memory.py*"].into_iter().flat_map(move |cli| [format!("{tool}({cli} {verb} *)"), format!("{tool}({cli} {verb})")])
            })
        })
        .collect()
}

/// Allow rules for exactly the read commands the executive briefing names: `alm --json --domain D VERB ...` for each bound
/// domain, and the cross-domain `open` by tag. A domain whose name could not be spelled as one plain command is left out.
fn memory_reads(domains: &[String]) -> Vec<String> {
    let mut commands: Vec<String> = domains
        .iter()
        .filter(|domain| !domain.is_empty() && !domain.contains(char::is_whitespace))
        .flat_map(|domain| MEMORY_READS.iter().map(move |verb| format!("alm --json --domain {domain} {verb}")))
        .filter(|command| check_command(command).is_ok())
        .collect();
    commands.push("alm --json open --all-domains --tag".into());
    command_rules(&commands).unwrap_or_default()
}

/// The executive chat's scope: an empty working folder of Hivemind's, reading only Living Memory (exact `alm` read commands
/// for `domains`), never asking, denied every Living Memory write, and isolated from the user's own settings, skills and MCP
/// servers (which could allow more). Living Memory's hooks live in those settings, so they do not run here; the folder is
/// bound to no domain, so they gave this chat nothing, and the CLI still refuses governed commands under HIVEMIND_SESSION.
pub fn executive(dir: &Path, title: String, domains: &[String]) -> Result<Scope, String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("Could not create the executive folder {}: {e}", dir.display()))?;
    let mut allow = vec!["TodoWrite".to_string()];
    allow.extend(memory_reads(domains));
    let mut deny = deny_rules();
    deny.extend(memory_rules(&MEMORY_WRITES));
    Ok(Scope {
        title,
        cwd: dir.to_path_buf(),
        add_dirs: vec![],
        policy: Policy::PreApproved { allow },
        schema: None,
        plugin_dirs: vec![],
        required_plugin: None,
        mode: Mode::Interactive,
        worktree: None,
        deny,
        isolated: true,
    })
}

/// A stored executive session's scope. The folder was chosen by Rust when the session started; only an executive folder
/// is accepted back. The domains are read again, so a project bound since then is readable.
fn executive_session(lm: &crate::executive::Lm, info: &SessionInfo, project: Option<&str>) -> Result<Scope, String> {
    let dir = info.workspace.first().map(PathBuf::from).filter(|d| d.ends_with(Path::new("executive").join("agent")));
    let dir = dir.ok_or("This session's folder is not an executive folder")?;
    let domains: Vec<String> = crate::executive::bound_domains(lm, project)?.into_iter().collect();
    executive(&dir, info.title.clone(), &domains)
}

/// The scope of a stored work session, checked against the registry again before a process is started for it.
pub fn for_session(bridge: &Bridge, saved: &Settings, info: &SessionInfo) -> Result<Scope, String> {
    if let AgentTask::Executive { project } = &info.task {
        return executive_session(&crate::executive::viewer(bridge), info, project.as_deref());
    }
    let AgentTask::Work { project, repo, .. } = &info.task else { return Err("This session does not take messages".into()) };
    if info.direct.is_some() {
        return Err("A session in your own folder runs in the terminal and does not take messages".into());
    }
    project_repo(&crate::git::project_entry(bridge, project)?, repo)?;
    let tree = info.worktree.clone().filter(|tree| Path::new(&tree.path).is_dir());
    let tree = tree.ok_or("This session's worktree no longer exists; end the session")?;
    match info.profile {
        // A session in a role keeps its profile; the allowed commands are the project's as they are now.
        Some(profile) => {
            let attended = info.policy != PolicyMode::PreApproved;
            let commands = saved.allowed_commands(project);
            let mut scope = work_as(tree, profile, attended, &commands, &info.title)?;
            scope.title = info.title.clone();
            Ok(scope)
        }
        None => work(tree, info.policy, &info.title),
    }
}

/// The Living Memory commands only the user may run, through Hivemind's own dialogs: undo and recover, setup and upgrade,
/// delete, merge and bulk retag, the store-wide writes (migrate, restore-backup, import, ingest, overlay-teardown), the manual
/// vault syncs (sync, overlay-build, overlay-sync-all, which apply vault deletions) and every other direct write (archive,
/// rewrite, remap, promote, taxonomy add and the source, project, system and type registries), since a user allow rule would
/// let any one missing here run without a question. It is Living Memory's own governed set (`HIVEMIND_GOVERNED` in its
/// core/runtime.py). Living Memory has had no plans since 2026-11-26, so an agent describes such a change and the user makes
/// it. A phrase is a subcommand and the action that makes it a write: `taxonomy` alone only reads, and the phrase keeps the
/// deny rules from refusing a search for the word "project".
const GOVERNED_COMMANDS: [&str; 32] = [
    "undo", "recover", "setup", "upgrade", "delete", "merge", "retag",
    "migrate", "restore-backup", "import", "ingest", "overlay-teardown", "sync", "overlay-build", "overlay-sync-all",
    "archive", "rewrite", "remap", "promote", "taxonomy add", "source add", "source remove", "source implicit",
    "project create", "project update", "project archive", "system create", "system update", "system retire",
    "type create", "type update", "type retire",
];

/// `doc` actions that write, for the deny rules. The guard itself governs every `doc` action but `read` and `propose`, as
/// Living Memory does (`hivemind_governed` in its core/runtime.py): `propose` only stages an edit for the user.
const DOC_WRITES: [&str; 2] = ["doc undo", "doc folder"];

/// Living Memory's global options that take a value (`--root DIR`), as argparse reads them: also abbreviated (`--dom`).
const VALUE_OPTIONS: [&str; 4] = ["--root", "--domain", "--cwd", "--actor"];

/// Programs that run another command given to them (`bash -c "..."`, `cmd /c ...`, `xargs alm ...`): a part they start is
/// refused when it names Living Memory with a governed word. Any other program (`git merge --no-ff alm`) only takes words.
/// Python environment runners (`poetry run`, `conda run`) are wrappers too (Codex re-review, F05).
const WRAPPERS: [&str; 34] = [
    "bash", "sh", "zsh", "dash", "ksh", "fish", "cmd", "powershell", "pwsh", "wsl", "xargs", "env", "sudo", "doas", "nohup",
    "time", "timeout", "nice", "exec", "command", "eval", "start", "uv", "uvx",
    "poetry", "pipenv", "pdm", "hatch", "rye", "pipx", "conda", "mamba", "micromamba", "pixi",
];

/// The `proposals` options that take a value (`--reason R`), besides the global ones: their value is never a proposal ID.
const PROPOSAL_VALUE_OPTIONS: [&str; 8] = ["--reason", "--session", "--turn", "--kind", "--status", "--notebook", "--body-file", "--expected-revision"];

/// A shell command that would make a governed write to the Living Memory store. Its hook lets read and capture commands
/// through before Hivemind is asked; these must never run from a session, whatever the user clicks.
///
/// Each part of a command line that runs Living Memory (`living_memory.py` under Python, or the `alm` launcher) is decided by
/// its subcommand, so `search "delete the cache"` is a search (Codex review of e30902f, G2). A part another program runs
/// through a wrapper (`bash -c "alm archive x"`, `cmd /c alm undo 1`), and a command line that cannot be read cleanly, is
/// refused when it names Living Memory together with a governed word. A part of any other program is not Living Memory
/// (Codex re-review, N14).
pub fn governed_memory_command(command: &str) -> bool {
    let text = command.to_lowercase();
    match shell_parts(&text) {
        Some(parts) => parts.iter().any(|words| governed_part(words)),
        None => names_memory_and_governed(&text),
    }
}

/// One part of a command line, as words.
fn governed_part(words: &[String]) -> bool {
    match program(words) {
        Program::Memory(args) => match subcommand(args) {
            Ok(Some((sub, rest))) => governed_subcommand(sub, rest),
            Ok(None) => false,
            // An option before the subcommand that Living Memory's global options do not have: read the words instead.
            Err(()) => names_memory_and_governed(&words.join(" ")),
        },
        Program::Wrapper => names_memory_and_governed(&words.join(" ")),
        Program::Other => false,
    }
}

/// What a part of a command line runs.
enum Program<'a> {
    /// Living Memory, with the arguments after the script or the launcher.
    Memory(&'a [String]),
    /// A program that runs a command it is given (`WRAPPERS`, or a Python without Living Memory's script).
    Wrapper,
    Other,
}

/// The program is the first word after `call` and `NAME=value` settings: the launcher when its file name is `alm`, `alm.exe`
/// or `alm.cmd`, or a Python whose script (a later word) is `living_memory.py`.
fn program(words: &[String]) -> Program<'_> {
    let Some(start) = words.iter().position(|word| word != "call" && !(word.contains('=') && !word.starts_with('-'))) else { return Program::Other };
    let name = |word: &str| word.rsplit(['/', '\\']).next().unwrap_or(word).to_string();
    let program = name(&words[start]);
    if matches!(program.as_str(), "alm" | "alm.exe" | "alm.cmd") {
        return Program::Memory(&words[start + 1..]);
    }
    let bare = program.strip_suffix(".exe").unwrap_or(&program);
    let python = bare.strip_prefix("python").or_else(|| bare.strip_prefix("py"));
    if python.is_some_and(|version| version.trim_end_matches('w').chars().all(|c| c.is_ascii_digit() || c == '.')) {
        return match words[start + 1..].iter().position(|word| matches!(name(word).as_str(), "living_memory.py" | "living_memory")) {
            Some(script) => Program::Memory(&words[start + 2 + script..]),
            None => Program::Wrapper,
        };
    }
    if WRAPPERS.contains(&bare) {
        return Program::Wrapper;
    }
    // Bash drops a backslash that PowerShell keeps (`al\m` is `alm` to bash): a name that only reads as Living Memory, Python or
    // a wrapper without its backslashes is read as a wrapper.
    let joined = words[start].replace('\\', "");
    let joined = joined.rsplit('/').next().unwrap_or(&joined);
    let joined = joined.strip_suffix(".exe").unwrap_or(joined);
    if joined != bare && (matches!(joined, "alm" | "alm.cmd") || joined.starts_with("py") || WRAPPERS.contains(&joined)) { Program::Wrapper } else { Program::Other }
}

/// The subcommand and the words after it, skipping `--json` and the global options with their values. Err for any other
/// option before it.
fn subcommand(args: &[String]) -> Result<Option<(&str, &[String])>, ()> {
    let mut index = 0;
    while let Some(word) = args.get(index) {
        if !word.starts_with('-') {
            return Ok(Some((word, &args[index + 1..])));
        }
        let (name, value) = word.split_once('=').map_or((word.as_str(), false), |(name, _)| (name, true));
        let takes_value = name.len() >= 3 && VALUE_OPTIONS.iter().any(|option| option.starts_with(name));
        if takes_value {
            index += if value { 1 } else { 2 };
        } else if !value && name.len() >= 4 && "--json".starts_with(name) {
            index += 1;
        } else {
            return Err(());
        }
    }
    Ok(None)
}

/// Whether a subcommand is governed. For a phrase, the action may come anywhere after the subcommand, as argparse allows
/// (`project --payload-file p.json create`). `doc` is governed unless its action reads or proposes, and `proposals` when it
/// accepts or rejects a page edit (Codex re-review, N12).
fn governed_subcommand(sub: &str, rest: &[String]) -> bool {
    GOVERNED_COMMANDS.iter().any(|command| match command.split_once(' ') {
        None => *command == sub,
        Some((head, action)) => head == sub && rest.iter().any(|word| word == action),
    }) || (sub == "doc" && !matches!(doc_action(rest), Some("read" | "propose")))
        || (sub == "proposals" && settles_page(without_option_values(rest).into_iter()))
}

/// The words of a `proposals` command without the values of its options, so `--reason 0123456789ab` (a commit hash) is not
/// read as a page ID (Codex re-review, F06). An option it does not know keeps the word after it, which fails closed.
fn without_option_values(rest: &[String]) -> Vec<&str> {
    let takes_value = |word: &str| {
        word.len() >= 3 && !word.contains('=') && VALUE_OPTIONS.iter().chain(&PROPOSAL_VALUE_OPTIONS).any(|option| option.starts_with(word))
    };
    let mut words = vec![];
    let mut index = 0;
    while let Some(word) = rest.get(index) {
        if word.starts_with("--") && word.contains('=') {
            index += 1;
            continue;
        }
        words.push(word.as_str());
        index += if takes_value(word) { 2 } else { 1 };
    }
    words
}

/// The action of a `doc` command: its first word that is not an option or an option's value.
fn doc_action(rest: &[String]) -> Option<&str> {
    let mut index = 0;
    while let Some(word) = rest.get(index) {
        if !word.starts_with('-') {
            return Some(word);
        }
        let takes_value = !word.contains('=') && word.len() >= 3 && VALUE_OPTIONS.iter().any(|option| option.starts_with(word.as_str()));
        index += if takes_value { 2 } else { 1 };
    }
    None
}

/// Whether these words accept or reject a page edit: a page proposal's ID is 12 hex digits; a staged note's (8) is the main
/// agent's to settle.
fn settles_page<'a>(words: impl Iterator<Item = &'a str> + Clone) -> bool {
    words.clone().any(|word| word == "accept" || word == "reject")
        && words.into_iter().any(|word| word.len() == 12 && word.chars().all(|c| c.is_ascii_hexdigit()))
}

/// The fail-closed reading of a lower-cased text: it names Living Memory (a word `alm`, or one ending in `living_memory`) and a
/// governed command (a phrase's two words anywhere). Quotes and escapes (\ ^) are also read as removed, since shells join
/// `a"lm"` and `al\m` into `alm`.
fn names_memory_and_governed(text: &str) -> bool {
    let joined: String = text.chars().filter(|c| !matches!(c, '"' | '\'' | '\\' | '^' | '`')).collect();
    [text, joined.as_str()].iter().any(|text| {
        let words: Vec<&str> = text.split(|c: char| !(c.is_ascii_alphanumeric() || c == '-' || c == '_')).filter(|w| !w.is_empty()).collect();
        let names_memory = words.iter().any(|word| *word == "alm" || word.ends_with("living_memory"));
        names_memory
            && (GOVERNED_COMMANDS.iter().any(|command| command.split(' ').all(|part| words.contains(&part)))
                || (words.contains(&"doc") && (words.contains(&"undo") || words.contains(&"folder")))
                || (words.contains(&"proposals") && settles_page(words.iter().copied())))
    })
}

/// A lower-cased command line as words, in parts split at ; & | and line breaks, read the way bash and PowerShell agree on.
/// A quoted stretch is part of the word it is in. None when the line uses what they read differently or what runs other
/// text: an unclosed quote, `$` or a backtick outside single quotes, a backslash before a closing double quote or a line break
/// (bash joins the lines, PowerShell does not; Codex re-review, N13), redirections, brackets, or cmd's `^` and `%`.
fn shell_parts(text: &str) -> Option<Vec<Vec<String>>> {
    let (mut parts, mut words, mut word, mut quote, mut in_word) = (vec![], vec![], String::new(), None::<char>, false);
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match quote {
            Some('\'') if c == '\'' => quote = None,
            Some('\'') => word.push(c),
            Some(_) if c == '"' => quote = None,
            Some(_) if c == '$' || c == '`' || (c == '\\' && chars.peek() == Some(&'"')) => return None,
            Some(_) => word.push(c),
            None => match c {
                '\'' | '"' => {
                    quote = Some(c);
                    in_word = true;
                }
                '\n' | ';' | '&' | '|' => {
                    if std::mem::take(&mut in_word) {
                        words.push(std::mem::take(&mut word));
                    }
                    parts.push(std::mem::take(&mut words));
                }
                c if c.is_whitespace() => {
                    if std::mem::take(&mut in_word) {
                        words.push(std::mem::take(&mut word));
                    }
                }
                '$' | '`' | '<' | '>' | '(' | ')' | '{' | '}' | '^' | '%' => return None,
                '\\' if matches!(chars.peek(), Some('\n' | '\r')) => return None,
                c => {
                    word.push(c);
                    in_word = true;
                }
            },
        }
    }
    if quote.is_some() {
        return None;
    }
    if in_word {
        words.push(word);
    }
    parts.push(words);
    Some(parts)
}

/// Deny rules for the same commands, for the CLI's own rule engine: they hold even where the user's settings allow the
/// call, so it never becomes a question Hivemind could refuse. They name the script only. `*alm*` rules would refuse every
/// memory search that mentions archive or delete, and would double a command line that terminal sessions pass through
/// cmd.exe's 8191-character limit; the `alm` launcher is refused by Living Memory itself while HIVEMIND_SESSION is set
/// (undo, recover and the direct writes), and by `governed_memory_command` when a session asks.
pub fn governed_rules() -> Vec<String> {
    ["Bash", "PowerShell"]
        .into_iter()
        .flat_map(|tool| {
            GOVERNED_COMMANDS
                .into_iter()
                .chain(DOC_WRITES)
                .flat_map(move |command| [format!("{tool}(*living_memory.py* {command} *)"), format!("{tool}(*living_memory.py* {command})")])
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A temp folder with a repo and an installed suite runtime; the caller removes it.
    fn fixture(name: &str) -> (PathBuf, PathBuf) {
        let base = std::env::temp_dir().join(format!("hivemind-agent-scope-{name}-{}", std::process::id()));
        std::fs::remove_dir_all(&base).ok();
        let (home, repo) = (base.join("home"), base.join("app"));
        let runtime = home.join(".architecture-suite").join("runtime").join(if cfg!(windows) { "Scripts" } else { "bin" });
        std::fs::create_dir_all(&runtime).unwrap();
        std::fs::create_dir_all(&repo).unwrap();
        std::fs::write(runtime.join(if cfg!(windows) { "python.exe" } else { "python" }), "").unwrap();
        (base, home)
    }

    #[test]
    fn an_executive_session_resumes_only_in_an_executive_folder() {
        let base = std::env::temp_dir().join(format!("hivemind-agent-scope-exec-{}", std::process::id()));
        let dir = base.join("executive").join("agent");
        let saved = Settings::default();
        let bridge = Bridge::new(crate::settings::resolve(&saved, |_| None));
        let made = executive(&dir, "Executive: Hi".into(), &[]).unwrap();
        let info = super::super::session_info("id", "claude-code", AgentTask::Executive { project: Some("pay".into()) }, &made, &Default::default());
        assert_eq!(info.project.as_deref(), Some("pay"));
        // A domain bound since the session started is readable on resume.
        let lm = |argv: &[&str]| -> Result<Value, String> {
            assert_eq!(argv, ["projects"]);
            Ok(serde_json::json!({"projects": [{"slug": "pay", "status": "active", "charter": "payments:charter"}, {"slug": "ops", "status": "active", "charter": "ops:c"}]}))
        };
        let scope = executive_session(&lm, &info, Some("pay")).unwrap();
        assert_eq!((scope.cwd, scope.title.as_str(), scope.mode, scope.worktree), (dir.clone(), "Executive: Hi", Mode::Interactive, None));
        assert!(scope.isolated);
        let Policy::PreApproved { allow } = &scope.policy else { panic!("not pre-approved") };
        assert!(allow.iter().any(|rule| rule == "Bash(alm --json --domain payments search *)"));
        assert!(!allow.iter().any(|rule| rule.contains("--domain ops")), "only the session's project");
        let elsewhere = SessionInfo { workspace: vec![base.join("repo").display().to_string()], ..info.clone() };
        assert_eq!(for_session(&bridge, &saved, &elsewhere).unwrap_err(), "This session's folder is not an executive folder");
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn the_executive_chat_is_denied_every_memory_write() {   // EXEC-14
        let dir = std::env::temp_dir().join(format!("hivemind-agent-scope-deny-{}", std::process::id()));
        let scope = executive(&dir, "Executive: Hi".into(), &["pay".into()]).unwrap();
        // Listed here, not read from MEMORY_WRITES, so dropping a verb there fails this test.
        let writes = ["capture", "update", "propose", "check", "confirm", "resolve", "reopen", "supersede", "restore", "batch", "distinct", "proposals"];
        for verb in writes {
            for tool in ["Bash", "PowerShell"] {
                for cli in ["*alm*", "*living_memory.py*"] {
                    for rule in [format!("{tool}({cli} {verb} *)"), format!("{tool}({cli} {verb})")] {
                        assert!(scope.deny.contains(&rule), "{rule} is not denied");
                    }
                }
            }
        }
        let Policy::PreApproved { allow } = &scope.policy else { panic!("not pre-approved") };
        let named = |rule: &String| writes.iter().any(|verb| rule.contains(&format!(" {verb} *)")) || rule.contains(&format!(" {verb})")));
        assert!(!allow.iter().any(named), "an allow rule names a write: {allow:?}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn only_picked_folders_are_accepted() {
        let (base, _) = fixture("other-folder");
        let folder = base.join("app");
        let saved = Settings { other_folders: Some(vec![folder.display().to_string()]), ..Default::default() };
        assert_eq!(other_folder(&saved, &format!("{}/", folder.display().to_string().replace('\\', "/"))).unwrap(), folder);
        let message = "That folder was not chosen with the folder picker";
        assert_eq!(other_folder(&saved, &base.display().to_string()).unwrap_err(), message);
        assert_eq!(other_folder(&saved, &folder.join("sub").display().to_string()).unwrap_err(), message);
        assert_eq!(other_folder(&Settings::default(), &folder.display().to_string()).unwrap_err(), message);
        std::fs::remove_dir_all(&folder).unwrap();
        assert!(other_folder(&saved, &folder.display().to_string()).unwrap_err().starts_with("The folder no longer exists"));
        std::fs::remove_dir_all(base).ok();
    }

    #[test]
    fn a_direct_scope_has_the_rules_of_a_work_scope_and_no_worktree() {
        let folder = Path::new("C:/notes");
        let direct = direct(folder, PolicyMode::AcceptEdits, "Codex".into()).unwrap();
        assert_eq!((direct.cwd.as_path(), direct.worktree.as_ref(), direct.mode), (folder, None, Mode::Interactive));
        assert_eq!(direct.policy.mode(), PolicyMode::AcceptEdits);
        assert_eq!(direct.deny, deny_rules());
        assert!(direct.add_dirs.is_empty());
        assert_eq!(super::direct(folder, PolicyMode::PreApproved, String::new()).unwrap_err(), "A work session needs the ask or accept_edits policy");
        assert_eq!(task_title("\n  Fix the bug  \nmore"), "Fix the bug");
        assert_eq!(task_title("  "), "");
        let folder_task: AgentTask = serde_json::from_value(json!({"kind": "folder", "path": "C:/notes"})).unwrap();
        assert_eq!(folder_task, AgentTask::Folder { path: "C:/notes".into() });
    }

    #[test]
    fn rule_paths_are_posix_with_an_extra_slash() {
        assert_eq!(rule_path(r"C:\Users\me\out"), "//c/Users/me/out");
        assert_eq!(rule_path("C:/Users/me/out"), "//c/Users/me/out");
        assert_eq!(rule_path(r"d:\out\"), "//d/out");
        assert_eq!(rule_path("/home/me/out"), "//home/me/out");
        assert_eq!(rule_path("/home/me/out/"), "//home/me/out");
    }

    #[test]
    fn task_json_is_tagged_by_kind() {
        let task: AgentTask = serde_json::from_value(json!({"kind": "system_passport", "slug": "billing"})).unwrap();
        assert_eq!(task, AgentTask::SystemPassport { slug: "billing".into() });
        assert_eq!(serde_json::to_value(&task).unwrap(), json!({"kind": "system_passport", "slug": "billing"}));

        let bare = json!({"kind": "work", "project": "paystream", "repo": "C:/r"});
        let work: AgentTask = serde_json::from_value(bare.clone()).unwrap();
        assert_eq!(work, AgentTask::Work { project: "paystream".into(), repo: "C:/r".into(), branch: None });
        assert_eq!(serde_json::to_value(&work).unwrap(), bare);
        let full = json!({"kind": "work", "project": "paystream", "repo": "C:/r", "branch": "main"});
        let work: AgentTask = serde_json::from_value(full.clone()).unwrap();
        assert_eq!(work, AgentTask::Work { project: "paystream".into(), repo: "C:/r".into(), branch: Some("main".into()) });
        assert_eq!(serde_json::to_value(&work).unwrap(), full);
    }

    /// A session record stored while Changes existed carries `"change": 14`; it still loads, and the field is not written back.
    #[test]
    fn a_legacy_work_task_with_a_change_still_deserializes() {
        let old = json!({"kind": "work", "project": "paystream", "repo": "C:/r", "branch": "main", "change": 14});
        let work: AgentTask = serde_json::from_value(old).unwrap();
        assert_eq!(work, AgentTask::Work { project: "paystream".into(), repo: "C:/r".into(), branch: Some("main".into()) });
        assert_eq!(serde_json::to_value(&work).unwrap(), json!({"kind": "work", "project": "paystream", "repo": "C:/r", "branch": "main"}));
    }

    #[test]
    fn registered_repos_match_whatever_the_slashes_and_case() {
        let entry = json!({"repos": ["C:/Work/Pay"]});
        assert_eq!(project_repo(&entry, "c:\\work\\pay\\").unwrap(), PathBuf::from("C:/Work/Pay"));
        for other in ["C:/Work/Pay2", "C:/Work"] {
            assert_eq!(project_repo(&entry, other).unwrap_err(), "That repository is not registered for this project");
        }
        assert!(project_repo(&json!({}), "C:/Work/Pay").is_err());
    }

    #[test]
    fn governed_memory_commands_are_recognised() {
        for command in [
            r#"python "C:\x\living_memory.py" --domain a delete a:x --expected-revision abc"#,
            r#"python "C:\x\living_memory.py" merge --payload-file m.json"#,
            r#"python "C:\x\living_memory.py" retag --payload-file r.json"#,
            r#"python "C:\x\living_memory.py" restore-backup b.zip"#,
            r#"python "C:\x\living_memory.py" overlay-teardown"#,
            r#"python "C:\x\living_memory.py" --domain a archive x"#,
            r#"python "C:\x\living_memory.py" project create --payload-file p.json"#,
            r#"python "C:\x\living_memory.py" taxonomy add concern/security"#,
            r#"python "C:\x\LIVING_MEMORY.PY" undo 123"#,
            // The launcher: bare, by path, and with its Windows extensions.
            "alm --json --domain a delete a:x --expected-revision abc",
            "alm --json merge --payload-file m.json",
            "alm --json migrate",
            "alm import bundle.zip",
            "alm --json ingest --source x",
            r#""C:\Users\u\.local\bin\alm.exe" recover op-1"#,
            r"C:\Users\u\.local\bin\ALM.CMD undo 123",
            "/home/u/.local/bin/alm --domain a archive x",
            "cd x && alm project create --payload-file p.json",
            r#"& "C:\Users\u\.local\bin\alm.exe" undo 1"#,
            r#""C:\Program Files\alm\alm.exe" --domain a rewrite --payload-file r.json"#,
            "LIVING_MEMORY_ROOT=x alm archive a:b",
            // Codex review of e30902f, G2: whitespace, abbreviated or `=` global options, and options before a phrase's action.
            "alm  project   create --payload-file p.json",
            "alm project --payload-file p.json create",
            "python  living_memory.py\tdelete x",
            "py -3 living_memory.py --dom a delete x",
            "alm --domain=a --actor main delete x",
            "alm --json --domain a setup --location x",
            "alm upgrade",
            "alm --json type create --payload-file t.json",
            "alm sync",
            "alm overlay-build",
            // What cannot be read cleanly is refused when it names Living Memory and a governed word.
            "alm --weird delete x",
            r#"alm search "$(alm delete x)""#,
            "alm search delete > out.txt",
            "alm (delete x)",
            r#"alm "delete x"#,
            // Wrappers run Living Memory too, so a part they start naming it with a governed word is refused.
            r#"bash -c "alm archive x""#,
            "cmd /c alm undo 1",
            "xargs alm delete",
            "env x=1 alm delete x",
            r#"powershell -c "& alm.exe undo 1""#,
            r#"python -c "import os; os.system('alm delete x')""#,
            // Codex re-review, N12: notebook writes and settling a page proposal, as Living Memory governs them.
            "alm doc undo op-1",
            "alm --json doc folder set --payload-file f.json",
            "alm doc",
            "alm proposals accept 0123456789ab",
            "alm proposals reject 0123456789ab --reason no",
            // Codex re-review, F06: an option value is not the ID, but the ID after one is still read.
            "alm proposals reject 0123456789ab --reason 1a2b3c4d",
            "alm proposals --session s1 accept 0123456789ab",
            "alm proposals accept --rule 0123456789ab",
            // Codex re-review, F05: Python environment runners are wrappers.
            "poetry run alm archive x",
            "pipenv run alm delete x",
            "conda run -n base alm undo 1",
            // Codex re-review, N13: bash joins a line ending in a backslash to the next one.
            "python living_memory.py search x \\\ndelete",
            "alm \\\r\ndelete x",
            // Shells join quoted and escaped letters into one word.
            r#"a"lm" delete x"#,
            r"al\m delete x",
        ] {
            assert!(governed_memory_command(command), "{command}");
        }
        for command in [
            r#"python "C:\x\living_memory.py" search retries"#,
            // A hyphenated word is one word: a name that only starts like a governed command is not one.
            "alm --json --domain a delete-plan a:x",
            r#"python "C:\x\living_memory.py" backup"#,
            r#"python "C:\x\living_memory.py" taxonomy"#,
            r#"python "C:\x\living_memory.py" projects --status active"#,
            r#"python "C:\x\living_memory.py" search "project change""#,
            r#"python "C:\x\living_memory.py" capture --title x"#,
            "git merge main",
            "alm --json --domain a search retries",
            // A word that only contains alm is not the launcher.
            "palm delete x",
            "realm.exe undo 1",
            "alm --json --domain a search x && git merge main",
            // Codex re-review, N14: another program only takes words, whatever they are.
            "git merge --no-ff alm",
            r#"echo "example; alm archive x""#,
            "alm doc read --file notes/a.md",
            "alm --json doc propose --file notes/a.md --body-file b.md",
            "alm proposals accept 01234567",
            "alm proposals list",
            // Codex re-review, F06: a commit hash given as the reason of a staged note's reject.
            "alm proposals reject 1a2b3c4d --reason 0123456789ab",
            "alm proposals reject 1a2b3c4d --reason=0123456789ab",
            "alm proposals reject 1a2b3c4d --reas 0123456789ab",
            // Codex review of e30902f, G2: an ordinary search is decided by its subcommand, whatever its text says.
            r#"python "C:\x\living_memory.py" search "delete the cache""#,
            "alm --json --domain a search 'merge the project create notes'",
            "alm search x > out.txt",
            "alm types",
            "alm source-sync",
            "alm --json taxonomy",
        ] {
            assert!(!governed_memory_command(command), "{command}");
        }
    }

    #[test]
    fn governed_rules_cover_every_command_for_both_shells() {
        let rules = governed_rules();
        assert_eq!(rules.len(), 136);
        assert_eq!(rules.iter().collect::<std::collections::HashSet<_>>().len(), 136, "all different");
        for rule in [
            "Bash(*living_memory.py* delete *)",
            "Bash(*living_memory.py* merge)",
            "PowerShell(*living_memory.py* undo *)",
            "PowerShell(*living_memory.py* recover)",
            "Bash(*living_memory.py* restore-backup *)",
            "Bash(*living_memory.py* project create *)",
            "PowerShell(*living_memory.py* archive)",
            "Bash(*living_memory.py* setup *)",
            "PowerShell(*living_memory.py* upgrade)",
            "Bash(*living_memory.py* type create *)",
            "Bash(*living_memory.py* sync *)",
            "PowerShell(*living_memory.py* overlay-sync-all *)",
            "Bash(*living_memory.py* doc undo *)",
            "PowerShell(*living_memory.py* doc folder)",
        ] {
            assert!(rules.iter().any(|r| r == rule), "{rule}");
        }
        assert!(!rules.iter().any(|r| r.contains(" apply")), "Living Memory has no apply command any more");
        assert_eq!(&rules[..2], ["Bash(*living_memory.py* undo *)", "Bash(*living_memory.py* undo)"]);
        for rule in &rules {
            assert!(rule.starts_with("Bash(*living_memory.py* ") || rule.starts_with("PowerShell(*living_memory.py* "), "{rule}");
            for word in ["-plan", "search", "read", "capture"] {
                assert!(!rule.contains(word), "{rule}");
            }
        }
        for command in GOVERNED_COMMANDS {
            assert!(governed_memory_command(&format!("python living_memory.py {command} x")), "{command}");
            assert!(governed_memory_command(&format!("alm --json {command} x")), "{command}");
        }
        // The harness reads a rule as a glob (`*` is any text). Extra spaces around the subcommand still match; extra spaces
        // inside a phrase cannot be written as one, and `governed_memory_command` refuses those.
        let matches = |rule: &str, command: &str| {
            let pattern = rule.split_once('(').unwrap().1.strip_suffix(')').unwrap();
            let pattern = format!("^{}$", pattern.split('*').map(regex::escape).collect::<Vec<_>>().join("(?s:.*)"));
            regex::Regex::new(&pattern).unwrap().is_match(command)
        };
        let denied = |command: &str| rules.iter().any(|rule| rule.starts_with("Bash(") && matches(rule, command));
        for command in [
            r#"python "C:\x\living_memory.py" delete d:x --expected-revision r"#,
            r#"python  "C:\x\living_memory.py"   delete   d:x"#,
            "python living_memory.py --json --domain a delete d:x",
            "python living_memory.py delete",
            "python living_memory.py project create --payload-file p.json",
            "python living_memory.py setup",
        ] {
            assert!(denied(command), "{command}");
        }
        for command in ["python living_memory.py search retries", "python living_memory.py projects", "python living_memory.py taxonomy"] {
            assert!(!denied(command), "{command}");
        }
        assert!(!denied("python living_memory.py project  create") && governed_memory_command("python living_memory.py project  create"));
    }

    #[test]
    fn work_scope_is_the_worktree_and_nothing_else() {
        let tree = Worktree {
            repo: "C:/demo/repos/paystream".into(),
            path: "/wt/paystream-5d1c0a3e/0f9e8d7c".into(),
            branch: "hivemind/0f9e8d7c".into(),
            base_branch: "main".into(),
            base_sha: "a053c800edb319fae41bc4873e4412b763b9d93b".into(),
            reviewed_sha: None,
        };
        let scope = work(tree.clone(), PolicyMode::Ask, "\n  Fix the retry\nmore").unwrap();
        assert_eq!(scope.cwd, PathBuf::from("/wt/paystream-5d1c0a3e/0f9e8d7c"));
        assert!(scope.add_dirs.is_empty() && scope.plugin_dirs.is_empty());
        assert_eq!(scope.policy, Policy::Ask { allow: vec![] });
        assert_eq!((scope.mode, scope.title.as_str()), (Mode::Interactive, "Fix the retry"));
        assert_eq!((scope.schema, scope.required_plugin, scope.worktree), (None, None, Some(tree.clone())));
        assert_eq!(scope.deny, deny_rules());
        assert_eq!(work(tree.clone(), PolicyMode::AcceptEdits, "x").unwrap().policy, Policy::AcceptEdits { allow: vec![] });
        assert_eq!(work(tree.clone(), PolicyMode::PreApproved, "x").unwrap_err(), "A work session needs the ask or accept_edits policy");
        assert_eq!(work(tree, PolicyMode::Ask, &"é".repeat(100)).unwrap().title.chars().count(), TITLE);
    }

    #[test]
    fn passport_scope_comes_from_the_registry_entry() {
        let (base, home) = fixture("ok");
        let (repo, other, architecture) = (base.join("app"), base.join("api"), base.join("arch").join("billing"));
        let entry = json!({"slug": "billing", "name": "Billing", "repos": [repo, other], "architecture": architecture});
        let saved = Settings { architecture_suite_plugin: Some("/plugins/suite".into()), ..Default::default() };
        let scope = system_passport(&entry, &saved, &home).unwrap();
        assert_eq!(scope.title, "System passport: Billing");
        assert_eq!(scope.cwd, repo);
        assert_eq!(scope.add_dirs, vec![other, architecture.clone()]);
        assert!(architecture.is_dir(), "the output folder is created");
        assert_eq!(scope.plugin_dirs, vec![PathBuf::from("/plugins/suite")]);
        assert_eq!(scope.required_plugin.as_deref(), Some("architecture-suite"));
        let allow = scope.policy.allow();
        assert_eq!(scope.policy.mode(), PolicyMode::PreApproved);
        assert_eq!((scope.mode, scope.worktree), (Mode::Unattended, None));
        assert_eq!(scope.deny, deny_rules());
        let folder = rule_path(&architecture.display().to_string());
        assert!(folder.starts_with("//") && !folder.contains('\\'), "{folder}");
        assert_eq!(
            allow,
            &vec![
                format!("Edit({folder}/**)"),
                "Bash(*architecture-suite.py *)".to_string(),
                "PowerShell(*architecture-suite.py *)".to_string()
            ]
        );
        let schema = scope.schema.unwrap();
        assert_eq!(schema["required"], json!(["summary"]));
        assert_eq!(schema["properties"]["registry"]["properties"]["depends_on"]["items"]["type"], "string");
        assert!(system_passport(&entry, &Settings::default(), &home).unwrap().plugin_dirs.is_empty());
        std::fs::remove_dir_all(base).ok();
    }

    #[test]
    fn passport_scope_errors_say_what_to_fix() {
        let (base, home) = fixture("errors");
        let (repo, architecture) = (base.join("app"), base.join("arch"));
        let saved = Settings::default();
        let error = |entry: Value, home: &Path| system_passport(&entry, &saved, home).unwrap_err();
        assert!(error(json!({"name": "Billing", "repos": [], "architecture": architecture}), &home).contains("no repositories"));
        assert!(error(json!({"name": "Billing", "architecture": architecture}), &home).contains("no repositories"));
        assert!(error(json!({"name": "Billing", "repos": [repo], "architecture": null}), &home).contains("no architecture folder"));
        assert!(error(json!({"name": "Billing", "repos": [repo], "architecture": " "}), &home).contains("no architecture folder"));
        let gone = base.join("gone");
        let missing = error(json!({"name": "Billing", "repos": [gone], "architecture": architecture}), &home);
        assert!(missing.contains("does not exist") && missing.contains("gone"), "{missing}");
        // No runtime under this home: the error names the interpreter it looked for, and nothing is created.
        let no_setup = error(json!({"name": "Billing", "repos": [repo], "architecture": architecture}), &base);
        assert!(no_setup.contains("one-time setup has not been run") && no_setup.contains(".architecture-suite"), "{no_setup}");
        assert!(!architecture.exists());
        std::fs::remove_dir_all(base).ok();
    }

    #[test]
    fn runtime_check_looks_under_the_given_home() {
        let (base, home) = fixture("runtime");
        let python = suite_runtime(&home).unwrap();
        assert!(python.starts_with(home.join(".architecture-suite").join("runtime")));
        assert_eq!(python.file_name().unwrap(), if cfg!(windows) { "python.exe" } else { "python" });
        assert!(suite_runtime(&base).unwrap_err().contains(&base.join(".architecture-suite").display().to_string()));
        std::fs::remove_dir_all(base).ok();
    }

    #[test]
    fn allowed_commands_are_one_plain_command() {
        assert_eq!(check_command("  npm test ").unwrap(), "npm test");
        assert_eq!(check_command("cargo test --manifest-path src-tauri/Cargo.toml").unwrap(), "cargo test --manifest-path src-tauri/Cargo.toml");
        for bad in ["", "npm test; rm -rf /", "a && b", "a | b", "echo `x`", "echo $(x)", "a > b", "npm\ntest", "git *", &"x".repeat(121)] {
            assert!(check_command(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn profiles_become_rules() {
        let cwd = Path::new("C:/wt/pay/0f9e8d7c");
        let commands = vec!["npm test".to_string()];
        let git = command_rules(&READ_GIT.map(String::from)).unwrap();
        assert!(git.contains(&"Bash(git log *)".to_string()) && git.contains(&"PowerShell(git diff *)".to_string()));
        let reads = [["Read", "Glob", "Grep", "TodoWrite", "Skill"].map(String::from).to_vec(), git.clone()].concat();
        assert_eq!(profile_policy(Profile::ReadOnly, cwd, true, &commands).unwrap(), Policy::PreApproved { allow: reads.clone() });
        assert_eq!(profile_policy(Profile::ReadOnly, cwd, false, &commands).unwrap(), Policy::PreApproved { allow: reads.clone() });
        let research = profile_policy(Profile::Research, cwd, true, &[]).unwrap();
        assert!(research.allow().iter().any(|rule| rule == "WebFetch") && research.allow().iter().any(|rule| rule == "WebSearch"));
        let command_rules = ["Bash(npm test)", "Bash(npm test *)", "PowerShell(npm test)", "PowerShell(npm test *)"].map(String::from).to_vec();
        assert_eq!(profile_policy(Profile::EditWorktree, cwd, true, &commands).unwrap(), Policy::AcceptEdits { allow: [git, command_rules.clone()].concat() });
        let mut unattended = reads;
        unattended.push("Edit(//c/wt/pay/0f9e8d7c/**)".into());
        unattended.extend(command_rules);
        assert_eq!(profile_policy(Profile::EditWorktree, cwd, false, &commands).unwrap(), Policy::PreApproved { allow: unattended });
        assert!(profile_policy(Profile::EditWorktree, cwd, false, &["a; b".to_string()]).is_err());
    }

    #[test]
    fn every_session_is_denied_destructive_git() {
        let rules = deny_rules();
        assert_eq!(&rules[..136], governed_rules().as_slice());
        for rule in ["Bash(*git push*)", "PowerShell(*git reset --hard*)", "Bash(*git clean*)", "PowerShell(*git branch -D*)"] {
            assert!(rules.iter().any(|r| r == rule), "{rule}");
        }
    }

    #[test]
    fn reading_git_commands_may_not_write_files_or_run_programs() {
        let rules = deny_rules();
        for tool in ["Bash", "PowerShell"] {
            for option in ["--output=", "--output ", "--ext-diff", "--textconv"] {
                let rule = format!("{tool}(*git *{option}*)");
                assert!(rules.contains(&rule), "{rule}");
            }
        }
        // Both spellings of --output are refused.
        for unsafe_line in ["git diff --output=x", "git log -p --output x"] {
            assert!(UNSAFE_GIT_OPTIONS.iter().any(|option| unsafe_line.contains(option)), "{unsafe_line}");
        }
        // The safe spellings Hivemind itself uses, and read-only options that start alike, are not matched (Codex review S-2).
        for safe in ["git log -p --no-ext-diff --no-textconv", "git diff --no-color", "git diff --output-indicator-new=+"] {
            assert!(!UNSAFE_GIT_OPTIONS.iter().any(|option| safe.contains(option)), "{safe}");
        }
    }

    #[test]
    fn a_role_scope_is_the_worktree_with_its_profile() {
        let tree = Worktree {
            repo: "C:/demo/pay".into(),
            path: "C:/wt/pay/0f9e8d7c".into(),
            branch: "hivemind/0f9e8d7c".into(),
            base_branch: "main".into(),
            base_sha: "a053c800edb319fae41bc4873e4412b763b9d93b".into(),
            reviewed_sha: None,
        };
        let scope = work_as(tree.clone(), Profile::ReadOnly, true, &[], "Review the retry\nmore").unwrap();
        assert_eq!((scope.cwd.as_path(), scope.mode, scope.title.as_str()), (Path::new("C:/wt/pay/0f9e8d7c"), Mode::Interactive, "Review the retry"));
        assert_eq!(scope.policy.mode(), PolicyMode::PreApproved);
        assert_eq!((scope.worktree, scope.deny), (Some(tree), deny_rules()));
    }

    #[test]
    fn an_architecture_folder_is_readable_but_never_editable() {
        let tree = |n: &str| Worktree {
            repo: "C:/demo/pay".into(),
            path: format!("C:/wt/pay/{n}"),
            branch: format!("hivemind/{n}"),
            base_branch: "main".into(),
            base_sha: "a053c800edb319fae41bc4873e4412b763b9d93b".into(),
            reviewed_sha: None,
        };
        let folder = Path::new(r"C:\arch\billing");
        for (profile, attended) in [(Profile::ReadOnly, true), (Profile::ReadOnly, false), (Profile::Research, false), (Profile::EditWorktree, false)] {
            let mut scope = work_as(tree("0f9e8d7c"), profile, attended, &[], "Review").unwrap();
            read_only_folder(&mut scope, folder);
            assert_eq!(scope.add_dirs, vec![folder.to_path_buf()], "{profile:?}");
            assert_eq!(scope.deny, [deny_rules(), vec!["Edit(//c/arch/billing/**)".to_string()]].concat(), "{profile:?}");
        }
        // An attended editing session would accept edits in the folder, so it is not given it.
        let mut edits = work_as(tree("1a2b3c4d"), Profile::EditWorktree, true, &[], "Design").unwrap();
        read_only_folder(&mut edits, folder);
        assert!(edits.add_dirs.is_empty());
        assert_eq!(edits.deny, deny_rules());
        // Nor is a folder whose name the deny pattern might not match (Codex review S-1).
        for odd in [r"C:\arch\billing [v2]", r"C:\arch\b*", r"C:\arch\{x}"] {
            let mut scope = work_as(tree("2b3c4d5e"), Profile::ReadOnly, false, &[], "Review").unwrap();
            read_only_folder(&mut scope, Path::new(odd));
            assert!(scope.add_dirs.is_empty(), "{odd}");
            assert_eq!(scope.deny, deny_rules(), "{odd}");
        }
    }
}
