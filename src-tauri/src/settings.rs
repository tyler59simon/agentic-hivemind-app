//! Where to find Python and Living Memory. Environment variables override the saved settings,
//! which override the platform defaults that Living Memory's install.py uses.
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize, Clone, Default, Debug, PartialEq)]
pub struct Settings {
    /// Python interpreter (full path or a command on PATH).
    pub python: Option<String>,
    /// Path to living_memory.py.
    pub script: Option<String>,
    /// Store root; None lets Living Memory resolve its own (config pointer, env).
    pub root: Option<String>,
    /// Global hotkey for quick capture; None means the default, "" turns it off.
    pub capture_shortcut: Option<String>,
    /// Closing the main window hides it to the tray (default on) so the hotkey keeps working.
    pub close_to_tray: Option<bool>,
    /// The Claude Code program for agent sessions; None looks in the usual places.
    pub claude_path: Option<String>,
    /// The Codex program for terminals and Codex sessions; None looks in the usual places.
    pub codex_path: Option<String>,
    /// Spending limit for one agent session, in US dollars; None means the default.
    pub agent_budget_usd: Option<f64>,
    /// Folder of the Architecture Suite plugin, for when Claude Code does not have it installed.
    pub architecture_suite_plugin: Option<String>,
    /// Folders the user picked with the native dialog, for sessions outside a project. Changed only by `folder_pick` and
    /// `folder_forget`.
    #[serde(default)]
    pub other_folders: Option<Vec<String>>,
    /// Commands agent sessions may run without asking, per project slug (for example `npm test`). Checked in Rust before use.
    #[serde(default)]
    pub allowed_commands: Option<BTreeMap<String, Vec<String>>>,
    /// Whether finished sessions are reviewed for knowledge and skills worth keeping (default on).
    #[serde(default)]
    pub learning_reviewer: Option<bool>,
    /// The most the reviewer and the executive calls (with the commit reviews and briefings automations ask for) may spend
    /// in one day, in US dollars; None means the default.
    #[serde(default)]
    pub learning_daily_usd: Option<f64>,
    /// The most the sessions and wiki rebuilds automations start may spend in one day, in US dollars; None means the default.
    #[serde(default)]
    pub automation_daily_usd: Option<f64>,
    /// The most one reviewer call may spend, in US dollars; None means the default.
    #[serde(default)]
    pub review_call_usd: Option<f64>,
    /// The most each executive call may spend, in US dollars, by call (the names in EXECUTIVE_CALLS); a call left out uses
    /// its default.
    #[serde(default)]
    pub executive_call_usd: Option<BTreeMap<String, f64>>,
    /// Whether reviewed patches to a well-used skill are published without asking (default off).
    #[serde(default)]
    pub skills_auto_patch: Option<bool>,
    /// An architecture-rules/v1 file per system slug, for the drift check. Checked in Rust before use.
    #[serde(default)]
    pub architecture_rules: Option<BTreeMap<String, String>>,
    /// Engines the user hid from the interface ("claude", "codex"). Strings, so an unknown value never breaks loading.
    #[serde(default)]
    pub hidden_engines: Option<Vec<String>>,
    /// Whether Claude calls run although Claude Code managed policy is deployed (default off): the executive chat, the reviewer
    /// and the one-shot calls are refused otherwise. Managed hooks then run in them.
    #[serde(default)]
    pub claude_under_managed_policy: Option<bool>,
}

pub const DEFAULT_CAPTURE_SHORTCUT: &str = "CommandOrControl+Alt+M";
pub const DEFAULT_AGENT_BUDGET_USD: f64 = 5.0;
pub const DEFAULT_LEARNING_DAILY_USD: f64 = 1.0;
pub const DEFAULT_AUTOMATION_DAILY_USD: f64 = 5.0;
pub const DEFAULT_REVIEW_CALL_USD: f64 = 0.25;
/// The executive workspace's calls and the most each may spend by default.
pub const EXECUTIVE_CALLS: [(&str, f64); 2] = [("brief", 0.5), ("extract", 0.25)];

