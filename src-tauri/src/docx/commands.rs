//! Tauri commands for `.docx` reading, raw layout bytes, surgical saving, creation, and shared binary history restore.
use super::{read, write, DocxLoaded, NewDocxMedia};
use crate::files::{self, SaveOutcome, Stamp};
use crate::history;
use crate::studio;
use crate::{blocking, AppState};
use serde_json::Value;
use std::collections::HashMap;
use tauri::ipc::Response;
use tauri::State;

#[tauri::command]
pub async fn docx_read(state: State<'_, AppState>, notebook: String, path: String) -> Result<DocxLoaded, String> {
    let (full, locked) = studio::resolve_file(&state, &notebook, &path, false)?;
    blocking(move || {
        let (bytes, stamp, ro_attr) = files::read_bytes(&full)?;
        let parsed = read::read_docx_bytes(&bytes)?;
        let read_only = locked.or_else(|| ro_attr.then(|| "This file is read-only on disk".into()));
        Ok(DocxLoaded {
            doc: parsed.doc,
            media: parsed.media,
            stamp,
            read_only,
            warnings: parsed.warnings,
            has_headers_footers: parsed.has_headers_footers,
        })
    })
    .await
}

#[tauri::command]
pub async fn docx_raw(state: State<'_, AppState>, notebook: String, path: String) -> Result<Response, String> {
    let (full, _) = studio::resolve_file(&state, &notebook, &path, false)?;
    let bytes = blocking(move || files::read_bytes(&full).map(|(b, _, _)| b)).await?;
    Ok(Response::new(bytes))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn docx_save(
    state: State<'_, AppState>,
    notebook: String,
    path: String,
    doc: Value,
    new_media: HashMap<String, NewDocxMedia>,
    pre: Stamp,
    source: Option<String>,
) -> Result<SaveOutcome, String> {
    let source = source.unwrap_or_else(|| "you".into());
    let (full, locked) = studio::resolve_file(&state, &notebook, &path, true)?;
    if let Some(why) = locked {
        return Err(why);
    }
    let history = state.history_dir.clone();
    blocking(move || {
        let (orig_bytes, orig_stamp, _) = files::read_bytes(&full)?;
        if orig_stamp.sha256 != pre.sha256 {
            return Ok(SaveOutcome::Stale { sha256: orig_stamp.sha256 });
        }
        let patched = write::patch_docx(&orig_bytes, &doc, &new_media)?;
        studio::save_bytes_kept(&history, &full, &patched, &pre, &source)
    })
    .await
}

#[tauri::command]
pub async fn docx_create(state: State<'_, AppState>, notebook: String, path: String) -> Result<Stamp, String> {
    let (root, protected) = studio::root_of(&state, &notebook)?;
    let history = state.history_dir.clone();
    blocking(move || {
        let full = studio::inside(&root, &protected, &path, true)?;
        let bytes = write::blank_docx()?;
        let stamp = files::create_bytes(&full, &bytes)?;
        let _ = history::snapshot(&history, &full, &bytes, "you", history::now_ms());
        Ok(stamp)
    })
    .await
}

/// Restore any binary file snapshot (`.docx` or `.pdf`) from Hivemind's version history by snapshot id.
#[tauri::command]
pub async fn binary_restore(state: State<'_, AppState>, notebook: String, path: String, id: u64, pre: Stamp) -> Result<SaveOutcome, String> {
    let (full, locked) = studio::resolve_file(&state, &notebook, &path, true)?;
    if let Some(why) = locked {
        return Err(why);
    }
    let history = state.history_dir.clone();
    blocking(move || {
        let bytes = history::read(&history, &full, id)?;
        studio::save_bytes_kept(&history, &full, &bytes, &pre, "restore")
    })
    .await
}
