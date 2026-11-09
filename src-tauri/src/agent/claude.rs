//! Claude Code in headless mode: one JSON object per stdout line, the prompt as one JSON line on stdin.
use super::Adapter;
use super::events::{Outcome, RunEvent, clip};
use super::scope::{Policy, Spec};
use crate::settings::Settings;
use serde_json::{Value, json};
use std::path::Path;
use std::process::Command;
use std::time::Duration;

const TOOL_SUMMARY: usize = 300;
const RESULT_SUMMARY: usize = 500;
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
fn result_summary(content: Option<&Value>) -> String {
    let text = match content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => parts.iter().filter_map(|part| text_of(part, "text")).collect::<Vec<_>>().join("\n"),
        _ => String::new(),
    };
    clip(&text, RESULT_SUMMARY)
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

impl Adapter for ClaudeCode {
    fn name(&self) -> &'static str {
        "claude-code"
    }

    fn command(&self, spec: &Spec) -> Command {
        let mut command = Command::new(&spec.program);
        command.current_dir(&spec.cwd).args(["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"]);
        let Policy::PreApproved { allow } = &spec.policy;
        command.args(["--permission-mode", "dontAsk", "--permission-prompts", "none"]);
        command.args(["--session-id", &spec.session_id, "--max-budget-usd", &spec.budget_usd.to_string()]);
        if let Some(schema) = &spec.schema {
            command.arg("--json-schema").arg(schema.to_string());
        }
        if !allow.is_empty() {
            command.arg("--allowedTools").args(allow);
        }
        if !spec.add_dirs.is_empty() {
            command.arg("--add-dir").args(&spec.add_dirs);
        }
        for dir in &spec.plugin_dirs {
            command.arg("--plugin-dir").arg(dir);
        }
        command
    }

    fn first_message(&self, prompt: &str) -> String {
        json!({"type": "user", "message": {"role": "user", "content": [{"type": "text", "text": prompt}]}}).to_string()
    }

    fn parse_line(&self, line: &str) -> Vec<RunEvent> {
        let Ok(value) = serde_json::from_str::<Value>(line) else { return vec![] };
        match (text_of(&value, "type"), text_of(&value, "subtype")) {
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

    fn outcome(&self, line: &str) -> Option<Outcome> {
        let value: Value = serde_json::from_str(line).ok()?;
        if text_of(&value, "type") != Some("result") {
            return None;
        }
        let subtype = text_of(&value, "subtype").unwrap_or_default();
        let result = text_of(&value, "result");
        let ok = subtype == "success" && value.get("is_error").and_then(Value::as_bool) != Some(true);
        Some(Outcome {
            ok,
            reason: (!ok).then(|| failure(subtype, result)),
            cost_usd: value.get("total_cost_usd").and_then(Value::as_f64),
            duration_ms: value.get("duration_ms").and_then(Value::as_u64),
            turns: value.get("num_turns").and_then(Value::as_u64),
            result: result.map(str::to_string),
            structured: value.get("structured_output").filter(|s| !s.is_null()).cloned(),
            denials: value.get("permission_denials").and_then(Value::as_array).map_or(0, |all| all.len() as u64),
        })
    }
}

/// The CLI to launch: the saved path, else the native installer's place, else `claude` on PATH.
/// `on_path` says whether the bare name runs; it is a parameter so tests never start the real CLI.
pub fn locate(saved: &Settings, home: &Path, on_path: impl Fn() -> bool) -> Result<String, String> {
    if let Some(path) = saved.claude_path.as_deref().map(str::trim).filter(|path| Path::new(path).is_file()) {
        return Ok(path.to_string());
    }
    let installed = home.join(".local").join("bin").join(if cfg!(windows) { "claude.exe" } else { "claude" });
    if installed.is_file() {
        return Ok(installed.display().to_string());
    }
    if on_path() {
        return Ok("claude".into());
    }
    Err("Claude Code was not found. Install it, or set the path to its program in Settings.".into())
}

pub fn available(saved: &Settings) -> Result<String, String> {
    let home = dirs::home_dir().ok_or("Could not find your home folder")?;
    locate(saved, &home, || {
        let mut command = Command::new("claude");
        command.arg("--version");
        crate::git::run_with_timeout(command, Duration::from_secs(5)).is_ok()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn parse(line: &str) -> Vec<RunEvent> {
        ClaudeCode.parse_line(line)
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
            assert_eq!(ClaudeCode.outcome(line), None, "{line}");
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
        let done = ClaudeCode
            .outcome(
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
            }
        );
        let over = ClaudeCode
            .outcome(
                r#"{"type":"result","subtype":"error_max_budget_usd","is_error":false,"total_cost_usd":5.02,"structured_output":null}"#,
            )
            .unwrap();
        assert!(!over.ok);
        assert_eq!(over.reason.as_deref(), Some("Claude Code reached the budget limit for this session"));
        assert_eq!((over.cost_usd, over.structured, over.denials), (Some(5.02), None, 0));
        let flagged =
            ClaudeCode.outcome(r#"{"type":"result","subtype":"success","is_error":true,"result":"Credit balance is too low"}"#).unwrap();
        assert_eq!(flagged.reason.as_deref(), Some("Claude Code reported an error: Credit balance is too low"));
        let new = ClaudeCode.outcome(r#"{"type":"result","subtype":"error_something_new"}"#).unwrap();
        assert_eq!(new.reason.as_deref(), Some("Claude Code stopped (error something new)"));
    }

    #[test]
    fn command_carries_the_spec() {
        let spec = Spec {
            session_id: "00000000-0000-4000-8000-000000000001".into(),
            cwd: PathBuf::from("/work/app"),
            add_dirs: vec![PathBuf::from("/work/api"), PathBuf::from("/work/arch")],
            policy: Policy::PreApproved { allow: vec!["Edit(//work/arch/**)".into(), "Bash(*architecture-suite.py *)".into()] },
            plugin_dirs: vec![PathBuf::from("/plugins/suite")],
            budget_usd: 5.0,
            schema: Some(json!({"type": "object"})),
            program: "claude".into(),
        };
        let command = ClaudeCode.command(&spec);
        let args: Vec<String> = command.get_args().map(|arg| arg.to_string_lossy().into_owned()).collect();
        #[rustfmt::skip]
        let expected = [
            "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
            "--permission-mode", "dontAsk", "--permission-prompts", "none",
            "--session-id", "00000000-0000-4000-8000-000000000001", "--max-budget-usd", "5", "--json-schema", r#"{"type":"object"}"#,
            "--allowedTools", "Edit(//work/arch/**)", "Bash(*architecture-suite.py *)",
            "--add-dir", "/work/api", "/work/arch", "--plugin-dir", "/plugins/suite",
        ];
        assert_eq!(args, expected);
        assert_eq!(command.get_program(), "claude");
        assert_eq!(command.get_current_dir(), Some(Path::new("/work/app")));
        let line = ClaudeCode.first_message("Say \"hi\"\nthen stop");
        assert!(!line.contains('\n'), "one line on stdin");
        assert_eq!(
            serde_json::from_str::<Value>(&line).unwrap(),
            json!({"type": "user", "message": {"role": "user", "content": [{"type": "text", "text": "Say \"hi\"\nthen stop"}]}})
        );
    }

    #[test]
    fn finds_the_cli_in_order() {
        let home = std::env::temp_dir().join(format!("hivemind-agent-locate-{}", std::process::id()));
        let bin = home.join(".local").join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let nothing = Settings::default();
        assert_eq!(locate(&nothing, &home, || true).unwrap(), "claude");
        assert!(locate(&nothing, &home, || false).unwrap_err().contains("Settings"));

        let installed = bin.join(if cfg!(windows) { "claude.exe" } else { "claude" });
        std::fs::write(&installed, "").unwrap();
        assert_eq!(locate(&nothing, &home, || false).unwrap(), installed.display().to_string());

        let chosen = home.join("my-claude");
        std::fs::write(&chosen, "").unwrap();
        let saved = |path: &Path| Settings { claude_path: Some(path.display().to_string()), ..Default::default() };
        assert_eq!(locate(&saved(&chosen), &home, || false).unwrap(), chosen.display().to_string());
        // A saved path that is not there falls through to the next place.
        assert_eq!(locate(&saved(&home.join("gone")), &home, || false).unwrap(), installed.display().to_string());
        std::fs::remove_dir_all(home).ok();
    }
}
