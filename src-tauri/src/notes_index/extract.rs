//! What the index keeps of each kind of page: Markdown, rich pages (`.hmdoc`), canvases and plain text.
use super::links::{self, Link, Scanned};
use super::units::Line;
use serde_json::Value;

/// The first part of a file that is indexed; a longer file is cut here.
pub const READ_CAP: usize = 2 * 1024 * 1024;
/// A rich page is JSON that must be read whole; the editor refuses one over 5,000,000 characters, and so does the index.
pub const HMDOC_CAP: usize = 5_000_000;

/// The kind a file name gets in the index, or None for a file that is not indexed.
pub fn kind_of(name: &str) -> Option<&'static str> {
    let ext = name.rsplit_once('.')?.1.to_ascii_lowercase();
    match ext.as_str() {
        "md" | "markdown" => Some("md"),
        "hmdoc" => Some("hmdoc"),
        "canvas" => Some("canvas"),
        "txt" => Some("txt"),
        _ => None,
    }
}

pub struct Extracted {
    pub title: String,
    pub headings: String,
    pub body: String,
    /// The text as lines with paragraph breaks and heading levels, for cutting the page into units.
    pub lines: Vec<Line>,
    pub tags: Vec<String>,
    pub links: Vec<Link>,
}

/// A file's name without the extension of an indexed kind.
pub fn stem(name: &str) -> String {
    match name.rsplit_once('.') {
        Some((stem, _)) if kind_of(name).is_some() && !stem.is_empty() => stem.to_string(),
        _ => name.to_string(),
    }
}

/// The text of a file that is not plain UTF-8, as the editor reads it, with LF line endings; none for binary data.
fn decoded(bytes: &[u8]) -> String {
    let (text, _, _, binary) = crate::files::decode(bytes);
    if binary { String::new() } else { text }
}

/// The text of a file's bytes with LF line endings: UTF-8 (with or without a byte order mark) at once, any other
/// encoding the way the editor reads it. Binary data gives no text.
fn text_of(bytes: &[u8]) -> String {
    let body = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    // Text with NUL bytes is UTF-16 or binary, and the editor's detection tells which.
    let plain = !body.iter().take(8000).any(|b| *b == 0);
    let text = match std::str::from_utf8(body) {
        Ok(text) if plain => text.to_string(),
        Ok(_) => return decoded(bytes),
        // A cut in the middle of a character at the end of a long file is not a reason to guess another encoding.
        Err(e) if e.error_len().is_none() && e.valid_up_to() + 4 > body.len() => String::from_utf8_lossy(&body[..e.valid_up_to()]).into_owned(),
        Err(_) => return decoded(bytes),
    };
    if text.contains('\r') { text.replace("\r\n", "\n").replace('\r', "\n") } else { text }
}

/// What to keep of `bytes`, a file called `name` of the kind `kind` (see `kind_of`).
pub fn extract(kind: &str, name: &str, bytes: &[u8]) -> Extracted {
    let stem = stem(name);
    let scanned = match kind {
        "md" => links::scan_markdown(&text_of(bytes)),
        "hmdoc" => hmdoc(bytes),
        "canvas" => canvas(bytes),
        _ => {
            let body = text_of(bytes);
            let lines = body.lines().map(|l| if l.trim().is_empty() { Line::Break } else { Line::Text(l.trim().to_string()) }).collect();
            Scanned { body, lines, ..Scanned::default() }
        }
    };
    let mut tags = scanned.tags;
    tags.sort();
    tags.dedup();
    Extracted { title: scanned.title.filter(|t| !t.is_empty()).unwrap_or(stem), headings: scanned.headings.join("\n"), body: scanned.body, lines: scanned.lines, tags, links: scanned.links }
}

// ---- rich pages ----------------------------------------------------------------------------------------------------

