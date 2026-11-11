# Claude Code headless protocol spike

- Version: Claude Code 2.1.322, `%USERPROFILE%\.local\bin\claude.exe`; 2026-11-10, Windows 11 Home 10.0.26100.
- Model used: `--model haiku` (claude-haiku-5-5); one sonnet turn for set_model. Total spend about $0.16.
- Nothing in the earlier 2.1.321 Living Memory note was contradicted.
- Raw logs and driver scripts: `<SCRATCH>\spike-claude\` (logs in `logs\*.jsonl`, fields t/dir/raw; `snippets.py [name...]` prints trimmed verbatim lines; `show.py <name>`; `inventory.py` writes `logs\inventory.txt`; `bin-extract\sdk-schemas.txt` is the control-protocol schema text copied out of claude.exe).
- The raw logs contain the account e-mail (in `initialize` and `get_status` responses): never copy those lines into a repo.

Conventions: `in` = host writes to stdin, `out` = CLI prints on stdout. One JSON object per line, `\n` endings, UTF-8 no BOM.

## Command lines that work

Long-lived session, host answers prompts:

```
claude.exe -p --input-format stream-json --output-format stream-json --verbose
  --permission-mode manual --permission-prompts host --permission-prompt-tool stdio
  --session-id <uuid> --max-budget-usd <n>
  [--replay-user-messages] [--include-partial-messages]
  [--allowedTools <rule>...] [--add-dir <dir>...] [--plugin-dir <dir>] [--json-schema <schema>]
