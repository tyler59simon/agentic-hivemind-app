# NS-1B: open any file

Read [README.md](README.md) and [phase-1a-workspace.md](phase-1a-workspace.md) first. This phase makes Hivemind the user's editor for any text file: open from a dialog, from Explorer ("Open with Hivemind" or a double-click on an associated type), by dragging onto the window, or from a recent list. It also adds encoding and line-ending preservation for every file, and the `hmfile` scheme so pages show local images. Spike findings S1, S2 and S7 in [spikes/](spikes/) decide the details marked "per spike".

## Changes from the NS-0 review

These rules come from the Codex review of the design ([reviews/ns0-codex-review.md](reviews/ns0-codex-review.md)). Where the text below says otherwise, these win.

- Folder identity is the canonical path converted with `folders::plain` (public) and compared in lowercase; `folders.rs normal()` is private and is not used (W1). `ReplaceFileW` comes from a direct `windows-sys` dependency (W2).
- Instance protocol v2 follows README 5.6: a request `id`, the reply only after the paths are queued (deduplicated by `id`), a 5 s wait in the starting process, and the frontend subscribing to `open-requested` before it drains `open_pending()`. Tests: delayed startup, a lost acknowledgement resent with the same id, an old instance receiving a v2 knock, and a new instance receiving a token-only knock (U2).
- Grants follow README 5.5: exact Origin check, revocation when a notebook is removed or a recent entry is forgotten or evicted, one percent-decode before `resolve_inside`, and `files::guard` on every resolved target. Tests: a request from the capture window, a forgotten grant, `%2e%2e`, `%5c`, a nested page path, and a junction inside the grant root (S3).
- `hmfile` answers CORS for the app's exact origins and exposes `Content-Range`, `Accept-Ranges` and `Content-Length`; spike S1 checks pdf.js Range fetches from both the dev and production origins (U11).
- A legacy-encoded file is editable only if decoding its actual bytes and encoding the result gives back the same bytes; otherwise it opens read-only with Convert to UTF-8. This covers encodings with two byte forms for one character (Shift_JIS IBM and NEC extensions). Test with files written by other encoders, not only by `encoding_rs` (U10).
- Every loose-file operation (open, save, Save as, recent list) runs `files::guard`, so a loose file inside the store or a managed vault opens read-only (S2). A loose file that lies inside a registered notebook becomes a notebook page, and its tabs and drafts move to the notebook key (U9).

## 1. What the user sees

- Ctrl+O (the quick switcher) lists notes, pages and **recent files**, and ends with **Open file from disk…** (native dialog, any file). The palette has **Open file…** and **New text file**.
- Dropping files on the window opens each in a tab (folders are offered as a new notebook).
- In Explorer: `.md`, `.markdown`, `.hmdoc` and `.canvas` can be set to open with Hivemind; any file has **Open with > Hivemind**. With Hivemind running, the file opens as a tab in the running window and the window comes to the front. With Hivemind closed, it starts and opens the file.
- A loose file's tab shows its folder as the eyebrow and a status line: encoding (UTF-8, UTF-8 with BOM, UTF-16 LE, Windows-1252, ...), line endings (LF, CRLF), size.
- A file that decodes with errors, or in an encoding Hivemind cannot write back exactly, opens read-only with the reason and a **Convert to UTF-8 and edit** button (makes the buffer editable; saving writes UTF-8 with the same line endings).
- **New text file** (Ctrl+N when no notebook exists or from the palette) opens an untitled buffer; the first save asks where (save dialog). This is the `new-file` tab kind.
- Images in Reading view and (from NS-3A) Live view load from the page's folder through `hmfile`.
- Files over 64 MB, and binary files, open in the system app for now (the viewer comes in NS-6B).

## 2. Opening from outside: single instance protocol v2 (`src-tauri/src/instance.rs`)

Anchors: `fn answer(`, `pub fn knock(`, `TOKEN_LEN`, `WORKERS`.

