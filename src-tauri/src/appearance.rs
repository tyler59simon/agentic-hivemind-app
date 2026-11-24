//! Window zoom (DESK-ZOOM). WebView2 does not keep a zoom across launches, so the saved one is applied to every window
//! when it is made; changes go to every window at once and are kept in the settings file.
use crate::settings;
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
