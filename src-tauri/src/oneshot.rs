//! One tool-free Claude call that answers with JSON: print mode, no tools, plugins, settings, MCP servers or saved session, its
//! own system prompt, a JSON schema and a cost cap. The post-session reviewer and the executive workspace use it. Living Memory's
//! hooks stay out of the call (`LIVING_MEMORY_OFF=1`), the input has known credentials removed first, and every call is
//! reserved against the daily cap before it starts and settled at its real cost.
use crate::agent::events::clip;
use crate::learning::{redact, Ledger};
use serde_json::Value;
use std::path::Path;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
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

/// What a cancelled call answers.
pub const CANCELLED: &str = "Cancelled";

/// A run's cancel switch, shared by the run and whoever cancels it. Exactly one of the two wins: a cancel stops the run's
/// commit (the write that makes its result last), and once that commit is done a cancel is refused.
#[derive(Default)]
pub struct Cancel {
    flag: AtomicBool,
    committed: Mutex<bool>,
}

impl Cancel {
    pub fn flag(&self) -> &AtomicBool {
        &self.flag
    }

    pub fn is_set(&self) -> bool {
        self.flag.load(Ordering::Relaxed)
    }

    /// Cancel the run: `record` (saving the cancel) runs first and the run is told only once it succeeds. False when the run
    /// has committed already.
    pub fn cancel(&self, record: impl FnOnce() -> Result<(), String>) -> Result<bool, String> {
        let committed = self.committed.lock().unwrap();
        if *committed {
            return Ok(false);
        }
        record()?;
        self.flag.store(true, Ordering::Relaxed);
        Ok(true)
    }

    /// Do `write` unless the run was cancelled; once it succeeds, cancels are refused.
    pub fn commit<T>(&self, write: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
        let mut committed = self.committed.lock().unwrap();
        if self.is_set() {
            return Err(CANCELLED.into());
        }
        let done = write()?;
        *committed = true;
        Ok(done)
    }
}

/// Run one call in `dir` within the daily cap. `id` names the reservation. Setting `cancel` stops the call; one that had
/// started keeps its reservation, since what it spent is unknown.
#[allow(clippy::too_many_arguments)] // each argument is one independent part of the call
pub fn run(claude: &str, dir: &Path, ledger: &Ledger, cap: f64, id: &str, call: &Call, input: &str, timeout: Duration, cancel: Option<&AtomicBool>) -> (Result<Value, String>, Option<f64>) {
    let cancelled = || cancel.is_some_and(|c| c.load(Ordering::Relaxed));
    if cancelled() {
        return (Err(CANCELLED.into()), None);
    }
    let now = crate::agent::now_ms();
    if let Err(e) = ledger.reserve(id, call.budget_usd, cap, now) {
        return (Err(e), None);
    }
    // A cancel that came while the reservation waited for the ledger: nothing ran.
    if cancelled() {
        let _ = ledger.release(id, crate::agent::now_ms());
        return (Err(CANCELLED.into()), None);
    }
    let _ = std::fs::create_dir_all(dir);
    let mut command = Command::new(claude);
    command.args(argv(call)).current_dir(dir).env("LIVING_MEMORY_OFF", "1").env_remove("HIVEMIND_SESSION").env_remove("CLAUDECODE");
    let ran = crate::git::run_cancellable(command, Some(&redact(input)), timeout, cancel);
    // A call that never started costs nothing; one that ran (even into a timeout) is charged what it reports, else its
    // whole reservation.
    let (answer, cost, recorded) = match ran {
        Ok(ran) => {
            let (answer, cost) = outcome(call.who, ran.status.success(), &ran.stdout);
            (answer, cost, ledger.settle(id, cost, crate::agent::now_ms()))
        }
        Err(crate::git::Failure::NotStarted(e)) => (Err(e), None, ledger.release(id, crate::agent::now_ms())),
        Err(crate::git::Failure::Stopped(e)) => (Err(e), None, ledger.settle(id, None, crate::agent::now_ms())),
    };
    match (recorded, answer) {
        (Ok(()), answer) => (answer, cost),
        (Err(e), Ok(_)) => (Err(format!("{} answered, but its cost could not be recorded in the daily budget: {e}", call.who)), cost),
        (Err(e), Err(first)) => (Err(format!("{first} (and its cost could not be recorded in the daily budget: {e})")), cost),
    }
}

