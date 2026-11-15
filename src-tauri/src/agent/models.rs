//! The models and reasoning efforts each engine offers. Claude Code's are fixed; Codex's come from its own
//! `codex debug models` (cached for ten minutes), else the file Codex keeps, and its defaults from `~/.codex/config.toml`
//! (read only, two top-level keys).
use super::Engine;
use crate::settings::Settings;
use serde::Serialize;
use serde_json::Value;
use std::path::Path;
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const CACHE_FOR: Duration = Duration::from_secs(600);
const ASK_CODEX: Duration = Duration::from_secs(15);
/// `claude --effort` choices (Claude Code 2.1.325).
const CLAUDE_EFFORTS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];
const CLAUDE_MODELS: [(&str, &str); 4] = [("fable", "Fable"), ("opus", "Opus"), ("sonnet", "Sonnet"), ("haiku", "Haiku")];

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    pub label: String,
    pub efforts: Vec<String>,
    pub default_effort: Option<String>,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentModels {
    pub models: Vec<ModelInfo>,
    pub default_model: Option<String>,
    pub default_effort: Option<String>,
    /// Why the list is empty, for the Start screen.
    pub note: Option<String>,
}

fn claude_models() -> AgentModels {
    let efforts: Vec<String> = CLAUDE_EFFORTS.iter().map(|e| e.to_string()).collect();
    AgentModels {
        models: CLAUDE_MODELS
            .iter()
            .map(|(id, label)| ModelInfo { id: id.to_string(), label: label.to_string(), efforts: efforts.clone(), default_effort: None })
            .collect(),
        ..Default::default()
    }
}

/// The picker entries in the JSON `codex debug models` prints (and `models_cache.json` holds): those listed to users.
pub fn parse_models(json: &str) -> Result<Vec<ModelInfo>, String> {
    let value: Value = serde_json::from_str(json).map_err(|e| format!("The model list is not JSON: {e}"))?;
    let list = value.get("models").and_then(Value::as_array).ok_or("The model list has no models")?;
    let text = |v: &Value, key: &str| v.get(key).and_then(Value::as_str).map(str::to_string);
    Ok(list
        .iter()
        .filter(|m| m.get("visibility").and_then(Value::as_str) == Some("list"))
        .filter_map(|m| {
            let id = text(m, "slug").filter(|id| !id.is_empty())?;
            let efforts = m
                .get("supported_reasoning_levels")
                .and_then(Value::as_array)
                .map(|levels| levels.iter().filter_map(|l| text(l, "effort")).collect())
                .unwrap_or_default();
            Some(ModelInfo { label: text(m, "display_name").unwrap_or_else(|| id.clone()), id, efforts, default_effort: text(m, "default_reasoning_level") })
        })
        .collect())
}

/// The top-level `model` and `model_reasoning_effort` of a Codex config file: lines before the first `[table]` header.
pub fn config_defaults(text: &str) -> (Option<String>, Option<String>) {
    let (mut model, mut effort) = (None, None);
    for line in text.lines().map(str::trim) {
        if line.starts_with('[') {
            break;
        }
        let Some((key, value)) = line.split_once('=') else { continue };
        let slot = match key.trim() {
            "model" => &mut model,
            "model_reasoning_effort" => &mut effort,
            _ => continue,
        };
        let value = value.trim();
        let quote = value.chars().next().filter(|c| matches!(c, '"' | '\''));
        let inner = quote.and_then(|q| value[1..].split_once(q)).map(|(inner, _)| inner);
        *slot = inner.filter(|v| !v.is_empty()).map(str::to_string);
    }
    (model, effort)
}

fn ask_codex(saved: &Settings) -> Result<Vec<ModelInfo>, String> {
    let cli = crate::term::launch::codex(saved)?;
    let mut command = Command::new(&cli.program);
    command.args(&cli.args).args(["debug", "models"]);
    let text = crate::git::run_with_timeout(command, ASK_CODEX)?;
    parse_models(&text)
}

fn read_cache_file(dir: &Path) -> Result<Vec<ModelInfo>, String> {
    let text = std::fs::read_to_string(dir.join("models_cache.json")).map_err(|e| e.to_string())?;
    parse_models(&text)
}

static CODEX_CACHE: Mutex<Option<(Instant, Vec<ModelInfo>)>> = Mutex::new(None);

fn codex_models(saved: &Settings) -> AgentModels {
    let dir = dirs::home_dir().map(|home| home.join(".codex"));
    let (default_model, default_effort) =
        dir.as_ref().and_then(|d| std::fs::read_to_string(d.join("config.toml")).ok()).map(|t| config_defaults(&t)).unwrap_or_default();
    let cached = CODEX_CACHE.lock().unwrap().as_ref().filter(|(at, _)| at.elapsed() < CACHE_FOR).map(|(_, models)| models.clone());
    let found = match cached {
        Some(models) => Ok(models),
        None => ask_codex(saved).inspect(|models| *CODEX_CACHE.lock().unwrap() = Some((Instant::now(), models.clone()))).or_else(|error| {
            // The file Codex keeps is the fallback; it is not cached, so a later call asks the command again.
            dir.as_deref().ok_or(error.clone()).and_then(read_cache_file).map_err(|_| error)
        }),
    };
    match found {
        Ok(models) => AgentModels { models, default_model, default_effort, note: None },
        Err(error) => AgentModels { models: vec![], default_model, default_effort, note: Some(format!("Codex's model list is not available: {error}")) },
    }
}

