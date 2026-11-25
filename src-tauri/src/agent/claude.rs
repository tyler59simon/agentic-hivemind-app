//! Claude Code in headless mode: one JSON object per stdout line, the prompt as one JSON line on stdin.
use super::{Adapter, Driver, Step};
use super::events::{Decision, Outcome, RunEvent, clip};
use super::scope::{Policy, PolicyMode, Spec, governed_memory_command};
use crate::settings::Settings;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

const TOOL_SUMMARY: usize = 300;
const RESULT_SUMMARY: usize = 500;
const APPROVAL_INPUT: usize = 4000;
pub(crate) const GOVERNED: &str = "Hivemind does not let agent sessions run Living Memory plan, apply or undo commands, or its direct writes (archive, rewrite, remap, promote, taxonomy add, source, project, system, change). Describe the change and let the user apply it.";
const DECLINED: &str = "The user declined this action in Hivemind.";
/// What the CLI's accept-edits mode allows, as the label of an always-allow that has no rule to show.
const EDITS_LABEL: &str = "file edits and simple file commands in the worktree";
/// The tool input fields worth showing, most telling first.
const INPUT_KEYS: [&str; 9] = ["command", "file_path", "pattern", "skill", "description", "url", "query", "path", "prompt"];

pub struct ClaudeCode;

fn text_of<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn blocks(message: &Value) -> impl Iterator<Item = &Value> {
    message.get("message").and_then(|m| m.get("content")).and_then(Value::as_array).into_iter().flatten()
}

fn input_summary(input: Option<&Value>) -> String {
    let Some(input) = input.filter(|i| !i.is_null()) else { return String::new() };
    let field = INPUT_KEYS.iter().find_map(|key| text_of(input, key).filter(|text| !text.trim().is_empty()));
    clip(&field.map(str::to_string).unwrap_or_else(|| input.to_string()), TOOL_SUMMARY)
}

/// A tool result's content is a string, or a list of blocks of which the text ones matter.
fn result_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => parts.iter().filter_map(|part| text_of(part, "text")).collect::<Vec<_>>().join("\n"),
        _ => String::new(),
    }
}

fn result_summary(content: Option<&Value>) -> String {
    clip(&result_text(content), RESULT_SUMMARY)
}

fn failure(subtype: &str, result: Option<&str>) -> String {
    let what = match subtype {
        "success" => "Claude Code reported an error".to_string(),
        "error_max_turns" => "Claude Code reached its turn limit".to_string(),
        "error_max_budget_usd" => "Claude Code reached the budget limit for this session".to_string(),
        "error_during_execution" => "Claude Code hit an error while working".to_string(),
        other => format!("Claude Code stopped ({})", other.replace('_', " ")),
    };
    match result.map(str::trim).filter(|text| !text.is_empty()) {
        Some(text) => format!("{what}: {}", clip(text, TOOL_SUMMARY)),
        None => what,
    }
}

/// Every string inside a JSON value cut to `max` characters.
fn clip_strings(value: &Value, max: usize) -> Value {
    match value {
        Value::String(text) => Value::String(clip(text, max)),
        Value::Array(items) => Value::Array(items.iter().map(|item| clip_strings(item, max)).collect()),
        Value::Object(fields) => Value::Object(fields.iter().map(|(key, field)| (key.clone(), clip_strings(field, max))).collect()),
        other => other.clone(),
    }
}

/// The permission updates "always allow" sends for this request, and what they allow in words.
fn always(request: &Value) -> (Vec<Value>, Option<String>) {
    if request.get("suppress_always_allow_rule").and_then(Value::as_bool) == Some(true) {
        return (vec![], None);
    }
    let suggestions: Vec<&Value> = request.get("permission_suggestions").and_then(Value::as_array).into_iter().flatten().collect();
    // Never the CLI's own destination: `localSettings` would write a settings file into the worktree.
    let for_session = |entry: &Value| {
        let mut entry = entry.clone();
        entry["destination"] = json!("session");
        entry
    };
    let rules: Vec<&Value> =
        suggestions.iter().copied().filter(|s| text_of(s, "type") == Some("addRules") && text_of(s, "behavior") == Some("allow")).collect();
    if !rules.is_empty() {
        let label = rules
            .iter()
            .filter_map(|entry| entry.get("rules").and_then(Value::as_array))
            .flatten()
            .map(|rule| {
                let tool = text_of(rule, "toolName").unwrap_or_default();
                match text_of(rule, "ruleContent") {
                    Some(content) => format!("{tool}({content})"),
                    None => tool.to_string(),
                }
            })
            .collect::<Vec<_>>()
            .join(", ");
        return (rules.into_iter().map(for_session).collect(), Some(label).filter(|label| !label.is_empty()));
    }
    match suggestions.iter().find(|s| text_of(s, "type") == Some("setMode") && text_of(s, "mode") == Some("acceptEdits")) {
        Some(entry) => (vec![for_session(entry)], Some(EDITS_LABEL.to_string())),
        None => (vec![], None),
    }
}

/// The `request` of a `control_request` line that asks whether a tool may run.
fn tool_request(line: &Value) -> Option<&Value> {
    let request = line.get("request")?;
    (text_of(line, "type") == Some("control_request") && text_of(request, "subtype") == Some("can_use_tool")).then_some(request)
}

/// A shell call that would change the Living Memory store through a plan or a direct write.
fn governed(request: &Value) -> bool {
    matches!(text_of(request, "tool_name"), Some("Bash" | "PowerShell"))
        && request.get("input").and_then(|input| text_of(input, "command")).is_some_and(governed_memory_command)
}

/// A stdin line that answers the CLI's request `request_id`.
fn envelope(request_id: &str, response: Value) -> String {
    json!({"type": "control_response", "response": {"subtype": "success", "request_id": request_id, "response": response}}).to_string()
}

/// A stdin line that asks the CLI for something, under an id of our own.
fn control_request(request: Value) -> String {
    json!({"type": "control_request", "request_id": format!("hivemind-{}", uuid::Uuid::new_v4()), "request": request}).to_string()
}

