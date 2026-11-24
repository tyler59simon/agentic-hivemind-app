//! OOXML `.docx` reader producing a Tiptap-compatible JSON document plus media map and fidelity warnings.
use super::{mime_for_ext, open_zip_safe, read_entry_capped, DocxMedia, DocxWarning, MAX_TOTAL_EXPANDED};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use quick_xml::events::Event;
use quick_xml::Reader;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

pub struct ParsedDocx {
    pub doc: Value,
    pub media: HashMap<String, DocxMedia>,
    pub warnings: Vec<DocxWarning>,
    pub has_headers_footers: bool,
}

#[derive(Default)]
struct Rel {
    target: String,
}

fn local_name(s: &str) -> &str {
    s
}

fn attr_val(e: &quick_xml::events::BytesStart, want_local: &str) -> Option<String> {
    for a in e.attributes().flatten() {
        if a.key.local_name().as_ref() == want_local {
            let raw: &str = a.value.as_ref();
            return Some(quick_xml::escape::unescape(raw).map(|s| s.into_owned()).unwrap_or_else(|_| raw.to_string()));
        }
    }
    None
}

fn parse_rels(xml: &str) -> HashMap<String, Rel> {
    let mut out = HashMap::new();
    let mut reader = Reader::from_str(xml);
    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) if local_name(e.local_name().as_ref()) == "Relationship" => {
                if let (Some(id), Some(target)) = (attr_val(&e, "Id"), attr_val(&e, "Target")) {
                    out.insert(id, Rel { target });
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    out
}

/// Map styleId -> heading level (1..=6) or "quote" from `word/styles.xml`.
fn parse_styles(xml: &str) -> (HashMap<String, u8>, HashSet<String>) {
    let mut headings = HashMap::new();
    let mut quotes = HashSet::new();
    let mut reader = Reader::from_str(xml);
    let mut cur_id: Option<String> = None;
    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) if local_name(e.local_name().as_ref()) == "style" => {
                cur_id = attr_val(&e, "styleId");
                if let Some(ref id) = cur_id {
                    let low = id.to_ascii_lowercase();
                    if let Some(lvl) = heading_level_from_name(&low) {
                        headings.insert(id.clone(), lvl);
                    }
                    if low.contains("quote") {
                        quotes.insert(id.clone());
                    }
                }
            }
            Ok(Event::Empty(e)) | Ok(Event::Start(e)) if cur_id.is_some() => {
                let ln = e.local_name(); let tag = ln.as_ref();
                if tag == "outlineLvl"
                    && let Some(val) = attr_val(&e, "val").and_then(|v| v.parse::<u8>().ok())
                    && val < 6
                {
                    headings.insert(cur_id.clone().unwrap(), val + 1);
                } else if tag == "name"
                    && let Some(val) = attr_val(&e, "val")
                {
                    let low = val.to_ascii_lowercase();
                    if let Some(lvl) = heading_level_from_name(&low) {
                        headings.entry(cur_id.clone().unwrap()).or_insert(lvl);
                    }
                    if low.contains("quote") {
                        quotes.insert(cur_id.clone().unwrap());
                    }
                }
            }
            Ok(Event::End(e)) if local_name(e.local_name().as_ref()) == "style" => {
                cur_id = None;
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    (headings, quotes)
}

fn heading_level_from_name(low: &str) -> Option<u8> {
    let trimmed = low.replace(' ', "");
    if let Some(rest) = trimmed.strip_prefix("heading")
        && let Ok(n) = rest.parse::<u8>()
        && (1..=6).contains(&n)
    {
        return Some(n);
    }
    if trimmed == "title" {
        return Some(1);
    }
    None
}

/// Map `numId` -> true if ordered, false if bullet, from `word/numbering.xml`.
fn parse_numbering(xml: &str) -> HashMap<String, bool> {
    let mut abs_ordered: HashMap<String, bool> = HashMap::new();
    let mut num_to_abs: HashMap<String, String> = HashMap::new();
    let mut reader = Reader::from_str(xml);
    let mut cur_abs: Option<String> = None;
    let mut cur_num: Option<String> = None;
    let mut cur_ilvl: Option<u8> = None;
    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) => {
                let ln = e.local_name(); let tag = ln.as_ref();
                match tag {
                    "abstractNum" => cur_abs = attr_val(&e, "abstractNumId"),
                    "lvl" => cur_ilvl = attr_val(&e, "ilvl").and_then(|v| v.parse().ok()),
                    "num" => cur_num = attr_val(&e, "numId"),
                    _ => {}
                }
            }
            Ok(Event::Empty(e)) => {
                let ln = e.local_name(); let tag = ln.as_ref();
                if tag == "numFmt" && cur_ilvl.unwrap_or(0) == 0 && let Some(ref abs) = cur_abs {
                    let fmt = attr_val(&e, "val").unwrap_or_default().to_ascii_lowercase();
                    abs_ordered.entry(abs.clone()).or_insert(fmt != "bullet" && fmt != "none");
                } else if tag == "abstractNumId" && let (Some(n), Some(v)) = (&cur_num, attr_val(&e, "val")) {
                    num_to_abs.insert(n.clone(), v);
                }
            }
            Ok(Event::End(e)) => match local_name(e.local_name().as_ref()) {
                "abstractNum" => cur_abs = None,
                "lvl" => cur_ilvl = None,
                "num" => cur_num = None,
                _ => {}
            },
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    let mut out = HashMap::new();
    for (num, abs) in num_to_abs {
        out.insert(num, *abs_ordered.get(&abs).unwrap_or(&false));
    }
    out
}

