//! What a task may touch. The folders and permissions come from Living Memory's registry and from
//! this file, never from the webview: the webview only names the task.
use super::SessionInfo;
use super::TITLE;
use super::events::{Mode, clip};
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
        #[serde(default, skip_serializing_if = "Option::is_none")]
        change: Option<u64>,
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
    /// Continue the CLI's own conversation `session_id` instead of creating it.
    pub resume: bool,
    /// A model alias for `--model`, or None for the user's Claude Code default.
    pub model: Option<String>,
    /// Rules the CLI must refuse whatever else allows them (`--disallowedTools`). Copied from the scope.
    pub deny: Vec<String>,
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
    /// Rules denied in every session: `governed_rules()`. Set for passport and work scopes alike.
    pub deny: Vec<String>,
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
/// its plan and apply commands must stay denied, so nothing here may match them.
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
        deny: governed_rules(),
    })
}

/// Look the task's subject up in Living Memory and work out what the session may touch.
pub fn for_task(bridge: &Bridge, task: &AgentTask, saved: &Settings, home: &Path) -> Result<Scope, String> {
    match task {
        AgentTask::SystemPassport { slug } => system_passport(&crate::architecture::system_entry(bridge, slug)?, saved, home),
        AgentTask::Work { .. } => Err("A work session is started with start_task".into()),
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
    let policy = match policy {
        PolicyMode::Ask => Policy::Ask { allow: vec![] },
        PolicyMode::AcceptEdits => Policy::AcceptEdits { allow: vec![] },
        PolicyMode::PreApproved => return Err("A work session needs the ask or accept_edits policy".into()),
    };
    let first = prompt.lines().map(str::trim).find(|line| !line.is_empty()).unwrap_or_default();
    Ok(Scope {
        title: clip(first, TITLE),
        cwd: PathBuf::from(&tree.path),
        add_dirs: vec![],
        policy,
        schema: None,
        plugin_dirs: vec![],
        required_plugin: None,
        mode: Mode::Interactive,
        worktree: Some(tree),
        deny: governed_rules(),
    })
}

/// The scope of a stored work session, checked against the registry again before a process is started for it.
pub fn for_session(bridge: &Bridge, info: &SessionInfo) -> Result<Scope, String> {
    let AgentTask::Work { project, repo, .. } = &info.task else { return Err("This session does not take messages".into()) };
    project_repo(&crate::git::project_entry(bridge, project)?, repo)?;
    let tree = info.worktree.clone().filter(|tree| Path::new(&tree.path).is_dir());
    work(tree.ok_or("This session's worktree no longer exists; end the session")?, info.policy, &info.title)
}

/// The Living Memory commands only the user may run, through Hivemind's reviewed dialogs: every plan command Living
/// Memory has (including `learn`'s), since a user allow rule would let any one missing here run without a question.
const GOVERNED_COMMANDS: [&str; 22] = [
    "apply", "undo", "recover", "plan", "merge-plan", "retag-plan", "taxonomy-plan", "project-plan", "system-plan", "promote-plan", "change-plan",
    "delete-plan", "import-plan", "ingest-plan", "migration-plan", "note-type-plan", "overlay-teardown-plan", "prune-plan", "remap-plan",
    "restore-plan", "retire-plan", "rollback-plan",
];

/// A shell command that would change the Living Memory store through a plan. Its hook lets read and capture commands
/// through before Hivemind is asked; these must never run from a session, whatever the user clicks.
pub fn governed_memory_command(command: &str) -> bool {
    let text = command.to_lowercase();
    text.contains("living_memory")
        && text
            .split(|c: char| !(c.is_ascii_alphanumeric() || c == '-' || c == '_'))
            .any(|word| GOVERNED_COMMANDS.contains(&word) || (word.ends_with("-plan") && word != "inspect-plan"))
}

/// Deny rules for the same commands, for the CLI's own rule engine: they hold even where the user's settings allow the
/// call, so it never becomes a question Hivemind could refuse.
pub fn governed_rules() -> Vec<String> {
    ["Bash", "PowerShell"]
        .into_iter()
        .flat_map(|tool| {
            GOVERNED_COMMANDS
                .into_iter()
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
        assert_eq!(work, AgentTask::Work { project: "paystream".into(), repo: "C:/r".into(), branch: None, change: None });
        assert_eq!(serde_json::to_value(&work).unwrap(), bare);
        let full = json!({"kind": "work", "project": "paystream", "repo": "C:/r", "branch": "main", "change": 14});
        let work: AgentTask = serde_json::from_value(full.clone()).unwrap();
        assert_eq!(work, AgentTask::Work { project: "paystream".into(), repo: "C:/r".into(), branch: Some("main".into()), change: Some(14) });
        assert_eq!(serde_json::to_value(&work).unwrap(), full);
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
            r#"python "C:\x\living_memory.py" apply abc --expected-plan-sha256 d"#,
            r#"python "C:\x\living_memory.py" --domain a plan archive x"#,
            r#"python "C:\x\living_memory.py" project-plan create"#,
            r#"python "C:\x\LIVING_MEMORY.PY" undo 123"#,
            // The word `apply` is there even inside a search; a refused search is the safe side.
            r#"python "C:\x\living_memory.py" search "apply the plan""#,
            // A plan command Living Memory may add later.
            r#"python "C:\x\living_memory.py" future-plan x"#,
        ] {
            assert!(governed_memory_command(command), "{command}");
        }
        for command in [
            r#"python "C:\x\living_memory.py" search retries"#,
            r#"python "C:\x\living_memory.py" inspect-plan abc"#,
            r#"python "C:\x\living_memory.py" capture --title x"#,
            "git apply patch.diff",
        ] {
            assert!(!governed_memory_command(command), "{command}");
        }
    }

    #[test]
    fn governed_rules_cover_every_command_for_both_shells() {
        let rules = governed_rules();
        assert_eq!(rules.len(), 88);
        assert_eq!(rules.iter().collect::<std::collections::HashSet<_>>().len(), 88, "all different");
        // The learning plans an allow rule for Living Memory would otherwise let through (review finding).
        for rule in ["Bash(*living_memory.py* rollback-plan *)", "PowerShell(*living_memory.py* retire-plan *)"] {
            assert!(rules.iter().any(|r| r == rule), "{rule}");
        }
        for rule in [
            "Bash(*living_memory.py* apply *)",
            "Bash(*living_memory.py* apply)",
            "PowerShell(*living_memory.py* undo *)",
            "PowerShell(*living_memory.py* change-plan)",
        ] {
            assert!(rules.iter().any(|r| r == rule), "{rule}");
        }
        assert_eq!(&rules[..2], ["Bash(*living_memory.py* apply *)", "Bash(*living_memory.py* apply)"]);
        for rule in &rules {
            assert!(rule.starts_with("Bash(*living_memory.py* ") || rule.starts_with("PowerShell(*living_memory.py* "), "{rule}");
            for word in ["inspect-plan", "search", "read", "capture"] {
                assert!(!rule.contains(word), "{rule}");
            }
        }
        for command in GOVERNED_COMMANDS {
            assert!(governed_memory_command(&format!("python living_memory.py {command} x")), "{command}");
        }
    }

    #[test]
    fn work_scope_is_the_worktree_and_nothing_else() {
        let tree = Worktree {
            repo: "C:/demo/repos/paystream".into(),
            path: "/wt/paystream-5d1c0a3e/0f9e8d7c".into(),
            branch: "hivemind/0f9e8d7c".into(),
            base_branch: "main".into(),
            base_sha: "a053c800edb319fae41bc4873e4412b763b9d93b".into(),
        };
        let scope = work(tree.clone(), PolicyMode::Ask, "\n  Fix the retry\nmore").unwrap();
        assert_eq!(scope.cwd, PathBuf::from("/wt/paystream-5d1c0a3e/0f9e8d7c"));
        assert!(scope.add_dirs.is_empty() && scope.plugin_dirs.is_empty());
        assert_eq!(scope.policy, Policy::Ask { allow: vec![] });
        assert_eq!((scope.mode, scope.title.as_str()), (Mode::Interactive, "Fix the retry"));
        assert_eq!((scope.schema, scope.required_plugin, scope.worktree), (None, None, Some(tree.clone())));
        assert_eq!(scope.deny, governed_rules());
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
        assert_eq!(scope.deny, governed_rules());
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
}
