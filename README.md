# Hivemind

Hivemind is an optional desktop app for [Agentic Living Memory](https://github.com/tyler59simon/agentic-living-memory). It gives you an Obsidian-style way to browse, search and (soon) edit the memory your coding agents keep.

It runs on Tauri 2 with React and TypeScript, on Windows, macOS and Linux. It is in early development and has no releases yet.

## How it works

Living Memory stays the only writer, and Hivemind never touches the store's files itself.
- **Bridge:** the app starts one `living_memory.py serve --stdio` process and sends it JSON-lines commands (`src-tauri/src/bridge.rs`).
- **Reads** run as `--actor viewer`. They are read-only and don't count as usage in Living Memory's stats.
- **Writes** (coming in Phase 2) go through `update --expected-revision`, which journals them so they can be undone. Archive, delete and merge go through Living Memory's plan, inspect and apply flow.
- **Live refresh:** a file watcher on `domains/*/notes|archive` refreshes the UI when agents write (`src-tauri/src/watcher.rs`). It never opens `search.sqlite3`.

## Requirements

- Living Memory with the app bridge (`serve`, `list`, `domains`, `version`, `--actor viewer`; API level 1). See agentic-living-memory PR #11.
- Python 3.10+ with SQLite FTS5 (the same interpreter Living Memory uses).
- To build: Rust (stable), Node 20+, and the [Tauri prerequisites](https://tauri.app/start/prerequisites/). On Windows that means the MSVC C++ Build Tools and WebView2.

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

## Develop

```sh
npm install
npm run tauri dev       # the app, with hot reload
npm test                # vitest
npx tsc --noEmit        # type-check
cd src-tauri && cargo test
```

`cargo test` includes an end-to-end bridge test against a temporary store. It runs only when `HIVEMIND_TEST_LM_SCRIPT` points at a `living_memory.py` that has `serve`. Set `HIVEMIND_TEST_PYTHON` to choose the interpreter.

## Shortcuts

| Keys | Action |
| --- | --- |
| Ctrl+O | Go to a note by title |
| Ctrl+P | Command palette |
| Ctrl+Shift+F | Search |