fn highlight_to_hex(name: &str) -> String {
    match name.to_ascii_lowercase().as_str() {
        "yellow" => "#fef08a",
        "green" => "#bbf7d0",
        "cyan" => "#a5f3fc",
        "magenta" => "#f5d0fe",
        "blue" => "#bfdbfe",
        "red" => "#fecaca",
        "darkblue" => "#93c5fd",
        "darkcyan" => "#67e8f9",
        "darkgreen" => "#86efac",
        "darkmagenta" => "#e879f9",
        "darkred" => "#fca5a5",
        "darkyellow" => "#fde047",
        "darkgray" => "#d1d5db",
        "lightgray" => "#e5e7eb",
        other if other.starts_with('#') => other,
        other if other.len() == 6 && other.bytes().all(|b| b.is_ascii_hexdigit()) => return format!("#{other}"),
        _ => "#fef08a",
    }
    .to_string()
}

#[derive(Default, Clone)]
struct RunStyle {
    bold: bool,
    italic: bool,
    underline: bool,
    strike: bool,
    code: bool,
    sup: bool,
    sub: bool,
    color: Option<String>,
    highlight: Option<String>,
}

impl RunStyle {
    fn to_marks(&self, link_href: Option<&str>) -> Vec<Value> {
        let mut marks = Vec::new();
        if self.bold { marks.push(json!({ "type": "bold" })); }
        if self.italic { marks.push(json!({ "type": "italic" })); }
        if self.underline { marks.push(json!({ "type": "underline" })); }
        if self.strike { marks.push(json!({ "type": "strike" })); }
        if self.code { marks.push(json!({ "type": "code" })); }
        if self.sup { marks.push(json!({ "type": "superscript" })); }
        if self.sub { marks.push(json!({ "type": "subscript" })); }
        if let Some(ref c) = self.color {
            marks.push(json!({ "type": "docxTextColor", "attrs": { "color": c } }));
        }
        if let Some(ref h) = self.highlight {
            marks.push(json!({ "type": "docxHighlight", "attrs": { "color": h } }));
        }
        if let Some(href) = link_href {
            marks.push(json!({ "type": "link", "attrs": { "href": href } }));
        }
        marks
    }
}

