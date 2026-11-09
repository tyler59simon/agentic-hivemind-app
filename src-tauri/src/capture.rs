//! Quick capture: a small always-on-top window opened by a global hotkey or the tray icon,
//! so a note can be saved without bringing up the whole app.
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::GlobalShortcutExt;

pub const WINDOW: &str = "capture";

pub fn show_capture(app: &AppHandle) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window(WINDOW) {
        window.show()?;
        window.unminimize()?;
        return window.set_focus();
    }
    // The hash tells the shared frontend bundle to render the capture form instead of the app.
    WebviewWindowBuilder::new(app, WINDOW, WebviewUrl::App("index.html#capture".into()))
        .title("Hivemind · Quick capture")
        .inner_size(560.0, 500.0)
        .min_inner_size(420.0, 380.0)
        .always_on_top(true)
        .skip_taskbar(true)
        .center()
        .focused(true)
        .build()?;
    Ok(())
}

pub fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Register the quick-capture hotkey (replacing any previous one). None turns it off.
pub fn apply_shortcut(app: &AppHandle, shortcut: Option<&str>) -> Result<(), String> {
    let shortcuts = app.global_shortcut();
    shortcuts.unregister_all().map_err(|e| e.to_string())?;
    match shortcut {
        Some(accelerator) => shortcuts
            .register(accelerator)
            .map_err(|e| format!("Could not register {accelerator}: {e}. It may be taken by another app or not a valid shortcut.")),
        None => Ok(()),
    }
}

pub fn tray(app: &AppHandle) -> tauri::Result<()> {
    let capture = MenuItem::with_id(app, "capture", "Quick capture", true, None::<&str>)?;
    let show = MenuItem::with_id(app, "show", "Show Hivemind", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Hivemind", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&capture, &show, &quit])?;
    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("Hivemind")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "capture" => { let _ = show_capture(app); }
            "show" => show_main(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}
