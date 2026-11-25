//! Window zoom (DESK-ZOOM). WebView2 does not keep a zoom across launches, so the saved one is applied to every window
//! when it is made; changes go to every window at once and are kept in the settings file.
use crate::settings;
use serde::Serialize;
use std::path::Path;
use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewWindow};

/// Zoom one window. A window that is already gone is not an error.
pub fn apply_to<R: Runtime>(window: &WebviewWindow<R>, zoom: f64) {
    if window.set_zoom(settings::clamp_zoom(zoom)).is_err() {
        log::warn!("window zoom: could not be set");
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
    pub spellcheck: Option<bool>,
    pub ui_font: Option<String>,
    pub doc_font: Option<String>,
    pub mono_font: Option<String>,
    pub doc_line_height: Option<f64>,
    pub doc_width: Option<String>,
    pub density: Option<String>,
}

pub fn get(saved: &settings::Settings) -> Appearance {
    Appearance {
        theme: saved.theme().map(String::from),
        document_background: saved.document_background().map(String::from),
        document_size: saved.document_size(),
        default_mode: saved.default_mode().map(String::from),
        spellcheck: saved.spellcheck(),
        ui_font: saved.ui_font().map(String::from),
        doc_font: saved.doc_font().map(String::from),
        mono_font: saved.mono_font().map(String::from),
        doc_line_height: saved.doc_line_height(),
        doc_width: saved.doc_width().map(String::from),
        density: saved.density().map(String::from),
    }
}

/// Set one appearance value after checking it. A new key is a new arm here, a validator in settings.rs and a field in `Appearance`.
pub fn change(saved: &mut settings::Settings, key: &str, value: &serde_json::Value) -> Result<(), String> {
    let text = |ok: fn(&str) -> bool| value.as_str().filter(|v| ok(v)).map(String::from).ok_or_else(|| format!("{key}: {value} is not a known value"));
    match key {
        "theme" => saved.theme = Some(text(settings::valid_theme)?),
        "document_background" => saved.document_background = Some(text(settings::valid_paper)?),
        "default_mode" => saved.default_mode = Some(text(settings::valid_default_mode)?),
        "spellcheck" => saved.spellcheck = Some(value.as_bool().ok_or_else(|| format!("{key}: {value} is not a known value"))?),
        "document_size" => saved.document_size = Some(value.as_f64().filter(|v| settings::valid_doc_size(*v)).ok_or_else(|| format!("{key}: {value} is not a known value"))?),
        "ui_font" => saved.ui_font = Some(text(settings::valid_ui_font)?),
        "doc_font" => saved.doc_font = Some(text(settings::valid_doc_font)?),
        "mono_font" => saved.mono_font = Some(text(settings::valid_mono_font)?),
        "doc_width" => saved.doc_width = Some(text(settings::valid_doc_width)?),
        "density" => saved.density = Some(text(settings::valid_density)?),
        "doc_line_height" => saved.doc_line_height = Some(value.as_f64().filter(|v| settings::valid_line_height(*v)).ok_or_else(|| format!("{key}: {value} is not a known value"))?),
        _ => return Err(format!("Unknown appearance setting: {key}")),
    }
    Ok(())
}

/// Whether `key` has a usable value in `saved`; a key that is not an appearance setting is an error.
fn is_set(saved: &settings::Settings, key: &str) -> Result<bool, String> {
    let now = get(saved);
    match key {
        "theme" => Ok(now.theme.is_some()),
        "document_background" => Ok(now.document_background.is_some()),
        "document_size" => Ok(now.document_size.is_some()),
        "default_mode" => Ok(now.default_mode.is_some()),
        "spellcheck" => Ok(now.spellcheck.is_some()),
        "ui_font" => Ok(now.ui_font.is_some()),
        "doc_font" => Ok(now.doc_font.is_some()),
        "mono_font" => Ok(now.mono_font.is_some()),
        "doc_line_height" => Ok(now.doc_line_height.is_some()),
        "doc_width" => Ok(now.doc_width.is_some()),
        "density" => Ok(now.density.is_some()),
        _ => Err(format!("Unknown appearance setting: {key}")),
    }
}

/// Check and keep one value; with `only_if_unset`, only when the key has none yet (a window moving its old localStorage copy
/// over must not undo a choice made since). Returns whether the file was changed.
fn write(saved: &mut settings::Settings, key: &str, value: &serde_json::Value, only_if_unset: bool) -> Result<Option<Appearance>, String> {
    if only_if_unset && is_set(saved, key)? {
        return Ok(None);
    }
    change(saved, key, value)?;
    Ok(Some(get(saved)))
}

/// Check and keep one value, then tell every window with `appearance` (the new values of all of them). With `only_if_unset`
/// nothing is written or sent when the key already has a value. Returns whether it wrote.
pub fn set_value<R: Runtime>(app: &AppHandle<R>, settings_path: &Path, key: &str, value: &serde_json::Value, only_if_unset: bool) -> Result<bool, String> {
    let now = settings::update_some(settings_path, |saved| write(saved, key, value, only_if_unset))?;
    if let Some(now) = &now {
        let _ = app.emit("appearance", now);
    }
    Ok(now.is_some())
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
        change(&mut saved, "spellcheck", &json!(false)).unwrap();
        let kept = get(&saved);
        assert_eq!((kept.theme.as_deref(), kept.document_background.as_deref(), kept.document_size, kept.default_mode.as_deref(), kept.spellcheck),
            (Some("emerald-light"), Some("white"), Some(1.25), Some("live"), Some(false)));
        change(&mut saved, "spellcheck", &json!(true)).unwrap();
        assert_eq!(saved.spellcheck(), Some(true));
        let before = saved.clone();
        for (key, value) in [("theme", json!("sepia")), ("theme", json!(3)), ("document_background", json!("black")), ("document_size", json!(1.2)),
            ("document_size", json!("1")), ("default_mode", json!("history")), ("default_mode", json!(null)), ("spellcheck", json!("true")), ("spellcheck", json!(1)), ("spellcheck", json!(null)), ("ui_zoom", json!(1.5))] {
            assert!(change(&mut saved, key, &value).is_err(), "{key} {value}");
        }
        assert_eq!(saved, before);
    }

    #[test]
    fn change_keeps_known_typography_values_and_refuses_the_rest() {   // DESK-TYPE
        let mut saved = settings::Settings::default();
        for (key, value) in [("ui_font", json!("segoe")), ("doc_font", json!("cambria")), ("mono_font", json!("consolas")), ("doc_line_height", json!(1.8)),
            ("doc_width", json!("full")), ("density", json!("compact"))] {
            change(&mut saved, key, &value).unwrap();
        }
        let kept = get(&saved);
        assert_eq!((kept.ui_font.as_deref(), kept.doc_font.as_deref(), kept.mono_font.as_deref(), kept.doc_line_height, kept.doc_width.as_deref(), kept.density.as_deref()),
            (Some("segoe"), Some("cambria"), Some("consolas"), Some(1.8), Some("full"), Some("compact")));
        let before = saved.clone();
        for (key, value) in [("ui_font", json!("georgia")), ("ui_font", json!("Arial; color: red")), ("ui_font", json!(1)), ("doc_font", json!("consolas")), ("mono_font", json!("monospace")),
            ("doc_line_height", json!(1.5)), ("doc_line_height", json!("1.6")), ("doc_width", json!("54rem")), ("doc_width", json!(null)), ("density", json!("dense")), ("density", json!(true))] {
            assert!(change(&mut saved, key, &value).is_err(), "{key} {value}");
        }
        assert_eq!(saved, before);
        // An init never replaces a value that is set, and writes one that is not.
        assert!(write(&mut saved, "density", &json!("comfortable"), true).unwrap().is_none());
        assert!(write(&mut settings::Settings::default(), "doc_line_height", &json!(1.4), true).unwrap().is_some());
        assert!(write(&mut saved, "doc_width", &json!("wide"), true).unwrap().is_none());
    }

    #[test]
    fn only_if_unset_writes_a_missing_value_and_never_replaces_one() {   // DESK-11, C3
        let mut saved = settings::Settings::default();
        assert!(write(&mut saved, "theme", &json!("emerald"), true).unwrap().is_some());
        assert_eq!(saved.theme(), Some("emerald"));
        assert!(write(&mut saved, "theme", &json!("purple"), true).unwrap().is_none());
        assert_eq!(saved.theme(), Some("emerald"));
        // A saved value that is not a known one counts as unset.
        saved.document_size = Some(3.0);
        assert!(write(&mut saved, "document_size", &json!(1.25), true).unwrap().is_some());
        assert_eq!(saved.document_size(), Some(1.25));
        // Bad values and unknown keys are still refused, set or not.
        assert!(write(&mut saved, "default_mode", &json!("history"), true).is_err());
        assert!(write(&mut saved, "ui_zoom", &json!(1.5), true).is_err());
        // A saved false is a value: an init never turns it back on.
        assert!(write(&mut saved, "spellcheck", &json!(false), true).unwrap().is_some());
        assert!(write(&mut saved, "spellcheck", &json!(true), true).unwrap().is_none());
        assert_eq!(saved.spellcheck(), Some(false));
        assert!(write(&mut saved, "theme", &json!("purple"), false).unwrap().is_some());
    }

    #[test]
    fn get_leaves_out_unknown_saved_values() {
        let saved = settings::Settings { theme: Some("sepia".into()), document_size: Some(1.0), ..Default::default() };
        assert_eq!(get(&saved), Appearance { theme: None, document_background: None, document_size: Some(1.0), default_mode: None, spellcheck: None,
            ui_font: None, doc_font: None, mono_font: None, doc_line_height: None, doc_width: None, density: None });
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

    #[test]
    fn an_init_with_nothing_to_do_leaves_the_file_unwritten() {   // Codex re-review of 2e736f0
        let dir = std::env::temp_dir().join(format!("hivemind-appearance-noop-{}", std::process::id()));
        let path = dir.join("settings.json");
        std::fs::create_dir_all(&dir).unwrap();
        // Compact JSON: a save would rewrite it pretty-printed, so an unchanged text shows nothing was written.
        std::fs::write(&path, r#"{"theme":"emerald"}"#).unwrap();
        assert!(settings::update_some(&path, |s| write(s, "theme", &json!("purple"), true)).unwrap().is_none());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), r#"{"theme":"emerald"}"#);
        assert!(settings::update_some(&path, |s| write(s, "document_size", &json!(1.25), true)).unwrap().is_some());
        assert_eq!(settings::load(&path).document_size(), Some(1.25));
        std::fs::remove_dir_all(&dir).ok();
    }
}