impl Adapter for ClaudeCode {
    fn name(&self) -> &'static str {
        "claude-code"
    }

    fn command(&self, spec: &Spec) -> Command {
        let mut command = Command::new(&spec.program);
        command.current_dir(&spec.cwd).args(["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"]);
        match &spec.policy {
            // Only the user's own settings: the repository's .claude settings could add allow rules or hooks to a session that
            // never asks. The user settings keep Living Memory's hooks.
            Policy::PreApproved { .. } if !spec.isolated => {
                command.args(["--permission-mode", "dontAsk", "--permission-prompts", "none", "--setting-sources", "user"])
            }
            Policy::PreApproved { .. } => command.args(["--permission-mode", "dontAsk", "--permission-prompts", "none"]),
            Policy::Ask { .. } => {
                command.args(["--permission-mode", "manual", "--permission-prompts", "host", "--permission-prompt-tool", "stdio"])
            }
            Policy::AcceptEdits { .. } => {
                command.args(["--permission-mode", "acceptEdits", "--permission-prompts", "host", "--permission-prompt-tool", "stdio"])
            }
        };
        if spec.isolated {
            // No settings file at all (so no user allow rules), no MCP servers, skills or commands, and only the shell and the
            // to-do list: what may run is exactly the allow rules below.
            command.args(["--restricted", "--tools", ISOLATED_TOOLS]);
            if spec.strict_mcp {
                command.arg("--strict-mcp-config");
            }
            command.arg("--disable-slash-commands");
        }
        command.args([if spec.resume { "--resume" } else { "--session-id" }, &spec.session_id]);
        command.args(["--max-budget-usd", &spec.budget_usd.to_string()]);
        if let Some(model) = &spec.model {
            command.args(["--model", model]);
        }
        if let Some(schema) = &spec.schema {
            command.arg("--json-schema").arg(schema.to_string());
        }
        if !spec.policy.allow().is_empty() {
            command.arg("--allowedTools").args(spec.policy.allow());
        }
        if !spec.deny.is_empty() {
            command.arg("--disallowedTools").args(&spec.deny);
        }
        if !spec.add_dirs.is_empty() {
            command.arg("--add-dir").args(&spec.add_dirs);
        }
        for dir in &spec.plugin_dirs {
            command.arg("--plugin-dir").arg(dir);
        }
        if let Some(root) = &spec.memory_root {
            command.env("LIVING_MEMORY_ROOT", root);
        }
        // Living Memory's hook and CLI refuse their plan, apply and direct-write commands while this is set: the second guard
        // beside the deny rules.
        command.env("HIVEMIND_SESSION", &spec.session_id);
        command
    }

    fn driver(&self, _cwd: &Path, _policy: PolicyMode, _engine_session: Option<&str>, _model: Option<&str>) -> Box<dyn Driver> {
        Box::new(ClaudeDriver)
    }

    fn tool_result(&self, line: &str, tool_use_id: &str) -> Option<(bool, String)> {
        let value: Value = serde_json::from_str(line).ok()?;
        if text_of(&value, "type") != Some("user") {
            return None;
        }
        let block = blocks(&value).find(|block| text_of(block, "type") == Some("tool_result") && text_of(block, "tool_use_id") == Some(tool_use_id))?;
        Some((block.get("is_error").and_then(Value::as_bool) != Some(true), result_text(block.get("content"))))
    }
}

/// The Claude Code conversation: stream-json lines both ways, no handshake and no memory between lines.
struct ClaudeDriver;

impl Driver for ClaudeDriver {
    fn read(&mut self, line: &str) -> Step {
        Step { write: refusal(line).into_iter().collect(), events: parse_line(line), turn: outcome(line), mode: mode_of(line), ..Step::default() }
    }

    fn open(&mut self) -> Vec<String> {
        vec![]
    }

    fn send(&mut self, text: &str) -> Vec<String> {
        vec![user_line(text)]
    }

    fn answer(&mut self, _request_id: &str, request: &str, decision: Decision) -> Option<String> {
        answer_line(request, decision)
    }

    fn interrupt(&mut self) -> Option<String> {
        Some(interrupt_line())
    }

    fn set_mode(&mut self, mode: PolicyMode) -> Option<String> {
        Some(mode_line(mode))
    }
}

fn user_line(text: &str) -> String {
    json!({"type": "user", "message": {"role": "user", "content": [{"type": "text", "text": text}]}}).to_string()
}

pub(crate) fn parse_line(line: &str) -> Vec<RunEvent> {
    let Ok(value) = serde_json::from_str::<Value>(line) else { return vec![] };
    match (text_of(&value, "type"), text_of(&value, "subtype")) {
        (Some("control_request"), _) => {
            let Some(request) = tool_request(&value) else { return vec![] };
            let tool = text_of(request, "tool_name").unwrap_or_default().to_string();
            if governed(request) {
                return vec![RunEvent::Denied { tool, summary: GOVERNED.into() }];
            }
            let summary = match text_of(request, "description").filter(|text| !text.trim().is_empty()) {
                Some(description) => clip(description, TOOL_SUMMARY),
                None => input_summary(request.get("input")),
            };
            let (updates, always_label) = always(request);
            vec![RunEvent::ApprovalRequest {
                request_id: text_of(&value, "request_id").unwrap_or_default().to_string(),
                tool,
                summary,
                input: request.get("input").map_or(Value::Null, |input| clip_strings(input, APPROVAL_INPUT)),
                can_always: !updates.is_empty(),
                always_label,
            }]
        }
        (Some("control_cancel_request"), _) => vec![RunEvent::ApprovalResolved {
            request_id: text_of(&value, "request_id").unwrap_or_default().to_string(),
            decision: Decision::Withdrawn,
        }],
        (Some("system"), Some("init")) => vec![RunEvent::Started {
            model: text_of(&value, "model").map(str::to_string),
            cli_version: text_of(&value, "claude_code_version").map(str::to_string),
            plugins: value
                .get("plugins")
                .and_then(Value::as_array)
                .map(|all| all.iter().filter_map(|plugin| text_of(plugin, "name")).map(str::to_string).collect())
                .unwrap_or_default(),
        }],
        (Some("system"), Some("permission_denied")) => vec![RunEvent::Denied {
            tool: text_of(&value, "tool_name").unwrap_or_default().to_string(),
            summary: clip(text_of(&value, "message").unwrap_or_default(), TOOL_SUMMARY),
        }],
        (Some("assistant"), _) => blocks(&value)
            .filter_map(|block| match text_of(block, "type")? {
                "text" => {
                    let text = text_of(block, "text").filter(|text| !text.trim().is_empty())?;
                    Some(RunEvent::Text { text: text.to_string() })
                }
                "tool_use" => Some(RunEvent::ToolUse {
                    id: text_of(block, "id").unwrap_or_default().to_string(),
                    name: text_of(block, "name").unwrap_or_default().to_string(),
                    summary: input_summary(block.get("input")),
                }),
                _ => None,
            })
            .collect(),
        (Some("user"), _) => blocks(&value)
            .filter(|block| text_of(block, "type") == Some("tool_result"))
            .map(|block| RunEvent::ToolResult {
                id: text_of(block, "tool_use_id").unwrap_or_default().to_string(),
                ok: block.get("is_error").and_then(Value::as_bool) != Some(true),
                summary: result_summary(block.get("content")),
            })
            .collect(),
        _ => vec![],
    }
}

fn outcome(line: &str) -> Option<Outcome> {
    let value: Value = serde_json::from_str(line).ok()?;
    if text_of(&value, "type") != Some("result") {
        return None;
    }
    let subtype = text_of(&value, "subtype").unwrap_or_default();
    let result = text_of(&value, "result");
    let error = value.get("errors").and_then(Value::as_array).and_then(|all| all.first()).and_then(Value::as_str);
    let ok = subtype == "success" && value.get("is_error").and_then(Value::as_bool) != Some(true);
    Some(Outcome {
        ok,
        reason: (!ok).then(|| failure(subtype, result.or(error))),
        cost_usd: value.get("total_cost_usd").and_then(Value::as_f64),
        duration_ms: value.get("duration_ms").and_then(Value::as_u64),
        turns: value.get("num_turns").and_then(Value::as_u64),
        result: result.map(str::to_string),
        structured: value.get("structured_output").filter(|s| !s.is_null()).cloned(),
        denials: value.get("permission_denials").and_then(Value::as_array).map_or(0, |all| all.len() as u64),
        budget: subtype == "error_max_budget_usd",
    })
}