```

Resume later: same flags with `--resume <session-id>` in place of `--session-id <uuid>`.

Today's unattended form (unchanged behaviour): `... --permission-mode dontAsk --permission-prompts none --session-id <uuid> --max-budget-usd <n> ...`, one user line, stdin closed.

Help text, verbatim:

```
--permission-mode <mode>       Permission mode to use for the session (choices: "acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan")
--permission-prompts <target>  Who answers permission prompts with --print: "host" (the SDK host or --permission-prompt-tool) or "none" (nobody: anything that would prompt is denied automatically; the permission mode still decides everything else) (choices: "host", "none", default: "host")
--replay-user-messages         Re-emit user messages from stdin back on stdout for acknowledgment (only works with --input-format=stream-json and --output-format=stream-json)
--max-budget-usd <amount>      Maximum dollar amount to spend on API calls (only works with --print)
--fork-session                 When resuming, create a new session ID instead of reusing the original (use with --resume or --continue)
```

`--permission-prompt-tool` is HIDDEN from `--help`. Declared in the binary as `--permission-prompt-tool <tool>`, "MCP tool to use for permission prompts (only works with --print)". The value `stdio` routes prompts to the host over stdout/stdin (this is what the Agent SDK passes).

## A. Multi-turn

User line (in); no session_id or uuid needed:

```json
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Reply with exactly: one"}]}}
```

- End of turn = the `{"type":"result",...}` line, one per turn. Keys the app needs: `subtype` ("success" | "error_during_execution" | "error_max_budget_usd"), `is_error`, `result` (final text; absent on errors), `session_id`, `total_cost_usd` (cumulative for the session), `num_turns`, `duration_ms`, `permission_denials` (array of {tool_name, tool_use_id, tool_input}), `terminal_reason` ("completed" | "aborted_tools" | "aborted_streaming" | "budget_exhausted"), `errors` (array, on errors), `result_index` (0,1,2… per process), `model_usage_since_last_result` (per-turn spend), `structured_output` (with --json-schema; every turn returns its own).
- The process stays alive and silent after `result` while stdin is open (verified idle 5 s, and 75 s with a prompt pending). A second user line starts a second turn in the same `session_id`; the model remembers turn 1.
- `system/init` is printed at the start of EVERY turn, not once per process. Before the first user line only a `system/hook_started` + `system/hook_response` pair (SessionStart) is printed. So the app's `Started` event would fire once per turn unless de-duplicated.
- `--replay-user-messages` (out) when the turn picks the line up: `{"type":"user","message":{...},"session_id":"…","parent_tool_use_id":null,"uuid":"…","timestamp":"…","isReplay":true}`. With that flag the CLI also echoes the host's own `control_response` lines, and prints `set_model` output as a replayed user line with string content.
- Stdin EOF while idle: clean exit 0 (about 1 s; exit code 1 when the last result was an error). Stdin EOF mid-turn: the turn finishes, `result` is printed, exit 0.
- A user line sent mid-turn is QUEUED and FOLDED into the running turn: one `result` answers both. So wait for `result` before sending the next prompt. With a client `uuid` on the user line the CLI reports `{"type":"command_lifecycle","command_uuid":"<uuid>","state":"queued"|"started"|"completed",...}`.
- A non-JSON stdin line KILLS the process: exit 1, stderr `Error parsing streaming input line (type=unknown, 16 chars): SyntaxError`, no `result`.
- Optional idle signal: env `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1` makes the CLI print `{"type":"system","subtype":"session_state_changed","state":"running"|"requires_action"|"idle",...}`; `idle` arrives about 2 ms after `result`. Not in the public docs.

## B. Host permission prompts

| Launch flags | A call needing approval |
|---|---|
| `--permission-mode manual --permission-prompts host` | Denied at once, NO request sent |
| the same plus `--permission-prompt-tool stdio` | `control_request`/`can_use_tool`; waits for the host |
| `--permission-prompt-tool stdio` only | Same as the row above |
| `--permission-mode default --permission-prompt-tool stdio` | Same; `default` spelling still accepted (`manual` is an alias; the wire name is always `default`) |
| `--permission-prompts none --permission-prompt-tool stdio` | Denied, no request |
| `--permission-mode dontAsk --permission-prompt-tool stdio` | Denied, no request |

Automatic denial line (out): `{"type":"system","subtype":"permission_denied","tool_name":"Write","tool_use_id":"toolu_…","message":"Claude requested permissions to write to …, but you haven't granted it yet.","uuid":"…","session_id":"…"}`.

Handshake: NONE required. `initialize` is optional: in `{"type":"control_request","request_id":"host-1-initialize","request":{"subtype":"initialize","hooks":null}}`; the response is one 32 KB line containing the account e-mail, so never log it.

### Requests (out). No session_id or uuid on these lines.

Write (Edit is the same with old_string/new_string/replace_all in input):

```json
{"type":"control_request","request_id":"a09f3229-53c0-4a3d-9b4b-bfa4cb890730","request":{"subtype":"can_use_tool","tool_name":"Write","display_name":"Write","input":{"file_path":"<SCRATCH>\\spike-claude\\a.txt","content":"x"},"description":"a.txt","permission_suggestions":[{"type":"setMode","mode":"acceptEdits","destination":"session"}],"tool_use_id":"toolu_01JDdQ12vozJ8B3vPpSdHovj"}}
```

Bash:

```json
{"type":"control_request","request_id":"6c738ff4-3b35-4894-acec-1b2806f0b2f4","request":{"subtype":"can_use_tool","tool_name":"Bash","display_name":"Bash","input":{"command":"mkdir spike_dir_1","description":"Create directory spike_dir_1"},"description":"Create directory spike_dir_1","permission_suggestions":[{"type":"addRules","rules":[{"toolName":"Bash","ruleContent":"mkdir spike_dir_1"}],"behavior":"allow","destination":"localSettings"},{"type":"addDirectories","directories":["<SCRATCH>\\spike-claude"],"destination":"session"},{"type":"setMode","mode":"acceptEdits","destination":"session"}],"blocked_path":"<SCRATCH>\\spike-claude\\spike_dir_1","tool_use_id":"toolu_01BaUp77S1XfWQ94cYZZXe5W"}}
```

PowerShell (the model may pick it instead of Bash on Windows): same shape, `tool_name":"PowerShell"`, plus `"decision_reason_type":"subcommandResults"`.

Read outside the working folders: `tool_name":"Read"`, `input":{"file_path":"C:\\Windows\\win.ini"}`, `permission_suggestions":[{"type":"addRules","rules":[{"toolName":"Read","ruleContent":"//c/Windows/**"}],"behavior":"allow","destination":"session"}]`, `"decision_reason":"Path is outside allowed working directories","decision_reason_type":"workingDir"`.

INFERRED from the binary's schema (not observed): optional `mcp_server`, `decision_reason_code`, `classifier_approvable`, `suppress_always_allow_rule`, `agent_id`.

