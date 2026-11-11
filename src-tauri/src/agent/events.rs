//! What a session reports, normalised so the UI does not depend on one CLI's output format.
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Running,
    Succeeded,
    Failed,
    Cancelled,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum RunEvent {
    Started {
        model: Option<String>,
        cli_version: Option<String>,
        plugins: Vec<String>,
    },
    Text {
        text: String,
    },
    ToolUse {
        id: String,
        name: String,
        summary: String,
    },
    ToolResult {
        id: String,
        ok: bool,
        summary: String,
    },
    Denied {
        tool: String,
        summary: String,
    },
    /// Written by Hivemind, once, when the process has exited; adapters never produce it.
    Finished {
        status: Status,
        reason: Option<String>,
        cost_usd: Option<f64>,
        duration_ms: Option<u64>,
        turns: Option<u64>,
        result: Option<String>,
        structured: Option<Value>,
        denials: u64,
    },
}

/// One event with its place in the session: `seq` counts from 0 without gaps.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SeqEvent {
    pub session_id: String,
    pub seq: u64,
    pub at: u64,
    pub event: RunEvent,
}

/// What a CLI's own closing report says. A session can print several; the last one counts.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Outcome {
    pub ok: bool,
    /// Why it failed, in words a user can read; None when `ok`.
    pub reason: Option<String>,
    pub cost_usd: Option<f64>,
    pub duration_ms: Option<u64>,
    pub turns: Option<u64>,
    pub result: Option<String>,
    pub structured: Option<Value>,
    pub denials: u64,
}

/// Shorten to at most `max` characters, ending in an ellipsis when something was cut.
pub fn clip(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max - 1).collect();
    out.push('…');
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The webview is written against these exact names.
    #[test]
    fn events_serialise_in_the_contract_shape() {
        let shape = |event: RunEvent| serde_json::to_value(event).unwrap();
        assert_eq!(
            shape(RunEvent::Started { model: None, cli_version: Some("2.1.321".into()), plugins: vec!["architecture-suite".into()] }),
            json!({"type": "started", "model": null, "cliVersion": "2.1.321", "plugins": ["architecture-suite"]})
        );
        assert_eq!(shape(RunEvent::Text { text: "Hello".into() }), json!({"type": "text", "text": "Hello"}));
        assert_eq!(
            shape(RunEvent::ToolUse { id: "toolu_01".into(), name: "Bash".into(), summary: "git log".into() }),
            json!({"type": "toolUse", "id": "toolu_01", "name": "Bash", "summary": "git log"})
        );
        assert_eq!(
            shape(RunEvent::ToolResult { id: "toolu_01".into(), ok: false, summary: "No such file".into() }),
            json!({"type": "toolResult", "id": "toolu_01", "ok": false, "summary": "No such file"})
        );
        assert_eq!(
            shape(RunEvent::Denied { tool: "Bash".into(), summary: "Not allowed".into() }),
            json!({"type": "denied", "tool": "Bash", "summary": "Not allowed"})
        );
        let finished = RunEvent::Finished {
            status: Status::Cancelled,
            reason: None,
            cost_usd: Some(0.5),
            duration_ms: Some(4670),
            turns: Some(3),
            result: Some("Done.".into()),
            structured: Some(json!({"summary": "Billing takes payments."})),
            denials: 1,
        };
        let expected = json!({"type": "finished", "status": "cancelled", "reason": null, "costUsd": 0.5, "durationMs": 4670, "turns": 3,
            "result": "Done.", "structured": {"summary": "Billing takes payments."}, "denials": 1});
        assert_eq!(shape(finished.clone()), expected);
        assert_eq!(serde_json::from_value::<RunEvent>(expected).unwrap(), finished);
        let numbered = SeqEvent {
            session_id: "00000000-0000-4000-8000-000000000001".into(),
            seq: 2,
            at: 1_700_000_000_000,
            event: RunEvent::Text { text: "Hi".into() },
        };
        assert_eq!(
            serde_json::to_value(numbered).unwrap(),
            json!({"sessionId": "00000000-0000-4000-8000-000000000001", "seq": 2, "at": 1_700_000_000_000u64, "event": {"type": "text", "text": "Hi"}})
        );
    }
}
