# NS-6A: power editing

Read [README.md](README.md) and [phase-1b-open-any-file.md](phase-1b-open-any-file.md) first. This phase brings Notepad++ text workflows to Source mode and plain text files up to about 8 MB.

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
