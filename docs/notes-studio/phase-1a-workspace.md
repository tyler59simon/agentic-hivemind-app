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
- `store.ts`: a zustand store `useDocuments` keyed by `docKey`, holding `DocState` and a reference count of open tabs. The dirty flag in `useWorkspace.dirty` is set for every tab showing a dirty document.
- `useDocument.ts`: `useDocument(tab)` loads through the adapter, wires autosave of drafts (README 5.2 timings), `save()`, `merge(result)`, `reload()`. On unmount of the last tab, a dirty document keeps its draft.
- `adapters/file.ts`: `read(ref)`, `save(ref, text, precondition, format)`, mapping Rust errors to `Stale`, `ReadOnly`, `Gone`.
- Merge: reuse `mergeBody` and `hasConflictMarkers` from `src/features/editor/merge.ts`. Add a body-only mode to `MergeDialog.tsx` (prop `fields={false}`) rather than a second dialog; notes keep calling it as today.
- Drafts: `src/lib/drafts.ts` `Draft` becomes `NoteDraft | FileDraft` with a type guard `isFileDraft(d) => d.kind === "file"`; keys `file-<sha256 hex of docKey>` via `crypto.subtle.digest`. On load, a draft whose precondition hash equals the file's hash restores silently with a banner; otherwise the draft text is merged against the current file (base kept in the draft) or offered as "Your unsaved version" in the merge dialog.

**Tests (`src/documents/session.test.ts`, `keys.test.ts`, `src/lib/drafts.test.ts`):** every reducer transition; outside change clean versus dirty; stale save opens merge; draft restore with same and different hashes; key hashing is stable and distinct for `a_b` and `a/b`.

## 4. Editor (`src/features/editor/`)

- New `CodeEditor.tsx`: props `{ doc, docVersion, language: "markdown" | "text", live, readOnly, lineNumbers, onChange, onSave, titles, onOpenLink, reveal, placeholder }`. Its extension list for `language: "markdown"` is produced by a pure `markdownExtensions(opts)` that returns today's list in today's order; `text` uses a plain language with `lineNumbers()` and `highlightActiveLine()`. Read-only and line numbers are Compartments.
- `MarkdownEditor.tsx` keeps `EditorProps` exactly and renders `CodeEditor` with `language: "markdown"`, `lineNumbers: false`, `readOnly: false` and the current placeholder. `NoteEditor.tsx` and `NewNote.tsx` do not change.
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

