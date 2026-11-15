//! What a terminal session may do without asking: each CLI's own permission settings, by the CLI's own names.
//! Serde is the allow-list: a name the CLI does not have cannot be read, stored or sent.
use super::scope::PolicyMode;
use super::Engine;
use serde::{Deserialize, Serialize};

/// `claude --permission-mode` choices (Claude Code 2.1.325).
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClaudeMode {
    #[serde(rename = "manual")]
    Manual,
    #[serde(rename = "acceptEdits")]
    AcceptEdits,
    #[serde(rename = "plan")]
    Plan,
    #[serde(rename = "auto")]
    Auto,
    #[serde(rename = "dontAsk")]
    DontAsk,
    #[serde(rename = "bypassPermissions")]
    BypassPermissions,
}

impl ClaudeMode {
    pub fn name(self) -> &'static str {
        match self {
            ClaudeMode::Manual => "manual",
            ClaudeMode::AcceptEdits => "acceptEdits",
            ClaudeMode::Plan => "plan",
            ClaudeMode::Auto => "auto",
            ClaudeMode::DontAsk => "dontAsk",
            ClaudeMode::BypassPermissions => "bypassPermissions",
        }
    }
}

/// `codex -s` choices (codex-cli 0.169.0).
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum Sandbox {
    #[serde(rename = "read-only")]
    ReadOnly,
    #[serde(rename = "workspace-write")]
    WorkspaceWrite,
    #[serde(rename = "danger-full-access")]
    DangerFullAccess,
}

impl Sandbox {
    pub fn name(self) -> &'static str {
        match self {
            Sandbox::ReadOnly => "read-only",
            Sandbox::WorkspaceWrite => "workspace-write",
            Sandbox::DangerFullAccess => "danger-full-access",
        }
    }
}

/// `codex -a` choices (`on-request`, `never`) and `--approve-for-me`.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum Approval {
    #[serde(rename = "on-request")]
    OnRequest,
    #[serde(rename = "never")]
    Never,
    #[serde(rename = "approve-for-me")]
    ApproveForMe,
}

impl Approval {
    pub fn name(self) -> &'static str {
        match self {
            Approval::OnRequest => "on-request",
            Approval::Never => "never",
            Approval::ApproveForMe => "approve-for-me",
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(tag = "engine", rename_all = "lowercase")]
pub enum Access {
    Claude { mode: ClaudeMode },
    Codex { sandbox: Sandbox, approval: Approval },
}

impl Access {
    pub fn engine(&self) -> Engine {
        match self {
            Access::Claude { .. } => Engine::Claude,
            Access::Codex { .. } => Engine::Codex,
        }
    }

    /// What a session started before the modes existed had: the old policy, in the engine's words. A session that
    /// stored no `access` is launched with this, so it keeps behaving as it did.
    pub fn from_policy(engine: Engine, policy: PolicyMode) -> Access {
        let edits = policy == PolicyMode::AcceptEdits;
        match engine {
            Engine::Claude => Access::Claude { mode: if edits { ClaudeMode::AcceptEdits } else { ClaudeMode::Manual } },
            Engine::Codex => Access::Codex {
                sandbox: if edits { Sandbox::WorkspaceWrite } else { Sandbox::ReadOnly },
                approval: Approval::OnRequest,
            },
        }
    }

    /// True when the program would run commands or edit files without putting a question to the user. Starting such a
    /// session needs the confirm tick. Claude's `auto` mode is not counted: it has a classifier that still blocks
    /// risky actions, and the CLI's help does not describe it as skipping checks.
    pub fn asks_nobody(&self) -> bool {
        match self {
            Access::Claude { mode } => matches!(mode, ClaudeMode::BypassPermissions | ClaudeMode::DontAsk),
            Access::Codex { sandbox, approval } => {
                *sandbox == Sandbox::DangerFullAccess || matches!(approval, Approval::Never | Approval::ApproveForMe)
            }
        }
    }

