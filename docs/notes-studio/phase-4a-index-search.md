# NS-4A: index, links, backlinks and search

Read [README.md](README.md) and the S4 spike verdict first. This phase adds Hivemind's own derived index for folder notebooks and opened files, the full link resolver across notebooks and memory, backlinks, tags and one search box over every origin.

## 1. What the user sees

- On the Notes page, Ctrl+K and Ctrl+Shift+F focus a search box over pages. Results are grouped: **This notebook**, **Other notebooks**, **Living Memory pages**, **Memory notes**. Filters: notebook, folder, tag, file kind, modified date. Snippets highlight matches; Enter opens, Ctrl+Enter opens in a split.
- Ctrl+O lists pages from every notebook with their notebook as detail.
- The page rail gains **Backlinks** (linked and unlinked mentions) and **Outgoing links** (with missing targets offering Create page). A **Tags** pane lists `#tags` and frontmatter `tags`.
- `[[Page]]` resolves in the same notebook, then other notebooks, then memory notes. An ambiguous link shows a picker; choosing writes an explicit `[[Notebook/Page]]` or `[[mem:Title]]`.
- Renaming or moving a page offers to update links in every page that points to it, listing them first.
- A status line shows indexing progress; **Rebuild index** is in notebook settings.

## 2. Design

- `rusqlite` with `bundled` (FTS5 confirmed by spike S4). Database `app_data/notes-index/index.sqlite3`, WAL, `PRAGMA user_version` as the schema version; a mismatch drops and rebuilds. The index is derived: deleting it loses nothing.
- Tables: `pages(id, notebook, path, kind, title, sha256, size, mtime_ms, indexed_at)`, `fts(title, headings, body, tags)` with `tokenize='porter unicode61'` (as Living Memory's `notes_fts`), `blocks(page, anchor, start, end, text)` (paragraph-level anchors used for citations in NS-8B), `links(page, target_raw, target_kind, target_ref, line)`, `tags(page, tag)`, `tasks(page, line, done, text, due)`, `props(page, key, value, type)`, later `vectors` (NS-4B).
- Extractors in Rust (`notes_index/extract.rs`): Markdown (title from the first heading or file name, headings, body without markup, wiki and Markdown links, tags, tasks with Obsidian Tasks dates, frontmatter subset), `.hmdoc` (the twin of the TypeScript extractor, shared fixtures), `.canvas` (text node content and file references), plain text (body only, capped at 2 MB per file).
- One writer thread fed by the notebook watcher (`files-changed`), plus a full scan at startup comparing `size` and `mtime_ms`, re-hashing on difference. Opening a page checks its hash against the index and re-indexes it lazily.
- Living Memory pages are searched with `alm search` (`pages` array) and memory notes with the existing `search`; the frontend merges groups, never scores.
- Link rewrite on rename: a plan built from `links` (each affected page with its precondition hash), applied page by page through `file_save`; a page that changed meanwhile is skipped and listed.

## 3. Files

`src-tauri/src/notes_index/{mod.rs, schema.rs, extract.rs, links.rs, writer.rs, query.rs}`, `src-tauri/src/lib.rs` (`index_search`, `index_links`, `index_status`, `index_rebuild`, event `index-progress`), `src/features/search/{NotesSearch.tsx, groups.ts}`, `src/features/links/{resolve.ts, rewrite.ts, BacklinksPanel.tsx}`, `src/workspace/RightSidebar.tsx`.

## 4. Tests and exit

cargo: schema rebuild on version change, incremental update, deleted file removal, extractor fixtures (shared with TypeScript for `.hmdoc`), link parser cases, FTS query escaping. vitest: resolver order and ambiguity, rewrite plan, result grouping. Exit: search, backlinks and rename work across a 10,000-page generated notebook with search under 200 ms; Memory regression pass.

## 5. Shipped

(Filled in when the phase lands.)
