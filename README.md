# Hivemind

Hivemind is an optional desktop app for [Agentic Living Memory](https://github.com/tyler59simon/agentic-living-memory). It gives you an Obsidian-style way to browse, search, edit and connect the memory your coding agents keep.

It runs on Tauri 2 with React and TypeScript, on Windows, macOS and Linux. It is in early development and has no releases yet.

## What it does

- **Layout:** a sidebar with a project picker and its sections (Home, Agent Workspace, Memory, Dashboards, Wiki, Recap, Maintenance, Inbox, Skills, Workflows), and a top bar with a breadcrumb and a search field. Every section is scoped to the picked project, or to all memory.
- **Memory:**
  - a library with search, tabs by note type, and Status, Scope (project, domain, all domains) and Tag filters; the selected note is previewed beside the list
  - a quick switcher (Ctrl+O) and a command palette (Ctrl+P)
  - live refresh when agents write
- **Notes:** open as tabs, side by side in up to three panes. A note page has Reading, Source and History tabs, and a context rail with its connections (backlinks, outgoing links, replaces / replaced by, links to missing notes), recent history, outline, details and a local graph. Hovering a note link shows its summary.
- **Home:** the picked project's current plan, next open items, recent notes and commits, and what needs review. Its Architecture tab shows the project's systems (all systems when no project is picked).
- **Inbox:** everything that waits for you, across projects, with one count on the sidebar. Its groups are agent code edits (with an Ask Codex button that has a read-only Codex review a diff), notes due for confirmation and drafts, notebook page edits agents proposed (store notebooks and folder notebooks; a folder notebook also shows "N agent edits" on the Notes page, and an accepted edit is kept in the page's file history), Executive captures, what maintenance changed in the last week (each with Undo and Looks right), registry updates an agent proposed, and skill proposals.
- **Architecture** (Home tab): a system's containers drawn from its Architecture Suite model (context and container levels, pan, zoom, select a box to inspect it), with its decisions, runbooks and weaknesses. Background agent sessions are listed in Agent Workspace.
- **Editor:**
  - CodeMirror with Obsidian-style live preview, plus a plain Source mode
  - a properties form, `[[` title autocomplete, and Ctrl+S to save
  - unsaved edits kept as drafts that survive a crash
  - a three-way merge when an agent saved the same note meanwhile
- **Lifecycle:** archive, resolve, reopen and supersede apply at once and can be undone from Activity; merge and delete are reviewed Living Memory plans whose diff you see before they apply.
- **Action items:** tick them in reading view.
- **Renames:** a renamed note offers to rewrite `[[Old Title]]` links elsewhere.
- **Graph** (Ctrl+G, under Memory): every note and link, coloured by type, with filters.
- **Activity** (Ctrl+Shift+A, under Memory): who changed what, with diffs and Undo. Who acted is inferred, because Living Memory's journal does not record it.
- **Tags** (under Memory): the taxonomy by facet with usage counts. Tags can be added, renamed or merged, and tags in use but not registered can be fixed.
- **Quick capture:** a global hotkey (default Ctrl+Alt+M) or the tray icon opens a small window to save a note without opening the app.
- **Agent roles:** chat sessions start as an architect, developer, reviewer, researcher or tester, each with a permission profile Hivemind builds (read only, research, or edit its own worktree), live CPU and memory use, and a verdict from reviewers and testers.
- **Learning:** after you approve or dismiss a session's edits, a capped, tool-free reviewer drafts notes for Living Memory and skill proposals; you approve them in the Inbox.
- **Skills:** approved procedures are kept with every version and published to Claude Code and Codex (`~/.claude/skills`, `~/.codex/skills`), with use counts and how the sessions that used them were reviewed.
- **Workflows:** a goal split into tasks for agents in roles, run in dependency order in separate worktrees, with checkpoint commits and a report. Nothing is merged or pushed.
- **Automations:** scheduled or event-driven work (reviews of new commits, memory maintenance, skill upkeep, drift checks, failure investigations) with ask-first, budgets and notifications.
- **Architecture drift:** the Architecture Suite's diff, check and verify, plus hand-edited outputs and commits since the output was made.

See [docs/engineering-workspace.md](docs/engineering-workspace.md) for how the agent features work, their safety model and their limits.

## How it works

Living Memory stays the only writer, and Hivemind never touches the store's files itself.
- **Bridge:** the app starts one `living_memory.py serve --stdio` process and sends it JSON-lines commands (`src-tauri/src/bridge.rs`).
- **Reads** run as `--actor viewer`. They are read-only and don't count as usage in Living Memory's stats.
- **Writes** go through `update --expected-revision` and send only the fields that changed. Living Memory journals every write, so it can be undone. Archive, resolve, reopen, supersede and new tags are direct writes. Delete, merge, tag renames and undoing those go through Living Memory's plan, inspect and apply flow (`src/features/plans/PlanDialog.tsx`).
- **Live refresh:** a file watcher on `domains/*/notes|archive` refreshes the UI when agents write (`src-tauri/src/watcher.rs`). It never opens `search.sqlite3`.
- **Drafts and preferences:** drafts live in the app's data folder (`src-tauri/src/drafts.rs`). The open notes, the picked project and page, the default editor mode and Hivemind's own operation log stay on this device.

## Requirements

- **Living Memory with the app bridge and direct writes:** its `version` reports API level 1 or later, the `serve`, `list`, `domains` and `version` commands, and `capabilities.direct_writes` 1 or later. Hivemind will not open an older one and says to update it. The Inbox settles staged notes and page edits through the one `proposals` command (`capabilities.proposals` 1; it replaced `doc proposals`, `doc accept` and `doc reject`), so update Living Memory and Hivemind together. Backlinks and the graph also need `links`; without it Hivemind says so and the rest still works.
- **Python 3.10+** with SQLite FTS5. Hivemind uses the interpreter Living Memory's installer recorded, so the app and Living Memory's hooks run the same one.
- **To build:** Rust (stable), Node 20+, and the [Tauri prerequisites](https://tauri.app/start/prerequisites/). On Windows that means the MSVC C++ Build Tools and WebView2. On Linux the tray icon needs `libayatana-appindicator3`.

## Install Living Memory

Hivemind does not include Living Memory. From a checkout of [agentic-living-memory](https://github.com/tyler59simon/agentic-living-memory), run:

```sh
py -3 install.py        # Windows
python3 install.py      # macOS and Linux
```

That copies Living Memory to its per-user app folder (below) and records the Python it ran under. Then wire each coding agent you use, as `install.py` prints: run `integrations/setup.py claude --hooks` (or `codex`, `copilot`, `factory`) from the installed copy and apply the plan it prints with `--apply-plan ID --expected-plan-sha256 DIGEST`. Hivemind itself needs only the installed copy. See `INSTALLATION.md` in that repository for the details.

## Configuration

Hivemind looks for the installed Living Memory copy:
- Windows: `%LOCALAPPDATA%/agentic-living-memory/app/living_memory.py`
- Elsewhere: `~/.local/lib/agentic-living-memory/app/living_memory.py`

It uses whichever store Living Memory is configured for. You can override these in Settings (the menu at the bottom of the sidebar, or the command palette) or with environment variables, which take priority:

| Variable | Meaning |
| --- | --- |
| `HIVEMIND_PYTHON` | Python interpreter (default: the one Living Memory's installer recorded in `app/.core-ownership-v1.json`, else `py -3` on Windows and `python3` elsewhere) |
| `HIVEMIND_LM_SCRIPT` | Path to `living_memory.py`, e.g. a development checkout |
| `HIVEMIND_LM_ROOT` | Store root; use a throwaway store while developing |
| `HIVEMIND_SKILL_DIRS` | Skill folders to publish to, separated by `;` on Windows and `:` elsewhere (default `~/.claude/skills` and `~/.codex/skills`); use scratch folders while developing |
| `HIVEMIND_ARCHSUITE_PYTHON` | Interpreter for the Architecture Suite's command line (default the one its setup installs in `~/.architecture-suite/runtime`) |

Settings also sets:
- the quick-capture hotkey (or turns it off)
- whether closing the window keeps Hivemind in the tray
- which mode notes open in

## Machines with managed policy

Hivemind has no policy of its own. After a confirm tick, a user can start a session with Claude Code's `bypassPermissions` mode or Codex's `danger-full-access` sandbox, and automations run unattended from the tray. Hivemind starts the `claude` and `codex` command lines, and they enforce their own administrator settings, so IT controls Hivemind's agents there:

- **Claude Code managed settings** (`managed-settings.json`, its `managed-settings.d` drop-ins, the Windows `Policies\ClaudeCode` registry key, or settings from the claude.ai console): `permissions.disableBypassPermissionsMode` set to `"disable"` blocks bypass mode, and managed permission rules apply to every Claude session Hivemind starts.
- **Codex `requirements.toml`**: limits the sandbox modes and approval policies Codex accepts, including the ones Hivemind passes.

What managed policy turns off in Hivemind: when Claude Code has any managed policy (a managed settings or MCP file, a drop-in, the registry value, or cached console settings), Hivemind refuses its isolated Claude calls (the executive chat, the learning reviewer, and the briefing and comms one-shot calls), because those calls cannot run isolated under managed hooks and MCP servers. The executive chat can still run with Codex; the learning reviewer and the briefing and comms calls run only on Claude, so they are off. Sessions you start yourself are not refused; the CLI applies the policy to them.

## Uninstall

1. **Before you uninstall:** in Settings, under **Before you uninstall**, press Check. For each session worktree, end the session, approve or discard its edits, and remove the worktree; then delete the `hivemind/...` branches already merged. Unapproved edits live only in those worktrees, inside the app data folder below. Deleting that folder loses them and leaves stale entries in each repository's `.git/worktrees` until you run `git worktree prune` there. Commits already on a session's branch are in your repository and survive. Branches with unmerged commits are listed but never deleted.
2. **Run the uninstaller.**
3. **What stays afterwards:**
   - App data. With Tauri's default installers, the NSIS uninstaller keeps `%APPDATA%\dev.hivemind.app` unless you tick its option to delete app data, and the MSI never removes it. It holds settings, `agent-sessions`, `worktrees`, `terminals`, `learning` and `skills`. WebView2 data is in `%LOCALAPPDATA%\dev.hivemind.app`. Delete both folders to remove everything.
   - Published skills in `~/.claude/skills` and `~/.codex/skills` (each folder has a `.hivemind-skill.json` marker). Delete the ones you no longer want.
   - Living Memory and its store. They are separate and keep working with your coding agents. If you turned on memory maintenance from Hivemind, Living Memory keeps scheduling those paid `claude -p` runs from its SessionStart hook; run `alm maintenance disable` to stop them.

## Develop

```sh
npm install
npm run tauri dev       # the app, with hot reload
npm test                # vitest
npx tsc --noEmit        # type-check
cd src-tauri && cargo test
```

`cargo test` includes end-to-end bridge tests against a temporary store. They run only when `HIVEMIND_TEST_LM_SCRIPT` points at a `living_memory.py` that has `serve`. Set `HIVEMIND_TEST_PYTHON` to choose the interpreter.

`src/lib/note.ts` mirrors Living Memory's note layout rules, and `scripts/gen_note_fixtures.py PATH/TO/agentic-living-memory` regenerates the fixtures that keep the two in step.

## Shortcuts

| Keys | Action |
| --- | --- |
| Ctrl+O | Go to a note by title |
| Ctrl+P | Command palette |
| Ctrl+N | New note |
| Ctrl+S | Save |
| Ctrl+E | Switch between reading and editing |
| Ctrl+W | Close the note tab |
| Ctrl+Tab / Ctrl+Shift+Tab | Next / previous note tab |
| Ctrl+\ | Open the note side by side |
| Ctrl+G | Graph |
| Ctrl+Shift+A | Activity |
| Ctrl+K or Ctrl+Shift+F | Search |
| Alt+Left | Back |
| Ctrl+click | Open a link or note in the other pane |
| Ctrl+Alt+M (global) | Quick capture |
