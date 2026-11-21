# NS-3D: `.hmdoc` embeds and drawing

Read [phase-3c-hmdoc.md](phase-3c-hmdoc.md) first. This phase adds typed live embeds, an Excalidraw block, freehand ink and OneNote-style free-positioned blocks to `.hmdoc` pages. No embed is ever an iframe.

## Changes from the NS-0 review

These rules come from the Codex review of the design ([reviews/ns0-codex-review.md](reviews/ns0-codex-review.md)). Where the text below says otherwise, these win.

- An architecture diagram embed stores the system slug and the manifest-relative diagram path, as `system_diagram` requires both; a diagram missing from the manifest renders a placeholder naming it (W3).
- Embeds carry their origin: an embed of private content marks the page, and NS-8A expands embeds itself before sending anything to a model (S10).

## Changes from the code survey before NS-3D

Claude checked the anchors against main at `4417bbf` on 2026-11-21, after NS-3C, and the user settled three questions the same day. Where the text below says otherwise, these win.

- **Scope.** This phase ships the memory note card, the architecture diagram, the code range, the PDF page, the gallery, the Excalidraw block and free-positioned blocks. Mermaid and math need no new node: rich pages already hold NS-3B's code block (a `mermaid` block draws its diagram) and its `mathBlock` and `mathInline` nodes. **Ink is not built**, at the user's choice; `perfect-freehand` is not added.
- **Files are the page's own notebook's (user).** Every file an embed names (code range, PDF, gallery pictures, the Excalidraw scene and preview) is a path from the root of the page's notebook, checked like any notebook path (no `..`, no absolute path, no hidden part). Embeds move with the notebook, and their sources share the page's notebook and so its Private setting, which settles S10 for files. Memory note cards and diagrams come from Living Memory; NS-8A expands embeds itself before sending anything to a model. A file outside the notebook is copied in first.
- **Schema version stays 1.** The new nodes are added to version 1. A build from NS-3C opens a page that uses one as read-only JSON naming the unknown node, which is safe; raising the version would make every page read-only there, including pages that use none.
- **One shape for embeds.** Each kind is an atom block node with its stored attributes plus `title` (what a placeholder and the extracted text show). Drawing an embed never writes the page; only the user's actions (insert, update, edit a drawing) change attributes. Every attribute has a rule in `rules.ts`, and pasted content is checked by `sanitiseSlice` as in NS-3C.
- **Memory note card** `{ ref, title }`: drawn from `read` as the viewer (title, type, status, the first lines of the body); a click opens the note tab. Without Living Memory, or for a missing note, a placeholder shows the stored title.
- **Architecture diagram** `{ system, path, title }`: drawn with `system_diagram` (a data URL); the picker lists the systems and their manifest diagrams (W3: a diagram missing from the manifest shows a placeholder naming it).
- **Code range (user)** `{ file, from, to, sha256, text, language, title }`: the page stores a copy of the lines (`text`, at most 200 lines and 20,000 characters) and the sha256 of those lines joined with LF. The block shows the file's current lines through `file_read`, in a read-only CodeMirror highlighted by the file's language, as the review diff does (`src/features/review/CodeDiff.tsx` with `loadLanguage`). When their hash differs it shows "Changed since embedded" and Update, which stores the current lines and hash. A missing file or a range past its end shows the stored lines with a note saying so.
- **PDF page** `{ file, page, title }`: `pdfjs-dist` with `isEvalSupported: false` and its worker bundled by Vite, loading the file through the notebook's `hmfile` grant with Range requests. A page draws when it scrolls into view, at the pane width.
- **Gallery** `{ images, columns, title }`: two to four columns of notebook pictures through the `hmfile` grant; a click opens a lightbox (arrows move, Escape closes).
- **Excalidraw** `{ scene, preview, title }`: the scene is a `.excalidraw` JSON file and the preview a PNG, both in the page's attachments folder with the same stem. The preview is saved through the existing attach path (a new file each time), and the preview it replaces goes to the notebook's trash. The scene is written with `file_create` and then `file_save` with its hash precondition. Editing opens Excalidraw full screen (Done, Cancel); it is a lazy chunk with its fonts and assets served by Hivemind itself, and collaboration, library browsing and links to excalidraw.com are off. Any CSP change it needs names only Hivemind's own origin and is recorded in section 6.
- **Free-positioned blocks.** A `freeform` block (with a stored `height`) holds `frame` nodes `{ x, y, w, h, z }`, each holding normal blocks but no freeform. A frame moves by its handle and resizes by its corner, snapped to 8 px; the block grows to fit. Extraction and export read frames top to bottom, then left to right.
- **Export to Markdown** writes what Markdown can hold and reports each kind with a count: a note card as a line with its title and ref, a diagram as a line naming it, a code range as a fenced block of its stored lines under a `file:from-to` line, a PDF page as a link to the file and page, a gallery as its pictures, an Excalidraw block as its preview picture, free-positioned frames one after another. The completeness test from NS-3C must cover every new node and attribute.
- **Extraction** gives each embed its title; a code range adds its stored lines and a gallery its picture paths. The fixtures in `fixtures/` gain a page with every embed.
- **Insert.** The slash menu and the toolbar of a rich page offer each kind, opening a picker. A test checks that no `<iframe` appears in `src/`.

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

