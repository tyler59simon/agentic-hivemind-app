# NS-6A: power editing

Read [README.md](README.md) and [phase-1b-open-any-file.md](phase-1b-open-any-file.md) first. This phase brings Notepad++ text workflows to Source mode and plain text files up to about 8 MB.

## Changes from the code survey before NS-6A

Claude surveyed main on 2026-11-22 (after NS-5). Where the sections below say otherwise, these win. At the user's request this phase has no Codex review; Claude reviews the diff.

- **Where it applies.** Source mode of Markdown pages and every plain text file tab. Memory notes and Live, Rich and Reading modes are unchanged: `editorExtensions` in `src/features/editor/CodeEditor.tsx` promises a note the same extension list as always, so the power extensions sit behind a prop the file tab sets.
- **Multi-cursor.** `searchKeymap` already binds Ctrl+D (select next occurrence) and Ctrl+Shift+L (select all occurrences); what is missing is `EditorState.allowMultipleSelections`, `rectangularSelection()` and `crosshairCursor()` (Alt), plus folding and bracket matching for code languages only.
- **Macros.** Ctrl+Shift+R can reload the page in WebView2. The editor's keymap takes it with `preventDefault`; Claude checks in the dev app that the page does not reload, and if it does the binding moves to Ctrl+Alt+R. Ctrl+Shift+P is free (the app's palette takes Ctrl+P only without Shift).
- **Line tools** are in the editor toolbar's menu and in the palette while a file tab is active; each runs as one transaction, so one Undo reverts it.
- **Encodings and line endings.** A new Rust `file_reopen(notebook, path, encoding)` decodes the file again with a chosen encoding from NS-1B's editable list (`src-tauri/src/files/encoding.rs`); the webview refuses it while the buffer has unsaved edits. Convert to and the LF or CRLF choice change the `format` the next save writes. A file with mixed line endings is read-only today (`files/mod.rs`); choosing LF or CRLF in the status line converts the buffer, marks it unsaved and makes it editable.
- **Compare** opens as a tab in the pane that is not restored after a restart (the workspace drops kinds it does not persist). Copying a hunk across edits the open document of that side through the document store, with its undo; it never writes a file directly. "A file from disk" uses the existing open dialog (`opens.rs open_dialog`).
- **Language** comes from the file extension through `@codemirror/language-data` (already a dependency, loaded lazily), with a picker in the status line.

## 1. What the user sees

- **Status line** (clickable): encoding, line endings, indentation, language. Actions: **Reopen with encoding…** (decode again with a chosen encoding; refused if the buffer is dirty), **Convert to…** encoding (on save), **Line endings: LF / CRLF** (converts the buffer), **Choose a line ending** for mixed files (makes them editable).
- **Multi-cursor:** Alt+click adds a cursor, Alt+drag (or Alt+Shift+arrows) makes a rectangular selection, Ctrl+D selects the next occurrence, Ctrl+Shift+L selects all occurrences.
- **Line tools** (menu and palette, also on a selection): sort ascending, descending, case-insensitive, numeric; remove duplicates; trim trailing spaces; join lines; duplicate line; move line up or down; upper, lower and title case; tabs to spaces and back.
- **Macros:** Record (Ctrl+Shift+R), Stop, Play (Ctrl+Shift+P inside the editor), Play N times, Play to end of file. Up to 10 saved macros with names, kept in localStorage. Mouse actions are not recorded.
- **Compare:** pick any two open files or a file and a file from disk; a side-by-side diff with next and previous change, ignore whitespace, copy a hunk across.
- Language from the file extension through `@codemirror/language-data` (lazy), with a picker to override.

## 2. Design

- `CodeEditor` gains `allowMultipleSelections`, `rectangularSelection()`, `crosshairCursor()`, `selectNextOccurrence`, `selectSelectionMatches`, folding and bracket matching for code languages.
- `src/features/power/lineTools.ts` (pure transforms over line arrays, applied as one transaction per selection).
- `src/features/power/macros.ts`: a recorder that wraps keymap commands and `EditorView.inputHandler` events into a list of steps; replay runs them as transactions; "to end of file" stops when the cursor stops moving.
- Encoding actions call Rust `file_reopen(ref, encoding)` and pass the chosen target encoding in `format` on save; unmappable characters refuse as in NS-1B.
- `src/features/power/Compare.tsx` with `@codemirror/merge` `MergeView`.

## 3. Tests and exit

vitest for every line tool (empty lines, CRLF already normalised, Unicode case), macro record and replay on a scripted editor state, compare model. Exit: the listed workflows on files up to 8 MB without visible lag; Memory regression pass.

## 4. Shipped

(Filled in when the phase lands.)