- Request: token (32 bytes), then optionally `\n` and JSON `{ "v": 1, "open": [paths], "cwd": "..." }`, at most 64 KiB in total, read within the existing patience window. Reply: the reversed token, as today.
- `answer()` returns `Option<Knock { open: Vec<String>, cwd: Option<String> }>`; `Owner::serve` takes `impl Fn(Knock)`. A token-only knock is `Knock { open: [] }` and only raises the window.
- Second launch (`run()` in `lib.rs`, before `instance::claim` result handling): collect `std::env::args_os().skip(1)` that are not flags, make each absolute against `current_dir`, canonicalise, keep existing files (at most 32). If the knock with paths gets no reply within 1.5 s, knock token-only and show a Windows notification "Restart Hivemind to open files" (an older instance is running).
- Cold start: the owner's own paths go into `AppState.open_queue: Mutex<Vec<String>>`. A knock with paths pushes to the queue, raises the window (`capture::show_main`) and emits `open-requested`. The frontend calls `open_pending()` on mount and on every `open-requested`, so no path is lost to the listener race.
- Explorer multi-select: the NSIS verb uses `MultiSelectModel=Player` so one process receives all paths (per spike S2).

**Tests:** a token-only knock (old client) still raises; a payload knock delivers paths; payload over 64 KiB refused; token plus garbage refused; silent clients do not block (existing test extended); `open_pending` drains once.

## 3. Grants (`src-tauri/src/opens.rs`)