fn answer_line(request: &str, decision: Decision) -> Option<String> {
    let line: Value = serde_json::from_str(request).ok()?;
    let asked = tool_request(&line)?;
    let response = match decision {
        Decision::Withdrawn => return None,
        Decision::Allow => json!({"behavior": "allow"}),
        Decision::AllowAlways => match always(asked).0 {
            updates if updates.is_empty() => json!({"behavior": "allow"}),
            updates => json!({"behavior": "allow", "updatedPermissions": updates}),
        },
        Decision::Deny => json!({"behavior": "deny", "message": DECLINED}),
    };
    Some(envelope(text_of(&line, "request_id")?, response))
}

fn refusal(line: &str) -> Option<String> {
    let line: Value = serde_json::from_str(line).ok()?;
    tool_request(&line).filter(|request| governed(request))?;
    Some(envelope(text_of(&line, "request_id")?, json!({"behavior": "deny", "message": GOVERNED})))
}

fn interrupt_line() -> String {
    control_request(json!({"subtype": "interrupt"}))
}

fn mode_line(mode: PolicyMode) -> String {
    // PreApproved is only ever a launch mode; `dontAsk` is what the launch flags call it.
    let mode = match mode {
        PolicyMode::Ask => "default",
        PolicyMode::AcceptEdits => "acceptEdits",
        PolicyMode::PreApproved => "dontAsk",
    };
    control_request(json!({"subtype": "set_permission_mode", "mode": mode}))
}

fn mode_of(line: &str) -> Option<PolicyMode> {
    let value: Value = serde_json::from_str(line).ok()?;
    if text_of(&value, "type") != Some("system") || text_of(&value, "subtype") != Some("status") {
        return None;
    }
    match text_of(&value, "permissionMode")? {
        "acceptEdits" => Some(PolicyMode::AcceptEdits),
        "default" => Some(PolicyMode::Ask),
        _ => None,
    }
}

/// The oldest Claude Code that Hivemind's flags are recorded as checked on (REG-31). The spike (`docs/plans/spikes/claude-headless.md`)
/// checked the session flags on 2.1.322. No document records the version for `--safe-mode`, `--restricted`,
/// `--no-session-persistence` or `--disable-slash-commands`, so this is the highest version the repository names
/// (2.1.329, in `managed.rs`).
pub const MIN_VERSION: (u32, u32, u32) = (2, 1, 329);

/// The version in the output of `claude --version` ("2.1.322 (Claude Code)"), as (major, minor, patch): the first word that
/// reads as three numbers. None when no word does, so a changed output format is not mistaken for an old version.
pub fn parse_version(output: &str) -> Option<(u32, u32, u32)> {
    output.split_whitespace().find_map(|word| {
        let mut parts = word.trim_start_matches('v').split('.').map(|part| part.chars().take_while(char::is_ascii_digit).collect::<String>().parse::<u32>().ok());
        Some((parts.next()??, parts.next()??, parts.next()??))
    })
}

/// The programs whose version passed the check, so `--version` runs once for each (a refused program is looked at again).
static CHECKED: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

/// Refuse a Claude Code older than `MIN_VERSION`. `probe` prints `<program> --version`, or None when it could not run (the
/// start then reports its own error). An output with no readable version is let through and logged, so a changed format does
/// not lock users out.
fn check_version(program: &str, probe: impl Fn(&str) -> Option<String>, checked: &std::sync::Mutex<Vec<String>>) -> Result<(), String> {
    if checked.lock().unwrap().iter().any(|done| done == program) {
        return Ok(());
    }
    let Some(output) = probe(program) else { return Ok(()) };
    match parse_version(&output) {
        Some(found) if found < MIN_VERSION => {
            let name = |(major, minor, patch): (u32, u32, u32)| format!("{major}.{minor}.{patch}");
            return Err(format!(
                "Claude Code {} is installed, and Hivemind needs {} or newer. Update Claude Code, or set the path to a newer one in Settings.",
                name(found),
                name(MIN_VERSION)
            ));
        }
        Some(_) => {}
        None => log::warn!("Claude version could not be read; starting it anyway"),
    }
    checked.lock().unwrap().push(program.to_string());
    Ok(())
}

#[cfg(not(test))]
fn probe(program: &str) -> Option<String> {
    let mut command = Command::new(program);
    command.arg("--version");
    crate::git::run_with_timeout(command, Duration::from_secs(10)).ok()
}

