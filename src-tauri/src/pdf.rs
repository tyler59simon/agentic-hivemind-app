//! Tauri commands for binary `.pdf` metadata, raw bytes, atomic saving, page extraction creation, and merge picker.
use crate::files::{self, SaveOutcome, Stamp, MAX_READ};
use crate::history;
use crate::studio;
use crate::{blocking, AppState};
use serde::Serialize;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, State};

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PdfMeta {
    #[serde(flatten)]
    pub stamp: Stamp,
    pub read_only: Option<String>,
    pub too_large: bool,
}

fn header_decoded(req: &Request<'_>, name: &str) -> Result<String, String> {
    let raw = req
        .headers()
        .get(name)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| format!("Missing header {name}"))?;
    percent_decode(raw)
}

fn percent_decode(input: &str) -> Result<String, String> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).map_err(|_| "Invalid header encoding")?;
            let val = u8::from_str_radix(hex, 16).map_err(|_| "Invalid percent escape")?;
            out.push(val);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| "Header is not valid UTF-8".into())
}

fn body_bytes(req: Request<'_>) -> Result<Vec<u8>, String> {
    match req.body() {
        InvokeBody::Raw(bytes) => {
            if bytes.len() as u64 > MAX_READ {
                return Err("PDF exceeds the 64 MB save limit".into());
            }
            Ok(bytes.clone())
        }
        InvokeBody::Json(_) => Err("Expected raw binary PDF bytes".into()),
    }
}

#[tauri::command]
pub async fn pdf_meta(state: State<'_, AppState>, notebook: String, path: String) -> Result<PdfMeta, String> {
    let (full, locked) = studio::resolve_file(&state, &notebook, &path, false)?;
    blocking(move || {
        let meta = std::fs::metadata(&full).map_err(|e| format!("Could not open {}: {e}", full.display()))?;
        if meta.is_dir() {
            return Err(format!("{} is a folder", full.display()));
        }
        let mtime_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        if meta.len() > MAX_READ {
            return Ok(PdfMeta {
                stamp: Stamp { sha256: String::new(), size: meta.len(), mtime_ms },
                read_only: Some("This PDF is larger than 64 MB, so editing is disabled".into()),
                too_large: true,
            });
        }
        let (_, stamp, ro_attr) = files::read_bytes(&full)?;
        let read_only = locked.or_else(|| ro_attr.then(|| "This file is read-only on disk".into()));
        Ok(PdfMeta { stamp, read_only, too_large: false })
    })
    .await
}

#[tauri::command]
pub async fn pdf_bytes(state: State<'_, AppState>, notebook: String, path: String) -> Result<Response, String> {
    let (full, _) = studio::resolve_file(&state, &notebook, &path, false)?;
    let bytes = blocking(move || files::read_bytes(&full).map(|(b, _, _)| b)).await?;
    Ok(Response::new(bytes))
}

#[tauri::command]
pub async fn pdf_save(state: State<'_, AppState>, req: Request<'_>) -> Result<SaveOutcome, String> {
    let notebook = header_decoded(&req, "notebook")?;
    let path = header_decoded(&req, "path")?;
    let sha256 = header_decoded(&req, "sha256")?;
    let size: u64 = header_decoded(&req, "size")?.parse().map_err(|_| "Invalid size header")?;
    let mtime_ms: i64 = header_decoded(&req, "mtimems").or_else(|_| header_decoded(&req, "mtimeMs"))?.parse().map_err(|_| "Invalid mtime header")?;
    let source = header_decoded(&req, "source").unwrap_or_else(|_| "you".into());
    let bytes = body_bytes(req)?;
    let pre = Stamp { sha256, size, mtime_ms };

    let (full, locked) = studio::resolve_file(&state, &notebook, &path, true)?;
    if let Some(why) = locked {
        return Err(why);
    }
    let history = state.history_dir.clone();
    blocking(move || studio::save_bytes_kept(&history, &full, &bytes, &pre, &source)).await
}

#[tauri::command]
pub async fn pdf_create(state: State<'_, AppState>, req: Request<'_>) -> Result<Stamp, String> {
    let notebook = header_decoded(&req, "notebook")?;
    let path = header_decoded(&req, "path")?;
    let bytes = body_bytes(req)?;
    let (root, protected) = studio::root_of(&state, &notebook)?;
    let history = state.history_dir.clone();
    blocking(move || {
        let full = studio::inside(&root, &protected, &path, true)?;
        let stamp = files::create_bytes(&full, &bytes)?;
        let _ = history::snapshot(&history, &full, &bytes, "you", history::now_ms());
        Ok(stamp)
    })
    .await
}

/// Native file picker for selecting a second PDF to merge into the open PDF; returns raw bytes (or empty if cancelled).
#[tauri::command]
pub async fn pdf_pick_merge(app: AppHandle) -> Result<Response, String> {
    use tauri_plugin_dialog::DialogExt;
    let handle = app.clone();
    let bytes = blocking(move || {
        let Some(picked) = handle.dialog().file().add_filter("PDF document", &["pdf"]).blocking_pick_file() else {
            return Ok(Vec::new());
        };
        let path = picked.into_path().map_err(|e| e.to_string())?;
        files::read_bytes(&path).map(|(b, _, _)| b)
    })
    .await?;
    Ok(Response::new(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hm-pdf-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn binary_save_and_create_enforce_preconditions_and_keep_history() {
        let dir = scratch();
        let hist = dir.join("history");
        let file = dir.join("doc.pdf");
        let v1 = b"%PDF-1.4\n1 0 obj<<>>endobj\n%%EOF\n";
        let v2 = b"%PDF-1.4\n1 0 obj<< /V 2 >>endobj\n%%EOF\n";

        let st1 = files::create_bytes(&file, v1).unwrap();
        // create_bytes never overwrites existing files
        assert!(files::create_bytes(&file, v2).unwrap_err().contains("already exists"));

        // Save with matching hash succeeds and snapshots both v1 (disk) and v2 (you)
        let saved = studio::save_bytes_kept(&hist, &file, v2, &st1, "you").unwrap();
        assert!(matches!(saved, SaveOutcome::Saved(_)));
        assert_eq!(std::fs::read(&file).unwrap(), v2);
        let versions = history::list(&hist, &file);
        assert_eq!(versions.len(), 2);

        // Saving again with stale stamp returns Stale and leaves v2 untouched
        let stale = studio::save_bytes_kept(&hist, &file, v1, &st1, "you").unwrap();
        assert!(matches!(stale, SaveOutcome::Stale { .. }));
        assert_eq!(std::fs::read(&file).unwrap(), v2);

        // Restoring v1 from history writes exact original bytes back
        let orig_entry = versions.iter().find(|e| e.sha256 == st1.sha256).unwrap();
        let restored_bytes = history::read(&hist, &file, orig_entry.id).unwrap();
        assert_eq!(restored_bytes, v1);

        std::fs::remove_dir_all(&dir).unwrap();
    }
}
