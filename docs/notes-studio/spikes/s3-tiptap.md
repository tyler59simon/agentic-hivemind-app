# S3: Tiptap and the block-preserving serializer (verdict: adopt in NS-3B, with one design change)

Measured on 2026-11-20 in a scratch Vite and Node project. This spike checked the assumptions the serializer depends on (licences, bundle cost, node identity, exact source slices). The serializer itself is built and tested on the full corpus in NS-3B.

## Licences

- Tiptap 3.35.0, all MIT: `@tiptap/core`, `pm`, `starter-kit`, `extension-table`, `extension-list`, `extension-image`, `extension-highlight`, `extension-text-style`, `extension-placeholder`, `extension-drag-handle`, `extension-details`, `extension-mathematics` and `extension-unique-id`.
- ProseMirror: `prosemirror-model` 1.25.13 and `prosemirror-tables` 1.8.5, MIT.
- Markdown pipeline, all MIT: `unified` 11.0.5, `remark-parse` 11.0.0, `remark-gfm` 4.0.1, `remark-frontmatter` 5.0.0, `remark-math` 6.0.0 and `mdast-util-to-markdown` 2.2.4.
- `extension-unique-id` stays excluded because it rewrites nodes.

## Bundle

The test bundle held an editor with StarterKit, TableKit, Image, Highlight, TextStyleKit, Placeholder and task lists, plus the unified and remark pipeline. It came to 603 KB minified and 193 KB gzipped, over 25 lazy chunks. The plan's estimate of 100 to 140 KB did not include the remark pipeline; the README dependency table now has the measured figure. Rich mode loads the editor only when a page opens in that mode.

## Node identity

The test used a real Tiptap editor under jsdom with all of the extensions above, on a 40-block document of headings, lists, tables and paragraphs.

- Inserting text into one block left the other 39 top-level nodes as the same objects.
- Bolding text in one block and appending a block left 38 of 40 as the same objects.
- After three undos the document equalled the original (`doc.eq`), but the two blocks that had been edited were new objects.

**Change to NS-3B.** When a block is missing from the identity map, the serializer compares it with `node.eq` against the original block at the same index, and failing that against a map of original blocks keyed by a content hash. An equal block emits its original source slice. Without this, undoing an edit would re-serialise those blocks in the detected style.

## Source slices

remark (`remark-parse`, `remark-gfm`, `remark-frontmatter`, `remark-math`) parsed 120 Markdown files from this repository, `agentic-living-memory` and `architecture-suite-plugin`. Each file was tested in four variants: LF, CRLF, with a BOM, and without a final newline. For all 480 variants, the top-level node slices plus the gaps between them reproduced the file exactly. Neither the BOM nor CRLF shifted the offsets.

## Not yet measured

Whether ProseMirror's block drag (the drag handle) works while Tauri's drop handler is on. It needs the running app, so it is checked at the start of NS-3B. If it fails, Rich mode offers move-up and move-down commands instead.
