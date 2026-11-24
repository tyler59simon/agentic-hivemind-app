# NS-4A: index, links, backlinks and search

> **Retired (CON-18, 2026-11-24).** Living Memory notebooks, the ones that kept their pages inside the store, no longer exist in Hivemind or in Living Memory. Where this document describes them (`lm:<domain>:<notebook>` pages, `doc notebooks`, `doc read`, `doc write`, `doc tasks`, `doc query`, the Living Memory group of search), read it as history. What it says about folder notebooks still holds.

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

Code landed on 2026-11-22: Hivemind `f559359` (the phase) and `9a9f32c` (fixes from the UI pass). At the user's request this phase had no Codex review; Claude reviewed the diff. `rusqlite` (bundled) is the only new dependency; no Living Memory change was needed.

**What differs from sections 2 and 3 and the survey above.**
- The commands live in `src-tauri/src/notes_index/commands.rs`, not in `lib.rs`, and there are three beyond the four in README 5.7: `index_pages` (every indexed page, for Ctrl+O and the resolver), `index_tags` and `index_incoming` (the links whose target is named like any of a list of pages, for the rename plan). `index_links` returns `{ outgoing, incoming, unlinked }`. The event `index-progress` carries `{ state, done, total, error }`.
- **Links are stored as written, and the webview resolves them.** `links` holds `(page, target_raw, target_kind, target_name, embed, line, context)`: `target_name` is the last part of the target, lowercase, without `#heading` and without a Markdown or rich page extension. The index answers "which links are written with a name like this page's" and `src/features/links/resolve.ts` says which of them reach it, so a link in the page, in Backlinks and in a rename's plan always agree and the rules exist once. There is no `links.rs` resolver in Rust; `notes_index/links.rs` is the Markdown link, tag and text scanner.
- No `blocks`, `tasks` or `props` tables (the survey). `tags` and `links` are as designed.
- Opening a page does not re-check its hash against the index (section 2 asked for it). The watcher, the commands that write files and the startup scan keep the index current, and a mismatch would only show as a stale search result until the next change.
- Search words are combined with AND, the last word also matches as a prefix, and a quoted phrase is a phrase. `OR`, `NOT`, `NEAR`, `-`, `*` and parentheses are plain text, so nothing a user types can be a query error.
- Unlinked mentions are pages of the same notebook that hold the page's file name as a phrase and have no link written with that name.
- The rename plan covers the links that reach the moved pages from Markdown and rich pages (the `wikiLink` and `embed` nodes of a rich page). A canvas card or any other page it cannot rewrite is listed as a link Hivemind could not update. The plan counts the links that must change: a bare `[[Name]]` that still resolves after a move is left alone. A link that no spelling of the new path reaches (a page of a folder that has a page of the same name, which the same-folder rule always prefers) is listed too, not guessed at.
- When any filter is set, only the folder notebooks' pages are searched, since the filters mean nothing to Living Memory. The memory group asks `search` for five notes and links to the full results on the Memory page.
- Ctrl+O lists indexed pages, so `.txt` files and canvases appear beside Markdown and rich pages. The notebook trees stand in while the index cannot answer.
- A tie between two memory notes of one title shows the picker, but the explicit form `[[mem:Title]]` cannot tell them apart, so nothing is written for that pick.

**Measured** (10,000 generated Markdown pages with frontmatter tags, about 2 KB each and 3 links each, in 100 folders; `cargo test notes_index::tests::ten_thousand -- --ignored --nocapture`, Windows 11):

| | debug build | opt-level 3 |
| --- | --- | --- |
| full index | 12.3 s (read 3.4 s, extract 4.6 s, SQL 2.4 s) | 0.7 s extract, 1.9 s SQL; file reads 49 s on that run, see below |
| search, two words | 1.5 ms | 0.8 ms |
| search, one common word | 31 ms | 19 ms |
| search, a prefix that matches every title ("page num") | 127 ms | 77 ms |
| backlinks of one page | 0.09 ms | 0.04 ms |
| unlinked mentions of one page | 0.5 ms | 0.25 ms |
| all 10,000 pages listed | 23 ms | 9.5 ms |
| restart scan, nothing changed | 89 ms | 53 ms |
| one saved page indexed | 8.5 ms | 8.7 ms |

The file reads are the operating system's: the same reads took 3.4 s from one test executable and 49 s from another in a temporary folder, which points at the real-time virus scan, so the first index of a large notebook on a machine that scans every file read can take a minute. Every query is far under the 200 ms target.

**Verified**: `cargo test`, `cargo clippy --all-targets -- -D warnings`, the whole `npx vitest run`, `npx tsc --noEmit` and `npm run build`. The `.hmdoc` extractor's Rust twin gives byte-identical text for all four fixture pairs (`rich_page_text_is_what_the_fixture_beside_it_holds`), and JavaScript's `\s` and `trim()` set is written out in Rust because it differs from `char::is_whitespace` at U+0085 and U+FEFF. The main tests were checked to fail with the code they cover changed: FTS escaping, the version rebuild, deletion on a missing path, the whitespace twin, the Living Memory group's gate, the resolver's step into other notebooks, the rewrite's hash precondition and the panel's arrow keys.

**UI pass (2026-11-22).** The dev app ran against a scratch store with Living Memory notebooks and two scratch folder notebooks (Alpha with pages in folders, a frontmatter tag, a rich page and links of every kind; Beta with one page), driven over WebView2 remote debugging:
- The index was created at start; searching a word in both notebooks grouped the results as This notebook and Other notebooks, and a word in a Living Memory page showed the Living Memory pages group through `doc search`; Enter opened that page in its tab.
- The rail of Home listed Ideas as a backlink and its outgoing links: the ambiguous `[[Plan]]` as several pages, `[[Roadmap]]` in Beta, the memory note named by `[[mem:...]]`, and `[[Missing page]]` with Create page. Ideas listed Home as an unlinked mention, and a `[[Target]]` inside a code fence was not counted.
- Following `[[Plan]]` opened the picker with `archive/Plan.md` and `projects/Plan.md`; choosing one opened it and wrote `[[projects/Plan]]` into Home as an unsaved edit, leaving the file alone until Save.
- Renaming `notes/Target.md` to `Destination` offered to update three links (a wiki link, a Markdown link and a rich page's `wikiLink`). Ideas was changed on disk before Update links: it was skipped and listed as changed, the other two were written, and the open Home tab showed `[[Destination]]`. The outside edit also reached the index through the watcher.
- The Tags pane listed `#tag-one` (2) and `#alpha-tag` (1); a tag opened the panel filtered to it. Ctrl+O listed Roadmap with its notebook. Notebook settings showed "6 pages are searchable" and Rebuild index ran.

The pass found two problems, fixed in `9a9f32c`: a match on the selected result was invisible because its highlight had the selection's colour, and Living Memory page snippets had no highlight (`doc search` returns them unmarked, so Hivemind marks the query's words).

**Known limits.** Planning a rewrite resolves every candidate link against every page of its notebook, which is quick for a page or a small folder and slow for a folder of thousands of pages that are linked everywhere. A notebook whose folder is missing at start keeps its rows and says so in its settings. Relative Markdown links inside a page that moves to another folder are not rewritten (wiki links by name are unaffected). The release exe size was not measured; spike S4 measured about 1.7 MB for `rusqlite`.
