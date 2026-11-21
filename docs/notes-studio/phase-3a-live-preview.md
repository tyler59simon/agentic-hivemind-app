# NS-3A: rich live preview

Read [README.md](README.md) first. This phase grows the CodeMirror live preview for pages (not memory notes) into an Obsidian-style editor: the Markdown text is always the file, and rich blocks render in place until the cursor enters them. Re-check anchors against the code before starting.

## Changes from the NS-0 review

These rules come from the Codex review of the design ([reviews/ns0-codex-review.md](reviews/ns0-codex-review.md)). Where the text below says otherwise, these win.

- Embeds of Living Memory pages and attachments need NS-2C; before it ships they render as plain links (C1).
- An embed (`![[Page]]`) of a page from a private notebook renders inside Hivemind but marks the embedding page as carrying private content, which NS-8A reads (S10).

## Changes from the code survey before NS-3A

Claude checked the anchors against main at `ab899b9` on 2026-11-21. Where the text below says otherwise, these win.

- **Dropped files have one router.** Today Rust's window handler (`opens::dropped`) opens every dropped file as a tab, and the terminal also pastes the paths of a drop that lands on it, so a drop on a terminal does both. A picture dropped on a page would also open as a tab. Rust now keeps the files of a drop under a token and emits `files-dropped { token, names, position }`; the webview decides by position: over a terminal, the terminal pastes the paths and nothing opens; over a page editor that can take a link, pictures are attached through `file_attach_dropped(token, notebook, page)` and linked at the drop point, and any other file opens as before; anywhere else, `open_dropped(token)` opens the files as before. Folders still offer "Add as notebook". Rust reads only files it saw dropped, by token.
- **Pasted pictures go to Rust as raw bytes.** `file_attach_bytes` takes the picture as the raw request body (`tauri::ipc::Request`, not base64 JSON), with the notebook, page and name in headers. A folder notebook writes it into its attachments folder: the sidecar's `attachments` (a path from the notebook root, or `./sub` from the page's folder), or `attachments` when unset; the name is made unique with ` 1`, ` 2`, ...; the write never replaces a file. A Living Memory page writes the bytes to a temp file in the bridge's staging folder and runs `doc attach --from-file`, which names the asset `<sha8>-<name>`, then deletes the temp file. Both take pictures only (the `hmfile` picture types) and at most 25 MB.
- **Links are standard Markdown.** An attached picture is linked as `![name](relative%20path)` from the page's folder, the form NS-2C's Attach file writes and the reading view already loads; Obsidian reads it too. `![[name.png]]` is still rendered when a page has it, found among the notebook's files.
- **The page editor is configured at mount.** `CodeEditor` gets a `rich` context prop (asset URL base and folder, `resolve`, `readEmbed`, `attach`, `openHref`), set only by `FileTab` for Markdown pages. Notes never pass it, so the note editor keeps its extension list exactly. With `rich`, the Markdown language gets the extra syntax (`==highlight==`, `%%comment%%`, `$math$`, `$$` blocks as `@lezer/markdown` extensions) and `codeLanguages` from `@codemirror/language-data` (already a dependency), and the rich decorations sit in their own compartment, switched off above 1,000,000 characters with a banner.
- **Live and Source both get the toolbar, paste and drop;** the rich rendering is Live only. Reading mode renders the same constructs (callouts, highlights, comments hidden, math, `![[Page]]` embeds, picture widths) through small remark plugins and `components` overrides, so a page reads the same in both views.
- **Embeds stay inside the page's notebook.** The link resolver is still NS-1A's same-notebook one until NS-4A, so `![[Page]]` can only show a page of the embedding page's own notebook, which has the same Private setting; the private-content flag of S10 waits for NS-4A's cross-notebook links. An embed shows its target once, read-only; embeds inside an embedded page show as links.
- **Footnotes are found by pattern.** `@lezer/markdown` has no footnote syntax, so `[^id]` references and `[^id]: text` definitions are found outside code by pattern; a reference shows as a superscript whose tooltip is the definition.
- **Links open with Ctrl+click in Live:** web links in the browser, a relative `.md` link as a page, a Living Memory attachment through `lmdoc_open_asset`, and another file of a folder notebook with its default program (`file_reveal` with open, which already refuses programs).
- **Mermaid and KaTeX render outside React.** `src/ui/Mermaid.tsx` exports its drawing function for widgets; KaTeX (`katex` 0.18.10, already in the lock file through Mermaid, now a direct dependency) loads on first use with its stylesheet.
- **Performance check.** The typing budget is checked twice: a vitest benchmark of the `richBlocks` field on a 1 MB page (time per transaction), and the real editor in the UI pass.

