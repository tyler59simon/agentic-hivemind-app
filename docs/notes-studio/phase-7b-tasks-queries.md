# NS-7B: tasks, properties and saved queries

Read [phase-4a-index-search.md](phase-4a-index-search.md) first; tasks and properties come from the index.

## Changes from the NS-0 review

These rules come from the Codex review of the design ([reviews/ns0-codex-review.md](reviews/ns0-codex-review.md)). Where the text below says otherwise, these win.

- Living Memory tasks and properties come from `doc tasks` and `doc query` (NS-2B), not from Hivemind's index; ticking a task or editing a property of a Living Memory page writes it with `doc write --expected-revision` (U7).
- Exit criteria split by capability: Living Memory task and property write-back is checked only when `docs.search` is present; folder notebooks are checked always. `doc query` filters by notebook, folder (path prefix) and tag (`tags` frontmatter) as well as by properties, so saved queries mean the same over both kinds (C1, U7).

## Changes from the code survey before NS-7B

Claude surveyed main at `a7e267d` on 2026-11-22. Where the text below says otherwise, these win.

- **The index has no `tasks` or `props` tables.** NS-4A built `pages`, `fts`, `links`, `tags`, `units`, `vectors` and `meta` (`src-tauri/src/notes_index/schema.rs`, `VERSION = 2`). This phase adds `tasks` and `props`, extracted in the same pass as links and tags (`notes_index/links.rs` already finds the frontmatter block), and raises `VERSION` so existing indexes rebuild.
- **The `yaml` package is not a dependency.** Add `yaml` (eemeli/yaml, ISC, no dependencies) at an exact version for the frontmatter document API. The Rust side keeps its own small frontmatter subset parser.
- **Living Memory commands that exist** (installed build, `core/cli.py`):
  - `doc tasks [--all-domains] [--notebook NB] [--open]`: task lines of notebook pages.
  - `doc query --payload-file FILE [--all-domains]`: the payload is `{"where": [{"key", "op", "value"}], "sort": [{"key", "order"}], "limit": N, "notebook": NB}`, with pseudo keys `title`, `path` and `notebook` (`core/docs_index.py` around line 450). Hivemind's query JSON uses `prop` and `dir`, so it is translated. Check `_matches` for the operators it supports. The folder filter maps to a `path` condition if an operator fits, otherwise it is applied in TypeScript after the query. Tags are the `tags` property.
  - `doc set` and `doc unset` manage folder notebooks, not page properties. Property edits and task ticks on a Living Memory page go through `doc read` and `doc write --expected-revision`, refusing a page read `truncated`, like NS-7A's append.
  - `--payload-file` goes through `lm_body` with a new allowed flag, as `--settings-file` did in NS-7A.
- **Living Memory action items** use the existing `open` and `check` wrappers in `src/lib/lm.ts` (`openArgs`, `check ... --index`).
- **Writes to open pages** go through the document session (`src/documents/store.ts`), as NS-7A's append does for pages in the main window. Closed pages save with the indexed hash and refuse on a mismatch.
- **Rich editors and frontmatter:** `src/features/rich/markdown.ts` and `fromMarkdown.ts` already carry a frontmatter block through. The properties panel edits the page text, and the open editor follows the document, so Rich, Live and Source stay in step.

## 1. What the user sees

