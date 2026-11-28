# NS-9A: Obsidian vaults, paste conversion and export

Read [README.md](README.md) and the S8 spike verdict first.

## Changes from the NS-0 review

These rules come from the Codex review of the design ([reviews/ns0-codex-review.md](reviews/ns0-codex-review.md)). Where the text below says otherwise, these win.

- Export targets chosen in the save dialog run `files::guard` (S2).

## 1. What the user sees

- **Obsidian vaults:** registering a folder that contains `.obsidian` marks the notebook as a vault. Hivemind reads (never writes) `.obsidian/app.json` (`attachmentFolderPath`, `newLinkFormat`, `useMarkdownLinks`, `alwaysUpdateLinks`), `daily-notes.json` and `templates.json`, and follows them: new attachments go where Obsidian would put them, new links use the vault's style (wiki or Markdown, shortest path or relative), daily notes and templates use the vault's settings. A notebook settings section shows what was read. The Living Memory-managed vault stays refused (NS-1A).
- **Paste:** pasting HTML (from a browser, Word, Outlook) into a Markdown page converts it to clean Markdown (headings, lists, tables, links, bold and italic, code); images in the clipboard become attachments; Ctrl+Shift+V pastes plain text. In Rich mode and `.hmdoc` pages, HTML is parsed into the editor schema instead.
- **Export** a page, a section or a whole notebook: **HTML** (one file per page or a single file, images inlined as data URLs, the current or a print theme), **DOCX** (headings, lists, tables, images, links, code as monospace), **PDF** (print quality through WebView2). Each export lists anything it could not carry over (embeds become images or links, canvases become an image or are listed).

## 2. Design

- Paste: sanitise with `dompurify` (no scripts, no event handlers, no styles beyond a small allowlist), then `turndown` with `turndown-plugin-gfm` for Markdown; ProseMirror's `DOMParser` for rich editors. Word's `mso-` list markup is normalised before conversion.
- HTML export renders pages with the same React Markdown pipeline as Reading view into a static string (no scripts), inlines images through Rust reads (containment-checked), and saves through a save dialog with an atomic write.
- DOCX export builds a document with the `docx` package (lazy) from the mdast or `.hmdoc` tree.
- PDF export goes through `platform::print::PrintBackend` (`src-tauri/src/platform/print.rs`, DOCOS-1A): WebView2 `PrintToPdf` on Windows, a WKWebView print operation that saves to a file on macOS. It prints the calling webview, so the page is drawn into `.print-root`, the only thing the `@media print` rules in `App.css` show, rather than into a hidden window.
- `src-tauri/src/export.rs` holds save dialogs and image inlining for HTML and DOCX; the PDF call is `PrintBackend`.

## 3. Tests and exit

vitest: paste conversion fixtures (browser article, Word list, table), DOCX tree mapping, export reports. cargo: image inlining containment, PDF call wiring behind a fake. Exit: a real vault opens with its attachment and link settings honoured; exports open in Word and a PDF reader; Memory regression pass.

## 4. Shipped

- **DOCOS-1A (2026-11-28):** Export to PDF for Markdown pages, from the page's actions menu and the command palette. `features/notes/printPage.tsx` draws the page's Reading view into `.print-root` with pictures loaded at once, waits until embeds, queries, diagrams, math and pictures have drawn, then calls `page_export_pdf` (`src-tauri/src/opens.rs`), which asks where to save, prints to a temporary file and writes it through the Save As guards and history. A4 portrait with 0.4 inch margins; no options yet. The rest of this phase (vault settings, paste, HTML and DOCX export, print) is DOCOS-1E.
