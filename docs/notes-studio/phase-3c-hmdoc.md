# NS-3C: `.hmdoc` core

Read [README.md](README.md) and [phase-3b-wysiwyg.md](phase-3b-wysiwyg.md) first. `.hmdoc` is a rich JSON page format for folder notebooks only, for content Markdown cannot hold. This phase defines the format and ships power tables and layout and styling; embeds and drawing follow in NS-3D.

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
