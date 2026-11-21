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

Code landed on 2026-11-21: Hivemind `9dda8ae` (the phase), then `694c928`, `74048b0` and `bf9bcf6` (fixes from three Codex review rounds) and `8736cc8` (fixes from the UI pass). Two small commits came before the phase: `0530c90` fixes a clippy lint that a newer clippy reports in `src-tauri/src/lib.rs`, and `c972680` stubs `Range` layout in the NS-3B Rich editor tests, which failed now and then with "target.getClientRects is not a function". No Living Memory or Rust change beyond `PAGE_EXT` was needed.

**What differs from sections 2 and 3 and the survey above.**
- The `.hmdoc` editor opens from `src/features/notes/FileTab.tsx`, not `Workspace.tsx`. Files not named in section 3: `palette.ts`, `rules.ts` (the attribute rules the validator checks), `sanitise.ts`, `convert.ts`, `outline.ts`, `HmdocTools.tsx` (page settings and the sort and filter dialog) and `src/features/notes/richActions.tsx` (the export report).
- Pasted content is cleaned before it reaches the page (`sanitise.ts`, through a `PasteGuard` extension and the plain-text Markdown paste path). Tiptap reads any attribute that has no `parseHTML` rule straight from the pasted element, so `<table align="center">` gave the page an attribute the validator refuses.
- New rich page is in the notebook's menu and the tree's context menu (with New rich subpage and New rich page here). Ctrl+N and the + button still make Markdown pages.
- Export to Markdown does not open the new page; the report has an "Open the Markdown page" button. Save both is not offered for a file opened from outside a notebook.
- Filters, like sorts, are not offered on a table with a cell spanning rows (review R1-7).
- With `Plan.md` and `Plan.hmdoc` side by side, `[[Plan]]` is the Markdown page and the `Plan/` folder of subpages belongs to it; the rich twin has no subpage commands. Following a missing `[[Name.hmdoc]]` makes a valid rich page (review R1-6, R1-15, R1-16).
- An edit that would take the written page past 5,000,000 characters is refused, and the page stays editable (review R1-11).
- A column width of 0 (unset) is valid in a merged cell's widths, and list starts run from -1,000,000 to 999,999,999 (review R1-3, R1-12, R2-1).
- From the UI pass: the outline beside the page lists a rich page's headings and moves the cursor to the one clicked; rich pages have their own icon in the tree and on their tabs; tables draw each column's alignment.

**Verified**
- `npm test` (115 files, 1,190 tests, one skipped: the NS-3A 1 MB timing check), `npx tsc --noEmit` and `npm run build` (the `.hmdoc` editor is a lazy chunk of about 22 KB on top of the NS-3B Rich editor chunk). `cargo test notebooks` and `cargo clippy --all-targets -- -D warnings` in `src-tauri`.
- Every page of the NS-3B corpus and this repository's `docs/` converts to a rich page that opens for editing, is written again byte for byte, and exports without failing (`convert.test.ts`). The three extraction fixtures in `fixtures/` give their `.txt` and are written in the stable order (`extract.test.ts`).
- Three read-only Codex reviews (19, 4 and 4 findings), each finding checked before it was fixed, each fix with a regression test checked to fail without it: [reviews/ns3c-codex-review.md](reviews/ns3c-codex-review.md).

**UI pass (2026-11-21).** The dev app ran against a scratch store and a folder notebook outside any bound folder, driven over WebView2 remote debugging:
- A rich page with a cover, wide width, text colour and highlight, two columns, a closed toggle, a callout with an icon and two tables (one with a merged header and an out-of-range reference) opened without changing the file. The formulas showed 22, 1.41666666667 and `#REF!`.
- Text typed at the end and Ctrl+S saved stable JSON; the file kept its CRLF line endings. The first save added the default cell attributes the hand-written file left out, as the survey says for files not in the stable form.
- Clicking a formula's value showed `=SUM(B2:B4)`; editing it to `=SUM(B2:B4)*2` showed 44. The toggle opened. Sorting by Qty showed the read-only sorted copy with its bar, and Clear sort brought the editable table back.
- A file that is not valid JSON and a file of schema version 2 opened as read-only JSON with their reasons ("Made by a newer Hivemind (schema version 2)").
- Convert to rich page on a Markdown page made `Plan.hmdoc` beside it with the table, callout and lists. Export to Markdown wrote `Kitchen.md` and its report listed ten kinds of loss with counts.
- A cover named `100% complete.png` was drawn. A real mouse drag on the edge of the merged header stored `[0, 86.5]`, and the page reopened for editing after a reload.
- With unsaved edits and the file changed by another program, the banner offered Keep mine, Keep theirs and Save both. Keep mine saved over the outside change; Save both wrote `Kitchen (my edits).hmdoc` and showed the disk version. A clean page followed an outside change on its own.
- New rich page made `Untitled.hmdoc`. The Memory page opened as before.
- Not driven: a picture pasted or dropped as a cover (the attach path has tests).

The pass found five problems, fixed in `8736cc8`: the outline beside the page said "No headings." on a rich page, `Plan.md` and `Plan.hmdoc` looked the same in the tree and the tabs, tables did not draw column alignment, the sorted copy's bar put one of its buttons on a line of its own, and the sort and filter dialog said "The rows of the table are never reordered", which read as if sorting did nothing. Checking the outline fix in the app showed the clicked heading scrolled under the sticky toolbar; it now scrolls to the middle of the pane.

**Known limits**
- The Rust twin of extraction is NS-4A's; the fixtures it must match are in `fixtures/`.
- Export reuses NS-3B's writer. The NS-3B notes record, as a hypothesis not measured here, that the writer is roughly quadratic on long paragraphs of alternating bold runs (about 9 s for 20,000 nodes).
- Math drawn in a sorted copy is not tested; pictures and links in it are.
- A page whose JSON is valid but holds something the schema refuses lists its headings in the outline, and clicking one does nothing, since the page is shown as JSON.
- A list numbered from 1,000,001 draws its number to the left of the page column. A new page, rich or Markdown, opens without the cursor in it.