/// The models and efforts `engine` offers now.
pub fn list(engine: Engine, saved: &Settings) -> AgentModels {
    match engine {
        Engine::Claude => claude_models(),
        Engine::Codex => codex_models(saved),
    }
}

/// Refuse a model or effort the engine does not list. Both are optional: None leaves the choice to the CLI.
pub fn check(available: &AgentModels, model: Option<&str>, effort: Option<&str>) -> Result<(), String> {
    let chosen = match model {
        Some(id) => {
            if available.models.is_empty() {
                return Err(available.note.clone().unwrap_or_else(|| "No models are available".into()));
            }
            Some(available.models.iter().find(|m| m.id == id).ok_or_else(|| format!("Unknown model: {id}"))?)
        }
        None => available.default_model.as_deref().and_then(|id| available.models.iter().find(|m| m.id == id)),
    };
    let Some(effort) = effort else { return Ok(()) };
    let known = match chosen {
        Some(m) => m.efforts.iter().any(|e| e == effort),
        None => available.models.iter().any(|m| m.efforts.iter().any(|e| e == effort)),
    };
    if known { Ok(()) } else { Err(format!("Unknown effort: {effort}")) }
}

#[cfg(test)]
mod tests {
    use super::*;

    const JSON: &str = r#"{"models":[
        {"slug":"gpt-a","display_name":"GPT-A","visibility":"list","default_reasoning_level":"low",
         "supported_reasoning_levels":[{"effort":"low","description":"x"},{"effort":"high","description":"y"}],"base_instructions":"long"},
        {"slug":"gpt-hidden","display_name":"Hidden","visibility":"hide","supported_reasoning_levels":[{"effort":"low"}]},
        {"slug":"gpt-b","visibility":"list","supported_reasoning_levels":[{"effort":"medium"},{"effort":"ultra"}]},
        {"display_name":"No slug","visibility":"list"}
    ]}"#;

    #[test]
    fn the_codex_list_keeps_listed_models() {
        let models = parse_models(JSON).unwrap();
        assert_eq!(
            models,
            vec![
                ModelInfo { id: "gpt-a".into(), label: "GPT-A".into(), efforts: vec!["low".into(), "high".into()], default_effort: Some("low".into()) },
                ModelInfo { id: "gpt-b".into(), label: "gpt-b".into(), efforts: vec!["medium".into(), "ultra".into()], default_effort: None },
            ]
        );
        assert!(parse_models("not json").is_err());
        assert!(parse_models("{}").is_err());
        assert_eq!(parse_models(r#"{"models":[]}"#).unwrap(), vec![]);
    }

    #[test]
    fn claude_offers_four_aliases_and_five_efforts() {
        let claude = claude_models();
        assert_eq!(claude.models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["fable", "opus", "sonnet", "haiku"]);
        assert!(claude.models.iter().all(|m| m.efforts == ["low", "medium", "high", "xhigh", "max"] && m.default_effort.is_none()));
        assert_eq!((claude.default_model.clone(), claude.default_effort.clone()), (None, None));
        assert_eq!(check(&claude, Some("fable"), Some("max")), Ok(()));
        assert_eq!(check(&claude, Some("gpt-6"), None), Err("Unknown model: gpt-6".into()));
        assert_eq!(check(&claude, None, Some("ultra")), Err("Unknown effort: ultra".into()));
        assert_eq!(check(&claude, None, None), Ok(()));
    }

    #[test]
    fn codex_efforts_follow_the_model() {
        let list = AgentModels { models: parse_models(JSON).unwrap(), default_model: Some("gpt-b".into()), ..Default::default() };
        assert_eq!(check(&list, Some("gpt-a"), Some("high")), Ok(()));
        assert_eq!(check(&list, Some("gpt-a"), Some("ultra")), Err("Unknown effort: ultra".into()));
        // Without a model, the configured default model decides; with none of those, any listed effort does.
        assert_eq!(check(&list, None, Some("ultra")), Ok(()));
        assert!(check(&list, None, Some("high")).is_err());
        let plain = AgentModels { default_model: None, ..list.clone() };
        assert_eq!(check(&plain, None, Some("high")), Ok(()));
        assert!(check(&plain, Some("gpt-hidden"), None).is_err());
        let empty = AgentModels { note: Some("Codex's model list is not available: x".into()), ..Default::default() };
        assert_eq!(check(&empty, Some("gpt-a"), None), Err("Codex's model list is not available: x".into()));
        assert_eq!(check(&empty, None, None), Ok(()));
    }

    #[test]
    fn config_defaults_read_two_top_level_keys() {
        let text = "# my config\nmodel = \"gpt-6.1-sol\"  # picked\nmodel_reasoning_effort = 'high'\nother = 1\n\n[profiles.x]\nmodel = \"nope\"\nmodel_reasoning_effort = \"low\"\n";
        assert_eq!(config_defaults(text), (Some("gpt-6.1-sol".into()), Some("high".into())));
        // Keys inside a table are ignored, and a similar key name is not the key.
        assert_eq!(config_defaults("[a]\nmodel = \"x\"\n"), (None, None));
        assert_eq!(config_defaults("model_provider = \"x\"\nmodel=\"y\"\r\nmodel_reasoning_effort = \"\"\r\n"), (Some("y".into()), None));
        assert_eq!(config_defaults("model = gpt\n"), (None, None));
        assert_eq!(config_defaults(""), (None, None));
    }
}
