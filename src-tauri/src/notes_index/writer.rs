//! Writing the index: reading a notebook's files, comparing them with what the index holds, and replacing the rows of
//! the pages that changed. Only the writer thread of `Index` calls into here.
use super::extract::{self, kind_of, READ_CAP};
use crate::files::watch::Root;
use crate::files::{contain, guard, MAX_READ};
use crate::notebooks;
use rusqlite::{params, Connection};
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};

/// A walk goes this deep and stops at this many files, so a folder of something else registered as a notebook cannot
/// run the index out of memory.
const MAX_DEPTH: usize = 24;
const MAX_FILES: usize = 200_000;
/// Pages written in one transaction, and so between two progress reports.
const BATCH: usize = 250;

pub struct Known {
    pub id: i64,
    pub size: i64,
    pub mtime_ms: i64,
}

struct Found {
    rel: String,
    kind: &'static str,
    size: u64,
    mtime_ms: i64,
    full: PathBuf,
}

fn mtime_of(meta: &std::fs::Metadata) -> i64 {
    meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// The indexed files under `dir` (at `rel` below the notebook's root): what the notebook tree shows, so hidden names,
/// links and vaults Living Memory manages are left out.
fn walk(dir: &Path, rel: &str, out: &mut Vec<Found>) {
    let mut stack = vec![(dir.to_path_buf(), rel.to_string(), 0usize)];
    while let Some((dir, rel, depth)) = stack.pop() {
        let Ok(read) = std::fs::read_dir(&dir) else { continue };
        for entry in read.flatten() {
            if out.len() >= MAX_FILES {
                return;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if notebooks::hidden(&name) {
                continue;
            }
            let Ok(kind) = entry.file_type() else { continue };
            if kind.is_symlink() {
                continue;
            }
            let child = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
            if kind.is_dir() {
                if depth + 1 < MAX_DEPTH && !guard::is_marked_vault(&entry.path()) {
                    stack.push((entry.path(), child, depth + 1));
                }
            } else if let Some(page_kind) = kind_of(&name)
                && let Ok(meta) = entry.metadata()
            {
                out.push(Found { rel: child, kind: page_kind, size: meta.len(), mtime_ms: mtime_of(&meta), full: entry.path() });
            }
        }
    }
}

pub fn known_page(conn: &Connection, notebook: &str, path: &str) -> Option<Known> {
    conn.query_row("SELECT id, size, mtime_ms FROM pages WHERE notebook = ?1 AND path = ?2", params![notebook, path], |r| Ok(Known { id: r.get(0)?, size: r.get(1)?, mtime_ms: r.get(2)? })).ok()
}

pub fn known(conn: &Connection, notebook: &str) -> rusqlite::Result<HashMap<String, Known>> {
    let mut stmt = conn.prepare("SELECT path, id, size, mtime_ms FROM pages WHERE notebook = ?1")?;
    let rows = stmt.query_map([notebook], |r| Ok((r.get::<_, String>(0)?, Known { id: r.get(1)?, size: r.get(2)?, mtime_ms: r.get(3)? })))?;
    rows.collect()
}

pub fn remove_page(conn: &Connection, id: i64) -> rusqlite::Result<()> {
    conn.prepare_cached("DELETE FROM fts WHERE rowid = ?1")?.execute([id])?;
    conn.prepare_cached("DELETE FROM links WHERE page = ?1")?.execute([id])?;
    conn.prepare_cached("DELETE FROM tags WHERE page = ?1")?.execute([id])?;
    conn.prepare_cached("DELETE FROM pages WHERE id = ?1")?.execute([id])?;
    Ok(())
}

fn like_escape(text: &str) -> String {
    text.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
}

/// The page at `rel` and, when `rel` was a folder, every page under it.
pub fn remove_under(conn: &Connection, notebook: &str, rel: &str) -> rusqlite::Result<usize> {
    let mut stmt = conn.prepare("SELECT id FROM pages WHERE notebook = ?1 AND (path = ?2 OR path LIKE ?3 ESCAPE '\\')")?;
    let ids: Vec<i64> = stmt.query_map(params![notebook, rel, format!("{}/%", like_escape(rel))], |r| r.get(0))?.collect::<Result<_, _>>()?;
    for id in &ids {
        remove_page(conn, *id)?;
    }
    Ok(ids.len())
}

pub fn remove_notebook(conn: &Connection, notebook: &str) -> rusqlite::Result<()> {
    let ids: Vec<i64> = conn.prepare("SELECT id FROM pages WHERE notebook = ?1")?.query_map([notebook], |r| r.get(0))?.collect::<Result<_, _>>()?;
    for id in ids {
        remove_page(conn, id)?;
    }
    Ok(())
}

/// The bytes to index (at most `READ_CAP`, or a whole rich page) and the hash of the whole file, as the editor's save
/// precondition has it. A file over 64 MB is indexed by its name only.
fn read_for_index(full: &Path, kind: &str) -> std::io::Result<(Vec<u8>, String)> {
    let mut file = std::fs::File::open(full)?;
    let mut bytes = Vec::new();
    file.by_ref().take(MAX_READ + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_READ {
        return Ok((Vec::new(), String::new()));
    }
    let hash = crate::files::sha256(&bytes);
    bytes.truncate(if kind == "hmdoc" { extract::HMDOC_CAP } else { READ_CAP });
    Ok((bytes, hash))
}

/// How far `index_file` trusts what the index holds.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Mode {
    /// A file with the size and time the index has is left alone (the startup scan).
    Scan,
    /// The bytes are always read and compared with the hash the index has (a change reported to the index).
    Compare,
    /// The page is always extracted again (Rebuild index).
    Force,
}

#[derive(Debug, PartialEq)]
pub enum Outcome {
    Unchanged,
    /// Only the size or the time differed: the bytes are the same, so the rows stay.
    Stamped,
    Indexed,
}

/// Index the file at `rel`; `mode` says what an existing row is trusted for.
#[allow(clippy::too_many_arguments)]
pub fn index_file(conn: &Connection, notebook: &str, rel: &str, kind: &str, full: &Path, size: u64, mtime_ms: i64, known: Option<&Known>, mode: Mode) -> Result<Outcome, String> {
    if mode == Mode::Scan && known.is_some_and(|k| k.size == size as i64 && k.mtime_ms == mtime_ms) {
        return Ok(Outcome::Unchanged);
    }
    let (bytes, hash) = read_for_index(full, kind).map_err(|e| format!("Could not read {}: {e}", full.display()))?;
    let sql = |e: rusqlite::Error| e.to_string();
    if mode != Mode::Force && let Some(k) = known {
        let same: Option<String> = conn.query_row("SELECT sha256 FROM pages WHERE id = ?1", [k.id], |r| r.get(0)).ok();
        if same.as_deref() == Some(hash.as_str()) && !hash.is_empty() {
            conn.execute("UPDATE pages SET size = ?1, mtime_ms = ?2 WHERE id = ?3", params![size as i64, mtime_ms, k.id]).map_err(sql)?;
            return Ok(Outcome::Stamped);
        }
    }
    let name = rel.rsplit('/').next().unwrap_or(rel);
    let page = extract::extract(kind, name, &bytes);
    conn.execute(
        "INSERT INTO pages (notebook, path, kind, title, sha256, size, mtime_ms, indexed_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) \
         ON CONFLICT (notebook, path) DO UPDATE SET kind = ?3, title = ?4, sha256 = ?5, size = ?6, mtime_ms = ?7, indexed_at = ?8",
        params![notebook, rel, kind, page.title, hash, size as i64, mtime_ms, now_ms()],
    )
    .map_err(sql)?;
    let id: i64 = conn.query_row("SELECT id FROM pages WHERE notebook = ?1 AND path = ?2", params![notebook, rel], |r| r.get(0)).map_err(sql)?;
    conn.prepare_cached("DELETE FROM fts WHERE rowid = ?1").map_err(sql)?.execute([id]).map_err(sql)?;
    conn.prepare_cached("INSERT INTO fts (rowid, title, headings, body, tags) VALUES (?1, ?2, ?3, ?4, ?5)")
        .map_err(sql)?
        .execute(params![id, page.title, page.headings, page.body, page.tags.join(" ")])
        .map_err(sql)?;
    conn.prepare_cached("DELETE FROM links WHERE page = ?1").map_err(sql)?.execute([id]).map_err(sql)?;
    {
        let mut insert = conn.prepare_cached("INSERT INTO links (page, target_raw, target_kind, target_name, embed, line, context) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)").map_err(sql)?;
        for link in &page.links {
            insert.execute(params![id, link.raw, link.kind, super::links::name_key(&link.raw), link.embed, link.line, link.context]).map_err(sql)?;
        }
    }
    conn.prepare_cached("DELETE FROM tags WHERE page = ?1").map_err(sql)?.execute([id]).map_err(sql)?;
    {
        let mut insert = conn.prepare_cached("INSERT INTO tags (page, tag) VALUES (?1, ?2)").map_err(sql)?;
        for tag in &page.tags {
            insert.execute(params![id, tag]).map_err(sql)?;
        }
    }
    Ok(Outcome::Indexed)
}

/// What a pass over files did, for the progress line.
#[derive(Default)]
pub struct Pass {
    pub error: Option<String>,
}

/// Bring the rows of `notebook` below `under` (a folder, or "" for the whole notebook) in line with `found`: index what
/// changed, drop what is gone. `tick` is called after each batch with the number of files handled.
fn reconcile(conn: &mut Connection, notebook: &str, under: &str, found: Vec<Found>, mode: Mode, pass: &mut Pass, tick: &mut dyn FnMut(usize)) -> Result<(), String> {
    let sql = |e: rusqlite::Error| e.to_string();
    let mut known = known(conn, notebook).map_err(sql)?;
    if !under.is_empty() {
        let prefix = format!("{under}/");
        known.retain(|path, _| path.starts_with(&prefix));
    }
    let mut seen: HashSet<String> = HashSet::with_capacity(found.len());
    for chunk in found.chunks(BATCH) {
        let tx = conn.transaction().map_err(sql)?;
        for file in chunk {
            seen.insert(file.rel.clone());
            if let Err(e) = index_file(&tx, notebook, &file.rel, file.kind, &file.full, file.size, file.mtime_ms, known.get(&file.rel), mode) {
                pass.error = Some(e);
            }
        }
        tx.commit().map_err(sql)?;
        tick(chunk.len());
    }
    let gone: Vec<i64> = known.iter().filter(|(path, _)| !seen.contains(*path)).map(|(_, k)| k.id).collect();
    if !gone.is_empty() {
        let tx = conn.transaction().map_err(sql)?;
        for id in gone {
            remove_page(&tx, id).map_err(sql)?;
        }
        tx.commit().map_err(sql)?;
    }
    Ok(())
}

/// Index every notebook in `roots`. With `prune`, notebooks the index holds that are not in `roots` are dropped. A
/// notebook whose folder is missing (an unplugged drive) keeps its rows.
pub fn scan(conn: &mut Connection, roots: &[Root], mode: Mode, prune: bool, progress: &mut dyn FnMut(u64, u64)) -> Result<Pass, String> {
    let mut pass = Pass::default();
    let mut walked: Vec<(&Root, Vec<Found>)> = Vec::new();
    for root in roots {
        if !root.path.is_dir() {
            pass.error = Some(format!("The notebook folder {} is missing, so its pages were left as they were", root.path.display()));
            continue;
        }
        let mut found = Vec::new();
        walk(&root.path, "", &mut found);
        walked.push((root, found));
    }
    let total: usize = walked.iter().map(|(_, f)| f.len()).sum();
    let mut done = 0usize;
    progress(0, total as u64);
    for (root, found) in walked {
        reconcile(conn, &root.id, "", found, mode, &mut pass, &mut |n| {
            done += n;
            progress(done as u64, total as u64);
        })?;
    }
    if prune {
        let keep: HashSet<&str> = roots.iter().map(|r| r.id.as_str()).collect();
        let held: Vec<String> = conn
            .prepare("SELECT DISTINCT notebook FROM pages")
            .and_then(|mut s| s.query_map([], |r| r.get(0))?.collect::<Result<_, _>>())
            .map_err(|e| e.to_string())?;
        for notebook in held.iter().filter(|n| !keep.contains(n.as_str())) {
            let tx = conn.transaction().map_err(|e| e.to_string())?;
            remove_notebook(&tx, notebook).map_err(|e| e.to_string())?;
            tx.commit().map_err(|e| e.to_string())?;
        }
    }
    Ok(pass)
}

/// Bring the pages at `rels` (paths below the notebook's root, files or folders, present or gone) up to date. This is
/// how a change the watcher saw and a change one of Hivemind's own commands made reach the index.
pub fn update(conn: &mut Connection, root: &Root, rels: &[String]) -> Result<Pass, String> {
    let mut pass = Pass::default();
    let sql = |e: rusqlite::Error| e.to_string();
    for rel in rels {
        let Ok(parts) = contain::check_rel(rel) else { continue };
        if parts.iter().any(|p| notebooks::hidden(p)) {
            continue;
        }
        let full = parts.iter().fold(root.path.clone(), |path, part| path.join(part));
        let meta = std::fs::symlink_metadata(&full);
        // The path as the disk spells it: a rename that changed only letter case names the file by either spelling.
        let spelled = match &meta {
            Ok(_) => match contain::resolved_rel(&root.path, &full) {
                Some(real) if real.to_lowercase() == rel.to_lowercase() => real,
                // Not the file the path names: a link inside the notebook leads somewhere else.
                Some(_) | None => continue,
            },
            Err(_) => rel.clone(),
        };
        if spelled != *rel {
            remove_under(conn, &root.id, rel).map_err(sql)?;
        }
        match meta {
            Ok(m) if m.file_type().is_symlink() => continue,
            Ok(m) if m.is_dir() => {
                let mut found = Vec::new();
                walk(&full, &spelled, &mut found);
                reconcile(conn, &root.id, &spelled, found, Mode::Scan, &mut pass, &mut |_| {})?;
            }
            Ok(m) => {
                let name = spelled.rsplit('/').next().unwrap_or(&spelled);
                let tx = conn.transaction().map_err(sql)?;
                match kind_of(name) {
                    Some(kind) => {
                        let known = known_page(&tx, &root.id, &spelled);
                        // A change the watcher or a command reports may keep the size and the time (a quick second
                        // save), so the bytes are always compared.
                        if let Err(e) = index_file(&tx, &root.id, &spelled, kind, &full, m.len(), mtime_of(&m), known.as_ref(), Mode::Compare) {
                            pass.error = Some(e);
                        }
                    }
                    None => {
                        remove_under(&tx, &root.id, &spelled).map_err(sql)?;
                    }
                }
                tx.commit().map_err(sql)?;
            }
            Err(_) => {
                let tx = conn.transaction().map_err(sql)?;
                remove_under(&tx, &root.id, rel).map_err(sql)?;
                tx.commit().map_err(sql)?;
            }
        }
    }
    Ok(pass)
}
