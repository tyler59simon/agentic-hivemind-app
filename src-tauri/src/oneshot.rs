//! One tool-free Claude call that answers with JSON: print mode, no tools, plugins, settings, MCP servers or saved session, its
//! own system prompt, a JSON schema and a cost cap. The post-session reviewer and the executive workspace use it. Living Memory's
//! hooks stay out of the call (`LIVING_MEMORY_OFF=1`), the input has known credentials removed first, and every call is
//! reserved against the daily cap before it starts and settled at its real cost.
use crate::agent::events::clip;
use crate::learning::{redact, Ledger};
use serde_json::Value;
use std::path::Path;
use std::process::Command;
use std::time::Duration;

/// What one call is: who it is in error messages ("The reviewer"), the model alias, the system prompt, the schema of the
/// answer and the most it may spend.
pub struct Call<'a> {
    pub who: &'a str,
    pub model: &'a str,
    pub policy: &'a str,
    pub schema: Value,
    pub budget_usd: f64,
}

/// The command line, the same shape Living Memory's maintenance agent uses.
pub fn argv(call: &Call) -> Vec<String> {
    [
        "-p", "--output-format", "json", "--model", call.model, "--tools", "", "--safe-mode", "--strict-mcp-config", "--no-session-persistence",
        "--disable-slash-commands", "--system-prompt", call.policy,
    ]
    .iter()
    .map(|s| s.to_string())
    .chain(["--json-schema".to_string(), call.schema.to_string(), "--max-budget-usd".to_string(), format!("{:.2}", call.budget_usd)])
    .collect()
}

/// The CLI's JSON envelope: (structured answer, cost). A failed call still reports what it cost.
pub fn parse_envelope(who: &str, stdout: &str) -> (Result<Value, String>, Option<f64>) {
    let Ok(envelope) = serde_json::from_str::<Value>(stdout.trim()) else {
        return (Err(format!("{who} printed no JSON")), None);
    };
    let cost = envelope.get("total_cost_usd").and_then(Value::as_f64);
    if envelope.get("is_error") != Some(&Value::Bool(false)) || envelope.get("subtype").and_then(Value::as_str) != Some("success") {
        let why = match envelope.get("subtype").and_then(Value::as_str) {
            Some("error_max_budget_usd") => format!("{who} reached its spending cap"),
            _ => format!("{who} failed: {}", clip(envelope.get("result").and_then(Value::as_str).unwrap_or("no reason given"), 300)),
        };
        return (Err(why), cost);
    }
    (envelope.get("structured_output").cloned().ok_or(format!("{who} gave no structured answer")), cost)
}

/// Run one call in `dir` within the daily cap. `id` names the reservation.
#[allow(clippy::too_many_arguments)] // each argument is one independent part of the call
pub fn run(claude: &str, dir: &Path, ledger: &Ledger, cap: f64, id: &str, call: &Call, input: &str, timeout: Duration) -> (Result<Value, String>, Option<f64>) {
    let now = crate::agent::now_ms();
    if let Err(e) = ledger.reserve(id, call.budget_usd, cap, now) {
        return (Err(e), None);
    }
    let _ = std::fs::create_dir_all(dir);
    let mut command = Command::new(claude);
    command.args(argv(call)).current_dir(dir).env("LIVING_MEMORY_OFF", "1").env_remove("HIVEMIND_SESSION").env_remove("CLAUDECODE");
    let (answer, cost) = match crate::git::run_with_input(command, Some(&redact(input)), timeout) {
        Ok(ran) => parse_envelope(call.who, &ran.stdout),
        Err(e) => (Err(e), None),
    };
    let _ = ledger.settle(id, cost, crate::agent::now_ms());
    (answer, cost)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn call() -> Call<'static> {
        Call { who: "The helper", model: "sonnet", policy: "Answer.", schema: json!({"type": "object"}), budget_usd: 0.5 }
    }

    #[test]
    fn the_command_line_has_no_tools_and_a_cap() {
        let args = argv(&call());
        let at = |flag: &str| args.iter().position(|a| a == flag).map(|i| args[i + 1].clone());
        assert_eq!(at("--tools").as_deref(), Some(""));
        assert_eq!(at("--max-budget-usd").as_deref(), Some("0.50"));
        assert_eq!(at("--system-prompt").as_deref(), Some("Answer."));
        assert_eq!(at("--json-schema").as_deref(), Some("{\"type\":\"object\"}"));
    }

    #[test]
    fn the_envelope_is_read_strictly() {
        let ok = json!({"subtype": "success", "is_error": false, "total_cost_usd": 0.02, "structured_output": {"a": 1}});
        assert_eq!(parse_envelope("The helper", &ok.to_string()), (Ok(json!({"a": 1})), Some(0.02)));
        let capped = json!({"subtype": "error_max_budget_usd", "is_error": true, "total_cost_usd": 0.5});
        assert_eq!(parse_envelope("The helper", &capped.to_string()), (Err("The helper reached its spending cap".into()), Some(0.5)));
        assert_eq!(parse_envelope("The helper", "nope").0.unwrap_err(), "The helper printed no JSON");
        let empty = json!({"subtype": "success", "is_error": false});
        assert!(parse_envelope("The helper", &empty.to_string()).0.is_err());
    }

    #[test]
    fn a_spent_budget_stops_the_call_before_it_starts() {
        let dir = std::env::temp_dir().join(format!("hivemind-oneshot-{}", std::process::id()));
        let ledger = Ledger::new(dir.join("spend.json"));
        let (answer, cost) = run("no-such-program", &dir, &ledger, 0.1, "x", &call(), "hi", Duration::from_secs(1));
        assert!(answer.unwrap_err().contains("budget"));
        assert_eq!(cost, None);
        std::fs::remove_dir_all(&dir).ok();
    }
}
