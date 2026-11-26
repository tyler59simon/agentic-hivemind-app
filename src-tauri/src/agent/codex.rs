//! Codex through `codex app-server` on stdio: JSON-RPC lines both ways, one process per session.
use super::claude::GOVERNED;
use super::events::{Decision, Outcome, RunEvent, clip};
use super::scope::{PolicyMode, Spec, governed_memory_command};
use super::{Adapter, Driver, Step};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;

/// The oldest `codex` whose app-server lines this driver was written against.
const MIN_VERSION: (u32, u32, u32) = (0, 166, 0);
const UNSUPPORTED: &str = "This Codex version is not supported for Chat. Use Terminal.";
const UNANSWERABLE: &str = "Hivemind cannot answer this kind of request.";
const DECLINED: &str = "Declined";
const TOOL_SUMMARY: usize = 300;
const RESULT_SUMMARY: usize = 500;
const APPROVAL_INPUT: usize = 4000;
/// The ids of the two requests every process starts with; the ones after them count up from `FIRST_TURN_ID`.
const HANDSHAKE_ID: u64 = 1;
const THREAD_ID: u64 = 2;
const FIRST_TURN_ID: u64 = 3;

pub struct Codex;

impl Adapter for Codex {
    fn name(&self) -> &'static str {
        "codex"
    }

    /// `<program> [program_args] app-server` in the worktree. Never `daemon`, `proxy` or `--listen`.
    /// No budget flag, no model flag, no allow rules: none of them exist for Codex (the model goes in `thread/start`).
    /// The CLI's hooks, Living Memory's included, run inside the server, so they get the store and the session id as in a
    /// terminal session.
    fn command(&self, spec: &Spec) -> Command {
        let mut command = Command::new(&spec.program);
        command.current_dir(&spec.cwd).args(&spec.program_args).arg("app-server").env("HIVEMIND_SESSION", &spec.session_id);
        if let Some(root) = &spec.memory_root {
            command.env("LIVING_MEMORY_ROOT", root);
        }
        command
    }

    fn driver(&self, cwd: &Path, policy: PolicyMode, engine_session: Option<&str>, model: Option<&str>) -> Box<dyn Driver> {
        Box::new(CodexDriver::new(cwd, policy, engine_session, model))
    }

    fn tool_result(&self, line: &str, tool_use_id: &str) -> Option<(bool, String)> {
        let value: Value = serde_json::from_str(line).ok()?;
        if text_of(&value, "method") != Some("item/completed") {
            return None;
        }
        let item = value.pointer("/params/item")?;
        if text_of(item, "type") != Some("commandExecution") || text_of(item, "id") != Some(tool_use_id) {
            return None;
        }
        Some((command_ok(item), text_of(item, "aggregatedOutput").unwrap_or_default().to_string()))
    }

    fn marks_process_start(&self) -> bool {
        true
    }
}

/// The version in an `initialize` result's `userAgent` ("hivemind/0.169.0 (...)"), as (major, minor, patch).
pub fn agent_version(user_agent: &str) -> Option<(u32, u32, u32)> {
    let version = user_agent.split_whitespace().next()?.rsplit_once('/')?.1;
    let mut parts = version.split('.').map(|part| part.chars().take_while(char::is_ascii_digit).collect::<String>().parse::<u32>().ok());
    Some((parts.next()??, parts.next()??, parts.next()??))
}

fn text_of<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn command_ok(item: &Value) -> bool {
    text_of(item, "status") == Some("completed") && item.get("exitCode").and_then(Value::as_i64) == Some(0)
}

/// What the user sees of a command: Codex's own reading of it when it has one, else the whole command line.
fn command_summary(source: &Value) -> String {
    let action = source.pointer("/commandActions/0/command").and_then(Value::as_str).filter(|text| !text.trim().is_empty());
    clip(action.or_else(|| text_of(source, "command")).unwrap_or_default(), TOOL_SUMMARY)
}

fn error_message(error: &Value, fallback: &str) -> String {
    text_of(error, "message").map_or_else(|| fallback.to_string(), str::to_string)
}

/// The reply to a server request that asks whether something may run.
fn decision_line(id: &Value, decision: &str) -> String {
    json!({"id": id, "result": {"decision": decision}}).to_string()
}

static NULL: Value = Value::Null;

/// What the driver keeps of an `item/started` line: the approval request that follows carries only the item's id.
enum Item {
    Command { summary: String },
    Edit { summary: String, changes: Vec<Value> },
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum State {
    /// No process was started yet.
    NoProcess,
    /// `initialize` is written; its reply is awaited.
    Handshake,
    /// `thread/start` or `thread/resume` is written; its reply is awaited.
    Starting,
    /// A thread is open and no turn is running.
    Ready,
    Turn,
    /// The process cannot be used for Chat (an old version, or it refused the thread).
    Failed,
}

/// The Codex conversation of one session. The thread id outlives processes; everything else is forgotten at each
/// `processStarted`. Events and states change in `read` and `note` only (the replay rule); `kept`, `next_id` and
/// the `Handshake` and `Starting` ids only decide what is written.
pub struct CodexDriver {
    cwd: PathBuf,
    policy: PolicyMode,
    /// The model the user picked; left out of the thread request when there is none.
    model: Option<String>,
    state: State,
    thread: Option<String>,
    turn: Option<String>,
    next_id: u64,
    /// The id of the `turn/start` written last, until Codex answers it or starts the turn.
    pending_turn: Option<u64>,
    /// A message sent before the thread was open, written as `turn/start` once it is.
    kept: Option<String>,
    /// Stop was pressed before the turn had an id: `turn/interrupt` is written as soon as `turn/started` names it.
    stop_asked: bool,
    items: HashMap<String, Item>,
    /// Approval requests not yet answered, in the order they arrived: item id and the server's request id.
    open: Vec<(String, Value)>,
    last_text: Option<String>,
    last_answer: Option<String>,
    declined: u64,
}

impl CodexDriver {
    fn new(cwd: &Path, policy: PolicyMode, engine_session: Option<&str>, model: Option<&str>) -> CodexDriver {
        CodexDriver {
            cwd: cwd.to_path_buf(),
            policy,
            model: model.map(str::to_string),
            state: State::NoProcess,
            thread: engine_session.map(str::to_string),
            turn: None,
            next_id: FIRST_TURN_ID,
            pending_turn: None,
            kept: None,
            stop_asked: false,
            items: HashMap::new(),
            open: Vec::new(),
            last_text: None,
            last_answer: None,
            declined: 0,
        }
    }

    /// A process was started: forget everything that belonged to the one before.
    fn begin(&mut self) {
        self.state = State::Handshake;
        self.turn = None;
        self.next_id = FIRST_TURN_ID;
        self.pending_turn = None;
        self.kept = None;
        self.stop_asked = false;
        self.items.clear();
        self.open.clear();
        self.last_text = None;
        self.last_answer = None;
        self.declined = 0;
    }

    /// This process cannot be used: the turn fails with `reason` and the manager ends the process.
    fn fail(&mut self, reason: String) -> Step {
        self.state = State::Failed;
        Step { turn: Some(Outcome { ok: false, reason: Some(reason), ..Outcome::default() }), end_process: true, ..Step::default() }
    }

    /// Codex's approval policy and sandbox for the session's permission mode.
    fn permissions(&self) -> (&'static str, &'static str) {
        match self.policy {
            PolicyMode::Ask => ("untrusted", "workspace-write"),
            PolicyMode::AcceptEdits => ("on-request", "workspace-write"),
            PolicyMode::PreApproved => ("never", "read-only"),
        }
    }

    /// `thread/start`, or `thread/resume` once the session has a thread. Without a picked model the user's default applies.
    fn thread_request(&self) -> String {
        let (approval, sandbox) = self.permissions();
        let mut params = json!({"cwd": self.cwd.display().to_string(), "approvalPolicy": approval, "sandbox": sandbox});
        if let Some(model) = &self.model {
            params["model"] = json!(model);
        }
        let method = match &self.thread {
            Some(thread) => {
                params["threadId"] = json!(thread);
                params["excludeTurns"] = json!(true);
                "thread/resume"
            }
            None => "thread/start",
        };
        json!({"method": method, "id": THREAD_ID, "params": params}).to_string()
    }

    fn client_request(&mut self, method: &str, params: Value) -> String {
        let id = self.next_id;
        self.next_id += 1;
        json!({"method": method, "id": id, "params": params}).to_string()
    }

    fn turn_start(&mut self, text: &str) -> String {
        let thread = self.thread.clone();
        self.pending_turn = Some(self.next_id);
        self.client_request("turn/start", json!({"threadId": thread, "input": [{"type": "text", "text": text}]}))
    }

    /// The reply to the `turn/start` written last. A refusal ends the turn the way `turn/completed` does, with its message
    /// as the reason; otherwise `turn/started` follows.
    fn turn_replied(&mut self, value: &Value) -> Step {
        self.pending_turn = None;
        let Some(error) = value.get("error") else {
            // The reply names the turn, and on 0.169.0 it can come before `turn/started`: a Stop in between can be sent at once.
            if let Some(turn) = value.pointer("/result/turn/id").and_then(Value::as_str) {
                self.turn = Some(turn.to_string());
            }
            return self.stop_if_asked();
        };
        self.stop_asked = false;
        let reason = error_message(error, "Codex did not accept the message");
        let events = self.close_requests();
        self.state = State::Ready;
        self.turn = None;
        Step { events, turn: Some(Outcome { ok: false, reason: Some(reason), ..Outcome::default() }), ..Step::default() }
    }

    /// The requests still open when a turn ends are withdrawn.
    fn close_requests(&mut self) -> Vec<RunEvent> {
        self.open.drain(..).map(|(item, _)| RunEvent::ApprovalResolved { request_id: item, decision: Decision::Withdrawn }).collect()
    }

    /// The path as the user knows it: relative to the worktree when it is inside it.
    fn relative(&self, path: &str) -> String {
        let root = self.cwd.to_string_lossy().replace('\\', "/");
        let root = root.trim_end_matches('/');
        let full = path.replace('\\', "/");
        match full.get(..root.len()) {
            Some(head) if !root.is_empty() && head.eq_ignore_ascii_case(root) && full[root.len()..].starts_with('/') => {
                full[root.len() + 1..].to_string()
            }
            _ => path.to_string(),
        }
    }

