//! Surgical OOXML `.docx` writer: patches `<w:body>` and new media/relationships while keeping untouched
//! archive entries (`styles.xml`, `header*.xml`, `footer*.xml`, `theme/*`, `docProps/*`, `<w:sectPr>`) verbatim.
use super::{ext_for_mime, open_zip_safe, read_entry_capped, NewDocxMedia, MAX_SINGLE_ENTRY, MAX_TOTAL_EXPANDED, MAX_ZIP_ENTRIES};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use quick_xml::events::Event;
use quick_xml::Reader;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::io::{Cursor, Read, Write};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

const DEFAULT_CONTENT_TYPES: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Default Extension="jpeg" ContentType="image/jpeg"/>
  <Default Extension="jpg" ContentType="image/jpeg"/>
  <Default Extension="gif" ContentType="image/gif"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
</Types>"#;

const ROOT_RELS: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>"#;

const DEFAULT_DOC_RELS: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
</Relationships>"#;

const DEFAULT_STYLES: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="30"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:pPr><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading4"><w:name w:val="heading 4"/><w:pPr><w:outlineLvl w:val="3"/></w:pPr><w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:pPr><w:ind w:left="720"/></w:pPr><w:rPr><w:i/><w:color w:val="555555"/></w:rPr></w:style>
</w:styles>"#;

const DEFAULT_NUMBERING: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>
  <w:abstractNum w:abstractNumId="2"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>
  <w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num>
  <w:num w:numId="2"><w:abstractNumId w:val="2"/></w:num>
</w:numbering>"#;

const DEFAULT_DOCUMENT: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
  <w:body>
    <w:p/>
    <w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>
  </w:body>
</w:document>"#;

const HYPERLINK_REL_TYPE: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink";
const IMAGE_REL_TYPE: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image";

