# NS-3C: `.hmdoc` core

Read [README.md](README.md) and [phase-3b-wysiwyg.md](phase-3b-wysiwyg.md) first. `.hmdoc` is a rich JSON page format for folder notebooks only, for content Markdown cannot hold. This phase defines the format and ships power tables and layout and styling; embeds and drawing follow in NS-3D.

## Changes from the code survey before NS-3C

Claude checked the anchors against main at `fe89de1` on 2026-11-21, after NS-3B. Where the text below says otherwise, these win.

- **A page kind, not a new tab kind.** `src-tauri/src/notebooks/mod.rs` adds `hmdoc` to `PAGE_EXT`, so the tree, the palette, subpage folders and `[[link]]` resolution treat `Name.hmdoc` as a page. `src/lib/notebooks.ts` gains `isRichDoc(path)`; `pageTitle` and the tree's `PAGE` pattern strip `.hmdoc` as well as `.md`. `isMarkdown` stays Markdown only. A new page made by following a missing link is still `.md`. `tauri.conf.json` already associates `.hmdoc` (NS-1B).
- **Living Memory notebooks.** Living Memory accepts only `.md` pages (`core/docs.py` `clean_path`), so no Living Memory change is needed: Hivemind does not offer New rich page or Convert in a Living Memory notebook. Convert is offered only on pages of folder notebooks, because it creates a file beside the page.
- **The tab.** A `.hmdoc` file tab has no mode tabs. `FileTab.tsx` shows `HmdocEditor`, a lazy chunk like `RichEditor`, over the same document session: the session text is the file's JSON, the editor writes it after every transaction that changes the document, and Save, Ctrl+S, drafts and the watcher work as for any page. Opening or viewing a file never writes it. A file whose keys are not in the stable order is rewritten in that order on its first save.
- **Read-only cases.** A file that is not valid JSON, has another `format`, has a `schemaVersion` other than 1, or holds a node, mark or attribute the schema does not know opens as read-only JSON in `CodeEditor` with a banner giving the reason; a newer version says "Made by a newer Hivemind". ProseMirror's `Node.fromJSON` silently drops unknown attributes, so `validate.ts` walks the JSON and compares every node's and mark's attribute keys with its type before calling `fromJSON` and `check()`. Files over 5,000,000 characters also open as read-only JSON.
- **Conflicts.** `.hmdoc` text is never merged line by line. When the file changed on disk, the banner offers Keep mine (`resolveMerge` with my text against theirs, which saves over the version shown), Keep theirs (reload) and Save both (my version goes to a new `Name (my edits).hmdoc` beside the page, with a free name, then the tab reloads).
- **Schema.** `src/features/hmdoc/schema.ts` builds on NS-3B's extensions and drops the Markdown-only attributes that have no meaning in a JSON page (`srcId` at least); where the export reuses NS-3B's `writeBlock`, missing style attributes fall back to the defaults. New in the schema: table cells with `colspan`, `rowspan`, `colwidth` (Tiptap's own) and `background`; a table `id` set when the table is made (the key of its view state); header rows and header columns as `tableHeader` cells; cells holding any blocks; a `textColor` mark and a `color` attribute on the highlight mark; `columns` with two to four `column` children; `toggle` (a summary line and a body, open or closed); an `icon` on callouts.
- **Palette.** Colours are stored as names from a fixed list (gray, red, orange, yellow, green, blue, purple, pink), never as hex, and drawn through CSS variables defined for the light and dark themes.
- **Sort and filter.** View state lives in `meta.views[tableId]` and never changes the stored rows. A filter hides rows that do not match and the table stays editable. A sorted table is drawn as a sorted, read-only copy with "Sorted by column B. Clear the sort to edit."; sorting is not offered on a table with a cell spanning rows.
- **Formulas.** A cell whose text starts with `=` holds a formula; the stored text is the formula, and the cell shows the computed value while the cursor is outside it. Supported: numbers, `+ - * /`, parentheses, unary minus, A1 references and ranges within the same table (over the visual grid from `TableMap`; a reference to a covered cell reads the merged cell), and `SUM`, `AVG`, `MIN`, `MAX`, `COUNT` over ranges and lists. Blank and text cells are skipped by the functions and are `#VALUE!` in arithmetic. Errors: `#REF!`, `#CYCLE!`, `#VALUE!`, `#DIV/0!`. No `eval`.
- **Page.** `meta.width` is `normal`, `wide` or `full`. `meta.cover` is a notebook-relative image path, picked from the notebook or added by paste or drop as an attachment (NS-3A's attach path) and drawn through the page's `RichContext`. `meta.title` is set from the file name when the file is made and is used only by exports; the tab and tree show the file name.
- **New rich page and Convert.** New rich page in the tree's context menu and the Notes page's new menu makes `Untitled.hmdoc` (free name) with one empty paragraph. Convert to rich page on a folder notebook's Markdown page loads it with NS-3B's `loadPage`, clears `srcId`, keeps source boxes (frontmatter, HTML and the rest) as source boxes, writes `Name.hmdoc` beside it (free name) and opens it.
- **Export to Markdown** writes `Name.md` beside the page (free name) with NS-3B's `writeBlock` in the default style and shows the report. Dropped or flattened, each with a count: merged cells (content kept in the first cell), cells holding more than one paragraph or any other block (joined with `<br>`), cell backgrounds, column widths, header columns, text colours, coloured highlights (written as plain `==highlight==`), columns (written one after another), toggles (written as a folded `> [!note]-` callout with the summary as its title), callout icons, formulas (written as their values), the cover, the page width, and sort and filter state. Source boxes are written as their source. The report is built by the same walk that writes the file, and a test fails if any `.hmdoc`-only node, mark or attribute is missing from it.
- **Extraction.** `extract.ts` ships here with shared fixtures in `src/features/hmdoc/fixtures/`. Formula cells extract as their stored formula text, so NS-4A's Rust twin needs no evaluator. The Rust twin itself is NS-4A's.

## 1. What the user sees

- **New rich page** in a folder notebook makes `Name.hmdoc`; **Convert to rich page** on a Markdown page makes a new `.hmdoc` beside it (the `.md` is not changed).
- Power tables: merged cells, column widths, cell background colours, header row and header column, sort and filter as view state (saved per page, never reordering stored rows), and formulas in cells (`=SUM(B2:B9)`, `AVG`, `MIN`, `MAX`, `COUNT`, A1 references and ranges) recalculated on edit.
- Layout and styling: text colour and highlight from a fixed palette that follows the theme, two to four columns, toggles (collapsible blocks), callouts with an icon, page width (normal, wide, full), a cover image.
- **Export to Markdown** writes a `.md` and lists every construct it dropped or flattened. Living Memory notebooks never hold `.hmdoc`.
- A file with an unknown or newer schema version opens read-only with "Made by a newer Hivemind".

## 2. Format

```json
{
  "schemaVersion": 1,
  "format": "hivemind-rich",
  "meta": { "title": "Q4 plan", "cover": "assets/cover.png", "width": "wide", "views": {} },
  "content": { "type": "doc", "content": [] }
}
```

- `content` is a ProseMirror document over the schema in `src/features/hmdoc/schema.ts` (an extension of the NS-3B schema). Every node attribute is versioned with the schema; unknown nodes or attributes make the file read-only rather than dropping data.
- Written with sorted object keys and two-space indentation so git diffs stay readable.
- Validation: `Node.fromJSON(schema, content)` then `node.check()`; failures open read-only with the error.
- Text extraction (`extract.ts`) is deterministic: block texts in document order, table cells row by row, tab-separated; a Rust twin (`src-tauri/src/notes_index/extract.rs`, NS-4A) is checked against the same fixtures.
- Formulas: a small parser and evaluator in `formulas.ts` (no `eval`), cycle detection, errors shown as `#REF!`, `#CYCLE!`, `#VALUE!`.
- Conflicts on save: keep mine, keep theirs, save both (README 5.2).

## 3. Files

`src/features/hmdoc/{envelope.ts, schema.ts, validate.ts, extract.ts, toMarkdown.ts, formulas.ts, HmdocEditor.tsx, blocks/table/*, blocks/columns.ts, blocks/toggle.ts, blocks/callout.ts}`, `src/workspace/Workspace.tsx` (open `.hmdoc` in the rich editor), `src-tauri/src/notebooks/mod.rs` (`.hmdoc` as a page kind).

## 4. Tests

vitest: envelope validation (good, unknown version, unknown node, bad JSON), stable serialisation, extraction fixtures, formula parser and evaluator (ranges, cycles, errors), export reports, merged-cell table operations.

## 5. Exit

`.hmdoc` files reopen identically and diff cleanly in git; every export report lists every dropped construct; Memory regression pass.

## 6. Shipped

(Filled in when the phase lands.)
