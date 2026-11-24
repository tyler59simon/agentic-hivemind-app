# Engineering workspace: roles, learning, skills, automations and drift

This document covers what Hivemind added on top of single agent sessions in November 2026: sessions in roles with permission profiles, a post-session reviewer that drafts notes and skills, a skills library published to Claude Code and Codex, automations that start work on their own, and architecture drift from the Architecture Suite's command line. It describes how each part works, where its files are, what keeps it safe, and what it cannot do. Workflows (a goal run as a task graph of sessions) were deleted on 2026-11-24 (CON-20); their run files in `workflows/` are no longer read.

Living Memory still owns knowledge and the Architecture Suite still owns architecture output. Hivemind uses their command lines and never writes their files.

## Where things live

| Part | Rust | Frontend | Files in the app data folder |
| --- | --- | --- | --- |
| Roles and profiles | `src-tauri/src/agent/roles.rs`, `agent/scope.rs` (`profile_policy`, `deny_rules`) | `features/agents/start.ts` (`PROFILE_HELP`) | none |
| Session reports | `src-tauri/src/conductor.rs`, `agent/mod.rs` (`Lifecycle`) | | none |
| Resource use | `src-tauri/src/resources.rs` | `AgentWorkspace.tsx` (`useResources`) | none |
| Post-session reviewer | `src-tauri/src/learning.rs` | `features/review/LearnedCards.tsx`, `features/skills/SkillsPage.tsx` | `learning/runs.jsonl`, `learning/spend.json` |
| Skills | `src-tauri/src/skills.rs` | `features/skills/` | `skills/library/<name>/`, `skills/proposals/`, `skills/ledger.jsonl`, `skills/usage.jsonl`, `skills/outcomes.jsonl` |
| Automations | `src-tauri/src/automations.rs` | `features/schedules/SchedulesSection.tsx` (Settings, Schedules) | `automations.json`, `automation-runs/<id>.json`, `automation-spend.json` |
| Architecture drift | `src-tauri/src/archsuite.rs` | `features/systems/DriftPanel.tsx` | `architecture-runs/<system>/` |
| Overview | | `features/projects/agentwork.ts`, `OverviewPage.tsx` | none |

`src-tauri/src/lib.rs` holds the Tauri commands and the glue: `AppDoer` (what automations do), and the conductor handlers `learning_reports` and `orchestration_reports`.

## Roles and permission profiles

A chat session can start in a role: architect, developer, reviewer, researcher or tester. A role adds a preamble to the first message and picks a permission profile. Rust builds every permission rule; the webview only names a role or profile.

| Profile | Roles | May do without asking |
| --- | --- | --- |
| `read_only` | architect, reviewer | Read, Glob, Grep, its to-do list, installed skills, and `git log`, `show`, `diff`, `status`, `blame` |
| `research` | researcher | the same, plus WebFetch and WebSearch |
| `edit_worktree` | developer, tester | the same reads, edits inside its own worktree, and the project's allowed commands (Settings, per project) |

A tester edits its worktree so it can run the project's test commands and add tests; like any session's edits, they wait in the Inbox.

Every session, whatever its profile, is denied Living Memory's governed commands and `git push`, `git reset --hard`, `git clean` and `git branch -D`. An attended `edit_worktree` session accepts edits and asks about everything else. An unattended one (the user ticked it, or an automation started it) refuses what is not allowed instead of asking.

A session that never asks (read only, research, or unattended) starts Claude with `--setting-sources user`: the repository's `.claude` settings cannot add allow rules or hooks to it. The user's own settings, Living Memory's hooks and the repository's `CLAUDE.md` still load.

Reviewers and testers end their reply with a verdict line (pass or changes needed), shown on the session. An architect or reviewer whose repository belongs to a registered system gets an Architecture section in its briefing (model, report, how far the output is behind) and the system's architecture folder as an extra folder it may read but not edit: a deny rule on the folder wins over any allow rule, the user's own included. The folder is given again when the session resumes. An attended editing session would accept edits there, so it gets only the paths.

**Ask Codex.** On a code diff in the Inbox, Ask Codex has Codex review the session's edits. Hivemind commits them as a checkpoint on the session's branch (a later approval finds that commit), then starts a read-only Codex reviewer in a worktree at the checkpoint. The reviewer is told the session's base commit, so `git diff <base>..HEAD` shows the same edits. It runs only when asked, and only for a session in its own worktree that is between turns. The session records the reviewer, and the diff links to it with its state and verdict.

