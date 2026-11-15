pub mod launch;
pub mod pty;
pub mod scrollback;

use serde::Deserialize;

/// What `term_open` should do when the session has no running program.
#[derive(Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum StartMode {
    /// The first-run command line: the briefing prompt, a new conversation.
    Fresh,
    /// The CLI's resume form: continue the session's conversation.
    Resume,
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
}
