# NS-3D: `.hmdoc` embeds and drawing

Read [phase-3c-hmdoc.md](phase-3c-hmdoc.md) first. This phase adds typed live embeds, an Excalidraw block, freehand ink and OneNote-style free-positioned blocks to `.hmdoc` pages. No embed is ever an iframe.

## 1. Embed kinds

| Kind | Stored attributes | Renders | Source |
| --- | --- | --- | --- |
| Memory note card | `ref` | Title, type, summary, status; click opens the note | bridge `read` with `--actor viewer` |
| Architecture diagram | `system` | The system's diagram image | existing `system_diagram` command |
| Code range | `file` (FileRef or GrantRef), `from`, `to`, `sha256` | Highlighted lines; a "changed since embedded" badge when the hash differs | `file_read` |
| PDF page | `file`, `page` | One page drawn to a canvas with `pdfjs-dist` (`isEvalSupported: false`, bundled worker) | `hmfile` with Range |
| Mermaid | `source` | `src/ui/Mermaid.tsx` | |
| Math | `tex`, `display` | KaTeX | |
| Gallery | `images[]`, `columns` | Grid with a lightbox | `hmfile` |
| Excalidraw | `scene` (attachment path to a `.excalidraw` JSON), `preview` (PNG attachment) | Preview image; editing opens Excalidraw full screen | lazy `@excalidraw/excalidraw` with fonts and assets hosted locally |
| Ink | `strokes[]` (points with pressure) | SVG paths from `perfect-freehand` | Pointer Events with pen pressure |

## 2. Free-positioned blocks

A `freeform` node whose children are `frame { x, y, w, h, z }` nodes, each holding normal block content. Frames move and resize with pointer events and snap to an 8 px grid; the canvas scrolls and grows. Text extraction reads frames top to bottom, left to right. Export to Markdown flattens frames in that order and reports it.

## 3. Rules

- Embeds store what they need to re-render; a missing source shows a placeholder with the stored title, never an error page.
- Excalidraw scenes and previews are attachments, so the `.hmdoc` stays small and diffable.
- Every embed has a deterministic text for search and AI (title, caption, OCR is out of scope).

## 4. Files

`src/features/hmdoc/blocks/{noteCard.tsx, diagram.tsx, codeRange.tsx, pdfPage.tsx, mermaid.tsx, math.tsx, gallery.tsx, excalidraw.tsx, ink.tsx, freeform.tsx}`; CSP `worker-src 'self'` (from NS-1B). Dependencies: `pdfjs-dist`, `@excalidraw/excalidraw`, `perfect-freehand`.

## 5. Tests and exit

vitest for each block's attribute validation, extraction text and export flattening; drive_ui screenshots; every embed round-trips through save and reopen; a grep confirms no `<iframe` in `src/`. Memory regression pass.

## 6. Shipped

(Filled in when the phase lands.)
