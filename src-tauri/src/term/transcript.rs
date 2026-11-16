//! A terminal session's conversation as the Phase 2 events the chat view renders, built from the CLI's own file.
//!
//! Privacy: Claude Code's file also holds the system prompt, the account's email and ids, and raw API requests. Only
//! `user` and `assistant` records are read; every other record type is ignored by name. Codex's rollout holds injected
//! instructions, which are skipped.
use super::cli_files::parse_iso_ms;
use crate::agent::claude;
use crate::agent::events::{RunEvent, SeqEvent, TurnEnd, clip};
use serde_json::Value;
use std::collections::HashMap;

const SUMMARY: usize = 300;
const RESULT: usize = 500;

pub(super) fn text_of<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

/// A block the CLI injected into a user message: `<tag>` first and `</tag>` last.
pub(super) fn injected(text: &str) -> bool {
    let text = text.trim();
    let Some(rest) = text.strip_prefix('<') else { return false };
    let Some(end) = rest.find('>') else { return false };
    // The tag name ends at the first space: `<hook_prompt hook_run_id="...">` is Codex's hook text.
    let tag = rest[..end].split(' ').next().unwrap_or("");
    !tag.is_empty() && tag.chars().all(|c| c.is_ascii_lowercase() || c == '_' || c == '-') && text.ends_with(&format!("</{tag}>"))
}

struct Numbered {
    session_id: String,
    events: Vec<SeqEvent>,
}

impl Numbered {
    fn push(&mut self, at: u64, event: RunEvent) {
        let seq = self.events.len() as u64;
        self.events.push(SeqEvent { session_id: self.session_id.clone(), seq, at, event });
    }
}

fn stamp(record: &Value) -> u64 {
    text_of(record, "timestamp").and_then(parse_iso_ms).unwrap_or(0)
}