#[cfg(test)]
thread_local! {
    /// What `claude --version` prints in a test on this thread: nothing (it could not run) unless a test sets it, so no test
    /// starts the real program.
    static FAKE_VERSION: std::cell::RefCell<Option<String>> = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
fn probe(_program: &str) -> Option<String> {
    FAKE_VERSION.with(|fake| fake.borrow().clone())
}

/// The folders under Program Files named `names`, where a per-machine (all users) install may be; none off Windows, and none
/// without `program_files`. A parameter so tests never read the real environment.
pub fn under_program_files(program_files: Option<PathBuf>, names: &[&str]) -> Vec<PathBuf> {
    if !cfg!(windows) {
        return vec![];
    }
    program_files.into_iter().flat_map(|base| names.iter().map(move |name| base.join(name))).collect()
}

/// Where a per-machine install of Claude Code may be. None of these is documented by Claude Code or recorded in this
/// repository: `ClaudeCode` is the folder Claude Code's managed settings use under Program Files (`managed.rs`), the others
/// are the product's name spelled out.
/// The tools of an isolated session: the shell and the to-do list. Claude Code has a PowerShell tool on Windows only
/// (MACOS-1D).
const ISOLATED_TOOLS: &str = if cfg!(windows) { "Bash,PowerShell,TodoWrite" } else { "Bash,TodoWrite" };

pub fn machine_folders() -> Vec<PathBuf> {
    under_program_files(std::env::var_os("ProgramFiles").map(PathBuf::from), &["ClaudeCode", "Claude Code", r"Anthropic\ClaudeCode"])
}

/// The CLI to launch: the saved path, else a per-machine install in `machine_dirs`, else the native installer's place for
/// the user, else `claude` on PATH. A per-machine folder comes first because it is the one an application allow list
/// (AppLocker) usually permits, and the user's own folders usually are not.
/// `on_path` says whether the bare name runs; it is a parameter so tests never start the real CLI.
pub fn locate(saved: &Settings, machine_dirs: &[PathBuf], home: &Path, on_path: impl Fn() -> bool) -> Result<String, String> {
    if let Some(path) = saved.claude_path.as_deref().map(str::trim).filter(|path| Path::new(path).is_file()) {
        return Ok(path.to_string());
    }
    let name = if cfg!(windows) { "claude.exe" } else { "claude" };
    if let Some(machine) = machine_dirs.iter().map(|dir| dir.join(name)).find(|path| path.is_file()) {
        return Ok(machine.display().to_string());
    }
    let installed = home.join(".local").join("bin").join(name);
    if installed.is_file() {
        return Ok(installed.display().to_string());
    }
    if on_path() {
        return Ok("claude".into());
    }
    // Off Windows, after PATH: the older local npm install, then Homebrew (Apple silicon, Intel), for when the login
    // shell's PATH could not be read (shell_env).
    if !cfg!(windows) {
        let fallback = [home.join(".claude").join("local").join(name), PathBuf::from("/opt/homebrew/bin/claude"), PathBuf::from("/usr/local/bin/claude")];
        if let Some(found) = fallback.into_iter().find(|p| p.is_file()) {
            return Ok(found.display().to_string());
        }
    }
    Err("Claude Code was not found. Install it, or set the path to its program in Settings.".into())
}

/// The Claude Code program to start, once its version is known to be new enough (`MIN_VERSION`).
pub fn available(saved: &Settings) -> Result<String, String> {
    let home = dirs::home_dir().ok_or("Could not find your home folder")?;
    let program = locate(saved, &machine_folders(), &home, || {
        let mut command = Command::new("claude");
        command.arg("--version");
        crate::git::run_with_timeout(command, Duration::from_secs(5)).is_ok()
    })?;
    check_version(&program, probe, &CHECKED)?;
    Ok(program)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(line: &str) -> Vec<RunEvent> {
        parse_line(line)
    }

    #[test]
    fn init_becomes_started() {
        let line = r#"{"type":"system","subtype":"init","session_id":"00000000-0000-4000-8000-000000000001","model":"claude-test-1",
            "claude_code_version":"2.1.321","cwd":"/work/app","permissionMode":"dontAsk","tools":["Bash","Read"],"skills":[],
            "plugins":[{"name":"architecture-suite","path":"/plugins/architecture-suite","source":"architecture-suite@local"},{"path":"/nameless"}]}"#;
        assert_eq!(
            parse(line),
            vec![RunEvent::Started {
                model: Some("claude-test-1".into()),
                cli_version: Some("2.1.321".into()),
                plugins: vec!["architecture-suite".into()]
            }]
        );
        assert_eq!(
            parse(r#"{"type":"system","subtype":"init"}"#),
            vec![RunEvent::Started { model: None, cli_version: None, plugins: vec![] }]
        );
    }

    #[test]
    fn assistant_blocks_become_text_and_tool_use() {
        let line = r#"{"type":"assistant","parent_tool_use_id":null,"message":{"content":[
            {"type":"thinking","thinking":"hidden"},{"type":"text","text":"Looking at the repo."},{"type":"text","text":"  "},
            {"type":"tool_use","id":"toolu_01","name":"Bash","input":{"command":"git log --oneline","description":"Show history"}},
            {"type":"tool_use","id":"toolu_02","name":"Read","input":{"file_path":"/work/app/README.md"}},
            {"type":"tool_use","id":"toolu_03","name":"Odd","input":{"count":3}},
            {"type":"tool_use","id":"toolu_04","name":"Bare"}]}}"#;
        let tool = |id: &str, name: &str, summary: &str| RunEvent::ToolUse { id: id.into(), name: name.into(), summary: summary.into() };
        assert_eq!(
            parse(line),
            vec![
                RunEvent::Text { text: "Looking at the repo.".into() },
                tool("toolu_01", "Bash", "git log --oneline"),
                tool("toolu_02", "Read", "/work/app/README.md"),
                tool("toolu_03", "Odd", r#"{"count":3}"#),
                tool("toolu_04", "Bare", ""),
            ]
        );
    }

    #[test]
    fn tool_results_keep_ok_and_error_in_both_content_shapes() {
        let line = r#"{"type":"user","message":{"content":[
            {"type":"tool_result","tool_use_id":"toolu_01","content":"3 commits"},
            {"type":"tool_result","tool_use_id":"toolu_02","content":"No such file","is_error":true},
            {"type":"tool_result","tool_use_id":"toolu_03","content":[{"type":"text","text":"first"},{"type":"image"},{"type":"text","text":"second"}],"is_error":false},
            {"type":"tool_result","tool_use_id":"toolu_04","content":[{"type":"text","text":"denied"}],"is_error":true},
            {"type":"text","text":"not a result"}]}}"#;
        let result = |id: &str, ok: bool, summary: &str| RunEvent::ToolResult { id: id.into(), ok, summary: summary.into() };
        assert_eq!(
            parse(line),
            vec![
                result("toolu_01", true, "3 commits"),
                result("toolu_02", false, "No such file"),
                result("toolu_03", true, "first\nsecond"),
                result("toolu_04", false, "denied"),
            ]
        );
        // A plain-text user message has no blocks to report.
        assert!(parse(r#"{"type":"user","message":{"role":"user","content":"hello"}}"#).is_empty());
    }

    #[test]
    fn tool_result_gives_the_whole_text() {
        let long = "é".repeat(700);
        let line = json!({"type": "user", "message": {"content": [
            {"type": "tool_result", "tool_use_id": "toolu_01", "content": long},
            {"type": "tool_result", "tool_use_id": "toolu_02", "content": "No such file", "is_error": true},
        ]}})
        .to_string();
        assert_eq!(ClaudeCode.tool_result(&line, "toolu_02"), Some((false, "No such file".to_string())));
        assert_eq!(ClaudeCode.tool_result(&line, "toolu_01"), Some((true, long)));
        assert_eq!(ClaudeCode.tool_result(&line, "toolu_09"), None);
        let assistant = r#"{"type":"assistant","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_01","content":"x"}]}}"#;
        assert_eq!(ClaudeCode.tool_result(assistant, "toolu_01"), None);
        assert_eq!(ClaudeCode.tool_result("not json", "toolu_01"), None);
    }

    #[test]
    fn permission_denied_becomes_denied() {
        let line = r#"{"type":"system","subtype":"permission_denied","tool_name":"Bash","tool_use_id":"toolu_05","message":"Permission to use Bash has been denied because it is not allowed."}"#;
        assert_eq!(
            parse(line),
            vec![RunEvent::Denied {
                tool: "Bash".into(),
                summary: "Permission to use Bash has been denied because it is not allowed.".into()
            }]
        );
    }

    #[test]
    fn noise_unknown_and_malformed_lines_give_nothing() {
        for line in [
            r#"{"type":"system","subtype":"hook_started","hook":"SessionStart"}"#,
            r#"{"type":"system","subtype":"hook_response","output":"ok"}"#,
            r#"{"type":"system","subtype":"thinking_tokens","tokens":12}"#,
            r#"{"type":"rate_limit_event","status":"allowed"}"#,
            r#"{"type":"system","subtype":"something_new"}"#,
            r#"{"type":"something_new"}"#,
            r#"{"type":"assistant","message":"not an object"}"#,
            r#"{"type":"assistant"}"#,
            r#"{"type":7}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"te"#,
            "[1,2,3]",
            "null",
            "not json",
            "",
        ] {
            assert!(parse(line).is_empty(), "{line}");
            assert_eq!(outcome(line), None, "{line}");
        }
        // The closing report is read by `outcome`; it is not an event.
        assert!(parse(r#"{"type":"result","subtype":"success","is_error":false,"result":"done"}"#).is_empty());
    }

    #[test]
    fn summaries_are_cut_to_their_limits() {
        let long = "é".repeat(700);
        let use_line = json!({"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "t", "name": "Bash", "input": {"command": long}}]}});
        let result_line = json!({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "t", "content": long}]}});
        let denied_line = json!({"type": "system", "subtype": "permission_denied", "tool_name": "Bash", "message": long});
        let text_line = json!({"type": "assistant", "message": {"content": [{"type": "text", "text": long}]}});
        let length = |line: &Value| match &parse(&line.to_string())[0] {
            RunEvent::ToolUse { summary, .. } | RunEvent::ToolResult { summary, .. } | RunEvent::Denied { summary, .. } => {
                assert!(summary.ends_with('…'));
                summary.chars().count()
            }
            RunEvent::Text { text } => text.chars().count(),
            other => panic!("{other:?}"),
        };
        assert_eq!(length(&use_line), 300);
        assert_eq!(length(&result_line), 500);
        assert_eq!(length(&denied_line), 300);
        assert_eq!(length(&text_line), 700);
        assert_eq!(clip("short", 300), "short");
        assert_eq!(clip(&"x".repeat(300), 300).chars().count(), 300);
    }

    #[test]
    fn result_lines_give_the_outcome() {
        let done = outcome(
                r#"{"type":"result","subtype":"success","is_error":false,"num_turns":3,"duration_ms":4670,"total_cost_usd":0.0066,"result":"All done.",
                "structured_output":{"summary":"Billing takes payments."},"permission_denials":[{"tool_name":"Bash","tool_use_id":"toolu_05","tool_input":{}}],
                "session_id":"00000000-0000-4000-8000-000000000001"}"#,
            )
            .unwrap();
        assert_eq!(
            done,
            Outcome {
                ok: true,
                reason: None,
                cost_usd: Some(0.0066),
                duration_ms: Some(4670),
                turns: Some(3),
                result: Some("All done.".into()),
                structured: Some(json!({"summary": "Billing takes payments."})),
                denials: 1,
                budget: false,
            }
        );
        let over = outcome(
                r#"{"type":"result","subtype":"error_max_budget_usd","is_error":false,"total_cost_usd":5.02,"structured_output":null}"#,
            )
            .unwrap();
        assert!(!over.ok);
        assert_eq!(over.reason.as_deref(), Some("Claude Code reached the budget limit for this session"));
        assert_eq!((over.cost_usd, over.structured, over.denials, over.budget), (Some(5.02), None, 0, true));
        let capped = outcome(
                r#"{"type":"result","subtype":"error_max_budget_usd","is_error":true,"num_turns":1,"total_cost_usd":0.0092,
                "errors":["Reached maximum budget ($0.004)"],"terminal_reason":"budget_exhausted"}"#,
            )
            .unwrap();
        assert!(!capped.ok && capped.budget && capped.result.is_none());
        assert!(capped.reason.as_deref().is_some_and(|reason| reason.contains("Reached maximum budget")), "{:?}", capped.reason);
        let unknown = outcome(
                r#"{"type":"result","subtype":"error_during_execution","is_error":true,"num_turns":0,"errors":["No conversation found with session ID: 0f9e8d7c"]}"#,
            )
            .unwrap();
        assert!(unknown.reason.as_deref().is_some_and(|reason| reason.contains("No conversation found")), "{:?}", unknown.reason);
        assert!(!unknown.budget);
        let flagged =
            outcome(r#"{"type":"result","subtype":"success","is_error":true,"result":"Credit balance is too low"}"#).unwrap();
        assert_eq!(flagged.reason.as_deref(), Some("Claude Code reported an error: Credit balance is too low"));
        let new = outcome(r#"{"type":"result","subtype":"error_something_new"}"#).unwrap();
        assert_eq!(new.reason.as_deref(), Some("Claude Code stopped (error something new)"));
    }

    // Verbatim from the spike (section 5.1 B of the Phase 2 document).
    const WRITE_REQUEST: &str = r#"{"type":"control_request","request_id":"a09f3229-53c0-4a3d-9b4b-bfa4cb890730","request":{"subtype":"can_use_tool","tool_name":"Write","display_name":"Write","input":{"file_path":"<SCRATCH>\\spike-claude\\a.txt","content":"x"},"description":"a.txt","permission_suggestions":[{"type":"setMode","mode":"acceptEdits","destination":"session"}],"tool_use_id":"toolu_01JDdQ12vozJ8B3vPpSdHovj"}}"#;
    const BASH_REQUEST: &str = r#"{"type":"control_request","request_id":"6c738ff4-3b35-4894-acec-1b2806f0b2f4","request":{"subtype":"can_use_tool","tool_name":"Bash","display_name":"Bash","input":{"command":"mkdir spike_dir_1","description":"Create directory spike_dir_1"},"description":"Create directory spike_dir_1","permission_suggestions":[{"type":"addRules","rules":[{"toolName":"Bash","ruleContent":"mkdir spike_dir_1"}],"behavior":"allow","destination":"localSettings"},{"type":"addDirectories","directories":["<SCRATCH>\\spike-claude"],"destination":"session"},{"type":"setMode","mode":"acceptEdits","destination":"session"}],"blocked_path":"<SCRATCH>\\spike-claude\\spike_dir_1","tool_use_id":"toolu_01BaUp77S1XfWQ94cYZZXe5W"}}"#;
    const GOVERNED_REQUEST: &str = r#"{"type":"control_request","request_id":"r-gov","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"python living_memory.py apply x --expected-plan-sha256 y"},"permission_suggestions":[]}}"#;

    fn json_of(line: &str) -> Value {
        serde_json::from_str(line).unwrap()
    }

    #[test]
    fn permission_requests_become_approval_requests() {
        let RunEvent::ApprovalRequest { request_id, tool, summary, input, can_always, always_label } = parse(WRITE_REQUEST).remove(0) else {
            panic!("not an approval request")
        };
        assert_eq!((request_id.as_str(), tool.as_str(), summary.as_str()), ("a09f3229-53c0-4a3d-9b4b-bfa4cb890730", "Write", "a.txt"));
        assert_eq!(input["content"], "x");
        assert!(can_always);
        assert_eq!(always_label.as_deref(), Some("file edits and simple file commands in the worktree"));
        assert_eq!(parse(WRITE_REQUEST).len(), 1);

        let RunEvent::ApprovalRequest { tool, summary, always_label, can_always, .. } = parse(BASH_REQUEST).remove(0) else {
            panic!("not an approval request")
        };
        assert_eq!((tool.as_str(), summary.as_str()), ("Bash", "Create directory spike_dir_1"));
        assert!(can_always);
        assert_eq!(always_label.as_deref(), Some("Bash(mkdir spike_dir_1)"));

        let bare = r#"{"type":"control_request","request_id":"r2","request":{"subtype":"can_use_tool","tool_name":"Read","input":{"file_path":"/work/app/a.md"}}}"#;
        let RunEvent::ApprovalRequest { summary, can_always, always_label, .. } = parse(bare).remove(0) else { panic!("not an approval request") };
        assert_eq!((summary.as_str(), can_always, always_label), ("/work/app/a.md", false, None));

        let long = json!({"type": "control_request", "request_id": "r3", "request": {"subtype": "can_use_tool", "tool_name": "Write",
            "input": {"file_path": "a.txt", "content": "é".repeat(10_000), "more": ["é".repeat(5_000)]}}});
        let RunEvent::ApprovalRequest { input, .. } = parse(&long.to_string()).remove(0) else { panic!("not an approval request") };
        assert_eq!(input["content"].as_str().unwrap().chars().count(), 4000);
        assert_eq!(input["more"][0].as_str().unwrap().chars().count(), 4000);
        assert_eq!(input["file_path"], "a.txt");
    }

    #[test]
    fn governed_memory_requests_are_denied_without_asking() {
        assert_eq!(parse(GOVERNED_REQUEST), vec![RunEvent::Denied { tool: "Bash".into(), summary: GOVERNED.into() }]);
        let refused = json_of(&refusal(GOVERNED_REQUEST).unwrap());
        assert_eq!(
            refused,
            json!({"type": "control_response", "response": {"subtype": "success", "request_id": "r-gov",
                "response": {"behavior": "deny", "message": GOVERNED}}})
        );
        let powershell = GOVERNED_REQUEST.replace("\"Bash\"", "\"PowerShell\"");
        assert!(matches!(parse(&powershell)[..], [RunEvent::Denied { .. }]));
        assert!(refusal(&powershell).is_some());
        assert_eq!(refusal(BASH_REQUEST), None);
        assert_eq!(refusal(WRITE_REQUEST), None);
        assert_eq!(refusal("not json"), None);
    }

    #[test]
    fn answers_are_one_json_line_in_the_envelope() {
        let allow = answer_line(BASH_REQUEST, Decision::Allow).unwrap();
        assert!(!allow.contains('\n'));
        assert_eq!(
            json_of(&allow),
            json!({"type": "control_response", "response": {"subtype": "success", "request_id": "6c738ff4-3b35-4894-acec-1b2806f0b2f4",
                "response": {"behavior": "allow"}}})
        );
        let deny = answer_line(BASH_REQUEST, Decision::Deny).unwrap();
        assert!(!deny.contains('\n'));
        let deny = json_of(&deny);
        assert_eq!(deny["response"]["response"]["behavior"], "deny");
        assert!(!deny["response"]["response"]["message"].as_str().unwrap().is_empty());
        assert_eq!(answer_line(BASH_REQUEST, Decision::Withdrawn), None);
        assert_eq!(answer_line(r#"{"type":"control_cancel_request","request_id":"r1"}"#, Decision::Allow), None);
        assert_eq!(answer_line(r#"{"type":"system","subtype":"init"}"#, Decision::Allow), None);
        assert_eq!(answer_line("not json", Decision::Allow), None);
    }

    #[test]
    fn always_allow_is_rewritten_to_the_session() {
        let line = answer_line(BASH_REQUEST, Decision::AllowAlways).unwrap();
        assert!(!line.contains("localSettings") && !line.contains("addDirectories"), "{line}");
        let response = json_of(&line)["response"]["response"].clone();
        assert_eq!(response["behavior"], "allow");
        assert_eq!(
            response["updatedPermissions"],
            json!([{"type": "addRules", "rules": [{"toolName": "Bash", "ruleContent": "mkdir spike_dir_1"}], "behavior": "allow",
                "destination": "session"}])
        );

        let response = json_of(&answer_line(WRITE_REQUEST, Decision::AllowAlways).unwrap())["response"]["response"].clone();
        assert_eq!(response["updatedPermissions"], json!([{"type": "setMode", "mode": "acceptEdits", "destination": "session"}]));

        // Nothing to remember, or a request that forbids it: a plain allow.
        let none = r#"{"type":"control_request","request_id":"r4","request":{"subtype":"can_use_tool","tool_name":"Read","input":{}}}"#;
        let suppressed = BASH_REQUEST.replace(r#""description":"Create directory spike_dir_1","permission_suggestions""#, r#""suppress_always_allow_rule":true,"permission_suggestions""#);
        for request in [none, suppressed.as_str()] {
            let response = json_of(&answer_line(request, Decision::AllowAlways).unwrap())["response"]["response"].clone();
            assert_eq!(response, json!({"behavior": "allow"}), "{request}");
        }
        let RunEvent::ApprovalRequest { can_always, always_label, .. } = parse(&suppressed).remove(0) else { panic!("not an approval request") };
        assert_eq!((can_always, always_label), (false, None));

        // A rule without content is written as the bare tool name; several rules are joined.
        let rules = r#"{"type":"control_request","request_id":"r5","request":{"subtype":"can_use_tool","tool_name":"WebFetch","input":{},
            "permission_suggestions":[{"type":"addRules","rules":[{"toolName":"WebFetch"},{"toolName":"Read","ruleContent":"//c/x/**"}],
            "behavior":"allow","destination":"localSettings"},{"type":"addRules","rules":[{"toolName":"Bash"}],"behavior":"deny","destination":"session"}]}}"#;
        let RunEvent::ApprovalRequest { always_label, .. } = parse(rules).remove(0) else { panic!("not an approval request") };
        assert_eq!(always_label.as_deref(), Some("WebFetch, Read(//c/x/**)"));
    }

    #[test]
    fn withdrawn_requests_resolve() {
        assert_eq!(
            parse(r#"{"type":"control_cancel_request","request_id":"r1"}"#),
            vec![RunEvent::ApprovalResolved { request_id: "r1".into(), decision: Decision::Withdrawn }]
        );
        assert!(parse(r#"{"type":"control_response","response":{"subtype":"success","request_id":"r1","response":{}}}"#).is_empty());
        assert!(parse(r#"{"type":"control_request","request_id":"r6","request":{"subtype":"something_else"}}"#).is_empty());
    }

    #[test]
    fn control_lines_are_valid_and_never_initialize() {
        let (first, second) = (json_of(&interrupt_line()), json_of(&interrupt_line()));
        assert_eq!((first["type"].as_str(), first["request"]["subtype"].as_str()), (Some("control_request"), Some("interrupt")));
        assert!(first["request_id"].as_str().unwrap().starts_with("hivemind-"));
        assert_ne!(first["request_id"], second["request_id"]);
        let mode = |mode: PolicyMode| json_of(&mode_line(mode))["request"].clone();
        assert_eq!(mode(PolicyMode::Ask), json!({"subtype": "set_permission_mode", "mode": "default"}));
        assert_eq!(mode(PolicyMode::AcceptEdits), json!({"subtype": "set_permission_mode", "mode": "acceptEdits"}));
        assert_eq!(mode(PolicyMode::PreApproved), json!({"subtype": "set_permission_mode", "mode": "dontAsk"}));
        let mut lines = vec![interrupt_line(), user_line("hello")];
        lines.extend([PolicyMode::PreApproved, PolicyMode::Ask, PolicyMode::AcceptEdits].map(mode_line));
        lines.extend([Decision::Allow, Decision::AllowAlways, Decision::Deny].map(|d| answer_line(BASH_REQUEST, d).unwrap()));
        lines.extend(refusal(GOVERNED_REQUEST));
        for line in lines {
            assert!(!line.contains('\n') && !line.contains("initialize") && !line.contains("get_status"), "{line}");
        }
    }

    #[test]
    fn status_lines_report_the_mode() {
        let status = |mode: &str| mode_of(&format!(r#"{{"type":"system","subtype":"status","status":null,"permissionMode":"{mode}"}}"#));
        assert_eq!(status("acceptEdits"), Some(PolicyMode::AcceptEdits));
        assert_eq!(status("default"), Some(PolicyMode::Ask));
        assert_eq!(status("plan"), None);
        assert_eq!(mode_of(r#"{"type":"system","subtype":"status","status":"requesting"}"#), None);
        assert_eq!(mode_of(r#"{"type":"system","subtype":"init","permissionMode":"acceptEdits"}"#), None);
        assert_eq!(mode_of("not json"), None);
    }

    fn spec(policy: Policy) -> Spec {
        Spec {
            session_id: "00000000-0000-4000-8000-000000000001".into(),
            cwd: PathBuf::from("/work/app"),
            add_dirs: vec![PathBuf::from("/work/api"), PathBuf::from("/work/arch")],
            policy,
            plugin_dirs: vec![PathBuf::from("/plugins/suite")],
            budget_usd: 5.0,
            schema: Some(json!({"type": "object"})),
            program: "claude".into(),
            program_args: vec![],
            resume: false,
            model: None,
            deny: vec![],
            isolated: false,
            strict_mcp: true,
            memory_root: None,
        }
    }

    #[test]
    fn an_isolated_session_leaves_out_strict_mcp_config_when_asked() {   // REG-16
        let mut executive = spec(Policy::PreApproved { allow: vec!["TodoWrite".into()] });
        (executive.isolated, executive.strict_mcp) = (true, false);
        let args = args_of(&ClaudeCode.command(&executive));
        assert!(!args.iter().any(|a| a == "--strict-mcp-config"), "{args:?}");
        for flag in ["--restricted", "--tools", ISOLATED_TOOLS, "--disable-slash-commands"] {
            assert!(args.iter().any(|a| a == flag), "{flag}");
        }
        // The flag order is as before, so only the one flag differs.
        executive.strict_mcp = true;
        let with = args_of(&ClaudeCode.command(&executive));
        let without: Vec<String> = with.iter().filter(|a| *a != "--strict-mcp-config").cloned().collect();
        assert_eq!(without, args);
    }

    #[test]
    fn an_isolated_session_loads_no_settings_and_only_the_shell() {
        let mut executive = spec(Policy::PreApproved { allow: vec!["TodoWrite".into(), "Bash(alm --json --domain pay search *)".into()] });
        (executive.isolated, executive.add_dirs, executive.plugin_dirs, executive.schema) = (true, vec![], vec![], None);
        #[rustfmt::skip]
        let expected = [
            "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
            "--permission-mode", "dontAsk", "--permission-prompts", "none",
            "--restricted", "--tools", ISOLATED_TOOLS, "--strict-mcp-config", "--disable-slash-commands",
            "--session-id", "00000000-0000-4000-8000-000000000001", "--max-budget-usd", "5",
            "--allowedTools", "TodoWrite", "Bash(alm --json --domain pay search *)",
        ];
        assert_eq!(args_of(&ClaudeCode.command(&executive)), expected);
    }

    fn args_of(command: &Command) -> Vec<String> {
        command.get_args().map(|arg| arg.to_string_lossy().into_owned()).collect()
    }

    /// Every rule is an argument. An unattended editing role with five allowed commands, every deny rule and an npm `.cmd`
    /// launcher must stay under cmd.exe's 8191 characters (about 5,300 on 2026-11-20); count before adding rules.
    #[test]
    fn a_role_session_command_line_fits_the_cmd_limit() {
        use crate::agent::{roles::Profile, scope};
        let commands = ["npm test", "npm run build", "cargo test", "cargo clippy", "npx tsc --noEmit"].map(String::from);
        let policy = scope::profile_policy(Profile::EditWorktree, Path::new("C:/Users/someone/AppData/Roaming/hivemind/worktrees/0f9e8d7c"), false, &commands).unwrap();
        let mut role = spec(policy);
        role.deny = scope::deny_rules();
        let args = args_of(&ClaudeCode.command(&role));
        let length: usize = args.iter().map(|arg| arg.len() + 3).sum::<usize>() + "C:/Users/someone/AppData/Roaming/npm/claude.cmd".len();
        assert!(length < 8191, "{length}");
    }

    #[test]
    fn command_carries_the_spec() {
        let allow = vec!["Edit(//work/arch/**)".to_string(), "Bash(*architecture-suite.py *)".to_string()];
        let mut passport = spec(Policy::PreApproved { allow });
        let command = ClaudeCode.command(&passport);
        #[rustfmt::skip]
        let expected = [
            "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
            "--permission-mode", "dontAsk", "--permission-prompts", "none", "--setting-sources", "user",
            "--session-id", "00000000-0000-4000-8000-000000000001", "--max-budget-usd", "5", "--json-schema", r#"{"type":"object"}"#,
            "--allowedTools", "Edit(//work/arch/**)", "Bash(*architecture-suite.py *)",
            "--add-dir", "/work/api", "/work/arch", "--plugin-dir", "/plugins/suite",
        ];
        assert_eq!(args_of(&command), expected);
        assert_eq!(command.get_program(), "claude");
        assert_eq!(command.get_current_dir(), Some(Path::new("/work/app")));

        // The deny rules go between the allow rules and --add-dir, each as its own argument.
        passport.deny = vec!["Bash(*living_memory.py* apply *)".into(), "Bash(*living_memory.py* apply)".into()];
        #[rustfmt::skip]
        let expected = [
            "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
            "--permission-mode", "dontAsk", "--permission-prompts", "none", "--setting-sources", "user",
            "--session-id", "00000000-0000-4000-8000-000000000001", "--max-budget-usd", "5", "--json-schema", r#"{"type":"object"}"#,
            "--allowedTools", "Edit(//work/arch/**)", "Bash(*architecture-suite.py *)",
            "--disallowedTools", "Bash(*living_memory.py* apply *)", "Bash(*living_memory.py* apply)",
            "--add-dir", "/work/api", "/work/arch", "--plugin-dir", "/plugins/suite",
        ];
        assert_eq!(args_of(&ClaudeCode.command(&passport)), expected);

        let ask = args_of(&ClaudeCode.command(&spec(Policy::Ask { allow: vec![] })));
        #[rustfmt::skip]
        let head = [
            "--verbose", "--permission-mode", "manual", "--permission-prompts", "host", "--permission-prompt-tool", "stdio",
            "--session-id", "00000000-0000-4000-8000-000000000001", "--max-budget-usd", "5",
        ];
        assert_eq!(ask[5..5 + head.len()], head);
        assert!(!ask.contains(&"--allowedTools".to_string()) && !ask.contains(&"--disallowedTools".to_string()));

        let mut resumed = spec(Policy::AcceptEdits { allow: vec![] });
        resumed.resume = true;
        resumed.model = Some("haiku".into());
        let resumed = args_of(&ClaudeCode.command(&resumed));
        #[rustfmt::skip]
        let head = [
            "--verbose", "--permission-mode", "acceptEdits", "--permission-prompts", "host", "--permission-prompt-tool", "stdio",
            "--resume", "00000000-0000-4000-8000-000000000001", "--max-budget-usd", "5", "--model", "haiku",
        ];
        assert_eq!(resumed[5..5 + head.len()], head);
        assert!(!resumed.contains(&"--session-id".to_string()));

        let line = user_line("Say \"hi\"\nthen stop");
        assert!(!line.contains('\n'), "one line on stdin");
        assert_eq!(
            serde_json::from_str::<Value>(&line).unwrap(),
            json!({"type": "user", "message": {"role": "user", "content": [{"type": "text", "text": "Say \"hi\"\nthen stop"}]}})
        );
    }

    #[test]
    fn command_points_living_memory_at_the_apps_store() {
        let stored = |command: &Command| {
            command.get_envs().find(|(name, _)| *name == "LIVING_MEMORY_ROOT").map(|(_, value)| value.map(|v| v.to_string_lossy().into_owned()))
        };
        for policy in [Policy::PreApproved { allow: vec![] }, Policy::Ask { allow: vec![] }] {
            let mut with_root = spec(policy.clone());
            with_root.memory_root = Some(PathBuf::from("/stores/demo"));
            assert_eq!(stored(&ClaudeCode.command(&with_root)), Some(Some("/stores/demo".to_string())));
            // No root: the variable is neither set nor removed, so the CLI inherits the app's own.
            assert_eq!(stored(&ClaudeCode.command(&spec(policy))), None);
        }
    }

    #[test]
    fn finds_the_cli_in_order() {
        let home = std::env::temp_dir().join(format!("hivemind-agent-locate-{}", std::process::id()));
        let bin = home.join(".local").join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let nothing = Settings::default();
        assert_eq!(locate(&nothing, &[], &home, || true).unwrap(), "claude");
        assert!(locate(&nothing, &[], &home, || false).unwrap_err().contains("Settings"));

        let installed = bin.join(if cfg!(windows) { "claude.exe" } else { "claude" });
        std::fs::write(&installed, "").unwrap();
        assert_eq!(locate(&nothing, &[], &home, || false).unwrap(), installed.display().to_string());

        let chosen = home.join("my-claude");
        std::fs::write(&chosen, "").unwrap();
        let saved = |path: &Path| Settings { claude_path: Some(path.display().to_string()), ..Default::default() };
        assert_eq!(locate(&saved(&chosen), &[], &home, || false).unwrap(), chosen.display().to_string());
        // A saved path that is not there falls through to the next place.
        assert_eq!(locate(&saved(&home.join("gone")), &[], &home, || false).unwrap(), installed.display().to_string());
        std::fs::remove_dir_all(home).ok();
    }

    #[test]
    fn an_old_local_install_never_comes_before_path() {   // Codex F10 (772b27c)
        let home = std::env::temp_dir().join(format!("hivemind-agent-local-{}", std::process::id()));
        let local = home.join(".claude").join("local");
        std::fs::create_dir_all(&local).unwrap();
        let old = local.join(if cfg!(windows) { "claude.exe" } else { "claude" });
        std::fs::write(&old, "").unwrap();
        let nothing = Settings::default();
        assert_eq!(locate(&nothing, &[], &home, || true).unwrap(), "claude");
        // Without one on PATH it is the fallback off Windows only.
        let missing = locate(&nothing, &[], &home, || false);
        if cfg!(windows) { assert!(missing.is_err()) } else { assert_eq!(missing.unwrap(), old.display().to_string()) }
        std::fs::remove_dir_all(home).ok();
    }

    #[test]
    fn a_per_machine_install_comes_before_the_users_folder_and_path() {   // REG-17
        let home = std::env::temp_dir().join(format!("hivemind-agent-machine-{}", std::process::id()));
        let name = if cfg!(windows) { "claude.exe" } else { "claude" };
        let (machine, empty) = (home.join("Program Files").join("ClaudeCode"), home.join("Program Files").join("Claude Code"));
        let user = home.join(".local").join("bin").join(name);
        for dir in [&machine, &empty, user.parent().unwrap()] {
            std::fs::create_dir_all(dir).unwrap();
        }
        std::fs::write(&user, "").unwrap();
        let (nothing, folders) = (Settings::default(), [empty.clone(), machine.clone()]);
        // Nothing per machine yet: the user's folder, as before.
        assert_eq!(locate(&nothing, &folders, &home, || true).unwrap(), user.display().to_string());
        // A per-machine install beats the user's folder and PATH, in whichever folder of the list it is.
        let installed = machine.join(name);
        std::fs::write(&installed, "").unwrap();
        assert_eq!(locate(&nothing, &folders, &home, || true).unwrap(), installed.display().to_string());
        // The first folder of the list that has it wins.
        let first = empty.join(name);
        std::fs::write(&first, "").unwrap();
        assert_eq!(locate(&nothing, &folders, &home, || true).unwrap(), first.display().to_string());
        // The saved path still wins over everything, and one that is not there does not.
        let chosen = home.join("my-claude");
        std::fs::write(&chosen, "").unwrap();
        let saved = |path: &Path| Settings { claude_path: Some(path.display().to_string()), ..Default::default() };
        assert_eq!(locate(&saved(&chosen), &folders, &home, || true).unwrap(), chosen.display().to_string());
        assert_eq!(locate(&saved(&home.join("gone")), &folders, &home, || true).unwrap(), first.display().to_string());
        std::fs::remove_dir_all(home).ok();
    }

    #[test]
    fn per_machine_folders_are_under_program_files_on_windows_only() {   // REG-17
        let folders = under_program_files(Some(PathBuf::from(r"C:\Program Files")), &["ClaudeCode", "Claude Code"]);
        if cfg!(windows) {
            assert_eq!(folders, [PathBuf::from(r"C:\Program Files").join("ClaudeCode"), PathBuf::from(r"C:\Program Files").join("Claude Code")]);
        } else {
            assert!(folders.is_empty());
        }
        assert!(under_program_files(None, &["ClaudeCode"]).is_empty(), "no Program Files variable, no folders");
    }

    #[test]
    fn the_version_is_read_from_the_cli_output() {   // REG-31
        assert_eq!(parse_version("2.1.322 (Claude Code)\n"), Some((2, 1, 322)));
        assert_eq!(parse_version("Claude Code v2.1.400"), Some((2, 1, 400)));
        assert_eq!(parse_version("2.2.0-beta.1 (Claude Code)"), Some((2, 2, 0)));
        assert_eq!(parse_version("claude"), None);
        assert_eq!(parse_version("2.1"), None);
        assert_eq!(parse_version(""), None);
    }

    #[test]
    fn an_old_claude_code_is_refused_and_a_new_or_unreadable_one_is_let_through() {   // REG-31
        let checked = std::sync::Mutex::new(Vec::new());
        let says = |text: &'static str| move |_: &str| Some(text.to_string());
        let old = check_version("claude", says("2.1.328 (Claude Code)"), &checked).unwrap_err();
        assert_eq!(old, "Claude Code 2.1.328 is installed, and Hivemind needs 2.1.329 or newer. Update Claude Code, or set the path to a newer one in Settings.");
        assert!(check_version("claude", says("1.0.0"), &checked).is_err(), "a refusal is not remembered, so an update is seen at once");
        assert!(check_version("claude", says("2.1.329 (Claude Code)"), &checked).is_ok(), "the minimum itself is allowed");
        // A program that passed is not asked again.
        assert!(check_version("claude", says("1.0.0"), &checked).is_ok());
        // Another path is checked on its own: a newer one, an unreadable one, and one that could not run.
        assert!(check_version("a", says("3.0.0"), &checked).is_ok());
        assert!(check_version("b", says("Claude Code, new format"), &checked).is_ok());
        assert!(check_version("c", |_: &str| None, &checked).is_ok());
        assert_eq!(*checked.lock().unwrap(), ["claude", "a", "b"], "a program that could not run is looked at again");
    }

    #[test]
    fn available_checks_the_version_of_the_program_it_found() {   // REG-31
        let dir = std::env::temp_dir().join(format!("hivemind-agent-version-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let program = |name: &str| {
            let path = dir.join(name);
            std::fs::write(&path, "").unwrap();
            Settings { claude_path: Some(path.display().to_string()), ..Default::default() }
        };
        let says = |text: Option<&str>| FAKE_VERSION.with(|fake| *fake.borrow_mut() = text.map(String::from));
        says(Some("2.1.300 (Claude Code)"));
        let refused = available(&program("old-claude")).unwrap_err();
        assert!(refused.contains("2.1.300") && refused.contains("2.1.329"), "{refused}");
        says(Some("2.1.329 (Claude Code)"));
        let found = available(&program("new-claude")).unwrap();
        assert!(found.ends_with("new-claude"), "{found}");
        says(Some("not a version"));
        assert!(available(&program("odd-claude")).is_ok());
        says(None);
        std::fs::remove_dir_all(dir).ok();
    }
}