    fn handshake(&mut self, value: &Value) -> Step {
        if let Some(error) = value.get("error") {
            return self.fail(error_message(error, "Codex did not accept the connection"));
        }
        let Some(result) = value.get("result") else { return Step::default() };
        let version = text_of(result, "userAgent").and_then(agent_version);
        if version.is_some_and(|found| found < MIN_VERSION) {
            return self.fail(UNSUPPORTED.into());
        }
        self.state = State::Starting;
        Step { write: vec![json!({"method": "initialized"}).to_string(), self.thread_request()], ..Step::default() }
    }

    fn thread_opened(&mut self, value: &Value) -> Step {
        if let Some(error) = value.get("error") {
            return self.fail(error_message(error, "Codex could not open the conversation"));
        }
        let Some(result) = value.get("result") else { return Step::default() };
        let Some(thread) = result.pointer("/thread/id").and_then(Value::as_str) else {
            return self.fail("Codex did not report a conversation id".into());
        };
        let engine_session = (self.thread.as_deref() != Some(thread)).then(|| thread.to_string());
        self.thread = Some(thread.to_string());
        self.state = State::Ready;
        let write = self.kept.take().map(|text| self.turn_start(&text)).into_iter().collect();
        let started = RunEvent::Started {
            model: text_of(result, "model").map(str::to_string),
            cli_version: result.pointer("/thread/cliVersion").and_then(Value::as_str).map(str::to_string),
            plugins: vec![],
        };
        Step { write, events: vec![started], engine_session, ..Step::default() }
    }

    /// A request from the server: only the two approval kinds can be answered.
    fn request(&mut self, method: &str, id: &Value, params: &Value) -> Step {
        let item = text_of(params, "itemId");
        match (method, item) {
            ("item/commandExecution/requestApproval", Some(item)) => self.command_request(id, item, params),
            ("item/fileChange/requestApproval", Some(item)) => self.edit_request(id, item, params),
            _ => Step {
                write: vec![json!({"id": id, "error": {"code": -32601, "message": "Not supported by Hivemind"}}).to_string()],
                events: vec![RunEvent::Denied { tool: method.to_string(), summary: UNANSWERABLE.into() }],
                ..Step::default()
            },
        }
    }

    fn command_request(&mut self, id: &Value, item: &str, params: &Value) -> Step {
        let command = text_of(params, "command").unwrap_or_default();
        let summary = match self.items.get(item) {
            Some(Item::Command { summary }) => summary.clone(),
            _ => command_summary(params),
        };
        if governed_memory_command(command) || governed_memory_command(&summary) {
            return Step {
                write: vec![decision_line(id, "decline")],
                events: vec![RunEvent::Denied { tool: "Shell".into(), summary: GOVERNED.into() }],
                ..Step::default()
            };
        }
        self.ask(id, item);
        let cwd = params.get("cwd").cloned().unwrap_or(Value::Null);
        // The command itself, not the shell wrapper Codex runs it in (`"C:\\…\\powershell.exe" -Command '…'`).
        let action = params.pointer("/commandActions/0/command").and_then(Value::as_str).filter(|text| !text.trim().is_empty());
        let input = json!({"command": clip(action.unwrap_or(command), APPROVAL_INPUT), "cwd": cwd});
        Step { events: vec![approval(item, "Shell", summary, input)], ..Step::default() }
    }

    fn edit_request(&mut self, id: &Value, item: &str, _params: &Value) -> Step {
        let (summary, changes) = match self.items.get(item) {
            Some(Item::Edit { summary, changes }) => (summary.clone(), changes.clone()),
            _ => ("file changes".to_string(), vec![]),
        };
        self.ask(id, item);
        Step { events: vec![approval(item, "Edit", summary, json!({"changes": changes}))], ..Step::default() }
    }

    /// Remember that the server waits for an answer to this item's request.
    fn ask(&mut self, id: &Value, item: &str) {
        self.open.retain(|(open, _)| open != item);
        self.open.push((item.to_string(), id.clone()));
    }

    /// A Stop pressed before the turn had an id, written now that it has one. Only what is written depends on it.
    fn stop_if_asked(&mut self) -> Step {
        match (self.stop_asked, self.thread.clone(), self.turn.clone()) {
            (true, Some(thread), Some(turn)) => {
                self.stop_asked = false;
                Step { write: vec![self.client_request("turn/interrupt", json!({"threadId": thread, "turnId": turn}))], ..Step::default() }
            }
            _ => Step::default(),
        }
    }

    fn turn_started(&mut self, params: &Value) -> Step {
        self.state = State::Turn;
        self.pending_turn = None;
        self.turn = params.pointer("/turn/id").and_then(Value::as_str).map(str::to_string);
        self.items.clear();
        self.last_text = None;
        self.last_answer = None;
        self.declined = 0;
        self.stop_if_asked()
    }

    fn item_started(&mut self, item: &Value) -> Step {
        let id = text_of(item, "id").unwrap_or_default().to_string();
        match text_of(item, "type") {
            Some("commandExecution") => {
                let summary = command_summary(item);
                self.items.insert(id.clone(), Item::Command { summary: summary.clone() });
                Step { events: vec![RunEvent::ToolUse { id, name: "Shell".into(), summary }], ..Step::default() }
            }
            Some("fileChange") => {
                let changes: Vec<Value> = item.get("changes").and_then(Value::as_array).into_iter().flatten().map(shown_change).collect();
                let paths: Vec<String> = changes
                    .iter()
                    .map(|change| {
                        let kind = change.pointer("/kind/type").and_then(Value::as_str).unwrap_or("change");
                        format!("{kind} {}", self.relative(text_of(change, "path").unwrap_or_default()))
                    })
                    .collect();
                let summary = clip(&paths.join(", "), TOOL_SUMMARY);
                self.items.insert(id.clone(), Item::Edit { summary: summary.clone(), changes });
                Step { events: vec![RunEvent::ToolUse { id, name: "Edit".into(), summary }], ..Step::default() }
            }
            _ => Step::default(),
        }
    }

    fn item_completed(&mut self, item: &Value) -> Step {
        let id = text_of(item, "id").unwrap_or_default().to_string();
        let declined = text_of(item, "status") == Some("declined");
        match text_of(item, "type") {
            Some("commandExecution") => {
                self.items.remove(&id);
                self.declined += u64::from(declined);
                let ok = command_ok(item);
                let output = text_of(item, "aggregatedOutput").filter(|text| !text.trim().is_empty());
                let summary = match (declined, output, item.get("exitCode").and_then(Value::as_i64)) {
                    (true, ..) => DECLINED.to_string(),
                    (_, Some(output), _) => clip(output, RESULT_SUMMARY),
                    (_, None, Some(code)) if code != 0 => format!("exit code {code}"),
                    _ if !ok => text_of(item, "status").unwrap_or_default().to_string(),
                    _ => String::new(),
                };
                Step { events: vec![RunEvent::ToolResult { id, ok, summary }], ..Step::default() }
            }
            Some("fileChange") => {
                self.items.remove(&id);
                self.declined += u64::from(declined);
                let ok = text_of(item, "status") == Some("completed");
                let summary = if declined { DECLINED.to_string() } else { String::new() };
                Step { events: vec![RunEvent::ToolResult { id, ok, summary }], ..Step::default() }
            }
            // Both the commentary before the tools and the final answer arrive under one item id: each is a text.
            Some("agentMessage") => {
                let Some(text) = text_of(item, "text").filter(|text| !text.trim().is_empty()) else { return Step::default() };
                self.last_text = Some(text.to_string());
                if text_of(item, "phase") == Some("final_answer") {
                    self.last_answer = Some(text.to_string());
                }
                Step { events: vec![RunEvent::Text { text: text.to_string() }], ..Step::default() }
            }
            _ => Step::default(),
        }
    }

    fn turn_completed(&mut self, params: &Value) -> Step {
        let turn = params.get("turn").unwrap_or(&NULL);
        let status = text_of(turn, "status").unwrap_or_default();
        let ok = status == "completed";
        let reason = match status {
            "completed" => None,
            "interrupted" => Some("Codex stopped the turn".to_string()),
            "failed" => Some(error_message(turn.get("error").unwrap_or(&NULL), "Codex failed the turn")),
            other => Some(format!("Codex ended the turn ({other})")),
        };
        let events = self.close_requests();
        let outcome = Outcome {
            ok,
            reason,
            duration_ms: turn.get("durationMs").and_then(Value::as_u64),
            result: self.last_answer.take().or_else(|| self.last_text.take()),
            denials: self.declined,
            ..Outcome::default()
        };
        self.state = State::Ready;
        self.turn = None;
        self.stop_asked = false;
        self.items.clear();
        self.last_text = None;
        self.declined = 0;
        Step { events, turn: Some(outcome), ..Step::default() }
    }
}

/// One change of a `fileChange` item as the approval card shows it.
fn shown_change(change: &Value) -> Value {
    json!({
        "path": change.get("path").cloned().unwrap_or(Value::Null),
        "kind": change.get("kind").cloned().unwrap_or(Value::Null),
        "diff": clip(text_of(change, "diff").unwrap_or_default(), APPROVAL_INPUT),
    })
}

fn approval(item: &str, tool: &str, summary: String, input: Value) -> RunEvent {
    let (request_id, tool) = (item.to_string(), tool.to_string());
    RunEvent::ApprovalRequest { request_id, tool, summary, input, can_always: false, always_label: None }
}

impl Driver for CodexDriver {
    fn read(&mut self, line: &str) -> Step {
        let Ok(value) = serde_json::from_str::<Value>(line) else { return Step::default() };
        let (method, id) = (text_of(&value, "method"), value.get("id"));
        let live = matches!(self.state, State::Ready | State::Turn);
        let params = value.get("params").unwrap_or(&NULL);
        match (method, id) {
            (None, Some(id)) => match (self.state, id.as_u64()) {
                (State::Handshake, Some(HANDSHAKE_ID)) => self.handshake(&value),
                (State::Starting, Some(THREAD_ID)) => self.thread_opened(&value),
                (State::Ready | State::Turn, Some(reply)) if self.pending_turn == Some(reply) => self.turn_replied(&value),
                // The reply to a `turn/start` or `turn/interrupt`, or to a request of an earlier process.
                _ => Step::default(),
            },
            (Some(method), Some(id)) if live => self.request(method, id, params),
            (Some("turn/started"), None) if live => self.turn_started(params),
            (Some("turn/completed"), None) if self.state == State::Turn => self.turn_completed(params),
            (Some("item/started"), None) if live => params.get("item").map_or_else(Step::default, |item| self.item_started(item)),
            (Some("item/completed"), None) if live => params.get("item").map_or_else(Step::default, |item| self.item_completed(item)),
            _ => Step::default(),
        }
    }

