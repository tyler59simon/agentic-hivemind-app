# NS-3B: WYSIWYG mode on Tiptap

> **Removed on 2026-11-24 (CON-19).** The user decided to delete Rich mode for Markdown pages; Markdown pages keep Reading, Live, Source and History. The Tiptap editor, schema, toolbar, slash menu and Markdown reader and writer built in this phase stay, because the `.hmdoc` editor (NS-3C) is built from them. The byte-preserving serializer (`preserve.ts`) and the Rich mode tab are gone. A tab saved in Rich mode opens in Live. This document is kept as the design record.

Read [README.md](README.md) and the S3 spike verdict first. This phase adds a fourth mode to Markdown pages, **Rich**, where no Markdown syntax is visible. The file stays Markdown: blocks the user did not touch are written back byte for byte, and only edited blocks are re-serialised.

## Changes from the NS-0 review

These rules come from the Codex review of the design ([reviews/ns0-codex-review.md](reviews/ns0-codex-review.md)). Where the text below says otherwise, these win.

- Block ownership: at parse, every top-level block gets a `srcId` attribute (its index in the original document), set when the document is built, never by an `appendTransaction`. On save, a block emits its original source slice only if it is the first block carrying its `srcId` and `node.eq(original[srcId])`; the original gap before it is emitted only when the previous emitted block is `srcId - 1`. Copies, moves, inserts and undo therefore never reuse a slice they do not own; everything else goes through the serializer. This replaces the identity WeakMap and the `node.eq` fallback (C5).
- Files with mixed line endings are read-only (NS-1A), so Rich mode never edits them; it works on the file service's LF text and file-level format. Round-trip tests run through the file adapter and `file_save` (BOM, CRLF, no final newline), not on source slices alone (C4). Tests also cover equal blocks with different spellings and gaps, copy, move, delete and undo (C5).
- Round 2: the text before the first block (the prefix) is emitted only when the first emitted block is the original first block (`srcId` 0) and still owns its slice; the text after the last block (the suffix) only when the last emitted block is the original last block. Tests cover leading blank lines, frontmatter-free files, and edits and moves at both ends (C5).

## Changes from the code survey before NS-3B

Claude checked the anchors against main at `bd6723d` on 2026-11-21, after NS-3A. Where the text below says otherwise, these win.

