//! Writing the index: reading a notebook's files, comparing them with what the index holds, and replacing the rows of
//! the pages that changed. Only the writer thread of `Index` calls into here.
use super::extract::{self, kind_of, READ_CAP};
use super::matrix::to_blob;
use super::semantic::{Identity, Semantic, Unavailable, MAX_VECTORS};
use super::units::{self, Unit};
use crate::files::watch::Root;
use crate::files::guard::Protected;
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
/// Pages embedded in one transaction by the pass that runs when the model appears.
const PASS_BATCH: usize = 50;

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
}

/// Where the index may read: one notebook's folder, minus the places no file command may touch. Every page is opened
/// through `file`, which is the containment the editor uses (`studio::inside`): no hidden part, nothing that leads outside
/// the folder once links are followed, nothing in the store, a managed vault or Hivemind's own data.
pub struct Reach<'a> {
    root: &'a Path,
    protected: &'a Protected,
}

impl<'a> Reach<'a> {
    pub fn new(root: &'a Path, protected: &'a Protected) -> Self {
        Reach { root, protected }
    }

    pub fn file(&self, rel: &str) -> Result<PathBuf, String> {
        crate::studio::inside(self.root, self.protected, rel, false)
    }
}

/// The protected places, for the store the meaning search is set to.
fn protected_for(sem: &Semantic) -> Protected {
    Protected::new(sem.root().as_deref())
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
                out.push(Found { rel: child, kind: page_kind, size: meta.len(), mtime_ms: mtime_of(&meta) });
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

pub fn remove_page(conn: &Connection, sem: &Semantic, id: i64) -> rusqlite::Result<()> {
    let vectors = conn.prepare_cached("DELETE FROM vectors WHERE unit IN (SELECT id FROM units WHERE page = ?1)")?.execute([id])?;
    sem.adjust_vectors(-(vectors as i64));
    conn.prepare_cached("DELETE FROM units WHERE page = ?1")?.execute([id])?;
    sem.matrix.stage(id);
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
pub fn remove_under(conn: &Connection, sem: &Semantic, notebook: &str, rel: &str) -> rusqlite::Result<usize> {
    let mut stmt = conn.prepare("SELECT id FROM pages WHERE notebook = ?1 AND (path = ?2 OR path LIKE ?3 ESCAPE '\\')")?;
    let ids: Vec<i64> = stmt.query_map(params![notebook, rel, format!("{}/%", like_escape(rel))], |r| r.get(0))?.collect::<Result<_, _>>()?;
    for id in &ids {
        remove_page(conn, sem, *id)?;
    }
    Ok(ids.len())
}

pub fn remove_notebook(conn: &Connection, sem: &Semantic, notebook: &str) -> rusqlite::Result<()> {
    let ids: Vec<i64> = conn.prepare("SELECT id FROM pages WHERE notebook = ?1")?.query_map([notebook], |r| r.get(0))?.collect::<Result<_, _>>()?;
    for id in ids {
        remove_page(conn, sem, id)?;
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

/// The words to ask Living Memory for notes related to a page with: its title and the start of its first unit of text.
/// Empty when the page cannot be read, or is not one the editor would open.
pub fn related_text(reach: &Reach, rel: &str) -> String {
    const CHARS: usize = 300;
    let Ok(full) = reach.file(rel) else { return String::new() };
    let name = rel.rsplit('/').next().unwrap_or(rel);
    let Some(kind) = kind_of(name) else { return String::new() };
    let Ok((bytes, _)) = read_for_index(&full, kind) else { return String::new() };
    let page = extract::extract(kind, name, &bytes);
    let first = units::cut(&page.title, &page.lines).into_iter().find(|u| u.text != page.title.trim()).and_then(|u| u.text.split_once('\n').map(|(_, text)| text.split_whitespace().collect::<Vec<_>>().join(" ")));
    let text = match first {
        Some(text) => format!("{} {text}", page.title.trim()),
        None => page.title.trim().to_string(),
    };
    text.chars().take(CHARS).collect()
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
pub fn index_file(conn: &Connection, sem: &Semantic, reach: &Reach, notebook: &str, rel: &str, kind: &str, size: u64, mtime_ms: i64, known: Option<&Known>, mode: Mode) -> Result<Outcome, String> {
    if mode == Mode::Scan && known.is_some_and(|k| k.size == size as i64 && k.mtime_ms == mtime_ms) {
        return Ok(Outcome::Unchanged);
    }
    let sql = |e: rusqlite::Error| e.to_string();
    // A page the editor would not open is not read, and what the index held of it goes.
    let full = match reach.file(rel) {
        Ok(full) => full,
        Err(why) => {
            if let Some(k) = known {
                remove_page(conn, sem, k.id).map_err(sql)?;
            }
            return Err(format!("{rel} was not indexed: {why}"));
        }
    };
    let (bytes, hash) = read_for_index(&full, kind).map_err(|e| format!("Could not read {}: {e}", full.display()))?;
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
    store_units(conn, sem, id, &units::cut(&page.title, &page.lines))?;
    Ok(Outcome::Indexed)
}

/// Make the units of page `id` what `cut` says. A unit whose text is the same as before keeps its row and its vector; the
/// others are embedded, when the model is there. Units without a vector wait for the pass that runs when the model appears.
fn store_units(conn: &Connection, sem: &Semantic, id: i64, cut: &[Unit]) -> Result<(), String> {
    let sql = |e: rusqlite::Error| e.to_string();
    let mut old: HashMap<String, Vec<(i64, bool)>> = HashMap::new();
    {
        let mut stmt = conn.prepare_cached("SELECT u.id, u.sha, v.unit IS NOT NULL FROM units u LEFT JOIN vectors v ON v.unit = u.id WHERE u.page = ?1 ORDER BY u.ord").map_err(sql)?;
        let rows = stmt.query_map([id], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, bool>(2)?))).map_err(sql)?;
        for row in rows {
            let (unit, sha, has) = row.map_err(sql)?;
            old.entry(sha).or_default().push((unit, has));
        }
    }
    let mut need: Vec<(i64, usize)> = Vec::new();
    for (ord, unit) in cut.iter().enumerate() {
        match old.get_mut(&unit.sha).filter(|same| !same.is_empty()).map(|same| same.remove(0)) {
            Some((unit_id, has)) => {
                conn.prepare_cached("UPDATE units SET ord = ?1, heading = ?2, first_line = ?3 WHERE id = ?4").map_err(sql)?.execute(params![ord as i64, unit.heading, unit.first_line, unit_id]).map_err(sql)?;
                if !has {
                    need.push((unit_id, ord));
                }
            }
            None => {
                conn.prepare_cached("INSERT INTO units (page, ord, heading, first_line, sha) VALUES (?1, ?2, ?3, ?4, ?5)")
                    .map_err(sql)?
                    .execute(params![id, ord as i64, unit.heading, unit.first_line, unit.sha])
                    .map_err(sql)?;
                need.push((conn.last_insert_rowid(), ord));
            }
        }
    }
    for (unit_id, has) in old.into_values().flatten() {
        conn.prepare_cached("DELETE FROM units WHERE id = ?1").map_err(sql)?.execute([unit_id]).map_err(sql)?;
        if has {
            conn.prepare_cached("DELETE FROM vectors WHERE unit = ?1").map_err(sql)?.execute([unit_id]).map_err(sql)?;
            sem.adjust_vectors(-1);
        }
    }
    embed_units(conn, sem, &need, cut)?;
    sem.matrix.stage(id);
    Ok(())
}

/// Another model than the one the vectors in the index came from: they are not comparable, so every one goes.
fn use_model(conn: &Connection, sem: &Semantic, identity: &Identity) -> Result<(), String> {
    let sql = |e: rusqlite::Error| e.to_string();
    let key = identity.key();
    let held: Option<String> = conn.query_row("SELECT value FROM meta WHERE key = 'model'", [], |r| r.get(0)).ok();
    if held.as_deref() != Some(key.as_str()) {
        conn.execute("DELETE FROM vectors", []).map_err(sql)?;
        conn.execute("INSERT OR REPLACE INTO meta (key, value) VALUES ('model', ?1)", [&key]).map_err(sql)?;
        sem.vectors.store(0, std::sync::atomic::Ordering::Relaxed);
        sem.full.store(false, std::sync::atomic::Ordering::Relaxed);
        sem.matrix.stage_reset();
        sem.forget_pass();
    }
    Ok(())
}

/// Embed the units `need` names (a unit row and the index of its text in `cut`) and store the vectors. A unit the model
/// knows nothing of gets an empty vector, so it is not tried again. Without the model, or past the vector budget, the
/// units are left as they are.
fn embed_units(conn: &Connection, sem: &Semantic, need: &[(i64, usize)], cut: &[Unit]) -> Result<(), String> {
    use std::sync::atomic::Ordering;
    if need.is_empty() {
        return Ok(());
    }
    let sql = |e: rusqlite::Error| e.to_string();
    let texts: Vec<&str> = need.iter().map(|(_, i)| cut[*i].text.as_str()).collect();
    if sem.identity().is_none() {
        sem.forget_pass();
        return Ok(());
    }
    if sem.vector_count(conn).map_err(sql)? + need.len() as i64 > MAX_VECTORS {
        sem.full.store(true, Ordering::Relaxed);
        return Ok(());
    }
    match sem.embed(&texts) {
        Ok(done) => {
            use_model(conn, sem, &done.identity)?;
            let mut insert = conn.prepare_cached("INSERT OR REPLACE INTO vectors (unit, vec) VALUES (?1, ?2)").map_err(sql)?;
            for ((unit_id, _), vector) in need.iter().zip(&done.vectors) {
                let blob = vector.as_deref().map(to_blob).unwrap_or_default();
                insert.execute(params![unit_id, blob]).map_err(sql)?;
                sem.adjust_vectors(1);
            }
        }
        // The marker went between the two checks: the pass that runs when the model is back fills the gap.
        Err(Unavailable::Absent) => sem.forget_pass(),
        // A model that cannot be read is reported by `Semantic::status`; the pages stay lexical.
        Err(Unavailable::Broken(_)) => {}
    }
    Ok(())
}

/// What a pass over files did, for the progress line.
#[derive(Default)]
pub struct Pass {
    pub error: Option<String>,
}

/// Bring the rows of `notebook` below `under` (a folder, or "" for the whole notebook) in line with `found`: index what
/// changed, drop what is gone. `tick` is called after each batch with the number of files handled.
#[allow(clippy::too_many_arguments)]
fn reconcile(conn: &mut Connection, sem: &Semantic, reach: &Reach, notebook: &str, under: &str, found: Vec<Found>, mode: Mode, pass: &mut Pass, tick: &mut dyn FnMut(usize)) -> Result<(), String> {
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
            if let Err(e) = index_file(&tx, sem, reach, notebook, &file.rel, file.kind, file.size, file.mtime_ms, known.get(&file.rel), mode) {
                pass.error = Some(e);
            }
        }
        tx.commit().map_err(sql)?;
        sem.matrix.publish();
        tick(chunk.len());
    }
    let gone: Vec<i64> = known.iter().filter(|(path, _)| !seen.contains(*path)).map(|(_, k)| k.id).collect();
    if !gone.is_empty() {
        let tx = conn.transaction().map_err(sql)?;
        for id in gone {
            remove_page(&tx, sem, id).map_err(sql)?;
        }
        tx.commit().map_err(sql)?;
        sem.matrix.publish();
    }
    Ok(())
}

/// Index every notebook in `roots`. With `prune`, notebooks the index holds that are not in `roots` are dropped. A
/// notebook whose folder is missing (an unplugged drive) keeps its rows.
pub fn scan(conn: &mut Connection, sem: &Semantic, roots: &[Root], mode: Mode, prune: bool, progress: &mut dyn FnMut(u64, u64)) -> Result<Pass, String> {
    let mut pass = Pass::default();
    let protected = protected_for(sem);
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
        reconcile(conn, sem, &Reach::new(&root.path, &protected), &root.id, "", found, mode, &mut pass, &mut |n| {
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
            remove_notebook(&tx, sem, notebook).map_err(|e| e.to_string())?;
            tx.commit().map_err(|e| e.to_string())?;
            sem.matrix.publish();
        }
    }
    Ok(pass)
}

/// Bring the pages at `rels` (paths below the notebook's root, files or folders, present or gone) up to date. This is
/// how a change the watcher saw and a change one of Hivemind's own commands made reach the index.
pub fn update(conn: &mut Connection, sem: &Semantic, root: &Root, rels: &[String]) -> Result<Pass, String> {
    let mut pass = Pass::default();
    let protected = protected_for(sem);
    let reach = Reach::new(&root.path, &protected);
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
            remove_under(conn, sem, &root.id, rel).map_err(sql)?;
            sem.matrix.publish();
        }
        match meta {
            Ok(m) if m.file_type().is_symlink() => continue,
            Ok(m) if m.is_dir() => {
                let mut found = Vec::new();
                walk(&full, &spelled, &mut found);
                reconcile(conn, sem, &reach, &root.id, &spelled, found, Mode::Scan, &mut pass, &mut |_| {})?;
            }
            Ok(m) => {
                let name = spelled.rsplit('/').next().unwrap_or(&spelled);
                let tx = conn.transaction().map_err(sql)?;
                match kind_of(name) {
                    Some(kind) => {
                        let known = known_page(&tx, &root.id, &spelled);
                        // A change the watcher or a command reports may keep the size and the time (a quick second
                        // save), so the bytes are always compared.
                        if let Err(e) = index_file(&tx, sem, &reach, &root.id, &spelled, kind, m.len(), mtime_of(&m), known.as_ref(), Mode::Compare) {
                            pass.error = Some(e);
                        }
                    }
                    None => {
                        remove_under(&tx, sem, &root.id, &spelled).map_err(sql)?;
                    }
                }
                tx.commit().map_err(sql)?;
                sem.matrix.publish();
            }
            Err(_) => {
                let tx = conn.transaction().map_err(sql)?;
                remove_under(&tx, sem, &root.id, rel).map_err(sql)?;
                tx.commit().map_err(sql)?;
                sem.matrix.publish();
            }
        }
    }
    Ok(pass)
}