struct ParseCtx<'a> {
    rels: &'a HashMap<String, Rel>,
    headings: &'a HashMap<String, u8>,
    quotes: &'a HashSet<String>,
    numbering: &'a HashMap<String, bool>,
    media: &'a mut HashMap<String, DocxMedia>,
    media_bytes: &'a HashMap<String, Vec<u8>>,
    saw_tracked: bool,
    saw_math: bool,
}

impl<'a> ParseCtx<'a> {
    fn register_media(&mut self, rel_id: &str) -> Option<String> {
        let rel = self.rels.get(rel_id)?;
        let normalized = if rel.target.starts_with("word/") {
            rel.target.clone()
        } else {
            format!("word/{}", rel.target.trim_start_matches('/').trim_start_matches("../"))
        };
        let bytes = self.media_bytes.get(&normalized)?;
        let id = normalized.clone();
        if !self.media.contains_key(&id) {
            let mime = mime_for_ext(&normalized).to_string();
            let data_url = format!("data:{mime};base64,{}", B64.encode(bytes));
            self.media.insert(id.clone(), DocxMedia { id: id.clone(), mime, data_url });
        }
        Some(id)
    }
}

#[derive(Debug)]
enum BodyItem {
    Node(Value),
    ListItem { ordered: bool, paragraph: Value },
}

