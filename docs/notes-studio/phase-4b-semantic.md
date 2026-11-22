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

(Filled in when the phase lands.)