fn escape_xml(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// Generate a valid minimal `.docx` file with one empty paragraph.
pub fn blank_docx() -> Result<Vec<u8>, String> {
    let mut buf = Vec::new();
    let mut z = ZipWriter::new(Cursor::new(&mut buf));
    let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    for (name, content) in [
        ("[Content_Types].xml", DEFAULT_CONTENT_TYPES),
        ("_rels/.rels", ROOT_RELS),
        ("word/_rels/document.xml.rels", DEFAULT_DOC_RELS),
        ("word/styles.xml", DEFAULT_STYLES),
        ("word/numbering.xml", DEFAULT_NUMBERING),
        ("word/document.xml", DEFAULT_DOCUMENT),
    ] {
        z.start_file(name, opts).map_err(|e| format!("Could not build .docx: {e}"))?;
        z.write_all(content.as_bytes()).map_err(|e| format!("Could not write .docx: {e}"))?;
    }
    z.finish().map_err(|e| format!("Could not finalize .docx: {e}"))?;
    Ok(buf)
}

#[derive(Clone)]
struct RelEntry {
    id: String,
    rel_type: String,
    target: String,
    external: bool,
}

fn parse_rel_entries(xml: &str) -> Vec<RelEntry> {
    let mut out = Vec::new();
    let mut reader = Reader::from_str(xml);
    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) if e.local_name().as_ref() == "Relationship" => {
                let mut id = String::new();
                let mut rel_type = String::new();
                let mut target = String::new();
                let mut external = false;
                for a in e.attributes().flatten() {
                    let ln = a.key.local_name();
                    let k: &str = ln.as_ref();
                    let raw: &str = a.value.as_ref();
                    let v = quick_xml::escape::unescape(raw).map(|s| s.into_owned()).unwrap_or_else(|_| raw.to_string());
                    match k {
                        "Id" => id = v,
                        "Type" => rel_type = v,
                        "Target" => target = v,
                        "TargetMode" => external = v.eq_ignore_ascii_case("External"),
                        _ => {}
                    }
                }
                if !id.is_empty() && !target.is_empty() {
                    out.push(RelEntry { id, rel_type, target, external });
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    out
}

fn next_rid(rels: &[RelEntry]) -> String {
    let used: HashSet<&str> = rels.iter().map(|r| r.id.as_str()).collect();
    for n in 1..100_000 {
        let cand = format!("rId{n}");
        if !used.contains(cand.as_str()) {
            return cand;
        }
    }
    format!("rId{}", rels.len() + 1)
}

/// Extract ONLY the body-level trailing `<w:sectPr>` (direct child of `<w:body>`),
/// leaving paragraph-level `<w:pPr><w:sectPr>` section breaks to their paragraphs.
fn extract_body_sect_pr(doc_xml: &str) -> String {
    let mut reader = Reader::from_str(doc_xml);
    let mut in_body = false;
    let mut body_depth: usize = 0;
    let mut found: Option<String> = None;
    loop {
        let before = reader.buffer_position() as usize;
        match reader.read_event() {
            Ok(Event::Start(e)) => {
                let ln = e.local_name(); let tag = ln.as_ref();
                if !in_body {
                    if tag == "body" {
                        in_body = true;
                        body_depth = 0;
                    }
                    continue;
                }
                if body_depth == 0 && tag == "sectPr" {
                    let start_idx = before.min(doc_xml.len());
                    let tag_start = doc_xml[start_idx..].find('<').map(|i| start_idx + i).unwrap_or(start_idx);
                    let _ = reader.read_to_end(e.to_end().name());
                    let end_idx = (reader.buffer_position() as usize).min(doc_xml.len());
                    found = Some(doc_xml[tag_start..end_idx].to_string());
                } else {
                    body_depth += 1;
                }
            }
            Ok(Event::Empty(e)) if in_body && body_depth == 0 && e.local_name().as_ref() == "sectPr" => {
                let start_idx = before.min(doc_xml.len());
                let tag_start = doc_xml[start_idx..].find('<').map(|i| start_idx + i).unwrap_or(start_idx);
                let end_idx = (reader.buffer_position() as usize).min(doc_xml.len());
                found = Some(doc_xml[tag_start..end_idx].to_string());
            }
            Ok(Event::End(e)) if in_body => {
                if body_depth == 0 && e.local_name().as_ref() == "body" {
                    break;
                }
                body_depth = body_depth.saturating_sub(1);
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    found.unwrap_or_else(|| {
        r#"<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>"#.into()
    })
}

#[derive(Default)]
struct NumberingInfo {
    known_num_ids: HashSet<String>,
    existing_bullet_id: Option<String>,
    existing_ordered_id: Option<String>,
    max_num_id: u32,
    max_abs_id: u32,
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

fn analyze_numbering(xml: &str) -> NumberingInfo {
    let mut info = NumberingInfo::default();
    let mut abs_fmt: HashMap<String, String> = HashMap::new();
    let mut num_to_abs: Vec<(String, String)> = Vec::new();
    let mut reader = Reader::from_str(xml);
    let mut cur_abs: Option<String> = None;
    let mut cur_num: Option<String> = None;
    let mut cur_ilvl: Option<u8> = None;
    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) => {
                let ln = e.local_name(); let tag = ln.as_ref();
                match tag {
                    "abstractNum" => {
                        cur_abs = attr_val(&e, "abstractNumId");
                        if let Some(n) = cur_abs.as_deref().and_then(|v| v.parse::<u32>().ok()) {
                            info.max_abs_id = info.max_abs_id.max(n);
                        }
                    }
                    "lvl" => cur_ilvl = attr_val(&e, "ilvl").and_then(|v| v.parse().ok()),
                    "num" => {
                        cur_num = attr_val(&e, "numId");
                        if let Some(ref id) = cur_num {
                            info.known_num_ids.insert(id.clone());
                            if let Ok(n) = id.parse::<u32>() {
                                info.max_num_id = info.max_num_id.max(n);
                            }
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::Empty(e)) => {
                let ln = e.local_name(); let tag = ln.as_ref();
                if tag == "numFmt" && cur_ilvl.unwrap_or(0) == 0 && let Some(ref abs) = cur_abs {
                    let fmt = attr_val(&e, "val").unwrap_or_default().to_ascii_lowercase();
                    abs_fmt.entry(abs.clone()).or_insert(fmt);
                } else if tag == "abstractNumId" && let (Some(n), Some(v)) = (&cur_num, attr_val(&e, "val")) {
                    num_to_abs.push((n.clone(), v));
                }
            }
            Ok(Event::End(e)) => match e.local_name().as_ref() {
                "abstractNum" => cur_abs = None,
                "lvl" => cur_ilvl = None,
                "num" => cur_num = None,
                _ => {}
            },
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    for (num_id, abs_id) in num_to_abs {
        if let Some(fmt) = abs_fmt.get(&abs_id) {
            if fmt == "bullet" && info.existing_bullet_id.is_none() {
                info.existing_bullet_id = Some(num_id);
            } else if fmt == "decimal" && info.existing_ordered_id.is_none() {
                info.existing_ordered_id = Some(num_id);
            }
        }
    }
    info
}

fn patch_numbering_xml(orig: &str, new_abs: &[String], new_nums: &[String]) -> String {
    let mut out = orig.to_string();
    if !new_abs.is_empty() {
        let joined = new_abs.join("\n  ");
        if let Some(pos) = out.find("<w:num ").or_else(|| out.rfind("</w:numbering>")) {
            out.insert_str(pos, &format!("{joined}\n  "));
        }
    }
    if !new_nums.is_empty() {
        let joined = new_nums.join("\n  ");
        if let Some(pos) = out.rfind("</w:numbering>") {
            out.insert_str(pos, &format!("  {joined}\n"));
        }
    }
    out
}

fn extract_doc_open_tag(doc_xml: &str) -> String {
    if let Some(start) = doc_xml.find("<w:document")
        && let Some(end_rel) = doc_xml[start..].find('>')
    {
        let mut tag = doc_xml[start..start + end_rel].to_string();
        for (ns, uri) in [
            ("xmlns:w", "http://schemas.openxmlformats.org/wordprocessingml/2006/main"),
            ("xmlns:r", "http://schemas.openxmlformats.org/officeDocument/2006/relationships"),
            ("xmlns:wp", "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"),
            ("xmlns:a", "http://schemas.openxmlformats.org/drawingml/2006/main"),
            ("xmlns:pic", "http://schemas.openxmlformats.org/drawingml/2006/picture"),
        ] {
            if !tag.contains(ns) {
                tag.push_str(&format!(" {ns}=\"{uri}\""));
            }
        }
        tag.push('>');
        return tag;
    }
    r#"<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">"#.into()
}

struct WriteCtx {
    rels: Vec<RelEntry>,
    media_rid: HashMap<String, String>,
    next_docpr_id: u32,
    used_lists: bool,
    has_existing_numbering: bool,
    numbering: NumberingInfo,
    added_abs_xml: Vec<String>,
    added_num_xml: Vec<String>,
}

impl WriteCtx {
    fn resolve_list_num_id(&mut self, ordered: bool, requested: Option<&str>) -> String {
        self.used_lists = true;
        if let Some(id) = requested
            && !id.is_empty()
            && self.numbering.known_num_ids.contains(id)
        {
            return id.to_string();
        }
        if !self.has_existing_numbering {
            return if ordered { "2".into() } else { "1".into() };
        }
        if !ordered && let Some(ref id) = self.numbering.existing_bullet_id {
            return id.clone();
        }
        if ordered && let Some(ref id) = self.numbering.existing_ordered_id {
            return id.clone();
        }
        self.numbering.max_abs_id += 1;
        self.numbering.max_num_id += 1;
        let abs_id = self.numbering.max_abs_id;
        let num_id = self.numbering.max_num_id.to_string();
        let abs_xml = if ordered {
            format!(r#"<w:abstractNum w:abstractNumId="{abs_id}"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>"#)
        } else {
            format!(r#"<w:abstractNum w:abstractNumId="{abs_id}"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>"#)
        };
        let num_xml = format!(r#"<w:num w:numId="{num_id}"><w:abstractNumId w:val="{abs_id}"/></w:num>"#);
        self.added_abs_xml.push(abs_xml);
        self.added_num_xml.push(num_xml);
        self.numbering.known_num_ids.insert(num_id.clone());
        if ordered {
            self.numbering.existing_ordered_id = Some(num_id.clone());
        } else {
            self.numbering.existing_bullet_id = Some(num_id.clone());
        }
        num_id
    }

    fn link_rid(&mut self, href: &str) -> String {
        if let Some(existing) = self.rels.iter().find(|r| r.rel_type == HYPERLINK_REL_TYPE && r.target == href) {
            return existing.id.clone();
        }
        let id = next_rid(&self.rels);
        self.rels.push(RelEntry { id: id.clone(), rel_type: HYPERLINK_REL_TYPE.into(), target: href.into(), external: true });
        id
    }

    fn image_drawing_xml(&mut self, media_id: &str, alt: &str) -> String {
        let Some(rid) = self.media_rid.get(media_id).cloned() else { return String::new() };
        let id = self.next_docpr_id;
        self.next_docpr_id += 1;
        // Default 4 in x 2.5 in (EMU: 914400 per inch)
        let (cx, cy) = (3_657_600u64, 2_286_000u64);
        format!(
            r#"<w:r><w:drawing><wp:inline><wp:extent cx="{cx}" cy="{cy}"/><wp:docPr id="{id}" name="Image {id}" descr="{}"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="{id}" name="Image {id}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="{rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="{cx}" cy="{cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>"#,
            escape_xml(alt)
        )
    }
}

fn hex_to_word_highlight(hex: &str) -> &'static str {
    match hex.to_ascii_lowercase().as_str() {
        "#bbf7d0" | "#86efac" => "green",
        "#a5f3fc" | "#67e8f9" => "cyan",
        "#bfdbfe" | "#93c5fd" => "blue",
        "#fecaca" | "#fca5a5" => "red",
        "#f5d0fe" | "#e879f9" => "magenta",
        "#d1d5db" | "#e5e7eb" => "lightGray",
        _ => "yellow",
    }
}

fn emit_inlines(nodes: &[Value], ctx: &mut WriteCtx) -> String {
    let mut out = String::new();
    for node in nodes {
        match node["type"].as_str().unwrap_or("") {
            "text" => {
                let text = node["text"].as_str().unwrap_or("");
                let marks = node["marks"].as_array();
                let mut rpr = String::new();
                let mut href: Option<String> = None;
                if let Some(ms) = marks {
                    for m in ms {
                        match m["type"].as_str().unwrap_or("") {
                            "bold" => rpr.push_str("<w:b/>"),
                            "italic" => rpr.push_str("<w:i/>"),
                            "underline" => rpr.push_str(r#"<w:u w:val="single"/>"#),
                            "strike" => rpr.push_str("<w:strike/>"),
                            "superscript" => rpr.push_str(r#"<w:vertAlign w:val="superscript"/>"#),
                            "subscript" => rpr.push_str(r#"<w:vertAlign w:val="subscript"/>"#),
                            "code" => rpr.push_str(r#"<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>"#),
                            "docxTextColor" => {
                                if let Some(c) = m["attrs"]["color"].as_str() {
                                    let clean = c.trim_start_matches('#');
                                    if clean.len() == 6 && clean.bytes().all(|b| b.is_ascii_hexdigit()) {
                                        rpr.push_str(&format!(r#"<w:color w:val="{clean}"/>"#));
                                    }
                                }
                            }
                            "docxHighlight" => {
                                if let Some(h) = m["attrs"]["color"].as_str() {
                                    rpr.push_str(&format!(r#"<w:highlight w:val="{}"/>"#, hex_to_word_highlight(h)));
                                }
                            }
                            "link" => {
                                if let Some(u) = m["attrs"]["href"].as_str() {
                                    href = Some(u.to_string());
                                }
                            }
                            _ => {}
                        }
                    }
                }
                let run = format!(
                    "<w:r>{}<w:t xml:space=\"preserve\">{}</w:t></w:r>",
                    if rpr.is_empty() { String::new() } else { format!("<w:rPr>{rpr}</w:rPr>") },
                    escape_xml(text)
                );
                if let Some(u) = href {
                    let rid = ctx.link_rid(&u);
                    out.push_str(&format!(r#"<w:hyperlink r:id="{rid}">{run}</w:hyperlink>"#));
                } else {
                    out.push_str(&run);
                }
            }
            "hardBreak" => out.push_str("<w:r><w:br/></w:r>"),
            "docxImage" => {
                let mid = node["attrs"]["mediaId"].as_str().unwrap_or("");
                let alt = node["attrs"]["alt"].as_str().unwrap_or("");
                out.push_str(&ctx.image_drawing_xml(mid, alt));
            }
            _ => {}
        }
    }
    out
}

fn emit_paragraph(node: &Value, style: Option<&str>, num_id: Option<&str>, ctx: &mut WriteCtx) -> String {
    let mut ppr = String::new();
    if let Some(st) = style {
        ppr.push_str(&format!(r#"<w:pStyle w:val="{}"/>"#, escape_xml(st)));
    }
    if let Some(nid) = num_id {
        ctx.used_lists = true;
        ppr.push_str(&format!(r#"<w:numPr><w:ilvl w:val="0"/><w:numId w:val="{}"/></w:numPr>"#, escape_xml(nid)));
    }
    if let Some(al) = node["attrs"]["textAlign"].as_str() {
        let jc = match al {
            "center" => Some("center"),
            "right" => Some("right"),
            "justify" => Some("both"),
            "left" => Some("left"),
            _ => None,
        };
        if let Some(v) = jc {
            ppr.push_str(&format!(r#"<w:jc w:val="{v}"/>"#));
        }
    }
    if let Some(sect_xml) = node["attrs"]["sectPrXml"].as_str() {
        let trimmed = sect_xml.trim();
        if trimmed.starts_with("<w:sectPr") || trimmed.starts_with("<sectPr") {
            ppr.push_str(trimmed);
        }
    }
    let inner = node["content"].as_array().map(|a| emit_inlines(a, ctx)).unwrap_or_default();
    if ppr.is_empty() {
        format!("<w:p>{inner}</w:p>")
    } else {
        format!("<w:p><w:pPr>{ppr}</w:pPr>{inner}</w:p>")
    }
}

fn emit_block(node: &Value, ctx: &mut WriteCtx) -> String {
    match node["type"].as_str().unwrap_or("") {
        "paragraph" => emit_paragraph(node, None, None, ctx),
        "heading" => {
            let lvl = node["attrs"]["level"].as_u64().unwrap_or(1).clamp(1, 6);
            emit_paragraph(node, Some(&format!("Heading{lvl}")), None, ctx)
        }
        "blockquote" => node["content"]
            .as_array()
            .map(|kids| kids.iter().map(|k| emit_paragraph(k, Some("Quote"), None, ctx)).collect::<String>())
            .unwrap_or_default(),
        "bulletList" | "orderedList" => {
            let ordered = node["type"].as_str() == Some("orderedList");
            let requested = node["attrs"]["listNumId"].as_str();
            let nid = ctx.resolve_list_num_id(ordered, requested);
            let mut out = String::new();
            if let Some(items) = node["content"].as_array() {
                for li in items {
                    if let Some(blocks) = li["content"].as_array() {
                        for b in blocks {
                            if b["type"].as_str() == Some("paragraph") {
                                out.push_str(&emit_paragraph(b, None, Some(&nid), ctx));
                            } else {
                                out.push_str(&emit_block(b, ctx));
                            }
                        }
                    }
                }
            }
            out
        }
        "codeBlock" => {
            let text = node["content"].as_array().and_then(|a| a.first()).and_then(|t| t["text"].as_str()).unwrap_or("");
            text.split('\n')
                .map(|line| format!(r#"<w:p><w:r><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/></w:rPr><w:t xml:space="preserve">{}</w:t></w:r></w:p>"#, escape_xml(line)))
                .collect()
        }
        "horizontalRule" => r#"<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="auto"/></w:pBdr></w:pPr></w:p>"#.into(),
        "docxPageBreak" => r#"<w:p><w:r><w:br w:type="page"/></w:r></w:p>"#.into(),
        "docxRawBlock" => node["attrs"]["xml"].as_str().unwrap_or("").to_string(),
        "table" => {
            let mut out = String::from(r#"<w:tbl><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:color="CBD5E1"/><w:left w:val="single" w:sz="4" w:color="CBD5E1"/><w:bottom w:val="single" w:sz="4" w:color="CBD5E1"/><w:right w:val="single" w:sz="4" w:color="CBD5E1"/><w:insideH w:val="single" w:sz="4" w:color="CBD5E1"/><w:insideV w:val="single" w:sz="4" w:color="CBD5E1"/></w:tblBorders></w:tblPr>"#);
            if let Some(rows) = node["content"].as_array() {
                for row in rows {
                    let cells = row["content"].as_array();
                    let has_header = cells.is_some_and(|cs| cs.iter().any(|c| c["type"].as_str() == Some("tableHeader")));
                    out.push_str("<w:tr>");
                    if has_header { out.push_str("<w:trPr><w:tblHeader/></w:trPr>"); }
                    if let Some(cs) = cells {
                        for cell in cs {
                            let colspan = cell["attrs"]["colspan"].as_u64().unwrap_or(1);
                            out.push_str("<w:tc>");
                            if colspan > 1 {
                                out.push_str(&format!(r#"<w:tcPr><w:gridSpan w:val="{colspan}"/></w:tcPr>"#));
                            }
                            if let Some(cblocks) = cell["content"].as_array() {
                                for cb in cblocks {
                                    out.push_str(&emit_block(cb, ctx));
                                }
                            } else {
                                out.push_str("<w:p/>");
                            }
                            out.push_str("</w:tc>");
                        }
                    }
                    out.push_str("</w:tr>");
                }
            }
            out.push_str("</w:tbl>");
            out
        }
        _ => String::new(),
    }
}

fn serialize_rels(rels: &[RelEntry]) -> String {
    let items: String = rels
        .iter()
        .map(|r| {
            let mode = if r.external { r#" TargetMode="External""# } else { "" };
            format!(r#"  <Relationship Id="{}" Type="{}" Target="{}"{mode}/>"#, escape_xml(&r.id), escape_xml(&r.rel_type), escape_xml(&r.target))
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\n{items}\n</Relationships>"
    )
}

fn ensure_content_types(xml: &str, exts: &HashSet<&'static str>, added_numbering: bool) -> String {
    let mut out = xml.to_string();
    let mut additions = String::new();
    for ext in exts {
        let needle = format!(r#"Extension="{ext}""#);
        if !out.to_ascii_lowercase().contains(&needle.to_ascii_lowercase()) {
            let mime = match *ext {
                "png" => "image/png",
                "jpeg" | "jpg" => "image/jpeg",
                "gif" => "image/gif",
                "webp" => "image/webp",
                "bmp" => "image/bmp",
                "svg" => "image/svg+xml",
                _ => "application/octet-stream",
            };
            additions.push_str(&format!(r#"  <Default Extension="{ext}" ContentType="{mime}"/>"#));
        }
    }
    if added_numbering && !out.contains("/word/numbering.xml") {
        additions.push_str(r#"  <Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>"#);
    }
    if additions.is_empty() {
        return out;
    }
    if let Some(pos) = out.rfind("</Types>") {
        out.insert_str(pos, &additions);
    }
    out
}

/// Surgically patch `original_zip` with edited Tiptap JSON `doc` and any `new_media`, preserving untouched archive parts.
pub fn patch_docx(original_zip: &[u8], doc: &Value, new_media: &HashMap<String, NewDocxMedia>) -> Result<Vec<u8>, String> {
    let mut src = open_zip_safe(original_zip)?;
    let mut budget = MAX_TOTAL_EXPANDED;

    let orig_doc_xml = read_entry_capped(&mut src, "word/document.xml", &mut budget)?
        .and_then(|b| String::from_utf8(b).ok())
        .unwrap_or_else(|| DEFAULT_DOCUMENT.to_string());
    let orig_rels_xml = read_entry_capped(&mut src, "word/_rels/document.xml.rels", &mut budget)?
        .and_then(|b| String::from_utf8(b).ok())
        .unwrap_or_else(|| DEFAULT_DOC_RELS.to_string());
    let orig_numbering_xml = read_entry_capped(&mut src, "word/numbering.xml", &mut budget)?
        .and_then(|b| String::from_utf8(b).ok());
    let has_numbering = orig_numbering_xml.is_some();
    let numbering_info = orig_numbering_xml.as_deref().map(analyze_numbering).unwrap_or_default();

    let mut rels = parse_rel_entries(&orig_rels_xml);
    let mut media_rid: HashMap<String, String> = HashMap::new();
    for r in &rels {
        if r.rel_type == IMAGE_REL_TYPE {
            let full = if r.target.starts_with("word/") {
                r.target.clone()
            } else {
                format!("word/{}", r.target.trim_start_matches('/').trim_start_matches("../"))
            };
            media_rid.insert(full, r.id.clone());
        }
    }

    // Decode newly added images and assign fresh media paths + rIds (checking single-entry cap up front).
    let mut extra_files: Vec<(String, Vec<u8>)> = Vec::new();
    let mut extra_exts: HashSet<&'static str> = HashSet::new();
    let mut media_idx = 1usize;
    for (key, item) in new_media {
        let bytes = B64.decode(item.base64.trim()).map_err(|e| format!("Invalid image data for {key}: {e}"))?;
        if bytes.len() as u64 > MAX_SINGLE_ENTRY {
            return Err("Inserted image exceeds the 32 MB per-entry safety limit, so nothing was written".into());
        }
        let ext = ext_for_mime(&item.mime);
        extra_exts.insert(ext);
        let mut target_rel = format!("media/hm_image_{media_idx}.{ext}");
        while rels.iter().any(|r| r.target == target_rel) {
            media_idx += 1;
            target_rel = format!("media/hm_image_{media_idx}.{ext}");
        }
        let rid = next_rid(&rels);
        rels.push(RelEntry { id: rid.clone(), rel_type: IMAGE_REL_TYPE.into(), target: target_rel.clone(), external: false });
        media_rid.insert(key.clone(), rid);
        extra_files.push((format!("word/{target_rel}"), bytes));
        media_idx += 1;
    }

    let mut ctx = WriteCtx {
        rels,
        media_rid,
        next_docpr_id: 100,
        used_lists: false,
        has_existing_numbering: has_numbering,
        numbering: numbering_info,
        added_abs_xml: Vec::new(),
        added_num_xml: Vec::new(),
    };
    let body_xml: String = doc["content"]
        .as_array()
        .map(|blocks| blocks.iter().map(|b| emit_block(b, &mut ctx)).collect())
        .unwrap_or_else(|| "<w:p/>".into());

    let added_numbering = ctx.used_lists && !has_numbering;
    let updated_numbering_xml = if let Some(ref orig_num) = orig_numbering_xml {
        if !ctx.added_abs_xml.is_empty() || !ctx.added_num_xml.is_empty() {
            Some(patch_numbering_xml(orig_num, &ctx.added_abs_xml, &ctx.added_num_xml))
        } else {
            None
        }
    } else {
        None
    };

    if added_numbering {
        let rid = next_rid(&ctx.rels);
        ctx.rels.push(RelEntry {
            id: rid,
            rel_type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering".into(),
            target: "numbering.xml".into(),
            external: false,
        });
    }

    let doc_open = extract_doc_open_tag(&orig_doc_xml);
    let sect_pr = extract_body_sect_pr(&orig_doc_xml);
    let new_doc_xml = format!("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n{doc_open}<w:body>{body_xml}{sect_pr}</w:body></w:document>");
    let new_rels_xml = serialize_rels(&ctx.rels);

    let mut out_buf = Vec::new();
    let mut dst = ZipWriter::new(Cursor::new(&mut out_buf));
    let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    let mut wrote_rels = false;
    let mut entry_count: usize = 0;
    let mut total_expanded: u64 = 0;

    let mut write_checked = |z: &mut ZipWriter<Cursor<&mut Vec<u8>>>, name: &str, data: &[u8]| -> Result<(), String> {
        entry_count += 1;
        if entry_count > MAX_ZIP_ENTRIES {
            return Err(format!("This .docx would exceed the {MAX_ZIP_ENTRIES}-entry safety limit, so nothing was written"));
        }
        let len = data.len() as u64;
        if len > MAX_SINGLE_ENTRY {
            return Err(format!("Entry {name} exceeds the 32 MB safety limit, so nothing was written"));
        }
        total_expanded = total_expanded.saturating_add(len);
        if total_expanded > MAX_TOTAL_EXPANDED {
            return Err("This .docx would exceed the 64 MB archive safety limit, so nothing was written".into());
        }
        z.start_file(name, opts).map_err(|e| e.to_string())?;
        z.write_all(data).map_err(|e| e.to_string())?;
        Ok(())
    };

    for i in 0..src.len() {
        let mut f = src.by_index(i).map_err(|e| format!("Could not copy .docx entry: {e}"))?;
        let name = f.name().to_string();
        if name == "word/document.xml" {
            write_checked(&mut dst, &name, new_doc_xml.as_bytes())?;
        } else if name == "word/_rels/document.xml.rels" {
            wrote_rels = true;
            write_checked(&mut dst, &name, new_rels_xml.as_bytes())?;
        } else if name == "word/numbering.xml" && let Some(ref patched_num) = updated_numbering_xml {
            write_checked(&mut dst, &name, patched_num.as_bytes())?;
        } else if name == "[Content_Types].xml" {
            let mut raw = Vec::new();
            f.read_to_end(&mut raw).map_err(|e| e.to_string())?;
            let ct = String::from_utf8(raw).unwrap_or_else(|_| DEFAULT_CONTENT_TYPES.to_string());
            let updated = ensure_content_types(&ct, &extra_exts, added_numbering);
            write_checked(&mut dst, &name, updated.as_bytes())?;
        } else {
            let mut raw = Vec::new();
            f.read_to_end(&mut raw).map_err(|e| e.to_string())?;
            write_checked(&mut dst, &name, &raw)?;
        }
    }

    if !wrote_rels {
        write_checked(&mut dst, "word/_rels/document.xml.rels", new_rels_xml.as_bytes())?;
    }
    if added_numbering {
        write_checked(&mut dst, "word/numbering.xml", DEFAULT_NUMBERING.as_bytes())?;
    }
    for (name, data) in extra_files {
        write_checked(&mut dst, &name, &data)?;
    }

    dst.finish().map_err(|e| format!("Could not write patched .docx: {e}"))?;
    Ok(out_buf)
}
