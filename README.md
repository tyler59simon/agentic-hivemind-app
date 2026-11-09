# Hivemind

Hivemind is an optional desktop app for [Agentic Living Memory](https://github.com/tyler59simon/agentic-living-memory). It gives you an Obsidian-style way to browse, search, edit and connect the memory your coding agents keep.

It runs on Tauri 2 with React and TypeScript, on Windows, macOS and Linux. It is in early development and has no releases yet.

## What it does

- **Library and search:**
  - a domain picker, with Active and Archive trees grouped by note type
  - faceted search (type, status, tag, scope)
  - a quick switcher (Ctrl+O) and a command palette (Ctrl+P)
  - live refresh when agents write
- **Workspace:** tabs and side-by-side panes (up to three). A right sidebar shows Outline, Links (backlinks, outgoing links, replaces / replaced by, links to missing notes), a local graph, and the note's History. Hovering a note link shows its summary.
- **Editor:**
  - CodeMirror with Obsidian-style live preview, plus a plain Source mode
  - a properties form, `[[` title autocomplete, and Ctrl+S to save
  - unsaved edits kept as drafts that survive a crash
  - a three-way merge when an agent saved the same note meanwhile
- **Lifecycle:** archive, resolve, reopen, supersede, merge and delete, each as a reviewed Living Memory plan whose diff you see before it applies.
- **Action Items:** tick them in reading view.
- **Renames:** a renamed note offers to rewrite `[[Old Title]]` links elsewhere.
- **Graph** (Ctrl+G): every note and link, coloured by type, with filters.
- **Activity** (Ctrl+Shift+A): who changed what, with diffs and Undo. Who acted is inferred, because Living Memory's journal does not record it.
- **Tags:** the taxonomy by facet with usage counts. Tags can be added, renamed or merged, and tags in use but not registered can be fixed.
- **Quick capture:** a global hotkey (default Ctrl+Alt+M) or the tray icon opens a small window to save a note without opening the app.

## How it works

Living Memory stays the only writer, and Hivemind never touches the store's files itself.
- **Bridge:** the app starts one `living_memory.py serve --stdio` process and sends it JSON-lines commands (`src-tauri/src/bridge.rs`).
- **Reads** run as `--actor viewer`. They are read-only and don't count as usage in Living Memory's stats.
- **Writes** go through `update --expected-revision` and send only the fields that changed. Living Memory journals every write, so it can be undone. Lifecycle, tag and undo changes go through Living Memory's plan, inspect and apply flow (`src/features/plans/PlanDialog.tsx`).
- **Live refresh:** a file watcher on `domains/*/notes|archive` refreshes the UI when agents write (`src-tauri/src/watcher.rs`). It never opens `search.sqlite3`.
- **Drafts and preferences:** drafts live in the app's data folder (`src-tauri/src/drafts.rs`). The tab layout, default editor mode and Hivemind's own operation log stay on this device.

## Requirements

- **Living Memory with the app bridge** (`serve`, `list`, `domains`, `version`, `--actor viewer`; API level 1; agentic-living-memory PR #11). Backlinks and the graph also need `links` (PR #12). Without it Hivemind says so and the rest still works.
- **Python 3.10+** with SQLite FTS5 (the same interpreter Living Memory uses).
- **To build:** Rust (stable), Node 20+, and the [Tauri prerequisites](https://tauri.app/start/prerequisites/). On Windows that means the MSVC C++ Build Tools and WebView2. On Linux the tray icon needs `libayatana-appindicator3`.

## Configuration

Hivemind looks for the installed Living Memory copy:
- Windows: `%LOCALAPPDATA%/agentic-living-memory/app/living_memory.py`
- Elsewhere: `~/.local/lib/agentic-living-memory/app/living_memory.py`

It uses whichever store Living Memory is configured for. You can override these in Settings (command palette → Settings) or with environment variables, which take priority:

| Variable | Meaning |
| --- | --- |
| `HIVEMIND_PYTHON` | Python interpreter (default `py -3` on Windows, `python3` elsewhere) |
| `HIVEMIND_LM_SCRIPT` | Path to `living_memory.py`, e.g. a development checkout |
| `HIVEMIND_LM_ROOT` | Store root; use a throwaway store while developing |

Settings also sets:
- the quick-capture hotkey (or turns it off)
- whether closing the window keeps Hivemind in the tray
- which mode notes open in

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
| Ctrl+W | Close the tab |
| Ctrl+Tab / Ctrl+Shift+Tab | Next / previous tab |
| Ctrl+\ | Split the pane |
| Ctrl+G | Graph |
| Ctrl+Shift+A | Activity |
| Ctrl+Shift+F | Search |
| Ctrl+click | Open a link or note in the other pane |
| Ctrl+Alt+M (global) | Quick capture |
