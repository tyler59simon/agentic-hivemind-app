# NS-0: design documents and spikes

Read [README.md](README.md) first. NS-0 commits this folder, the Living Memory design (`agentic-living-memory/docs/notebooks-design.md`), and the measured verdicts of eight spikes. Spike code is throwaway: it lives in a scratch folder or an unmerged branch, never on main. Each verdict goes in `spikes/sN-<name>.md` with what was measured, the numbers, and the decision it fixes. If a verdict contradicts this design, the phase document it affects is updated in the same commit.

| Spike | Question | Method | Verdict decides |
| --- | --- | --- | --- |
| S1 `hmfile` | Does an asynchronous URI scheme serve images and Range requests to WebView2 under our CSP, from the main window only? | Scratch branch: register `hmfile`, serve one PNG, one SVG and one PDF; load the PDF page with `pdfjs-dist`; request from the capture window too | NS-1B scheme handler and CSP |
| S2 associations | Do protocol v2 knocks, NSIS `fileAssociations` and an "Open with" hook work, including Explorer multi-select? | Scratch branch: installed NSIS build; double-click, Open with, three-file selection; old instance plus new launch | NS-1B instance protocol and installer hooks |
| S3 Tiptap | Bundle cost of Tiptap core plus the extensions we need; licence of each package; does the block-preserving serializer give byte identity on a real corpus; does ProseMirror's own block drag work with Tauri's drop handler on? | Scratch Vite project with the extensions; `vite build` and gzip sizes; serializer prototype over 200 Markdown files (Living Memory notes, GFM, Obsidian syntax, CRLF, BOM) | NS-3B design and the dependency table |
| S4 rusqlite | Clean and incremental build time and exe size with `rusqlite` `bundled` on Windows MSVC; FTS5 present | Scratch crate with the same Rust toolchain; `PRAGMA compile_options`; create an `fts5` table | NS-4A (and whether to defer the dependency) |
| S5 model2vec | Does a Rust reader give the same token ids and vectors as `agentic-living-memory/core/semantic.py`? | Scratch crate reading `<store>/.models/potion-retrieval-32M`; compare 20 sentences against Python (`py -3 -I` importing `core.semantic`) | NS-4B parity bar and Unicode handling |
| S6 Codex one-shot | What does `codex exec --json --output-schema` emit (events, usage), how strict must schemas be, how is a policy passed, is there managed configuration to respect? | `codex exec --help` and docs offline; one live call only with the user's approval (it costs money) | NS-8A `run_codex` |
| S7 encodings | Which encodings round-trip byte for byte through `encoding_rs` decode and encode; UTF-16 by hand; CRLF through CodeMirror's `lineSeparator` | Scratch crate: round-trip windows-1252, ISO-8859-1, Shift_JIS, GBK, EUC-KR, UTF-16 LE and BE, UTF-8 with BOM | NS-1B editable encodings list |
| S8 print to PDF | Can a hidden WebView2 window print a rendered page to PDF through `webview2-com` `PrintToPdf` from Tauri's `with_webview`? | Scratch branch: render a Markdown page in a hidden window and print it | NS-9A export path |

Order: S4, S5 and S7 need no app changes and run first. S3 needs only npm in a scratch folder. S1, S2 and S8 need a running or installed build, which means closing the user's Hivemind first; they can run at the start of NS-1B (S1, S2) and NS-9A (S8) instead, and their verdict files say so until then. S6's live call waits for the user's approval.

## Exit

- This folder and the Living Memory design are committed and Codex-reviewed.
- Every spike has a verdict file, or a file that says which phase runs it and why.
- `docs/plans/README.md` decision 2 and decision 8 carry a note that Notes Studio supersedes them (shared workspace; delivery straight to main).

## Shipped

2026-11-20: design docs in both repositories and the offline spikes.

| Spike | Verdict |
| --- | --- |
| S3 Tiptap | Adopt. All packages MIT; 193 KB gzipped with the remark pipeline; undo breaks node identity, so NS-3B tracks block ownership with a `srcId` attribute (after the review); remark slices reproduced 480 file variants exactly. Block drag checked at the start of NS-3B |
| S4 rusqlite | Adopt. 22 s clean build, about 1.7 MB exe, FTS5 with the porter tokenizer |
| S5 model2vec | Adopt. Identical token ids on 26 of 26 texts, worst cosine 0.9999999884 |
| S6 Codex | Partial. Flags confirmed offline; the live call waits for the user's approval at the start of NS-8A |
| S7 encodings | Adopt. Twelve encodings round-trip; UTF-16 written by hand; ISO-2022-JP stays read-only |
| S1, S2, S8 | Deferred to NS-1B and NS-9A, see [spikes/deferred.md](spikes/deferred.md) |
