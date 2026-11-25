//! Window zoom (DESK-ZOOM). WebView2 does not keep a zoom across launches, so the saved one is applied to every window
//! when it is made; changes go to every window at once and are kept in the settings file.
use crate::settings;
use serde::Serialize;
use std::path::Path;
use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewWindow};

/// Zoom one window. A window that is already gone is not an error.
pub fn apply_to<R: Runtime>(window: &WebviewWindow<R>, zoom: f64) {
    if let Err(e) = window.set_zoom(settings::clamp_zoom(zoom)) {
        eprintln!("Hivemind: could not zoom {} ({e})", window.label());
    }
}

/// Save `zoom` (clamped) and show it in every window; the windows are told with `ui-zoom`. Returns the zoom kept.
pub fn set<R: Runtime>(app: &AppHandle<R>, settings_path: &Path, zoom: f64) -> Result<f64, String> {
    let zoom = settings::clamp_zoom(zoom);
    settings::update(settings_path, |saved| {
        saved.ui_zoom = Some(zoom);
        Ok(())
    })?;
    for window in app.webview_windows().values() {
        apply_to(window, zoom);
    }
    let _ = app.emit("ui-zoom", zoom);
    Ok(zoom)
}

/// The appearance settings kept in the settings file (DESK-11): what each window shows, apart from the zoom. Unset or
/// unknown values are None. The windows keep a copy in localStorage for the first paint and follow `appearance`.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Appearance {
    pub theme: Option<String>,
    pub document_background: Option<String>,
    pub document_size: Option<f64>,
    pub default_mode: Option<String>,
}

pub fn get(saved: &settings::Settings) -> Appearance {
    Appearance {
        theme: saved.theme().map(String::from),
        document_background: saved.document_background().map(String::from),
        document_size: saved.document_size(),
        default_mode: saved.default_mode().map(String::from),
    }
}

/// Set one appearance value after checking it. A new key is a new arm here, a validator in settings.rs and a field in `Appearance`.
pub fn change(saved: &mut settings::Settings, key: &str, value: &serde_json::Value) -> Result<(), String> {
    let text = |ok: fn(&str) -> bool| value.as_str().filter(|v| ok(v)).map(String::from).ok_or_else(|| format!("{key}: {value} is not a known value"));
    match key {
        "theme" => saved.theme = Some(text(settings::valid_theme)?),
        "document_background" => saved.document_background = Some(text(settings::valid_paper)?),
        "default_mode" => saved.default_mode = Some(text(settings::valid_default_mode)?),
        "document_size" => saved.document_size = Some(value.as_f64().filter(|v| settings::valid_doc_size(*v)).ok_or_else(|| format!("{key}: {value} is not a known value"))?),
        _ => return Err(format!("Unknown appearance setting: {key}")),
    }
    Ok(())
}

/// Check and keep one value, then tell every window with `appearance` (the new values of all of them).
pub fn set_value<R: Runtime>(app: &AppHandle<R>, settings_path: &Path, key: &str, value: &serde_json::Value) -> Result<(), String> {
    let now = settings::update(settings_path, |saved| {
        change(saved, key, value)?;
        Ok(get(saved))
    })?;
    let _ = app.emit("appearance", now);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn change_keeps_known_values_and_refuses_the_rest() {   // DESK-11
        let mut saved = settings::Settings::default();
        change(&mut saved, "theme", &json!("emerald-light")).unwrap();
        change(&mut saved, "document_background", &json!("white")).unwrap();
        change(&mut saved, "document_size", &json!(1.25)).unwrap();
        change(&mut saved, "default_mode", &json!("live")).unwrap();
        let kept = get(&saved);
        assert_eq!((kept.theme.as_deref(), kept.document_background.as_deref(), kept.document_size, kept.default_mode.as_deref()),
            (Some("emerald-light"), Some("white"), Some(1.25), Some("live")));
        let before = saved.clone();
        for (key, value) in [("theme", json!("sepia")), ("theme", json!(3)), ("document_background", json!("black")), ("document_size", json!(1.2)),
            ("document_size", json!("1")), ("default_mode", json!("history")), ("default_mode", json!(null)), ("ui_zoom", json!(1.5))] {
            assert!(change(&mut saved, key, &value).is_err(), "{key} {value}");
        }
        assert_eq!(saved, before);
    }

    #[test]
    fn get_leaves_out_unknown_saved_values() {
        let saved = settings::Settings { theme: Some("sepia".into()), document_size: Some(1.0), ..Default::default() };
        assert_eq!(get(&saved), Appearance { theme: None, document_background: None, document_size: Some(1.0), default_mode: None });
    }

    #[test]
    fn a_kept_value_survives_a_round_trip_and_a_refused_one_saves_nothing() {
        let dir = std::env::temp_dir().join(format!("hivemind-appearance-{}", std::process::id()));
        let path = dir.join("settings.json");
        settings::update(&path, |s| change(s, "theme", &json!("emerald"))).unwrap();
        assert!(settings::update(&path, |s| change(s, "theme", &json!("sepia"))).is_err());
        assert_eq!(settings::load(&path).theme(), Some("emerald"));
        std::fs::remove_dir_all(&dir).ok();
    }
}
