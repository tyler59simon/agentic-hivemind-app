//! Where to find Python and Living Memory. Environment variables override the saved settings,
//! which override the platform defaults that Living Memory's install.py uses.
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize, Clone, Default, Debug, PartialEq)]
pub struct Settings {
    /// Python interpreter (full path or a command on PATH).
    pub python: Option<String>,
    /// Path to living_memory.py.
    pub script: Option<String>,
    /// Store root; None lets Living Memory resolve its own (config pointer, env).
    pub root: Option<String>,
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

pub fn resolve(saved: &Settings, env: impl Fn(&str) -> Option<String>) -> Launch {
    let (program, args) = match pick(env("HIVEMIND_PYTHON"), &saved.python) {
        Some(python) => (python, vec![]),
        None if cfg!(windows) => ("py".into(), vec!["-3".into()]),
        None => ("python3".into(), vec![]),
    };
    Launch {
        program,
        args,
        script: pick(env("HIVEMIND_LM_SCRIPT"), &saved.script)
            .map(PathBuf::from)
            .unwrap_or_else(default_script),
        root: pick(env("HIVEMIND_LM_ROOT"), &saved.root).map(PathBuf::from),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_beats_saved_beats_default() {
        let saved = Settings { python: Some("C:/py.exe".into()), script: Some("saved.py".into()), root: None };
        let launch = resolve(&saved, |k| (k == "HIVEMIND_LM_SCRIPT").then(|| "env.py".to_string()));
        assert_eq!(launch.program, "C:/py.exe");
        assert!(launch.args.is_empty());
        assert_eq!(launch.script, PathBuf::from("env.py"));
        assert_eq!(launch.root, None);
    }

    #[test]
    fn blank_values_fall_through_to_defaults() {
        let saved = Settings { python: Some("  ".into()), ..Default::default() };
        let launch = resolve(&saved, |_| Some(String::new()));
        assert!(launch.script.ends_with("app/living_memory.py") || launch.script.ends_with("app\\living_memory.py"));
        assert_ne!(launch.program, "  ");
    }

    #[test]
    fn save_then_load_round_trips() {
        let dir = std::env::temp_dir().join(format!("hivemind-settings-{}", std::process::id()));
        let path = dir.join("settings.json");
        let value = Settings { python: Some("python3".into()), script: None, root: Some("/tmp/store".into()) };
        save(&path, &value).unwrap();
        assert_eq!(load(&path), value);
        std::fs::remove_dir_all(dir).ok();
    }
}
