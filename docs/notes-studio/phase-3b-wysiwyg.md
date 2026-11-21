# NS-3B: WYSIWYG mode on Tiptap

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

(Filled in when the phase lands.)
