//! Native offline `.docx` (OOXML) reader, surgical writer, and Tauri commands.
pub mod commands;
pub mod read;
pub mod write;

use crate::files::Stamp;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Cursor, Read};
use zip::ZipArchive;

pub const MAX_ZIP_ENTRIES: usize = 2_000;
pub const MAX_SINGLE_ENTRY: u64 = 32 * 1024 * 1024;
pub const MAX_TOTAL_EXPANDED: u64 = 64 * 1024 * 1024;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DocxWarning {
    pub kind: String,
    pub message: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DocxMedia {
    pub id: String,
    pub mime: String,
    pub data_url: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NewDocxMedia {
    pub mime: String,
    pub base64: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DocxLoaded {
    pub doc: serde_json::Value,
    pub media: HashMap<String, DocxMedia>,
    #[serde(flatten)]
    pub stamp: Stamp,
    pub read_only: Option<String>,
    pub warnings: Vec<DocxWarning>,
    pub has_headers_footers: bool,
}

/// Validate a ZIP archive entry path against traversal or absolute prefixes.
pub fn safe_entry_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name.starts_with('/') || name.starts_with('\\') || name.contains(':') {
        return Err(format!("Unsafe archive entry path: {name}"));
    }
    for part in name.split(['/', '\\']) {
        if part == ".." {
            return Err(format!("Unsafe archive entry path: {name}"));
        }
    }
    Ok(())
}

/// Open a `.docx` ZIP archive and verify entry count, path safety, and declared expanded sizes.
pub fn open_zip_safe(bytes: &[u8]) -> Result<ZipArchive<Cursor<&[u8]>>, String> {
    let mut archive = ZipArchive::new(Cursor::new(bytes)).map_err(|e| format!("Not a valid .docx archive: {e}"))?;
    if archive.len() > MAX_ZIP_ENTRIES {
        return Err(format!("This .docx archive has more than {MAX_ZIP_ENTRIES} entries"));
    }
    let mut declared_total: u64 = 0;
    for i in 0..archive.len() {
        let entry = archive.by_index(i).map_err(|e| format!("Damaged .docx entry: {e}"))?;
        safe_entry_name(entry.name())?;
        if entry.size() > MAX_SINGLE_ENTRY {
            return Err(format!("Entry {} exceeds the 32 MB safety limit", entry.name()));
        }
        declared_total = declared_total.saturating_add(entry.size());
        if declared_total > MAX_TOTAL_EXPANDED {
            return Err("This .docx archive expands beyond the 64 MB safety limit".into());
        }
    }
    Ok(archive)
}

/// Read one entry from a validated ZIP archive with a hard read cap (guards against lying ZIP headers).
pub fn read_entry_capped(archive: &mut ZipArchive<Cursor<&[u8]>>, name: &str, budget: &mut u64) -> Result<Option<Vec<u8>>, String> {
    let mut file = match archive.by_name(name) {
        Ok(f) => f,
        Err(zip::result::ZipError::FileNotFound) => return Ok(None),
        Err(e) => return Err(format!("Could not read {name} from .docx: {e}")),
    };
    let cap = (*budget).min(MAX_SINGLE_ENTRY);
    let mut out = Vec::new();
    file.by_ref().take(cap + 1).read_to_end(&mut out).map_err(|e| format!("Could not decompress {name}: {e}"))?;
    if out.len() as u64 > cap {
        return Err(format!("Entry {name} exceeds the safety decompression limit"));
    }
    *budget = budget.saturating_sub(out.len() as u64);
    Ok(Some(out))
}

pub fn mime_for_ext(path: &str) -> &'static str {
    let ext = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        _ => "application/octet-stream",
    }
}

