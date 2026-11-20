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
- PDF export: render the HTML in a hidden window and call WebView2 `PrintToPdf` through `webview2-com` (pinned to the version Tauri already uses) from `with_webview`, per spike S8.
- `src-tauri/src/export.rs` holds save dialogs, image inlining and the PDF call.

## 3. Tests and exit

vitest: paste conversion fixtures (browser article, Word list, table), DOCX tree mapping, export reports. cargo: image inlining containment, PDF call wiring behind a fake. Exit: a real vault opens with its attachment and link settings honoured; exports open in Word and a PDF reader; Memory regression pass.

## 4. Shipped

(Filled in when the phase lands.)