- A **Tasks** view (Notes page sub-view, palette entry): every `- [ ]` and `- [x]` from folder notebooks and Living Memory pages, plus open action items from Living Memory work notes (`alm open`). Columns: task, page or note, notebook or domain, due, priority. Filters: notebook, due (overdue, today, this week, none), done, text. Grouping by page, due date or notebook.
- Ticking a task writes back: pages through a hash-checked save of that one line; Living Memory action items through `check`.
- Dates and priority use the Obsidian Tasks emoji format (`📅 2026-12-01`, `⏫`), so vaults keep working in Obsidian.
- **Properties:** a properties panel above a page edits frontmatter with typed fields (text, number, date, checkbox, list, link). Untouched keys and their formatting stay byte-identical.
- **Saved queries:** a `query` fenced block in a page, or a saved view (a query view in Living Memory's `views.json`, since CON-13), defined by a small filter form (notebook, folder, tag, property conditions, sort, limit) and shown as a **table** (property columns, inline edit) or a **board** (cards grouped by a property; dragging a card updates the property with a hash-checked save).

## 2. Design

- Index tables `tasks` and `props` from NS-4A; the TypeScript side edits frontmatter with the `yaml` package's document API (keeps comments, order and untouched formatting); Rust parses a small frontmatter subset for the index (scalars, lists, quoted strings).
- Query definition (JSON, versioned): `{ "version": 1, "from": { "notebooks": [], "folder": null }, "where": [{ "prop": "status", "op": "eq", "value": "active" }], "sort": [{ "prop": "due", "dir": "asc" }], "view": "table" | "board", "columns": [], "groupBy": null, "limit": 500 }`. Evaluated in Rust over the index (`index_query`).
- Writes go through the document session when the page is open, else directly through `file_save` with the indexed hash.

## 3. Tests and exit

vitest: Tasks emoji parsing and formatting, frontmatter edit keeping untouched bytes, query form to JSON. cargo: query evaluation, task write-back with a stale hash. Exit: tick, edit a property and drag a board card all write back with preconditions; Memory regression pass.

## 4. Shipped

Shipped on 2026-11-22 in `c6ddc72` (survey `41f6926`). At the user's request this phase had no Codex review; Claude reviewed the diff (the shared write path in `pageWrite.ts`, saved view files in `queries.rs` (since removed)) and reran every check.

UI pass (Claude, dev app, scratch folder notebook plus the scratch Living Memory store):
- Tasks listed the folder tasks and a Living Memory page task, with priority and an overdue date in red; Overdue left only the overdue task. Ticking "call Ana" changed only that line on disk.
- Properties panel on a CRLF page with a comment line, a trailing comment, extra spaces, mixed quotes, a list and a nested map: changing `status` and the `done` checkbox changed only those two values; every other byte stayed the same. The nested key showed read-only.
- A `query` block drew a table in Reading, sorted by `due`. As a board grouped by `status`, dragging a card to another column rewrote that page's `status`, and dragging one to "No status" removed the key. The drags were fired as DOM drag events, since CDP mouse input does not start an HTML5 drag.
- Save view wrote `.hivemind/queries/Active work.json`.
- Not checked in the app: a stale tick or drop (covered by `writes.test.ts` and `QueryView.test.tsx`), and a tick on an open page with unsaved edits (covered by `writes.test.ts`).

**Rust**
- `notes_index/props.rs` (new): the tasks and properties of a Markdown page, read as Living Memory reads them (`core/docs_index.py`, `tasks` and `properties`), so both kinds of notebook mean the same. A task is a `- [ ]`, `* [x]` or `1) [X]` line with text, outside fenced code (a fence closes only on the three characters that opened it) and outside the frontmatter, at most 500 per page and 500 characters of text. Its due date is the first `📅 YYYY-MM-DD` or `due:: YYYY-MM-DD`. A property is a flat frontmatter key: a scalar, an inline `[a, b]` list or a block list gives one value each, nested maps are skipped, at most 50 per page. The test strings were run through Living Memory's own functions and agree.
- `notes_index/schema.rs`: tables `tasks (page, line, done, text, due)` and `props (page, key, value)`, `VERSION = 3`, so an index made by an older build is dropped and every notebook is read again. `links.rs` (`scan_markdown`), `extract.rs` and `writer.rs` fill and clear them with the page's other rows, in the same pass; they exist for Markdown pages only.
- `notes_index/structured.rs` (new): `tasks` (open before done, then due date with none last, notebook, page and line, as `doc tasks` orders them; filters for notebook, done and text) and `run`, the query evaluator over the index. It follows Living Memory's `_matches` and `query`: all conditions must hold, a key with several values holds when any does, numbers compare as numbers when both sides are, text by lower case, `ne` holds for a missing key, a page without the sort key comes last, later sort keys are applied first. Pseudo keys `title`, `path`, `notebook`. A query has at most 10 conditions and 5 sort keys and returns at most 1000 pages. `notes_index/commands.rs`: `index_tasks` and `index_query`.
- `queries.rs` and the three `studio.rs` commands (`query_views`, `query_view_save`, `query_view_delete`) kept a saved view as `.hivemind/queries/<name>.json` of a folder notebook. CON-13 (2026-11-24) removed them: Living Memory now stores saved views in `views.json` as query views (`views add --spec-file`, `views update`, `views remove`), so a view no longer depends on a folder notebook.
- `lmdoc.rs`: `lm_body` accepts `--payload-file` as a third file option (staged `.json`, at most 256 KiB, swept with the others); CON-13 added `--spec-file`, for `views add` and `views update`. The live test now creates a page with properties and tasks and checks `doc tasks`, `doc tasks --open`, and `doc query` through a staged payload (including a refused operator).

**Webview**
- `features/notes/tasks.ts`: the twin of the Rust task parse (`parseTask`, `dueOf`), the priority emojis (`🔺 ⏫ 🔼 🔽 ⏬`), `displayText`, `sameTask` and `tickLine`.
- `features/notes/frontmatter.ts`: reads the block with the `yaml` package (2.9.1, exact) and edits it by splicing: the value of an existing key is replaced where it stands (a quoted value keeps its quote style, a trailing comment stays, a flow list stays a flow list, a block list stays a block list at its indent), a new key is added as the last line of the block, a page with no block gets one, a removed key takes only its own lines. Every other byte, comments, key order, spacing and line endings included, is copied as it was. A block that is not valid YAML, is not a map or is one line in braces is refused with a message.
- `features/notes/pageWrite.ts` and `writes.ts`: `changePage` changes one thing in one page. A page open in a tab changes through its document session, so unsaved edits are kept (a clean page is saved at once; one with unsaved edits stays unsaved and the user is told). A closed folder notebook page is read, changed and saved with the stamp it was read at, and refused when its hash is not the one the list was read from. A closed Living Memory page is read with `doc read`, refused when read `truncated` or not exactly UTF-8, and written with `doc write --expected-revision`. `setTaskDone` checks that the line at that number still parses to the same box and text; `setPageProperty` and `clearPageProperty` go through `frontmatter.ts`.
- `features/notes/queries.ts`: the query (version 1) with `parseSpec`, the form (`QueryForm`, `specOf`, `formOf`), `toLmPayload` (keys and operators renamed; a folder becomes the range `path >= folder/` and `path < folder0`; a tag becomes the `tags` property; one Living Memory notebook goes in `notebook`, several are filtered after the answer), `runQuery` (index and `doc query` asked together, merged, sorted again and limited here; a source that fails is named while the other answers) and the saved view calls.
- `features/notes/TasksView.tsx` and `taskList.ts`: the **Tasks** sub-view of the Notes page (a button above the notebooks, and a palette entry). Rows come from the index, from `doc tasks` (with `docs.search`) and from `openWork` (open Memory action items). Filters: notebook (or Memory action items), due (overdue, today, this week, none), open or done or both, text; grouping by page, due date or notebook. A tick on a page writes through `setTaskDone`; on an action item through `check`; a refusal is a toast and the list is read again.
- `features/notes/PropertiesPanel.tsx`: the **Properties** panel above a Markdown page (not in History). Typed fields: text, number, date, checkbox, list (comma separated) and link (a `[[Page]]` value, with an Open button). A nested value is shown as written and left alone. Add and remove a property. An edit changes the page text through the session (`edit`), so the open editor follows in every mode, and the page is saved like any other edit.
- `features/notes/QueryView.tsx`, `QueryForm.tsx`, `ViewsPage.tsx`: a query as a **table** (a cell edits its property in place; emptying a cell clears it) or a **board** (cards grouped by a property; a drag writes the column's value, the column for no value removes the property) with the hash or revision the answer carried as the precondition. The **Views** sub-view lists the views Living Memory keeps (CON-13: note dashboards and query views), opens a query view into the form, runs it, saves it (add, or update when one is open) through Living Memory, deletes it and copies it as a ```` ```query ```` block. A `query` fenced block in a page is drawn by the Reading view (`PageView`).
- `openPage` now closes a list (Tasks or Views) that fills the Notes page, so a page opened from anywhere shows. `NotesPage`, `store.ts` (`view` on the notes route) and `Palette.tsx` carry the entries.

**Tests**
- vitest: `frontmatter.test.ts` (reads, every edit as a whole-text comparison with comments, key order, quoting, `key:` with no value, nested maps, a trailing comment, CRLF and a byte order mark, and refusals), `tasks.test.ts` (parse, due, priority, `sameTask`, `tickLine`), `taskList.test.ts`, `queries.test.ts` (definition checks, form to JSON and back, the Living Memory translation, sorting, merging, one source failing), `writes.test.ts` (a tick keeps a page's CRLF, a stale hash is refused and nothing is saved, a line that moved is refused, a tick on an open page with unsaved edits keeps them, a Living Memory page read truncated is refused, a stale revision is refused, a property write carries the hash), `TasksView.test.tsx`, `QueryView.test.tsx` (a drag writes against the hash; a changed page is refused and the card put back), `PropertiesPanel.test.tsx`, `ViewsPage.test.tsx`.
- cargo: `notes_index::props`, `notes_index::structured`, and in `notes_index` the index extracting tasks and properties and following edits and deletes, the task list filters and order, query evaluation (notebook, folder, tag, comparisons, sorting, pseudo keys, limit, page rows), and the version bump rebuilding an index that has no `tasks` or `props`; `lmdoc::tests` (three file options, bounds, the live bridge test).
- Checked against mutations that remove the code each covers; every one failed its test: the quote style kept on a replaced value, the byte range of a replaced value, the line check of a tick, the hash check of a closed page, the truncated check, writing an open page through the session, the hash on a board or table write, a Living Memory operator, the version bump, the numeric comparison and the storing of tasks.
- Results: `cargo test` 801 passed and 3 ignored (the live test included, run with `HIVEMIND_TEST_LM_SCRIPT=...living_memory.py`); `cargo clippy --all-targets -- -D warnings` clean; the whole `npx vitest run` 192 files, 1922 passed and 1 skipped, with `src/workspace/store.test.ts` unedited; `npx tsc --noEmit` and `npm run build` clean.

**Deviations**
- Ticking a task changes only its box. The Tasks done date (`✅ 2026-12-01`) is not added, since the doc does not ask for it; clearing a box does remove an existing done date, which would otherwise say an open task was finished.
- A `query` block is drawn by the Reading view only. Live, Rich and Source show the fence as code; the **Views** sub-view and **Copy as page block** make and check one.
- The index stores `due` but not the priority: the priority is read from the task text in the webview, for index rows and Living Memory rows alike (`doc tasks` has none).
- The tag of a query is the index's tag set (frontmatter `tags` and `#tags` of the body) for folder notebooks and the `tags` property for Living Memory notebooks, as the survey says.
- "Link" is a kind a field takes when its value is `[[Page]]`; it is not offered when adding a property.
- Saved views are kept in a folder notebook only (Living Memory notebooks have no `.hivemind` folder), though a view can look into any notebook.

**Known limits**
- Tasks inside a callout or quote (`> - [ ] x`) are not found, as in Living Memory. A value with a trailing ` # comment` is read with the comment, as Living Memory reads it.
- The index reads files on disk: a task or property typed into an open page shows in the lists after it is saved. A tick on an open page whose unsaved edits moved the line is refused.
- A list-valued property has one column in a board by its first value; a card whose property has several values is not moved by a drag. A board has columns only for values in the answer, plus the one for no value.
- Editing a list in the panel or a cell replaces the list and drops comments on its items. A value with a line break is written on one line.
- `doc tasks` returns at most 500 rows across Living Memory, open ones first; the Tasks view reads at most 5000 index rows.
- The Tasks plugin's recurrence (`🔁`) is not applied when a task is ticked.
- The pseudo key `notebook` is the notebook id for a folder notebook and the notebook name for a Living Memory notebook, so a sort or condition on it only means something inside one kind.