    fn note(&mut self, event: &RunEvent) {
        match event {
            RunEvent::ProcessStarted { .. } => self.begin(),
            RunEvent::ApprovalResolved { request_id, .. } => self.open.retain(|(item, _)| item != request_id),
            RunEvent::TurnFinished { .. } => self.open.clear(),
            _ => {}
        }
    }

    fn open(&mut self) -> Vec<String> {
        if self.state != State::Handshake {
            return vec![];
        }
        let client = json!({"name": "hivemind", "title": "Hivemind", "version": env!("CARGO_PKG_VERSION")});
        vec![json!({"method": "initialize", "id": HANDSHAKE_ID, "params": {"clientInfo": client}}).to_string()]
    }

    fn send(&mut self, text: &str) -> Vec<String> {
        match self.state {
            State::Handshake | State::Starting => {
                self.kept = Some(text.to_string());
                vec![]
            }
            State::Ready | State::Turn => vec![self.turn_start(text)],
            State::NoProcess | State::Failed => vec![],
        }
    }

    fn answer(&mut self, request_id: &str, _request: &str, decision: Decision) -> Option<String> {
        let (_, server) = self.open.iter().find(|(item, _)| item == request_id)?;
        match decision {
            Decision::Allow | Decision::AllowAlways => Some(decision_line(server, "accept")),
            Decision::Deny => Some(decision_line(server, "decline")),
            Decision::Withdrawn => None,
        }
    }

    /// Stops the running turn. A turn that is asked for but has no id yet (the handshake, or `turn/start` not yet
    /// answered) is stopped as soon as Codex names it.
    fn interrupt(&mut self) -> Option<String> {
        if let (State::Ready | State::Turn, Some(thread), Some(turn)) = (self.state, self.thread.clone(), self.turn.clone()) {
            return Some(self.client_request("turn/interrupt", json!({"threadId": thread, "turnId": turn})));
        }
        if self.kept.is_some() || self.pending_turn.is_some() {
            self.stop_asked = true;
        }
        None
    }

    /// Changing the approval policy of a running thread was not verified.
    fn set_mode(&mut self, _mode: PolicyMode) -> Option<String> {
        None
    }
}

#[cfg(test)]
pub(super) mod tests {
    use super::super::events::TurnEnd;
    use super::super::scope::Policy;
    use super::super::step_of;
    use super::super::store::Record;
    use super::*;

