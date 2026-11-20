# NS-7C: canvas boards

Read [README.md](README.md) first. Canvas boards use the open JSON Canvas format (`.canvas`, as Obsidian writes it), so boards move between Hivemind and Obsidian.

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
