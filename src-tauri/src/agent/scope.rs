//! What a task may touch. The folders and permissions come from Living Memory's registry and from
//! this file, never from the webview: the webview only names the task.
use crate::bridge::Bridge;
use crate::settings::Settings;
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
}

#[derive(Clone, Debug, PartialEq)]
pub enum Policy {
    /// Nothing is asked: the listed rules are allowed and every other gated tool call is denied.
    PreApproved { allow: Vec<String> },
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
    })
}

/// Look the task's subject up in Living Memory and work out what the session may touch.
pub fn for_task(bridge: &Bridge, task: &AgentTask, saved: &Settings, home: &Path) -> Result<Scope, String> {
    match task {
        AgentTask::SystemPassport { slug } => system_passport(&crate::architecture::system_entry(bridge, slug)?, saved, home),
    }
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
        let Policy::PreApproved { allow } = &scope.policy;
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