### Answers (in)

Envelope: `{"type":"control_response","response":{"subtype":"success","request_id":"<the request's id>","response":<inner>}}`

Inner object (from the binary's schema):

```
allow: {"behavior":"allow", "updatedInput"?: object, "updatedPermissions"?: PermissionUpdate[], "toolUseID"?: string, "decisionClassification"?: "user_temporary"|"user_permanent"|"user_reject"}
deny:  {"behavior":"deny", "message": string (required), "interrupt"?: boolean, "toolUseID"?: string, "decisionClassification"?: ...}
```

- Allow once: `{"behavior":"allow"}` alone works (`updatedInput` may be omitted, or echo the request's input). The following `user`/`tool_result` line carries `tool_result_meta[].permission_decision {"decision":"accept","source":"user_temporary"}`.
- Deny: `{"behavior":"deny","message":"Host says no: …"}`. The tool result becomes that message with `is_error:true`, `permission_decision {"decision":"reject","source":"user_reject"}`. The turn still ends `result`/`success`, and the call is listed in `result.permission_denials`. No `system/permission_denied` line is printed for a host deny.
- Deny with `"interrupt":true`: the tool result becomes the stock "The user doesn't want to proceed with this tool use…" text and the turn ends `error_during_execution` with `terminal_reason:"aborted_tools"`. The process stays alive.
- Allow always by mode (the suggestion for Write/Edit): add `"updatedPermissions":[{"type":"setMode","mode":"acceptEdits","destination":"session"}]`; the CLI confirms with `{"type":"system","subtype":"status","status":null,"permissionMode":"acceptEdits",...}`; later edits run with no prompt (`source":"config","reason_type":"mode"`). `acceptEdits` also auto-approved `mkdir` in the working folder.
- Allow always by a session rule: `"updatedPermissions":[{"type":"addRules","rules":[{"toolName":"Bash","ruleContent":"mkdir rule_1"}],"behavior":"allow","destination":"session"}]`. The same command then ran with no prompt; a different command prompted again.
- GOTCHA: the CLI's own Bash suggestion has `"destination":"localSettings"`. Sent back unchanged it WRITES `<cwd>\.claude\settings.local.json` (`{"permissions":{"allow":["Bash(mkdir persist_1)"]}}`) into the worktree. A host should rewrite `destination` to `"session"`.

### Other cases

- Pre-allowed tools do not prompt (`--allowedTools "Bash(mkdir pre_*)"`, a `--settings` allow rule, reads inside the working folders).
- Host never answers: 75 s of silence, still waiting (longer not tested). No timeout observed.
- Unknown `request_id` in an answer: ignored silently; the real answer sent afterwards worked.
- Prompt withdrawn when its turn is interrupted (out): `{"type":"control_cancel_request","request_id":"…"}`; a late answer is ignored.
- Stdin EOF with a prompt pending: denied at once (tool_result "Tool permission request failed: AbortError: Tool permission stream closed before response received"), turn ends `success`, exit 0.
- MCP fallback (`--permission-prompt-tool mcp__server__tool` + `--mcp-config`): not needed, not run.
- NOT verified: prompts raised by subagents, `AskUserQuestion`, MCP tools; two processes on one session at once.

## C. Other control messages (in → out)

- Interrupt: in `{"type":"control_request","request_id":"host-1-interrupt","request":{"subtype":"interrupt"}}` → out `{"type":"control_response","response":{"subtype":"success","request_id":"host-1-interrupt","response":{"still_queued":[]}}}`, then a `user` text line `[Request interrupted by user for tool use]` (or `[Request interrupted by user]`), then `result` with `"is_error":true,"subtype":"error_during_execution","terminal_reason":"aborted_tools"` (or `"aborted_streaming"` when interrupted while the model was writing; the partial `assistant` line then carries `"aborted":true`). The result came 0.04 s after the request; the running child command was gone a second later; the next user line ran normally in the same session.
  - `failure()` in claude.rs would label this "Claude Code hit an error while working"; a result that follows the app's own interrupt must be shown as cancelled/stopped, not failed.
  - INFERRED (schema only): `"cancel_queued":true` also drops queued user lines.
- Set model: `{"type":"control_request","request_id":"…","request":{"subtype":"set_model","model":"sonnet"}}` → `{"response":{"model":"claude-sonnet-5-5"}}`.
- Set permission mode: `{"subtype":"set_permission_mode","mode":"acceptEdits"}` → `{"response":{"mode":"acceptEdits"}}`. Valid: acceptEdits, auto, bypassPermissions, default, dontAsk, plan (`manual` is answered as `default`).
- Errors leave the process running: `{"type":"control_response","response":{"subtype":"error","request_id":"…","error":"Unsupported control request subtype: no_such_subtype"}}` (and `"error_code":"invalid_mode"` for a bad mode).
- Also answered: `get_session_cost`, `get_context_usage`, `list_permission_rules`, `get_status`, `mcp_status`.

## D. Resume

- `--resume <id>` keeps the session id; `--fork-session` gives a new id with the conversation intact.
- No history is replayed on stdout, with or without `--replay-user-messages`. Before the first stdin line only the SessionStart hook pair is printed (`hook_name":"SessionStart:resume"`).
- `total_cost_usd` continues from the earlier total across processes (and across a fork).
- `--session-id` on an existing id: exit 1 before any stdout, stderr `Error: Session ID <id> is already in use.` So a resumed session must use `--resume`.
- `--resume` on an unknown id: exit 1, stderr `No conversation found with session ID: <id>`, plus a short `result` with `subtype":"error_during_execution"`, `num_turns":0`, `errors":["No conversation found with session ID: …"]`.
- Resume from another folder works; the transcript stays in the original project folder; `init.cwd` is the new process's folder.
- `--max-budget-usd` counts only the CURRENT process's spend. The capped turn still prints its assistant text, then `result` with `"is_error":true,"subtype":"error_max_budget_usd","errors":["Reached maximum budget ($0.004)"],"terminal_reason":"budget_exhausted"` and no `result` text. The process does NOT exit after the cap: every later user line returns the same error at once with no model call. Close stdin (exit 1) and start a new process with `--resume`.
- The claude.rs test fixture has `error_max_budget_usd` with `is_error:false`; the real line has `true`. Outcome logic unaffected.

## E. Event inventory (stdout kinds seen)

| Kind | Notes |
|---|---|
| `system/init` | every turn; session_id, model, claude_code_version, permissionMode, cwd, additional_directories, plugins, skills, tools, mcp_servers, capabilities |
| `system/hook_started`, `system/hook_response` | SessionStart:startup or :resume; absent when user settings are excluded |
| `assistant` (content text / thinking / tool_use) | one line per content block; stop_reason always null; thinking text empty |
| `user` with tool_result | is_error, tool_use_result, tool_result_meta[].permission_decision |
| `user` with text, isReplay:true | only with --replay-user-messages |
| `user` with text, no isReplay | `[Request interrupted by user]` / `… for tool use]` |
| `result/success`, `result/error_during_execution`, `result/error_max_budget_usd` | |
| `control_request/can_use_tool` | no session_id or uuid |
| `control_response` success / error | replies to host requests (and echoes with replay) |
| `control_cancel_request` | |
| `command_lifecycle` queued/started/completed | only for user lines carrying a uuid |
| `rate_limit_event` | rate_limit_info.status, unifiedWindows five_hour / seven_day utilization |
| `system/thinking_tokens` | estimated_tokens |
| `system/status` | mode change, or status:"requesting" with partial messages |
| `system/permission_denied` | automatic denials only |
| `system/session_state_changed` | env var only |
| `system/task_started`, `system/task_notification` | Bash commands running longer than about 2 s |
| `tool_progress` | 30 s heartbeat during a long command |
| `stream_event` | only with --include-partial-messages; e.g. `{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"…"}},"session_id":"…","parent_tool_use_id":null,"uuid":"…","api_message_id":"msg_…"}` |

`permission_decision.source` values seen: config, user_temporary, user_permanent, user_reject. Not seen: keep_alive, system/api_retry, system/compact_boundary, system/hook_progress.

Assistant tool_use line shape: `{"type":"assistant","message":{"model":"…","id":"msg_…","type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_…","name":"Write","input":{…},"caller":{"type":"direct"}}],"stop_reason":null,"usage":{…}},"parent_tool_use_id":null,"session_id":"…","uuid":"…","timestamp":"…","request_id":"req_…","wire_tool_inputs":{…}}`.

## F. Working directory and scope flags (run from a git worktree with a sibling --add-dir folder and a minimal --plugin-dir plugin)

- Today's flag set behaves the same from a worktree: `init.cwd` = the worktree, `additional_directories` = the add-dir, plugin and its skill listed; the write into the add-dir (allowed by `--allowedTools "Edit(//c/…/spike-extra/**)"`) succeeded; the write into the worktree was denied and listed in permission_denials; `structured_output` present; exit 0.
- `--add-dir` gives access, not approval: a Write there still prompted in manual mode.
- `--settings '{"permissions":{"allow":["Bash(mkdir set_*)"]}}'`: the matching command ran with no prompt.
- `--setting-sources project,local`: user settings left out (no hook lines, user-level plugins absent); login still worked.
- `--strict-mcp-config`: `init.mcp_servers` was `[]`, including the claude.ai connector.
- `--plugin-dir`: loaded regardless of `--setting-sources`.
- `--json-schema` on a long-lived process: every turn returned its own `structured_output`.

## G. Windows

- Launch `claude.exe` directly with CREATE_NO_WINDOW and three pipes, as mod.rs does.
- UTF-8 both ways, no BOM; non-ASCII and emoji round-trip. Largest line 32.6 KB (initialize response); init about 7 KB.
- Stderr is empty except for the fatal messages quoted above.
- Process tree: idle = one conhost.exe; during a Bash tool = bash.exe ×3, a second conhost.exe, and the command.

| Kill method | Result |
|---|---|
| `taskkill /PID <pid> /T /F` (what mod.rs does) | exit 1, no descendants left |
| TerminateProcess on claude.exe only | exit 1; bash.exe ×3, conhost.exe and the running command left running |
| `interrupt` control request | command ended, process kept |
| close stdin | clean exit after the current turn |

A killed process prints no `result`; stdout just ends.

## Docs versus behaviour

- The headless page and the CLI reference do not describe the control protocol or the `stdio` value of `--permission-prompt-tool`.
- The headless page calls `system/init` "the first event in the stream"; with stream-json input it arrives with the first user line and repeats each turn.
- Docs and behaviour agree on the `manual` alias, the budget ignoring restored totals, the cumulative `total_cost_usd`, and `--resume` searching every project.

## How to re-verify

Folder `<SCRATCH>\spike-claude`. Run each script from there with Python 3.15 after setting `PYTHONIOENCODING=utf-8`; each writes `logs\<name>.jsonl`. Each costs under a cent except `c1_control.py` (about 7 cents).

| Script | Covers |
|---|---|
| `drv.py` | driver: pipes, timestamped log, turn(), request(), respond() |
| `a1_multiturn.py` | A |
| `b1_host_prompts.py` | B without the prompt tool (auto-deny) |
| `b1_host_prompts.py b2_host_stdio --permission-prompt-tool stdio` | B: allow, deny, allow always by mode |
| `b3_rules.py` | B: initialize, session rule, bare allow, pre-allowed, unknown id |
| `c1_control.py` | C: interrupt mid-stream, set_model, set_permission_mode |
| `c2_interrupt_queue.py` | interrupt mid-tool, mid-turn line, deny+interrupt, unanswered prompt |
| `d1_resume.py`, `d7_budget.py` | D |
| `e1_events.py` | state events, partial messages, UTF-8, Read and PowerShell prompts |
| `f1_scope.py` | F (needs `..\spike-claude-wt`, `..\spike-extra`, `..\spike-plugin`) |
| `g1_windows.py [session-id]`, `g4_newlines.py` | G |
| `h1_edges.py`, `h8_persist.py` | edge cases; delete `.claude\settings.local.json` after h8 |

## Step 0 results (Phase 2)

Run on 2026-11-10 (UTC 2026-11-11) for `docs/plans/phase-2-interactive-sessions.md`, section 8, step 0. Claude Code 2.1.322, git 2.56.0.windows.4, Windows 11 Home 10.0.26100, model `haiku`. `LIVING_MEMORY_ROOT` pointed at a throwaway demo store built with `scripts/seed_demo_store.py`. The step 0 script is the one in the phase document, with three small additions: a raw-line log kept in the scratch folder, a guard in check B for a process that ends before its prompt, and a switch to run check E in its `--settings` form (not needed). Spend: a few cents.

| Check | Result | Pass? |
| --- | --- | --- |
| 0a: "Generate with agent" from the app | Refused before any CLI started: `The Architecture Suite's one-time setup has not been run: there is no interpreter at C:\Users\<user>\.architecture-suite\runtime\Scripts\python.exe`. This is today's code; the suite is not installed on this machine. The rest of 0a (streaming, Stop, restart) could not run. | Not run (scope check) |
| A: `system/init` lines per turn | `1 1` | Yes |
| A: prompts | `['Write']` | Yes |
| A: results | `success success`, second result `notes.txt` | Yes |
| A: exit code after stdin EOF | `0` | Yes |
| B: resume after `taskkill /T /F` mid-turn | `success 'resumed'` | Yes: no fallback needed |
| C: launch with `--permission-mode acceptEdits` plus host prompts | prompts `['Bash']`, no `Write` | Yes: no fallback needed |
| `claude --help`, `--model` | "Provide an alias for the latest model (e.g. 'fable', 'opus', or 'sonnet')" | Yes: Opus option stays |
| `claude --help`, `--disallowedTools` | `--disallowedTools, --disallowed-tools <tools...>` | Yes |
| D: Living Memory hook in a worktree outside the bound folder | hook text names no session and no domain; it says the folder "is not bound to a memory domain" and offers the bind command; the agent then declined to search (no prompt) | **No**: worktree sessions are not bound to the project's domain. Per the document nothing in the design changes: the briefing names the project and domain for captures. |
| E: `--disallowedTools "Bash(*living_memory.py* undo *)" …` with a `--settings` allow rule `Bash(*living_memory.py*)` | prompts `[]`, 1 denial in `result.permission_denials`, Living Memory did not answer | Yes: the flag form works; the `--settings` deny fallback was not needed |

Real store isolation. The first full run (A to E, run in the background) read `real store untouched: False`. The only real-store file that changed was `logs/log-<date>.jsonl` (plus `.turns/` state). Every entry written in that window came from the developer's own Claude Code session (its tool-call, Stop and capture-finalize hooks; that session kept working while the run was in the background). The four sessions the script started appear only in the demo store's log. Check E, rerun in the foreground with nothing else running: `real store untouched: True`, `demo store written: True`. Lesson: take both readings in one command **and** do nothing else in the same Claude Code session until that command ends; a background run is not enough.

### Verification run (Phase 2, after commit 9)

From the running app against a demo store, Haiku, all inside the real-store wrapper (every reading `real store untouched: True`): start with an approval card, allow once, files card and diff, a second turn, stop mid-command (`Stopped`), quit and restart (session `ready`, same transcript), resume with `--resume` (one `started` line in the whole transcript), always allow (`Bash(mkdir hm_a)` ran again without a card, no `.claude\settings.local.json` written), deny, a governed `undo` refused as "Not allowed: PowerShell" with no card, files written before an external `taskkill` of the CLI reported before "The turn failed", a junction to an outside folder listed without its content, a budget stop (`--max-budget-usd 0.001`) followed by the confirm and a resumed run, End and Remove worktree. The idle CLI exits by itself when Hivemind dies (its stdin closes).

- `git worktree remove --force` on a worktree that holds an agent-made junction removes the worktree and every file, does not touch the junction's target, but leaves the worktree folder with the junction in it and still exits 0. Hivemind's `remove` then reports success and the folder stays behind until it is deleted by hand (remove the junction with `rmdir`, never a recursive delete).
- Every plan command Living Memory has is now in `GOVERNED_COMMANDS` (22 commands, 88 rules). Checked with Claude Code 2.1.322: the 88 `--disallowedTools` arguments are accepted, and `learn procedure rollback-plan` is denied although a `--settings` allow rule covers `Bash(*living_memory.py*)` and `PowerShell(*living_memory.py*)`.
- A Windows PowerShell 5.1 script cannot pass a JSON `--settings` value to `claude.exe` (it strips the inner quotes, exit 1); use Python `subprocess` with a list, as Hivemind's Rust `Command` does.