- `src-tauri/src/files/contain.rs`: `pub fn check_rel(rel: &str) -> Result<Vec<String>, String>` (forward-slash relative path; every part non-empty, not `.` or `..`, no `:`, no `\\`, no device name, no trailing dot or space, at most 240 characters per part) and `pub fn resolve_inside(root: &Path, rel: &str, for_write: bool) -> Result<PathBuf, String>`. Tests: `..`, absolute, `C:x`, `\\server\share`, `a.md:ads`, `CON`, `con.txt`, trailing dot, a junction that escapes (create with `mklink /J` through `cmd`, skipped if it cannot be created), a symlinked parent on write.
- `src-tauri/src/files/atomic.rs`: `pub fn replace(path: &Path, bytes: &[u8]) -> Result<(), String>`: temp `.<name>.hm-<uuid>.tmp` in the same folder, write, `sync_all`, rename, remove the temp on failure. `pub fn is_temp(name: &str) -> bool`.
- `src-tauri/src/files/mod.rs`: `FileFormat { encoding: "utf-8", bom: bool, eol: "lf" | "crlf" | "mixed" | "none" }` (NS-1B widens it), `Loaded { text, sha256, size, mtime_ms, format, read_only: Option<String> }`, `Precondition { sha256, size, mtime_ms }`, `SaveOutcome::{Saved(Loaded-like stamp), Stale { sha256 }, Gone}`. Functions: `read(path)` (64 MB cap, NUL sniff, UTF-8 with or without BOM; other bytes give `read_only: "not UTF-8"` and lossless display deferred to NS-1B), `save(path, text, pre, format)` with a per-path `Mutex` map, `create(path, text)` (fails if it exists), `mkdir`, `rename(from, to)` (fails if the target exists, case-only renames go through a temporary name), `trash(root, rel)` to `.hivemind/trash/<yyyymmdd-hhmmss>/<rel>`. Line endings: the text from the webview is LF; `save` converts to CRLF when `format.eol == "crlf"`, and the BOM is written back when `format.bom`. Mixed files are read-only with the reason "mixed line endings" until NS-6A adds the choice.
- `src-tauri/src/notebooks/mod.rs`: `Registry { path, lock }`, `Notebook { id, path, title, added }`, `list`, `add(picked, store_root)` with the README 5.4 refusals, `remove(id)`, `get(id)`, `tree(id) -> Vec<Entry { path, kind: dir|page|text|asset|other, size, mtime_ms }>` (walk with `std::fs::read_dir`, skip hidden folders, at most 20,000 entries and depth 12, `truncated` flag). Text extensions: md, markdown, txt, log, json, yaml, yml, toml, ini, cfg, conf, csv, tsv, xml, html, css, js, ts, tsx, jsx, py, rs, go, java, c, h, cpp, cs, ps1, sh, bat, sql, env (shown, never previewed); everything else is `other` and opens with the system app.
- `src-tauri/src/notebooks/sidecar.rs`: `read(nb) -> Value`, `write(nb, patch: Value)` merging top-level keys and keeping unknown ones, written with `atomic::replace`; a folder that refuses the write falls back to `app_data/notebook-meta/<id>.json`.
- `src-tauri/src/files/watch.rs`: a second debouncer (`notify-debouncer-mini`, 400 ms) watching every registered notebook root recursively, rebuilt when the registry changes. It maps paths to `(notebook id, rel)`, drops temp files, `.hivemind/trash`, `.git` and hidden folders, drops echoes (a path whose current sha256 equals the last hash Hivemind wrote, kept in a bounded map), and emits `files-changed { notebook, paths }`.
- Commands (all through `blocking`): `notebooks_list`, `notebook_add` (dialog), `notebook_remove(id)`, `notebook_tree(id)`, `notebook_meta_get(id)`, `notebook_meta_set(id, patch)`, `file_read(notebook, path)`, `file_save(notebook, path, text, pre, format)`, `file_create(notebook, path, text)`, `file_mkdir(notebook, path)`, `file_rename(notebook, from, to)`, `file_delete(notebook, path, pre)`. Every one resolves the notebook id through the registry and the path through `resolve_inside`; the webview never sends an absolute path.
- `drafts.rs`: refuse values over 32 MB (serialised size).

**Cargo tests:** containment cases above; atomic write leaves no temp on success or failure; save refuses a stale hash and a deleted file; CRLF and BOM survive a save; a case-only rename; trash keeps the relative path; sidecar keeps unknown keys and falls back for a read-only folder; registry refusals (store root, inside store, nested notebooks, managed vault); tree hides dot-folders and caps entries; watcher path mapping and echo suppression (pure functions); draft size cap.

## 8. Exit criteria

- Register a scratch folder, create sections and pages, edit, split, save, close, reopen after a restart; kill the app with unsaved edits and recover them from the draft.
- Edit a page in Notepad while Hivemind has it open: a clean tab follows; a dirty tab offers Merge, and the merge saves.
- A CRLF file with a BOM keeps both after an edit (compare bytes outside the edit).
- `npm test`, `npx tsc --noEmit`, `npm run build`, `cargo test`, `cargo clippy` pass; `src/workspace/store.test.ts` unedited.
- `scripts/drive_ui.py`: the Notes flow above and the Memory regression pass (README section 4).

## 9. Shipped

(Filled in when the phase lands: commits, what was verified, deviations.)