/// A daily cap as saved: zero or more; anything else is the default.
fn daily(saved: Option<f64>, default: f64) -> f64 {
    saved.filter(|usd| usd.is_finite() && *usd >= 0.0).unwrap_or(default)
}

/// One call's limit as saved: at least a cent (a call with no money cannot run; the daily cap turns calls off), else the
/// default, and never more than the daily cap it draws from, so a call can always be afforded on a fresh day. Whole cents,
/// since the CLI is given the limit in cents and the reservation must match it.
fn per_call(saved: Option<f64>, default: f64, cap: f64) -> f64 {
    let cents = |usd: f64| (usd * 100.0).round() / 100.0;
    let usd = saved.filter(|usd| usd.is_finite() && cents(*usd) >= 0.01).map_or(default, cents);
    if cap > 0.0 { usd.min(cap.max(0.01)) } else { usd }
}

impl Settings {
    /// The spending limit to give an agent session.
    pub fn agent_budget_usd(&self) -> f64 {
        self.agent_budget_usd.filter(|usd| usd.is_finite() && *usd > 0.0).unwrap_or(DEFAULT_AGENT_BUDGET_USD)
    }

    /// The commands a project allows, as saved (each is checked again where it becomes a rule).
    pub fn allowed_commands(&self, project: &str) -> Vec<String> {
        self.allowed_commands.as_ref().and_then(|all| all.get(project)).cloned().unwrap_or_default()
    }

    pub fn learning_reviewer(&self) -> bool {
        self.learning_reviewer.unwrap_or(true)
    }

    /// The daily cap for the reviewer and the executive calls; zero turns them off.
    pub fn learning_daily_usd(&self) -> f64 {
        daily(self.learning_daily_usd, DEFAULT_LEARNING_DAILY_USD)
    }

    /// The daily cap for the sessions and wiki rebuilds automations start; zero turns them off. Before this cap existed, a
    /// learning cap of zero also stopped these automations, so a settings file from then keeps them stopped.
    pub fn automation_daily_usd(&self) -> f64 {
        let off_before = self.automation_daily_usd.is_none() && self.learning_daily_usd == Some(0.0);
        if off_before { 0.0 } else { daily(self.automation_daily_usd, DEFAULT_AUTOMATION_DAILY_USD) }
    }

    /// The most one reviewer call may spend.
    pub fn review_call_usd(&self) -> f64 {
        per_call(self.review_call_usd, DEFAULT_REVIEW_CALL_USD, self.learning_daily_usd())
    }

    /// The most each executive call may spend, for every name in EXECUTIVE_CALLS.
    pub fn executive_calls_usd(&self) -> BTreeMap<String, f64> {
        let saved = |name: &str| self.executive_call_usd.as_ref().and_then(|all| all.get(name)).copied();
        EXECUTIVE_CALLS.iter().map(|(name, default)| (name.to_string(), per_call(saved(name), *default, self.learning_daily_usd()))).collect()
    }

    pub fn architecture_rules(&self, system: &str) -> Option<std::path::PathBuf> {
        self.architecture_rules.as_ref()?.get(system).filter(|p| !p.trim().is_empty()).map(std::path::PathBuf::from)
    }

    pub fn skills_auto_patch(&self) -> bool {
        self.skills_auto_patch.unwrap_or(false)
    }

    pub fn claude_under_managed_policy(&self) -> bool {
        self.claude_under_managed_policy.unwrap_or(false)
    }

    /// Whether the user keeps the engine shown (default: both are).
    pub fn shows(&self, engine: crate::agent::Engine) -> bool {
        let name = match engine {
            crate::agent::Engine::Claude => "claude",
            crate::agent::Engine::Codex => "codex",
        };
        !self.hidden_engines.iter().flatten().any(|h| h == name)
    }