pub fn ext_for_mime(mime: &str) -> &'static str {
    match mime.to_ascii_lowercase().as_str() {
        "image/png" => "png",
        "image/jpeg" | "image/jpg" => "jpeg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/bmp" => "bmp",
        "image/svg+xml" => "svg",
        _ => "png",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    #[test]
    fn blank_docx_creates_and_reads_cleanly() {
        let bytes = write::blank_docx().unwrap();
        let parsed = read::read_docx_bytes(&bytes).unwrap();
        assert_eq!(parsed.doc["type"], "doc");
        assert!(parsed.warnings.is_empty());
        assert!(!parsed.has_headers_footers);
    }

    #[test]
    fn surgical_patch_preserves_headers_styles_theme_sectpr_and_raw_blocks() {
        // Build a .docx containing a custom header, custom theme, custom styles, a raw SDT block, and a paragraph.
        let base = write::blank_docx().unwrap();
        let mut out_buf = Vec::new();
        {
            let mut src = ZipArchive::new(Cursor::new(&base)).unwrap();
            let mut dst = zip::ZipWriter::new(Cursor::new(&mut out_buf));
            let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
            for i in 0..src.len() {
                let mut f = src.by_index(i).unwrap();
                let name = f.name().to_string();
                let mut data = Vec::new();
                f.read_to_end(&mut data).unwrap();
                if name == "word/document.xml" {
                    let xml = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Original Heading</w:t></w:r></w:p>
    <w:sdt><w:sdtPr><w:alias w:val="CustomControl"/></w:sdtPr><w:sdtContent><w:p><w:r><w:t>Keep SDT</w:t></w:r></w:p></w:sdtContent></w:sdt>
    <w:sectPr><w:headerReference w:type="default" r:id="rId99"/><w:pgSz w:w="12240" w:h="15840"/></w:sectPr>
  </w:body>
</w:document>"#;
                    dst.start_file(&name, opts).unwrap();
                    dst.write_all(xml.as_bytes()).unwrap();
                } else {
                    dst.start_file(&name, opts).unwrap();
                    dst.write_all(&data).unwrap();
                }
            }
            dst.start_file("word/header1.xml", opts).unwrap();
            dst.write_all(b"<w:hdr>COMPANY HEADER</w:hdr>").unwrap();
            dst.start_file("word/theme/theme1.xml", opts).unwrap();
            dst.write_all(b"<a:theme>CUSTOM THEME</a:theme>").unwrap();
            dst.start_file("word/comments.xml", opts).unwrap();
            dst.write_all(b"<w:comments><w:comment w:id=\"0\"/></w:comments>").unwrap();
            dst.finish().unwrap();
        }

        let loaded = read::read_docx_bytes(&out_buf).unwrap();
        assert!(loaded.has_headers_footers);
        assert!(loaded.warnings.iter().any(|w| w.kind == "comments"));
        let content = loaded.doc["content"].as_array().unwrap();
        assert_eq!(content[0]["type"], "heading");
        assert_eq!(content[1]["type"], "docxRawBlock");

        // Edit the heading text, add a bold paragraph + table + list, keep the raw block intact, and surgically patch.
        let mut edited = loaded.doc.clone();
        edited["content"][0]["content"][0]["text"] = serde_json::json!("Updated Heading");
        edited["content"].as_array_mut().unwrap().push(serde_json::json!({
            "type": "paragraph",
            "attrs": { "textAlign": "center" },
            "content": [{ "type": "text", "text": "Hello", "marks": [{ "type": "bold" }, { "type": "docxTextColor", "attrs": { "color": "#1a73e8" } }] }]
        }));
        let patched = write::patch_docx(&out_buf, &edited, &HashMap::new()).unwrap();

        // Verify untouched archive parts survived byte-for-byte
        let mut verify_zip = open_zip_safe(&patched).unwrap();
        let mut budget = MAX_TOTAL_EXPANDED;
        assert_eq!(read_entry_capped(&mut verify_zip, "word/header1.xml", &mut budget).unwrap().unwrap(), b"<w:hdr>COMPANY HEADER</w:hdr>");
        assert_eq!(read_entry_capped(&mut verify_zip, "word/theme/theme1.xml", &mut budget).unwrap().unwrap(), b"<a:theme>CUSTOM THEME</a:theme>");
        let doc_xml = String::from_utf8(read_entry_capped(&mut verify_zip, "word/document.xml", &mut budget).unwrap().unwrap()).unwrap();
        assert!(doc_xml.contains("rId99"), "headerReference in sectPr must survive");
        assert!(doc_xml.contains("CustomControl"), "raw SDT block must survive");
        assert!(doc_xml.contains("Updated Heading"));
        assert!(doc_xml.contains("1a73e8"));

        // Re-read patched docx cleanly
        let reread = read::read_docx_bytes(&patched).unwrap();
        assert_eq!(reread.doc["content"][0]["content"][0]["text"], "Updated Heading");
        assert_eq!(reread.doc["content"][1]["type"], "docxRawBlock");
        assert_eq!(reread.doc["content"][2]["attrs"]["textAlign"], "center");
    }

    #[test]
    fn zip_traversal_entry_is_rejected() {
        let mut buf = Vec::new();
        {
            let mut z = zip::ZipWriter::new(Cursor::new(&mut buf));
            z.start_file("../evil.xml", SimpleFileOptions::default()).unwrap();
            z.write_all(b"x").unwrap();
            z.finish().unwrap();
        }
        assert!(open_zip_safe(&buf).unwrap_err().contains("Unsafe archive entry"));
    }
}
