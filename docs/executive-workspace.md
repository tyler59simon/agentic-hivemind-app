# Executive workspace

The executive workspace is for an engineering leader. It keeps decisions, commitments, risks and status from daily work, shows a portfolio of projects, writes briefings and offers a chat assistant. It runs locally with no connectors. Living Memory stays the only durable knowledge store; Hivemind holds the operational records and runs the model calls. It started as the Executive page; CON-3 and CON-5 (2026-11-22) moved it to Home and removed Communications (drafts, refine and style learning).

The user approved the design on 2026-11-19. These choices came from the user: commitments are Living Memory action items, the one-shot model calls use Claude Code only, and the scope is the MVP plus automation (a scheduled weekly briefing; style learning from edited drafts went with Communications).

## Where data lives

| Thing | Lives in | How |
| --- | --- | --- |
| Decisions, risks, status updates, knowledge | Living Memory | Existing note types, tagged `project/<slug>`, written with `capture` |
| Commitments | Living Memory | Action items on the plan note `Commitments: <Project>` (or `Commitments: Cross-project`), written as `Task (owner: Name, due: YYYY-MM-DD)` with `update --add-action`, ticked with `check` |
| Writing preferences | Living Memory | `preference` notes in `_global`, tagged `subject/user` |
| Projects | Living Memory | The existing `projects` registry |
| Milestones, project health, stakeholders | Hivemind | Records under `%APPDATA%\dev.hivemind.app\executive\<kind>\<id>.json` |
| Generated briefings, capture batches waiting for review | Hivemind | Same record store |

A capture batch is model output that waits for review. It is not memory: it holds fields Living Memory proposals cannot (milestones, owner, due) and the duplicate matches Hivemind looks up. No Living Memory change was needed; every gap was operational data or orchestration.

## What each part does

**Capture** (the Capture button on Home, or Ctrl+Shift+C there). The user pastes meeting notes, a conversation or a document. One Claude call extracts decisions, risks, commitments, status, milestones, knowledge and preferences, each with the line it came from and a confidence. The review dialog shows each item for editing; nothing is written until the user accepts it. An item whose title matches an existing note offers to replace that note (it supersedes it, after a confirm) or to save anyway. Accepted notes carry a `## Source` section with the quote and the capture date. A milestone needs a project, and a replacement is offered only for a note in the domain the item is written to. Accept waits until the note list has loaded, so a second commitments note is not started by mistake.

