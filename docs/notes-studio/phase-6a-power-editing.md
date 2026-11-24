# NS-6A: power editing

Read [README.md](README.md) and [phase-1b-open-any-file.md](phase-1b-open-any-file.md) first. This phase brings Notepad++ text workflows to Source mode and plain text files up to about 8 MB.

## Changes from the code survey before NS-6A

Claude surveyed main on 2026-11-22 (after NS-5). Where the sections below say otherwise, these win. At the user's request this phase has no Codex review; Claude reviews the diff.

- **Where it applies.** Source mode of Markdown pages and every plain text file tab. Memory notes and Live and Reading modes are unchanged: `editorExtensions` in `src/features/editor/CodeEditor.tsx` promises a note the same extension list as always, so the power extensions sit behind a prop the file tab sets.
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

Code landed on 2026-11-22: Hivemind `0c4e835`, with the fixes from Claude's review and UI pass. At the user's request this phase had no Codex review; Claude reviewed the diff.

**What is where**
- **Rust.** `file_reopen(notebook, path, encoding)` in `src-tauri/src/studio.rs`. `file_read` and `file_reopen` both go through `read_for`, which resolves a page with `inside()` and a loose file with `loose()`, so a reopen reaches exactly what a read reaches. `files::encoding` gained `EDITABLE` (the 14 encodings of the round-trip test), `editable(name)` and `decode_as`, which refuses NUL bytes unless the encoding is UTF-16. `files::read_as` and `read_view_as` share `read_inner` with `read`. `Loaded` gained `chooseEol` (`choose_eol` in Rust): read-only only because of mixed line endings.
- **Document store.** `src/documents/session.ts` has a `reformat` event and `DocState.reformat = { from }`, the format the file has on disk while `base.format` holds the one the next save writes. `src/documents/store.ts` has `reformat(key, change)` and `reopenAs(key, encoding)`. A save with a pending `reformat` passes `convert = true`, which is what lets Rust write over a mixed file. The draft keeps `reformat`, so the choice comes back with the text.
- **Editor.** `CodeEditor` takes `power?: { id, fileName, language?, on }`. Only a file tab passes it; a note adds no extension (a test counts the 14 entries it has always had). The power switch and the language switch are compartments that exist only when `power` is set.
- **`src/features/power/`.** `lineTools.ts` (transforms and tools), `macros.ts` (recorder, replay, saved macros), `extensions.ts` (multiple selections, rectangular selection, macro keys), `language.ts` (language by file name, indentation), `registry.ts` (a tab's editor, for the palette and the status line), `PowerBar.tsx` (Lines menu, Record, Play, Macro menu), `StatusLine.tsx` (the clickable status line), `hunks.ts` (Compare model), `Compare.tsx` (the Compare tab), `ComparePicker.tsx`.
- **Workspace.** A new `compare` tab kind with `Tab.compare = { left, right }`. It is dropped by `partialize`, follows a renamed file (`retargetFile`), counts as holding both documents in `sync.ts`, shows the unsaved dot when either is unsaved, and Ctrl+S saves both. Reached from the palette ("Compare files…", which starts from the focused file) and the page menu ("Compare with another file…").
- **Palette.** While a file tab shows source: 15 `Lines: …` commands, `Macro: record` or `stop recording`, `Macro: play the last one`, `Macro: play to the end of the file`. "Compare files…" is always there.

**Keyboard shortcuts** (all inside the editor of a file tab, Source mode or a text file)
- Ctrl+Shift+R records or stops, Ctrl+Shift+P plays the last macro once, Esc cancels a replay.
- Ctrl+D selects the next occurrence and Ctrl+Shift+L all occurrences (already in `searchKeymap`, now with several selections allowed). Ctrl+Alt+Up and Down add a cursor above or below (CodeMirror's own). Ctrl+click adds a cursor (CodeMirror's default).
- Alt+drag makes a rectangular selection. Alt+Shift+Up, Down, Left and Right grow one by keyboard (a new command in `extensions.ts`; the columns survive a short line).
- Clashes: no app shortcut uses these (`App.tsx` and `Workspace.tsx` handle Ctrl+P without Shift, O, N, G, Shift+A, W, S, Tab, `\` and E). Inside a file tab, Alt+Shift+Up and Down no longer duplicate the line (the menu and the palette do), and Alt+Shift+Left and Right no longer select by syntax. A Memory note keeps both.

**Deviations**
- **Alt+click does not add a cursor.** CodeMirror's Alt gesture is the rectangle, and a plain click with it replaces the selection; Ctrl+click adds one. Making Alt+click add would also keep the old cursor after every Alt+drag, so it was left alone.
- **Play to the end of the file** stops when a run leaves the cursor at the end of the file, or leaves it where it was with the text unchanged, not on any "cursor stops moving". A run that types and then steps down always moves the cursor on the last line, so the plain rule never ends. A cap of 1,000,000 runs and the Esc key stop a macro that never gets there.
- **Macro steps** are typed text and the commands of the editor's default keys, recorded by key name (`Mod-ArrowLeft`), so a saved macro still plays after a restart. Mouse, menu and palette actions are not recorded. Pasting was not checked in the app.
- **Macro playback on a real editor** runs on a copy of the editor's state and gives the editor one transaction (UI-2, below). A macro on a wrapped editor, or on anything that is not a real editor, still runs step by step on the editor's own state and reports to the page once, when it ends (`replayDone`).
- **Join lines** with only cursors joins each cursor's line with the next; with a selection it joins the selected lines. Every other line tool with only cursors works on the whole file, as the phase text says.
- **Compare** shows both sides read-only, aligned by gaps of fixed height computed from the changes (UI-1, below); copying a change edits the other side's open document like typing (unsaved, with a draft) and the tab has its own Undo copy, which refuses when that file changed since. "Ignore whitespace" compares lines with all whitespace removed (`ignoreWhitespaceDiff` in `hunks.ts`) and falls back to the exact diff above about 55,000 distinct lines.
- **Indentation** in the status line is shown, and its menu runs the "tabs to spaces" and "spaces to tabs" tools on the selection or the file. It does not set the editor's indent unit.
- **Language** is not offered for Markdown, whose language stays Markdown. The override is stored on the tab (`Tab.language`), so it follows the workspace's persistence. `@codemirror/language-data` was already in the main chunk through `editor/rich`, so the dynamic import in `language.ts` makes nothing lazier.
- **A Living Memory page** keeps the plain status line (UTF-8, line endings, size): its bytes are Living Memory's.
- No new dependency.

**Verified** (Claude, in vitest and cargo; the app was not launched)
- `cargo test` 713 passed, `cargo clippy --all-targets -- -D warnings` clean. New: every editable encoding through `file_reopen`, containment, a loose file and a protected one, mixed line endings and `chooseEol`.
- `npx vitest run`: 161 files, 1689 tests, passed twice in a row after the UI pass. `src/workspace/store.test.ts` unedited. The main session raised the timeouts of the two `it.each` blocks in `src/features/rich/roundtrip.test.ts` to 20 s, which the suite needed once this phase's CPU-heavy tests joined it.
- `npx tsc --noEmit` and `npm run build` pass.
- New tests: line tools (`lineTools.test.ts`), macros and saved macros (`macros.test.ts`), the multi-cursor and rectangle extensions and a note's untouched list (`CodeEditor.power.test.ts`), reformat and reopen in the store (`store.reformat.test.ts`), the mounted status line, banners and language picker (`FileTab.power.test.tsx`), the palette (`Palette.power.test.tsx`), the Compare model and tab (`hunks.test.ts`, `Compare.test.tsx`, which also covers the picker), language and indentation (`language.test.ts`). Breaking the code on purpose made the matching test fail for: the dirty-page refusal of a reopen, the unsaved flag and the lenient save of a reformat, the power switch following the mode, the 10-macro cap, the play-to-end stop rule, the newline of a copied change, the end of a selection that stops at a line start, the Alt+Shift keys, the mixed-file banner button, the Compare tab holding its documents, and (in Rust) the containment of `file_reopen`.
- Timings on the 200,000-line, about 5 MB test input, on a slow machine: sort ascending 339 ms, descending 386, ignoring case 282, by number 219, remove duplicates 84, trim 654, join with the whole file selected 50, upper case 627, lower 23, title 583, tabs to spaces 31, spaces to tabs 49. A macro (type `// `, step down) played to the end through a state-only target: 200,000 runs in 1.4 s with 84 pauses for the window.

**UI pass after the first check in the app** (main session found three problems; webview only, no Rust change)
- **UI-1, Compare did not line the two sides up.** This report was Claude's misreading: in the case checked, `cherry   ` (trailing spaces) and `cherry` differ, so the diff pairs them as one change and the merge view's alignment was right. The rewrite below was kept, since it gives the same alignment without measuring. Compare now needs no measuring: lines are one fixed height (`LINE_PX` = 20 px, no wrapping, set by `lineLook` in `Compare.tsx`), so `alignment()` in `hunks.ts` works out from the changes alone how many lines of gap the shorter side needs after each change (or where its lines would be), and a block widget of exactly that height is drawn there. The merge view's own `measure` is switched off, so it adds no spacers of its own. Both sides sit in the one scrolling pane, so vertical scrolling is shared; a long line scrolls sideways on both sides together. Tests: `hunks.test.ts` builds the rows each side draws (lines plus gaps) for 14 pairs of texts, including the reported 8 lines against 4, and checks that every unchanged line has the same row on both sides and that both sides end on the same row; `Compare.test.tsx` checks that the gaps are in the DOM, 20 px per line, and that no spacer of the merge view is. Switching off the merge view's own measuring is not covered by a test (jsdom has no layout, so the merge view adds no spacers there either way); breaking the gap sizes, `headless.ts`'s column move and the changed-text guard each made a test fail.
- **UI-2, macro playback was far too slow on a real editor** (about 90 runs a second: each step was a transaction through the view, which draws and measures). `src/features/power/headless.ts` runs the commands against a copy of the state. The commands are the editor's own; they get a stand-in for the view that answers `state` and `dispatch` from the copy and the few view methods that read the screen (`lineBlockAt`, `moveToLineBoundary`, `moveVertically`, with the column kept as a number of characters, plus a private `bidiCache`). This applies to a view whose lines do not wrap and whose text runs left to right (`canReplayHeadless`); a wrapped editor (Markdown source) is replayed step by step as before, because the screen decides where a line ends there. `play()` works in slices of about 14 ms and pauses for the window between them; the page shows "Playing: N runs". **One transaction at the end** (`input.macro`): one Undo reverts the whole replay, and it is reported to the page once. Esc applies what was done so far, again as one transaction. The editor takes no typing during a replay (keydown, beforeinput, paste, cut and drop are stopped), and if its text changed some other way meanwhile (another pane saving over it), nothing is applied and a message says so. The cost is that the text does not change on screen until the replay ends.
- **UI-3, "Measure loop restarted more than 5 times".** In the recheck no new warning appeared (counted with a `console.warn` hook while switching tabs, sorting the 8 MB file and opening Compare); the repeats Claude saw were old entries the debugging connection replays each time it attaches (CDP `Log.enable`). The changes below stay. The likely cause is the Compare view: its editors wrapped lines inside a pane that scrolls, and the merge view's spacers change the pane's height, which can bring a scrollbar in and out, which changes the wrapping, which changes the heights, round again. Compare now has no wrapping and no measured spacers (UI-1), so that loop has nothing to feed on. The power bar also has a fixed minimum height now (`.power-bar`), so its recording and playing messages cannot change the editor's height. If the message still appears in the app, the next suspect is the file editor itself with an 8 MB text.
- Timings (jsdom with the real view, 10.8 MB, 155,000 lines, macro End, `;`, ArrowDown to the end of the file): 3.5 s, about 43,000 runs a second, one dispatch to the editor, one Undo restores the text. A smaller replay of 40,000 runs took 33 slices of about 1,200 runs. Before: about 90 runs a second on the real editor.


**UI pass (2026-11-22).** Claude ran the dev app with a scratch notebook (text files for each tool, a Windows-1252 file, a file with mixed line endings, a Python file and an 8 MB, 150,902-line log):
- Lines > Sort ascending, then one Undo reverts it; Sort descending on the 8 MB file in about 1 s.
- Ctrl+Shift+R recorded End, `;`, Down; Ctrl+Shift+P played it twice. Alt+drag made a three-line rectangle and typing went onto each line; Alt+Shift+Down added column cursors.
- Reopen with encoding as Greek (Windows-1253), Convert to UTF-8, save: the file held the expected UTF-8 bytes. Use CRLF and edit on the mixed file: editable, saved as all CRLF.
- Python highlighting, folding and the indentation reading in the status line.
- After the UI-2 fix, the macro played to the end of the 8 MB log in under 2 s (it took about 90 runs a second before), and one Undo reverted it.
- Compare of two files with and without Ignore whitespace: unchanged lines on the same row on both sides.
- A Memory note in Source mode: no Lines bar, one cursor.

**Not verified**
- Whether a real Ctrl+Shift+R reloads WebView2: keys sent over CDP do not trigger its reload shortcut even outside the editor, so the UI pass cannot tell. If it does, move the binding to Ctrl+Alt+R in `extensions.ts`.
- Spike or contract changes: `Loaded.chooseEol` and the `file_reopen` command are additions only (README 5.7 lists the command).