    /// The hotkey to register, or None when the user turned it off.
    pub fn capture_shortcut(&self) -> Option<String> {
        match self.capture_shortcut.as_deref().map(str::trim) {
            None => Some(DEFAULT_CAPTURE_SHORTCUT.to_string()),
            Some("") => None,
            Some(s) => Some(s.to_string()),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Launch {
    pub program: String,
    pub args: Vec<String>,
    pub script: PathBuf,
    pub root: Option<PathBuf>,
}

pub fn load(path: &Path) -> Settings {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

pub fn save(path: &Path, settings: &Settings) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&temp, path).map_err(|e| e.to_string())
}

fn default_script() -> PathBuf {
    let base = if cfg!(windows) {
        dirs::data_local_dir().unwrap_or_default().join("agentic-living-memory")
    } else {
        dirs::home_dir().unwrap_or_default().join(".local/lib/agentic-living-memory")
    };
    base.join("app").join("living_memory.py")
}

fn pick(env: Option<String>, saved: &Option<String>) -> Option<String> {
    env.filter(|v| !v.trim().is_empty())
        .or_else(|| saved.clone().filter(|v| !v.trim().is_empty()))
}

/// The Python that Living Memory's installer ran under, from the ownership record it writes beside the script.
/// Its hooks run that Python too, so Hivemind and the hooks use the same one.
fn recorded_python(script: &Path) -> Option<String> {
    let text = std::fs::read_to_string(script.parent()?.join(".core-ownership-v1.json")).ok()?;
    let record: serde_json::Value = serde_json::from_str(&text).ok()?;
    let python = record.get("interpreter")?.as_str()?.trim();
    (!python.is_empty() && Path::new(python).is_file()).then(|| python.to_string())
}

pub fn resolve(saved: &Settings, env: impl Fn(&str) -> Option<String>) -> Launch {
    let script = pick(env("HIVEMIND_LM_SCRIPT"), &saved.script)
        .map(PathBuf::from)
        .unwrap_or_else(default_script);
    let (program, args) = match pick(env("HIVEMIND_PYTHON"), &saved.python).or_else(|| recorded_python(&script)) {
        Some(python) => (python, vec![]),
        None if cfg!(windows) => ("py".into(), vec!["-3".into()]),
        None => ("python3".into(), vec![]),
    };
    Launch { program, args, script, root: pick(env("HIVEMIND_LM_ROOT"), &saved.root).map(PathBuf::from) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_beats_saved_beats_default() {
        let saved = Settings { python: Some("C:/py.exe".into()), script: Some("saved.py".into()), ..Default::default() };
        let launch = resolve(&saved, |k| (k == "HIVEMIND_LM_SCRIPT").then(|| "env.py".to_string()));
        assert_eq!(launch.program, "C:/py.exe");
        assert!(launch.args.is_empty());
        assert_eq!(launch.script, PathBuf::from("env.py"));
        assert_eq!(launch.root, None);
    }

    #[test]
    fn the_python_living_memory_recorded_comes_after_env_and_saved() {   // REG-4
        let dir = std::env::temp_dir().join(format!("hivemind-recorded-python-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let python = dir.join("python.exe");
        std::fs::write(&python, b"").unwrap();
        let script = dir.join("living_memory.py").to_string_lossy().into_owned();
        let record = |value: &str| std::fs::write(dir.join(".core-ownership-v1.json"), value).unwrap();
        let saved = Settings { script: Some(script.clone()), ..Default::default() };
        let fallback = if cfg!(windows) { "py" } else { "python3" };

        record(&serde_json::json!({ "interpreter": python }).to_string());
        assert_eq!(resolve(&saved, |_| None).program, python.to_string_lossy());
        assert!(resolve(&saved, |_| None).args.is_empty());
        let mine = Settings { python: Some("C:/mine.exe".into()), ..saved.clone() };
        assert_eq!(resolve(&mine, |_| None).program, "C:/mine.exe");
        assert_eq!(resolve(&saved, |k| (k == "HIVEMIND_PYTHON").then(|| "env.exe".to_string())).program, "env.exe");

        record(&serde_json::json!({ "interpreter": dir.join("gone.exe") }).to_string());
        assert_eq!(resolve(&saved, |_| None).program, fallback, "a recorded Python that no longer exists");
        record(r#"{"schema": "living-memory-core-ownership-v1"}"#);
        assert_eq!(resolve(&saved, |_| None).program, fallback, "a record from before the field");
        record("not json");
        assert_eq!(resolve(&saved, |_| None).program, fallback);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn blank_values_fall_through_to_defaults() {
        let saved = Settings { python: Some("  ".into()), ..Default::default() };
        let launch = resolve(&saved, |_| Some(String::new()));
        assert!(launch.script.ends_with("app/living_memory.py") || launch.script.ends_with("app\\living_memory.py"));
        assert_ne!(launch.program, "  ");
    }

    #[test]
    fn capture_shortcut_defaults_and_can_be_turned_off() {
        assert_eq!(Settings::default().capture_shortcut().as_deref(), Some(DEFAULT_CAPTURE_SHORTCUT));
        assert_eq!(Settings { capture_shortcut: Some(" ".into()), ..Default::default() }.capture_shortcut(), None);
        assert_eq!(Settings { capture_shortcut: Some("Ctrl+Shift+K".into()), ..Default::default() }.capture_shortcut().as_deref(), Some("Ctrl+Shift+K"));
        // Settings files from before these fields existed still load.
        let old: Settings = serde_json::from_str(r#"{"python":null,"script":null,"root":null}"#).unwrap();
        assert_eq!(old.close_to_tray, None);
        assert_eq!(old.claude_under_managed_policy, None);
        assert!(!old.claude_under_managed_policy(), "off unless the user turns it on");
        assert_eq!((old.claude_path, old.agent_budget_usd, old.architecture_suite_plugin), (None, None, None));
        assert_eq!(old.codex_path, None);
        assert_eq!((old.allowed_commands, old.learning_reviewer, old.learning_daily_usd, old.skills_auto_patch), (None, None, None, None));
        assert_eq!(old.hidden_engines, None);
        assert_eq!((old.automation_daily_usd, old.review_call_usd, old.executive_call_usd), (None, None, None));
    }

    #[test]
    fn every_budget_has_a_default_and_takes_the_users_value() {
        let defaults = Settings::default();
        assert_eq!((defaults.learning_daily_usd(), defaults.automation_daily_usd(), defaults.review_call_usd()), (1.0, 5.0, 0.25));
        let calls = defaults.executive_calls_usd();
        assert_eq!(calls.len(), 2);
        assert_eq!((calls["brief"], calls["extract"]), (0.5, 0.25));

        // Daily caps: zero turns spending off; a bad value is the default.
        let caps = |usd: Option<f64>| {
            let s = Settings { learning_daily_usd: usd, automation_daily_usd: usd, ..Default::default() };
            (s.learning_daily_usd(), s.automation_daily_usd())
        };
        assert_eq!(caps(Some(0.0)), (0.0, 0.0));
        assert_eq!(caps(Some(7.5)), (7.5, 7.5));
        assert_eq!(caps(Some(-1.0)), (1.0, 5.0));
        assert_eq!(caps(Some(f64::NAN)), (1.0, 5.0));

        // Per-call limits: more than zero, else the default; never above the daily cap they draw from.
        let mut executive = BTreeMap::new();
        executive.insert("brief".to_string(), 0.8);
        executive.insert("extract".to_string(), 0.0);
        executive.insert("unknown".to_string(), 9.0);
        // A limit saved for a call that no longer exists (drafting and style learning were removed) is ignored too.
        executive.insert("draft".to_string(), 9.0);
        let s = Settings { review_call_usd: Some(0.4), executive_call_usd: Some(executive), learning_daily_usd: Some(2.0), ..Default::default() };
        assert_eq!(s.review_call_usd(), 0.4);
        let calls = s.executive_calls_usd();
        assert_eq!((calls["brief"], calls["extract"], calls.len()), (0.8, 0.25, 2), "zero is the default; an unknown call is ignored");
        let low_cap = Settings { review_call_usd: Some(0.4), learning_daily_usd: Some(0.3), ..s.clone() };
        assert_eq!((low_cap.review_call_usd(), low_cap.executive_calls_usd()["brief"]), (0.3, 0.3));
        let off = Settings { learning_daily_usd: Some(0.0), ..s };
        assert_eq!(off.review_call_usd(), 0.4, "a zero cap turns calls off at the ledger, not here");
        // Whole cents, as the CLI is given them; under a cent is the default (Codex review R7-2).
        let cents = |usd: f64| Settings { review_call_usd: Some(usd), ..Default::default() }.review_call_usd();
        assert_eq!((cents(0.126), cents(0.004), cents(0.006)), (0.13, 0.25, 0.01));
    }

    #[test]
    fn a_learning_cap_of_zero_from_before_the_automation_cap_keeps_automations_off() {   // Codex review R7-1
        let old: Settings = serde_json::from_str(r#"{"python":null,"script":null,"root":null,"learning_daily_usd":0.0}"#).unwrap();
        assert_eq!(old.automation_daily_usd(), 0.0);
        // Once the user sets the automation cap, it is theirs.
        assert_eq!(Settings { automation_daily_usd: Some(3.0), ..old.clone() }.automation_daily_usd(), 3.0);
        assert_eq!(Settings { learning_daily_usd: Some(2.0), ..old }.automation_daily_usd(), 5.0);
    }

    #[test]
    fn engines_are_shown_unless_hidden() {
        use crate::agent::Engine;
        let default = Settings::default();
        assert!(default.shows(Engine::Claude) && default.shows(Engine::Codex));
        let hidden = Settings { hidden_engines: Some(vec!["codex".into(), "gemini".into()]), ..Default::default() };
        assert!(hidden.shows(Engine::Claude));
        assert!(!hidden.shows(Engine::Codex));
        // An unknown name loads and is ignored.
        let file: Settings = serde_json::from_str(r#"{"python":null,"script":null,"root":null,"hidden_engines":["other"]}"#).unwrap();
        assert!(file.shows(Engine::Claude) && file.shows(Engine::Codex));
    }

    #[test]
    fn allowed_commands_are_per_project() {
        assert!(Settings::default().allowed_commands("pay").is_empty());
        let mut commands = BTreeMap::new();
        commands.insert("pay".to_string(), vec!["npm test".to_string()]);
        let saved = Settings { allowed_commands: Some(commands), ..Default::default() };
        assert_eq!(saved.allowed_commands("pay"), vec!["npm test".to_string()]);
        assert!(saved.allowed_commands("other").is_empty());
    }

    #[test]
    fn agent_budget_defaults_unless_positive() {
        let with = |usd: Option<f64>| Settings { agent_budget_usd: usd, ..Default::default() }.agent_budget_usd();
        assert_eq!(with(None), DEFAULT_AGENT_BUDGET_USD);
        assert_eq!(with(Some(0.0)), DEFAULT_AGENT_BUDGET_USD);
        assert_eq!(with(Some(-2.0)), DEFAULT_AGENT_BUDGET_USD);
        assert_eq!(with(Some(f64::NAN)), DEFAULT_AGENT_BUDGET_USD);
        assert_eq!(with(Some(12.5)), 12.5);
    }

    #[test]
    fn save_then_load_round_trips() {
        let dir = std::env::temp_dir().join(format!("hivemind-settings-{}", std::process::id()));
        let path = dir.join("settings.json");
        let value = Settings { python: Some("python3".into()), script: None, root: Some("/tmp/store".into()), hidden_engines: Some(vec!["claude".into()]), ..Default::default() };
        save(&path, &value).unwrap();
        assert_eq!(load(&path), value);
        std::fs::remove_dir_all(dir).ok();
    }
}