    // The lines below are `<-` lines of docs/plans/spikes/codex-app-server-0.169.0.jsonl, as codex-cli 0.169.0 printed them.
    pub(crate) const INIT_RESULT: &str = r##"{"id":1,"result":{"userAgent":"hivemind/0.169.0 (Windows 10.0.26100; x86_64) WindowsTerminal (hivemind; 0.1.0)","codexHome":"C:\\Users\\<user>\\.codex","platformFamily":"windows","platformOs":"windows"}}"##; // line 2
    pub(crate) const THREAD_RESULT: &str = r##"{"id":2,"result":{"thread":{"id":"01a1e27b-5c52-7e82-9d72-1eb2d9ff6b38","environments":[{"environmentId":"local","cwd":"C:\\work\\codex-check","runtimeWorkspaceRoots":["C:\\work\\codex-check"]}],"extra":null,"sessionId":"01a1e27b-5c52-7e82-9d72-1eb2d9ff6b38","forkedFromId":null,"attachedToThreadId":null,"parentThreadId":null,"preview":"","ephemeral":false,"section":null,"sectionEnteredAt":null,"projectId":null,"historyMode":"paginated","modelProvider":"openai","model":"gpt-6.1-sol","reasoningEffort":"high","createdAt":1794801098,"updatedAt":1794801098,"recencyAt":1794801098,"status":{"type":"idle"},"path":"C:\\Users\\<user>\\.codex\\sessions\\2026\\11\\15\\rollout-2026-11-15T21-51-38-01a1e27b-5c52-7e82-9d72-1eb2d9ff6b38.jsonl","cwd":"C:\\work\\codex-check","cliVersion":"0.169.0","originator":"hivemind","source":"vscode","canAcceptDirectInput":true,"threadSource":null,"agentNickname":null,"agentRole":null,"gitInfo":null,"name":null,"daybreakEnabled":null,"turns":[]},"model":"gpt-6.1-sol","modelProvider":"openai","serviceTier":"default","disabledPluginIds":[],"cwd":"C:\\work\\codex-check","runtimeWorkspaceRoots":["C:\\work\\codex-check"],"instructionSources":["C:\\Users\\<user>\\.codex\\AGENTS.md"],"approvalPolicy":"untrusted","approvalsReviewer":"user","sandbox":{"type":"workspaceWrite","writableRoots":[],"networkAccess":false,"excludeTmpdirEnvVar":false,"excludeSlashTmp":false},"activePermissionProfile":null,"reasoningEffort":"high","multiAgentMode":"explicitRequestOnly"}}"##; // line 7
    pub(crate) const THREAD_STATUS: &str = r##"{"method":"thread/status/changed","params":{"threadId":"01a1e27b-5c52-7e82-9d72-1eb2d9ff6b38","status":{"type":"active","activeFlags":[]}},"emittedAtMs":1794801099632}"##; // line 19
    pub(crate) const TURN_STARTED: &str = r##"{"method":"turn/started","params":{"threadId":"01a1e27b-5c52-7e82-9d72-1eb2d9ff6b38","turn":{"id":"01a1e27b-5fd8-7241-9725-3b97d589c611","rootTurnId":"01a1e27b-5fd8-7241-9725-3b97d589c611","items":[],"itemsView":"notLoaded","status":"inProgress","error":null,"startedAt":1794801098,"completedAt":null,"durationMs":null}},"emittedAtMs":1794801099632}"##; // line 20
    const HOOK_STARTED: &str = r##"{"method":"hook/started","params":{"threadId":"01a1e27b-5c52-7e82-9d72-1eb2d9ff6b38","turnId":"01a1e27b-5fd8-7241-9725-3b97d589c611","run":{"eventName":"sessionStart","status":"running"}}}"##; // line 21
    const HOOK_COMPLETED: &str = r##"{"method":"hook/completed","params":{"threadId":"01a1e27b-5c52-7e82-9d72-1eb2d9ff6b38","turnId":"01a1e27b-5fd8-7241-9725-3b97d589c611","run":{"eventName":"sessionStart","status":"completed"}}}"##; // line 22
    const USER_MESSAGE_STARTED: &str = r##"{"method":"item/started","params":{"item":{"type":"userMessage","id":"01a1e27b-6812-7602-a474-3eb8fe8c3977","clientId":null,"content":[{"type":"text","text":"Do these three steps in order, each as its own action, then reply with exactly \"done.\": 1) run the shell command: Set-Content -LiteralPath as-shell.txt -Value hi 2) create the file as-patch.txt containing the single line hi, using your file editing (apply_patch) tool, not a shell command 3) run the shell command: Set-Content -LiteralPath declined.txt -Value no If a step is declined, skip it and continue.","text_elements":[]}],"startedAtMs":1794801100948,"completedAtMs":null},"threadId":"01a1e27b-5c52-7e82-9d72-1eb2d9ff6b38","turnId":"01a1e27b-5fd8-7241-9725-3b97d589c611","startedAtMs":1794801100948},"emittedAtMs":1794801100948}"##; // line 25
    const USER_MESSAGE_COMPLETED: &str = r##"{"method":"item/completed","params":{"item":{"type":"userMessage","id":"01a1e27b-6812-7602-a474-3eb8fe8c3977","clientId":null,"content":[{"type":"text","text":"Do these three steps in order, each as its own action, then reply with exactly \"done.\": 1) run the shell command: Set-Content -LiteralPath as-shell.txt -Value hi 2) create the file as-patch.txt containing the single line hi, using your file editing (apply_patch) tool, not a shell command 3) run the shell command: Set-Content -LiteralPath declined.txt -Value no If a step is declined, skip it and continue.","text_elements":[]}],"startedAtMs":1794801100948,"completedAtMs":1794801100948},"threadId":"01a1e27b-5c52-7e82-9d72-1eb2d9ff6b38","turnId":"01a1e27b-5fd8-7241-9725-3b97d589c611","contentTokenCount":null,"completedAtMs":1794801100948},"emittedAtMs":1794801101080}"##; // line 26
    const DELTA: &str = r##"{"method":"item/agentMessage/delta","params":{"threadId":"01a1e27b-5c52-7e82-9d72-1eb2d9ff6b38","turnId":"01a1e27b-5fd8-7241-9725-3b97d589c611","itemId":"msg_0ac2d3814f2deb42016afa7dcede7c87d1a58c6c5e7364a6eb","delta":"I"},"emittedAtMs":1794801102880}"##; // line 28
    pub(crate) const COMMENTARY_COMPLETED: &str = r##"{"method":"item/completed","params":{"item":{"type":"agentMessage","moderation":null,"id":"msg_0ac2d3814f2deb42016afa7dcede7c87d1a58c6c5e7364a6eb","text":"I will perform each step in order and skip any declined step.\n","phase":"commentary","memoryCitation":null,"delivery":null,"questions":null,"startedAtMs":1794801102879,"completedAtMs":1794801103315},"threadId":"01a1e27b-5c52-7e82-9d72-1eb2d9ff6b38","turnId":"01a1e27b-5fd8-7241-9725-3b97d589c611","contentTokenCount":14,"completedAtMs":1794801103315},"emittedAtMs":1794801103431}"##; // line 41
    pub(crate) const ITEM_STARTED_COMMAND: &str = r##"{"method":"item/started","params":{"item":{"type":"commandExecution","id":"exec-0761b7d0-9001-4bde-b606-650cea373e1d","pluginId":null,"scriptPath":null,"command":"\"C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe\" -Command 'Set-Content -LiteralPath as-shell.txt -Value hi'","cwd":"C:\\work\\codex-check","processId":null,"source":"agent","status":"inProgress","commandActions":[{"type":"unknown","command":"Set-Content -LiteralPath as-shell.txt -Value hi"}],"aggregatedOutput":null,"exitCode":null,"durationMs":null,"startedAtMs":1794801104628,"completedAtMs":null},"threadId":"01a1e27b-5c52-7e82-9d72-1eb2d9ff6b38","turnId":"01a1e27b-5fd8-7241-9725-3b97d589c611","startedAtMs":1794801104628},"emittedAtMs":1794801104631}"##; // line 45
    const REQUEST_COMMAND: &str = r##"{"method":"item/commandExecution/requestApproval","id":0,"params":{"kind":"command","threadId":"01a1e27b-5c52-7e82-9d72-1eb2d9ff6b38","turnId":"01a1e27b-5fd8-7241-9725-3b97d589c611","itemId":"exec-0761b7d0-9001-4bde-b606-650cea373e1d","startedAtMs":1794801104628,"environmentId":"local","command":"\"C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe\" -Command 'Set-Content -LiteralPath as-shell.txt -Value hi'","cwd":"C:\\work\\codex-check","commandActions":[{"type":"unknown","command":"Set-Content -LiteralPath as-shell.txt -Value hi"}],"proposedExecpolicyAmendment":["Set-Content","-LiteralPath","as-shell.txt","-Value","hi"],"availableDecisions":["accept",{"acceptWithExecpolicyAmendment":{"execpolicy_amendment":["Set-Content","-LiteralPath","as-shell.txt","-Value","hi"]}},"cancel"]}}"##; // line 46
    const RESOLVED: &str = r##"{"method":"serverRequest/resolved","params":{"threadId":"01a1e27b-5c52-7e82-9d72-1eb2d9ff6b38","requestId":0},"emittedAtMs":1794801104634}"##; // line 48
    pub(crate) const ITEM_COMPLETED_COMMAND: &str = r##"{"method":"item/completed","params":{"item":{"type":"commandExecution","id":"exec-0761b7d0-9001-4bde-b606-650cea373e1d","pluginId":null,"scriptPath":null,"command":"\"C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe\" -Command 'Set-Content -LiteralPath as-shell.txt -Value hi'","cwd":"C:\\work\\codex-check","processId":"69973","source":"unifiedExecStartup","status":"completed","commandActions":[{"type":"unknown","command":"Set-Content -LiteralPath as-shell.txt -Value hi"}],"aggregatedOutput":null,"exitCode":0,"durationMs":364,"startedAtMs":1794801104628,"completedAtMs":1794801106220},"threadId":"01a1e27b-5c52-7e82-9d72-1eb2d9ff6b38","turnId":"01a1e27b-5fd8-7241-9725-3b97d589c611","contentTokenCount":null,"completedAtMs":1794801106220},"emittedAtMs":1794801106340}"##; // line 50
    pub(crate) const TOKEN_USAGE: &str = r##"{"method":"thread/tokenUsage/updated","params":{"threadId":"01a1e27b-5c52-7e82-9d72-1eb2d9ff6b38","turnId":"01a1e27b-5fd8-7241-9725-3b97d589c611","tokenUsage":{"total":{"totalTokens":19905,"inputTokens":19847,"cachedInputTokens":13440,"cacheWriteInputTokens":0,"outputTokens":58,"reasoningOutputTokens":0},"last":{"totalTokens":19905,"inputTokens":19847,"cachedInputTokens":13440,"cacheWriteInputTokens":0,"outputTokens":58,"reasoningOutputTokens":0},"modelContextWindow":475000}},"emittedAtMs":1794801106562}"##; // line 51
    const RATE_LIMITS: &str = r##"{"method":"account/rateLimits/updated","params":{}}"##; // line 52
    const ITEM_STARTED_PATCH: &str = r##"{"method":"item/started","params":{"item":{"type":"fileChange","id":"exec-71bc70e6-55b4-481b-ab24-f4c118d2fa93","changes":[{"path":"C:\\work\\codex-check\\as-patch.txt","kind":{"type":"add"},"diff":"hi\n"}],"status":"inProgress","startedAtMs":1794801110927,"completedAtMs":null},"threadId":"01a1e27b-5c52-7e82-9d72-1eb2d9ff6b38","turnId":"01a1e27b-5fd8-7241-9725-3b97d589c611","startedAtMs":1794801110927},"emittedAtMs":1794801110928}"##; // line 55
    const REQUEST_PATCH: &str = r##"{"method":"item/fileChange/requestApproval","id":1,"params":{"threadId":"01a1e27b-5c52-7e82-9d72-1eb2d9ff6b38","turnId":"01a1e27b-5fd8-7241-9725-3b97d589c611","itemId":"exec-71bc70e6-55b4-481b-ab24-f4c118d2fa93","startedAtMs":1794801110932,"reason":null,"grantRoot":null}}"##; // line 57
    const ITEM_COMPLETED_PATCH: &str = r##"{"method":"item/completed","params":{"item":{"type":"fileChange","id":"exec-71bc70e6-55b4-481b-ab24-f4c118d2fa93","changes":[{"path":"C:\\work\\codex-check\\as-patch.txt","kind":{"type":"add"},"diff":"hi\n"}],"status":"completed","startedAtMs":1794801110927,"completedAtMs":1794801113793},"threadId":"01a1e27b-5c52-7e82-9d72-1eb2d9ff6b38","turnId":"01a1e27b-5fd8-7241-9725-3b97d589c611","contentTokenCount":null,"completedAtMs":1794801113793},"emittedAtMs":1794801113802}"##; // line 61
    const ITEM_STARTED_DECLINED: &str = r##"{"method":"item/started","params":{"item":{"type":"commandExecution","id":"exec-fdbd310d-f3c4-42d2-b099-bec93e0fefaa","pluginId":null,"scriptPath":null,"command":"\"C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe\" -Command 'Set-Content -LiteralPath declined.txt -Value no'","cwd":"C:\\work\\codex-check","processId":null,"source":"agent","status":"inProgress","commandActions":[{"type":"unknown","command":"Set-Content -LiteralPath declined.txt -Value no"}],"aggregatedOutput":null,"exitCode":null,"durationMs":null,"startedAtMs":1794801117400,"completedAtMs":null},"threadId":"01a1e27b-5c52-7e82-9d72-1eb2d9ff6b38","turnId":"01a1e27b-5fd8-7241-9725-3b97d589c611","startedAtMs":1794801117400},"emittedAtMs":1794801117400}"##; // line 69
    const REQUEST_DECLINED: &str = r##"{"method":"item/commandExecution/requestApproval","id":2,"params":{"kind":"command","threadId":"01a1e27b-5c52-7e82-9d72-1eb2d9ff6b38","turnId":"01a1e27b-5fd8-7241-9725-3b97d589c611","itemId":"exec-fdbd310d-f3c4-42d2-b099-bec93e0fefaa","startedAtMs":1794801117400,"environmentId":"local","command":"\"C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe\" -Command 'Set-Content -LiteralPath declined.txt -Value no'","cwd":"C:\\work\\codex-check","commandActions":[{"type":"unknown","command":"Set-Content -LiteralPath declined.txt -Value no"}],"proposedExecpolicyAmendment":["Set-Content","-LiteralPath","declined.txt","-Value","no"],"availableDecisions":["accept",{"acceptWithExecpolicyAmendment":{"execpolicy_amendment":["Set-Content","-LiteralPath","declined.txt","-Value","no"]}},"cancel"]}}"##; // line 70
    const ITEM_COMPLETED_DECLINED: &str = r##"{"method":"item/completed","params":{"item":{"type":"commandExecution","id":"exec-fdbd310d-f3c4-42d2-b099-bec93e0fefaa","pluginId":null,"scriptPath":null,"command":"\"C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe\" -Command 'Set-Content -LiteralPath declined.txt -Value no'","cwd":"C:\\work\\codex-check","processId":null,"source":"agent","status":"declined","commandActions":[{"type":"unknown","command":"Set-Content -LiteralPath declined.txt -Value no"}],"aggregatedOutput":null,"exitCode":null,"durationMs":null,"startedAtMs":1794801117400,"completedAtMs":1794801117401},"threadId":"01a1e27b-5c52-7e82-9d72-1eb2d9ff6b38","turnId":"01a1e27b-5fd8-7241-9725-3b97d589c611","contentTokenCount":null,"completedAtMs":1794801117401},"emittedAtMs":1794801117401}"##; // line 73
    pub(crate) const ITEM_COMPLETED_MESSAGE: &str = r##"{"method":"item/completed","params":{"item":{"type":"agentMessage","moderation":null,"id":"msg_0ac2d3814f2deb42016afa7de0228487d18ea670f20e08abff","text":"done.","phase":"final_answer","memoryCitation":null,"delivery":null,"questions":null,"startedAtMs":1794801120151,"completedAtMs":1794801120225},"threadId":"01a1e27b-5c52-7e82-9d72-1eb2d9ff6b38","turnId":"01a1e27b-5fd8-7241-9725-3b97d589c611","contentTokenCount":3,"completedAtMs":1794801120225},"emittedAtMs":1794801120312}"##; // line 81
    pub(crate) const TURN_COMPLETED: &str = r##"{"method":"turn/completed","params":{"threadId":"01a1e27b-5c52-7e82-9d72-1eb2d9ff6b38","turn":{"id":"01a1e27b-5fd8-7241-9725-3b97d589c611","rootTurnId":"01a1e27b-5fd8-7241-9725-3b97d589c611","items":[{"type":"agentMessage","moderation":null,"id":"msg_0ac2d3814f2deb42016afa7de0228487d18ea670f20e08abff","text":"done.","phase":"final_answer","memoryCitation":null,"delivery":null,"questions":null,"startedAtMs":1794801120151,"completedAtMs":1794801120225}],"itemsView":"summary","status":"completed","error":null,"startedAt":1794801098,"completedAt":1794801120,"durationMs":22090}},"emittedAtMs":1794801120862}"##; // line 88
    const REASONING_STARTED: &str = r##"{"method":"item/started","params":{"item":{"type":"reasoning","id":"rs_0ac2d3814f2deb42016afa7de4298c87d181cbd48cf2d8cdb2","summary":[],"content":[],"startedAtMs":1794801124174,"completedAtMs":null},"threadId":"01a1e27b-5c52-7e82-9d72-1eb2d9ff6b38","turnId":"01a1e27b-b660-7d12-aa7b-c17638473741","startedAtMs":1794801124174},"emittedAtMs":1794801124175}"##; // line 98
    const REASONING_COMPLETED: &str = r##"{"method":"item/completed","params":{"item":{"type":"reasoning","id":"rs_0ac2d3814f2deb42016afa7de4298c87d181cbd48cf2d8cdb2","summary":[],"content":[],"startedAtMs":1794801124174,"completedAtMs":1794801124176},"threadId":"01a1e27b-5c52-7e82-9d72-1eb2d9ff6b38","turnId":"01a1e27b-b660-7d12-aa7b-c17638473741","contentTokenCount":null,"completedAtMs":1794801124176},"emittedAtMs":1794801124190}"##; // line 99
    const INTERRUPT_REPLY: &str = r##"{"id":11,"result":{}}"##; // line 158
    const TURN_INTERRUPTED: &str = r##"{"method":"turn/completed","params":{"threadId":"01a1e27b-5c52-7e82-9d72-1eb2d9ff6b38","turn":{"id":"01a1e27b-b660-7d12-aa7b-c17638473741","rootTurnId":"01a1e27b-b660-7d12-aa7b-c17638473741","items":[],"itemsView":"notLoaded","status":"interrupted","error":null,"startedAt":1794801120,"completedAt":1794801125,"durationMs":4303}},"emittedAtMs":1794801125213}"##; // line 160
    const TURN_START_REPLY: &str = r##"{"id":21,"result":{"turn":{"id":"01a1e27b-c7aa-7e60-9d58-856547639d6d","rootTurnId":"01a1e27b-c7aa-7e60-9d58-856547639d6d","items":[],"itemsView":"notLoaded","status":"inProgress","error":null,"startedAt":null,"completedAt":null,"durationMs":null}}}"##; // line 172
    const ERROR: &str = r##"{"method":"error","params":{"error":{"message":"The 'no-such-model-xyz' model is not supported when using Codex with a ChatGPT account.","codexErrorInfo":"modelNotFound","additionalDetails":null,"misalignment":null},"willRetry":false,"threadId":"01a1e27b-c765-7f52-b656-1ff5786da017","turnId":"01a1e27b-c7aa-7e60-9d58-856547639d6d"},"emittedAtMs":1794801127357}"##; // line 183
    const TURN_FAILED: &str = r##"{"method":"turn/completed","params":{"threadId":"01a1e27b-c765-7f52-b656-1ff5786da017","turn":{"id":"01a1e27b-c7aa-7e60-9d58-856547639d6d","rootTurnId":"01a1e27b-c7aa-7e60-9d58-856547639d6d","items":[],"itemsView":"notLoaded","status":"failed","error":{"message":"The 'no-such-model-xyz' model is not supported when using Codex with a ChatGPT account.","codexErrorInfo":"modelNotFound","additionalDetails":null,"misalignment":null},"startedAt":1794801125,"completedAt":1794801127,"durationMs":2040}},"emittedAtMs":1794801127357}"##; // line 184
    pub(crate) const RESUME_RESULT: &str = r##"{"id":2,"result":{"thread":{"id":"01a1e27b-5c52-7e82-9d72-1eb2d9ff6b38","environments":[{"environmentId":"local","cwd":"C:\\work\\codex-check","runtimeWorkspaceRoots":["C:\\work\\codex-check"]}],"extra":null,"sessionId":"01a1e27b-5c52-7e82-9d72-1eb2d9ff6b38","forkedFromId":null,"attachedToThreadId":null,"parentThreadId":null,"preview":"Do these three steps in order, each as its own action, then reply with exactly \"done.\": 1) run the shell command: Set-Content -LiteralPath as-shell.txt -Value hi 2) create the file as-patch.txt containing the single line hi, using your file editing (apply_patch) tool, not a shell command 3) run the shell command: Set-Content -LiteralPath declined.txt -Value no If a step is declined, skip it and continue.","ephemeral":false,"section":null,"sectionEnteredAt":null,"projectId":null,"historyMode":"paginated","modelProvider":"openai","model":"gpt-6.1-sol","reasoningEffort":"low","createdAt":1794801098,"updatedAt":1794801128,"recencyAt":1794801120,"status":{"type":"idle"},"path":"C:\\Users\\<user>\\.codex\\sessions\\2026\\11\\15\\rollout-2026-11-15T21-51-38-01a1e27b-5c52-7e82-9d72-1eb2d9ff6b38.jsonl","cwd":"C:\\work\\codex-check","cliVersion":"0.169.0","originator":"hivemind","source":"vscode","canAcceptDirectInput":true,"threadSource":null,"agentNickname":null,"agentRole":null,"gitInfo":{"sha":"8712227990f41a085cc6ca75cfe595b683a7b383","branch":"master","originUrl":null},"name":null,"daybreakEnabled":null,"turns":[{"id":"01a1e27b-5fd8-7241-9725-3b97d589c611","rootTurnId":"01a1e27b-5fd8-7241-9725-3b97d589c611","items":[{"type":"userMessage","id":"01a1e27b-6812-7602-a474-3eb8fe8c3977","clientId":null,"content":[{"type":"text","text":"Do these three steps in order, each as its own action, then reply with exactly \"done.\": 1) run the shell command: Set-Content -LiteralPath as-shell.txt -Value hi 2) create the file as-patch.txt containing the single line hi, using your file editing (apply_patch) tool, not a shell command 3) run the shell command: Set-Content -LiteralPath declined.txt -Value no If a step is declined, skip it and continue.","text_elements":[]}],"startedAtMs":1794801100948,"completedAtMs":1794801100948},{"type":"agentMessage","moderation":null,"id":"msg_0ac2d3814f2deb42016afa7dcede7c87d1a58c6c5e7364a6eb","text":"I will perform each step in order and skip any declined step.\n","phase":"commentary","memoryCitation":null,"delivery":null,"questions":null,"startedAtMs":1794801102879,"completedAtMs":1794801103315},{"type":"commandExecution","id":"exec-0761b7d0-9001-4bde-b606-650cea373e1d","pluginId":null,"scriptPath":null,"command":"\"C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe\" -Command 'Set-Content -LiteralPath as-shell.txt -Value hi'","cwd":"C:\\work\\codex-check","processId":"69973","source":"unifiedExecStartup","status":"completed","commandActions":[{"type":"unknown","command":"Set-Content -LiteralPath as-shell.txt -Value hi"}],"aggregatedOutput":null,"exitCode":0,"durationMs":364,"startedAtMs":1794801104628,"completedAtMs":1794801106220},{"type":"fileChange","id":"exec-71bc70e6-55b4-481b-ab24-f4c118d2fa93","changes":[{"path":"C:\\work\\codex-check\\as-patch.txt","kind":{"type":"add"},"diff":"hi\n"}],"status":"completed","startedAtMs":1794801110927,"completedAtMs":1794801113793},{"type":"agentMessage","moderation":null,"id":"msg_0ac2d3814f2deb42016afa7de0228487d18ea670f20e08abff","text":"done.","phase":"final_answer","memoryCitation":null,"delivery":null,"questions":null,"startedAtMs":1794801120151,"completedAtMs":1794801120225}],"itemsView":"full","status":"completed","error":null,"startedAt":1794801098,"completedAt":1794801120,"durationMs":22090},{"id":"01a1e27b-b660-7d12-aa7b-c17638473741","rootTurnId":"01a1e27b-b660-7d12-aa7b-c17638473741","items":[{"type":"userMessage","id":"01a1e27b-b8d1-76a0-815b-6a9546f5b263","clientId":null,"content":[{"type":"text","text":"Count slowly from 1 to 200, one number per line, thinking about each number.","text_elements":[]}],"startedAtMs":1794801121498,"completedAtMs":1794801121498},{"type":"reasoning","id":"rs_0ac2d3814f2deb42016afa7de4298c87d181cbd48cf2d8cdb2","summary":[],"content":[],"startedAtMs":1794801124174,"completedAtMs":1794801124176}],"itemsView":"full","status":"interrupted","error":null,"startedAt":1794801120,"completedAt":1794801125,"durationMs":4303}]},"model":"gpt-6.1-sol","modelProvider":"openai","serviceTier":"default","disabledPluginIds":[],"cwd":"C:\\work\\codex-check","runtimeWorkspaceRoots":["C:\\work\\codex-check"],"instructionSources":["C:\\Users\\<user>\\.codex\\AGENTS.md"],"approvalPolicy":"untrusted","approvalsReviewer":"user","sandbox":{"type":"workspaceWrite","writableRoots":[],"networkAccess":false,"excludeTmpdirEnvVar":false,"excludeSlashTmp":false},"activePermissionProfile":{"id":":workspace","extends":null},"reasoningEffort":"low","collaborationMode":{"mode":"default","settings":{"model":"gpt-6.1-sol","reasoning_effort":"low","developer_instructions":null}},"multiAgentMode":"explicitRequestOnly","initialTurnsPage":null,"turnsBackwardsCursor":"{\"requestedThreadId\":\"01a1e27b-5c52-7e82-9d72-1eb2d9ff6b38\",\"rolloutOrdinal\":37,\"includeAnchor\":true,\"scope\":{\"kind\":\"turns\"}}","itemsBackwardsCursor":"{\"requestedThreadId\":\"01a1e27b-5c52-7e82-9d72-1eb2d9ff6b38\",\"rolloutOrdinal\":43,\"includeAnchor\":true,\"scope\":{\"kind\":\"itemsByCreatedAtOrdinal\"}}"}}"##; // line 200

