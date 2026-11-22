//! The Tauri commands of the search index. The webview names a notebook by id and a page by its relative path, as every
//! other notebook command does; nothing here reads a file.
use super::query::{self, Filters, Hit, Incoming, Mention, Outgoing, PageRow, TagCount};
use super::Status;
use crate::{blocking, AppState};
use serde::Serialize;
use tauri::State;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub hits: Vec<Hit>,
    /// How long the query took inside the index.
    pub ms: u64,
    /// `scanning` while the index is still being filled, so results may be missing pages.
    pub state: &'static str,
}

/// Pages matching `query` under `filters`, best first. With no words, the pages the filters keep.
#[tauri::command]
pub async fn index_search(state: State<'_, AppState>, query: String, filters: Option<Filters>, limit: Option<usize>) -> Result<SearchResult, String> {
    let index = state.index.clone();
    blocking(move || {
        let started = std::time::Instant::now();
        let filters = filters.unwrap_or_default();
        let hits = index.read(|c| query::search(c, &query, &filters, limit.unwrap_or(30)))?;
        Ok(SearchResult { hits, ms: started.elapsed().as_millis() as u64, state: index.state() })
    })
    .await
}

#[derive(Serialize)]
pub struct Links {
    pub outgoing: Vec<Outgoing>,
    /// Links whose target is named like this page; the webview keeps those its resolver sends here.
    pub incoming: Vec<Incoming>,
    pub unlinked: Vec<Mention>,
}

/// What links to and from a page, and the pages that name it without a link.
#[tauri::command]
pub async fn index_links(state: State<'_, AppState>, notebook: String, path: String) -> Result<Links, String> {
    let index = state.index.clone();
    blocking(move || {
        index.read(|c| {
            let mut incoming = query::incoming(c, std::slice::from_ref(&path), 1000)?;
            incoming.retain(|l| !(l.notebook == notebook && l.path == path));
            Ok(Links { outgoing: query::outgoing(c, &notebook, &path)?, incoming, unlinked: query::unlinked(c, &notebook, &path, 30)? })
        })
    })
    .await
}

/// The links whose target is named like any of `paths`, for the plan that follows a rename or a move.
#[tauri::command]
pub async fn index_incoming(state: State<'_, AppState>, paths: Vec<String>) -> Result<Vec<Incoming>, String> {
    let index = state.index.clone();
    blocking(move || index.read(|c| query::incoming(c, &paths, 20_000))).await
}

/// Every indexed page (of one notebook, or of all), for Ctrl+O and for resolving links.
#[tauri::command]
pub async fn index_pages(state: State<'_, AppState>, notebook: Option<String>) -> Result<Vec<PageRow>, String> {
    let index = state.index.clone();
    blocking(move || index.read(|c| query::pages(c, notebook.as_deref()))).await
}

#[tauri::command]
pub async fn index_tags(state: State<'_, AppState>, notebook: Option<String>) -> Result<Vec<TagCount>, String> {
    let index = state.index.clone();
    blocking(move || index.read(|c| query::tags(c, notebook.as_deref()))).await
}

#[tauri::command]
pub async fn index_status(state: State<'_, AppState>) -> Result<Status, String> {
    let index = state.index.clone();
    blocking(move || index.status()).await
}

/// Read every page of one notebook, or of all, again. Returns at once; `index-progress` reports how it goes.
#[tauri::command]
pub fn index_rebuild(state: State<'_, AppState>, notebook: Option<String>) -> Result<(), String> {
    let mut roots = crate::studio::roots(&state);
    if let Some(id) = notebook {
        roots.retain(|r| r.id == id);
        if roots.is_empty() {
            return Err("That notebook is no longer registered".into());
        }
    }
    state.index.rebuild(roots);
    Ok(())
}
