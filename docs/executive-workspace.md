# Executive workspace

The Executive page is a workspace for an engineering leader. It keeps decisions, commitments, risks and status from daily work, shows a portfolio of projects, drafts communications, writes briefings and offers a chat assistant. It runs locally with no connectors. Living Memory stays the only durable knowledge store; Hivemind holds the operational records and runs the model calls.

The user approved the design on 2026-11-19. These choices came from the user: commitments are Living Memory action items, the one-shot model calls use Claude Code only, and the scope is the MVP plus automation (a scheduled weekly briefing and style learning from edited drafts).

## Where data lives

| Thing | Lives in | How |
| --- | --- | --- |
| Decisions, risks, status updates, knowledge | Living Memory | Existing note types, tagged `project/<slug>`, written with `capture` |
| Commitments | Living Memory | Action items on the plan note `Commitments: <Project>` (or `Commitments: Cross-project`), written as `Task (owner: Name, due: YYYY-MM-DD)` with `update --add-action`, ticked with `check` |
| Writing preferences | Living Memory | `preference` notes in `_global`, tagged `subject/user` |
| Projects | Living Memory | The existing `projects` registry |
| Milestones, project health, stakeholders | Hivemind | Records under `%APPDATA%\dev.hivemind.app\executive\<kind>\<id>.json` |
| Drafts, generated briefings, capture batches waiting for review | Hivemind | Same record store |

A capture batch is model output that waits for review. It is not memory: it holds fields Living Memory proposals cannot (milestones, owner, due) and the duplicate matches Hivemind looks up. No Living Memory change was needed; every gap was operational data or orchestration.

## What each part does

**Capture** (the header button, or Ctrl+Shift+C on the page). The user pastes meeting notes, a conversation or a document. One Claude call extracts decisions, risks, commitments, status, milestones, knowledge and preferences, each with the line it came from and a confidence. The review dialog shows each item for editing; nothing is written until the user accepts it. An item whose title matches an existing note offers to replace that note (it supersedes it, after a confirm) or to save anyway. Accepted notes carry a `## Source` section with the quote and the capture date.

**Today.** Overdue and due-soon commitments (tick with an undo toast), milestones in the next 14 days, projects at risk with the reason, the capture inbox, the latest briefing, and an ask box that starts an assistant conversation. A paused project counts as at risk only when the user set its health.

**Portfolio.** With no project picked in the sidebar, one row per active project: health, next milestone, open and overdue commitments, open risks, latest status. With a project picked: health (the user's setting, or a suggestion from the signals with its reasons), milestones, commitments (tick or add), risks and open bugs, recent decisions.

**Assistant.** A chat with Claude Code or Codex (`AgentTask::Executive`). It starts in `executive/agent` under the app data folder with no repository, read-only, and its briefing holds 14 days of evidence plus the exact `alm` read commands for the domains in scope (the folder is bound to no domain, so Living Memory's session hook injects nothing). Claude runs with allow rules for the `alm` read verbs and deny rules for the write verbs. The assistant restates decisions and commitments as `Decision:` and `Commitment:` lines; when the conversation ends, Hivemind extracts them into the capture inbox. The Capture button in the chat does the same on demand.

**Communications.** Draft an email, stakeholder update, escalation or executive summary from key points, an audience, a tone and a project. The draft uses the evidence and the accepted writing preferences; missing facts appear as `[placeholders]` and in a "Facts the draft lacks" list. Refine with one of the preset instructions or a custom one; earlier versions can be restored. Copy as Markdown or plain text, or export `.md`, `.txt` or `.eml` (an unsent email with `X-Unsent: 1`). When the user copies or exports a draft they edited, a Claude call compares the generated and kept text and puts up to three writing preferences in the capture inbox.

**Briefings.** A weekly leadership report, project summary, priorities, outstanding commitments or risk assessment, for one project or all active projects, over 7, 14 or 30 days. Every bullet cites evidence; the view numbers the citations, marks bullets that cite nothing, lists the gaps and the sources, and can save the briefing as a status note after a confirm. The Automations template "Weekly leadership briefing" (Mondays at 07:00, off until the user adds it) writes one on a schedule.

## How grounding works

`executive::pack` in `src-tauri/src/executive.rs` builds one evidence pack for briefings, drafts and the assistant: project health (or a gap saying none is set), milestones (overdue flagged), open action items (overdue flagged), the latest status note (a gap when none is newer than 14 days), risks and bugs, decisions in the period, active plans, other recent notes, and writing preferences. Each piece gets an id (E1, E2, ...); the pack is capped at 40,000 characters (20,000 for the assistant). Gaps found while building the pack go to the model and to the reader. The model returns evidence ids in fields of a JSON schema; the frontend keeps only ids the pack really has (`texts.ts knownCitations`, `numbered`) and strips stray ids from draft bodies.

## Model calls

Extraction, drafting, refining, briefings and style learning are tool-free one-shot calls through `src-tauri/src/oneshot.rs` (shared with the commit-learning reviewer): `claude -p --output-format json --tools "" --safe-mode --strict-mcp-config --no-session-persistence --json-schema`, with `LIVING_MEMORY_OFF=1`, secrets redacted from the input, a per-call budget ($0.25 for drafts and extraction, $0.15 for a refine, $0.50 for a briefing) and the shared daily cap (`learning_daily_usd` in Settings). Rust owns every prompt and schema; the webview names the task and sends the user's text. They are refused while Claude Code is hidden in Settings.

## Tests

- `src/features/executive/executive.test.ts`: commitment parsing, health suggestions, the portfolio rows and attention, capture write planning, citations and exports.
- `src-tauri/src/executive.rs` tests: the record store, the evidence pack, staging with duplicate matches, the assistant briefing.
- `live_capture_round_trip` (runs when `HIVEMIND_TEST_LM_SCRIPT` points at a `living_memory.py`): a real store, the pack finds a decision and an overdue commitment, staging flags a repeat, an accepted decision supersedes the old one, the commitment shows in `open`, and `search` finds the new note.
- `live_model_calls` (also needs `HIVEMIND_TEST_CLAUDE`, the `claude` program; about $1): extraction, a weekly briefing whose citations are all in the pack, a draft, a refine and style learning against real Claude calls.

## Limits

- One-shot calls run on Claude Code only. Codex works in the assistant chat, but there it has no rule that blocks a memory write; its read-only sandbox is the only guard.
- Hivemind's governed-command rules (`scope::governed_rules`) match `living_memory.py`, not the `alm` launcher. The executive deny rules cover both spellings; other session kinds still need the fix.
- Health is a suggestion from simple signals (overdue milestones and commitments, open risks, status age). It does not read code or CI.
- Duplicate detection is title overlap within the project domains, not semantic.
- Commitments follow a text convention. An action item written another way still shows, without owner or due date.
- Records live in the app data folder shared by dev builds and the installed app (identifier `dev.hivemind.app`).

## Extension points for connectors

Nothing below is built. Capture batches carry `source: { kind, label, session }`, so an Outlook, Teams or Jira connector adds a source kind (an email thread, a meeting transcript, a ticket) and feeds the same extraction and review. Drafts carry `channel` (`email`, `message`, `document`) and stakeholders carry an `email`, so a Microsoft 365 connector can add a "Send" action behind the same explicit step as Copy and Export. Jira issues could map to commitments through the same `(owner, due)` convention, or to milestones. Any connector goes through the review step; nothing it reads is saved without the user's accept.