Code landed on 2026-11-21: Hivemind `d201b86` (the phase, with the fixes from Claude's review of the diff) and `564865d` (fixes from the UI pass). At the user's request this phase had no Codex review; Claude reviewed every diff. No Rust or Living Memory change was needed, and the CSP is unchanged.

**What differs from the survey above and sections 1 to 4.**
- New files are in `src/features/hmdoc/blocks/`: `embeds.ts` (the six atom nodes), `embedViews.ts`, `EmbedDialogs.tsx` (pickers), `codeRange.ts` and `hash.ts` (a synchronous SHA-256), `pdf.ts`, `drawing.ts`, `DrawingDialog.tsx`, `excalidrawLoader.ts`, `freeform.ts`, `layout.ts`, `insert.ts` and `items.ts` (slash menu and the toolbar's Insert an embed menu). `RichContext` gains `notebook` (the page's notebook files, folder notebooks only); `isNotebookPath` in `src/lib/notebooks.ts` mirrors Rust's path checks.
- `pdfjs-dist` 6 has no `isEvalSupported` option and no longer evaluates code; it runs with `useWasm: false` because the CSP allows no WebAssembly, so JPEG 2000 and JBIG2 pictures inside a PDF do not draw.
- Excalidraw's fonts are served by a Vite plugin (`hivemind-excalidraw-assets` in `vite.config.ts`) from `/excalidraw-assets/fonts/`, without the Xiaolai family (13 MB): Chinese, Japanese and Korean text in a drawing uses a system font. Collaboration, AI, export, the library and help are off or hidden, and links inside a drawing do nothing.
- Excalidraw's own nested packages brought 12 npm advisories; `overrides` in `package.json` lift them (lodash-es, nanoid, and katex inside mermaid-to-excalidraw, which Hivemind never calls), and `npm audit` reports none.
- A drawing's preview is saved first and the scene is named after it; after an edit the preview is a new file (`Sketch 1.png`, then `Sketch.png` again) and only a PNG beside the scene with its stem is ever moved to the trash. A scene changed on disk is never overwritten: the dialog offers to save a new drawing.
- A pasted embed with a refused attribute is left out rather than given a default, and a note card ref starting with `-` is refused (it is passed to `alm read` as an argument).
- A PDF or code file must already be in the notebook: the attach path takes pictures only, so only the gallery offers "Add pictures from your computer".
- Frames keep inside the block's width, snapped down to the 8 px grid, with 32 px of block below the lowest one; the block is its own stacking context.

**Verified**
- `npm test` (130 files, 1,404 tests, one skipped: the NS-3A 1 MB timing check), `npx tsc --noEmit`, `npm run build` and `npm audit` (0). The `.hmdoc` editor chunk is 51 KB; pdf.js (444 KB plus a 1.2 MB worker) and Excalidraw (1.1 MB plus 142 KB of CSS) are lazy chunks; the main chunk grew 58 KB, which the build attributes to shared CodeMirror code moving into it rather than new library code. The Excalidraw fonts are 500 KB.
- Every new node and attribute has a rule, extraction text, an export with a report count (the NS-3C completeness test covers them), and a paste test; a fixture page with every embed (`fixtures/embeds.hmdoc`) reopens identically and extracts to `embeds.txt`; a test finds no `<iframe` in `src/`.

**UI pass (2026-11-21).** The dev app ran against a scratch store (with one note for the card) and a folder notebook outside any bound folder, driven over WebView2 remote debugging:
- A page with a note card, three code ranges (current, changed, file missing), a PDF page and a gallery opened without changing the file. The card showed the note's title, type, status and first lines; its title opened the note tab.
- The code ranges were highlighted with line numbers; the changed one showed "Changed since embedded", and Update stored exactly the file's current lines and their SHA-256, the only change in the saved diff. The missing file showed the stored lines with a note.
- pdf.js drew page 2 of a three-page PDF through the notebook's grant, with no console or CSP errors.
- The gallery's pictures drew; a click opened the lightbox, the arrow keys moved, Escape closed it and focus went back to the picture.
- The slash menu offered every kind. A new drawing opened Excalidraw full screen with Excalifont loaded from `/excalidraw-assets/`; Escape did not close it. Done wrote the scene and preview into `attachments/`; editing it again saved the scene with an added shape, pointed the page at a new preview and moved the old one to the notebook's trash; Cancel without changes closed it.
- A free-positioned block took typing in its frame, Add a frame, moves and resizes; each change saved, frames stopped at the block's right edge on the grid, and the block slid under the toolbar when scrolled.

The pass found eight problems, fixed in `564865d`: frame drags could leave the drawn position and the document apart so the change was lost (the drag now listens on the window and always ends from the document), frames could pass the block's right edge so its scrollbar covered the lowest corner, a fractional pane width still left a scrollbar strip, clamped values fell off the grid, frames and the block's bar drew over the toolbar, Excalidraw's dead Library button and help button showed, the Edit drawing button was unreadable over a white preview, and a code range repeated its label.

**Known limits**
- Ink is not built (the user's choice).
- The architecture diagram embed was not driven in the UI pass, since the scratch store has no system with Architecture Suite output; its picker, placeholder and rules have tests.
- A note card shows its body's first lines as plain text, Markdown marks included.
- A page made in a wider pane and opened in a narrower one may scroll sideways inside its free-positioned block.
