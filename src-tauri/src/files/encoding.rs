//! Text encodings for files Hivemind did not write: detect, decode, and write back byte for byte (NS-1B, spike S7).
//! Line endings are handled by the caller; this module works on the text as the file holds it.
use encoding_rs::{Encoding, EncoderResult, ISO_2022_JP, UTF_16BE, UTF_16LE, UTF_8};
use serde::{Deserialize, Serialize};

/// How sure the detection is: a byte order mark, bytes that are valid in the encoding, or a statistical guess.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum Confidence {
    Bom,
    #[default]
    Valid,
    Guess,
}

#[derive(Debug, PartialEq)]
pub struct Decoded {
    /// The text with the file's own line endings.
    pub text: String,
    /// An encoding_rs name: "UTF-8", "UTF-16LE", "windows-1252", ...
    pub encoding: &'static str,
    pub bom: bool,
    pub confidence: Confidence,
    /// Why the file cannot be edited; None when it can.
    pub read_only: Option<String>,
    pub binary: bool,
}

/// Bytes looked at for NUL (binary files) and for UTF-16 without a byte order mark.
const SNIFF: usize = 8000;
const UTF16_SNIFF: usize = 4096;

/// Detect and decode. Order: byte order mark, UTF-16 without one, binary (NUL), valid UTF-8, then a legacy guess.
pub fn decode(bytes: &[u8]) -> Decoded {
    if let Some((encoding, bom_len)) = Encoding::for_bom(bytes) {
        return decode_with(&bytes[bom_len..], encoding, true, Confidence::Bom);
    }
    if let Some(encoding) = utf16_without_bom(bytes) {
        return decode_with(bytes, encoding, false, Confidence::Guess);
    }
    if bytes.iter().take(SNIFF).any(|b| *b == 0) {
        return Decoded { text: String::new(), encoding: UTF_8.name(), bom: false, confidence: Confidence::Valid, read_only: Some("This is not a text file".into()), binary: true };
    }
    if std::str::from_utf8(bytes).is_ok() {
        return decode_with(bytes, UTF_8, false, Confidence::Valid);
    }
    // UTF-8 text with a few bad bytes is still UTF-8: a legacy guess would show its accented letters as two wrong
    // characters each. It counts as UTF-8 only when its valid multi-byte characters outnumber its runs of invalid
    // bytes, so a legacy file that happens to hold one UTF-8-looking pair is still guessed as legacy (Codex review of
    // 52051c8, D5). A file that does not decode opens read-only either way.
    let (mut multibyte, mut invalid, mut in_run) = (0usize, 0usize, false);
    for chunk in bytes.utf8_chunks() {
        multibyte += chunk.valid().chars().filter(|c| !c.is_ascii()).count();
        // Invalid bytes with nothing valid between them are one run (Codex re-review of fa08348, D5).
        if !chunk.invalid().is_empty() && !(in_run && chunk.valid().is_empty()) {
            invalid += 1;
        }
        in_run = !chunk.invalid().is_empty();
    }
    if multibyte > invalid {
        return decode_with(bytes, UTF_8, false, Confidence::Guess);
    }
    let mut detector = chardetng::EncodingDetector::new(chardetng::Iso2022JpDetection::Allow);
    detector.feed(bytes, true);
    decode_with(bytes, detector.guess(None, chardetng::Utf8Detection::Allow), false, Confidence::Guess)
}

/// UTF-16 without a byte order mark: in the first 4 KB at least 40% of the odd bytes (little endian ASCII) or of the
/// even bytes (big endian) are NUL, and the whole file decodes cleanly.
fn utf16_without_bom(bytes: &[u8]) -> Option<&'static Encoding> {
    let head = &bytes[..bytes.len().min(UTF16_SNIFF)];
    if head.len() < 4 || !bytes.len().is_multiple_of(2) {
        return None;
    }
    let pairs = head.len() / 2;
    let even = head.iter().step_by(2).filter(|b| **b == 0).count();
    let odd = head.iter().skip(1).step_by(2).filter(|b| **b == 0).count();
    let encoding = if odd * 10 >= pairs * 4 && odd > even {
        UTF_16LE
    } else if even * 10 >= pairs * 4 && even > odd {
        UTF_16BE
    } else {
        return None;
    };
    let (_, had_errors) = encoding.decode_without_bom_handling(bytes);
    (!had_errors).then_some(encoding)
}