/// The text of a message's content: a string, or the `text` blocks of a list.
pub(super) fn message_text(content: Option<&Value>, kinds: &[&str]) -> String {
    match content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .filter(|block| text_of(block, "type").is_some_and(|kind| kinds.contains(&kind)))
            .filter_map(|block| text_of(block, "text"))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn is_denial(text: &str) -> bool {
    text.contains("hook error")
}

/// Claude Code's `~/.claude/projects/.../<id>.jsonl`.
pub fn claude(session_id: &str, file: &str) -> Vec<SeqEvent> {
    let mut out = Numbered { session_id: session_id.to_string(), events: Vec::new() };
    let mut tools: HashMap<String, String> = HashMap::new();
    for line in file.lines() {
        // A cheap test first: most of the file is records this view never reads.
        if !line.contains("\"user\"") && !line.contains("\"assistant\"") {
            continue;
        }
        let Ok(record) = serde_json::from_str::<Value>(line) else { continue };
        let kind = text_of(&record, "type");
        if !matches!(kind, Some("user" | "assistant")) || record.get("isSidechain").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        let at = stamp(&record);
        if kind == Some("assistant") {
            for event in claude::parse_line(line) {
                if let RunEvent::ToolUse { id, name, .. } = &event {
                    tools.insert(id.clone(), name.clone());
                }
                out.push(at, event);
            }
            continue;
        }
        if record.get("isMeta").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        let content = record.get("message").and_then(|m| m.get("content"));
        let text = message_text(content, &["text"]);
        if !text.trim().is_empty() && !injected(&text) {
            out.push(at, RunEvent::UserMessage { text, context: vec![] });
        }
        for event in claude::parse_line(line) {
            match event {
                RunEvent::ToolResult { id, ok: false, summary } if is_denial(&summary) => {
                    let tool = tools.get(&id).cloned().unwrap_or_default();
                    out.push(at, RunEvent::ToolResult { id, ok: false, summary: "Denied".into() });
                    out.push(at, RunEvent::Denied { tool, summary });
                }
                other => out.push(at, other),
            }
        }
    }
    out.events
}

/// What a Codex tool call's arguments show: the command for a shell call, else the text, cut short.
fn call_summary(arguments: Option<&Value>) -> String {
    let parsed = match arguments {
        Some(Value::String(text)) => serde_json::from_str::<Value>(text).unwrap_or_else(|_| Value::String(text.clone())),
        Some(other) => other.clone(),
        None => return String::new(),
    };
    let shown = match parsed.get("command").or_else(|| parsed.get("cmd")) {
        Some(Value::Array(parts)) => parts.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(" "),
        Some(Value::String(text)) => text.clone(),
        _ => match &parsed {
            Value::String(text) => text.clone(),
            other => other.to_string(),
        },
    };
    clip(&shown, SUMMARY)
}

/// A Codex tool output is plain text, or JSON text `{"output": ..., "metadata": {"exit_code": n}}`, or an object.
fn output_result(output: Option<&Value>) -> (bool, String) {
    let parsed = match output {
        Some(Value::String(text)) => serde_json::from_str::<Value>(text).ok().filter(Value::is_object),
        Some(object @ Value::Object(_)) => Some(object.clone()),
        _ => None,
    };
    let Some(object) = parsed else {
        return (true, clip(output.and_then(Value::as_str).unwrap_or_default(), RESULT));
    };
    let text = ["output", "content"].iter().find_map(|key| text_of(&object, key)).unwrap_or_default();
    let code = object.get("metadata").and_then(|m| m.get("exit_code")).and_then(Value::as_i64);
    let success = object.get("success").and_then(Value::as_bool);
    (code.is_none_or(|c| c == 0) && success != Some(false), clip(text, RESULT))
}

/// Codex's `~/.codex/sessions/.../rollout-*.jsonl`.
pub fn codex(session_id: &str, file: &str) -> Vec<SeqEvent> {
    let mut out = Numbered { session_id: session_id.to_string(), events: Vec::new() };
    for line in file.lines() {
        let Ok(record) = serde_json::from_str::<Value>(line) else { continue };
        let at = stamp(&record);
        let payload = &record["payload"];
        match (text_of(&record, "type"), text_of(payload, "type")) {
            (Some("response_item"), Some("message")) => match text_of(payload, "role") {
                Some("user") => {
                    let text = message_text(payload.get("content"), &["input_text", "text"]);
                    if !text.trim().is_empty() && !text.trim_start().starts_with("# AGENTS.md instructions") && !injected(&text) {
                        out.push(at, RunEvent::UserMessage { text, context: vec![] });
                    }
                }
                Some("assistant") => {
                    let text = message_text(payload.get("content"), &["output_text", "text"]);
                    if !text.trim().is_empty() {
                        out.push(at, RunEvent::Text { text });
                    }
                }
                _ => {}
            },
            (Some("response_item"), Some("function_call")) => out.push(
                at,
                RunEvent::ToolUse {
                    id: text_of(payload, "call_id").unwrap_or_default().to_string(),
                    name: text_of(payload, "name").unwrap_or_default().to_string(),
                    summary: call_summary(payload.get("arguments")),
                },
            ),
            (Some("response_item"), Some("custom_tool_call")) => out.push(
                at,
                RunEvent::ToolUse {
                    id: text_of(payload, "call_id").unwrap_or_default().to_string(),
                    name: text_of(payload, "name").unwrap_or_default().to_string(),
                    summary: call_summary(payload.get("input")),
                },
            ),
            (Some("response_item"), Some("function_call_output" | "custom_tool_call_output")) => {
                let (ok, summary) = output_result(payload.get("output"));
                out.push(at, RunEvent::ToolResult { id: text_of(payload, "call_id").unwrap_or_default().to_string(), ok, summary });
            }
            (Some("event_msg"), Some("task_complete")) => out.push(
                at,
                RunEvent::TurnFinished {
                    ok: true,
                    reason: None,
                    cost_usd: None,
                    duration_ms: payload.get("duration_ms").and_then(Value::as_u64),
                    result: text_of(payload, "last_agent_message").map(str::to_string),
                    denials: 0,
                    outcome: TurnEnd::Completed,
                },
            ),
            _ => {}
        }
    }
    out.events
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn lines(records: &[Value]) -> String {
        records.iter().map(Value::to_string).collect::<Vec<_>>().join("\n")
    }

    fn kinds(events: &[SeqEvent]) -> Vec<&'static str> {
        events
            .iter()
            .map(|e| match &e.event {
                RunEvent::UserMessage { .. } => "user",
                RunEvent::Text { .. } => "text",
                RunEvent::ToolUse { .. } => "use",
                RunEvent::ToolResult { .. } => "result",
                RunEvent::Denied { .. } => "denied",
                RunEvent::TurnFinished { .. } => "turn",
                _ => "other",
            })
            .collect()
    }

    fn claude_file() -> String {
        lines(&[
            json!({"type": "permission-mode", "permissionMode": "default"}),
            json!({"type": "attachment", "attachment": {"type": "prompt_snapshot", "content": "SYSTEM PROMPT SECRET"}}),
            json!({"type": "attachment", "attachment": {"type": "session_context", "email": "someone@example.com"}}),
            json!({"type": "session-owner", "accountUuid": "acct-123"}),
            json!({"type": "api-request", "body": {"messages": [{"role": "user", "content": "RAW API BODY"}]}}),
            json!({"type": "api-request-blob", "blob": "BLOB assistant user"}),
            json!({"type": "user", "isMeta": true, "message": {"role": "user", "content": "<local-command-caveat>meta</local-command-caveat>"}}),
            json!({"type": "user", "timestamp": "2026-11-15T10:00:00.000Z", "message": {"role": "user", "content": "Fix the importer"}}),
            json!({"type": "user", "message": {"role": "user", "content": [{"type": "text", "text": "<system-reminder>hook context</system-reminder>"}]}}),
            json!({"type": "assistant", "timestamp": "2026-11-15T10:00:05.000Z", "message": {"role": "assistant", "content": [
                {"type": "thinking", "thinking": "hmm"},
                {"type": "text", "text": "Looking at it."},
                {"type": "tool_use", "id": "toolu_1", "name": "Bash", "input": {"command": "rm -rf build"}},
            ]}}),
            json!({"type": "user", "message": {"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": "toolu_1", "is_error": true, "content": "PreToolUse:Bash hook error: blocked by policy"},
            ]}}),
            json!({"type": "assistant", "message": {"role": "assistant", "content": [{"type": "tool_use", "id": "toolu_2", "name": "Read", "input": {"file_path": "a.rs"}}]}}),
            json!({"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "toolu_2", "content": "file text"}]}}),
            json!({"type": "assistant", "isSidechain": true, "message": {"role": "assistant", "content": [{"type": "text", "text": "SIDE CHAIN"}]}}),
            json!({"type": "ai-title", "aiTitle": "Fix importer"}),
            json!({"type": "cost-state", "totalCostUSD": 0.5}),
        ])
    }

    #[test]
    fn a_claude_transcript_reads_user_and_assistant_records_only() {
        let events = claude("s1", &claude_file());
        assert_eq!(kinds(&events), ["user", "text", "use", "result", "denied", "use", "result"]);
        assert_eq!(events.iter().map(|e| e.seq).collect::<Vec<_>>(), (0..7).collect::<Vec<u64>>());
        assert!(matches!(&events[0].event, RunEvent::UserMessage { text, .. } if text == "Fix the importer"));
        assert_eq!(events[0].at, 1_794_736_800_000);
        assert!(matches!(&events[3].event, RunEvent::ToolResult { id, ok: false, summary } if id == "toolu_1" && summary == "Denied"));
        assert!(matches!(&events[4].event, RunEvent::Denied { tool, summary } if tool == "Bash" && summary.contains("blocked by policy")));
        assert!(matches!(&events[6].event, RunEvent::ToolResult { ok: true, .. }));
    }

    #[test]
    fn nothing_private_reaches_the_claude_transcript() {
        let shown = serde_json::to_string(&claude("s1", &claude_file())).unwrap();
        for secret in ["someone@example.com", "acct-123", "SYSTEM PROMPT SECRET", "RAW API BODY", "BLOB", "SIDE CHAIN", "hook context", "meta"] {
            assert!(!shown.contains(secret), "{secret} leaked");
        }
    }

    fn codex_file() -> String {
        lines(&[
            json!({"type": "session_meta", "payload": {"id": "t1", "cwd": "C:\\x", "timestamp": "2026-11-15T10:00:00.000Z"}}),
            json!({"type": "response_item", "payload": {"type": "message", "role": "developer", "content": [{"type": "input_text", "text": "DEVELOPER RULES"}]}}),
            json!({"type": "response_item", "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "# AGENTS.md instructions for C:\\x\n\n<INSTRUCTIONS>\nbe nice\n</INSTRUCTIONS>"}]}}),
            json!({"type": "response_item", "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "<environment_context>\n<cwd>C:\\x</cwd>\n</environment_context>"}]}}),
            json!({"type": "response_item", "payload": {"type": "additional_tools", "tools": []}}),
            json!({"type": "world_state", "payload": {"type": "x"}}),
            json!({"type": "response_item", "timestamp": "2026-11-15T10:00:01.000Z", "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "List the files"}]}}),
            json!({"type": "response_item", "payload": {"type": "reasoning", "encrypted_content": "ENCRYPTED"}}),
            json!({"type": "response_item", "payload": {"type": "function_call", "name": "shell", "call_id": "c1", "arguments": "{\"command\":[\"powershell\",\"-Command\",\"ls\"]}"}}),
            json!({"type": "response_item", "payload": {"type": "function_call_output", "call_id": "c1", "output": "{\"output\":\"a.txt\",\"metadata\":{\"exit_code\":0}}"}}),
            json!({"type": "response_item", "payload": {"type": "custom_tool_call", "name": "apply_patch", "call_id": "c2", "input": "*** Begin Patch"}}),
            json!({"type": "response_item", "payload": {"type": "custom_tool_call_output", "call_id": "c2", "output": "{\"output\":\"failed\",\"metadata\":{\"exit_code\":1}}"}}),
            json!({"type": "response_item", "payload": {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "Two files."}]}}),
            json!({"type": "event_msg", "payload": {"type": "token_count", "info": {}}}),
            json!({"type": "event_msg", "payload": {"type": "task_complete", "last_agent_message": "Two files."}}),
        ])
    }

    #[test]
    fn a_codex_transcript_skips_injected_content_and_pairs_calls_with_outputs() {
        let events = codex("s2", &codex_file());
        assert_eq!(kinds(&events), ["user", "use", "result", "use", "result", "text", "turn"]);
        assert!(matches!(&events[0].event, RunEvent::UserMessage { text, .. } if text == "List the files"));
        assert!(matches!(&events[1].event, RunEvent::ToolUse { id, name, summary } if id == "c1" && name == "shell" && summary == "powershell -Command ls"));
        assert!(matches!(&events[2].event, RunEvent::ToolResult { id, ok: true, summary } if id == "c1" && summary == "a.txt"));
        assert!(matches!(&events[4].event, RunEvent::ToolResult { id, ok: false, .. } if id == "c2"));
        let shown = serde_json::to_string(&events).unwrap();
        for hidden in ["DEVELOPER RULES", "AGENTS.md", "environment_context", "ENCRYPTED", "be nice"] {
            assert!(!shown.contains(hidden), "{hidden}");
        }
    }

    #[test]
    fn only_a_whole_tagged_block_counts_as_injected() {
        assert!(injected("<system-reminder>x</system-reminder>"));
        assert!(injected("<environment_context>\n<cwd>a</cwd>\n</environment_context>\n"));
        assert!(injected("<hook_prompt hook_run_id=\"stop:5:C:\\x\\hooks.json\">Living Memory: ...</hook_prompt>"));
        assert!(!injected("<div> fix this"));
        assert!(!injected("Use <b>bold</b>"));
        assert!(!injected("plain"));
    }
}
