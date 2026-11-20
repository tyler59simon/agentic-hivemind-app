# S5: model2vec in Rust (verdict: parity met; adopt in NS-4B)

Measured on 2026-11-20 with the model Living Memory installed at `<store>/.models/potion-retrieval-32M/`: F32 embeddings of 63,091 rows by 512 dimensions, a WordPiece tokenizer with `BertNormalizer` (lowercase, accents stripped because `strip_accents` is null and lowercase is on, clean text, Chinese character spacing) and `BertPreTokenizer`.

## Reader

A scratch Rust reader mirrored `agentic-living-memory/core/semantic.py`:

- reads `tokenizer.json` (vocabulary, unknown token, `##` prefix, 100-character word limit, normaliser flags);
- normalises like BERT: drops NUL, U+FFFD and control and format characters other than tab and newlines, maps whitespace to a space, spaces out CJK ideographs, lowercases, then NFD and drops nonspacing marks;
- splits on whitespace and on punctuation (the four ASCII ranges plus the Unicode P categories);
- runs greedy longest-match WordPiece, caps at 512 tokens and drops unknown pieces;
- reads embedding rows with `FileExt::seek_read` from the safetensors file, with no memory map;
- averages in f64, normalises and stores f32.

Crates: `serde_json`, `unicode-normalization` 0.1.26 ((MIT OR Apache-2.0) AND Unicode-3.0) and `unicode-general-category` 1.1.0 (Apache-2.0). The plan named `unicode-properties`; `unicode-general-category` replaces it because it exposes the general category directly.

## Corpus

26 texts: plain English; accented Latin; Greek with final sigma; Cyrillic; Chinese; Japanese with kana and half-width katakana; Korean; emoji and a flag; punctuation runs; a 150-character word; 700 tokens; control characters; U+FFFD, a zero-width space and NBSP; combining marks; Turkish dotted I, German sharp s and the fi ligature; Markdown with a task and a code fence; a URL and a Windows path; numbers and a timestamp; camelCase, snake_case and kebab-case identifiers; an empty string; whitespace only; ideographic space with line and paragraph separators; Arabic and Hebrew; Devanagari and Thai; math and currency symbols.

## Result

- Token ids identical for 26 of 26 texts.
- Worst cosine between the Python and Rust vectors: 0.9999999884 (the target was 0.99999).
- The Rust reader embedded the corpus in 5 ms; Python took 45 ms.

Decision: NS-4B uses this reader, with this corpus as a gated parity test that runs when the model is installed. Python's and the crates' Unicode tables can be different Unicode versions; no difference showed in this corpus, and the parity test is where one would.
