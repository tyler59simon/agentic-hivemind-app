//! What a session reports, normalised so the UI does not depend on one CLI's output format.
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    /// A turn is in progress.
    Running,
    /// A permission prompt awaits the user.
    Waiting,
    /// The last turn finished and the session can take another message, with or without a live process.
    Idle,
    Succeeded,
    Failed,
    Cancelled,
    /// The user ended an interactive session.
    Ended,
}

/// Unattended is the one-prompt run; interactive takes messages until it is ended.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    #[default]
    Unattended,
    Interactive,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Decision {
    Allow,
    AllowAlways,
    Deny,
    /// The CLI took the question back (its turn was interrupted); never sent by the user.
    Withdrawn,
}

/// How a turn ended. A field this document adds to `turnFinished`.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum TurnEnd {
    #[default]
    Completed,
    /// The user pressed Stop.
    Stopped,
    /// The process reached its spending limit.
    Budget,
    Error,
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
    /// Written by Hivemind when it sends a message. `text` is what the user typed; `context` the note refs sent with it.
    UserMessage {
        text: String,
        #[serde(default)]
        context: Vec<String>,
    },
    /// The CLI asks whether a tool call may run.
    ApprovalRequest {
        request_id: String,
        tool: String,
        summary: String,
        /// The tool's input, with every string cut to APPROVAL_INPUT characters.
        input: Value,
        can_always: bool,
        /// What "always" would allow, in words ("Bash(mkdir build)", "file edits and simple file commands in the worktree").
        #[serde(default)]
        always_label: Option<String>,
    },
    ApprovalResolved {
        request_id: String,
        decision: Decision,
    },
    /// Written by Hivemind at the end of every turn of an interactive session.
    TurnFinished {
        ok: bool,
        reason: Option<String>,
        cost_usd: Option<f64>,
        duration_ms: Option<u64>,
        result: Option<String>,
        denials: u64,
        #[serde(default)]
        outcome: TurnEnd,
    },
    /// Written by Hivemind: the worktree's diff against its base after a turn.
    FilesChanged {
        files: Vec<crate::worktree::FileChange>,
    },
    /// Written by Hivemind, once, as the last event of a session; adapters never produce it.
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
    /// The CLI stopped because the process reached `--max-budget-usd`.
    pub budget: bool,
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
    use crate::worktree::FileChange;
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
        let note = "paystream:6f0c1d2e-3b4a-4c5d-8e9f-0a1b2c3d4e5f";
        let user = RunEvent::UserMessage { text: "Add a retry ceiling flag to the replay tool.".into(), context: vec![note.into()] };
        let user_json = json!({"type": "userMessage", "text": "Add a retry ceiling flag to the replay tool.", "context": [note]});
        assert_eq!(shape(user.clone()), user_json);
        assert_eq!(serde_json::from_value::<RunEvent>(user_json).unwrap(), user);
        assert_eq!(
            serde_json::from_value::<RunEvent>(json!({"type": "userMessage", "text": "Hi"})).unwrap(),
            RunEvent::UserMessage { text: "Hi".into(), context: vec![] }
        );

        let request_id = "6c738ff4-3b35-4894-acec-1b2806f0b2f4";
        let request = RunEvent::ApprovalRequest {
            request_id: request_id.into(),
            tool: "Bash".into(),
            summary: "Create directory build".into(),
            input: json!({"command": "mkdir build", "description": "Create directory build"}),
            can_always: true,
            always_label: Some("Bash(mkdir build)".into()),
        };
        let request_json = json!({"type": "approvalRequest", "requestId": request_id, "tool": "Bash", "summary": "Create directory build",
            "input": {"command": "mkdir build", "description": "Create directory build"}, "canAlways": true, "alwaysLabel": "Bash(mkdir build)"});
        assert_eq!(shape(request.clone()), request_json);
        assert_eq!(serde_json::from_value::<RunEvent>(request_json).unwrap(), request);
        let unlabelled = json!({"type": "approvalRequest", "requestId": "r", "tool": "Read", "summary": "", "input": null, "canAlways": false});
        assert!(matches!(
            serde_json::from_value::<RunEvent>(unlabelled).unwrap(),
            RunEvent::ApprovalRequest { always_label: None, can_always: false, .. }
        ));

        let resolved = RunEvent::ApprovalResolved { request_id: request_id.into(), decision: Decision::Allow };
        let resolved_json = json!({"type": "approvalResolved", "requestId": request_id, "decision": "allow"});
        assert_eq!(shape(resolved.clone()), resolved_json);
        assert_eq!(serde_json::from_value::<RunEvent>(resolved_json).unwrap(), resolved);
        assert_eq!(serde_json::to_value(Decision::AllowAlways).unwrap(), json!("allow_always"));
        assert_eq!(serde_json::to_value(Decision::Withdrawn).unwrap(), json!("withdrawn"));

        let files = RunEvent::FilesChanged {
            files: vec![
                FileChange { path: "src/replay/tool.py".into(), status: "M".into(), added: 24, removed: 6, binary: false },
                FileChange { path: "tests/test_ceiling.py".into(), status: "A".into(), added: 18, removed: 0, binary: false },
            ],
        };
        let files_json = json!({"type": "filesChanged", "files": [
            {"path": "src/replay/tool.py", "status": "M", "added": 24, "removed": 6, "binary": false},
            {"path": "tests/test_ceiling.py", "status": "A", "added": 18, "removed": 0, "binary": false}]});
        assert_eq!(shape(files.clone()), files_json);
        assert_eq!(serde_json::from_value::<RunEvent>(files_json).unwrap(), files);

        let turn = RunEvent::TurnFinished {
            ok: true,
            reason: None,
            cost_usd: Some(0.04),
            duration_ms: Some(19800),
            result: Some("The flag is in place.".into()),
            denials: 0,
            outcome: TurnEnd::Completed,
        };
        let mut turn_json = json!({"type": "turnFinished", "ok": true, "reason": null, "costUsd": 0.04, "durationMs": 19800,
            "result": "The flag is in place.", "denials": 0, "outcome": "completed"});
        assert_eq!(shape(turn.clone()), turn_json);
        assert_eq!(serde_json::from_value::<RunEvent>(turn_json.clone()).unwrap(), turn);
        turn_json.as_object_mut().unwrap().remove("outcome");
        assert_eq!(serde_json::from_value::<RunEvent>(turn_json).unwrap(), turn, "a turn without `outcome` completed");
        for (outcome, text) in [(TurnEnd::Stopped, "stopped"), (TurnEnd::Budget, "budget"), (TurnEnd::Error, "error")] {
            assert_eq!(serde_json::to_value(outcome).unwrap(), json!(text));
        }

        for (status, text) in [(Status::Waiting, "waiting"), (Status::Idle, "idle"), (Status::Ended, "ended")] {
            assert_eq!(serde_json::to_value(status).unwrap(), json!(text));
        }
        assert_eq!(serde_json::to_value(Mode::Interactive).unwrap(), json!("interactive"));
        let ended = RunEvent::Finished {
            status: Status::Ended,
            reason: None,
            cost_usd: Some(0.11),
            duration_ms: None,
            turns: Some(3),
            result: None,
            structured: None,
            denials: 0,
        };
        assert_eq!(
            shape(ended),
            json!({"type": "finished", "status": "ended", "reason": null, "costUsd": 0.11, "durationMs": null, "turns": 3, "result": null,
                "structured": null, "denials": 0})
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
