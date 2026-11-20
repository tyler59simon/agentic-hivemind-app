# NS-3A: rich live preview

Read [README.md](README.md) first. This phase grows the CodeMirror live preview for pages (not memory notes) into an Obsidian-style editor: the Markdown text is always the file, and rich blocks render in place until the cursor enters them. Re-check anchors against the code before starting.

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
