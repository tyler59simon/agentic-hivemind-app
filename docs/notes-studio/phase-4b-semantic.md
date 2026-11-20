# NS-4B: semantic search

Read [phase-4a-index-search.md](phase-4a-index-search.md) and the S5 spike verdict first. This phase adds find-by-meaning over folder notebooks by reading the static model2vec model Living Memory already installs, so Hivemind ships no model and no ONNX runtime.

## Changes from the NS-0 review

These rules come from the Codex review of the design ([reviews/ns0-codex-review.md](reviews/ns0-codex-review.md)). Where the text below says otherwise, these win.

- Windows tests follow Living Memory's real behaviour: `semantic install` while Hivemind reads the model, and `semantic remove` that reports `leftover` when a file cannot be deleted yet. Units follow `core/units.py`, which keeps a single paragraph over 360 words whole; the parity fixtures include one (W6).

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