## Post-session reviewer

When a chat work session ends in a way worth learning from, Hivemind asks a separate, tool-free Claude call (Sonnet) to read a digest of the session and propose what to keep. The call has no tools, no MCP servers, no session persistence, its own system prompt and a JSON schema, a budget per review set in Settings, Budgets ($0.25 by default), and `LIVING_MEMORY_OFF=1` so Living Memory's hooks stay out of it. Before the call, Hivemind removes credentials it recognizes from the digest or commit log: private keys, tokens with a known prefix (`sk-`, `ghp_`, `AKIA` and others), passwords in URLs, and values of settings named like `password`, `secret`, `token` or `api_key`.

- **When it runs:** after the user approves a session's edits (notes and skills), after the user dismisses them (notes only), and after a session without edits that made at least 15 tool calls (notes only). Each session is reviewed once; a failed review can be run again from the session's rail.
- **What it produces:** note drafts staged with Living Memory's `propose` (the user saves or rejects them in the Inbox, Memory group), and at most one skill proposal. "Nothing" is a normal answer.
- **Daily cap:** Settings, Spend, sets the most the reviewer, the executive calls, and the commit reviews and briefings automations ask for may spend per UTC day (default $1). Each review reserves its limit per call ($0.25 by default) first and settles at its real cost; a crash leaves the reservation counted. Sessions and wiki rebuilds started by automations have their own daily budget (default $5).

## Skills

A skill is a `SKILL.md` procedure Claude Code and Codex load by name. Hivemind keeps every version in its library and publishes the current one to `~/.claude/skills/<name>` and `~/.codex/skills/<name>`, each with a `.hivemind-skill.json` marker (name, version, SHA-256). `HIVEMIND_SKILL_DIRS` replaces those two folders, for tests.

