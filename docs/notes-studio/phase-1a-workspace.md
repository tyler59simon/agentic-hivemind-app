# NS-1A: shared workspace, Notes page and folder notebooks

Read [README.md](README.md) first. This phase gives Hivemind a Notes page where the user registers folders as notebooks, browses them as a tree, and opens pages as tabs in the same workspace the Memory page uses. Pages are plain files on disk; saving is atomic and refuses to overwrite a file that changed underneath. Memory behaviour does not change.

Out of scope here: loose files outside notebooks, encodings other than UTF-8, images (NS-1B); Living Memory notebooks (NS-2C); rich preview (NS-3A); the index and backlinks (NS-4A).

## 1. What the user sees

- A **Notes** section in the sidebar (icon `NotebookPen`), after Memory. Hiding it works like any section (`src/shell/hidden.ts`).
- The Notes page: a notebook column on the left and the workspace on the right. With no notebooks, the page explains notebooks and offers **Add a notebook** (native folder dialog).
- The notebook column lists registered notebooks, each a collapsible tree: sections (subfolders), pages (`.md`, `.markdown`, `.txt` and other text files), subpages (`X/` beside `X.md` nests under `X.md`). An **Attachments** heading shows the attachments folder. Hidden: `.hivemind`, `.git`, `.obsidian`, `node_modules`, any dot-folder.
- Tree actions (context menu and buttons): new page, new section, rename, move (drag with pointer events within one notebook), delete (to the notebook's trash), reveal in Explorer (`opener` `revealItemInDir` is already allowed), notebook settings, remove notebook from Hivemind (files untouched).
- Clicking a page opens it in the focused pane; Ctrl+click or middle-click opens it in a split. Tabs show the page name with a dot when unsaved.
- A page tab has Reading, Live and Source modes (the same names as notes) for Markdown, and Source only for other text files (plain CodeMirror, line numbers on, no preview). Ctrl+E toggles Live and Reading. Ctrl+S saves. Live preview is today's `livePreview.ts`.
- Banners: "Restored unsaved edits from a draft", "This page changed on disk" (dirty editor; offers Merge or Reload), "Saved by another program; your copy was updated" (clean editor follows silently, banner fades).
- `[[Page]]` links in Markdown pages open the page in the same notebook (Ctrl+click in Live, click in Reading). A link to a missing page offers "Create page".
- Opening a note from anywhere outside Notes behaves exactly as today. Opening a page from outside Notes (the palette, Ctrl+O) goes to the Notes page.

## 2. Workspace changes (`src/workspace/`)

Anchors: `export type TabKind`, `export const sameTab`, `const showNotes`, `name: "hivemind.workspace"`, `export function notesOnly`.

- `TabKind` becomes `"note" | "new-note" | "file"`. `Tab` gains `file?: FileRef` (README 5.1). `Mode` is unchanged.
- New `src/documents/keys.ts`: `docKey(tab)` and `sameDoc(a, b)`. `sameTab` becomes `(a, b) => a.kind === b.kind && a.kind !== "new-note" && docKey(a) === docKey(b)`. For notes this is exactly `a.ref === b.ref`.
- `showNotes()` becomes `showTab(tab)`: read `useApp.getState().route`; if it is `{ page: "notes" }` or `{ page: "memory", view: "notes" }`, do nothing; else `note`/`new-note` go to `{ page: "memory", view: "notes" }` and `file` goes to `{ page: "notes" }`.
- `split()` opens a second view of any kind in reading mode (Source for non-Markdown files).
- Persistence version 3: `migrate(stored, version)` returns `notesOnly(stored)` for version 1 and the stored state for version 2. A `merge` option drops tabs whose kind is unknown (data from a newer build). `partialize` already drops `new-note`.
- `OpenTabs` and `PaneView` keep their markup. `TabPill` label: notes as today; files use `tab.title` or the file name. The `+` button in the strip makes a new note on Memory and a new page on Notes (in the notebook of the focused page, else the first notebook).
- `useCloseTab` message depends on the kind: notes keep "not saved to Living Memory"; files say "not saved to <file name>".
- `TAB_VIEWS.file = (tab) => <FileTab tab={tab} />`.
- `RightSidebar.tsx`: a `RAIL_VIEWS` record; `note` keeps `NoteRail`; `file` gets `PageRail` (On this page outline from `outline(body)` in `src/lib/note.ts`, File details: path, size, modified, notebook). Other sections arrive in later phases.
- The workspace keyboard listener (`Workspace()` effect) handles Ctrl+E for file tabs too.

**Tests (`src/workspace/store.test.ts` must pass unedited; add `src/workspace/files.test.ts`):** opening the same page twice focuses it; a page and a note never match; `showTab` stays on Notes for a note opened from Notes and goes to Memory from elsewhere; version 2 data loads unchanged; version 1 data still goes through `notesOnly`; unknown kinds are dropped; split works for files.

## 3. Document session controller (`src/documents/`)

- `session.ts` (pure): `type DocState = { status: "loading" | "clean" | "dirty" | "saving" | "stale" | "readOnly" | "error"; base: Loaded | null; text: string; version: number; banner?: Banner; error?: string }` where `Loaded = { text, sha256, size, mtimeMs, format }`. Reducer events: `loaded`, `edited`, `saveStarted`, `saved`, `staleOnSave(theirs)`, `outsideChange(theirs)`, `merged(text, theirs)`, `reloaded(theirs)`, `failed`. Rules: an outside change to a clean document replaces `base` and `text` and bumps `version`; to a dirty one it sets the "changed on disk" banner and keeps the text; a stale save goes to `stale` with both sides for the merge dialog.
- `store.ts`: a zustand store `useDocuments` keyed by `docKey`, holding `DocState` and a reference count of open tabs. It lives outside React, so moving between the Notes and Memory pages (which remounts the workspace) keeps every file document, edits included. The dirty flag in `useWorkspace.dirty` is set for every tab showing a dirty document.
- `useDocument.ts`: `useDocument(tab)` loads through the adapter, wires autosave of drafts (README 5.2 timings), `save()`, `merge(result)`, `reload()`. On unmount of the last tab, a dirty document keeps its draft.
- `adapters/file.ts`: `read(ref)`, `save(ref, text, precondition, format)`, mapping Rust errors to `Stale`, `ReadOnly`, `Gone`.
- Merge: reuse `mergeBody` and `hasConflictMarkers` from `src/features/editor/merge.ts`. Add a body-only mode to `MergeDialog.tsx` (prop `fields={false}`) rather than a second dialog; notes keep calling it as today.
- Drafts: `src/lib/drafts.ts` keeps an in-memory cache: `putDraft` stores the value there synchronously before the asynchronous `draft_put`, and `getDraft` reads the cache first, so a note editor that unmounts and remounts at once (switching between Notes and Memory) never loads a draft older than its last keystroke. `NewNote.tsx` and `NoteEditor.tsx` flush their pending draft on unmount instead of dropping the debounce timer (the one change to those files), so an edit made less than a second before leaving the page is in the cache. `Draft` becomes `NoteDraft | FileDraft` with a type guard `isFileDraft(d) => d.kind === "file"`; keys `file-<sha256 hex of docKey>` via `crypto.subtle.digest`. On load, a draft whose precondition hash equals the file's hash restores silently with a banner; otherwise the draft text is merged against the current file (base kept in the draft) or offered as "Your unsaved version" in the merge dialog.

- Rename and move: `file_rename` moves the drafts of every page it moved in Rust, in the same command (`drafts::retarget`), so unsaved edits follow the file even if the app stops right after; the frontend then, in one step, retargets open tabs (`retargetFile(notebook, from, to)` in the workspace store, folders included by prefix), moves the documents store entry and its drafts to the new `docKey` (case-only renames keep the same key, since keys are lowercased), and refreshes the tree. NS-5 moves history the same way.

**Tests (`src/documents/session.test.ts`, `keys.test.ts`, `src/lib/drafts.test.ts`):** every reducer transition; outside change clean versus dirty; stale save opens merge; draft restore with same and different hashes; key hashing is stable and distinct for `a_b` and `a/b`; a draft put and read back at once returns the newest value; a rename moves tabs, the document and its draft, including pages inside a moved folder.

## 4. Editor (`src/features/editor/`)

- New `CodeEditor.tsx`: props `{ doc, docVersion, language: "markdown" | "text", live, readOnly, lineNumbers, onChange, onSave, titles, onOpenLink, reveal, placeholder }`. Its extension list for `language: "markdown"` is produced by a pure `markdownExtensions(opts)` that returns today's list in today's order; `text` uses a plain language with `lineNumbers()` and `highlightActiveLine()`. Read-only and line numbers are Compartments.
- `MarkdownEditor.tsx` keeps `EditorProps` exactly and renders `CodeEditor` with `language: "markdown"`, `lineNumbers: false`, `readOnly: false` and the current placeholder. `NoteEditor.tsx` and `NewNote.tsx` change only to flush their pending draft on unmount (section 3).
- A test asserts that `markdownExtensions` for a note equals today's list (compare by extension identity where possible, else by a snapshot of the facet values used).

## 5. Notes UI (`src/features/notes/`)

- `NotesPage.tsx`: `notes-page` grid (tree column 16rem, resizable later; workspace; rail). Renders `<Workspace />` and the rail when tabs are open, else an empty state.
- `NotebookTree.tsx` with pure `tree.ts`: `buildTree(entries, meta)` (sections, subpages, order from the sidecar then alphabetical with folders first), `visibleRows(tree, open)` (reuse the shape of `treeRows` and `treeOpen` in `src/features/wiki/wiki.ts`), `dropTarget(...)` for pointer-event moves. Opened state persists in localStorage `hivemind.notes.open`.
- `FileTab.tsx`: header with the file name (rename in place), the notebook and folder as an eyebrow, mode tabs, Save, a menu (reveal, copy path, delete), banners; body is `PageView` (Reading) or `CodeEditor` (Live, Source).
- `PageView.tsx`: Markdown reading view with `src/ui/Markdown.tsx` plus `remarkWikilinks` from `src/features/viewer/remarkWikilinks.ts`; wiki links resolve through `src/features/links/resolve.ts`.
- `NotebookSettings.tsx`: title, attachments folder, templates folder, inbox page, remove from Hivemind. (Visibility and Private arrive in NS-2C.)
- `src/features/links/resolve.ts` (pure): `resolvePage(target, from: FileRef, pages: string[])`: exact relative path, then a case-insensitive match of the file name without extension in the same folder, then anywhere in the notebook (shortest path wins, as Obsidian does); returns `{ ref } | { missing: suggestedPath } | { ambiguous: refs }`. NS-4A replaces the page list with the index and adds other notebooks and memory.

## 6. Shell and app

- `src/store.ts`: `| { page: "notes"; notebook?: string; path?: string }`.
- `src/shell/Sidebar.tsx`: a `notes` entry in `SECTIONS` after memory; the unsaved dot moves to whichever section holds the dirty tab (notes: Memory; files: Notes).
- `src/shell/Shell.tsx`: `notes: () => <NotesPage />` in `PAGES`.
- `src/shell/Topbar.tsx` `useCrumbs()`: Notes > notebook title > page name.
- `src/App.tsx`: Ctrl+N makes a new page when the route is Notes, else a new note; the close guard counts every dirty tab.
- `src/features/palette/Palette.tsx`: Notes, Add a notebook, New page (section `notes`), and every page of every notebook in the Ctrl+O switcher (from `notebook_tree`, detail "notebook · folder").
- `src/App.css`: `/* ---- Notes ---- */` block; no new colour tokens.

## 7. Rust

New modules; register commands in `lib.rs` `generate_handler!` and state in `AppState`.

- `src-tauri/src/files/contain.rs`: `pub fn check_rel(rel: &str) -> Result<Vec<String>, String>` (forward-slash relative path; every part non-empty, not `.` or `..`, no `:`, no `\\`, no device name, no trailing dot or space, at most 240 characters per part) and `pub fn resolve_inside(root: &Path, rel: &str, for_write: bool) -> Result<PathBuf, String>` (README 5.3: only symbolic links and junctions count as links; OneDrive placeholders do not). `src-tauri/src/files/guard.rs`: `pub fn check(path: &Path, protected: &Protected) -> Result<(), String>` where `Protected` holds the store root and the managed vaults (README 5.3), built per command from the current store root; every notebook command runs it on the notebook root and on each resolved path. The file commands also refuse any hidden path part, which keeps `.git`, `.obsidian` and `.hivemind` out of reach (the sidecar has its own command). Tests: `..`, absolute, `C:x`, `\\server\share`, `a.md:ads`, `CON`, `con.txt`, trailing dot, a junction that escapes (create with `mklink /J` through `cmd`, skipped if it cannot be created), a symlinked parent on write.
- `src-tauri/src/files/atomic.rs`: `pub fn replace(path: &Path, bytes: &[u8]) -> Result<(), String>`: temp `.<name>.hm-<uuid>.tmp` in the same folder, write, `sync_all`, rename, remove the temp on failure. `pub fn is_temp(name: &str) -> bool`.
- `src-tauri/src/files/mod.rs`: `FileFormat { encoding: "utf-8", bom: bool, eol: "lf" | "crlf" | "mixed" | "none" }` (NS-1B widens it), `Loaded { text, sha256, size, mtime_ms, format, read_only: Option<String> }`, `Precondition { sha256, size, mtime_ms }`, `SaveOutcome::{Saved(Loaded-like stamp), Stale { sha256 }, Gone}`. Functions: `read(path)` (64 MB cap, NUL sniff, UTF-8 with or without BOM; other bytes give `read_only: "not UTF-8"` and lossless display deferred to NS-1B), `save(path, text, pre, format)` with a per-path `Mutex` map and the target held open without write sharing from the hash check to the rename (README 5.3), `create(path, text)` (fails if it exists), `mkdir`, `rename(from, to)` (fails if the target exists, case-only renames go through a temporary name), `trash(root, rel)` to `.hivemind/trash/<yyyymmdd-hhmmss>/<rel>`. Line endings: the text from the webview is LF; `save` converts to CRLF when `format.eol == "crlf"`, and the BOM is written back when `format.bom`. Mixed files are read-only with the reason "mixed line endings" until NS-6A adds the choice.
- `src-tauri/src/notebooks/mod.rs`: `Registry { path, lock }`, `Notebook { id, path, title, added }`, `list`, `add(picked, store_root)` with the README 5.4 refusals, `remove(id)`, `get(id)`, `tree(id) -> Vec<Entry { path, kind: dir|page|text|asset|other, size, mtime_ms }>` (walk with `std::fs::read_dir`, skip hidden folders, at most 20,000 entries and depth 12, `truncated` flag). Text extensions: md, markdown, txt, log, json, yaml, yml, toml, ini, cfg, conf, csv, tsv, xml, html, css, js, ts, tsx, jsx, py, rs, go, java, c, h, cpp, cs, ps1, sh, bat, sql, env (shown, never previewed); everything else is `other` and opens with the system app.
- `src-tauri/src/notebooks/sidecar.rs`: `read(nb) -> Value`, `write(nb, patch: Value)` merging top-level keys and keeping unknown ones, written with `atomic::replace`; a folder that refuses the write falls back to `app_data/notebook-meta/<id>.json`.
- `src-tauri/src/files/watch.rs`: a second debouncer (`notify-debouncer-mini`, 400 ms) watching every registered notebook root recursively, rebuilt when the registry changes. It maps paths to `(notebook id, rel)`, drops temp files, `.hivemind/trash`, `.git` and hidden folders, drops echoes (a path whose current sha256 equals the last hash Hivemind wrote, kept in a bounded map), and emits `files-changed { notebook, paths }`.
- Commands (all through `blocking`): `notebooks_list`, `notebook_add` (dialog), `notebook_remove(id)`, `notebook_tree(id)`, `notebook_meta_get(id)`, `notebook_meta_set(id, patch)`, `file_read(notebook, path)`, `file_save(notebook, path, text, pre, format)`, `file_create(notebook, path, text)`, `file_mkdir(notebook, path)`, `file_rename(notebook, from, to)`, `file_delete(notebook, path, pre)`. Every one resolves the notebook id through the registry and the path through `resolve_inside`; the webview never sends an absolute path.
- `drafts.rs`: refuse values over 32 MB (serialised size).

**Cargo tests:** containment cases above; the guard refuses the store, a folder holding it and a managed vault; atomic write leaves no temp on success or failure; save refuses a stale hash and a deleted file; a save while another handle has the file open for writing fails with "in use" and leaves the bytes alone; CRLF and BOM survive a save; a case-only rename; trash keeps the relative path; sidecar keeps unknown keys and falls back for a read-only folder; registry refusals (store root, inside store, nested notebooks, managed vault); tree hides dot-folders and caps entries; watcher path mapping and echo suppression (pure functions); draft size cap.

## 8. Exit criteria

- Register a scratch folder, create sections and pages, edit, split, save, close, reopen after a restart; kill the app with unsaved edits and recover them from the draft.
- Edit a page in Notepad while Hivemind has it open: a clean tab follows; a dirty tab offers Merge, and the merge saves.
- A CRLF file with a BOM keeps both after an edit (compare bytes outside the edit).
- `npm test`, `npx tsc --noEmit`, `npm run build`, `cargo test`, `cargo clippy` pass; `src/workspace/store.test.ts` unedited.
- `scripts/drive_ui.py`: the Notes flow above and the Memory regression pass (README section 4).

## 9. Shipped

Landed on 2026-11-20 (commit history of `docs/notes-studio/phase-1a-workspace.md` and `src/features/notes/`).

**Verified**
- `npm test` (81 files, 579 tests), `npx tsc --noEmit`, `npm run build`, `cargo test --lib`, `cargo clippy --all-targets` (one warning, in older workflow code at `lib.rs` `workflow::templates()`). `src/workspace/store.test.ts` is unedited.
- `cargo test`: `bridge::tests::a_script_that_fails_shows_its_stderr` fails about one run in eight on main as well; it is tracked as a separate bug.
- Real app, driven over CDP with a scratch notebook registered in app data and removed afterwards: tree with sections and subpages; open, edit, Ctrl+S; unsaved dots on the tab and on the Notes section; a CRLF file with a BOM keeps both and every byte outside the edit; a clean tab follows a Notepad edit with its banner; a dirty tab gets "changed on disk", Merge, and the merged page saves; after a restart, a draft whose file changed meanwhile came back merged as unsaved edits; `[[Plan]]` opens the page, `[[Missing page]]` offers Create; rename in the tree and a pointer drag into a section move the open tab with them; delete goes to `.hivemind/trash/<time>/<path>` and closes the tab; a `.txt` file opens in Source with line numbers; Ctrl+N makes `Untitled.md` beside the focused page; Ctrl+\ splits one document into two panes; Ctrl+W on a dirty page names the file; Ctrl+O lists pages and opens them on Notes from Memory. Memory regression: the library, a note from Ctrl+O, its rail (Connections, Source history, On this page) and Ctrl+E.

**Found by the UI pass:** the watcher emitted an array of changes per event while the webview expects one `{ notebook, paths }` object, so outside edits were never seen. `watch::watch` now calls back once per notebook, and a test pins the payload shape.

**Deviations**
- No `useDocument.ts` or `adapters/file.ts`: `src/documents/store.ts` holds the controller (open, edit, save, merge, reload, refresh, retarget, release, discard) and calls `src/lib/notebooks.ts` directly; `src/documents/sync.ts` keeps documents and tabs in step (unsaved dots, letting go of documents no tab shows, routing `files-changed`). A rename pauses that sync while documents and tabs move together.
- `MergeDialog` gained `noun: "note" | "page"` and a `PageMergeDialog` wrapper instead of a `fields={false}` prop.
- Saves use `files::atomic::Held` (round 2 of the design review): the file is held without write or delete sharing, renamed aside through its handle, and the new file moved in without replacing.
- `NoteEditor.tsx` already wrote its draft on unmount; only `NewNote.tsx` changed (it now does too, unless the note was saved).
- Not done here: an Attachments heading in the tree (the attachments folder shows as an ordinary section until NS-1B shows images), and drag to reorder within a folder (drag moves between folders; an order in the sidecar is honoured).


**Code review.** Codex reviewed `32fd236` and reported 28 findings; Claude added two. All 30 are fixed in the next commit, with the verdicts, fixes and regression tests in `docs/notes-studio/reviews/ns1a-codex-review.md`. What changed in the contract:
- A save refuses to replace bytes that are not editable text, keeps the file's NTFS named streams, and a page an interrupted save left aside is put back when it is read, saved or listed.
- Renames and moves never replace a destination; trash holds a checked file from the hash to the move.
- Hivemind's own data folders are protected places, every file command checks hidden names after links resolve, and marked vaults inside a notebook are hidden and cannot be moved.
- The document store shares one load per document, saves a merge against the version the dialog showed, writes drafts in order, and holds saves and drafts while a move runs. Draft sizes are UTF-8 bytes, failed draft writes show a banner, and both quit paths write pending drafts first.
- File tabs pass `follow` to `CodeEditor`, so two panes of one page stay in step.

A second Codex pass over the fix commit (`c496e1c`) reported 19 more findings, also in the review record. What its fixes changed: every document session has a generation number, and late reads and saves apply only to their own session; moves hold pages by path and let a closed tab's page go only after the move; quitting writes drafts until each unsaved page's text is stored; a delete closes the page's tabs first; temp names carry a hash of the whole file name; the sidecar fallback records which notebook copy it replaced.

A third and last pass over `b82e9ab` found eight more high-severity cases, all fixed: deletes hold their pages like moves, pages opened during a move or delete load when it ends, the window close flushes drafts whenever any are pending, a failed draft write is never served from the cache, a link anywhere on a notebook's registered path is refused, aside names hash the exact spelling, and the sidecar fallback keeps its base hash inside its own JSON.

Checks after the first fixes: `npm test` (81 files, 590 tests), `npx tsc --noEmit`, `npm run build`, `cargo test` (527), `cargo clippy --all-targets` (the same older warning). The real app, over CDP: two panes typing into one page and saving both lines; Ctrl+S in Reading mode; renaming the section `Release.2026` to `Archive`; the delete dialog naming unsaved edits; a click on `run.cmd` refused; a Memory note opened with Ctrl+O on Notes with no notebooks.
