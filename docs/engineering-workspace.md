# Engineering workspace: roles, learning, skills, workflows, automations and drift

This document covers what Hivemind added on top of single agent sessions in November 2026: sessions in roles with permission profiles, a post-session reviewer that drafts notes and skills, a skills library published to Claude Code and Codex, workflows that run several agents in order, automations that start work on their own, and architecture drift from the Architecture Suite's command line. It describes how each part works, where its files are, what keeps it safe, and what it cannot do.

Living Memory still owns knowledge and the Architecture Suite still owns architecture output. Hivemind uses their command lines and never writes their files.

## Where things live

| Part | Rust | Frontend | Files in the app data folder |
| --- | --- | --- | --- |
| Roles and profiles | `src-tauri/src/agent/roles.rs`, `agent/scope.rs` (`profile_policy`, `deny_rules`) | `features/agents/start.ts` (`PROFILE_HELP`) | none |
| Session reports | `src-tauri/src/conductor.rs`, `agent/mod.rs` (`Lifecycle`) | | none |
| Resource use | `src-tauri/src/resources.rs` | `AgentWorkspace.tsx` (`useResources`) | none |
| Post-session reviewer | `src-tauri/src/learning.rs` | `features/review/LearnedCards.tsx`, `features/skills/SkillsPage.tsx` | `learning/runs.jsonl`, `learning/spend.json` |
| Skills | `src-tauri/src/skills.rs` | `features/skills/` | `skills/library/<name>/`, `skills/proposals/`, `skills/ledger.jsonl`, `skills/usage.jsonl`, `skills/outcomes.jsonl` |
| Workflows | `src-tauri/src/workflow.rs` | `features/workflows/WorkflowsPage.tsx` (Runs tab) | `workflows/<id>.json` |
| Automations | `src-tauri/src/automations.rs` | `features/workflows/WorkflowsPage.tsx` (Automations tab) | `automations.json`, `automation-runs/<id>.json` |
| Architecture drift | `src-tauri/src/archsuite.rs` | `features/systems/DriftPanel.tsx` | `architecture-runs/<system>/` |
| Overview | | `features/projects/agentwork.ts`, `OverviewPage.tsx` | none |

`src-tauri/src/lib.rs` holds the Tauri commands and the glue: `AppHost` (how workflows start sessions), `AppDoer` (what automations do), and the conductor handlers `learning_reports` and `orchestration_reports`.

## Roles and permission profiles

A chat session can start in a role: architect, developer, reviewer, researcher or tester. A role adds a preamble to the first message and picks a permission profile. Rust builds every permission rule; the webview only names a role or profile.

| Profile | Roles | May do without asking |
| --- | --- | --- |
| `read_only` | architect, reviewer | Read, Glob, Grep, its to-do list, installed skills, and `git log`, `show`, `diff`, `status`, `blame` |
| `research` | researcher | the same, plus WebFetch and WebSearch |
| `edit_worktree` | developer, tester | the same reads, edits inside its own worktree, and the project's allowed commands (Settings, per project) |

A tester edits its worktree so it can run the project's test commands and add tests; like any session's edits, they wait in Review.

Every session, whatever its profile, is denied Living Memory's governed commands and `git push`, `git reset --hard`, `git clean` and `git branch -D`. An attended `edit_worktree` session accepts edits and asks about everything else. An unattended one (the user ticked it, or a workflow or automation started it) refuses what is not allowed instead of asking.

Reviewers and testers end their reply with a verdict line (pass or changes needed), shown on the session and in workflow reports. An architect or reviewer whose repository belongs to a registered system gets an Architecture section in its briefing (model, report, how far the output is behind) and the system's architecture folder as an extra readable folder.

## Post-session reviewer

When a chat work session ends in a way worth learning from, Hivemind asks a separate, tool-free Claude call (Sonnet) to read a digest of the session and propose what to keep. The call has no tools, no MCP servers, no session persistence, its own system prompt and a JSON schema, a budget of $0.25, and `LIVING_MEMORY_OFF=1` so Living Memory's hooks stay out of it.

- **When it runs:** after the user approves a session's edits (notes and skills), after the user dismisses them (notes only), and after a session without edits that made at least 15 tool calls (notes only). Each session is reviewed once; a failed review can be run again from the session's rail.
- **What it produces:** note drafts staged with Living Memory's `propose` (the user saves or rejects them in Review, Learned tab), and at most one skill proposal. "Nothing" is a normal answer.
- **Daily cap:** Settings sets the most the reviewer and paid automations may spend per UTC day (default $1). Each call reserves $0.25 first and settles at its real cost; a crash leaves the reservation counted.

## Skills

A skill is a `SKILL.md` procedure Claude Code and Codex load by name. Hivemind keeps every version in its library and publishes the current one to `~/.claude/skills/<name>` and `~/.codex/skills/<name>`, each with a `.hivemind-skill.json` marker (name, version, SHA-256). `HIVEMIND_SKILL_DIRS` replaces those two folders, for tests.