- A skill comes from a session whose edits the user approved, or from a runbook note (Make a skill). Every proposal needs When to use, When not to use and Steps sections, and the user's approval. Settings can let reviewed patches to a skill with at least 3 approved uses apply without asking (off by default).
- Hivemind never writes a folder without its marker, so it cannot overwrite a skill it did not make. A published copy edited by hand is shown as edited; the user keeps the edit as a new version or restores a version.
- Uses are read from session logs (Claude's Skill tool, and Codex reading a `SKILL.md`). Reliability is the share of sessions that used the skill and were approved. It is a correlation, not proof that the skill helped.
- Upkeep proposes archiving skills unused for 30 days, or with reliability under 50% over 4 or more uses. Archiving unpublishes and keeps every version.
- `skills/ledger.jsonl` records who changed what, and every change can be undone by restoring a version.

## Automations

An automation starts work on its own while Hivemind runs (the tray keeps it running with the window closed). They are listed in Settings, Schedules: the built-in schedules (briefings, memory maintenance, weekly wiki rebuilds) always show, and other automations show while "Show custom automations" is on, a per-computer choice that does not stop them running. `automations.json` is read entry by entry: an entry that no longer reads (such as an automation that started a workflow) is dropped, after the file is copied to `automations.json.bak-<ms>`.

- **Triggers:** every N hours, daily or weekly at a local time, when a session fails (it ends with an error, or a chat turn crashes or errors; a turn the user stopped does not count), when the user approves a session's edits, after new commits on a project repository (HEAD is checked once a minute), or only by hand. An automation set to a project hears only that project's events (and only its repository's, when it names one).
- **Actions:** an unattended session in a role (not developer), Living Memory's own maintenance run, a briefing, a weekly rebuild of a project's agent wiki, skill upkeep, the reviewer over new commits (note drafts for Review), and an architecture drift check.
- **Policy per automation:** ask before each run (the run waits in Settings, Schedules with a notification), a Claude budget per session (never above the session budget in Settings), and notifications for every run, failures only, or never. A drift check notifies when it finds drift.
- **Limits:** one run per automation at a time; a trigger that fires meanwhile is dropped, and a scheduled time that comes while a run is still open is skipped. A queued trigger is checked again against the definition when it is admitted: an automation turned off or moved to another project meanwhile does not run, and a waiting event run whose automation moved to another project is cancelled when approved. Each due automation runs on its own thread, so a slow one delays no other. Role runs and wiki rebuilds count against the automation budget in Settings, Spend ($5 a day by default), and start (or, when they waited for approval, can be approved) only when their budget fits in what is left today. The budget checked is the one the run gets: its own, never above the spend cap per agent run (`run_budget` in `lib.rs`); a wiki rebuild passes that figure as `--budget`. A rebuild that leaves pages failed or unbuilt ends as failed, keeping its cost. A Codex role session is not checked or counted, since Codex bills the user's ChatGPT plan, not dollars. Follow-up turns the user sends to an automation's session count as the user's own spending, not the automation's; each is still capped per run. Commit-capture and briefing runs count against the learning and executive budget, shared with the reviewer, and do not start when it is spent. A session starts without holding up other automations; a report that comes before its run has recorded it is kept until the run has. A cancelled run still counts what its session cost. A schedule missed while Hivemind was closed runs once at the next start; a run still marked running from before is marked failed.
- **Repositories:** an automation's repository must be registered for its project in Living Memory. Commit capture reads `git log -p` with external diff and text conversion helpers off.
- **No loops:** event triggers ignore work an automation started (its sessions).

## Architecture drift

The Drift panel on Home's Architecture tab, and the architecture-check automation, run the Architecture Suite's command line (`skills/architecture-suite-runtime/scripts/architecture-suite.py` in the plugin folder set in Settings) with the interpreter its one-time setup installs (`~/.architecture-suite/runtime`, or `HIVEMIND_ARCHSUITE_PYTHON`). Results go to `architecture-runs/<system>/<time>/`; the system's architecture folder is only read.

A drift check reports:
- commits on the repository since the output was made (from the passport session's source commit);
- output files whose SHA-256 no longer matches the Suite's manifest (edited by hand, or missing);
- structural changes from the newest earlier snapshot whose model differs (`diff`);
- rule findings, when the system has an `architecture-rules/v1` file (set in the Drift panel; `check`);
- diagram layout findings (`verify`).

Regenerating the output stays a user action (Generate with agent), because the passport brief is built in the UI.

## Overview

"Needs your review" also lists learned drafts, automation runs waiting or failed today, architecture drift beyond the commits it already shows, and stale or duplicate notes. "Agent activity" merges finished sessions, automation runs and skill changes, newest first.

## How this differs from Hermes Agent, and why

Hermes Agent learns skills with a forked reviewer after turns, prefers patching, counts uses and archives stale skills. Hivemind keeps those ideas and changes the rest:

- **Skills need an outcome and an approval.** Living Memory's own evaluation retired learned runbooks on 2026-11-16 because they were no better than notes and were applied to lookalike cases. So skills come only from approved work, must say when not to use them, and need the user's approval by default.
- **Memory stays in Living Memory.** The reviewer stages `propose` drafts; Hivemind keeps no memory file of its own.
- **The reviewer is a separate headless call.** Hivemind drives external CLIs, so it cannot fork their agent loop. A tool-free call over a digest is cheaper and cannot act.
- **Left out:** a messaging gateway, container backends, and model-judged command approval. Approvals stay with the user or with rules Rust builds.

## Known limits

- Sessions stop when Hivemind exits; automations run only while it runs.
- A role run or wiki rebuild is admitted only when its budget fits in what is left of the automation budget, but nothing is reserved: runs that start together all see the same balance.
- Credential removal before the reviewer call is a pattern match; a secret of an unknown shape in a session or commit still reaches Claude.
- Every session is denied `--output`, `--ext-diff` and `--textconv` with any git command, but a diff helper or text conversion the repository's own git config sets up still runs for a plain `git diff`, as it does for the user.
- Role sessions load the user's own Claude Code settings, for Living Memory's hooks, so the user's allow rules apply in them too; only the deny rules Hivemind adds (destructive git, governed Living Memory commands, unsafe git options, the architecture folder) win over them.
- Claude deny rules match command text and can be bypassed through another shell; worktree isolation and ask-by-default are the real guard.
- Codex has no deny-rule flag, so profiles are weaker there. On Windows Codex's sandbox refuses many shell commands in unattended sessions; automations default to Claude.
- Skill reliability counts correlations from review outcomes.
- The terminal (CLI) sessions keep no event log, so the reviewer and skill-use tracking cover chat sessions only.