- `Grants { path: app_data/open-files.json, list: Mutex<Vec<Grant { id, path, opened }>> }`, newest first, capped at 200. `grant_id(path) = first 16 hex of sha256(normal(path))` using `folders.rs normal()`.
- A path enters only from: the open dialog, a knock, a Tauri `DragDrop` window event seen in Rust (handled in `on_window_event`; the frontend's `onDragDropEvent` only names paths Rust recorded within the last 10 s), or a save dialog for a new file.
- A path inside a registered notebook is returned as a `FileRef` instead of a grant.
- Commands: `open_dialog() -> Vec<OpenRef>`, `open_pending() -> Vec<OpenRef>`, `open_recent() -> Vec<Recent>`, `open_forget(grant)`, `save_as_dialog(suggested) -> Option<OpenRef>`. The `file_*` commands from NS-1A accept `{ grant }` as well as `{ notebook, path }`.
- Loose files save with `ReplaceFileW` (declared with `windows-sys`, already in the build, or by hand as `instance.rs` declares `AllowSetForegroundWindow`) so ACLs, attributes and creation time survive; a read-only attribute refuses the save and offers Save as.

## 4. Encodings (`src-tauri/src/files/encoding.rs`)

New crates: `encoding_rs`, `chardetng` (licences in the README's dependency table).

- Detect, in order: BOM (UTF-8, UTF-16 LE, UTF-16 BE); valid UTF-8; UTF-16 without BOM when at least 40% of even or odd bytes in the first 4 KB are NUL and the rest decodes; NUL in the first 8000 bytes means binary; otherwise `chardetng` guesses a legacy encoding (with the TLD hint off).
- Decode with `encoding_rs`. `had_errors` makes the file read-only ("contains bytes that are not valid <encoding>").
- Encode on save: UTF-8 (BOM kept as loaded); UTF-16 LE and BE written by hand with `encode_utf16` (`encoding_rs` has no UTF-16 encoder); legacy encodings with `Encoder::encode_from_utf8_without_replacement`, and any unmappable character refuses the save with "<n> characters cannot be written in <encoding>" plus the Convert to UTF-8 option. Stateful encodings (ISO-2022-JP) open read-only.
- Line endings: detect LF, CRLF, CR, mixed. The webview text is always LF; Rust converts on save. CodeMirror shows the file's style in the status line. Mixed files are read-only until NS-6A's "choose a line ending" action.
- `FileFormat` gains `encoding` as an `encoding_rs` name (`UTF-8`, `UTF-16LE`, `UTF-16BE`, `windows-1252`, ...) and `confidence: "bom" | "valid" | "guess"`.
- **Round-trip rule:** opening and saving with no edits must give identical bytes for every encoding Hivemind lets the user edit. A cargo test enforces it per encoding (spike S7 lists them).

## 5. The `hmfile` scheme (`src-tauri/src/assets.rs`)

As in README 5.5, per spike S1. Grants for images are separate from file grants: `AssetGrants` maps an opaque random id (128 bits) to a root folder and is rebuilt each run; the frontend asks `asset_base(ref) -> String` for the URL prefix of a page's folder (the notebook root for notebook pages, the file's folder for loose files). Reading view (`PageView.tsx`) rewrites relative `src` values to `asset_base` plus the encoded relative path; absolute `http(s)` URLs stay as they are; anything else (`file:`, `C:\`) is not loaded and shows its alt text.

**Tests (cargo, every refusal):** wrong webview label; POST; unknown grant; `..` and encoded `%2e%2e`; absolute path; extension not allowed; over the size cap; a junction escape; Range 206 with correct `Content-Range`; SVG gets the strict CSP header.

## 6. File associations and "Open with" (`src-tauri/tauri.conf.json`, NSIS hook)

- `bundle.fileAssociations`: `md` and `markdown` (`Markdown document`), `hmdoc` (`Hivemind rich page`), `canvas` (`JSON Canvas board`), role `Editor`.
- `bundle.windows.nsis.installerHooks`: a `hooks.nsh` that writes `HKCU\Software\Classes\Applications\agentic-hivemind.exe\shell\open\command` = `"<exe>" "%1"`, `FriendlyAppName` and `SupportedTypes` for common text types (`.txt .log .json .yaml .yml .toml .ini .cfg .csv .xml .ps1 .py .ts .js .rs .sql`), with `MultiSelectModel=Player` on the verb; the uninstall hook removes the key. It never sets a default program.
- Verified only on an installed build (README section 7).

## 7. Frontend

- `src/lib/opens.ts` wrappers; `src/workspace/store.ts` `TabKind` gains `"new-file"`; `FileRef | GrantRef` handled by `docKey`.
- `FileTab.tsx` shows the status line (encoding, EOL, size), the read-only reason and Convert to UTF-8.
- `App.tsx`: listen for `open-requested`; on mount call `open_pending()`; listen for drag and drop through `getCurrentWebview().onDragDropEvent` and ask Rust to open the recorded paths.
- Palette: Open file…, New text file, recent files in Ctrl+O.

## 8. Exit criteria

- With Hivemind running, double-click an associated `.md` in Explorer: it opens in the running window. "Open with > Hivemind" on a `.log` does the same. Selecting three files and choosing Open with opens three tabs.
- A windows-1252 file with accented characters, a UTF-16 LE file with BOM, and a CRLF UTF-8 file each open, change one line and save; a byte diff shows only that line changed.
- A file with invalid UTF-8 bytes opens read-only; Convert to UTF-8 then saves UTF-8.
- An image beside a page shows in Reading view; `../` outside the notebook does not load.
- All test commands and the Memory regression pass.

## 9. Shipped

Landed on 2026-11-20 (commit history of `docs/notes-studio/phase-1b-open-any-file.md`, `src-tauri/src/opens.rs` and `src/features/notes/opening.tsx`).

**Verified**
- `npm test` (83 files, 610 tests), `npx tsc --noEmit`, `npm run build`, `cargo test` (561), `cargo clippy --all-targets` (the same older warning in `lib.rs`). `src/workspace/store.test.ts` gained one test and kept its old ones unedited. `bridge::tests::a_script_that_fails_shows_its_stderr` failed once more in a full run and passed three of three alone; it stays tracked as its own bug.
- Spike S1 passed in the dev app and the release build: [spikes/s1-hmfile.md](spikes/s1-hmfile.md).
- Real app, driven over CDP with a scratch notebook registered in app data and removed afterwards:
  - Starting a second copy (`target\debug\agentic-hivemind.exe`) with six arguments while the dev app ran: it knocked and exited in about a second. Four loose files and one notebook page opened as tabs. A missing file and a `--flag` were skipped. The page opened as the notebook's page, not as a loose file. The knock arrived while the window still said "Connecting to Living Memory", and the tabs appeared once it connected.
  - Status lines: `windows-1252 (guessed) · CRLF`, `UTF-16LE with BOM · CRLF`, `UTF-8 · LF`.
  - Editing line 2 of the windows-1252 file and of the UTF-16 LE file and saving: a byte dump showed line 1 unchanged in both (`caf\351 \200 one\r\n`), CRLF kept, and the BOM kept.
  - Typing `中` into the windows-1252 file and saving gave "1 character cannot be written in Windows-1252" with Convert to UTF-8. Converting and saving wrote UTF-8 with CRLF kept.
  - A file with an invalid UTF-8 byte opened read-only with "Convert to UTF-8 and edit". After converting, it saved as UTF-8 with U+FFFD in place of the bad byte.
  - A file with the read-only attribute offered "Save a copy as…", and a binary file offered "Open with default app".
  - Pictures rendered in Reading view from a notebook page and beside a loose Markdown file. `../outside.png` and a `file:` URL showed their alt text.
  - Ctrl+O led with the recent files and ended with "Open file from disk…". The palette offered "Open file…" and "New text file". A new text file took focus and showed the unsaved dot. Closing it warned that its text is lost.
  - After a loose file was moved away, its tab showed the error with "Remove from recent files", which closed the tab and took the file off `open-files.json`.
- Not run: the native open and save dialogs (they would appear on the user's screen), dropping files or folders on the window (CDP cannot produce an operating-system drop), and spike S2 (below).

**Found by the UI pass**
- `toLoaded` in `src/documents/store.ts` dropped `convertible`, so Convert to UTF-8 never showed. Fixed, with a store test that fails without the fix.
- Ctrl+O never showed recent files with an empty query, because notes filled the 50-row cap. The eight newest recent files now lead the list; the rest stay searchable.
- A loose file's eyebrow showed its whole folder path in capitals. It now reads "Opened file · <folder name>", with the full path as the tooltip. The breadcrumb reads "Opened files / <file name>".
- The new text file's editor did not take focus, and closing it or quitting promised a draft that does not exist. It now focuses on open, and both dialogs say a never-saved file is lost.
- A deleted loose file could not report Gone: `loose()` failed to canonicalize it, so its save failed. When a loose file is missing, its folder is checked instead, so the save answers Gone and the banner offers Save as. A Rust test covers this.

**Spike S2 (associations on an installed build): built, not installed.** `npm run tauri build` built the NSIS installer (with the `fileAssociations` and `windows/hooks.nsh`) and the MSI. Installing it replaces the user's installed Hivemind and its registry entries, so the Explorer checks wait for the user: double-click an associated `.md`, "Open with > Hivemind" on a `.log`, and a three-file selection. The second-launch path itself is the one the knock test above used.

**Deviations**
- A loose file is a `FileRef` whose notebook is `@<grant id>` and whose path is its file name, not a separate `GrantRef`. Every tab, document and draft path already used `FileRef`. Only `file_read`, `file_save`, `file_reveal` and `asset_base` accept `@` ids; `root_of` refuses them, and so every other notebook command does too.
- Drops are handled in Rust, in `on_window_event` (`DragDrop::Drop` on the main window), not through the webview's `onDragDropEvent`. Files join the open queue like files from Explorer. Each folder gets a token that `notebook_add_dropped` accepts for two minutes, after the user confirms "Add this folder as a notebook?". The webview never sends a path.
- The command is `file_save_as(text, suggested)`, not `save_as_dialog(suggested)`; it writes the text itself (UTF-8, LF).
- An older running instance gets a token-only knock (it comes to the front), and the new launch shows a message box saying to restart Hivemind to open files, not a Windows notification.
- Loose files save like notebook pages: the file is renamed aside and the new one moved in (`files::atomic`), and `copy_basic_info` now copies the creation time and the hidden, system, archive and not-indexed attributes. `ReplaceFileW` is not used. **Gap:** explicit (not inherited) per-file ACLs are not kept on save.
- Picture grants are withdrawn by one rule (`opens::prune_assets`): a root stays only while it is a registered notebook's folder or the folder of a recent file. It runs when a notebook is removed, a recent file is forgotten, and after every new recent file (which can push the oldest off the 200-entry list).
- Binary files open in a read-only tab with "Open with default app", and a file over 64 MB shows its error with the same button. The phase text said they open in the system app directly.
- Loose files are not watched. An outside change reaches a loose tab only when it saves (the hash check then offers the merge), and a clean loose tab does not follow outside edits. Tracked for a later phase.
- Recent files can be forgotten only from a loose file's error view ("Remove from recent files"); there is no list editor yet.
