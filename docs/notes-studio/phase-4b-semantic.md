# NS-4B: semantic search

Read [phase-4a-index-search.md](phase-4a-index-search.md) and the S5 spike verdict first. This phase adds find-by-meaning over folder notebooks by reading the static model2vec model Living Memory already installs, so Hivemind ships no model and no ONNX runtime.

## Changes from the NS-0 review

These rules come from the Codex review of the design ([reviews/ns0-codex-review.md](reviews/ns0-codex-review.md)). Where the text below says otherwise, these win.

- Windows tests follow Living Memory's real behaviour: `semantic install` while Hivemind reads the model, and `semantic remove` that reports `leftover` when a file cannot be deleted yet. Units follow `core/units.py`, which keeps a single paragraph over 360 words whole; the parity fixtures include one (W6).

## Changes from the code survey before NS-4B

Claude surveyed Hivemind main at `bdac161` and Living Memory's `core/semantic.py`, `core/units.py` and `core/search.py` on 2026-11-22. Where the sections below say otherwise, these win. At the user's request this phase has no Codex review; Claude reviews the diff.

- **Which model.** The store root is the one the bridge uses (`settings.rs` `Launch.root`, as `studio.rs store_root` finds it). The model is `<root>/.models/potion-retrieval-32M/`, used only while its `verified.json` marker is present (Living Memory's `installed()`); Hivemind never downloads, verifies or changes the folder. The marker is checked before each embedding batch and each search, so `semantic install` and `remove` take effect without a restart.
- **Units and vectors.** NS-4A has no `blocks` table, so this phase adds `units` (page, order, heading, first line, text hash) and `vectors` (unit, f32 blob), cut the way `units.py` cuts a note body (heading sections, pieces of at most 360 words split only between paragraphs, one longer paragraph kept whole). A `meta` row records the model name and the `model.safetensors` hash from `verified.json`; a different model drops every vector and embeds again. The schema version bump rebuilds the index.
- **When pages are embedded.** On the writer thread after a page is extracted, only while the model is present, and only units whose text hash changed. When the model appears (or changes), the writer embeds every page in the background with `index-progress` reporting it. Without the model, everything from NS-4A works as before.
- **Search by meaning.** The unit vectors live in a bounded in-memory matrix loaded from SQLite on first use and kept in step by the writer; a query is embedded once and scored by cosine against every unit, a page scoring its best unit. The **Meaning** toggle fuses that ranking with the lexical one by reciprocal rank (k = 60) for folder notebook pages; a page found only by meaning is shown when its cosine is at least the model's `min_similarity` (0.45). Living Memory pages and memory notes keep their own search, which uses meaning when Living Memory's semantic search is on.
- **Related.** The rail's **Related** section ranks other folder notebook pages by the cosine of their best unit against the open page's mean vector (five, each at least 0.45) and asks Living Memory `search` with the page's title and first unit for three memory notes. It is hidden for Living Memory pages and loose files.
- **Reading the model on Windows.** No memory map: rows are read with `FileExt::seek_read`, a bounded row cache, the file closed after 30 s idle. The S5 spike's reader (crates `unicode-normalization`, `unicode-general-category`) and its 26-text corpus are the reference.
- **Parity test.** Gated on `HIVEMIND_TEST_LM_SCRIPT` and `HIVEMIND_TEST_MODEL_DIR` (a folder with the three model files): it makes a temporary store, installs the model there with `semantic install --from`, and compares token ids and vectors with Python's `core.semantic` (`py -3 -I`). A second gated test runs `semantic install --from` again and `semantic remove` while Hivemind's reader has the model in use, and both must succeed. Never against the user's store.

## 1. What the user sees

- A **Meaning** toggle in Notes search: results ranked by semantic similarity, fused with lexical results by reciprocal rank (k = 60, as Living Memory does), still grouped by origin.
- A **Related** section in the page rail: the five closest pages across notebooks and the three closest memory notes (through Living Memory search).
- When the model is not installed: "Semantic search needs the Living Memory model. Run `alm semantic install`." with a copy button.

## 2. Design

- `notes_index/semantic.rs` mirrors `agentic-living-memory/core/semantic.py`: read `<store>/.models/potion-retrieval-32M/` (`tokenizer.json` fields as `_tokenizer_spec`, `model.safetensors` header as `Model.__init__`), BERT normalisation (clean text, CJK spacing, lowercase, NFD and drop combining marks), BERT pre-tokenisation with the same punctuation ranges, greedy WordPiece with `##`, at most 512 tokens, unknown pieces dropped, mean of rows in f64, normalised, stored f32.
- **No memory map on Windows:** Living Memory's `semantic install` and `remove` replace the model folder and fail if another process holds a file open. Read rows with `seek_read`, cache recent rows (bounded), close the file after 30 s idle, and check `verified.json` before each batch.
- Units: chunk pages the way `agentic-living-memory/core/units.py` does (heading sections, at most 360 words); vectors in the `vectors` table keyed by block anchor.
- Dependencies: `unicode-normalization` and `unicode-general-category`, as used by the S5 reader that met parity.
- Known limit: Python's and Rust's Unicode tables can be different versions, so rare characters may tokenise differently; documented, not fixed.

## 3. Tests and exit

Ungated unit tests with a tiny synthetic tokenizer and safetensors file. A gated parity test (`HIVEMIND_TEST_LM_SCRIPT` and an installed model) runs the Python model through `py -3 -I` over a fixed corpus (ASCII, accents, Greek, CJK, emoji, punctuation runs, a 150-character word, more than 512 tokens, control characters, U+FFFD) and requires identical token ids and cosine at least 0.99999. Exit: parity green; `alm semantic install` still succeeds while Hivemind runs; Memory regression pass.

## 4. Shipped

Commit hashes to be added by Claude. At the user's request this phase had no Codex review; Claude reviews the diff. New dependencies: `unicode-normalization` and `unicode-general-category`. No Living Memory change was needed.

**What was built.**
- `src-tauri/src/notes_index/semantic.rs`: the model reader. It reads `<store>/.models/potion-retrieval-32M/` only while `verified.json` is there (the marker is read before every embedding batch, so `semantic install` and `remove` take effect without a restart), tokenizes as `core/semantic.py` does, and reads rows with `seek_read` through a 1,024-row cache. The file is closed, and the cache emptied, after 30 s of no use (the writer thread wakes every 5 s to check). A model that cannot be read (another tokenizer, a damaged matrix, a vocabulary past the matrix) is reported in `index_status` and not tried again until the marker's hash changes. F16 matrices are read too.
- `units.rs`: units cut like `units.py` (section per heading, pieces of at most 360 words cut between paragraphs, one longer paragraph kept whole, under three words skipped, the same text once per page). The extractors now also produce `lines` (headings with levels and paragraph breaks) for Markdown, rich pages, canvases and text.
- `schema.rs` (version 2, so the index is rebuilt): tables `units` (page, order, heading, first line, text hash), `vectors` (unit, f32 blob; an empty blob means the model knew none of the words, so the unit is not tried again) and `meta` (the model name and the `model.safetensors` hash from `verified.json`).
- `writer.rs`: each page's units are stored as the page is indexed; a unit whose hash is unchanged keeps its row and vector, the others are embedded while the model is present. `embed_pass` runs on the writer thread when the model appears or changes (the next look at `Index::semantic_status`, which every search, `index_status` and a new store root make): it drops the vectors of another model, then reads again every page that has a unit without a vector and reports `index-progress` with `phase: "meaning"`. It stops at once if the marker goes. A page the model could not be used on (marker removed mid-run) is filled by the next pass.
- `matrix.rs`: all vectors in one flat `f32` array, loaded from SQLite on the first meaning search and kept in step by the writer (it names the pages it changed after each commit; the next search reads those pages again, or everything when many changed or the model changed). Scoring is a dot product against every row; a page counts by its best unit.
- `query.rs`: `search_meaning` fuses the word ranking (100 candidates) with the 20 nearest pages by reciprocal rank (k = 60; ties keep the word order, as in `_fuse`); a page found only by meaning needs a cosine of at least 0.45. `related` ranks other pages by their best unit against the open page's mean vector, at least 0.45, five of them. Filters apply to both.
- Commands: `index_search` takes `meaning`; its result has `meaning` (`off`, `ready`, `building`, `missing`, `error`). New `index_related` returns `{ pages, query, meaning }`, where `query` is the title and the start of the first unit of text. `index_status` has `semantic`. The store root reaches the index from `studio::rewatch` (launch settings, else `~/LivingMemory`) and from `connect` (the root the bridge reports).
- Webview: a **Meaning** toggle in the search filters (`features/search/NotesSearch.tsx`, `store.ts`), the install hint with a Copy command button (`SemanticHint.tsx`: "Semantic search needs the Living Memory model. Run `alm semantic install`."; also "still reading your pages" and "cannot read the model" lines), a **Related** rail section (`features/links/RelatedPanel.tsx`: five pages, and three memory notes from Living Memory `search` with `query`; not shown for Living Memory pages or loose files), and the status line "Reading pages for meaning search: n of m".

**Where it differs from the survey and sections 2 and 3.**
- The title of a page is a unit of its own (a page has no summary), and `units.py`'s skip of the "Links" and "Action items" sections is not applied: that is note layout, not page layout. A page's first heading equal to its title is dropped from the heading path of its units.
- At most 128 units per page and 100,000 vectors in the index (about 205 MB of matrix at 512 dimensions); past that a page keeps its units without vectors, and `index_status` says `full`. The survey said "bounded"; these are the bounds.
- Unit text is not stored (only its hash and first line), so the pass that fills in vectors reads the page files again. "Related" asks Living Memory with the title and the first unit's text, which is read from the file when asked.
- The idle close needed no change to `semantic install`'s own rules: Rust opens files with delete sharing, so Living Memory's `install` and `remove` succeed while Hivemind has the model open (checked, see below).
- The marker's hash is read from `verified.json`; if it cannot be read the identity has an empty hash.

**Tests.** Ungated cargo tests use a 12-word tokenizer and a 12-row safetensors file written by the tests: normalisation (case, accents, control characters, final sigma, every kind of space), CJK spacing, punctuation split (ASCII and Unicode), WordPiece with `##`, the 100-character word limit (exactly 100 matches, 101 is unknown, characters not bytes), the 512-token cap (also for words of many pieces), unknown pieces dropped, f64 mean and unit length, F16 rows, damaged and unsupported models, the row cache bound, the marker removed and the model changed (reloaded), the idle close (also through the writer thread), units (sections, 360-word pieces, one 500-word paragraph kept whole, a fence with a blank line, duplicates, the unit cap), the matrix (best unit per page, publish, removal from the middle, reset, mean vector), and through the index: no model, a model present from the start, a model appearing later (progress 0 of 4 to 4 of 4, and not read again), a changed model, the marker removed during a 120-page pass, only changed units embedded, the vector budget, fusion with the 0.45 floor, a tie keeping the word order, related pages, the matrix following saves and deletes. Vitest: the Meaning toggle (asks for meaning, hint and Copy command, "still reading"), the Related section (pages, memory notes, hint, empty states, what a click opens), the rail (Related only on folder notebook pages), and the status line. Each was run against a version of the code with the behaviour removed (marker check, floor, hash reuse, model-change drop, publish, idle close, 360-word cut, token cap, pass stop on marker loss, related excluding itself, tie order, the `meaning` argument, the hint, the copy text, the rail section, the progress phase, the memory note limit) and failed.

Two gated tests (they run only with `HIVEMIND_TEST_LM_SCRIPT` and `HIVEMIND_TEST_MODEL_DIR` set; each makes a temporary store, binds a domain with `bind`, and installs the model with `semantic install --from`; `py -3 -I` runs Living Memory's `core.semantic`):
- Parity over the 26 texts of the S5 spike: identical token ids for 26 of 26, worst cosine 0.9999999929.
- `semantic install` again and then `semantic remove` while Hivemind has the model file open: both succeed, `remove` reports no `leftover`, Hivemind stops using the model at once, and it works again after another install.

**Measured** (10,000 generated Markdown pages, each with a title and three sections of 80 words of the model's own vocabulary, so 40,000 units; the real model; `cargo test --release notes_index::tests::ten_thousand_pages_meaning -- --ignored --nocapture`, Windows 11, opt-level 3):

| | |
| --- | --- |
| index the pages without the model (as NS-4A) | 4.8 s |
| embed everything (read every file again, cut, embed, store) | 24.2 s for 40,000 vectors |
| meaning search, three words, the first one (loads the model and the matrix from SQLite) | 210 ms |
| meaning search, later | 7.6 ms (1.7 ms with a folder filter) |
| related pages of one page | 8.7 ms |
| matrix in memory | 82.6 MB (40,000 units) |
| row cache | 2.1 MB (1,024 rows) |
| one saved page indexed and embedded | 9.4 ms |
| the first search after a save | 14 ms |

The first search after a start is just over the 200 ms target because it loads the 1.5 MB tokenizer and reads 40,000 vectors out of SQLite; every later search is far under it. In a debug build the embedding pass of this notebook takes more than two minutes (the test's `flush` gives up at 120 s), so debug numbers were not taken.

**Follow-ups from the review (R-1, UI-1, UI-2).**
- **R-1, the matrix is released when idle.** `Matrix::release_if_idle` (`matrix.rs`) empties the matrix, and forgets the pages the writer changed meanwhile, when no search or Related query has used it for 10 minutes (20 times the model's idle time, `Semantic::matrix_idle`). The writer thread's existing idle poll calls it. The next search or Related query loads it again from SQLite, which the writer keeps current whether or not the matrix is loaded; a save while it is unloaded does not load it. Tests: `an_idle_matrix_is_released_and_loads_again_with_what_the_writer_did_meanwhile` (matrix) and `the_matrix_is_released_when_idle_and_loaded_again_by_the_next_search_with_the_saves_made_meanwhile` (through the writer thread, with a 400 ms matrix idle time); both fail when the release is removed.
- **UI-1, Related keeps only near memory notes.** `isRelatedNote` (`features/search/groups.ts`): a note is kept when its `similarity` is at least 0.45; when results carry no `similarity` (Living Memory's semantic search off), when its `relevance` is above 0; a result with neither field is kept. `SearchHit` gained the optional `relevance`. Tests in `RelatedPanel.test.tsx` cover padding (similarity 0.0443, relevance 0), the 0.449 and 0.45 edge, and the no-similarity case.
- **UI-2, the Living Memory pages group drops padding.** `isRelevantPage`: a hit with `relevance` 0 is dropped unless its `similarity` is at least 0.45 (`DocSearchHit` gained the optional `similarity`); a group of only padding is absent. Applied in `buildGroups`; tests in `groups.test.ts`. This works around Living Memory returning every page after the real hits; the Living Memory bug itself is tracked separately. The Memory notes group of the search panel (NS-4A) is unchanged.

**Verified**: `cargo test`, `cargo clippy --all-targets -- -D warnings`, the whole `npx vitest run`, `npx tsc --noEmit` and `npm run build`.

**Known limits.** Python's and Rust's Unicode tables can differ in version, so a rare character may tokenize differently (no difference showed in the 26 texts). Setext headings (underlined with `===`) are not headings for the cutter, as for the NS-4A extractor. A rich page's headings inside a container (a toggle, a column) are found, but a heading inside a table cell is text. Every pass after a start re-checks which pages lack vectors; it reads files only for those. A notebook at the vector budget keeps pages without vectors until others are removed.