    pub(crate) const THREAD: &str = "01a1e27b-5c52-7e82-9d72-1eb2d9ff6b38";
    const TURN: &str = "01a1e27b-5fd8-7241-9725-3b97d589c611";
    const COMMAND: &str = "exec-0761b7d0-9001-4bde-b606-650cea373e1d";
    const PATCH: &str = "exec-71bc70e6-55b4-481b-ab24-f4c118d2fa93";
    const DECLINED_COMMAND: &str = "exec-fdbd310d-f3c4-42d2-b099-bec93e0fefaa";

    fn cwd() -> PathBuf {
        PathBuf::from(r"C:\work\codex-check")
    }

    fn driver(policy: PolicyMode, engine_session: Option<&str>) -> Box<dyn Driver> {
        Codex.driver(&cwd(), policy, engine_session, None)
    }

    fn json_of(line: &str) -> Value {
        serde_json::from_str(line).unwrap()
    }

    fn empty(step: &Step) -> bool {
        step.write.is_empty() && step.events.is_empty() && step.turn.is_none() && step.mode.is_none() && step.engine_session.is_none()
    }

    /// A driver whose process answered the handshake and opened the thread, as a new session's first process does.
    fn ready() -> Box<dyn Driver> {
        let mut d = driver(PolicyMode::Ask, None);
        d.note(&RunEvent::ProcessStarted { resume: false });
        d.read(INIT_RESULT);
        d.read(THREAD_RESULT);
        d
    }

