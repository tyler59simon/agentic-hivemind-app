pub mod launch;
pub mod pty;
pub mod scrollback;

use serde::Deserialize;
use std::path::{Path, PathBuf};

/// What `term_open` should do when the session has no running program.
#[derive(Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum StartMode {
    /// The first-run command line: the briefing prompt, a new conversation.
    Fresh,
    /// The CLI's resume form: continue the session's conversation.
    Resume,
}

/// The session's folder under `dir`; only a plain UUID names one.
pub fn session_dir(dir: &Path, session_id: &str) -> Result<PathBuf, String> {
    crate::agent::store::log_path(dir, session_id)?;
    Ok(dir.join(session_id))
}

/// Write `<dir>/<session id>/context/briefing.md` and return the `context` folder.
pub fn write_briefing(dir: &Path, session_id: &str, text: &str) -> Result<PathBuf, String> {
    let context = session_dir(dir, session_id)?.join("context");
    std::fs::create_dir_all(&context).map_err(|e| format!("Could not create {}: {e}", context.display()))?;
    let file = context.join("briefing.md");
    std::fs::write(&file, text).map_err(|e| format!("Could not write {}: {e}", file.display()))?;
    Ok(context)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn start_mode_reads_lowercase() {
        assert_eq!(serde_json::from_value::<StartMode>(json!("fresh")).unwrap(), StartMode::Fresh);
        assert_eq!(serde_json::from_value::<StartMode>(json!("resume")).unwrap(), StartMode::Resume);
        assert!(serde_json::from_value::<StartMode>(json!("other")).is_err());
    }

    #[test]
    fn only_plain_uuids_name_a_terminal_folder() {
        let dir = std::env::temp_dir().join(format!("hivemind-term-dir-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        let id = "00000000-0000-4000-8000-000000000001";
        assert_eq!(session_dir(&dir, id).unwrap(), dir.join(id));
        for bad in ["", "../x", "login-claude", "00000000-0000-4000-8000-00000000000A"] {
            assert!(session_dir(&dir, bad).is_err(), "{bad}");
            assert!(write_briefing(&dir, bad, "x").is_err(), "{bad}");
        }
        let context = write_briefing(&dir, id, "Briefing\n\n---\n\nTask").unwrap();
        assert_eq!(context, dir.join(id).join("context"));
        assert_eq!(std::fs::read_to_string(context.join("briefing.md")).unwrap(), "Briefing\n\n---\n\nTask");
        std::fs::remove_dir_all(&dir).ok();
    }
}
