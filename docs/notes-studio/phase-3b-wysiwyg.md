# NS-3B: WYSIWYG mode on Tiptap

Read [README.md](README.md) and the S3 spike verdict first. This phase adds a fourth mode to Markdown pages, **Rich**, where no Markdown syntax is visible. The file stays Markdown: blocks the user did not touch are written back byte for byte, and only edited blocks are re-serialised.

## 1. What the user sees

- Mode tabs on a Markdown page: Reading, Live, Rich, Source. The choice is remembered per tab.
- Rich mode edits headings, lists, task lists, quotes, callouts, tables, code blocks, images, links, wiki links, embeds, math, footnotes and highlights with a toolbar, a slash menu, keyboard shortcuts and block drag handles (if spike S3 confirms drag works with Tauri's drop handler; otherwise move-up and move-down commands).
- Constructs Rich mode cannot represent (raw HTML blocks, link reference definitions, unknown fences such as Dataview, frontmatter) show as grey source boxes edited in an embedded CodeMirror.
- Switching modes never changes the file by itself.

## 2. Design

- Parse with `unified` + `remark-parse` + `remark-gfm` + `remark-frontmatter` + `remark-math` + small micromark extensions for `[[...]]`, `![[...]]`, `==...==`, `%%...%%` and `^block-id`; turn `> [!type]` quotes into callout nodes. Every mdast node keeps its position.
- Map mdast to a ProseMirror schema (`src/features/rich/schema.ts`) shared with `.hmdoc` (NS-3C) where node types overlap.
- **Preservation:** at load, record a `WeakMap<PMNode, { start, end }>` for each top-level block, plus the exact gap text between blocks and after the last. ProseMirror keeps the identity of untouched nodes through transactions, so "in the map" means "untouched". Undo is the exception (spike S3): a block that was edited and then undone is equal to the original but is a new object. So a node missing from the map is compared with `node.eq` against the original block at the same index, then against a map of original blocks keyed by a content hash; an equal block counts as untouched. Serialising walks the new document: untouched nodes emit their gap and original slice; changed or new nodes go through `mdast-util-to-markdown` with options detected from the file (bullet marker, emphasis marker, fence style, rule style, list indent).
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
