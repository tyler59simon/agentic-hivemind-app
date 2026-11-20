# S7: encodings (verdict: adopt encoding_rs and chardetng in NS-1B)

Measured on 2026-11-20 in a scratch crate with `encoding_rs` 0.8.44 ((Apache-2.0 OR MIT) AND BSD-3-Clause) and `chardetng` 1.0.0 (Apache-2.0 OR MIT).

## Results

- **Round trips.** A sample text in each encoding was encoded, decoded, and encoded again with `encode_from_utf8_without_replacement`. All were byte-identical with no decode errors: windows-1252, ISO-8859-2, windows-1250, windows-1251, KOI8-R, windows-1253, Shift_JIS, EUC-JP, ISO-2022-JP, GBK, Big5 and EUC-KR.
- **Detection.** `chardetng` guessed 11 of 12 short samples exactly. It guessed KOI8-R as KOI8-U, a superset, which still round-trips because Hivemind writes back with the encoding it decoded with.
- **Every byte value.** All 256 byte values round-trip in windows-1252, windows-1250, windows-1251, ISO-8859-2, KOI8-R and IBM866. windows-1253 has undefined bytes, so a file containing them decodes with errors and must open read-only.
- **Labels.** The label `iso-8859-1` resolves to windows-1252 (WHATWG rules). Such files still round-trip byte for byte. The status bar shows "Windows-1252" for them.
- **UTF-16.** `encoding_rs` decodes UTF-16 LE and BE, but its encoder outputs UTF-8 (`output_encoding()` is UTF-8). Hivemind therefore writes UTF-16 by hand with `str::encode_utf16`. The hand-written round trip was byte-identical, including a surrogate pair and CRLF.
- **Unmappable characters.** With the `_without_replacement` API, a CJK character saved as windows-1252 is reported as `EncoderResult::Unmappable` instead of being written as an HTML numeric reference.

## Decision for NS-1B

- Editable: UTF-8 with or without BOM, UTF-16 LE and BE with or without BOM, and every other encoding listed above.
- ISO-2022-JP stays read-only, as `phase-1b-open-any-file.md` says. Its round trip passed only for text that `encoding_rs` itself encoded; a file from another encoder can choose different escape sequences (for example `ESC ( J` against `ESC ( B`), so saving it would change bytes the user did not touch.
- A file that decodes with errors opens read-only, with "Reopen with encoding" and "Convert to UTF-8" offered.
- Saves always use the `_without_replacement` API. On an unmappable character the save is refused and the dialog offers converting the file to UTF-8.
