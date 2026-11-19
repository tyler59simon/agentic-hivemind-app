//! Windows notifications (toasts) for a terminal that needs the user and for the tray notice. Other systems get none.
use crate::term::signal::Kind;
use serde::Serialize;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

/// What the page is told when a notification is clicked.
#[derive(Serialize, Clone)]
struct OpenSession {
    id: String,
}

/// The terminal of the last notification and when it was sent. The fallback for a click that does not reach the app:
/// the next time the window gets the focus within `PENDING_FOR`, that terminal is opened.
static PENDING: Mutex<Option<(String, Instant)>> = Mutex::new(None);
const PENDING_FOR: Duration = Duration::from_secs(120);

/// The body of the notification for a kind.
pub fn body(kind: Kind) -> &'static str {
    match kind {
        Kind::Waiting => "Waiting for you",
        Kind::Done => "Finished",
    }
}

/// Whether the user is looking at the main window: shown, not minimized and focused.
pub fn main_active(app: &AppHandle) -> bool {
    app.get_webview_window("main").is_some_and(|w| w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false) && w.is_focused().unwrap_or(false))
}

/// A terminal needs attention: notify unless the user is looking at the window.
pub fn terminal(app: &AppHandle, id: &str, title: &str, kind: Kind) {
    session(app, id, title, body(kind));
}

/// A session needs the user or has something to show: notify unless the user is looking at the window. A click opens it.
pub fn session(app: &AppHandle, id: &str, title: &str, text: &str) {
    if main_active(app) {
        return;
    }
    *PENDING.lock().unwrap() = Some((id.to_string(), Instant::now()));
    show(app, title, text, Some(id.to_string()));
}

/// A notice that opens nothing when clicked (automations), shown only while the window is not in front.
pub fn notice(app: &AppHandle, title: &str, text: &str) {
    if !main_active(app) {
        show(app, title, text, None);
    }
}

/// What a chat session's notification says, or None when the report is not worth one. A turn that was stopped by the user
/// is not reported, and a session that ended normally after its last turn already had its turn reported.
pub fn session_text(report: &crate::agent::Lifecycle) -> Option<&'static str> {
    use crate::agent::Lifecycle;
    use crate::agent::events::Status;
    match report {
        Lifecycle::Waiting { .. } => Some("Waiting for your approval"),
        Lifecycle::TurnEnded { ok: true, .. } => Some("Finished its turn"),
        Lifecycle::TurnEnded { ok: false, .. } => Some("Stopped with an error"),
        Lifecycle::Finished { status: Status::Succeeded, .. } => Some("Finished"),
        Lifecycle::Finished { status: Status::Failed, .. } => Some("Failed"),
        Lifecycle::Finished { .. } | Lifecycle::Reviewed { .. } => None,
    }
}

/// The user looked at a terminal: a click fallback for it is no longer wanted.
pub fn forget(id: &str) {
    let mut pending = PENDING.lock().unwrap();
    if pending.as_ref().is_some_and(|(pending_id, _)| pending_id == id) {
        *pending = None;
    }
}

/// The window got the focus: open the terminal of a recent notification whose click did not arrive.
pub fn on_focus(app: &AppHandle) {
    let Some((id, at)) = PENDING.lock().unwrap().take() else { return };
    if at.elapsed() <= PENDING_FOR {
        let _ = app.emit("open-session", OpenSession { id });
    }
}

/// The one-time notice that closing the window keeps Hivemind running.
pub fn tray(app: &AppHandle) {
    show(app, "Hivemind keeps running in the tray", "Open it from the tray icon. Quit from there to stop your terminals.", None);
}

#[cfg(windows)]
fn show(app: &AppHandle, title: &str, text: &str, session: Option<String>) {
    use tauri_winrt_notification::Toast;
    // A dev build has no registered AppUserModelID of its own, so it borrows PowerShell's, as Tauri's own notification
    // plugin does. An installed build uses the app identifier.
    let app_id = if cfg!(debug_assertions) { Toast::POWERSHELL_APP_ID.to_string() } else { app.config().identifier.clone() };
    let (app, title, text) = (app.clone(), title.to_string(), text.to_string());
    // `show` waits a few milliseconds; keep that off the caller's thread.
    std::thread::spawn(move || {
        let mut toast = Toast::new(&app_id).title(&title).text1(&text);
        if let Some(id) = session {
            let handle = app.clone();
            toast = toast.on_activated(move |_| {
                *PENDING.lock().unwrap() = None;
                crate::capture::show_main(&handle);
                let _ = handle.emit("open-session", OpenSession { id: id.clone() });
                Ok(())
            });
        }
        let _ = toast.show();
    });
}

#[cfg(not(windows))]
fn show(_app: &AppHandle, _title: &str, _text: &str, _session: Option<String>) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_body_says_what_the_terminal_wants() {
        assert_eq!(body(Kind::Waiting), "Waiting for you");
        assert_eq!(body(Kind::Done), "Finished");
    }

    #[test]
    fn chat_reports_say_what_happened() {
        use crate::agent::Lifecycle;
        use crate::agent::events::Status;
        assert_eq!(session_text(&Lifecycle::Waiting { id: "1".into() }), Some("Waiting for your approval"));
        assert_eq!(session_text(&Lifecycle::TurnEnded { id: "1".into(), ok: false }), Some("Stopped with an error"));
        assert_eq!(session_text(&Lifecycle::Finished { id: "1".into(), status: Status::Failed }), Some("Failed"));
        assert_eq!(session_text(&Lifecycle::Finished { id: "1".into(), status: Status::Ended }), None);
    }

    #[test]
    fn forgetting_clears_only_its_own_terminal() {
        *PENDING.lock().unwrap() = Some(("a".into(), Instant::now()));
        forget("b");
        assert!(PENDING.lock().unwrap().is_some());
        forget("a");
        assert!(PENDING.lock().unwrap().is_none());
    }
}