## 1. What the user sees

In Live mode on a page:
- **Images** `![alt](path)` and `![[image.png]]` render inline (through `hmfile`), with a size handle that writes `|300` width syntax.
- **Tables** render as an editable grid: Tab and Shift+Tab move between cells, Enter adds a row, a header menu adds, moves, deletes and aligns columns. Every grid edit writes the GFM table text back, re-padded only in the edited table.
- **Callouts** `> [!note] Title` (Obsidian types and `+`/`-` folding) render as styled boxes.
- **Mermaid** fences render through `src/ui/Mermaid.tsx`; **math** `$...$` and `$$...$$` through KaTeX (lazy).
- **Embeds** `![[Page]]` and `![[Page#Heading]]` render the target read-only with a link to open it.
- **Code fences** are highlighted by language (`@codemirror/language-data`, lazy).
- **Footnotes** show as superscripts with a hover preview; **links** are clickable (Ctrl+click in Live, click in Reading); `==highlight==` and `%%comments%%` render.
- A **toolbar** (bold, italic, heading, list, task, quote, code, link, table, image, callout, math) and a **slash menu** (`/` at the start of a line) insert Markdown.
- **Paste or drop an image**: saved to the notebook's attachments folder (folder notebooks) or through `doc attach` (Living Memory), named `Pasted image <yyyymmddhhmmss>.png`, and linked.
- Pages over about 1 MB fall back to today's preview with a banner. Memory notes keep today's preview.

## 2. Design

- CodeMirror rule: block widgets and replacements that cross line breaks must come from a `StateField`, not a `ViewPlugin`. A new field `richBlocks` finds block ranges from the syntax tree (`@lezer/markdown` with GFM, plus small parsers for callouts, `![[...]]`, `$$`, `==`, `%%`), maps decorations through changes, and recomputes only blocks whose syntax nodes changed. Blocks containing a selection show their source.
- Inline marks stay in `livePreview.ts`'s `ViewPlugin`, extended for images inline, highlights and links.
- `CodeEditor` gets an `extensions` Compartment; pages pass `richPreview(ctx)` where `ctx` gives `assetUrl(rel)`, `resolve(target)`, `readEmbed(ref)` and `attach(bytes, name)`.
- Table write-back is a pure function `writeTable(model) -> string` tested on alignment rows, escaped pipes and inline code with pipes.
- Attach: Rust `file_attach(notebook, folder, name, bytes)` (base64 over IPC, 25 MB cap, unique name) for folder notebooks; Living Memory pages use a temp file and `doc attach --from-file`.
- Drops from outside arrive through Tauri's `onDragDropEvent` (WebView2's own drop event has no paths); the drop position is mapped with `view.posAtCoords`.

## 3. Files

`src/features/editor/rich/{blocks.ts, parse.ts, images.ts, tables.ts, callouts.ts, math.ts, mermaid.ts, embeds.ts, code.ts, footnotes.ts}`, `src/features/editor/{toolbar.tsx, slash.ts, attach.ts, CodeEditor.tsx}`, `src-tauri/src/files/mod.rs` (`file_attach`). New dependency: `katex`.

## 4. Tests

vitest for block detection (every construct, nested quotes, fences containing table syntax), table parse and write-back, callout parsing, attach naming, embed resolution. drive_ui screenshots of each construct. A typing benchmark on a 1 MB page (time per keystroke under 16 ms on the dev machine).

## 5. Exit

Every construct renders, edits and round-trips through Source mode unchanged when untouched; memory notes unchanged; Memory regression pass.

## 6. Shipped

(Filled in when the phase lands.)