fn parse_paragraph(reader: &mut Reader<&[u8]>, ctx: &mut ParseCtx) -> Result<BodyItem, String> {
    let mut style_id: Option<String> = None;
    let mut align: Option<String> = None;
    let mut num_id: Option<String> = None;
    let mut has_bottom_border = false;
    let mut has_page_break = false;
    let mut inlines: Vec<Value> = Vec::new();
    let mut cur_link: Option<String> = None;
    let mut in_ppr = false;
    let mut in_rpr = false;
    let mut in_t = false;
    let mut run_style = RunStyle::default();
    let mut depth: usize = 1;

    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) => {
                depth += 1;
                let ln = e.local_name(); let tag = ln.as_ref();
                match tag {
                    "pPr" if depth == 2 => in_ppr = true,
                    "rPr" => in_rpr = true,
                    "r" => run_style = RunStyle::default(),
                    "t" => in_t = true,
                    "ins" | "del" => ctx.saw_tracked = true,
                    "oMath" | "oMathPara" => ctx.saw_math = true,
                    "hyperlink" => {
                        if let Some(rid) = attr_val(&e, "id")
                            && let Some(rel) = ctx.rels.get(&rid)
                        {
                            cur_link = Some(rel.target.clone());
                        }
                    }
                    "blip" => {
                        if let Some(rid) = attr_val(&e, "embed")
                            && let Some(media_id) = ctx.register_media(&rid)
                        {
                            inlines.push(json!({ "type": "docxImage", "attrs": { "mediaId": media_id, "alt": "" } }));
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::Empty(e)) => {
                let ln = e.local_name(); let tag = ln.as_ref();
                if in_ppr {
                    match tag {
                        "pStyle" => style_id = attr_val(&e, "val"),
                        "jc" => {
                            let v = attr_val(&e, "val").unwrap_or_default().to_ascii_lowercase();
                            if matches!(v.as_str(), "left" | "center" | "right" | "both" | "justify") {
                                align = Some(if v == "both" { "justify".into() } else { v });
                            }
                        }
                        "numId" => num_id = attr_val(&e, "val"),
                        "bottom" => has_bottom_border = true,
                        _ => {}
                    }
                } else if in_rpr {
                    match tag {
                        "b" | "bCs" => run_style.bold = attr_val(&e, "val").as_deref() != Some("0") && attr_val(&e, "val").as_deref() != Some("false"),
                        "i" | "iCs" => run_style.italic = attr_val(&e, "val").as_deref() != Some("0") && attr_val(&e, "val").as_deref() != Some("false"),
                        "u" => run_style.underline = attr_val(&e, "val").as_deref() != Some("none"),
                        "strike" | "dstrike" => run_style.strike = attr_val(&e, "val").as_deref() != Some("0"),
                        "vertAlign" => match attr_val(&e, "val").as_deref() {
                            Some("superscript") => run_style.sup = true,
                            Some("subscript") => run_style.sub = true,
                            _ => {}
                        },
                        "color" => {
                            if let Some(c) = attr_val(&e, "val")
                                && c.len() == 6
                                && c.bytes().all(|b| b.is_ascii_hexdigit())
                            {
                                run_style.color = Some(format!("#{c}"));
                            }
                        }
                        "highlight" => {
                            if let Some(h) = attr_val(&e, "val") && h != "none" {
                                run_style.highlight = Some(highlight_to_hex(&h));
                            }
                        }
                        "rFonts" => {
                            let font = attr_val(&e, "ascii").or_else(|| attr_val(&e, "hAnsi")).unwrap_or_default().to_ascii_lowercase();
                            if font.contains("mono") || font.contains("consolas") || font.contains("courier") {
                                run_style.code = true;
                            }
                        }
                        _ => {}
                    }
                } else {
                    match tag {
                        "br" => {
                            if attr_val(&e, "type").as_deref() == Some("page") {
                                has_page_break = true;
                            } else {
                                inlines.push(json!({ "type": "hardBreak" }));
                            }
                        }
                        "tab" => {
                            let marks = run_style.to_marks(cur_link.as_deref());
                            let mut node = json!({ "type": "text", "text": "\t" });
                            if !marks.is_empty() { node["marks"] = Value::Array(marks); }
                            inlines.push(node);
                        }
                        "blip" => {
                            if let Some(rid) = attr_val(&e, "embed")
                                && let Some(media_id) = ctx.register_media(&rid)
                            {
                                inlines.push(json!({ "type": "docxImage", "attrs": { "mediaId": media_id, "alt": "" } }));
                            }
                        }
                        _ => {}
                    }
                }
            }
            Ok(Event::Text(t)) if in_t => {
                let raw: &str = t.as_ref();
                let decoded = quick_xml::escape::unescape(raw).map(|s| s.into_owned()).unwrap_or_else(|_| raw.to_string());
                if !decoded.is_empty() {
                    let marks = run_style.to_marks(cur_link.as_deref());
                    let mut node = json!({ "type": "text", "text": decoded });
                    if !marks.is_empty() { node["marks"] = Value::Array(marks); }
                    inlines.push(node);
                }
            }
            Ok(Event::End(e)) => {
                let ln = e.local_name(); let tag = ln.as_ref();
                match tag {
                    "pPr" if depth == 2 => in_ppr = false,
                    "rPr" => in_rpr = false,
                    "t" => in_t = false,
                    "hyperlink" => cur_link = None,
                    _ => {}
                }
                depth -= 1;
                if depth == 0 {
                    break;
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(format!("Malformed paragraph XML: {e}")),
            _ => {}
        }
    }

    if has_page_break && inlines.is_empty() {
        return Ok(BodyItem::Node(json!({ "type": "docxPageBreak" })));
    }
    if has_bottom_border && inlines.is_empty() {
        return Ok(BodyItem::Node(json!({ "type": "horizontalRule" })));
    }

    let mut attrs = serde_json::Map::new();
    if let Some(al) = align {
        attrs.insert("textAlign".into(), Value::String(al));
    }

    if let Some(ref sid) = style_id
        && let Some(&level) = ctx.headings.get(sid).or_else(|| heading_level_from_name(&sid.to_ascii_lowercase()).as_ref().map(|_| &1u8))
    {
        let resolved = ctx.headings.get(sid).copied().or_else(|| heading_level_from_name(&sid.to_ascii_lowercase())).unwrap_or(level);
        attrs.insert("level".into(), json!(resolved));
        let mut node = json!({ "type": "heading", "attrs": attrs });
        if !inlines.is_empty() { node["content"] = Value::Array(inlines); }
        return Ok(BodyItem::Node(node));
    }

    let mut para = json!({ "type": "paragraph" });
    if !attrs.is_empty() { para["attrs"] = Value::Object(attrs); }
    if !inlines.is_empty() { para["content"] = Value::Array(inlines); }

    if let Some(nid) = num_id && nid != "0" {
        let ordered = *ctx.numbering.get(&nid).unwrap_or(&false);
        return Ok(BodyItem::ListItem { ordered, paragraph: para });
    }

    if let Some(ref sid) = style_id && (ctx.quotes.contains(sid) || sid.to_ascii_lowercase().contains("quote")) {
        return Ok(BodyItem::Node(json!({ "type": "blockquote", "content": [para] })));
    }

    Ok(BodyItem::Node(para))
}

fn parse_table(reader: &mut Reader<&[u8]>, ctx: &mut ParseCtx) -> Result<Value, String> {
    let mut rows: Vec<Value> = Vec::new();
    let mut depth: usize = 1;
    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) => {
                let ln = e.local_name(); let tag = ln.as_ref();
                if depth == 1 && tag == "tr" {
                    rows.push(parse_table_row(reader, ctx)?);
                } else {
                    depth += 1;
                }
            }
            Ok(Event::End(_)) => {
                depth -= 1;
                if depth == 0 { break; }
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(format!("Malformed table XML: {e}")),
            _ => {}
        }
    }
    if rows.is_empty() {
        rows.push(json!({ "type": "tableRow", "content": [{ "type": "tableCell", "content": [{ "type": "paragraph" }] }] }));
    }
    Ok(json!({ "type": "table", "content": rows }))
}