/// Decode `body` (without its byte order mark) as `encoding`, and decide whether it may be edited: only when the text
/// decodes without errors and writing it back gives exactly the same bytes.
pub fn decode_with(body: &[u8], encoding: &'static Encoding, bom: bool, confidence: Confidence) -> Decoded {
    let (text, had_errors) = encoding.decode_without_bom_handling(body);
    let text = text.into_owned();
    let name = encoding.name();
    let read_only = if had_errors {
        Some(format!("This file contains bytes that are not valid {}", shown(name)))
    } else if encoding == ISO_2022_JP {
        Some("Hivemind cannot write ISO-2022-JP back exactly, so this file opens read-only".to_string())
    } else if encode_body(&text, encoding).ok().as_deref() != Some(body) {
        Some(format!("Saving this {} file would change bytes you did not edit, so it opens read-only", shown(name)))
    } else {
        None
    };
    Decoded { text, encoding: name, bom, confidence, read_only, binary: false }
}

/// A name for people: "UTF-16 LE" rather than "UTF-16LE", "Windows-1252" rather than "windows-1252".
pub fn shown(name: &str) -> String {
    match name {
        "UTF-16LE" => "UTF-16 LE".into(),
        "UTF-16BE" => "UTF-16 BE".into(),
        other if other.starts_with("windows-") => format!("W{}", &other[1..]),
        other => other.into(),
    }
}

/// The bytes for `text` in the encoding named `name`, with a byte order mark when `bom`. Refuses characters the
/// encoding cannot hold instead of writing replacements.
pub fn encode(text: &str, name: &str, bom: bool) -> Result<Vec<u8>, String> {
    let encoding = Encoding::for_label(name.as_bytes()).ok_or_else(|| format!("Hivemind does not know the encoding {name}"))?;
    if encoding == ISO_2022_JP {
        return Err("Hivemind cannot write ISO-2022-JP; convert the file to UTF-8 to edit it".into());
    }
    let mut out = Vec::with_capacity(text.len() + 3);
    if bom {
        out.extend_from_slice(match encoding.name() {
            "UTF-8" => &[0xEF, 0xBB, 0xBF][..],
            "UTF-16LE" => &[0xFF, 0xFE][..],
            "UTF-16BE" => &[0xFE, 0xFF][..],
            other => return Err(format!("{} files have no byte order mark", shown(other))),
        });
    }
    out.extend(encode_body(text, encoding)?);
    Ok(out)
}