    /// `ready`, with a turn running.
    fn running() -> Box<dyn Driver> {
        let mut d = ready();
        d.read(TURN_STARTED);
        d
    }

    #[test]
    fn handshake_then_thread_then_the_kept_prompt() {
        let mut d = driver(PolicyMode::Ask, None);
        assert!(d.open().is_empty());
        d.note(&RunEvent::ProcessStarted { resume: false });
        let open = d.open();
        assert_eq!(open.len(), 1);
        let init = json_of(&open[0]);
        assert_eq!((init["method"].as_str(), init["id"].as_u64(), init["params"]["clientInfo"]["name"].as_str()), (Some("initialize"), Some(1), Some("hivemind")));
        assert!(d.send("hi").is_empty());
        let step = d.read(INIT_RESULT);
        assert!(step.events.is_empty() && step.turn.is_none());
        assert_eq!(step.write.len(), 2);
        assert_eq!(json_of(&step.write[0]), json!({"method": "initialized"}));
        let start = json_of(&step.write[1]);
        assert_eq!((start["method"].as_str(), start["id"].as_u64()), (Some("thread/start"), Some(2)));
        assert_eq!(
            start["params"],
            json!({"cwd": r"C:\work\codex-check", "approvalPolicy": "untrusted", "sandbox": "workspace-write"}),
            "no model: the user's default applies"
        );
        let step = d.read(THREAD_RESULT);
        assert_eq!(
            step.events,
            vec![RunEvent::Started { model: Some("gpt-6.1-sol".into()), cli_version: Some("0.169.0".into()), plugins: vec![] }]
        );
        assert_eq!(step.engine_session.as_deref(), Some(THREAD));
        assert_eq!(step.write.len(), 1);
        let turn = json_of(&step.write[0]);
        assert_eq!((turn["method"].as_str(), turn["id"].as_u64()), (Some("turn/start"), Some(3)));
        assert_eq!((turn["params"]["threadId"].as_str(), turn["params"]["input"][0]["text"].as_str()), (Some(THREAD), Some("hi")));
        // Once the thread is open a message goes out at once, under the next id.
        let next = json_of(&d.send("again")[0]);
        assert_eq!((next["id"].as_u64(), next["params"]["input"][0]["text"].as_str()), (Some(4), Some("again")));
        assert!(d.set_mode(PolicyMode::AcceptEdits).is_none());
    }

    #[test]
    fn the_policy_decides_the_thread_parameters() {
        let thread_params = |policy| {
            let mut d = driver(policy, None);
            d.note(&RunEvent::ProcessStarted { resume: false });
            json_of(&d.read(INIT_RESULT).write[1])["params"].clone()
        };
        assert_eq!(thread_params(PolicyMode::AcceptEdits)["approvalPolicy"], "on-request");
        assert_eq!(thread_params(PolicyMode::AcceptEdits)["sandbox"], "workspace-write");
        assert_eq!(thread_params(PolicyMode::Ask)["approvalPolicy"], "untrusted");
    }

    #[test]
    fn a_picked_model_goes_in_the_thread_request() {
        let mut start = Codex.driver(&cwd(), PolicyMode::Ask, None, Some("gpt-6.1-sol"));
        start.note(&RunEvent::ProcessStarted { resume: false });
        let request = json_of(&start.read(INIT_RESULT).write[1]);
        assert_eq!(request["method"], "thread/start");
        assert_eq!(request["params"]["model"], "gpt-6.1-sol");
        let mut resume = Codex.driver(&cwd(), PolicyMode::Ask, Some("T"), Some("gpt-6.1-sol"));
        resume.note(&RunEvent::ProcessStarted { resume: true });
        let request = json_of(&resume.read(INIT_RESULT).write[1]);
        assert_eq!((request["method"].as_str(), request["params"]["threadId"].as_str()), (Some("thread/resume"), Some("T")));
        assert_eq!(request["params"]["model"], "gpt-6.1-sol");
    }

    #[test]
    fn resume_uses_the_thread_id() {
        let mut d = driver(PolicyMode::AcceptEdits, Some("T"));
        d.note(&RunEvent::ProcessStarted { resume: true });
        let step = d.read(INIT_RESULT);
        assert_eq!(json_of(&step.write[0]), json!({"method": "initialized"}));
        assert_eq!(
            json_of(&step.write[1]),
            json!({"method": "thread/resume", "id": 2, "params": {
                "threadId": "T", "excludeTurns": true, "cwd": r"C:\work\codex-check", "approvalPolicy": "on-request", "sandbox": "workspace-write"}})
        );
        // The reply of a thread the session already knows reports `started` but not the id again.
        let mut known = driver(PolicyMode::Ask, Some(THREAD));
        known.note(&RunEvent::ProcessStarted { resume: true });
        known.read(INIT_RESULT);
        let step = known.read(RESUME_RESULT);
        assert!(matches!(&step.events[..], [RunEvent::Started { cli_version: Some(version), .. }] if version == "0.169.0"));
        assert_eq!(step.engine_session, None);
    }