- **The parser agrees with Live.** Pages are parsed with `mdast-util-from-markdown` and the micromark extensions for GFM and frontmatter (the packages `remark-parse`, `remark-gfm` and `remark-frontmatter` wrap; no `unified` processor is needed). Obsidian syntax comes from Hivemind's own micromark extensions in `src/features/rich/micromark/`, written to the rules of NS-3A's `richSyntax` so Rich and Live see the same constructs: `==highlight==` and `%%comment%%` pair like the Live parser's delimiters, `$x$` follows Obsidian's rules (so "$5 and $6" stays text), a `$$` line runs to the next line ending in `$$`, and `[[link]]` and `![[embed]]` are single tokens. `remark-math` is not used: its `$` rules differ from Live's, and `micromark-extension-math` depends on a KaTeX version with a published advisory. A `^block-id` stays text: nothing escapes it and Rich has nothing to draw for it until NS-4A links to blocks.
- **Lossless or raw, per block.** When a page opens, every top-level block is converted from mdast to the editor's document and back, and the two mdast trees are compared (positions, the nesting order of marks and short table rows aside, since the editor cannot hold them). A block that does not come back equal opens as a grey source box (`rawBlock`). Rich mode therefore never shows a block it would write back differently. The same check is the per-block fidelity assertion of section 4.
- **Edited blocks keep their prose unescaped where they can.** `mdast-util-to-markdown` escapes every `[`, `*` and similar character in text. An edited block is written twice, once without text escapes and once with them; the first is used when parsing it again (with the page's link and footnote definitions) gives the same block, so "see [this]" stays as written.
- **Mode.** The workspace `Mode` gains `rich`, shown as "Rich" between Live and Source and remembered per tab like the others. An older build that reads a `rich` tab shows it as Source. A page over `RICH_LIMIT` (1,000,000 characters) shows a banner in Rich and opens in Source instead of building a document that large. A read-only page (mixed line endings, a parked page of another store, a file arriving) opens Rich read-only.
- **Sync.** The Rich editor serialises after every transaction that changes the document and hands the text to the document store, as CodeMirror does; when the store's text changes from elsewhere (a merge, a reload, a followed outside edit), the editor is rebuilt from it and its undo history starts again.
- **Block dragging uses pointer events.** Tauri's drop handler is on (NS-3A routes dropped files through it), and with it on WebView2 delivers no HTML5 drag events inside the page, the reason the notebook tree already uses pointer events. Rich mode has its own pointer-event handle beside each top-level block and Alt+Shift+Up and Alt+Shift+Down to move a block; `@tiptap/extension-drag-handle` is not installed.
- **Dependencies installed:** `@tiptap/core`, `pm`, `react`, `starter-kit`, `extension-table`, `extension-list` and `extension-placeholder` (3.35.0, MIT); `mdast-util-from-markdown`, `micromark-extension-gfm`, `mdast-util-gfm`, `micromark-extension-frontmatter`, `mdast-util-frontmatter`, `mdast-util-to-markdown` and `micromark-util-character` (MIT, most already present through `react-markdown`). Images, highlights, math, callouts, wiki links, embeds, footnotes and source boxes are Hivemind's own nodes, so `extension-image` and `extension-highlight` are not needed. StarterKit's `TrailingNode` (appends an empty paragraph) and `Underline` (no Markdown form) are off.
- **What Rich draws, from NS-3A.** Pictures, embeds, links and attachments use the page's `RichContext` (`src/features/editor/rich/context.ts`), so pictures load through the same grant, `![[Page]]` draws the embedded page as in Live, Ctrl+click follows links, and a pasted or dropped picture is attached the same way (`registerDropTarget` takes drops on the Rich editor). Code blocks are plain text without syntax colours; a `mermaid` block shows its diagram below the code and math shows through KaTeX.
- **Files** live in `src/features/rich/`: `micromark/` (syntax), `markdown.ts` (parse and stringify options), `schema.ts` (Tiptap extensions and nodes), `fromMarkdown.ts`, `toMarkdown.ts`, `preserve.ts` (ownership and gaps), `views.tsx` (node views), `RichEditor.tsx`, `toolbar.tsx`, `corpus/` and the tests.
- **Line endings and BOM.** Round-trip tests run the corpus through the Living Memory adapter's `pageText` and `pageBody` (CRLF, BOM, no final newline) and compare bytes; folder notebooks save through `files::save` with the same file format, which NS-1B's tests cover.

## 1. What the user sees

- Mode tabs on a Markdown page: Reading, Live, Rich, Source. The choice is remembered per tab.
- Rich mode edits headings, lists, task lists, quotes, callouts, tables, code blocks, images, links, wiki links, embeds, math, footnotes and highlights with a toolbar, a slash menu, keyboard shortcuts and block drag handles (if spike S3 confirms drag works with Tauri's drop handler; otherwise move-up and move-down commands).
- Constructs Rich mode cannot represent (raw HTML blocks, link reference definitions, unknown fences such as Dataview, frontmatter) show as grey source boxes edited in an embedded CodeMirror.
- Switching modes never changes the file by itself.

## 2. Design

- Parse with `unified` + `remark-parse` + `remark-gfm` + `remark-frontmatter` + `remark-math` + small micromark extensions for `[[...]]`, `![[...]]`, `==...==`, `%%...%%` and `^block-id`; turn `> [!type]` quotes into callout nodes. Every mdast node keeps its position.
- Map mdast to a ProseMirror schema (`src/features/rich/schema.ts`) shared with `.hmdoc` (NS-3C) where node types overlap.
- **Preservation:** at load, record each top-level block's source slice `{ start, end }` and the exact gap text between blocks and after the last, and give each block a `srcId` attribute (see the review changes above for the ownership rule). Serialising walks the new document: blocks that still own their original emit their gap and original slice; changed or new nodes go through `mdast-util-to-markdown` with options detected from the file (bullet marker, emphasis marker, fence style, rule style, list indent).
- Never install extensions that rewrite every node (Tiptap `UniqueID`, normalising `appendTransaction` plugins); a test fails if any node loses identity after a no-op transaction.
- `rawBlock` and `rawInline` atoms hold exact source for anything the schema cannot model.
- CRLF: original slices keep their bytes; new blocks are written with `\n` and the file service converts line endings (NS-1B), so a CRLF file stays CRLF.
- Editing one item of a list rewrites that whole list (the top-level block is the unit).
- The Rich editor is a lazy chunk (`@tiptap/*`, `unified` and friends).

## 3. Files

`src/features/rich/{schema.ts, fromMarkdown.ts, toMarkdown.ts, preserve.ts, micromark/*.ts, RichEditor.tsx, toolbar.tsx, corpus/, roundtrip.test.ts}`. Dependencies per the README table; check every Tiptap package's licence field (Pro packages excluded).

## 4. Tests

Corpus in `src/features/rich/corpus/` (Living Memory note fixtures from `scripts/gen_note_fixtures.py`, GFM tables and tasks, Obsidian syntax, CRLF, BOM, no trailing newline, mixed endings, nested lists, HTML blocks, math, footnotes, Mermaid fences, a 1 MB page; no CommonMark spec examples, which are CC BY-SA). Four assertions: identity `serialize(parse(x)) === x`; locality (an edit to block k leaves every other block byte-identical); per-block fidelity (forcing a block through the serializer gives an mdast equal to the original, positions aside); a Source, Rich, Source switch with no edits leaves the bytes unchanged. `prosemirror-model` runs in Node without a DOM.

## 5. Exit

All four corpus assertions pass; Rich edits on real pages produce minimal diffs; Memory regression pass.

## 6. Shipped

Code landed on 2026-11-21: Hivemind `2392f6b` (the phase), then `b0afec0`, `ad6c5c5` and `2cc08d7` (fixes from three Codex review rounds) and `2720fbc` (fixes from the UI pass). No Living Memory or Rust change was needed.

**What differs from sections 2 and 3 and the survey above.**
- `@tiptap/react` is not installed: the editor is Tiptap core with DOM node views (`views.ts`, not `views.tsx`), and React draws only the toolbar, the slash menu, the popovers (`popovers.tsx`) and the block handle. `@tiptap/extension-code` and `extension-code-block` are direct dependencies so the code mark and block can be configured, and `micromark-util-chunked` is direct since the round 2 fix.
- Editing helpers (input rules for `[[`, `![[` and `$`, the slash menu plugin, block moves, picture markers, paste and copy) are in `editing.ts` and `slash.ts`; the tree comparison is `canon.ts`.
- Lists hold `listItem` and `taskItem` together; there is no task list node, so a list can mix tasks and plain items as Markdown does.
- A list of more than 32 items is written item by item, each item's text remembered with its node, and the whole list is written at once only when its items would not keep one marker. This replaces "editing one item of a list rewrites that whole list" for long lists (UI pass).
- The 1 MB corpus page is a generated page in `roundtrip.test.ts`, not a file in `corpus/`.

**Verified**
- `npm test` (104 files, 960 tests, one skipped: the NS-3A 1 MB timing check), `npx tsc --noEmit` and `npm run build` (the Rich editor is a lazy chunk of 501 KB, 159 KB gzipped). `npm audit`: 0 vulnerabilities.
- The corpus (seven hand-made pages, this repository's `docs/` and the note fixtures, in LF, CRLF, BOM, no-final-newline and combined variants; 3,218 blocks, none shown as a source box): identity, locality, per-block fidelity and the mode switch, as section 4 asks.
- Three read-only Codex reviews (15, 9 and 5 findings), each finding checked before it was fixed, each fix with a regression test checked to fail without it: [reviews/ns3b-codex-review.md](reviews/ns3b-codex-review.md).

**UI pass (2026-11-21).** The dev app ran against a scratch store and a folder notebook outside any bound folder, driven over WebView2 remote debugging:
- The NS-3A page with every construct opened in Rich without changing the file: pictures in both syntaxes through the grant, the Mermaid diagram, inline and display math, the `![[Embedded#Goals]]` section, both callouts, the footnote reference, the highlight and the comment.
- Text typed at the end of one paragraph and Ctrl+S changed that line only; the file kept its CRLF line endings. `*rich*` typed became italic through the input rule and was written `*rich*`.
- A block dragged by its grip above the table, and another moved with Alt+Shift+Up: the saved diff was the move alone. Two Undos gave back the file as it was before the moves.
- Markdown pasted from the clipboard (a synthetic paste event) became a heading, two task items and a table, written as Markdown; ticking a task saved `- [x]`.
- The HTML corpus page showed eight source boxes and nine inline source runs, all editable, with the file unchanged. The 1.1 MB page showed the banner and opened as source.
- Ctrl+E inside Rich kept the tab in Rich. A memory note opened, took edits and was checked by Living Memory's capture rules on Save, as before.
- Not driven: a picture dropped from Explorer (it needs a real desktop drag; the drop target and the attach path have tests).

The pass found four problems, fixed in `2720fbc`: callout type menus showed open on load (their display rule beat the `hidden` attribute), task items drew the bullet, checkbox and text on three lines (Tiptap 3's task item view sets `data-checked` but not `data-type`), every node view was drawn twice when Rich opened, and typing in a 3,000-item list took about 640 ms per key because each key rewrote the whole list. The same list now takes about 71 ms per key in the dev build; a short page takes about 12 ms.

**Known limits**
- Opening a page near the 1 MB limit in Rich is slow. A 950 KB page of 17,000 headings and 17,000 tables (34,706 blocks) took 10.8 s in the dev build: about 3 s to parse and check it with micromark's development build, 1.5 s to build the editor, all done twice because React's StrictMode mounts the editor twice in development. A production build mounts once and uses micromark's production build; it was not measured.
- micromark is quadratic on a long paragraph full of `**` or `~~` runs that never pair (16,000 runs took about 3 and 5 s), and Rich inherits this up to its limit. The `==` and `%%` constructs are Hivemind's own and are linear.
- Editing one item of a list of up to 32 items rewrites that list in the page's style; a longer list rewrites the edited items only.
- Tables hold one paragraph per cell, so merging cells is not offered; a pasted HTML table with a cell spanning columns is written as the Markdown of its cells.
- A `^block-id` stays text, and `![[Page]]` resolves within the page's own notebook until NS-4A.
- A page over 1,000,000 characters opens in Source.
