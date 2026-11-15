# Phase 6: the terminal behaves like the real CLI

Phase 5 (PR #10, merged 2026-11-15) added an embedded terminal that runs the real `claude` (Claude Code 2.1.325) and `codex` (codex-cli 0.169.0). This phase removes its known limits so that the Hivemind terminal behaves like either CLI in a normal terminal window, and the user never has to open the real CLI.

Read `README.md` in this folder first, then `phase-5-codex-and-terminal.md` (sections 4 to 7 describe the code this phase changes). Where this document and the Phase 5 document disagree, this one wins.

## 1. Decisions (the user, 2026-11-15; do not reopen)

| Topic | Decision |
| --- | --- |
| Where a terminal runs | The project's real checkout (the default), a new worktree, or any folder the user picks |
| Task | Optional. An empty task starts the bare CLI with no first prompt; the briefing file is still written |
| Closing Hivemind | While anything runs, closing the window hides Hivemind to the tray; tray Quit lists what runs and asks first |
| Spending | Tokens and cost in the status line; banners at 80% and 100% of the limit; Hivemind never stops a program for spending |
| Permission modes | Every mode each CLI has, by its CLI name; modes that never ask need a confirm tick under a red warning |
| Outside conversations | List the conversations each CLI saved for a folder and resume one in a Hivemind terminal |
| Attention | Dot on the tab and on Agent Workspace in the sidebar; Windows notification when Hivemind is not focused; clicking it opens the terminal |
| Review | "Stop and approve"; "Request changes" resumes the CLI with a pointer to a comments file; checkout and folder sessions get a read-only diff and no Approve or Discard |
| Transcript | Terminal / Transcript toggle above the terminal; ended sessions open on Transcript |
| CLI habits | Paste images, drag files in, search with Ctrl+Shift+F (Ctrl+F stays with the CLI), two panes side by side, rename |
| Memory plans | Kept. Living Memory's hook refuses `apply`, `undo`, `recover` and `setup --apply-plan` when `HIVEMIND_SESSION` is set (Living Memory PR) |
| Split | Two panes, tabs for the rest; up to 8 programs; the sign-in terminal does not count |
| Shell | PowerShell tabs in a checkout, any folder, or "Open PowerShell here" on a session; never a worktree of their own |
| Codex | Model and effort pickers; stays in inline mode (`--no-alt-screen`) |
| No-project folders | An "Other folders" entry in the project picker |
| Same folder twice | Allowed, with a warning that offers a new worktree |
| Tab names | The CLI's own title once it exists, else the task, else the folder name; the user can rename |
| Platforms | Windows only; keep code portable and report macOS and Linux as untested |
| Delivery | Living Memory PR first, then PR 1 to PR 4 below, each with its own checks and one Codex review |

Corrections to Phase 5: folder trust is saved per repository root by both CLIs, so the trust prompt comes once per repository, as in the real CLI (not "every session"). `codex login` started while signed in begins a new sign-in, and closing it unfinished signs the CLI out (codex-cli 0.169.0).

## 2. Rules kept from Phase 5

- Lock order: `term::Inner.terms` first, then the agent manager's session lock (`agents.info`, `amend`); never the reverse. Never call `pty.close()` while `terms` is held.
- Hivemind never answers the CLIs' prompts and never types into a CLI for the user. A first prompt (the briefing pointer, the review pointer) is a launch argument.
- Hivemind never reads or stores credentials, and never edits the user's own CLI config files (`~/.claude/settings.json`, `~/.claude.json`, `~/.codex/config.toml`, `~/.codex/hooks.json`). Per-session behaviour goes through a `--settings <file>` written under the app data folder (Claude) and `-c key=value` overrides (Codex).
- Reading the CLIs' own conversation files is allowed, read-only, from paths built from the home folder plus validated ids.
- `cargo fmt` is never run. Rust strings never contain raw line breaks (use `\n`). xterm packages are pinned to exact versions.
- Tests never start the real `claude` or `codex`.

## 3. PR 1: terminal habits (`feat/terminal-habits`)

1. This document; the Phase 5 known-limits correction; README table row.
2. Keys (`src/features/terminal/keys.ts`, `registry.ts`): `keyAction` gains `search` for Ctrl+Shift+F; F5, Ctrl+R and Ctrl+Shift+R are swallowed so WebView2 never reloads; scrollback 10000 lines. Tests in `keys.test.ts`.
3. Image paste (`registry.ts`): a capture-phase `paste` listener on the terminal host. Text pastes go through as today. When the clipboard has no `text/plain`, Hivemind sends the CLI's own image-paste key with `termWrite`: Claude Code `\x1bv` (Alt+V), Codex `\x16` (Ctrl+V). The CLI reads the Windows clipboard itself; Hivemind never decodes images. Checks U1, U2, U13.
4. Drag files in: Tauri's `getCurrentWebview().onDragDropEvent` (WebView2's HTML drop has no paths). On `drop`, hit-test the position against each visible `.term-host` (U16) and call `live.term.paste(quotePaths(paths))`. Pure `quotePaths` in `src/features/terminal/paths.ts`: each path in double quotes, space-separated.
5. Search and OSC 52: `@xterm/addon-search` exactly `0.16.0`; a `FindBar` in `TerminalView.tsx` (input, next, previous, match count, Escape closes) opened by Ctrl+Shift+F or a magnifier button. `term.parser.registerOscHandler(52, ...)` writes decoded text to the clipboard; read requests (`?`) are ignored. Pure decoder in `osc52.ts`.
6. Split panes: `src/features/terminal/layout.ts`, a Zustand store persisted as `hivemind.terms`: `{ split: boolean, panes: [string[], string[]], active: [string|null, string|null], focus: 0|1 }` with pure moves (`openIn`, `moveTab`, `closeTab`, `toggleSplit`) and tests. `TerminalWorkspace.tsx` renders one or two panes, each with its own tab strip; tab pills can be dragged between panes with pointer events (not HTML5 drag and drop: Tauri's native file drop, needed for item 4, swallows HTML5 `dragover` and `drop` in WebView2), and each pill has "Move to other pane". The registry stays the only owner of xterm instances (decision D10): a terminal is in at most one pane, and `registry.mount` focuses only the focused pane. The route's `session` is the focused pane's active tab. Update `README.md` decision 2: terminals may show two panes.
7. `MAX_TERMINALS = 8` in `src-tauri/src/term/mod.rs`; entries whose id starts with `login-` are not counted. Update the limit test. `launch::environment` also sets `HIVEMIND_SESSION=<terminal id>` for every program Hivemind starts (the Living Memory guard in section 7 reads it).
8. Rename: `SessionInfo.name: Option<String>` (`#[serde(default)]`), command `agent_rename(session_id, name)` through `Manager::amend` (trimmed, at most 80 characters, empty clears). `tabLabel` prefers `name`, then the CLI title (`SessionInfo.cli_title`, filled in PR 3), then the task, then the folder name. Double-click a tab to rename it inline. Claude Code also receives `--name <name>` on start and resume (U12).
9. Tray: `src/App.tsx` close guard hides the window instead of closing whenever `termList()` is non-empty or a chat turn runs, with a one-time toast "Hivemind keeps running in the tray". Tray Quit (`src-tauri/src/capture.rs`) shows the window and emits `quit-requested`; a `QuitDialog` lists what runs (pure `runningSummary()`), and "Quit" invokes a new `app_quit` command (`app.exit(0)`). `RunEvent::Exit` still runs `stop_all`.

Checks in the app: paste text and an image, drop two files, Ctrl+Shift+F finds text, F5 does nothing, split and drag a tab between panes, 8 terminals plus sign-in, rename, close the window and see the terminal keep printing, tray Quit lists it.

## 4. PR 2: where and how (`feat/terminal-places`)

1. `Settings.other_folders: Option<Vec<String>>`; `folder_pick` uses `tauri-plugin-dialog` 2.8.4 from Rust (`blocking_pick_folder`), so a folder path only enters the app through the native picker; `folder_forget(path)`.
2. Direct sessions: `AgentTask::Folder { path }` (accepted only if `path` is in `other_folders`); `StartOptions.place: worktree | checkout` (default `checkout` for terminals); `SessionInfo.direct: Option<Direct { path, repo: Option<String>, head_sha: Option<String>, start_tree: Option<String> }>`. `start_task` skips `worktree::create` for them. The start snapshot: copy `.git/index` to a temp file, run `git add -A` with `GIT_INDEX_FILE` pointing at the copy, then `git write-tree`; store the tree as `start_tree` and `HEAD` as `head_sha`. The user's real index is only read. Not a git folder: no snapshot, no "Files changed". `term::open` uses `worktree.path` or `direct.path`. Chat sessions stay worktree-only.
3. Optional task: an empty task is allowed for terminals; the briefing is still written; no prompt argument; the title is "<engine> · <folder name>".
4. Modes: `SessionInfo.access: Option<Access>`, a tagged enum: `Claude { mode: manual | acceptEdits | plan | auto | dontAsk | bypassPermissions }` and `Codex { sandbox: read-only | workspace-write | danger-full-access, approval: on-request | never }`. Serde is the allow-list. `None` maps from the old `policy` (Ask = manual / read-only + on-request; AcceptEdits = acceptEdits / workspace-write + on-request). `launch::session_args` builds the flags. No-prompt modes (`bypassPermissions`, `dontAsk`, `danger-full-access`, approval `never`) need the confirm tick. U14: codex-cli 0.169.0 lists only `on-request` and `never` for `-a`, so `untrusted` is not offered. Codex also has `--approve-for-me` (approvals go to Codex's automatic reviewer, in the workspace-write sandbox); it is offered as approval `approve-for-me`, sent as `--approve-for-me` alone (codex-cli 0.169.0 refuses it next to `-s`: "the argument '--approve-for-me' cannot be used with '--sandbox <SANDBOX_MODE>'"), and needs the confirm tick because the user is not asked.
5. Models and effort: `agent_models(engine)`: Claude aliases (`sonnet`, `opus`, `haiku`, `fable`) and efforts from `claude --help` (`low medium high xhigh max`); Codex from `codex debug models` (U6, checked on 0.169.0: JSON `{"models":[{"slug","display_name","visibility","default_reasoning_level","supported_reasoning_levels":[{"effort"}]}]}`, about 650 KB, 0.15 s; keep entries with `visibility` `list`; cached 10 minutes; fallback `~/.codex/models_cache.json`), with defaults read from the top-level `model` and `model_reasoning_effort` keys of `~/.codex/config.toml` (read-only). `SessionInfo.effort: Option<String>`. Claude gets `--model`, `--effort`; Codex gets `-m <model> -c model_reasoning_effort="<effort>"`, both validated against the list. Fix the Claude model check that rejects `fable`.
6. PowerShell tabs: `term_shell(target, cols, rows, output)` where `target` is `{ session }`, `{ checkout: { project, repo } }` or `{ folder }` (must be in `other_folders`). Program `pwsh.exe` (PATH or `%ProgramFiles%\PowerShell\7`) else `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe -NoLogo`. Ids `shell-<uuid>`, no scrollback file, no session record. `TermInfo` gains `label` and `cwd` so shell tabs come back from `term_list` after a page reload. A bell on a shell tab sets its attention dot (PR 3).
7. Start screen (`StartSession.tsx`): "Where" (This checkout, New worktree, Another folder…), the optional task, the engine's own modes with the red warning and confirm, model and effort, and the same-folder warning ("Another terminal is working in this folder; their edits can collide", Start anyway / Use a new worktree). Sidebar project picker (`src/shell/Sidebar.tsx`) gains "Other folders" (sentinel `~other`, never sent to Living Memory); `tabs.ts inProject` handles it.

Checks in the app: start in the checkout, a folder and a worktree; empty task; each mode's flags on the stand-in's echo; the red confirm; PowerShell in each place; the same-folder warning.

## 5. PR 3: visibility (`feat/terminal-visibility`)

1. `src-tauri/src/term/cli_files.rs`: Claude's transcript is `~/.claude/projects/<cwd with : \ / . replaced by ->/<session id>.jsonl` (U8: on a miss, scan folders for `<id>.jsonl`). Codex's thread: the rollout under `~/.codex/sessions/YYYY/MM/DD/` on or after the session's start whose first `session_meta.cwd` matches the session folder; stored as `SessionInfo.engine_session`. Codex resumes with `resume <thread id>`; `--last` only when no thread is known; a stale id clears `engine_session` and offers Start over.
2. Transcript: `agent_transcript(session_id)` builds Phase 2 events. Claude: reuse `ClaudeCode::parse_line` (`agent/claude.rs`) for assistant text, tool use and results; add user messages (non-meta, not `isSidechain`) and denials (`permissionDecision` with a deny). Codex: `response_item` messages (skip injected environment and AGENTS blocks), `function_call` and `custom_tool_call` with their outputs, `task_complete`. Rendered by the existing `Transcript` (`src/features/agents/`) without the chat controls, behind a Terminal / Transcript toggle; ended sessions open on Transcript; refetch every 3 s while running. The CLI title (`ai-title`; Codex `thread_name` from `session_index.jsonl`) fills `SessionInfo.cli_title`.
3. Usage: `agent_usage(session_id)` returns tokens in and out, cached tokens, `cost_usd` with `cost_exact` (Claude `cost-state.totalCostUSD` when present, U7; else tokens times a price table in `term/pricing.rs`, shown with "≈"), and Codex `rate_limits` `used_percent`. Status line text "12.4k tokens · $0.31"; banners at 80% (yellow) and 100% (orange) of `agent_budget_usd` or of the Codex plan limit. Never a kill.
4. Attention: Claude gets `--settings <app data>/terminals/<id>/settings.json` holding exec-form `Notification` and `Stop` hooks that run Hivemind's own executable with `--hivemind-signal` (a small mode in `main.rs` that reads the hook JSON on stdin and appends one line to `$HIVEMIND_SIGNAL_DIR/signals.jsonl`; U4, U18). Codex gets `-c tui.notifications=["approval-requested","agent-turn-complete"] -c tui.notification_method="osc9"`, and the PTY reader scans output for OSC 9 and BEL (`term/signal.rs`, pure scanner across chunk boundaries; U5; fallback: quiet 2 s plus an unanswered call in the rollout). `Shared.attention` is set without holding `terms`; event `term-attention`; `term_seen(id)` and any `term_write` clear it. Dots on tabs and on the Agent Workspace nav item.
5. Windows notifications: `tauri-winrt-notification` 0.8.1 under `cfg(windows)`, sent from Rust when the main window is hidden or unfocused; a click shows the window and emits `open-session` (U9; fallback: open the last-notified session on next focus). No capability change. The one-time "Hivemind keeps running in the tray" notice (PR 1) moves to a Windows notification too: as an in-app toast it is raised just as the window hides, so it is not seen.
6. CLI history: `cli_history(engine, target)` lists the newest 50 conversations for a folder (title, updated time, id) from the files in step 1; `agent_import(engine, cli_id, target)` creates a terminal session with `engine_session` set and opens it in Resume mode. Start screen: "Resume a CLI conversation".
7. Sign-in status: `agent_auth_status(engine)` runs `claude auth status` (JSON `loggedIn`) or `codex login status` (exit 255 = signed out) with a 10 s timeout. `ConnectionDialog` shows "Signed in" or "Not signed in"; "Sign in" only when signed out; "Sign in with another account" behind a confirmation that names the Codex sign-out trap.

Checks in the app: dots, a notification and its click; transcript and usage for both CLIs; banners; resume a conversation started outside Hivemind; sign-in status shows "Signed in" without starting a sign-in.

## 6. PR 4: review (`feat/terminal-review`)

1. Direct sessions on the Review page: `review.rs checked_direct` (the path must be the project's registered repository or in `other_folders`); files and diffs compare `start_tree` with a fresh snapshot (same temp-index method), so edits that existed before the session are excluded (U17; fallback: diff against `head_sha`, labelled "includes earlier uncommitted edits"). `CodeReview.tsx` shows the diff read-only with "Commit these yourself"; no Approve or Discard; Dismiss stays.
2. Stop and approve: `term::Manager::stop(id)` closes and waits up to 10 s until the session is not running; `review_stop_and_approve(session_id, message)` calls it, then `review::approve`. The button replaces the disabled Approve for a running terminal session with a worktree.
3. Request changes for terminals: write the comments to `<app data>/terminals/<id>/context/review-<n>.md`, stop the program if it runs, then `term::Manager::resume_with(id, file, &held)` under the held reservation: Claude `--resume <id> ... "Read the file <path>. It holds review feedback on your changes."`, Codex `resume <thread> ... "<same>"`. The spawn starts without an output channel; the view attaches when shown.

Checks in the app: a direct session's diff excludes earlier edits; Stop and approve; Request changes resumes with the pointer prompt.

## 7. Living Memory PR (`agentic-living-memory`, `feat/hivemind-guard`)

`core/runtime.py`, pre-tool-use: when `HIVEMIND_SESSION` is set and the shell command's Living Memory subcommand (from `memory_subcommand()`) is governed (`apply`, `undo`, `recover`, `setup --apply-plan`), deny with detail `deny:hivemind`; fail closed when parsing fails but the text names Living Memory with a governed word. Hivemind sets `HIVEMIND_SESSION=<session id>` in `launch::environment` for every program it starts (PR 1 adds the variable). Checks U10, U11: the refusal reaches both CLIs, including Codex `danger-full-access` with approval `never`.

## 8. Checks before building

| # | Check | Fallback |
| --- | --- | --- |
| U1, U2 | Claude `ESC v` and Codex `0x16` paste a clipboard image | Save the image to a file under the session folder and paste its quoted path |
| U3 | Both CLIs attach a pasted image path | Ask the user to drag the file instead |
| U4 | `--settings` hooks run alongside the user's own hooks; `Notification` carries `permission_prompt`; `Stop` fires per turn | Any Notification counts as waiting |
| U5 | Codex `tui.notifications` with `osc9` emits OSC 9 | Quiet 2 s plus an unanswered call in the rollout |
| U6 | `codex debug models` output | `~/.codex/models_cache.json` |
| U7 | When Claude writes `cost-state` | Token estimate only |
| U8 | Claude project folder naming with spaces and non-ASCII | Find `<id>.jsonl` by scanning |
| U9 | A toast click reaches the running app | Open the last-notified session on next focus |
| U10, U11 | `HIVEMIND_SESSION` reaches Living Memory's hooks in both CLIs, including Codex `danger-full-access` | Say on the Start screen that those Codex modes cannot be guarded |
| U12 | `--resume <id> --name` renames in Claude Code | Name only at a fresh start |
| U13 | WebView2's paste event has no text for an image clipboard | Any empty-text paste sends the key |
| U14 | `codex -a untrusted` accepted | Not offered |
| U15 | Codex newline for Shift+Enter | Keep ESC CR |
| U16 | Drag-drop coordinates at 125% scaling | Divide by `devicePixelRatio` |
| U17 | Snapshot time on a large repository | Diff against `head_sha` with a label |
| U18 | The hook helper flashes no console window | Re-exec with `CREATE_NO_WINDOW` |

## 9. Verification for every PR

- `npm test`, `npx tsc --noEmit`, `npm run build`, `cargo test`, `cargo clippy` (in `src-tauri`).
- The running dev app on a seeded demo store, driven over CDP: first with the stand-in CLI (it echoes its arguments, `HIVEMIND_SESSION` and `LIVING_MEMORY_ROOT`, emits OSC 9, BEL and OSC 52, and runs the hook command from `--settings`), then one short real Claude Code run (`--model haiku --effort low`) and one Codex run, about $3 at most per PR.
- The user's real Living Memory store gets no hook entries from test CLIs.
- Test sessions, worktrees, folders and settings are removed afterwards; side effects are listed in the PR.
