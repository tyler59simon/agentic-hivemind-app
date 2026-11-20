# NS-7B: tasks, properties and saved queries

Read [phase-4a-index-search.md](phase-4a-index-search.md) first; tasks and properties come from the index.

## 1. What the user sees

- A **Tasks** view (Notes page sub-view, palette entry): every `- [ ]` and `- [x]` from folder notebooks and Living Memory pages, plus open action items from Living Memory work notes (`alm open`). Columns: task, page or note, notebook or domain, due, priority. Filters: notebook, due (overdue, today, this week, none), done, text. Grouping by page, due date or notebook.
- Ticking a task writes back: pages through a hash-checked save of that one line; Living Memory action items through `check`.
- Dates and priority use the Obsidian Tasks emoji format (`📅 2026-12-01`, `⏫`), so vaults keep working in Obsidian.
- **Properties:** a properties panel above a page edits frontmatter with typed fields (text, number, date, checkbox, list, link). Untouched keys and their formatting stay byte-identical.
- **Saved queries:** a `query` fenced block in a page, or a saved view in `.hivemind/queries/<name>.json`, defined by a small filter form (notebook, folder, tag, property conditions, sort, limit) and shown as a **table** (property columns, inline edit) or a **board** (cards grouped by a property; dragging a card updates the property with a hash-checked save).

## 2. Design

- Index tables `tasks` and `props` from NS-4A; the TypeScript side edits frontmatter with the `yaml` package's document API (keeps comments, order and untouched formatting); Rust parses a small frontmatter subset for the index (scalars, lists, quoted strings).
- Query definition (JSON, versioned): `{ "version": 1, "from": { "notebooks": [], "folder": null }, "where": [{ "prop": "status", "op": "eq", "value": "active" }], "sort": [{ "prop": "due", "dir": "asc" }], "view": "table" | "board", "columns": [], "groupBy": null, "limit": 500 }`. Evaluated in Rust over the index (`index_query`).
- Writes go through the document session when the page is open, else directly through `file_save` with the indexed hash.

## 3. Tests and exit

vitest: Tasks emoji parsing and formatting, frontmatter edit keeping untouched bytes, query form to JSON. cargo: query evaluation, task write-back with a stale hash. Exit: tick, edit a property and drag a board card all write back with preconditions; Memory regression pass.

## 4. Shipped

(Filled in when the phase lands.)