/// Give every page that has units without a vector its vectors, with the model installed now. This is the pass that runs
/// when the model appears or changes: a page is read from its file again (the units are not kept as text), and a page that
/// no longer matches the index is indexed afresh, which embeds it too. `progress` is told how many pages are done.
pub fn embed_pass(conn: &mut Connection, sem: &Semantic, roots: &[Root], progress: &mut dyn FnMut(u64, u64)) -> Result<Pass, String> {
    use std::sync::atomic::Ordering;
    let mut pass = Pass::default();
    let sql = |e: rusqlite::Error| e.to_string();
    let Some(identity) = sem.identity() else {
        sem.forget_pass();
        return Ok(pass);
    };
    if sem.failure(&identity).is_some() {
        return Ok(pass);
    }
    // A model that cannot be read is found out here, before any page is read.
    match sem.embed(&[]) {
        Ok(_) => {}
        Err(Unavailable::Broken(why)) => {
            pass.error = Some(format!("Meaning search cannot read the model: {why}"));
            return Ok(pass);
        }
        Err(Unavailable::Absent) => return Ok(pass),
    }
    // A model the index has not seen drops the old vectors first.
    {
        let tx = conn.transaction().map_err(sql)?;
        use_model(&tx, sem, &identity)?;
        tx.commit().map_err(sql)?;
        sem.matrix.publish();
    }
    let todo: Vec<(i64, String, String, String, String)> = conn
        .prepare(
            "SELECT p.id, p.notebook, p.path, p.kind, p.sha256 FROM pages p WHERE EXISTS \
             (SELECT 1 FROM units u WHERE u.page = p.id AND NOT EXISTS (SELECT 1 FROM vectors v WHERE v.unit = u.id)) ORDER BY p.id",
        )
        .and_then(|mut s| s.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))?.collect::<Result<_, _>>())
        .map_err(sql)?;
    let protected = protected_for(sem);
    let total = todo.len() as u64;
    progress(0, total);
    let mut done = 0u64;
    'pages: for chunk in todo.chunks(PASS_BATCH) {
        let tx = conn.transaction().map_err(sql)?;
        for (id, notebook, rel, kind, sha) in chunk {
            if sem.identity().as_ref() != Some(&identity) {
                // The model changed or went away under the pass: stop, and the next pass starts from the new marker.
                tx.commit().map_err(sql)?;
                sem.matrix.publish();
                return Ok(pass);
            }
            if sem.vector_count(&tx).map_err(sql)? >= MAX_VECTORS {
                sem.full.store(true, Ordering::Relaxed);
                tx.commit().map_err(sql)?;
                sem.matrix.publish();
                break 'pages;
            }
            let Some(root) = roots.iter().find(|r| r.id == *notebook) else { continue };
            // The same containment as every other read: a page that now leads out of its notebook is dropped, not embedded.
            let Ok(full) = Reach::new(&root.path, &protected).file(rel) else {
                remove_page(&tx, sem, *id).map_err(sql)?;
                continue;
            };
            let Ok(meta) = std::fs::metadata(&full) else { continue };
            let result = read_for_index(&full, kind).map_err(|e| format!("Could not read {}: {e}", full.display())).and_then(|(bytes, hash)| {
                if hash == *sha {
                    let name = rel.rsplit('/').next().unwrap_or(rel);
                    let page = extract::extract(kind, name, &bytes);
                    store_units(&tx, sem, *id, &units::cut(&page.title, &page.lines))
                } else {
                    // The file is not what the index read: index it afresh, which embeds it as well.
                    let known = known_page(&tx, notebook, rel);
                    index_file(&tx, sem, &Reach::new(&root.path, &protected), notebook, rel, kind, meta.len(), mtime_of(&meta), known.as_ref(), Mode::Compare).map(|_| ())
                }
            });
            if let Err(e) = result {
                pass.error = Some(e);
            }
        }
        tx.commit().map_err(sql)?;
        sem.matrix.publish();
        done += chunk.len() as u64;
        progress(done, total);
    }
    if sem.identity().as_ref() == Some(&identity) {
        *sem.pass.lock().unwrap_or_else(|e| e.into_inner()) = Some(identity.key());
    }
    Ok(pass)
}
