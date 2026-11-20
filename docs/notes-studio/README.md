# Notes Studio: shared decisions and contracts

Notes Studio (roadmap item NOTES-1) adds notebooks to Hivemind: a Notes page with folder notebooks and Living Memory notebooks, rich Markdown and `.hmdoc` pages, Notepad++-style editing of any file, search with semantic matching, history, notebook features (daily notes, tasks, queries, canvases), AI actions and agent sessions, and import and export. It is built in 23 phases, NS-0 to NS-9B, across this repository and `agentic-living-memory`.

**How to use these documents.** Read this file first, then your phase's document. This file holds what every phase shares: decisions, architecture, contracts, conventions and how to verify. Where a phase document and this file disagree about a shared name or shape, this file wins; report the conflict. Documents cite files by path plus an anchor string, not line numbers. If an anchor is gone, find its successor before changing anything, and say so in your report. The general conventions in [../plans/README.md](../plans/README.md) sections 4 to 6 still apply, except where section 4 below changes them.

## 1. Decisions (the user, 2026-11-20; do not reopen)

| Topic | Decision |
| --- | --- |
| Notebook kinds | **Folder notebook**: any folder the user picks, including an Obsidian vault; plain files are the only source of truth. **Living Memory notebook**: inside any Living Memory domain, or in a notebook-only domain with no folder binding |
| Workspace | One shared tab and pane workspace (up to 3 panes) for the Memory page and the Notes page. The library and the notebook tree are two navigators over the same open documents. This supersedes decision 2 of `../plans/README.md` ("only notes are tabs") |
| Any file | Open any file: open dialog, drag and drop, recent files, Windows file association and "Open with Hivemind", which opens the file in the running instance |
| Folder metadata | Sidecar `.hivemind/notebook.json` inside the notebook, written only when the user changes order, icons, pins or settings |
| History | A snapshot of every save in Hivemind's app data (100 versions or 90 days per page, pinned versions kept), plus the git timeline and a Commit button for notebooks in a git repository. Living Memory pages use Living Memory's journal |
| Living Memory storage | A separate record kind, not notes: `domains/D/notebooks/<nb>/...`, pages stored byte for byte, its own `doc` commands, journal, undo, backup, Obsidian sync and an attachment store. Review, staleness, maintenance, SessionStart and the wiki never see pages |
| Agent reach | Per notebook, for both kinds: **hidden**, **searchable** (the default: agents' `alm search` and `alm ask` return its paragraphs) or **injectable** (Living Memory adds labelled excerpts to prompts, after notes) |
| Agent writes | Agents outside Notes Studio may only stage page edits (`alm doc propose`); the user accepts or rejects them in Hivemind |
| Privacy | AI is on by default. **Private** blocks every Hivemind AI feature for the notebook and every Living Memory search and injection path. It is not file protection: an agent whose working folder contains the notebook can read it with its own tools |
| Rich Markdown | Both a much richer CodeMirror live preview (images, tables, callouts, Mermaid, math, embeds, code, footnotes, links, toolbar, slash menu) and a WYSIWYG mode on Tiptap whose serializer keeps untouched blocks byte-identical |
| `.hmdoc` | A rich JSON page format for folder notebooks only: power tables, layout and styling, typed live embeds (never iframes), Excalidraw, freehand ink, free-positioned blocks |
| Power editing | Encodings and line endings kept and convertible; multi-cursor, rectangular selection, line tools, recordable macros; large files (view, search, tail, hex; never editable above about 64 MB); compare any two files; find and replace in files |
| Notebook features | Daily notes and templates; a target switch in Quick capture (Memory note, Today's page, notebook Inbox); a Tasks view across notebooks and Living Memory action items; typed properties and saved queries; JSON Canvas boards |
| Search | A derived SQLite FTS5 index in app data (rusqlite, bundled), rebuildable from files, plus semantic search that reads Living Memory's installed model2vec model in Rust. Living Memory pages are searched through Living Memory. Results are grouped by origin; scores from different origins are never compared |
| Links | Obsidian style `[[Page]]`, resolved in the same notebook, then other notebooks, then memory notes. An ambiguous link gets a picker that writes `[[Notebook/Page]]` or `[[mem:Title]]` |
| AI | Selection and page actions with a diff to accept, edit or reject; Ask a notebook with citations; a background suggestions rail; Save to memory through Executive Capture with links both ways |
| Agent sessions | On folder notebooks only: the agent works in a staged copy tracked by a hidden git repository; the Review page shows its diff; "Apply to notebook" writes the files the user accepts, merging and snapshotting first |
| AI engine and budget | Claude (`oneshot.rs`) or Codex (`codex exec --output-schema`), chosen per action kind, default Claude. `notes_daily_usd` defaults to 2 USD with per-action caps; background suggestions stop at 25% of the day's cap |
| Interop | Obsidian vaults as notebooks; import Evernote ENEX, Notion export zips and OneNote desktop exports (`.mht`, `.docx`); export PDF, DOCX and HTML; paste conversion from browsers and Word. No web clipper |
| Order | Foundation and Living Memory notebooks, then rich editing, search and links, history, power editing, notebook features, AI, interop |
| Delivery | This folder first. Then each phase straight to main: commit, a read-only Codex review of the new commits, fixes in their own commit with regression tests, push |
| Platforms | Windows 11 only; keep code portable and report macOS and Linux as untested |

## 2. Not in scope for any phase

- A Hivemind database of record. The SQLite index is derived and can be deleted at any time.
- Sync, accounts, sharing, multi-user editing, a plugin API, Office or OneNote fidelity, a browser extension or web clipper.
- Writing Living Memory store files directly. Every Living Memory change goes through Living Memory commands.
- Editing files over about 64 MB, or binary files.
- Microsoft Graph or any other cloud import.

## 3. Architecture

The diagram shows who owns what and the only paths that write.

```mermaid
flowchart LR
  UI[Webview: Notes page, Memory page, shared workspace] -->|notebook_*, file_* commands| RS[Rust: files, notebooks, index, history, AI]
  UI -->|GET images and PDFs| HM[hmfile scheme handler]
  RS -->|atomic save with hash precondition| FS[(Folder notebooks and opened files)]
  HM -->|grant and containment checks| FS
  RS -->|serve --stdio bridge| LM[Living Memory]
  LM --> DOCS[(domains/D/notebooks)]
  LM -->|sources, visibility from the sidecar| FS
  RS --> IDX[(app data: index, history, drafts)]
  Agents[Claude and Codex CLIs] -->|search, ask, doc propose| LM
```

Principles:
- Living Memory is the only writer of its store. Hivemind never writes under the store root.
- The webview never touches the disk. Every file access is a Rust command that checks a registered notebook or a grant, or the `hmfile` scheme handler.
- Files are the source of truth. Anything Hivemind derives (index, snapshots, drafts) can be rebuilt or dropped without losing a page.
- AI and agent output is a proposal, applied only if the page still has the hash or revision captured with it.

## 4. Conventions that differ from `../plans/README.md`

- **Git:** work on `main`. Per phase: commit (each commit builds and passes tests), run a read-only Codex review of the new commits, fix what holds in its own commit with regression tests, then push. Record the shipped commits in the phase document's "Shipped" section.
- **Gates:** every phase that depends on a Living Memory feature checks it through `src/lib/connection.ts` (a `version` capability or a command name), so an older Living Memory still runs the app.
- **Memory must not change.** `src/workspace/store.test.ts` passes without edits in every phase, and each phase ends with a `scripts/drive_ui.py` pass over the Memory library: open a note, edit, save, force a merge, split, open the rail.
- **Lazy chunks:** every large editor dependency (Tiptap, KaTeX, pdf.js, Excalidraw, mammoth, docx) is loaded with a dynamic `import()`, as `src/ui/Mermaid.tsx` loads mermaid.
- **Colours:** a new colour token needs a value in all three theme blocks of `src/App.css`, and `src/lib/theme.test.ts` must pass.
- **Dependencies:** only MIT, Apache, BSD, ISC or MPL compatible licences. No Tiptap Pro package, and never `@tiptap/extension-unique-id` (it rewrites every node, which breaks the untouched-block check). `jszip` is avoided for its GPL option; `fflate` replaces it if needed. Living Memory stays standard-library only. Each phase adds only the dependencies in its row:

| Phase | New dependencies | Measured or estimated cost |
| --- | --- | --- |
| 1B | `encoding_rs`, `chardetng` | Licences checked in S7; about 0.3 to 0.5 MB exe (estimate) |
| 3A | `katex` | Lazy; about 0.6 MB with fonts (estimate) |
| 3B | `@tiptap/core`, `pm`, `react`, `starter-kit`, `extension-table`, `extension-list`, `extension-image`, `extension-highlight`, `extension-text-style`, `extension-placeholder`, `extension-drag-handle`; `unified`, `remark-parse`, `remark-gfm`, `remark-frontmatter`, `remark-math`, `mdast-util-to-markdown` | Lazy; 193 KB gzipped measured in S3 |
| 3D | `pdfjs-dist`, `@excalidraw/excalidraw`, `perfect-freehand` | Lazy; several MB (estimate) |
| 4A | `rusqlite` with `bundled` | About 1.7 MB exe and a 22 s clean build, measured in S4 |
| 4B | `unicode-normalization`, `unicode-general-category` | Measured in S5 |
| 5, 6B | `flate2` (already transitive), `ignore` | About 0.2 MB (estimate) |
| 7B | `yaml` | About 100 KB (estimate) |
| 9A | `dompurify`, `turndown`, `turndown-plugin-gfm`, `docx`, `webview2-com` pinned to the version Tauri resolves | Lazy |
| 9B | `mammoth`, `zip`, `quick-xml` (transitive) | Lazy; about 0.3 MB exe (estimate) |

## 5. Contracts between phases

A phase may add fields and commands. It may not rename or reshape what is listed here.

### 5.1 Documents and tabs (NS-1A)

```ts
// src/workspace/store.ts
export type TabKind = "note" | "new-note" | "file" | "new-file" | "doc";
export interface FileRef { notebook: string; path: string }   // a page in a folder notebook; path relative, forward slashes
export interface GrantRef { grant: string }                    // a loose file opened from disk (NS-1B)
export interface DocRef { domain: string; notebook: string; path: string }  // a Living Memory page (NS-2C)
// Tab gains: file?: FileRef | GrantRef; doc?: DocRef
```

- `docKey(tab)` (pure, `src/documents/keys.ts`): `note:<ref>`, `file:<notebook>:<lowercased path>`, `grant:<grant>`, `doc:<domain>:<notebook>:<lowercased path>`. `sameTab` compares kind family and `docKey`; note behaviour is unchanged.
- A file the user opens from disk that lies inside a registered notebook becomes a `FileRef`, never a `GrantRef`, so one file has one key.
- `showTab(tab)` replaces `showNotes()`: if the current route already shows the workspace (Notes, or Memory with view `notes`), stay; otherwise note kinds go to Memory exactly as today and file and doc kinds go to Notes.
- Persistence: `hivemind.workspace` version 3. Version 1 migrates through `notesOnly` as today; version 2 is kept; tabs of unknown kinds are dropped on load; `new-note` and `new-file` tabs are not persisted. A build that only knows version 2 runs `notesOnly` on version 3 data and keeps the notes.

### 5.2 Document session controller (NS-1A)

`src/documents/session.ts` is a pure state machine per `docKey`: `loading`, `clean`, `dirty`, `saving`, `stale` (text merge), `conflict` (keep mine, keep theirs, save both), `readOnly(reason)`, `error`. `src/documents/useDocument.ts` binds it to React; two tabs on one document share one session and one dirty flag. Adapters:

| Adapter | Read | Save precondition | On a stale save |
| --- | --- | --- | --- |
| `file` (folder pages, loose files) | `file_read` | `{ sha256, size, mtimeMs }` of the bytes loaded | Text: `mergeBody` from `src/features/editor/merge.ts`. `.hmdoc`, `.canvas`: keep mine, keep theirs, save both |
| `lmdoc` (Living Memory pages, NS-2C) | `doc read` | `{ revision }` (sha256 of the page bytes) | Same text merge, then `doc write --expected-revision <theirs>` |

Memory notes keep their own path (`NoteEditor.tsx`, `save.ts`, `MergeDialog.tsx`) and do not use the controller.

Drafts: keys `file-<sha256(docKey)>` and `doc-<sha256(docKey)>` (hashed, so paths never collide or overflow the 200-character key limit of `drafts.rs`). A file draft stores `{ key, kind, target, precondition, base?, mine, format, savedAt }`; `base` is left out above 2 MB. A note draft keeps today's shape (no `kind`). `drafts.rs` gains a 32 MB cap. Autosave of drafts waits 1 s under 256 KB and 5 s above, and stops above 16 MB with a banner.

### 5.3 File service (NS-1A, encodings in NS-1B)

- One containment helper, `resolve_inside(root, rel)` in `src-tauri/src/files/contain.rs`: every component `Component::Normal`, no `:` (alternate data streams), no Windows device names (`CON`, `NUL`, `COM1`...), no trailing dot or space; the canonical result must start with the canonical root. For a write, canonicalise the parent and refuse a target that is a reparse point. It replaces the ad hoc checks pattern of `archsuite.rs` (`fn inside`) and `review.rs` (`fn canonical`) for new code; those files are not changed.
- Reads: refuse above 64 MB (larger files go to the large-file viewer in NS-6B); NUL in the first 8000 bytes means binary. Return `{ text, sha256, size, mtimeMs, format: { encoding, bom, eol }, readOnly?: reason }`.
- Saves: lock per path; re-hash the file on disk; refuse with `Stale { sha256 }` if it differs from the precondition; write a hidden temp file beside the target (`.<name>.hm-<uuid>.tmp`), `sync_all`, rename over the target. Loose files outside notebooks use `ReplaceFileW` so the file keeps its ACLs and attributes. A read-only file is refused and "Save as" is offered. Encoding, BOM and line endings come back in `format` and are applied on save (NS-1B). The temp-file pattern is ignored by the watcher and the indexer.
- Echo suppression: the watcher drops an event whose file now hashes to the last hash Hivemind wrote there.
- Delete moves to `.hivemind/trash/<timestamp>/<path>` inside the notebook; loose files go to the Windows Recycle Bin.

### 5.4 Notebooks (NS-1A)

- Registry: `app_data/notebooks.json`, `{ "version": 1, "notebooks": [{ "id": "nb-<8 hex>", "path": "<plain absolute>", "title": "...", "added": "<iso>" }] }`. Only the native folder dialog adds an entry (the `folders.rs folder_pick` pattern). It is not part of `settings.json`, so `save_settings` cannot change it. Living Memory notebooks are not registered here; Hivemind lists them from Living Memory (NS-2C).
- Refusals at registration: the Living Memory store root or anything inside it; the folder of an Obsidian vault that Living Memory manages (its `sync-state.json` names the vault); a folder inside or containing an already registered notebook.
- Sidecar `.hivemind/notebook.json` (version 1). Unknown keys are kept on write. Read-only folders keep the same JSON in `app_data/notebook-meta/<id>.json`.

```json
{
  "version": 1,
  "order": { "": ["Inbox.md", "Projects"], "Projects": ["Roadmap.md"] },
  "icons": { "Projects": "folder-kanban" },
  "pinned": ["Inbox.md"],
  "visibility": "searchable",
  "private": false,
  "attachments": "assets",
  "templates": "Templates",
  "daily": { "folder": "Daily", "format": "YYYY-MM-DD", "template": null },
  "inbox": "Inbox.md",
  "ai": { "engine": {} }
}
```

- Tree rules: subfolders are sections; a page `X.md` with a sibling folder `X/` holds subpages; `.hivemind`, `.git`, `.obsidian`, `node_modules` and dot-folders are hidden; the attachments folder shows under its own heading. Order not listed in `order` is alphabetical, folders first.
- Hivemind never writes inside `.obsidian`.

### 5.5 The `hmfile` scheme (NS-1B)

`src-tauri/src/assets.rs` registers an asynchronous URI scheme `hmfile`, served on Windows as `http://hmfile.localhost/<grant>/<percent-encoded relative path>`. A grant is an opaque id Rust creates for a folder notebook root, a Living Memory notebook's `assets` folder, or the folder of an opened loose file. The handler is the only gate (capabilities do not cover scheme handlers): webview label `main`, GET or HEAD, known grant, `resolve_inside`, not under `.git` or `.obsidian`, extension in png, jpg, jpeg, gif, webp, avif, bmp, ico, svg, pdf, size cap 50 MB. It answers Range requests (pdf.js), sets `Content-Type` from the extension, `X-Content-Type-Options: nosniff` and an ETag; SVG also gets `Content-Security-Policy: default-src 'none'` and is only shown through `<img>`. The CSP in `tauri.conf.json` gains `http://hmfile.localhost` in `img-src` and `connect-src`, and `worker-src 'self'`.

### 5.6 Opening files from outside (NS-1B)

`instance.rs` protocol version 2: the knock is the token, a newline, then JSON `{ "v": 1, "open": ["<absolute path>"], "cwd": "<dir>" }`, at most 64 KiB. A token-only knock still only raises the window, so old and new builds interoperate. Paths go to an `OpenQueue` in `AppState`; the frontend pulls them with `open_pending()` on mount and when the `open-requested` event fires. Every opened or dropped path becomes a grant in `src-tauri/src/opens.rs` (`app_data/open-files.json`, the 200 most recent). A grant id is the first 16 hex characters of the sha256 of the normalised path, so reopening a file gives the same key. `tauri.conf.json` associates `.md`, `.markdown`, `.hmdoc` and `.canvas`; an NSIS installer hook registers "Open with" for any file with `MultiSelectModel=Player`.

### 5.7 Tauri commands and events

Names are fixed here; signatures are set by the phase that adds them.

| Phase | Commands | Events |
| --- | --- | --- |
| NS-1A | `notebooks_list`, `notebook_add`, `notebook_remove`, `notebook_tree`, `notebook_meta_get`, `notebook_meta_set`, `file_read`, `file_save`, `file_create`, `file_mkdir`, `file_rename`, `file_delete` | `files-changed { notebook, paths }` |
| NS-1B | `open_dialog`, `open_pending`, `open_recent`, `open_forget` | `open-requested` |
| NS-2C | (Living Memory `doc` commands go through `lm`) | `docs-changed { domain, notebook }` |
| NS-4A | `index_search`, `index_links`, `index_status`, `index_rebuild` | `index-progress` |
| NS-5 | `history_list`, `history_read`, `history_pin`, `git_file_log`, `git_file_commit` | |
| NS-6B | `bigfile_open`, `bigfile_lines`, `bigfile_search`, `bigfile_bytes`, `bigfile_close`, `replace_preview`, `replace_apply` | `bigfile-progress`, `bigfile-grew` |
| NS-8A | `notes_ai_run`, `notes_ai_cancel`, `notes_ai_status` | `notes-ai-changed` |

### 5.8 Living Memory pages (NS-2A, NS-2B)

The full contract is in `agentic-living-memory/docs/notebooks-design.md`. What Hivemind relies on:
- `doc` commands with JSON output; a page's revision is the sha256 of its bytes; `doc write --expected-revision R` fails with code `stale` (exit 6) like `update`.
- `version` reports `capabilities.docs = { version, max_page_bytes, max_asset_bytes }`; Hivemind gates on it (`useDocsEnabled`).
- `domains` reports `kind: "notebook"` for notebook-only domains; Memory's domain pickers skip them.
- `search` and `ask` return pages in a separate `pages` array; `results` is unchanged.

### 5.9 AI settings and ledger (NS-8A)

`settings.rs` gains `notes_daily_usd` (default 2.0), `notes_call_usd` (per action, clamped by `per_call`) and `notes_engine` (per action, `claude` or `codex`, default `claude`). Notes AI uses its own ledger `app_data/notes-spend.json` (the `learning.rs Ledger` with a label). Background suggestions reserve only while the day's spend is under 25% of the cap.

### 5.10 Shortcuts

Taken today: Ctrl+P, Ctrl+O (Shift ignored), Ctrl+N, Ctrl+G, Ctrl+Shift+A, Ctrl+W, Ctrl+K and Ctrl+Shift+F (Topbar search), Ctrl+Tab, Ctrl+\, Ctrl+E, Ctrl+S, Ctrl+Shift+C on the Executive page. Notes Studio adds no new global chord in NS-1A to NS-1B: Ctrl+N makes a new page when the Notes page is showing and a new note elsewhere; Ctrl+O lists pages and recent files beside notes and offers "Open file from disk"; Ctrl+K and Ctrl+Shift+F search pages on the Notes page. Editor-local keys (multi-cursor, macros, toolbar) are bound inside CodeMirror or Tiptap and listed in each phase document.

## 6. Phases

| Phase | Repo | Document | Depends on |
| --- | --- | --- | --- |
| NS-0 Design docs and spikes | both | [phase-0-spikes.md](phase-0-spikes.md), `agentic-living-memory/docs/notebooks-design.md` | |
| NS-1A Shared workspace, Notes page, folder notebooks | Hivemind | [phase-1a-workspace.md](phase-1a-workspace.md) | NS-0 |
| NS-1B Open any file | Hivemind | [phase-1b-open-any-file.md](phase-1b-open-any-file.md) | NS-1A |
| NS-2A Living Memory doc records | Living Memory | `agentic-living-memory/docs/notebooks-design.md` | NS-0 |
| NS-2B Page search, agent reach, sync | Living Memory | `agentic-living-memory/docs/notebooks-design.md` | NS-2A |
| NS-2C Living Memory notebooks in Hivemind | Hivemind | [phase-2c-lm-notebooks.md](phase-2c-lm-notebooks.md) | NS-1A, NS-2A (NS-2B for the reach settings) |
| NS-3A Rich live preview | Hivemind | [phase-3a-live-preview.md](phase-3a-live-preview.md) | NS-1B |
| NS-3B WYSIWYG mode | Hivemind | [phase-3b-wysiwyg.md](phase-3b-wysiwyg.md) | NS-3A |
| NS-3C `.hmdoc` core | Hivemind | [phase-3c-hmdoc.md](phase-3c-hmdoc.md) | NS-3B |
| NS-3D `.hmdoc` embeds and drawing | Hivemind | [phase-3d-embeds-drawing.md](phase-3d-embeds-drawing.md) | NS-3C |
| NS-4A Index, links, search | Hivemind | [phase-4a-index-search.md](phase-4a-index-search.md) | NS-3C |
| NS-4B Semantic search | Hivemind | [phase-4b-semantic.md](phase-4b-semantic.md) | NS-4A |
| NS-5 History | Hivemind | [phase-5-history.md](phase-5-history.md) | NS-1A |
| NS-6A Power editing | Hivemind | [phase-6a-power-editing.md](phase-6a-power-editing.md) | NS-1B |
| NS-6B Large files, replace in files | Hivemind | [phase-6b-large-files-replace.md](phase-6b-large-files-replace.md) | NS-5 |
| NS-7A Daily notes, templates, capture | Hivemind | [phase-7a-daily-capture.md](phase-7a-daily-capture.md) | NS-2C |
| NS-7B Tasks, properties, queries | Hivemind | [phase-7b-tasks-queries.md](phase-7b-tasks-queries.md) | NS-4A |
| NS-7C Canvas boards | Hivemind | [phase-7c-canvas.md](phase-7c-canvas.md) | NS-4A |
| NS-8A AI engine and actions | Hivemind | [phase-8a-ai-actions.md](phase-8a-ai-actions.md) | NS-5 |
| NS-8B Ask, suggestions, save to memory | Hivemind | [phase-8b-ask-suggest-memory.md](phase-8b-ask-suggest-memory.md) | NS-4B, NS-8A |
| NS-8C Agent sessions on notebooks | Hivemind | [phase-8c-agent-sessions.md](phase-8c-agent-sessions.md) | NS-5 |
| NS-9A Obsidian vaults, paste, export | Hivemind | [phase-9a-obsidian-export.md](phase-9a-obsidian-export.md) | NS-3D |
| NS-9B Importers | Hivemind | [phase-9b-importers.md](phase-9b-importers.md) | NS-9A |

Three items run earlier than the user's order because later work needs them: a minimal link resolver (NS-1A), encoding preservation (NS-1B, needed to save opened files safely), and the `.obsidian` and Living Memory vault protections (NS-1A).

## 7. Running and verifying

Use `../plans/README.md` section 6 (demo store, environment variables, `scripts/drive_ui.py`). In addition:
- Close any running Hivemind before `npm run tauri dev`: every build shares the identifier `dev.hivemind.app` and the single-instance lock makes a second copy exit.
- Use a scratch folder notebook for UI checks, never one of the user's folders. A dev run still writes drafts, snapshots and the index under the real `%APPDATA%\dev.hivemind.app`; remove what the test created.
- File association checks need an installed build (`npm run tauri build`, then the NSIS installer); `tauri dev` cannot test them.
- Live tests that start a model (`HIVEMIND_TEST_CLAUDE`, Codex) cost money and need the user's approval first.

## 8. What every phase reports

- What was built, what was verified in the running app, and what was not.
- Anything in its document that turned out wrong, and what was done instead (and update the document).
- Side effects outside the repository (files left in app data, a Living Memory install).
- What was recorded in Living Memory, and the roadmap item ticked (`NS-<phase>`).