    /// The access a new session gets: the one asked for, else the old policy's. Refuses what the engine does not have.
    pub fn resolve(engine: Engine, asked: Option<Access>, policy: PolicyMode, confirmed_risky: bool) -> Result<Access, String> {
        let Some(access) = asked else {
            return Ok(Access::from_policy(engine, policy));
        };
        if access.engine() != engine {
            return Err(format!("These permissions are not {}'s.", engine.label()));
        }
        if let Access::Codex { sandbox, approval: Approval::ApproveForMe } = access
            && sandbox != Sandbox::WorkspaceWrite
        {
            return Err("Approve for me works only with the workspace-write sandbox.".into());
        }
        if access.asks_nobody() && !confirmed_risky {
            return Err("This setting never asks before it acts. Tick the box to start without asking.".into());
        }
        Ok(access)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const CLAUDE: [(ClaudeMode, &str); 6] = [
        (ClaudeMode::Manual, "manual"),
        (ClaudeMode::AcceptEdits, "acceptEdits"),
        (ClaudeMode::Plan, "plan"),
        (ClaudeMode::Auto, "auto"),
        (ClaudeMode::DontAsk, "dontAsk"),
        (ClaudeMode::BypassPermissions, "bypassPermissions"),
    ];

    #[test]
    fn names_round_trip_as_the_cli_spells_them() {
        for (mode, name) in CLAUDE {
            let access = Access::Claude { mode };
            assert_eq!(serde_json::to_value(access).unwrap(), json!({"engine": "claude", "mode": name}));
            assert_eq!(serde_json::from_value::<Access>(json!({"engine": "claude", "mode": name})).unwrap(), access);
            assert_eq!(mode.name(), name);
        }
        for (sandbox, s) in [(Sandbox::ReadOnly, "read-only"), (Sandbox::WorkspaceWrite, "workspace-write"), (Sandbox::DangerFullAccess, "danger-full-access")] {
            for (approval, a) in [(Approval::OnRequest, "on-request"), (Approval::Never, "never"), (Approval::ApproveForMe, "approve-for-me")] {
                let access = Access::Codex { sandbox, approval };
                let value = json!({"engine": "codex", "sandbox": s, "approval": a});
                assert_eq!(serde_json::to_value(access).unwrap(), value);
                assert_eq!(serde_json::from_value::<Access>(value).unwrap(), access);
                assert_eq!((sandbox.name(), approval.name()), (s, a));
            }
        }
    }

    #[test]
    fn unknown_names_are_refused() {
        for bad in [
            json!({"engine": "claude", "mode": "default"}),
            json!({"engine": "claude", "mode": "Manual"}),
            json!({"engine": "claude", "mode": "bypass"}),
            json!({"engine": "claude"}),
            json!({"engine": "codex", "sandbox": "read-only", "approval": "untrusted"}),
            json!({"engine": "codex", "sandbox": "full", "approval": "never"}),
            json!({"engine": "codex", "sandbox": "read-only"}),
            json!({"engine": "gemini", "mode": "manual"}),
            json!({"mode": "manual"}),
        ] {
            assert!(serde_json::from_value::<Access>(bad.clone()).is_err(), "{bad}");
        }
    }

    #[test]
    fn the_old_policy_maps_to_each_engine() {
        assert_eq!(Access::from_policy(Engine::Claude, PolicyMode::Ask), Access::Claude { mode: ClaudeMode::Manual });
        assert_eq!(Access::from_policy(Engine::Claude, PolicyMode::AcceptEdits), Access::Claude { mode: ClaudeMode::AcceptEdits });
        assert_eq!(Access::from_policy(Engine::Codex, PolicyMode::Ask), Access::Codex { sandbox: Sandbox::ReadOnly, approval: Approval::OnRequest });
        assert_eq!(
            Access::from_policy(Engine::Codex, PolicyMode::AcceptEdits),
            Access::Codex { sandbox: Sandbox::WorkspaceWrite, approval: Approval::OnRequest }
        );
    }

    #[test]
    fn only_the_modes_that_never_ask_are_risky() {
        for (mode, _) in CLAUDE {
            let risky = matches!(mode, ClaudeMode::DontAsk | ClaudeMode::BypassPermissions);
            assert_eq!(Access::Claude { mode }.asks_nobody(), risky, "{mode:?}");
        }
        for sandbox in [Sandbox::ReadOnly, Sandbox::WorkspaceWrite, Sandbox::DangerFullAccess] {
            for approval in [Approval::OnRequest, Approval::Never, Approval::ApproveForMe] {
                let risky = sandbox == Sandbox::DangerFullAccess || approval != Approval::OnRequest;
                assert_eq!(Access::Codex { sandbox, approval }.asks_nobody(), risky, "{sandbox:?} {approval:?}");
            }
        }
    }

    #[test]
    fn resolving_checks_engine_sandbox_and_the_tick() {
        let claude = |mode| Some(Access::Claude { mode });
        let codex = |sandbox, approval| Some(Access::Codex { sandbox, approval });
        let ask = PolicyMode::Ask;
        // Nothing asked for: the old policy.
        assert_eq!(Access::resolve(Engine::Codex, None, PolicyMode::AcceptEdits, false), Ok(Access::from_policy(Engine::Codex, PolicyMode::AcceptEdits)));
        // Safe settings start without the tick.
        assert_eq!(Access::resolve(Engine::Claude, claude(ClaudeMode::Plan), ask, false), Ok(Access::Claude { mode: ClaudeMode::Plan }));
        assert!(Access::resolve(Engine::Claude, claude(ClaudeMode::Auto), ask, false).is_ok());
        // Settings that never ask need it.
        for risky in [
            (Engine::Claude, claude(ClaudeMode::BypassPermissions)),
            (Engine::Claude, claude(ClaudeMode::DontAsk)),
            (Engine::Codex, codex(Sandbox::DangerFullAccess, Approval::OnRequest)),
            (Engine::Codex, codex(Sandbox::ReadOnly, Approval::Never)),
            (Engine::Codex, codex(Sandbox::WorkspaceWrite, Approval::ApproveForMe)),
        ] {
            let error = Access::resolve(risky.0, risky.1, ask, false).unwrap_err();
            assert!(error.contains("Tick the box to start without asking"), "{error}");
            assert_eq!(Access::resolve(risky.0, risky.1, ask, true), Ok(risky.1.unwrap()));
        }
        // The other engine's settings are refused, ticked or not.
        assert!(Access::resolve(Engine::Codex, claude(ClaudeMode::Manual), ask, true).is_err());
        assert!(Access::resolve(Engine::Claude, codex(Sandbox::ReadOnly, Approval::OnRequest), ask, true).is_err());
        // Approve for me needs the workspace-write sandbox.
        for sandbox in [Sandbox::ReadOnly, Sandbox::DangerFullAccess] {
            let error = Access::resolve(Engine::Codex, codex(sandbox, Approval::ApproveForMe), ask, true).unwrap_err();
            assert!(error.contains("workspace-write"), "{error}");
        }
    }
}
