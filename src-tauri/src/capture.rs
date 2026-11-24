//! Quick capture: a small always-on-top window opened by a global hotkey or the tray icon,
//! so a note can be saved without bringing up the whole app.
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::GlobalShortcutExt;

pub const WINDOW: &str = "capture";

/// A second tray Quit within this long exits at once when no page answered the first (`quit_ack`), so Quit works
/// when the page is not loaded. Once the page answers, it asks before quitting however often Quit is clicked.
const QUIT_AGAIN: Duration = Duration::from_secs(5);
static LAST_QUIT: Mutex<Option<Instant>> = Mutex::new(None);

/// Whether a tray Quit at `now` is the second within `QUIT_AGAIN` of `last`.
fn quit_again(last: Option<Instant>, now: Instant) -> bool {
    last.is_some_and(|last| now.duration_since(last) <= QUIT_AGAIN)
}

/// The page received `quit-requested` and will ask the user itself.
pub fn quit_ack() {
    *LAST_QUIT.lock().unwrap() = None;
}

/// Tray Quit (also Cmd+Q and Dock Quit on macOS): show the window and ask the page to confirm (it quits at once when
/// nothing runs); a second request within five seconds exits directly.
pub fn request_quit(app: &AppHandle) {
    let now = Instant::now();
    let mut last = LAST_QUIT.lock().unwrap();
    if quit_again(*last, now) {
        drop(last);
        app.exit(0);
        return;
    }
    *last = Some(now);
    drop(last);
    show_main(app);
    let _ = app.emit("quit-requested", ());
}

pub fn show_capture(app: &AppHandle) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window(WINDOW) {
        window.show()?;
        window.unminimize()?;
        return window.set_focus();
    }
    // The capture window is zoomed like the main one, and grows with it so its form still fits (DESK-ZOOM).
    let zoom = app.path().app_config_dir().map(|dir| crate::settings::load(&dir.join("settings.json")).ui_zoom()).unwrap_or(1.0);
    // The hash tells the shared frontend bundle to render the capture form instead of the app.
    let window = WebviewWindowBuilder::new(app, WINDOW, WebviewUrl::App("index.html#capture".into()))
        .title("Hivemind · Quick capture")
        .inner_size(560.0 * zoom, 500.0 * zoom)
        .min_inner_size(420.0 * zoom.min(1.0), 380.0 * zoom.min(1.0))
        .always_on_top(true)
        .skip_taskbar(true)
        .center()
        .focused(true)
        .build()?;
    crate::appearance::apply_to(&window, zoom);
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

/// The id of the macOS app menu's Quit item. Not `quit`: a global menu handler also sees the tray menu's events.
pub const APP_QUIT: &str = "app-quit";

/// The macOS menu bar. Tauri's default binds Cmd+Q to a Quit that skips the page's confirmation and Cmd+W to Close
/// Window, which hides the app instead of closing the page's tab. This one keeps the standard App, Edit and Window items,
/// routes Quit through `request_quit`, and leaves Cmd+W to the page (MACOS-1C).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn macos_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let name = app.package_info().name.clone();
    let app_menu = Submenu::with_items(
        app,
        &name,
        true,
        &[
            &PredefinedMenuItem::about(app, None, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, APP_QUIT, format!("Quit {name}"), true, Some("CmdOrCtrl+Q"))?,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let window = Submenu::with_items(app, "Window", true, &[&PredefinedMenuItem::minimize(app, None)?, &PredefinedMenuItem::maximize(app, None)?])?;
    Menu::with_items(app, &[&app_menu, &edit, &window])
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
            "quit" => request_quit(app),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_second_quit_within_five_seconds_exits() {
        let start = Instant::now();
        assert!(!quit_again(None, start));
        assert!(quit_again(Some(start), start + Duration::from_secs(4)));
        assert!(!quit_again(Some(start), start + Duration::from_secs(6)));
    }
}