- A skill comes from a session whose edits the user approved, or from a runbook note (Make a skill). Every proposal needs When to use, When not to use and Steps sections, and the user's approval. Settings can let reviewed patches to a skill with at least 3 approved uses apply without asking (off by default).
- Hivemind never writes a folder without its marker, so it cannot overwrite a skill it did not make. A published copy edited by hand is shown as edited; the user keeps the edit as a new version or restores a version.
- Uses are read from session logs (Claude's Skill tool, and Codex reading a `SKILL.md`). Reliability is the share of sessions that used the skill and were approved. It is a correlation, not proof that the skill helped.
- Upkeep proposes archiving skills unused for 30 days, or with reliability under 50% over 4 or more uses. Archiving unpublishes and keeps every version.
- `skills/ledger.jsonl` records who changed what, and every change can be undone by restoring a version.

## Workflows

A workflow runs a goal as tasks, each an agent session in a role, with dependencies between them. The built-in templates are Feature (architect, then developer, then reviewer and tester in parallel), Review (reviewer and architect in parallel) and Investigate a failure (researcher, then developer). The user can edit any task before starting.

- A task starts when every task it depends on has succeeded or was skipped. At most three sessions run at once (`MAX_RUNNING`); a task that finds no free slot waits for the next report.
- When an editing task succeeds, Hivemind commits its edits as a checkpoint on the task's own `hivemind/<id8>` branch. A task with "worktree starts from" set gets a new worktree branched from that checkpoint, so parallel and sequential agents never share a working tree.
- Each task's briefing has the goal, its own task, and for each task it depends on: the role, branch, files changed, verdict and summary (up to 2,000 characters).
- A failed task blocks what depends on it until the user retries or skips it. Cancelling stops running sessions. A run that was running when Hivemind stopped comes back with its running tasks failed, ready to retry.
- Nothing is merged or pushed. Each editing task's branch waits in Review like any session's; approving it adopts the checkpoint commit.
- The run report (Markdown, Copy report) lists each task's state, branch, checkpoint, verdict and summary.

## Automations

An automation starts work on its own while Hivemind runs (the tray keeps it running with the window closed).

- **Triggers:** every N hours, daily or weekly at a local time, when a session fails, when the user approves a session's edits, after new commits on a project repository (HEAD is checked once a minute), or only by hand.
- **Actions:** an unattended session in a role (not developer), a workflow from a template, Living Memory's own maintenance run, skill upkeep, the reviewer over new commits (note drafts for Review), and an architecture drift check.
- **Policy per automation:** ask before each run (the run waits on the Automations tab with a notification), a Claude budget per session (never above the session budget in Settings), and notifications for every run, failures only, or never. A drift check notifies when it finds drift.
- **Limits:** one run per automation at a time; a trigger that fires meanwhile is dropped. Role, workflow and commit-capture runs count against the same daily cap as the reviewer, and do not start when it is spent. A schedule missed while Hivemind was closed runs once at the next start.
- **No loops:** event triggers ignore work an automation started (its sessions and its workflows). Approving a task of a workflow the user started does fire them.

## Architecture drift

The Drift panel on the Architecture page, and the architecture-check automation, run the Architecture Suite's command line (`skills/architecture-suite-runtime/scripts/architecture-suite.py` in the plugin folder set in Settings) with the interpreter its one-time setup installs (`~/.architecture-suite/runtime`, or `HIVEMIND_ARCHSUITE_PYTHON`). Results go to `architecture-runs/<system>/<time>/`; the system's architecture folder is only read.

A drift check reports:
- commits on the repository since the output was made (from the passport session's source commit);
- output files whose SHA-256 no longer matches the Suite's manifest (edited by hand, or missing);
- structural changes from the newest earlier snapshot whose model differs (`diff`);
- rule findings, when the system has an `architecture-rules/v1` file (set in the Drift panel; `check`);
- diagram layout findings (`verify`).

Regenerating the output stays a user action (Generate with agent), because the passport brief is built in the UI.

## Overview

"Needs your review" also lists learned drafts, automation runs waiting or failed today, workflows that failed in the last three days, architecture drift beyond the commits it already shows, and stale or duplicate notes. "Agent activity" merges finished sessions, workflow runs, automation runs and skill changes, newest first.

## How this differs from Hermes Agent, and why

Hermes Agent learns skills with a forked reviewer after turns, prefers patching, counts uses and archives stale skills. Hivemind keeps those ideas and changes the rest:

- **Skills need an outcome and an approval.** Living Memory's own evaluation retired learned runbooks on 2026-11-16 because they were no better than notes and were applied to lookalike cases. So skills come only from approved work, must say when not to use them, and need the user's approval by default.
- **Memory stays in Living Memory.** The reviewer stages `propose` drafts; Hivemind keeps no memory file of its own.
- **The reviewer is a separate headless call.** Hivemind drives external CLIs, so it cannot fork their agent loop. A tool-free call over a digest is cheaper and cannot act.
- **Delegation is a visible task graph** of real sessions with their own worktrees, not a tool the model calls.
- **Left out:** a messaging gateway, container backends, and model-judged command approval. Approvals stay with the user or with rules Rust builds.

## Known limits

- Sessions stop when Hivemind exits; automations run only while it runs.
- Claude deny rules match command text and can be bypassed through another shell; worktree isolation and ask-by-default are the real guard. `git diff --output` and `git log --output` can write a file inside the worktree.
- Codex has no deny-rule flag, so profiles are weaker there. On Windows Codex's sandbox refuses many shell commands in unattended sessions; automations default to Claude.
- Skill reliability counts correlations from review outcomes.
- Parallel editing tasks are not merged. Each branch is approved on its own.
- Approving a workflow task adopts its checkpoint commit; the commit message typed at approval is not used.
- The terminal (CLI) sessions keep no event log, so the reviewer and skill-use tracking cover chat sessions only.