fn parse_table_row(reader: &mut Reader<&[u8]>, ctx: &mut ParseCtx) -> Result<Value, String> {
    let mut cells: Vec<Value> = Vec::new();
    let mut is_header = false;
    let mut depth: usize = 1;
    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) => {
                let ln = e.local_name(); let tag = ln.as_ref();
                if depth == 1 && tag == "tc" {
                    cells.push(parse_table_cell(reader, ctx, is_header)?);
                } else {
                    if tag == "tblHeader" { is_header = true; }
                    depth += 1;
                }
            }
            Ok(Event::Empty(e)) => {
                if local_name(e.local_name().as_ref()) == "tblHeader" {
                    is_header = true;
                }
            }
            Ok(Event::End(_)) => {
                depth -= 1;
                if depth == 0 { break; }
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(format!("Malformed table row XML: {e}")),
            _ => {}
        }
    }
    if cells.is_empty() {
        cells.push(json!({ "type": if is_header { "tableHeader" } else { "tableCell" }, "content": [{ "type": "paragraph" }] }));
    }
    Ok(json!({ "type": "tableRow", "content": cells }))
}

fn parse_table_cell(reader: &mut Reader<&[u8]>, ctx: &mut ParseCtx, is_header: bool) -> Result<Value, String> {
    let mut colspan: u32 = 1;
    let mut blocks: Vec<Value> = Vec::new();
    let mut depth: usize = 1;
    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) => {
                let ln = e.local_name(); let tag = ln.as_ref();
                if depth == 1 && tag == "p" {
                    match parse_paragraph(reader, ctx)? {
                        BodyItem::Node(n) => blocks.push(n),
                        BodyItem::ListItem { paragraph, .. } => blocks.push(paragraph),
                    }
                } else {
                    depth += 1;
                }
            }
            Ok(Event::Empty(e)) => {
                if local_name(e.local_name().as_ref()) == "gridSpan" {
                    colspan = attr_val(&e, "val").and_then(|v| v.parse().ok()).unwrap_or(1).max(1);
                }
            }
            Ok(Event::End(_)) => {
                depth -= 1;
                if depth == 0 { break; }
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(format!("Malformed table cell XML: {e}")),
            _ => {}
        }
    }
    if blocks.is_empty() {
        blocks.push(json!({ "type": "paragraph" }));
    }
    let mut cell = json!({ "type": if is_header { "tableHeader" } else { "tableCell" }, "content": blocks });
    if colspan > 1 {
        cell["attrs"] = json!({ "colspan": colspan, "rowspan": 1 });
    }
    Ok(cell)
}

