# NS-4A: index, links, backlinks and search

Read [README.md](README.md) and the S4 spike verdict first. This phase adds Hivemind's own derived index for folder notebooks and opened files, the full link resolver across notebooks and memory, backlinks, tags and one search box over every origin.

## Changes from the NS-0 review

These rules come from the Codex review of the design ([reviews/ns0-codex-review.md](reviews/ns0-codex-review.md)). Where the text below says otherwise, these win.

- The index covers notebook pages only. Loose files opened from disk are not indexed; recent files find them (U12).
- Living Memory pages are searched through `search`'s `pages` array (both origins, README 5.8), gated on `docs.search`; before NS-2B ships, the Living Memory group is absent (C1).
- Hivemind searches folder notebooks in its own index and takes only `origin: "lm"` entries from Living Memory's `pages`; `origin: "folder"` results are for agents. So a registered folder is never shown twice (C3).

## Changes from the code survey before NS-4A

Claude surveyed main at `604dbd1` on 2026-11-22. Where the sections below say otherwise, these win. At the user's request this phase has no Codex review; Claude reviews every diff.

- **Scope of the schema.** The index holds `pages`, `fts`, `links` and `tags` only. `blocks` (NS-8B citations), `tasks` and `props` (NS-7B) are added by the phases that use them; the index is derived, so their schema version bump just rebuilds it.
- **What is indexed.** Pages of registered folder notebooks with the extensions `.md`, `.markdown`, `.hmdoc`, `.canvas` and `.txt`, skipping the paths `files/watch.rs locate` skips (hidden files and folders, which covers `.hivemind`, `.git`, `.obsidian` and the trash, and `node_modules`). A file's first 2 MB are indexed. Private notebooks are indexed: Private stops AI and agents, not the user's own search.
- **Keeping it current.** The watcher's callback reports changes made by other programs but drops Hivemind's own writes (`is_own_write`), so the writer thread is also told by the Rust commands that write notebook files (`file_save`, `file_create`, `file_rename`, `file_delete`, the attach commands, `notebook_add`, `notebook_remove`). It never depends on the frontend relaying `files-changed`.
- **Living Memory pages.** The **Living Memory pages** group uses `doc search --all-domains` (pages only, private notebooks included on Hivemind's bridge), not `search`'s `pages` array, and shows only notebooks registered in Hivemind, since those are the ones a doc tab can open. It is present only when `capabilities.docs.search` is true; Hivemind never indexes Living Memory pages itself.
- **Memory notes group.** The existing `search` command, a few results with a link to the full results on the Memory page.
- **Where search lives.** The top bar's box stays the one search box. On the Notes page it reads "Search pages", and typing opens a results panel under it with the four groups, filters (notebook, folder, tag, kind, modified), arrow keys, Enter to open and Ctrl+Enter to open in a split; the open tabs stay visible. On every other page it searches memory as today. Ctrl+K and Ctrl+Shift+F keep focusing it.
- **Ctrl+O.** The palette's note list also lists indexed pages, with the notebook as detail.
- **Resolver.** `src/features/links/resolve.ts` keeps its same-notebook rules (exact path, same folder, shortest path, the Markdown twin over `.hmdoc`). When nothing in the page's own notebook matches, it tries other registered notebooks: `[[Notebook/Page]]` matches a notebook title as the first segment, a bare name searches every other notebook. Then memory notes by exact title; `[[mem:Title]]` names a memory note directly. Several equal answers show the picker, which writes the explicit form.
- **Tags pane.** A collapsible section of the Notes navigator; a tag opens the search panel filtered to it.
- **Link rewrite.** Renaming or moving a page or folder in the tree (both go through `file_rename`) offers the rewrite plan afterwards; each page is saved with its precondition and a page changed meanwhile is skipped and listed.
- **The `.hmdoc` extractor twin** is checked against every pair in `src/features/hmdoc/fixtures/`, including the NS-3D embeds.

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
