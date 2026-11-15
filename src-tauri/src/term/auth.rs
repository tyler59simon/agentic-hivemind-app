//! Whether a CLI is signed in, from the CLI's own status command. Hivemind never reads or stores credentials: Claude's
//! JSON is parsed for three fields only (`loggedIn`, and the plan and method labels), and Codex's output text is ignored.
use super::launch;
use crate::agent::Engine;
use crate::settings::Settings;
use serde::Serialize;
use serde_json::Value;
use std::process::Command;
use std::time::Duration;

const TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Serialize, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    /// None: it could not be told.
    pub signed_in: Option<bool>,
    /// A non-secret label such as the plan or the sign-in method; never an account detail.
    pub detail: Option<String>,
}

/// A label the CLI printed, kept only when it is short and plain: letters, digits, spaces, `.`, `_` and `-`.
fn label(value: Option<&Value>) -> Option<String> {
    let text = value?.as_str()?.trim();
    let plain = !text.is_empty() && text.len() <= 40 && text.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '.' | '_' | '-'));
    plain.then(|| text.to_string())
}

/// `claude auth status`: JSON with `loggedIn`. Anything else in it is ignored.
pub fn claude_status(output: &str) -> AuthStatus {
    let text = output.trim();
    let parsed = serde_json::from_str::<Value>(text).ok().or_else(|| {
        // A banner line before or after the JSON object.
        let (start, end) = (text.find('{')?, text.rfind('}')?);
        serde_json::from_str::<Value>(text.get(start..=end)?).ok()
    });
    let Some(signed_in) = parsed.as_ref().and_then(|value| value.get("loggedIn")).and_then(Value::as_bool) else { return AuthStatus::default() };
    let detail = parsed
        .as_ref()
        .filter(|_| signed_in)
        .map(|value| [label(value.get("subscriptionType")), label(value.get("authMethod"))].into_iter().flatten().collect::<Vec<_>>().join(" \u{b7} "))
        .filter(|text| !text.is_empty());
    AuthStatus { signed_in: Some(signed_in), detail }
}

/// `codex login status`: exit code 0 is signed in and another code is signed out (255 is what it gives). Code 2 is a
/// usage error from an older Codex that has no such command, so it says nothing. No code (killed) says nothing.
pub fn codex_status(code: Option<i32>) -> AuthStatus {
    AuthStatus { signed_in: match code { Some(0) => Some(true), Some(2) | None => None, Some(_) => Some(false) }, detail: None }
}

/// Run the CLI's own status command, with a 10 second limit. A program that is missing, does not start or times out
/// gives "could not tell". Not run by any test.
pub fn status(engine: Engine, saved: &Settings) -> AuthStatus {
    let Ok(cli) = launch::program(engine, saved) else { return AuthStatus::default() };
    let mut command = Command::new(&cli.program);
    command.args(&cli.args).args(match engine {
        Engine::Claude => ["auth", "status"],
        Engine::Codex => ["login", "status"],
    });
    command.env_remove("HIVEMIND_SESSION");
    match crate::git::run_captured(command, TIMEOUT) {
        Ok(ran) => match engine {
            Engine::Claude => claude_status(&ran.stdout),
            Engine::Codex => codex_status(ran.status.code()),
        },
        Err(_) => AuthStatus::default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status(signed_in: Option<bool>, detail: Option<&str>) -> AuthStatus {
        AuthStatus { signed_in, detail: detail.map(str::to_string) }
    }

    #[test]
    fn claude_signed_in_with_and_without_labels() {
        assert_eq!(claude_status("{\"loggedIn\": true}"), status(Some(true), None));
        assert_eq!(
            claude_status("{\"loggedIn\":true,\"authMethod\":\"claude.ai\",\"subscriptionType\":\"max\"}\n"),
            status(Some(true), Some("max \u{b7} claude.ai"))
        );
    }

    #[test]
    fn claude_signed_out_has_no_detail() {
        assert_eq!(claude_status("{\"loggedIn\": false, \"authMethod\": \"none\"}"), status(Some(false), None));
    }

    #[test]
    fn claude_garbage_is_unknown() {
        for text in ["", "not json", "[]", "{}", "{\"loggedIn\": \"yes\"}", "{\"loggedIn\": tru"] {
            assert_eq!(claude_status(text), AuthStatus::default(), "{text}");
        }
        assert_eq!(claude_status("note\n{\"loggedIn\": true}\n"), status(Some(true), None));
    }

    #[test]
    fn claude_details_never_carry_account_data() {
        let payload = "{\"loggedIn\":true,\"email\":\"someone@example.com\",\"orgId\":\"org-123\",\"orgName\":\"Acme\",\"accountId\":\"acc-1\",\"authMethod\":\"claude.ai\",\"subscriptionType\":\"max\"}";
        let shown = serde_json::to_string(&claude_status(payload)).unwrap();
        for secret in ["someone", "example.com", "org-123", "Acme", "acc-1"] {
            assert!(!shown.contains(secret), "{shown}");
        }
        // A label that looks like an address or is long is dropped, not shown.
        let odd = claude_status("{\"loggedIn\":true,\"authMethod\":\"someone@example.com\",\"subscriptionType\":\"a very long label that is not a plan name at all\"}");
        assert_eq!(odd, status(Some(true), None));
    }

    #[test]
    fn codex_exit_codes_map_to_signed_in_out_or_unknown() {
        assert_eq!(codex_status(Some(0)), status(Some(true), None));
        assert_eq!(codex_status(Some(255)), status(Some(false), None));
        assert_eq!(codex_status(Some(1)), status(Some(false), None));
        assert_eq!(codex_status(Some(2)), AuthStatus::default());
        assert_eq!(codex_status(None), AuthStatus::default());
    }

    #[test]
    fn a_status_serialises_in_camel_case() {
        assert_eq!(serde_json::to_value(status(Some(true), Some("max"))).unwrap(), serde_json::json!({"signedIn": true, "detail": "max"}));
    }
}