/// Group flat `BodyItem` stream into Tiptap top-level nodes (combining consecutive list items).
fn assemble_body(items: Vec<BodyItem>) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    let mut cur_list: Option<(bool, Vec<Value>)> = None;

    let flush = |cur: &mut Option<(bool, Vec<Value>)>, out: &mut Vec<Value>| {
        if let Some((ordered, list_items)) = cur.take() {
            out.push(json!({
                "type": if ordered { "orderedList" } else { "bulletList" },
                "content": list_items
            }));
        }
    };

    for item in items {
        match item {
            BodyItem::Node(n) => {
                flush(&mut cur_list, &mut out);
                out.push(n);
            }
            BodyItem::ListItem { ordered, paragraph, .. } => {
                if let Some((is_ord, _)) = &cur_list && *is_ord != ordered {
                    flush(&mut cur_list, &mut out);
                }
                let li = json!({ "type": "listItem", "content": [paragraph] });
                match &mut cur_list {
                    Some((_, list_items)) => list_items.push(li),
                    None => cur_list = Some((ordered, vec![li])),
                }
            }
        }
    }
    flush(&mut cur_list, &mut out);
    if out.is_empty() {
        out.push(json!({ "type": "paragraph" }));
    }
    out
}

/// Read a `.docx` archive's bytes into a Tiptap JSON document, media data URLs, and fidelity warnings.
pub fn read_docx_bytes(bytes: &[u8]) -> Result<ParsedDocx, String> {
    let mut archive = open_zip_safe(bytes)?;
    let mut budget = MAX_TOTAL_EXPANDED;
    let mut warnings = Vec::new();
    let mut has_headers_footers = false;
    let mut media_bytes: HashMap<String, Vec<u8>> = HashMap::new();

    // Scan archive entries for media and Word-only features.
    let names: Vec<String> = (0..archive.len())
        .filter_map(|i| archive.by_index(i).ok().map(|e| e.name().to_string()))
        .collect();
    let mut has_comments = false;
    let mut has_macros = false;
    let mut has_diagrams = false;
    let mut has_charts = false;
    let mut has_notes = false;
    for name in &names {
        let low = name.to_ascii_lowercase();
        if low.starts_with("word/header") || low.starts_with("word/footer") {
            has_headers_footers = true;
        } else if low == "word/comments.xml" {
            has_comments = true;
        } else if low.ends_with("vbaproject.bin") {
            has_macros = true;
        } else if low.starts_with("word/diagrams/") {
            has_diagrams = true;
        } else if low.starts_with("word/charts/") {
            has_charts = true;
        } else if low == "word/footnotes.xml" || low == "word/endnotes.xml" {
            has_notes = true;
        } else if low.starts_with("word/media/") && !low.ends_with('/') {
            if let Some(data) = read_entry_capped(&mut archive, name, &mut budget)? {
                media_bytes.insert(name.clone(), data);
            }
        }
    }

    let doc_bytes = read_entry_capped(&mut archive, "word/document.xml", &mut budget)?
        .ok_or("This .docx file is missing word/document.xml")?;
    let doc_xml = String::from_utf8(doc_bytes).map_err(|_| "word/document.xml is not valid UTF-8")?;

    let rels = read_entry_capped(&mut archive, "word/_rels/document.xml.rels", &mut budget)?
        .and_then(|b| String::from_utf8(b).ok())
        .map(|s| parse_rels(&s))
        .unwrap_or_default();
    let (headings, quotes) = read_entry_capped(&mut archive, "word/styles.xml", &mut budget)?
        .and_then(|b| String::from_utf8(b).ok())
        .map(|s| parse_styles(&s))
        .unwrap_or_default();
    let numbering = read_entry_capped(&mut archive, "word/numbering.xml", &mut budget)?
        .and_then(|b| String::from_utf8(b).ok())
        .map(|s| parse_numbering(&s))
        .unwrap_or_default();

    let mut media = HashMap::new();
    let mut ctx = ParseCtx {
        rels: &rels,
        headings: &headings,
        quotes: &quotes,
        numbering: &numbering,
        media: &mut media,
        media_bytes: &media_bytes,
        saw_tracked: false,
        saw_math: false,
    };

    let mut items: Vec<BodyItem> = Vec::new();
    let mut reader = Reader::from_str(&doc_xml);
    let mut in_body = false;

    loop {
        let before = reader.buffer_position() as usize;
        match reader.read_event() {
            Ok(Event::Start(e)) => {
                let ln = e.local_name(); let tag = ln.as_ref();
                if !in_body {
                    if tag == "body" { in_body = true; }
                    continue;
                }
                match tag {
                    "p" => items.push(parse_paragraph(&mut reader, &mut ctx)?),
                    "tbl" => items.push(BodyItem::Node(parse_table(&mut reader, &mut ctx)?)),
                    "sectPr" => {
                        let _ = reader.read_to_end(e.to_end().name());
                    }
                    other => {
                        let label = match other {
                            "sdt" => "Word content control",
                            "oMathPara" | "oMath" => { ctx.saw_math = true; "Word equation" }
                            "ins" | "del" => { ctx.saw_tracked = true; "Tracked change" }
                            _ => "Preserved Word block",
                        };
                        let start_idx = doc_xml[..before.min(doc_xml.len())].len();
                        let tag_start = doc_xml[start_idx..].find('<').map(|i| start_idx + i).unwrap_or(start_idx);
                        let _ = reader.read_to_end(e.to_end().name());
                        let end_idx = (reader.buffer_position() as usize).min(doc_xml.len());
                        let raw_xml = doc_xml[tag_start..end_idx].to_string();
                        items.push(BodyItem::Node(json!({
                            "type": "docxRawBlock",
                            "attrs": { "label": label, "xml": raw_xml }
                        })));
                    }
                }
            }
            Ok(Event::End(e)) if in_body && local_name(e.local_name().as_ref()) == "body" => break,
            Ok(Event::Eof) => break,
            Err(e) => return Err(format!("Malformed word/document.xml: {e}")),
            _ => {}
        }
    }

    if ctx.saw_tracked {
        warnings.push(DocxWarning { kind: "trackedChanges".into(), message: "Contains tracked changes (insertions/deletions) that cannot be edited as revisions here.".into() });
    }
    if has_comments {
        warnings.push(DocxWarning { kind: "comments".into(), message: "Contains Word comments (not shown in Edit mode; original comments XML is preserved in the archive).".into() });
    }
    if has_diagrams {
        warnings.push(DocxWarning { kind: "smartArt".into(), message: "Contains SmartArt graphics that cannot be edited visually here.".into() });
    }
    if has_charts {
        warnings.push(DocxWarning { kind: "charts".into(), message: "Contains embedded Word charts that cannot be edited visually here.".into() });
    }
    if ctx.saw_math {
        warnings.push(DocxWarning { kind: "equations".into(), message: "Contains Word math equations (preserved as read-only blocks on save).".into() });
    }
    if has_macros {
        warnings.push(DocxWarning { kind: "macros".into(), message: "Contains VBA macros (preserved untouched in the archive).".into() });
    }
    if has_notes {
        warnings.push(DocxWarning { kind: "footnotes".into(), message: "Contains footnotes or endnotes (not editable inline here; original notes part is kept).".into() });
    }

    Ok(ParsedDocx {
        doc: json!({ "type": "doc", "content": assemble_body(items) }),
        media,
        warnings,
        has_headers_footers,
    })
}
