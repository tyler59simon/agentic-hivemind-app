# NS-9B: importers

Read [phase-9a-obsidian-export.md](phase-9a-obsidian-export.md) first. Importers convert other apps' exports into a new or existing folder notebook. They never change the source files, and each ends with a report of what it could not carry over.

## 1. Sources

| Source | Input | Output |
| --- | --- | --- |
| Evernote | `.enex` file (one notebook) | One page per note (`.md`, or `.hmdoc` when tables with merged cells or coloured text need it); resources become attachments; tags become frontmatter `tags`; created and updated dates kept in frontmatter; encrypted (`en-crypt`) sections are listed, not imported |
| Notion | Export zip (Markdown and CSV), including nested zips | The page tree as folders and pages; the 32-hex ids stripped from names with links fixed accordingly; database CSVs become a folder of pages with properties plus a saved query (NS-7B) showing them as a table |
| OneNote | Sections exported from OneNote desktop as `.mht` (single file web page) or `.docx` | `.mht`: the MIME parts decoded, HTML converted with the NS-9A pipeline, images saved as attachments, one page per OneNote page. `.docx`: converted with `mammoth` to HTML, then the same pipeline |

## 2. What the user sees

**Import…** in the palette and on a notebook: pick the source type and files, pick the target notebook and folder, see a preview list of pages to be created (with name clashes resolved by a suffix), then import. Progress shows per page; the final report lists warnings per page and can be saved as a page.

## 3. Design

- Rust parsing for large inputs: `quick-xml` (streaming ENEX), `zip` (Notion), a small MIME multipart reader for `.mht` (quoted-printable and base64 parts); HTML to Markdown runs in the webview with the NS-9A pipeline; `mammoth` (lazy) for `.docx`.
- Writes go through `file_create` (never overwriting) inside the chosen notebook; the import is one history group so it can be undone by deleting the created files (listed in the report).
- Input caps: 2 GB per archive, 50 MB per resource, 20,000 pages per import, with clear messages.

## 4. Tests and exit

cargo: ENEX streaming on a generated file, Notion id stripping and link fixing, `.mht` part decoding. vitest: conversion fixtures per source. Exit: each importer produces readable pages from a real export and a report of what it dropped; Memory regression pass.

## 5. Shipped

(Filled in when the phase lands.)