/// JavaScript's `\s` and `trim()` set: Rust's `char::is_whitespace` differs from it at U+0085 and U+FEFF.
fn js_space(c: char) -> bool {
    matches!(c, '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

fn js_trim(s: &str) -> &str {
    s.trim_matches(js_space)
}

/// `\s+` replaced by one space, then trimmed.
fn one_line(s: &str) -> String {
    s.split(js_space).filter(|part| !part.is_empty()).collect::<Vec<_>>().join(" ")
}

fn str_of<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get("attrs").and_then(|a| a.get(key)).and_then(Value::as_str).unwrap_or("")
}

fn kids(n: &Value) -> &[Value] {
    n.get("content").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}

fn node_type(n: &Value) -> &str {
    n.get("type").and_then(Value::as_str).unwrap_or("")
}

/// What an inline node contributes: its text, or the text an atom stands for.
fn inline_text(n: &Value) -> String {
    match node_type(n) {
        "text" => n.get("text").and_then(Value::as_str).unwrap_or("").to_string(),
        "hardBreak" => "\n".into(),
        "wikiLink" | "embed" | "mathInline" | "rawInline" => str_of(n, "value").to_string(),
        "image" => str_of(n, "alt").to_string(),
        _ => kids(n).iter().map(inline_text).collect(),
    }
}

const TEXT_BLOCKS: [&str; 5] = ["paragraph", "heading", "codeBlock", "calloutTitle", "toggleSummary"];

/// The twin of `extractText` in `src/features/hmdoc/extract.ts`: block texts in document order, a table as one line per
/// row with tab-separated cells, and so on. `src/features/hmdoc/fixtures/` holds the pairs both are checked against.
fn block_text(n: &Value, out: &mut Vec<String>) {
    let t = node_type(n);
    if TEXT_BLOCKS.contains(&t) {
        let text: String = kids(n).iter().map(inline_text).collect();
        if !text.is_empty() {
            out.push(text);
        }
    } else if t == "table" {
        for row in kids(n) {
            let cells: Vec<String> = kids(row)
                .iter()
                .map(|cell| {
                    let mut parts = Vec::new();
                    for b in kids(cell) {
                        block_text(b, &mut parts);
                    }
                    // A cell is one field: its blocks and line breaks become spaces, and tabs never appear inside it.
                    one_line(&parts.join(" "))
                })
                .collect();
            out.push(cells.join("\t"));
        }
    } else if t == "mathBlock" {
        let text = js_trim(str_of(n, "value"));
        if !text.is_empty() {
            out.push(text.to_string());
        }
    } else if matches!(t, "noteCard" | "diagram" | "pdfPage" | "excalidraw") {
        let text = js_trim(str_of(n, "title"));
        if !text.is_empty() {
            out.push(text.to_string());
        }
    } else if t == "codeRange" {
        let title = js_trim(str_of(n, "title"));
        if !title.is_empty() {
            out.push(title.to_string());
        }
        let text = str_of(n, "text").trim_end_matches(js_space);
        if !text.is_empty() {
            out.push(text.to_string());
        }
    } else if t == "gallery" {
        let title = js_trim(str_of(n, "title"));
        if !title.is_empty() {
            out.push(title.to_string());
        }
        if let Some(images) = n.get("attrs").and_then(|a| a.get("images")).and_then(Value::as_array) {
            out.extend(images.iter().filter_map(Value::as_str).filter(|p| !p.is_empty()).map(str::to_string));
        }
    } else if t == "freeform" {
        let frames = kids(n);
        let num = |f: &Value, key: &str| f.get("attrs").and_then(|a| a.get(key)).and_then(Value::as_f64).unwrap_or(0.0);
        // Top to bottom, then left to right, then as they stand in the document (the sort is stable).
        let mut order: Vec<usize> = (0..frames.len()).collect();
        order.sort_by(|&a, &b| {
            num(&frames[a], "y").total_cmp(&num(&frames[b], "y")).then(num(&frames[a], "x").total_cmp(&num(&frames[b], "x")))
        });
        for i in order {
            block_text(&frames[i], out);
        }
    } else if t == "rawBlock" {
        let text = str_of(n, "value").trim_end_matches(js_space);
        if !text.is_empty() {
            out.push(text.to_string());
        }
    } else {
        for c in kids(n) {
            block_text(c, out);
        }
    }
}

/// The text of a rich page's `content` node.
pub fn hmdoc_text(content: &Value) -> String {
    let mut out = Vec::new();
    block_text(content, &mut out);
    out.join("\n")
}

/// The lines of a rich page for the cutter: a heading with its level, and each block's text as a paragraph of its own.
fn rich_lines(n: &Value, out: &mut Vec<Line>) {
    match node_type(n) {
        "heading" => {
            let text = one_line(&kids(n).iter().map(inline_text).collect::<String>());
            if !text.is_empty() {
                let level = n.get("attrs").and_then(|a| a.get("level")).and_then(Value::as_u64).unwrap_or(1).clamp(1, 6);
                out.push(Line::Heading(level as u8, text));
            }
        }
        "paragraph" | "codeBlock" | "calloutTitle" | "toggleSummary" | "table" | "mathBlock" | "noteCard" | "diagram" | "pdfPage" | "excalidraw" | "codeRange" | "gallery" | "freeform" | "rawBlock" => {
            let mut parts = Vec::new();
            block_text(n, &mut parts);
            if !parts.is_empty() {
                out.extend(parts.into_iter().map(Line::Text));
                out.push(Line::Break);
            }
        }
        _ => {
            for c in kids(n) {
                rich_lines(c, out);
            }
        }
    }
}

/// Headings and links of a rich page, in document order.
fn hmdoc_walk(n: &Value, headings: &mut Vec<String>, links: &mut Vec<Link>) {
    match node_type(n) {
        "heading" => {
            let text = one_line(&kids(n).iter().map(inline_text).collect::<String>());
            if !text.is_empty() {
                headings.push(text);
            }
        }
        "wikiLink" | "embed" => {
            let value = str_of(n, "value");
            let target = value.split('|').next().unwrap_or("").trim();
            if !target.is_empty() && !links::name_key(target).is_empty() {
                links.push(Link { raw: target.to_string(), kind: links::WIKI, embed: node_type(n) == "embed", line: 0, context: String::new() });
            }
        }
        _ => {}
    }
    if let Some(marks) = n.get("marks").and_then(Value::as_array) {
        for mark in marks.iter().filter(|m| node_type(m) == "link") {
            let href = links::percent_decode(str_of(mark, "href").trim());
            let path = href.split(['#', '?']).next().unwrap_or("");
            let scheme = href.find(':').is_some_and(|i| i >= 2 && href[..i].chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-')));
            if !path.is_empty() && !scheme {
                links.push(Link { raw: href, kind: links::MD, embed: false, line: 0, context: String::new() });
            }
        }
    }
    for c in kids(n) {
        hmdoc_walk(c, headings, links);
    }
}

fn hmdoc(bytes: &[u8]) -> Scanned {
    // A page that is not valid JSON, or not a rich page, is indexed by its name only.
    let Ok(file) = serde_json::from_slice::<Value>(bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes)) else { return Scanned::default() };
    let Some(content) = file.get("content") else { return Scanned::default() };
    let mut found = Scanned { body: hmdoc_text(content), ..Scanned::default() };
    rich_lines(content, &mut found.lines);
    hmdoc_walk(content, &mut found.headings, &mut found.links);
    found.title = found.headings.first().cloned();
    links::tags_in(&found.body, &mut found.tags);
    found
}

// ---- canvases ------------------------------------------------------------------------------------------------------

/// A JSON Canvas: the text of its cards and groups and its edge labels are the body, the `[[links]]` in its text cards
/// and the files its file cards show are its links.
fn canvas(bytes: &[u8]) -> Scanned {
    let Ok(file) = serde_json::from_slice::<Value>(bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes)) else { return Scanned::default() };
    let mut found = Scanned::default();
    let mut body = Vec::new();
    let field = |v: &Value, key: &str| v.get(key).and_then(Value::as_str).unwrap_or("").to_string();
    for node in file.get("nodes").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]) {
        match node.get("type").and_then(Value::as_str).unwrap_or("") {
            "text" => {
                let inner = links::scan_markdown(&field(node, "text").replace("\r\n", "\n"));
                found.headings.extend(inner.headings);
                found.tags.extend(inner.tags);
                found.links.extend(inner.links.into_iter().map(|l| Link { line: 0, ..l }));
                if !inner.body.is_empty() {
                    body.push(inner.body);
                    found.lines.extend(inner.lines);
                    found.lines.push(Line::Break);
                }
            }
            "file" => {
                let file = field(node, "file").replace('\\', "/");
                if !file.is_empty() {
                    found.lines.extend([Line::Text(file.clone()), Line::Break]);
                    body.push(file.clone());
                    if !links::name_key(&file).is_empty() {
                        found.links.push(Link { raw: file, kind: links::FILE, embed: false, line: 0, context: String::new() });
                    }
                }
            }
            "link" => {
                found.lines.extend([Line::Text(field(node, "url")), Line::Break]);
                body.push(field(node, "url"));
            }
            "group" => {
                found.lines.extend([Line::Text(field(node, "label")), Line::Break]);
                body.push(field(node, "label"));
            }
            _ => {}
        }
    }
    for edge in file.get("edges").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]) {
        found.lines.extend([Line::Text(field(edge, "label")), Line::Break]);
        body.push(field(edge, "label"));
    }
    body.retain(|text| !text.is_empty());
    found.lines.retain(|l| !matches!(l, Line::Text(t) if t.is_empty()));
    found.body = body.join("\n");
    found.title = found.headings.first().cloned();
    found
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The pairs `src/features/hmdoc/extract.test.ts` is checked against: a `.hmdoc` and the `.txt` it extracts to.
    fn fixtures() -> Vec<(String, String, String)> {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/features/hmdoc/fixtures");
        let mut found = Vec::new();
        for entry in std::fs::read_dir(&dir).unwrap().flatten() {
            let path = entry.path();
            if path.extension().is_some_and(|e| e == "hmdoc") {
                // Git may check the fixtures out with CRLF line endings; the page is read as LF text.
                let lf = |p: &std::path::Path| std::fs::read_to_string(p).unwrap().replace("\r\n", "\n");
                let name = path.file_stem().unwrap().to_string_lossy().into_owned();
                found.push((name, lf(&path), lf(&path.with_extension("txt"))));
            }
        }
        found.sort();
        found
    }

    #[test]
    fn rich_page_text_is_what_the_fixture_beside_it_holds() {
        let all = fixtures();
        assert_eq!(all.iter().map(|f| f.0.as_str()).collect::<Vec<_>>(), ["basic", "embeds", "inline", "table"]);
        for (name, page, expected) in all {
            let file: Value = serde_json::from_str(&page).unwrap();
            assert_eq!(hmdoc_text(&file["content"]), expected.strip_suffix('\n').unwrap_or(&expected), "{name}");
        }
    }

    #[test]
    fn a_rich_page_gives_its_headings_links_and_tags() {
        let page = std::fs::read(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/features/hmdoc/fixtures/basic.hmdoc")).unwrap();
        let e = extract("hmdoc", "Plan.hmdoc", &page);
        assert_eq!(e.title, "Plan");
        assert!(e.headings.starts_with("Plan"));
        assert_eq!(e.links.iter().map(|l| l.raw.as_str()).collect::<Vec<_>>(), ["Other page"]);
        assert!(e.body.starts_with("Plan\nHello world and Other page|alias."));
    }

    #[test]
    fn rich_page_edge_cases_match_the_typescript_rules() {
        let text = |blocks: Value| hmdoc_text(&json!({ "type": "doc", "content": blocks }));
        let p = |s: &str| json!({ "type": "paragraph", "content": [{ "type": "text", "text": s }] });
        // Empty blocks and dividers leave nothing; the text ends without a line break.
        assert_eq!(text(json!([{ "type": "paragraph" }, p("x"), { "type": "horizontalRule" }, p("y")])), "x\ny");
        assert_eq!(text(json!([{ "type": "paragraph" }])), "");
        // A cell is one field: blocks, line breaks and every kind of space become one space, and U+0085 is not space.
        let cell = json!({ "type": "tableCell", "content": [{ "type": "paragraph", "content": [
            { "type": "text", "text": "one" }, { "type": "hardBreak" }, { "type": "text", "text": "two\tthree\u{a0}\u{feff}four\u{85}five" }] }, p("six")] });
        let table = json!({ "type": "table", "content": [{ "type": "tableRow", "content": [cell, { "type": "tableCell", "content": [{ "type": "paragraph" }] }] }] });
        assert_eq!(text(json!([table])), "one two three four\u{85}five six\t");
        // Formula cells stay formulas; titles and values are trimmed the way JavaScript trims.
        assert_eq!(text(json!([{ "type": "mathBlock", "attrs": { "value": "\u{feff} x^2 \n" } }, { "type": "diagram", "attrs": { "title": "  Map " } }])), "x^2\nMap");
        // Frames read top to bottom, then left to right, then as stored.
        let frame = |x: i64, y: i64, s: &str| json!({ "type": "frame", "attrs": { "x": x, "y": y }, "content": [p(s)] });
        assert_eq!(text(json!([{ "type": "freeform", "content": [frame(9, 1, "c"), frame(1, 1, "b"), frame(1, 0, "a"), frame(1, 1, "b2")] }])), "a\nb\nb2\nc");
    }

    #[test]
    fn a_page_that_is_not_json_is_indexed_by_its_name() {
        let e = extract("hmdoc", "Broken.hmdoc", b"{ not json");
        assert_eq!((e.title.as_str(), e.body.as_str()), ("Broken", ""));
        let e = extract("canvas", "Board.canvas", b"[1,2");
        assert_eq!((e.title.as_str(), e.body.as_str()), ("Board", ""));
    }

    #[test]
    fn a_canvas_gives_its_text_labels_and_file_cards() {
        let canvas = json!({
            "nodes": [
                { "id": "a", "type": "text", "text": "# Idea\nSee [[Roadmap]] #plan" },
                { "id": "b", "type": "file", "file": "Projects/Roadmap.md" },
                { "id": "c", "type": "link", "url": "https://example.com" },
                { "id": "d", "type": "group", "label": "Phase one" }
            ],
            "edges": [{ "id": "e", "fromNode": "a", "toNode": "b", "label": "depends on" }]
        });
        let e = extract("canvas", "Board.canvas", canvas.to_string().as_bytes());
        assert_eq!(e.title, "Idea");
        assert_eq!(e.body, "Idea\nSee Roadmap #plan\nProjects/Roadmap.md\nhttps://example.com\nPhase one\ndepends on");
        assert_eq!(e.tags, ["plan"]);
        assert_eq!(e.links.iter().map(|l| (l.raw.as_str(), l.kind)).collect::<Vec<_>>(), [("Roadmap", links::WIKI), ("Projects/Roadmap.md", links::FILE)]);
    }

    #[test]
    fn plain_text_is_all_body_and_encodings_are_read_like_the_editor_does() {
        let e = extract("txt", "notes.txt", b"line one\r\nline two\rthree");
        assert_eq!((e.title.as_str(), e.body.as_str()), ("notes", "line one\nline two\nthree"));
        assert_eq!(extract("txt", "a.txt", b"\xEF\xBB\xBFcaf\xc3\xa9").body, "café");
        assert_eq!(extract("txt", "a.txt", b"caf\xe9 na\xefve").body, "café naïve");
        let utf16: Vec<u8> = [&[0xFF, 0xFE][..], &"héllo".encode_utf16().flat_map(u16::to_le_bytes).collect::<Vec<u8>>()].concat();
        assert_eq!(extract("txt", "a.txt", &utf16).body, "héllo");
        assert_eq!(extract("txt", "a.txt", b"PK\x03\x04\x00\x00binary").body, "");
        // A cut in the middle of a character, as at the end of a read capped at 2 MB.
        assert_eq!(extract("txt", "a.txt", &"café".as_bytes()[..4]).body, "caf");
    }

    #[test]
    fn markdown_without_a_heading_is_titled_by_its_file_name() {
        let e = extract("md", "Daily 2026-11-22.md", b"text only #tag");
        assert_eq!((e.title.as_str(), e.tags.as_slice()), ("Daily 2026-11-22", ["tag".to_string()].as_slice()));
        assert_eq!(kind_of("A.MD"), Some("md"));
        assert_eq!(kind_of("a.markdown"), Some("md"));
        assert_eq!(kind_of("a.png"), None);
        assert_eq!(kind_of("noext"), None);
        assert_eq!(stem("Plan.hmdoc"), "Plan");
        assert_eq!(stem("run.log"), "run.log");
    }
}