/// The answer of a call that ran: its envelope, and a non-zero exit is a failure even when the envelope claims success.
fn outcome(who: &str, exit_ok: bool, stdout: &str) -> (Result<Value, String>, Option<f64>) {
    let (answer, cost) = parse_envelope(who, stdout);
    match answer {
        Ok(_) if !exit_ok => (Err(format!("{who} exited with an error")), cost),
        answer => (answer, cost),
    }
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
        let (answer, cost) = run("no-such-program", &dir, &ledger, 0.1, "x", &call(), "hi", Duration::from_secs(1), None);
        assert!(answer.unwrap_err().contains("budget"));
        assert_eq!(cost, None);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_call_that_never_starts_is_not_charged() {   // EXEC-6
        let dir = std::env::temp_dir().join(format!("hivemind-oneshot-start-{}", std::process::id()));
        let ledger = Ledger::new(dir.join("spend.json"));
        let (answer, cost) = run("no-such-program", &dir, &ledger, 1.0, "x", &call(), "hi", Duration::from_secs(5), None);
        assert!(answer.unwrap_err().starts_with(crate::git::COULD_NOT_RUN));
        assert_eq!(cost, None);
        assert!(ledger.used(crate::agent::now_ms()).abs() < 1e-9, "the old code charged the whole $0.50");
        // Cancelled before it starts: no call and no reservation (EXEC-5).
        let cancel = AtomicBool::new(true);
        let (answer, _) = run("no-such-program", &dir, &ledger, 1.0, "y", &call(), "hi", Duration::from_secs(5), Some(&cancel));
        assert_eq!(answer.unwrap_err(), CANCELLED);
        assert!(ledger.used(crate::agent::now_ms()).abs() < 1e-9);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_cancel_and_a_commit_exclude_each_other() {   // Codex review of 74bba49
        let first = Cancel::default();
        assert_eq!(first.commit(|| Ok(1)), Ok(1));
        assert_eq!(first.cancel(|| Ok(())), Ok(false), "a committed run cannot be cancelled");
        // A cancel that could not be saved does not stop the run (Codex re-review of 61a3474).
        let unsaved = Cancel::default();
        assert!(unsaved.cancel(|| Err("rename denied".into())).is_err());
        assert!(!unsaved.is_set());
        let second = Cancel::default();
        assert_eq!(second.cancel(|| Ok(())), Ok(true));
        let mut wrote = false;
        assert_eq!(second.commit(|| { wrote = true; Ok(()) }).unwrap_err(), CANCELLED);
        assert!(!wrote, "a cancelled run writes nothing");
        let third = Cancel::default();
        assert!(third.commit(|| Err::<(), _>("disk full".into())).is_err());
        assert_eq!(third.cancel(|| Ok(())), Ok(true), "a failed commit can still be cancelled");
    }

    #[test]
    fn a_non_zero_exit_is_a_failure() {   // EXEC-6
        let ok = json!({"subtype": "success", "is_error": false, "total_cost_usd": 0.02, "structured_output": {"a": 1}}).to_string();
        assert_eq!(outcome("The helper", true, &ok), (Ok(json!({"a": 1})), Some(0.02)));
        assert_eq!(outcome("The helper", false, &ok), (Err("The helper exited with an error".into()), Some(0.02)), "the cost is still counted");
        let capped = json!({"subtype": "error_max_budget_usd", "is_error": true, "total_cost_usd": 0.5}).to_string();
        assert_eq!(outcome("The helper", false, &capped), (Err("The helper reached its spending cap".into()), Some(0.5)));
    }
}