    #[test]
    fn a_command_approval_round_trip() {
        let mut d = running();
        assert_eq!(
            d.read(ITEM_STARTED_COMMAND).events,
            vec![RunEvent::ToolUse { id: COMMAND.into(), name: "Shell".into(), summary: "Set-Content -LiteralPath as-shell.txt -Value hi".into() }]
        );
        let step = d.read(REQUEST_COMMAND);
        assert!(step.write.is_empty());
        let [RunEvent::ApprovalRequest { request_id, tool, summary, input, can_always, always_label }] = &step.events[..] else { panic!("{:?}", step.events) };
        assert_eq!((request_id.as_str(), tool.as_str(), *can_always, always_label), (COMMAND, "Shell", false, &None));
        assert_eq!(summary, "Set-Content -LiteralPath as-shell.txt -Value hi");
        assert_eq!(input["cwd"], r"C:\work\codex-check");
        assert_eq!(input["command"], "Set-Content -LiteralPath as-shell.txt -Value hi");
        let accept = r#"{"id":0,"result":{"decision":"accept"}}"#;
        assert_eq!(d.answer(COMMAND, REQUEST_COMMAND, Decision::Allow).as_deref(), Some(accept));
        assert_eq!(d.answer(COMMAND, REQUEST_COMMAND, Decision::AllowAlways).as_deref(), Some(accept));
        assert_eq!(d.answer(COMMAND, REQUEST_COMMAND, Decision::Withdrawn), None);
        assert_eq!(d.answer("exec-unknown", REQUEST_COMMAND, Decision::Allow), None);
        d.note(&RunEvent::ApprovalResolved { request_id: COMMAND.into(), decision: Decision::Allow });
        assert_eq!(d.answer(COMMAND, REQUEST_COMMAND, Decision::Allow), None, "answered once");
        assert!(empty(&d.read(RESOLVED)));
        assert_eq!(d.read(ITEM_COMPLETED_COMMAND).events, vec![RunEvent::ToolResult { id: COMMAND.into(), ok: true, summary: String::new() }]);

        // A second request, with the server's next id.
        d.read(ITEM_STARTED_DECLINED);
        assert!(matches!(&d.read(REQUEST_DECLINED).events[..], [RunEvent::ApprovalRequest { request_id, .. }] if request_id == DECLINED_COMMAND));
        assert_eq!(d.answer(DECLINED_COMMAND, REQUEST_DECLINED, Decision::Deny).as_deref(), Some(r#"{"id":2,"result":{"decision":"decline"}}"#));
        assert_eq!(
            d.read(ITEM_COMPLETED_DECLINED).events,
            vec![RunEvent::ToolResult { id: DECLINED_COMMAND.into(), ok: false, summary: "Declined".into() }]
        );
    }

    #[test]
    fn a_governed_memory_command_is_declined_without_asking() {
        let mut d = running();
        let request = r#"{"method":"item/commandExecution/requestApproval","id":7,"params":{"itemId":"exec-1","command":"python living_memory.py merge --payload-file p.json","cwd":"C:\\work\\codex-check","commandActions":[]}}"#;
        let step = d.read(request);
        assert_eq!(step.events, vec![RunEvent::Denied { tool: "Shell".into(), summary: GOVERNED.into() }]);
        assert_eq!(step.write, vec![r#"{"id":7,"result":{"decision":"decline"}}"#.to_string()]);
        assert_eq!(d.answer("exec-1", request, Decision::Allow), None, "nothing is open");
    }

    #[test]
    fn tool_results_can_be_read_back() {
        assert_eq!(Codex.tool_result(ITEM_COMPLETED_COMMAND, COMMAND), Some((true, String::new())));
        assert_eq!(Codex.tool_result(ITEM_COMPLETED_DECLINED, DECLINED_COMMAND), Some((false, String::new())));
        assert_eq!(Codex.tool_result(ITEM_COMPLETED_COMMAND, "exec-other"), None);
        assert_eq!(Codex.tool_result(ITEM_COMPLETED_PATCH, PATCH), None);
        assert_eq!(Codex.tool_result(ITEM_STARTED_COMMAND, COMMAND), None);
        assert_eq!(Codex.tool_result("not json", COMMAND), None);
        let printed = ITEM_COMPLETED_COMMAND.replace(r#""aggregatedOutput":null"#, r#""aggregatedOutput":"hi\n""#);
        assert_eq!(Codex.tool_result(&printed, COMMAND), Some((true, "hi\n".into())));
    }

    #[test]
    fn a_patch_approval_shows_the_change() {
        let mut d = running();
        let started = d.read(ITEM_STARTED_PATCH).events;
        assert_eq!(started, vec![RunEvent::ToolUse { id: PATCH.into(), name: "Edit".into(), summary: "add as-patch.txt".into() }]);
        let step = d.read(REQUEST_PATCH);
        let [RunEvent::ApprovalRequest { request_id, tool, summary, input, can_always, .. }] = &step.events[..] else { panic!("{:?}", step.events) };
        assert_eq!((request_id.as_str(), tool.as_str(), *can_always), (PATCH, "Edit", false));
        assert!(summary.contains("as-patch.txt"));
        assert_eq!(input["changes"][0]["diff"], "hi\n");
        assert_eq!(input["changes"][0]["kind"], json!({"type": "add"}));
        assert_eq!(d.answer(PATCH, REQUEST_PATCH, Decision::Allow).as_deref(), Some(r#"{"id":1,"result":{"decision":"accept"}}"#));
        assert_eq!(d.read(ITEM_COMPLETED_PATCH).events, vec![RunEvent::ToolResult { id: PATCH.into(), ok: true, summary: String::new() }]);
    }

    #[test]
    fn text_arrives_whole_and_deltas_are_ignored() {
        let mut d = running();
        assert!(empty(&d.read(DELTA)));
        assert_eq!(d.read(ITEM_COMPLETED_MESSAGE).events, vec![RunEvent::Text { text: "done.".into() }]);
        let blank = ITEM_COMPLETED_MESSAGE.replace(r#""text":"done.""#, r#""text":"  ""#);
        assert!(empty(&d.read(&blank)));
    }

    #[test]
    fn a_commentary_and_a_final_answer_with_one_id_are_two_texts() {
        // Section 4.12 item 9 says both carry one id; the recording has two ids, so make it one.
        let commentary_id = json_of(COMMENTARY_COMPLETED)["params"]["item"]["id"].as_str().unwrap().to_string();
        let final_id = json_of(ITEM_COMPLETED_MESSAGE)["params"]["item"]["id"].as_str().unwrap().to_string();
        let same_id = ITEM_COMPLETED_MESSAGE.replace(&final_id, &commentary_id);
        assert_ne!(same_id, ITEM_COMPLETED_MESSAGE);
        let mut d = running();
        let commentary = d.read(COMMENTARY_COMPLETED).events;
        let answer = d.read(&same_id).events;
        assert_eq!(commentary, vec![RunEvent::Text { text: "I will perform each step in order and skip any declined step.
".into() }]);
        assert_eq!(answer, vec![RunEvent::Text { text: "done.".into() }]);
        // The final answer is the result.
        assert_eq!(d.read(TURN_COMPLETED).turn.unwrap().result.as_deref(), Some("done."));
        // With the recorded ids, and a commentary that comes last, the result is still the final answer.
        let mut late = running();
        late.read(ITEM_COMPLETED_MESSAGE);
        late.read(COMMENTARY_COMPLETED);
        assert_eq!(late.read(TURN_COMPLETED).turn.unwrap().result.as_deref(), Some("done."));
        // Without a final answer, the last message.
        let mut only = running();
        only.read(COMMENTARY_COMPLETED);
        let result = only.read(TURN_COMPLETED).turn.unwrap().result;
        assert_eq!(result.as_deref(), Some("I will perform each step in order and skip any declined step.
"));
    }

    #[test]
    fn turn_completed_closes_the_turn() {
        let mut d = running();
        d.read(ITEM_COMPLETED_MESSAGE);
        d.read(ITEM_COMPLETED_DECLINED);
        let step = d.read(TURN_COMPLETED);
        assert!(step.events.is_empty() && step.write.is_empty());
        assert_eq!(
            step.turn,
            Some(Outcome { ok: true, duration_ms: Some(22090), result: Some("done.".into()), denials: 1, ..Outcome::default() })
        );
        assert!(d.interrupt().is_none(), "the turn is over");

        let stopped = running().read(TURN_INTERRUPTED).turn.unwrap();
        assert!(!stopped.ok);
        assert_eq!(stopped.reason.as_deref(), Some("Codex stopped the turn"));
        let failed = running().read(TURN_FAILED).turn.unwrap();
        assert!(!failed.ok);
        assert!(failed.reason.unwrap().contains("not supported when using Codex"));

        // A request still open when the turn ends is reported as withdrawn, first.
        let mut open = running();
        open.read(ITEM_STARTED_COMMAND);
        open.read(REQUEST_COMMAND);
        let step = open.read(TURN_COMPLETED);
        assert_eq!(step.events, vec![RunEvent::ApprovalResolved { request_id: COMMAND.into(), decision: Decision::Withdrawn }]);
        assert!(step.turn.is_some());
        // Another turn in the same process starts clean.
        open.read(TURN_STARTED);
        assert!(open.read(TURN_COMPLETED).events.is_empty());
    }

    #[test]
    fn a_turn_start_reply_after_turn_started_is_harmless() {
        let mut d = ready();
        assert!(empty(&d.read(TURN_STARTED)));
        assert!(empty(&d.read(TURN_START_REPLY)));
        let interrupt = json_of(&d.interrupt().expect("still in the turn"));
        assert_eq!(interrupt["method"], "turn/interrupt");
        assert_eq!((interrupt["params"]["threadId"].as_str(), interrupt["params"]["turnId"].as_str()), (Some(THREAD), Some(TURN)));
        assert!(empty(&d.read(INTERRUPT_REPLY)));
        assert!(d.read(TURN_COMPLETED).turn.is_some());
    }

    #[test]
    fn a_rejected_turn_start_fails_the_turn() {
        let mut d = ready();
        let sent = json_of(&d.send("hi")[0]);
        assert_eq!(sent["id"], 3);
        let reply = r#"{"id":3,"error":{"code":-32600,"message":"The 'nope' model is not supported."}}"#;
        let step = d.read(reply);
        let outcome = step.turn.expect("the turn ends");
        assert_eq!((outcome.ok, outcome.reason.as_deref()), (false, Some("The 'nope' model is not supported.")));
        assert!(step.events.is_empty() && step.write.is_empty() && !step.end_process, "the process stays usable");
        assert!(empty(&d.read(reply)), "the reply is only taken once");
        // The next message goes out under a new id and its turn runs as usual.
        assert_eq!(json_of(&d.send("again")[0])["id"], 4);
        assert!(empty(&d.read(TURN_STARTED)));
        assert!(d.read(TURN_COMPLETED).turn.is_some_and(|turn| turn.ok));
        // An error reply to anything but the turn/start in flight is not a rejected turn.
        let mut d = ready();
        d.send("hi");
        d.read(TURN_STARTED);
        assert!(empty(&d.read(r#"{"id":3,"error":{"message":"late"}}"#)));
        assert!(empty(&d.read(r#"{"id":11,"error":{"message":"no turn to interrupt"}}"#)));
    }

    #[test]
    fn a_rejected_turn_withdraws_the_open_requests() {
        let mut d = ready();
        d.send("hi");
        d.read(ITEM_STARTED_COMMAND);
        d.read(REQUEST_COMMAND);
        let step = d.read(r#"{"id":3,"error":{"message":"no"}}"#);
        assert_eq!(step.events, vec![RunEvent::ApprovalResolved { request_id: COMMAND.into(), decision: Decision::Withdrawn }]);
        assert!(step.turn.is_some_and(|turn| !turn.ok));
        assert!(d.answer(COMMAND, REQUEST_COMMAND, Decision::Allow).is_none());
    }

    #[test]
    fn interrupt_needs_a_running_turn() {
        let mut d = driver(PolicyMode::Ask, None);
        assert!(d.interrupt().is_none());
        let mut d = ready();
        assert!(d.interrupt().is_none());
        assert!(d.read(TURN_STARTED).write.is_empty(), "no Stop was asked for");
    }

    #[test]
    fn a_stop_before_the_turn_has_an_id_is_sent_when_codex_names_it() {
        // Stop during the handshake: the kept message starts a turn, and turn/started brings the interrupt.
        let mut d = driver(PolicyMode::Ask, None);
        d.note(&RunEvent::ProcessStarted { resume: false });
        d.open();
        d.send("hi");
        assert!(d.interrupt().is_none());
        d.read(INIT_RESULT);
        d.read(THREAD_RESULT);
        let step = d.read(TURN_STARTED);
        assert!(step.events.is_empty());
        let [line] = &step.write[..] else { panic!("{:?}", step.write) };
        let line = json_of(line);
        assert_eq!((line["method"].as_str(), line["params"]["turnId"].as_str()), (Some("turn/interrupt"), Some(TURN)));

        // Stop after turn/start was written: the reply names the turn first, and the interrupt goes out with it, once.
        let mut d = ready();
        d.send("hi");
        assert!(d.interrupt().is_none());
        let reply = TURN_START_REPLY.replace(r#""id":21"#, r#""id":3"#);
        let [line] = &d.read(&reply).write[..] else { panic!("the reply should carry the interrupt") };
        assert_eq!(json_of(line)["method"], "turn/interrupt");
        assert!(d.read(TURN_STARTED).write.is_empty());
    }

    #[test]
    fn unknown_requests_are_answered_and_noise_is_ignored() {
        let mut d = running();
        let step = d.read(r#"{"method":"item/tool/requestUserInput","id":5,"params":{}}"#);
        assert_eq!(step.events, vec![RunEvent::Denied { tool: "item/tool/requestUserInput".into(), summary: UNANSWERABLE.into() }]);
        assert_eq!(step.write.len(), 1);
        let error = json_of(&step.write[0]);
        assert_eq!(error["id"], 5);
        assert!(error["error"]["message"].is_string() && error.get("result").is_none());
        for noise in [THREAD_STATUS, TOKEN_USAGE, RATE_LIMITS, RESOLVED, ERROR, DELTA, "not json", "", "{}", "[]", r#"{"method":"something/new","params":{}}"#] {
            assert!(empty(&d.read(noise)), "{noise}");
        }
        assert!(d.interrupt().is_some(), "none of it ended the turn");
    }

    #[test]
    fn hooks_user_messages_and_reasoning_give_an_empty_step() {
        let mut d = ready();
        for line in [TURN_STARTED, HOOK_STARTED, HOOK_COMPLETED, USER_MESSAGE_STARTED, USER_MESSAGE_COMPLETED, REASONING_STARTED, REASONING_COMPLETED] {
            assert!(empty(&d.read(line)), "{line}");
        }
    }

    #[test]
    fn an_old_codex_is_refused() {
        let mut d = driver(PolicyMode::Ask, None);
        d.note(&RunEvent::ProcessStarted { resume: false });
        let old = INIT_RESULT.replace("hivemind/0.169.0", "hivemind/0.150.0");
        let step = d.read(&old);
        assert!(step.write.is_empty() && step.events.is_empty());
        let outcome = step.turn.unwrap();
        assert!(!outcome.ok && step.end_process, "the manager ends this process");
        assert_eq!(outcome.reason.as_deref(), Some("This Codex version is not supported for Chat. Use Terminal."));
        assert!(empty(&d.read(THREAD_RESULT)), "a process that is not usable stays unused");
        assert_eq!(agent_version("hivemind_spike/0.166.0 (Windows 10.0.26100; x86_64) WindowsTerminal (hivemind_spike; 0.0.1)"), Some((0, 166, 0)));
        assert_eq!(agent_version("hivemind/0.169.0-alpha.2 (Linux)"), Some((0, 169, 0)));
        assert_eq!(agent_version("hivemind (no version)"), None);
        assert_eq!(agent_version(""), None);
        // The oldest supported version is let through.
        let mut d = driver(PolicyMode::Ask, None);
        d.note(&RunEvent::ProcessStarted { resume: false });
        assert_eq!(d.read(&INIT_RESULT.replace("hivemind/0.169.0", "hivemind/0.166.0")).write.len(), 2);
    }

    #[test]
    fn a_refused_thread_fails_the_turn() {
        let mut d = driver(PolicyMode::Ask, Some("gone"));
        d.note(&RunEvent::ProcessStarted { resume: true });
        d.read(INIT_RESULT);
        let step = d.read(r#"{"id":2,"error":{"code":-32600,"message":"no rollout found for thread id gone"}}"#);
        assert_eq!(step.turn.unwrap().reason.as_deref(), Some("no rollout found for thread id gone"));
        assert!(step.write.is_empty() && step.events.is_empty() && step.end_process);
    }

    /// What the manager does with one session's driver and log, reduced to the calls that matter here.
    struct Rig {
        driver: Box<dyn Driver>,
        started: bool,
        records: Vec<Record>,
        events: Vec<RunEvent>,
        written: Vec<String>,
    }

    impl Rig {
        fn new() -> Rig {
            Rig { driver: driver(PolicyMode::Ask, None), started: false, records: vec![], events: vec![], written: vec![] }
        }

        fn feed(&mut self, record: Record) -> Step {
            let step = step_of(self.driver.as_mut(), &record, &mut self.started);
            self.records.push(record);
            self.events.extend(step.events.clone());
            self.written.extend(step.write.clone());
            step
        }

        fn event(&mut self, event: RunEvent) -> Step {
            self.feed(Record::Event { at: 0, event })
        }

        fn raw(&mut self, line: &str) -> Step {
            self.feed(Record::Raw { at: 0, raw: line.to_string() })
        }

        /// After `spawn`: the `processStarted` record, then what the driver opens with.
        fn start(&mut self, resume: bool) {
            self.event(RunEvent::ProcessStarted { resume });
            let lines = self.driver.open();
            self.written.extend(lines);
        }

        /// The `userMessage` record, then the lines that carry the message.
        fn say(&mut self, text: &str) {
            self.event(RunEvent::UserMessage { text: text.into(), context: vec![] });
            let lines = self.driver.send(text);
            self.written.extend(lines);
        }

        /// `answer`: the line first, then the `approvalResolved` record.
        fn answer(&mut self, item: &str, request: &str, decision: Decision) {
            let line = self.driver.answer(item, request, decision);
            self.written.extend(line);
            self.event(RunEvent::ApprovalResolved { request_id: item.into(), decision });
        }

        /// `Manager::session`: a fresh driver, the same records, `read` and `note` only.
        fn replay(&self) -> Vec<RunEvent> {
            let mut fresh = driver(PolicyMode::Ask, None);
            let mut started = false;
            self.records.iter().flat_map(|record| step_of(fresh.as_mut(), record, &mut started).events).collect()
        }
    }

    fn turned(wrote: &[String], method: &str) -> Vec<Value> {
        wrote.iter().map(|line| json_of(line)).filter(|line| line["method"] == method).collect()
    }

    #[test]
    fn replay_rebuilds_open_requests() {
        let mut live = Rig::new();
        live.start(false);
        live.say("go");
        for line in [INIT_RESULT, THREAD_RESULT, TURN_STARTED, ITEM_STARTED_COMMAND, REQUEST_COMMAND] {
            live.raw(line);
        }
        live.answer(COMMAND, REQUEST_COMMAND, Decision::Allow);
        for line in [ITEM_COMPLETED_COMMAND, ITEM_STARTED_DECLINED, REQUEST_DECLINED, TURN_COMPLETED] {
            live.raw(line);
        }
        let withdrawn = |events: &[RunEvent]| -> Vec<String> {
            events.iter().filter_map(|e| match e { RunEvent::ApprovalResolved { request_id, decision: Decision::Withdrawn } => Some(request_id.clone()), _ => None }).collect()
        };
        assert_eq!(withdrawn(&live.events), vec![DECLINED_COMMAND.to_string()], "only the request nobody answered");
        assert_eq!(live.replay(), live.events);
    }

    #[test]
    fn a_log_that_spans_two_processes_replays_the_same() {
        let mut live = Rig::new();
        live.start(false);
        live.say("first");
        live.raw(INIT_RESULT);
        live.raw(THREAD_RESULT);
        for line in [TURN_STARTED, ITEM_STARTED_COMMAND, REQUEST_COMMAND] {
            live.raw(line);
        }
        live.answer(COMMAND, REQUEST_COMMAND, Decision::Allow);
        for line in [ITEM_COMPLETED_COMMAND, TURN_COMPLETED] {
            live.raw(line);
        }
        let first_process = live.events.len();
        // The app is closed and started again; the user sends a message.
        live.start(true);
        live.say("second");
        live.raw(INIT_RESULT);
        live.raw(RESUME_RESULT);
        for line in [TURN_STARTED, ITEM_COMPLETED_MESSAGE, TURN_COMPLETED] {
            live.raw(line);
        }
        let started = |events: &[RunEvent]| events.iter().filter(|event| matches!(event, RunEvent::Started { .. })).count();
        assert_eq!((started(&live.events), started(&live.events[..first_process])), (1, 1), "the second process's started is dropped");
        assert_eq!(live.replay(), live.events);
        assert_eq!(live.events.iter().filter(|event| matches!(event, RunEvent::ProcessStarted { .. })).count(), 2);
        // The second process resumed the thread the first one printed, and wrote the waiting message once the thread was open.
        assert_eq!(turned(&live.written, "thread/start").len(), 1);
        let resumes = turned(&live.written, "thread/resume");
        assert_eq!(resumes.len(), 1);
        assert_eq!((resumes[0]["params"]["threadId"].as_str(), resumes[0]["params"]["excludeTurns"].as_bool()), (Some(THREAD), Some(true)));
        let prompts: Vec<_> = turned(&live.written, "turn/start").iter().map(|line| line["params"]["input"][0]["text"].as_str().unwrap().to_string()).collect();
        assert_eq!(prompts, ["first", "second"]);
        assert_eq!(turned(&live.written, "initialize").len(), 2);
    }

    #[test]
    fn a_process_that_died_with_an_open_request_withdraws_it_once() {
        let mut live = Rig::new();
        live.start(false);
        live.say("go");
        for line in [INIT_RESULT, THREAD_RESULT, TURN_STARTED, ITEM_STARTED_COMMAND, REQUEST_COMMAND] {
            live.raw(line);
        }
        // What the pump records when the process dies in the middle of the turn.
        live.event(RunEvent::TurnFinished { ok: false, reason: Some("died".into()), cost_usd: None, duration_ms: None, result: None, denials: 0, outcome: TurnEnd::Error });
        live.start(true);
        live.say("again");
        for line in [INIT_RESULT, RESUME_RESULT, TURN_STARTED, ITEM_COMPLETED_MESSAGE, TURN_COMPLETED] {
            live.raw(line);
        }
        assert!(!live.events.iter().any(|event| matches!(event, RunEvent::ApprovalResolved { .. })), "the dead process's request is not withdrawn by a later one");
        assert_eq!(live.replay(), live.events);
    }

    #[test]
    fn the_command_runs_the_app_server_with_the_session_environment() {
        let spec = |memory_root: Option<PathBuf>, program_args: Vec<String>| Spec {
            session_id: "00000000-0000-4000-8000-000000000001".into(),
            cwd: PathBuf::from("/work/app"),
            add_dirs: vec![],
            policy: Policy::Ask { allow: vec![] },
            plugin_dirs: vec![],
            budget_usd: 5.0,
            schema: None,
            program: "node".into(),
            program_args,
            resume: false,
            model: None,
            deny: vec![],
            isolated: false,
            strict_mcp: true,
            memory_root,
        };
        let env = |command: &Command, name: &str| command.get_envs().find(|(key, _)| *key == name).and_then(|(_, value)| value.map(|v| v.to_string_lossy().into_owned()));
        let command = Codex.command(&spec(Some(PathBuf::from("/stores/demo")), vec!["codex.js".into()]));
        assert_eq!(command.get_program(), "node");
        assert_eq!(command.get_args().collect::<Vec<_>>(), ["codex.js", "app-server"]);
        assert_eq!(command.get_current_dir(), Some(Path::new("/work/app")));
        assert_eq!(env(&command, "HIVEMIND_SESSION").as_deref(), Some("00000000-0000-4000-8000-000000000001"));
        assert_eq!(env(&command, "LIVING_MEMORY_ROOT").map(PathBuf::from), Some(PathBuf::from("/stores/demo")));
        let bare = Codex.command(&spec(None, vec![]));
        assert_eq!(bare.get_args().collect::<Vec<_>>(), ["app-server"]);
        assert_eq!(env(&bare, "LIVING_MEMORY_ROOT"), None);
        assert!(Codex.marks_process_start());
        assert_eq!(Codex.name(), "codex");
    }
}