fn encode_body(text: &str, encoding: &'static Encoding) -> Result<Vec<u8>, String> {
    if encoding == UTF_8 {
        return Ok(text.as_bytes().to_vec());
    }
    // encoding_rs writes UTF-16 as UTF-8 (its output encoding), so UTF-16 is encoded here.
    if encoding == UTF_16LE {
        return Ok(text.encode_utf16().flat_map(u16::to_le_bytes).collect());
    }
    if encoding == UTF_16BE {
        return Ok(text.encode_utf16().flat_map(u16::to_be_bytes).collect());
    }
    let mut encoder = encoding.new_encoder();
    let mut out = Vec::with_capacity(text.len() + 16);
    let mut buffer = [0u8; 4096];
    let (mut rest, mut unmappable) = (text, 0usize);
    loop {
        let (result, read, written) = encoder.encode_from_utf8_without_replacement(rest, &mut buffer, true);
        out.extend_from_slice(&buffer[..written]);
        rest = &rest[read..];
        match result {
            EncoderResult::InputEmpty => break,
            EncoderResult::OutputFull => {}
            // The character was consumed; count it and go on, so the message can say how many there are.
            EncoderResult::Unmappable(_) => unmappable += 1,
        }
    }
    if unmappable == 0 {
        // Some encoders write a near match without reporting it: Shift_JIS writes U+00A5 YEN SIGN as 0x5C, which reads
        // back as a backslash. The bytes must read back as the text (Codex review of 52051c8, D4).
        let (back, _) = encoding.decode_without_bom_handling(&out);
        unmappable = back.chars().zip(text.chars()).filter(|(a, b)| a != b).count() + back.chars().count().abs_diff(text.chars().count());
    }
    match unmappable {
        0 => Ok(out),
        1 => Err(format!("1 character cannot be written in {}", shown(encoding.name()))),
        n => Err(format!("{n} characters cannot be written in {}", shown(encoding.name()))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_character_the_encoder_writes_as_another_is_refused() {   // Codex review of 52051c8, D4
        let err = encode("price \u{a5}100\n", "Shift_JIS", false).unwrap_err();
        assert!(err.contains("1 character cannot be written in Shift_JIS"), "{err}");
        assert_eq!(encode("C:\\dir\n", "Shift_JIS", false).unwrap(), b"C:\\dir\n");
    }

    #[test]
    fn a_legacy_file_holding_one_utf8_looking_pair_is_guessed_as_legacy() {   // Codex review of 52051c8, D5
        let legacy = decode(b"Le caf\xe9 co\xfbte 3 \xc2\xa3 au march\xe9 de la ville\n");
        assert_eq!(legacy.encoding, "windows-1252");
        assert!(legacy.read_only.is_none() && legacy.text.starts_with("Le caf\u{e9} co\u{fb}te"), "{:?}", legacy.read_only);
        // UTF-8 with one bad byte among its accented letters stays UTF-8, read-only.
        let damaged = decode(b"caf\xc3\xa9 na\xc3\xafve \xff\n");
        assert_eq!(damaged.encoding, "UTF-8");
        assert!(damaged.read_only.unwrap().contains("not valid UTF-8"));
        // Two bad bytes side by side are one run, so two accented letters still make it UTF-8 (re-review of fa08348).
        assert_eq!(decode(b"caf\xc3\xa9 na\xc3\xafve \xff\xff\n").encoding, "UTF-8");
    }

    const SAMPLES: &[(&str, &str)] = &[
        ("windows-1252", "Café crème, naïve façade; déjà vu. Ça coûte 5 €.\r\n"),
        ("ISO-8859-2", "Zażółć gęślą jaźń, příliš žluťoučký kůň.\n"),
        ("windows-1250", "Příliš žluťoučký kůň úpěl ďábelské ódy.\n"),
        ("windows-1251", "Съешь же ещё этих мягких французских булок.\n"),
        ("KOI8-R", "Съешь же ещё этих мягких французских булок.\n"),
        ("windows-1253", "Ξεσκεπάζω την ψυχοφθόρα βδελυγμία.\n"),
        ("Shift_JIS", "いろはにほへと ちりぬるを 日本語の文章です。\n"),
        ("EUC-JP", "いろはにほへと ちりぬるを 日本語の文章です。\n"),
        ("GBK", "我能吞下玻璃而不伤身体。\n"),
        ("Big5", "我能吞下玻璃而不傷身體。\n"),
        ("EUC-KR", "다람쥐 헌 쳇바퀴에 타고파.\n"),
    ];

    #[test]
    fn every_editable_encoding_round_trips_byte_for_byte() {
        for (name, text) in SAMPLES {
            let encoding = Encoding::for_label(name.as_bytes()).unwrap();
            let bytes = encode(text, name, false).unwrap();
            let decoded = decode_with(&bytes, encoding, false, Confidence::Guess);
            assert_eq!(decoded.read_only, None, "{name}");
            assert_eq!(decoded.text, *text, "{name}");
            assert_eq!(encode(&decoded.text, decoded.encoding, false).unwrap(), bytes, "{name}");
        }
    }

    #[test]
    fn utf16_with_and_without_a_bom() {
        let text = "Line one\r\nZweite Zeile mit Umlaut ä and 😀\r\n";
        for (name, bom) in [("UTF-16LE", true), ("UTF-16BE", true), ("UTF-16LE", false), ("UTF-16BE", false)] {
            let bytes = encode(text, name, bom).unwrap();
            let decoded = decode(&bytes);
            assert_eq!((decoded.encoding, decoded.bom, decoded.read_only.clone(), decoded.text.as_str()), (name, bom, None, text), "{name} bom {bom}");
            assert_eq!(decoded.confidence, if bom { Confidence::Bom } else { Confidence::Guess });
            assert_eq!(encode(&decoded.text, decoded.encoding, decoded.bom).unwrap(), bytes);
        }
    }

    #[test]
    fn utf8_with_and_without_a_bom_is_valid_not_guessed() {
        let plain = decode("plain ascii and é".as_bytes());
        assert_eq!((plain.encoding, plain.bom, plain.confidence), ("UTF-8", false, Confidence::Valid));
        let mut with_bom = vec![0xEF, 0xBB, 0xBF];
        with_bom.extend_from_slice("x".as_bytes());
        let d = decode(&with_bom);
        assert_eq!((d.encoding, d.bom, d.text.as_str(), d.confidence), ("UTF-8", true, "x", Confidence::Bom));
    }

    #[test]
    fn a_legacy_file_is_detected_and_editable() {
        let bytes = encode(SAMPLES[0].1, "windows-1252", false).unwrap();
        let d = decode(&bytes);
        assert_eq!((d.encoding, d.confidence, d.read_only.clone()), ("windows-1252", Confidence::Guess, None));
        assert_eq!(d.text, SAMPLES[0].1);
    }

    #[test]
    fn a_second_byte_form_makes_the_file_read_only() {
        // Shift_JIS 0xED 0x40 (an NEC-selected IBM extension) decodes to U+7E8A, which encoding_rs writes as 0xFA 0x5C.
        let bytes = [b'a', 0xED, 0x40, b'\n'];
        let d = decode_with(&bytes, encoding_rs::SHIFT_JIS, false, Confidence::Guess);
        assert!(d.read_only.unwrap().contains("would change bytes"));
    }

    #[test]
    fn decode_errors_and_iso_2022_jp_are_read_only() {
        let d = decode_with(&[b'a', 0xAA, b'b'], encoding_rs::WINDOWS_1253, false, Confidence::Guess);
        assert!(d.read_only.unwrap().contains("not valid Windows-1253"));
        let jis = ISO_2022_JP.encode("日本語").0.into_owned();
        assert!(decode_with(&jis, ISO_2022_JP, false, Confidence::Guess).read_only.is_some());
        assert!(encode("x", "ISO-2022-JP", false).is_err());
    }

    #[test]
    fn unmappable_characters_refuse_the_save_and_say_how_many() {
        assert_eq!(encode("漢字 ok", "windows-1252", false).unwrap_err(), "2 characters cannot be written in Windows-1252");
        assert_eq!(encode("€", "windows-1252", false).unwrap(), vec![0x80]);
        assert!(encode("x", "windows-1252", true).is_err(), "legacy encodings have no BOM");
    }

    #[test]
    fn utf8_with_a_bad_byte_stays_utf8_and_read_only() {
        let mut bytes = "Café crème\n".as_bytes().to_vec();
        bytes.push(0xFF);
        let d = decode(&bytes);
        assert_eq!(d.encoding, "UTF-8");
        assert!(d.read_only.unwrap().contains("not valid UTF-8"));
        assert!(d.text.starts_with("Café crème"));
        // High bytes alone, with no UTF-8 sequence anywhere, are a legacy file.
        assert_eq!(decode(b"caf\xe9 cr\xe8me").encoding, "windows-1252");
    }

    #[test]
    fn nul_bytes_mean_binary_unless_the_file_is_utf16() {
        let d = decode(&[0x89, b'P', b'N', b'G', 0, 0, 0, 13, 1, 2, 3]);
        assert!(d.binary);
        assert!(!decode(&encode("abcdef", "UTF-16LE", false).unwrap()).binary);
    }
}
