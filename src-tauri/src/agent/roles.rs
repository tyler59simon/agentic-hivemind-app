//! Roles a session can be started in (architect, developer, reviewer, researcher, tester) and the permission profiles they
//! run with. A role is a preamble put before the task and a default profile; the profile becomes the session's permission
//! rules in `scope.rs`. The webview names a role and a profile, never a rule.
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    Architect,
    Developer,
    Reviewer,
    Researcher,
    Tester,
}

/// What a session may do without a person answering.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum Profile {
    /// Read the worktree and Living Memory; nothing else.
    ReadOnly,
    /// Edit files inside the worktree and run the project's allowed commands; anything else is asked (attended) or
    /// refused (unattended).
    EditWorktree,
    /// As `ReadOnly`, plus web search and fetch.
    Research,
}

/// What a reviewer or tester concluded, from the `Verdict:` line its preamble asks for.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Verdict {
    Pass,
    ChangesNeeded,
}

pub const ALL: [Role; 5] = [Role::Architect, Role::Developer, Role::Reviewer, Role::Researcher, Role::Tester];

const CLOSING: &str = "End your final reply with a section headed `## Summary`: what you did, what you found, and anything left open, \
in at most ten lines.";

const VERDICT: &str = "On the last line of your final reply write exactly `Verdict: pass` when the work is ready, or \
`Verdict: changes needed` when it is not.";

impl Role {
    pub fn label(self) -> &'static str {
        match self {
            Role::Architect => "Architect",
            Role::Developer => "Developer",
            Role::Reviewer => "Reviewer",
            Role::Researcher => "Researcher",
            Role::Tester => "Tester",
        }
    }

    /// The profile a role gets when the user does not pick another.
    pub fn profile(self) -> Profile {
        match self {
            Role::Architect | Role::Reviewer => Profile::ReadOnly,
            Role::Researcher => Profile::Research,
            Role::Developer | Role::Tester => Profile::EditWorktree,
        }
    }

    /// Whether the role's final reply carries a `Verdict:` line.
    pub fn gives_verdict(self) -> bool {
        matches!(self, Role::Reviewer | Role::Tester)
    }

    /// The instructions put before the task.
    pub fn preamble(self) -> String {
        let what = match self {
            Role::Architect => {
                "You are the architect for this task. Read the code, the architecture notes and the relevant Living Memory decisions, \
then produce a design: the parts to change, the order to change them in, the risks, and how to verify the result. Do not edit files."
            }
            Role::Developer => {
                "You are the developer for this task. Make the change in this working folder, keep it as small as the task allows, follow \
the existing conventions, and run the project's tests when you are allowed to. Do not push, merge or rewrite history."
            }
            Role::Reviewer => {
                "You are the reviewer for this task. Read the changes on this branch against its base (`git diff` and `git log` are \
enough) and look for bugs, missing tests, security problems and departures from the project's conventions. Report findings with \
file and line. Do not edit files."
            }
            Role::Researcher => {
                "You are the researcher for this task. Find the facts the task needs, from the code, Living Memory and the web when \
you are allowed to, and cite where each fact came from. Do not edit files."
            }
            Role::Tester => {
                "You are the tester for this task. Check that the change works: run the project's tests and add focused tests where \
coverage is missing. Report what passed and what failed with the exact command and output. Do not change production code."
            }
        };
        let verdict = if self.gives_verdict() { format!("\n\n{VERDICT}") } else { String::new() };
        format!("Role: {}\n\n{what}\n\n{CLOSING}{verdict}", self.label())
    }
}

/// One role as the Start screen lists it.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RoleInfo {
    pub role: Role,
    pub label: &'static str,
    pub profile: Profile,
    pub gives_verdict: bool,
}

pub fn list() -> Vec<RoleInfo> {
    ALL.into_iter().map(|role| RoleInfo { role, label: role.label(), profile: role.profile(), gives_verdict: role.gives_verdict() }).collect()
}

/// The verdict on the last `Verdict:` line of a final reply, if there is one.
pub fn verdict(result: &str) -> Option<Verdict> {
    let line = result.lines().rev().map(|line| line.trim().trim_matches(['*', '`', '_'])).find(|line| line.to_lowercase().starts_with("verdict:"))?;
    let word = line["verdict:".len()..].trim().trim_matches(['*', '`', '.', '_']).to_lowercase();
    match word.as_str() {
        "pass" | "passed" | "approve" | "approved" => Some(Verdict::Pass),
        "changes needed" | "changes requested" | "fail" | "failed" => Some(Verdict::ChangesNeeded),
        _ => None,
    }
}

/// The `## Summary` section of a final reply, or the whole reply when it has none. At most `limit` characters, keeping the start.
pub fn summary(result: &str, limit: usize) -> String {
    let text = match result.find("## Summary") {
        Some(at) => result[at + "## Summary".len()..].trim(),
        None => result.trim(),
    };
    let mut kept: String = text.chars().take(limit).collect();
    if text.chars().count() > limit {
        kept.push_str(" [...]");
    }
    kept
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roles_and_profiles_are_snake_case_in_json() {
        assert_eq!(serde_json::to_value(Role::Reviewer).unwrap(), "reviewer");
        assert_eq!(serde_json::to_value(Profile::EditWorktree).unwrap(), "edit_worktree");
        assert_eq!(serde_json::from_value::<Profile>("read_only".into()).unwrap(), Profile::ReadOnly);
        assert_eq!(serde_json::to_value(Verdict::ChangesNeeded).unwrap(), "changes_needed");
    }

    #[test]
    fn every_role_has_a_profile_and_a_preamble() {
        for role in ALL {
            let preamble = role.preamble();
            assert!(preamble.starts_with(&format!("Role: {}", role.label())));
            assert!(preamble.contains("## Summary"));
            assert_eq!(preamble.contains("Verdict: pass"), role.gives_verdict());
        }
        assert_eq!(Role::Developer.profile(), Profile::EditWorktree);
        assert_eq!(Role::Reviewer.profile(), Profile::ReadOnly);
        assert_eq!(Role::Researcher.profile(), Profile::Research);
    }

    #[test]
    fn the_last_verdict_line_counts() {
        assert_eq!(verdict("All good.\n\nVerdict: pass"), Some(Verdict::Pass));
        assert_eq!(verdict("**Verdict: changes needed**\n"), Some(Verdict::ChangesNeeded));
        assert_eq!(verdict("Verdict: pass\nlater\nverdict: Fail."), Some(Verdict::ChangesNeeded));
        assert_eq!(verdict("`Verdict: approved`"), Some(Verdict::Pass));
        assert_eq!(verdict("No verdict here"), None);
        assert_eq!(verdict("Verdict: maybe"), None);
    }

    #[test]
    fn the_summary_section_is_kept_and_clipped() {
        assert_eq!(summary("Long work log\n## Summary\nFixed the retry.\n", 100), "Fixed the retry.");
        assert_eq!(summary("  no heading  ", 100), "no heading");
        assert_eq!(summary("abcdef", 3), "abc [...]");
    }
}
