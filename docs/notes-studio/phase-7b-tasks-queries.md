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
- **Saved queries:** a `query` fenced block in a page, or a saved view in `.hivemind/queries/<name>.json`, defined by a small filter form (notebook, folder, tag, property conditions, sort, limit) and shown as a **table** (property columns, inline edit) or a **board** (cards grouped by a property; dragging a card updates the property with a hash-checked save).

## 2. Design

- Index tables `tasks` and `props` from NS-4A; the TypeScript side edits frontmatter with the `yaml` package's document API (keeps comments, order and untouched formatting); Rust parses a small frontmatter subset for the index (scalars, lists, quoted strings).
- Query definition (JSON, versioned): `{ "version": 1, "from": { "notebooks": [], "folder": null }, "where": [{ "prop": "status", "op": "eq", "value": "active" }], "sort": [{ "prop": "due", "dir": "asc" }], "view": "table" | "board", "columns": [], "groupBy": null, "limit": 500 }`. Evaluated in Rust over the index (`index_query`).
- Writes go through the document session when the page is open, else directly through `file_save` with the indexed hash.

## 3. Tests and exit

vitest: Tasks emoji parsing and formatting, frontmatter edit keeping untouched bytes, query form to JSON. cargo: query evaluation, task write-back with a stale hash. Exit: tick, edit a property and drag a board card all write back with preconditions; Memory regression pass.

## 4. Shipped

(Filled in when the phase lands.)
