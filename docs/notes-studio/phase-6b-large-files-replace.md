# NS-6B: large files and replace in files

Read [README.md](README.md) and [phase-5-history.md](phase-5-history.md) first. This phase opens files too big for the editor (and binary files) in a fast viewer, follows growing logs, shows a hex view, and adds find and replace across a folder or notebook with a preview of every change.

## 1. What the user sees

- Files over about 8 MB open read-only in the editor up to 64 MB; above 64 MB, and binary files, open in the **large file viewer**: line numbers, jump to line, regex search with next and previous, copy lines, word wrap off. It opens instantly and indexes in the background with a progress bar.
- **Follow** (tail -f): the view sticks to the end as the file grows; a truncated or rotated file is re-indexed.
- **Hex view** for any file: offset, hex bytes, text column, jump to offset, search bytes.
- **Find in files** (palette, and a notebook or folder context menu): pattern (text or regex, case, whole word), include and exclude globs, the folder or notebook; results grouped by file with line previews. **Replace** shows a per-file diff with checkboxes, then applies with each file's hash precondition, a history snapshot first, and **Undo all** afterwards. A file changed since the preview is skipped and listed.

## 2. Design

- `src-tauri/src/bigfile.rs`: opens with read, write and delete sharing; a sparse line index (every 1024th line's byte offset) built on a background thread with `bigfile-progress` events; `bigfile_lines(handle, first, count)` decodes windows on demand (UTF-16 aware, encoding from NS-1B detection); `bigfile_search(handle, pattern, from, direction)` streams with `regex` over decoded windows; `bigfile_bytes(handle, offset, len)` for hex. Follow: a watcher plus a 500 ms size poll; growth indexes the new bytes and emits `bigfile-grew`; shrink or replace re-indexes. Handles close when the tab closes.
- Frontend: a virtual list with fixed row height (no CodeMirror, no new dependency) in `BigFileView.tsx`; `HexView.tsx` likewise.
- `src-tauri/src/replace.rs`: walk with the `ignore` crate (respects `.gitignore`, skips `.git`, `.hivemind`, binaries and files over 8 MB), match per file with encoding detection, build a preview `{ path, sha256, hunks }`, apply with `file_save`-equivalent preconditions and `history` snapshots, record an undo set.

## 3. Tests and exit

cargo: line index over generated files (LF, CRLF, UTF-16, no trailing newline), a gated 200 MB file in a temp folder, growth and rotation, regex across window boundaries, replace preview and apply, a file changed between preview and apply is skipped, undo all. Exit: a 200 MB log opens in under a second, searches and follows; replace in files never overwrites a changed file; Memory regression pass.

## 4. Shipped

(Filled in when the phase lands.)
