# NS-7C: canvas boards

Read [README.md](README.md) first. Canvas boards use the open JSON Canvas format (`.canvas`, as Obsidian writes it), so boards move between Hivemind and Obsidian.

## Changes from the code survey before NS-7C

Claude surveyed main at `6007ce8` on 2026-11-22. Where the text below says otherwise, these win.

- **The index already reads canvases.** NS-4A's `notes_index/extract.rs` (`canvas()`) indexes text node content, headings, tags and links, and `PageKind` includes `canvas`. This phase adds no index work beyond file references if `canvas()` misses them.
- **A `.canvas` file opens as plain JSON text today.** The board is a new editor loaded lazily in `FileTab.tsx`, as `HmdocEditor` is for `.hmdoc` (NS-3C), with Board and Source modes. It edits the page through the document session (`src/documents/store.ts`), so saving, drafts, history, the hash precondition and the changed-on-disk banner work as for every page. The doc's "keep mine, keep theirs, save both" is that existing conflict flow, not a new one.
- **Pictures and PDFs on file nodes** load through the notebook asset grant (`asset_base`, the `hmfile` scheme), as NS-3D embeds do in `src/features/hmdoc/blocks/embedViews.ts`.
- **Memory note cards** reuse the NS-3D memory note card (`noteCard` in `embedViews.ts`) where it fits.
- **Notebook tree rows are not draggable today.** Dragging a page onto a board needs the tree rows to set a drag payload (notebook id and path) that only the board accepts; the tree's own behaviour must not change.
- **New canvas** is a notebook and folder menu action next to New page, making `Untitled.canvas` with `{"nodes":[],"edges":[]}`.
- **Rendering:** plain DOM and CSS transforms unless the spike shows `@xyflow/react` is clearly better; record the decision and the reason in section 4. A new dependency is pinned at an exact version.

## 1. What the user sees

- **New canvas** in a folder notebook. An infinite board with pan and zoom; nodes: **text** (Markdown, edited in place), **file** (a page, an image or a PDF from the notebook, rendered as a card or the image), **link** (a URL shown as a card with its title, never an iframe), **group** (a labelled box). Edges between node sides, with labels and arrowheads. Colours from the JSON Canvas preset set, mapped to theme tokens.
- Drag pages from the notebook tree onto the board; double-click a file node to open it in a tab.
- Memory notes can be placed as file-like cards (stored as a link node with a `hivemind:mem:` URL in a Hivemind field, so Obsidian shows a plain link).

## 2. Design

- `src/features/canvas/{model.ts, CanvasBoard.tsx, nodes/*}`: the model reads JSON Canvas 1.0, keeps unknown node and edge fields and unknown top-level keys on save, and writes stable key order.
- Rendering with plain DOM and CSS transforms (no new dependency) unless the spike in this phase shows that `@xyflow/react` (MIT) is clearly better; the decision is recorded here.
- Text extraction for the index: text node content and file references (NS-4A extractor).
- Conflicts: keep mine, keep theirs, save both.

## 3. Tests and exit

vitest: model round trip with unknown fields, edge validation, colour mapping. Exit: an Obsidian-made canvas opens and saves without losing any field; Memory regression pass.

## 4. Shipped

(Filled in when the phase lands.)