**Home with a project picked.** Open work by due date (overdue, this week, later with milestones, undated), commitments (tick with an undo toast), what needs the user, health (the user's setting, or a suggestion from the signals with its reasons, to confirm or set), the newest briefing, an ask box that starts an assistant conversation, and the project's system. A paused project counts as at risk only when the user set its health.

**Home with All projects.** One row per active project: health, next milestone, open and overdue commitments, open risks, latest status, and what is overdue or due this week across projects.

**Assistant.** The ask box on Home starts a chat in the Agent Workspace with Claude Code or Codex (`AgentTask::Executive`). It starts in `executive/agent` under the app data folder with no repository, read-only, and its briefing holds 14 days of evidence plus the exact `alm` read commands for the domains in scope (the folder is bound to no domain, so Living Memory's session hook injects nothing). Claude runs isolated (`--restricted --tools Bash,PowerShell,TodoWrite --strict-mcp-config --disable-slash-commands`: no user settings, skills, MCP servers or file tools) with allow rules for exactly `alm --json --domain D <read verb>` in each domain in scope and `alm --json open --all-domains --tag`, and deny rules for the write verbs. Claude Code still runs the few built-in commands it treats as read-only (such as `whoami`) without a rule. The assistant restates decisions and commitments as `Decision:` and `Commitment:` lines; when the conversation ends, Hivemind extracts them into the capture inbox. The Capture button in the chat does the same on demand.

**Briefings** (on Home). A weekly leadership report, project summary, priorities, outstanding commitments or risk assessment, for one project or all active projects, over 7, 14 or 30 days. Every bullet cites evidence; the view numbers the citations, marks bullets that cite nothing, lists the gaps and the sources, and can save the briefing as a status note after a confirm. The Automations template "Weekly leadership briefing" (Mondays at 07:00, off until the user adds it) writes one on a schedule.

## How grounding works

`executive::pack` in `src-tauri/src/executive.rs` builds one evidence pack for briefings and the assistant: project health (or a gap saying none is set), milestones (overdue flagged), open action items (overdue flagged; for all projects, also the cross-project commitments), the latest status note (a gap when none is newer than 14 days), risks and bugs, decisions in the period, active plans, other recent notes, and writing preferences. Each piece gets an id (E1, E2, ...); the pack is capped at 40,000 characters (20,000 for the assistant). Gaps found while building the pack go to the model and to the reader. The model returns evidence ids in fields of a JSON schema; the frontend keeps only ids the pack really has (`texts.ts knownCitations`, `numbered`).

## Model calls

Extraction and briefings are tool-free one-shot calls through `src-tauri/src/oneshot.rs` (shared with the commit-learning reviewer): `claude -p --output-format json --tools "" --safe-mode --strict-mcp-config --no-session-persistence --json-schema`, with `LIVING_MEMORY_OFF=1`, secrets redacted from the input, a per-call budget set in Settings, Budgets (`executive_call_usd`; by default $0.25 for extraction and $0.50 for a briefing) and the daily cap shared with the session reviewer (`learning_daily_usd`). Rust owns every prompt and schema; the webview names the task and sends the user's text. They are refused while Claude Code is hidden in Settings.

Managed (organization) Claude Code settings still apply to these calls and to the assistant: Claude Code's documentation says `--safe-mode` keeps "managed settings policy, including policy-configured hooks", `--restricted` "loads only managed settings and `--settings`", and a deployed `managed-mcp.json` makes Claude Code exit at startup on `--strict-mcp-config` (checked 2026-11-19). So before every one-shot call and before a Claude assistant chat starts or restarts, `src-tauri/src/managed.rs` looks for managed policy and refuses with a message that names what it found: `managed-settings.json`, a `.json` file in `managed-settings.d/` or `managed-mcp.json` in `C:\Program Files\ClaudeCode\` (Windows), `/Library/Application Support/ClaudeCode/` (macOS) or `/etc/claude-code/` (Linux), the `Settings` value under `HKLM` or `HKCU\SOFTWARE\Policies\ClaudeCode`, the macOS `com.anthropic.claudecode` managed preferences file, or Claude Code's cache of server-managed settings (`remote-settings.json` in `CLAUDE_CONFIG_DIR` or `~/.claude`). Drop-in files whose names start with a dot are ignored, as Claude Code ignores them. A Codex assistant is not affected.

## Tests

- `src/features/executive/executive.test.ts`: commitment parsing, health suggestions, the portfolio rows and attention, capture write planning and citations.
- `src-tauri/src/executive.rs` tests: the record store, the evidence pack, staging with duplicate matches, the assistant briefing.
- `live_capture_round_trip` (runs when `HIVEMIND_TEST_LM_SCRIPT` points at a `living_memory.py`): a real store, the pack finds a decision and an overdue commitment, staging flags a repeat, an accepted decision supersedes the old one, the commitment shows in `open`, and `search` finds the new note.
- `live_model_calls` (also needs `HIVEMIND_TEST_CLAUDE`, the `claude` program; about $1): extraction and a weekly briefing whose citations are all in the pack against real Claude calls.

## Limits

- One-shot calls run on Claude Code only. Codex works in the assistant chat, but there it has no rule that blocks a memory write; its read-only sandbox is the only guard. The assistant's permission mode cannot be changed after it starts.
- Hivemind's governed-command deny rules (`scope::governed_rules`) name `living_memory.py` only; `scope::governed_memory_command` also recognises the `alm` launcher when a session asks, and Living Memory refuses the launcher's apply, undo, recover and direct-write commands itself while `HIVEMIND_SESSION` is set. Writing a plan is allowed: it is how an agent proposes a merge or delete for the user to apply.
- Hivemind redacts secrets from the briefing and every message it sends to the assistant (`learning::redact`), but not from tool output: Claude Code runs its `alm` reads itself, so a secret stored in a note reaches the model as written.
- The assistant's allow rules are command prefixes, so arguments after them are not checked: a second `--domain`, `--root`, a ref from another domain or `search --rebuild` still run. A project-scoped chat can therefore read other domains of the user's own memory. A Hivemind-owned read tool would close this (user decision 2026-11-19: tracked, not built).
- Each bound domain adds 40 allow rules to Claude's command line; past about 13 domains an all-projects chat would exceed the Windows command-line limit.
- Server-managed settings from the claude.ai console are found only once Claude Code has cached them; a policy it has not fetched yet (a first launch on an organization account) can still apply to Hivemind's Claude calls, hooks included. Under WSL, a Windows policy inherited through `wslInheritsWindowsSettings` is not checked either.
- Health is a suggestion from simple signals (overdue milestones and commitments, open risks, status age). It does not read code or CI.
- Duplicate detection is title overlap within the project domains, not semantic.
- Commitments follow a text convention. An action item written another way still shows, without owner or due date.
- Records live in the app data folder shared by dev builds and the installed app (identifier `dev.hivemind.app`).

## Extension points for connectors

Nothing below is built. Capture batches carry `source: { kind, label, session }`, so an Outlook, Teams or Jira connector adds a source kind (an email thread, a meeting transcript, a ticket) and feeds the same extraction and review. Stakeholders carry an `email`, so a Microsoft 365 connector could add a "Send" action behind an explicit step. Jira issues could map to commitments through the same `(owner, due)` convention, or to milestones. Any connector goes through the review step; nothing it reads is saved without the user's accept.
