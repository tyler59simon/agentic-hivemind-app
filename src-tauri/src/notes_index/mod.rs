//! Notes Studio's search index (NS-4A): a derived SQLite database of the pages of every folder notebook, in app data. It
//! holds each page's title, headings, text, tags and links, and answers search, backlinks, the page list and the tag list.
//! Files stay the only source of truth: the database can be deleted at any time and is made again from them.
//!
//! One writer thread owns the write connection. It is fed by the notebook watcher (changes other programs make), by the
//! Rust commands that write notebook files (the watcher drops Hivemind's own writes), and by a scan at start and when a
//! notebook is added, which compares each file's size and time with the row it has.
pub mod commands;
pub mod extract;
pub mod links;
pub mod query;
mod schema;
mod writer;

use crate::files::watch::Root;
use rusqlite::Connection;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use writer::Mode;

/// The `index-progress` event, and the state of the index.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    /// `scanning` while a scan or a rebuild runs, else `idle`.
    pub state: &'static str,
    pub done: u64,
    pub total: u64,
    /// Why the index could not be kept current (a file that could not be read, a folder that is missing), or why it is
    /// not available at all.
    pub error: Option<String>,
}

/// What `index_status` reports.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    #[serde(flatten)]
    pub progress: Progress,
    pub pages: u64,
    pub notebooks: Vec<NotebookCount>,
    pub version: u32,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct NotebookCount {
    pub id: String,
    pub pages: u64,
}

pub type Emit = Arc<dyn Fn(&Progress) + Send + Sync>;

enum Job {
    /// Index every notebook and drop the rest.
    Sync(Vec<Root>),
    /// Read every page of these notebooks again.
    Rebuild(Vec<Root>),
    /// Bring these paths of one notebook up to date.
    Paths(Root, Vec<String>),
    /// Answers once every job before it is done (tests).
    #[cfg_attr(not(test), allow(dead_code))]
    Barrier(Sender<()>),
}

struct Shared {
    db: PathBuf,
    progress: Mutex<Progress>,
    reader: Mutex<Option<Connection>>,
}

/// A handle on the index; cloning it is cheap, and every clone talks to the same writer thread.
#[derive(Clone)]
pub struct Index {
    jobs: Option<Sender<Job>>,
    shared: Arc<Shared>,
}

fn idle(error: Option<String>) -> Progress {
    Progress { state: "idle", done: 0, total: 0, error }
}

impl Index {
    /// Open the index database in `dir` (making it, or making it again when its version is another or it is damaged) and
    /// start the writer thread. An index that cannot be opened is still returned, reporting why in its status.
    pub fn start(dir: &Path, emit: Emit) -> Index {
        let db = dir.join("index.sqlite3");
        let shared = |error| Arc::new(Shared { db: db.clone(), progress: Mutex::new(idle(error)), reader: Mutex::new(None) });
        match schema::open(&db) {
            Ok((conn, _fresh)) => {
                let shared = shared(None);
                let (tx, rx) = channel();
                let worker = shared.clone();
                std::thread::Builder::new().name("notes-index".into()).spawn(move || run(conn, rx, worker, emit)).expect("the index thread starts");
                Index { jobs: Some(tx), shared }
            }
            Err(e) => Index { jobs: None, shared: shared(Some(e)) },
        }
    }

    fn send(&self, job: Job) {
        if let Some(jobs) = &self.jobs {
            let _ = jobs.send(job);
        }
    }

    /// Index every notebook in `roots` (a file with the size and time the index has is left alone) and forget the
    /// notebooks that are no longer there.
    pub fn sync(&self, roots: Vec<Root>) {
        self.send(Job::Sync(roots));
    }

    /// Read every page of `roots` again.
    pub fn rebuild(&self, roots: Vec<Root>) {
        self.send(Job::Rebuild(roots));
    }

    /// Tell the index that `rels` (pages or folders of the notebook `root`) changed, were made or are gone.
    pub fn touch(&self, root: Root, rels: Vec<String>) {
        if !rels.is_empty() {
            self.send(Job::Paths(root, rels));
        }
    }

    /// Wait until the writer has done everything sent before this call.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn flush(&self) {
        let (done, wait) = channel();
        self.send(Job::Barrier(done));
        let _ = wait.recv_timeout(std::time::Duration::from_secs(120));
    }

    /// Run `read` on the reading connection, which opens on first use.
    pub fn read<T>(&self, read: impl FnOnce(&Connection) -> rusqlite::Result<T>) -> Result<T, String> {
        if let Some(why) = &self.shared.progress.lock().unwrap_or_else(|e| e.into_inner()).error
            && self.jobs.is_none()
        {
            return Err(format!("The search index is not available: {why}"));
        }
        let mut slot = self.shared.reader.lock().unwrap_or_else(|e| e.into_inner());
        if slot.is_none() {
            *slot = Some(schema::open_reader(&self.shared.db)?);
        }
        read(slot.as_ref().expect("the reader was just opened")).map_err(|e| format!("The search index could not be read: {e}"))
    }

    /// `scanning` while a scan or a rebuild runs, else `idle`.
    pub fn state(&self) -> &'static str {
        self.shared.progress.lock().unwrap_or_else(|e| e.into_inner()).state
    }

    pub fn status(&self) -> Result<Status, String> {
        let progress = self.shared.progress.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let notebooks: Vec<NotebookCount> = if self.jobs.is_some() { self.read(query::counts)?.into_iter().map(|(id, pages)| NotebookCount { id, pages }).collect() } else { Vec::new() };
        Ok(Status { pages: notebooks.iter().map(|n| n.pages).sum(), notebooks, progress, version: schema::VERSION })
    }
}

fn run(mut conn: Connection, jobs: Receiver<Job>, shared: Arc<Shared>, emit: Emit) {
    let set = |progress: Progress| {
        *shared.progress.lock().unwrap_or_else(|e| e.into_inner()) = progress.clone();
        emit(&progress);
    };
    while let Ok(job) = jobs.recv() {
        if let Job::Barrier(done) = job {
            let _ = done.send(());
            continue;
        }
        // A page that makes an extractor panic must not stop the index for good.
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| match &job {
            Job::Sync(roots) | Job::Rebuild(roots) => {
                let (mode, prune) = if matches!(job, Job::Sync(_)) { (Mode::Scan, true) } else { (Mode::Force, false) };
                let mut report = |done, total| set(Progress { state: "scanning", done, total, error: None });
                report(0, 0);
                writer::scan(&mut conn, roots, mode, prune, &mut report)
            }
            Job::Paths(root, rels) => writer::update(&mut conn, root, rels),
            Job::Barrier(_) => Ok(writer::Pass::default()),
        }));
        set(idle(match outcome {
            Ok(Ok(pass)) => pass.error,
            Ok(Err(e)) => Some(e),
            Err(_) => Some("The search index hit an internal error and skipped a page".to_string()),
        }));
    }
}

#[cfg(test)]
mod tests {
    use super::query::{Filters, Hit};
    use super::*;

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hm-index-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(root: &Path, rel: &str, text: &str) {
        let path = root.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    /// Close the index (its database files stay locked on Windows while a connection is open) and remove the folder.
    fn finish(index: Index, dir: &Path) {
        drop(index);
        for _ in 0..100 {
            if std::fs::remove_dir_all(dir).is_ok() {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        panic!("could not remove {}", dir.display());
    }

    fn started(dir: &Path) -> Index {
        Index::start(&dir.join("data"), Arc::new(|_| {}))
    }

    fn root(dir: &Path, id: &str) -> Root {
        Root { id: id.into(), path: dir.join(id) }
    }

    fn found(index: &Index, text: &str, filters: &Filters) -> Vec<String> {
        index.read(|c| query::search(c, text, filters, 50)).unwrap().into_iter().map(|h| format!("{}:{}", h.notebook, h.path)).collect()
    }

    fn all(index: &Index, text: &str) -> Vec<String> {
        found(index, text, &Filters::default())
    }

    fn pages(index: &Index) -> Vec<String> {
        index.read(|c| query::pages(c, None)).unwrap().into_iter().map(|p| format!("{}:{}", p.notebook, p.path)).collect()
    }

    #[test]
    fn a_database_with_another_version_or_damaged_is_made_again() {
        let dir = scratch();
        let db = dir.join("index.sqlite3");
        let (conn, fresh) = schema::open_versioned(&db, 1).unwrap();
        assert!(fresh);
        conn.execute("INSERT INTO pages (notebook, path, kind, title, sha256, size, mtime_ms, indexed_at) VALUES ('nb', 'a.md', 'md', 'A', '', 0, 0, 0)", []).unwrap();
        drop(conn);
        // The same version keeps its rows.
        let (conn, fresh) = schema::open_versioned(&db, 1).unwrap();
        assert!(!fresh);
        assert_eq!(conn.query_row("SELECT count(*) FROM pages", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
        drop(conn);
        // A newer schema drops everything and starts over.
        let (conn, fresh) = schema::open_versioned(&db, 2).unwrap();
        assert!(fresh);
        assert_eq!(conn.query_row("SELECT count(*) FROM pages", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
        assert_eq!(conn.query_row("PRAGMA user_version", [], |r| r.get::<_, u32>(0)).unwrap(), 2);
        drop(conn);
        // A file that is not a database is replaced.
        std::fs::write(&db, b"this is not sqlite at all, just text that is long enough to be read as a header").unwrap();
        let (conn, fresh) = schema::open_versioned(&db, 2).unwrap();
        assert!(fresh);
        assert_eq!(conn.query_row("SELECT count(*) FROM pages", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
        drop(conn);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_first_scan_indexes_pages_and_skips_what_the_tree_hides() {
        let dir = scratch();
        let nb = root(&dir, "nb-1");
        write(&nb.path, "Inbox.md", "# Inbox\nfirst page");
        write(&nb.path, "Projects/Plan.md", "# Plan\n[[Inbox]] and #work");
        write(&nb.path, "Projects/board.canvas", r#"{"nodes":[{"id":"a","type":"text","text":"idea"}]}"#);
        write(&nb.path, "notes.txt", "plain text");
        write(&nb.path, "Rich.hmdoc", r#"{"schemaVersion":1,"format":"hivemind-rich","meta":{},"content":{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"rich words"}]}]}}"#);
        write(&nb.path, "image.png", "not indexed");
        write(&nb.path, ".git/hidden.md", "# hidden");
        write(&nb.path, ".hivemind/trash/old.md", "# trashed");
        write(&nb.path, "node_modules/pkg/readme.md", "# pkg");
        write(&nb.path, ".Page.md.hm-0123abcd.tmp", "temp");
        let index = started(&dir);
        index.sync(vec![nb.clone()]);
        index.flush();
        assert_eq!(pages(&index), ["nb-1:Inbox.md", "nb-1:Projects/Plan.md", "nb-1:Projects/board.canvas", "nb-1:Rich.hmdoc", "nb-1:notes.txt"]);
        assert_eq!(all(&index, "rich words"), ["nb-1:Rich.hmdoc"]);
        assert_eq!(all(&index, "idea"), ["nb-1:Projects/board.canvas"]);
        let status = index.status().unwrap();
        assert_eq!((status.pages, status.progress.state, status.progress.error.is_none()), (5, "idle", true));
        finish(index, &dir);
    }

    #[test]
    fn a_changed_file_is_indexed_again_and_a_deleted_or_renamed_one_goes() {
        let dir = scratch();
        let nb = root(&dir, "nb-1");
        write(&nb.path, "A.md", "# A\nalpha apple");
        write(&nb.path, "Folder/B.md", "# B\nbeta banana");
        write(&nb.path, "Folder/Deep/C.md", "# C\ngamma cherry");
        let index = started(&dir);
        index.sync(vec![nb.clone()]);
        index.flush();
        assert_eq!(all(&index, "apple"), ["nb-1:A.md"]);
        // An edit, as the watcher reports it.
        write(&nb.path, "A.md", "# A\nalpha avocado");
        index.touch(nb.clone(), vec!["A.md".into()]);
        index.flush();
        assert_eq!((all(&index, "apple"), all(&index, "avocado")), (vec![], vec!["nb-1:A.md".to_string()]));
        // A deleted file.
        std::fs::remove_file(nb.path.join("A.md")).unwrap();
        index.touch(nb.clone(), vec!["A.md".into()]);
        index.flush();
        assert!(all(&index, "avocado").is_empty());
        // A renamed page: the old path is gone, the new one is there; a renamed folder moves every page under it.
        std::fs::rename(nb.path.join("Folder/B.md"), nb.path.join("Folder/Renamed.md")).unwrap();
        index.touch(nb.clone(), vec!["Folder/B.md".into(), "Folder/Renamed.md".into()]);
        index.flush();
        assert_eq!(all(&index, "banana"), ["nb-1:Folder/Renamed.md"]);
        std::fs::rename(nb.path.join("Folder"), nb.path.join("Moved")).unwrap();
        index.touch(nb.clone(), vec!["Folder".into(), "Moved".into()]);
        index.flush();
        assert_eq!(pages(&index), ["nb-1:Moved/Deep/C.md", "nb-1:Moved/Renamed.md"]);
        // A deleted folder drops everything under it.
        std::fs::remove_dir_all(nb.path.join("Moved")).unwrap();
        index.touch(nb.clone(), vec!["Moved".into()]);
        index.flush();
        assert!(pages(&index).is_empty());
        finish(index, &dir);
    }

    #[test]
    fn hiveminds_own_writes_reach_the_index_without_the_watcher() {
        // The watcher drops what Hivemind wrote (`is_own_write`), so the commands tell the index themselves.
        let dir = scratch();
        let nb = root(&dir, "nb-1");
        std::fs::create_dir_all(&nb.path).unwrap();
        let index = started(&dir);
        index.sync(vec![nb.clone()]);
        let page = nb.path.join("Made.md");
        let stamp = crate::files::create(&page, "# Made\nfresh words").unwrap();
        assert!(crate::files::is_own_write(&page), "the watcher would drop this write");
        index.touch(nb.clone(), vec!["Made.md".into()]);
        index.flush();
        assert_eq!(all(&index, "fresh"), ["nb-1:Made.md"]);
        let loaded = crate::files::read(&page).unwrap();
        crate::files::save(&page, "# Made\nedited words", &stamp, &loaded.format, false).unwrap();
        assert!(crate::files::is_own_write(&page));
        index.touch(nb.clone(), vec!["Made.md".into()]);
        index.flush();
        assert_eq!((all(&index, "fresh"), all(&index, "edited")), (vec![], vec!["nb-1:Made.md".to_string()]));
        crate::files::rename(&page, &nb.path.join("Sub/Moved.md")).unwrap();
        index.touch(nb.clone(), vec!["Made.md".into(), "Sub/Moved.md".into()]);
        index.flush();
        assert_eq!(pages(&index), ["nb-1:Sub/Moved.md"]);
        finish(index, &dir);
    }

    #[test]
    fn a_rename_that_changes_only_letter_case_leaves_one_page_under_the_disk_spelling() {
        let dir = scratch();
        let nb = root(&dir, "nb-1");
        write(&nb.path, "note.md", "# Note\ncase words");
        let index = started(&dir);
        index.sync(vec![nb.clone()]);
        index.flush();
        crate::files::rename(&nb.path.join("note.md"), &nb.path.join("NOTE.md")).unwrap();
        index.touch(nb.clone(), vec!["note.md".into(), "NOTE.md".into()]);
        index.flush();
        assert_eq!(pages(&index), ["nb-1:NOTE.md"]);
        assert_eq!(all(&index, "case"), ["nb-1:NOTE.md"]);
        finish(index, &dir);
    }

    #[test]
    fn a_restart_compares_size_and_time_and_reads_only_what_differs() {
        let dir = scratch();
        let nb = root(&dir, "nb-1");
        write(&nb.path, "Same.md", "# Same\nunchanged words");
        write(&nb.path, "Edited.md", "# Edited\nold words");
        write(&nb.path, "Gone.md", "# Gone\nvanishing words");
        let data = dir.join("data");
        let index = Index::start(&data, Arc::new(|_| {}));
        index.sync(vec![nb.clone()]);
        index.flush();
        let stamps = |index: &Index| index.read(|c| c.prepare("SELECT path, indexed_at FROM pages ORDER BY path")?.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?.collect::<Result<Vec<_>, _>>()).unwrap();
        let before = stamps(&index);
        drop(index);
        std::thread::sleep(std::time::Duration::from_millis(20));
        // Changed while Hivemind was not running.
        write(&nb.path, "Edited.md", "# Edited\nnew words and more");
        std::fs::remove_file(nb.path.join("Gone.md")).unwrap();
        write(&nb.path, "Added.md", "# Added\nbrand new");
        let index = Index::start(&data, Arc::new(|_| {}));
        index.sync(vec![nb.clone()]);
        index.flush();
        let after = stamps(&index);
        assert_eq!(after.iter().map(|p| p.0.as_str()).collect::<Vec<_>>(), ["Added.md", "Edited.md", "Same.md"]);
        let at = |list: &[(String, i64)], name: &str| list.iter().find(|p| p.0 == name).map(|p| p.1);
        assert_eq!(at(&after, "Same.md"), at(&before, "Same.md"), "an unchanged file is not read again");
        assert!(at(&after, "Edited.md") > at(&before, "Edited.md"));
        assert_eq!(all(&index, "more"), ["nb-1:Edited.md"]);
        assert!(all(&index, "vanishing").is_empty());
        finish(index, &dir);
    }

    #[test]
    fn a_file_with_the_same_bytes_and_another_time_keeps_its_rows() {
        let dir = scratch();
        let nb = root(&dir, "nb-1");
        write(&nb.path, "Touched.md", "# Touched\nsame text");
        let index = started(&dir);
        index.sync(vec![nb.clone()]);
        index.flush();
        let before = index.read(|c| c.query_row("SELECT indexed_at, mtime_ms FROM pages", [], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)))).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(30));
        write(&nb.path, "Touched.md", "# Touched\nsame text");
        index.touch(nb.clone(), vec!["Touched.md".into()]);
        index.flush();
        let after = index.read(|c| c.query_row("SELECT indexed_at, mtime_ms FROM pages", [], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)))).unwrap();
        assert_eq!(after.0, before.0, "not extracted again");
        assert!(after.1 >= before.1);
        finish(index, &dir);
    }

    #[test]
    fn removing_a_notebook_drops_its_pages_and_a_missing_folder_keeps_them() {
        let dir = scratch();
        let (one, two) = (root(&dir, "nb-1"), root(&dir, "nb-2"));
        write(&one.path, "A.md", "# A\nshared");
        write(&two.path, "B.md", "# B\nshared");
        let index = started(&dir);
        index.sync(vec![one.clone(), two.clone()]);
        index.flush();
        assert_eq!(all(&index, "shared"), ["nb-1:A.md", "nb-2:B.md"]);
        // The drive of nb-2 is not there now: its pages stay as they were.
        std::fs::remove_dir_all(&two.path).unwrap();
        index.sync(vec![one.clone(), two.clone()]);
        index.flush();
        assert_eq!(all(&index, "shared"), ["nb-1:A.md", "nb-2:B.md"]);
        assert!(index.status().unwrap().progress.error.unwrap().contains("missing"));
        // Removed from Hivemind: gone from the index.
        index.sync(vec![one.clone()]);
        index.flush();
        assert_eq!(all(&index, "shared"), ["nb-1:A.md"]);
        assert_eq!(index.status().unwrap().notebooks, [NotebookCount { id: "nb-1".into(), pages: 1 }]);
        finish(index, &dir);
    }

    #[test]
    fn rebuild_reads_every_page_again() {
        let dir = scratch();
        let nb = root(&dir, "nb-1");
        write(&nb.path, "A.md", "# A\nbody");
        let index = started(&dir);
        index.sync(vec![nb.clone()]);
        index.flush();
        let before = index.read(|c| c.query_row("SELECT indexed_at FROM pages", [], |r| r.get::<_, i64>(0))).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        index.rebuild(vec![nb.clone()]);
        index.flush();
        let after = index.read(|c| c.query_row("SELECT indexed_at FROM pages", [], |r| r.get::<_, i64>(0))).unwrap();
        assert!(after > before);
        assert_eq!(all(&index, "body"), ["nb-1:A.md"]);
        finish(index, &dir);
    }

    fn corpus(dir: &Path) -> (Index, Root, Root) {
        let (one, two) = (root(dir, "nb-1"), root(dir, "nb-2"));
        write(&one.path, "Roadmap.md", "# Roadmap\nWe are searching for quarterly goals. #planning\nSee [[Inbox]] and [[Other/Notes]].");
        write(&one.path, "Inbox.md", "---\ntags: [work]\n---\n# Inbox\nThings to do about the Roadmap, not linked yet.");
        write(&one.path, "Archive/Old plan.md", "# Old plan\nquarterly numbers from last year #planning #work");
        write(&one.path, "Archive/Roadmap.md", "# Archive roadmap\nold [[Inbox]] and [text](../Inbox.md)");
        write(&one.path, "log.txt", "quarterly log lines");
        write(&two.path, "Notes.md", "# Café Über notes\nNaïve résumé of 日本語 quarterly work. [[Roadmap]]");
        let index = started(dir);
        index.sync(vec![one.clone(), two.clone()]);
        index.flush();
        (index, one, two)
    }

    #[test]
    fn search_matches_stems_phrases_prefixes_and_non_ascii_and_filters_by_everything() {
        let dir = scratch();
        let (index, _, _) = corpus(&dir);
        // Porter stemming: "search" finds "searching".
        assert_eq!(all(&index, "search"), ["nb-1:Roadmap.md"]);
        assert_eq!(all(&index, "\"quarterly goals\""), ["nb-1:Roadmap.md"]);
        assert!(all(&index, "\"goals quarterly\"").is_empty());
        // As the user types: the last word is a prefix.
        assert_eq!(all(&index, "quarterly goa"), ["nb-1:Roadmap.md"]);
        // Accents and other scripts.
        assert_eq!(all(&index, "cafe uber"), ["nb-2:Notes.md"]);
        assert_eq!(all(&index, "naive resume"), ["nb-2:Notes.md"]);
        assert_eq!(all(&index, "日本語"), ["nb-2:Notes.md"]);
        // A page with the word in its title comes before pages that only use it in their text.
        assert_eq!(all(&index, "inbox")[0], "nb-1:Inbox.md");
        let by = |filters: Filters| found(&index, "quarterly", &filters);
        assert_eq!(by(Filters { notebook: Some("nb-2".into()), ..Default::default() }), ["nb-2:Notes.md"]);
        assert_eq!(by(Filters { exclude_notebook: Some("nb-2".into()), ..Default::default() }).len(), 3);
        assert_eq!(by(Filters { folder: Some("Archive".into()), ..Default::default() }), ["nb-1:Archive/Old plan.md"]);
        assert_eq!(by(Filters { tag: Some("#Planning".into()), ..Default::default() }).len(), 2);
        assert_eq!(by(Filters { tag: Some("work".into()), ..Default::default() }), ["nb-1:Archive/Old plan.md"]);
        assert_eq!(by(Filters { kind: Some("txt".into()), ..Default::default() }), ["nb-1:log.txt"]);
        assert_eq!(by(Filters { modified_after_ms: Some(i64::MAX), ..Default::default() }).len(), 0);
        assert_eq!(by(Filters { modified_after_ms: Some(0), ..Default::default() }).len(), 4);
        // No words: the pages the filters keep, newest first; frontmatter tags count.
        let tagged = found(&index, "", &Filters { tag: Some("work".into()), ..Default::default() });
        assert_eq!(tagged.len(), 2);
        let hits: Vec<Hit> = index.read(|c| query::search(c, "roadmap", &Filters::default(), 5)).unwrap();
        assert!(hits[0].snippet.contains(query::MARK_OPEN) || hits[0].title_marked.contains(query::MARK_OPEN));
        finish(index, &dir);
    }

    #[test]
    fn nothing_the_user_types_can_break_the_query() {
        let dir = scratch();
        let (index, _, _) = corpus(&dir);
        for input in [
            "\"", "\"\"", "'", "*", "**", "-", "- -quarterly", "quarterly -goals", "NEAR", "NEAR(quarterly goals, 5)", "quarterly NEAR goals", "AND", "OR", "NOT quarterly",
            "(", ")", "(quarterly", "quarterly)", "((()))", "\"unbalanced quarterly", "quarterly\"", "title:quarterly", "body : goals", "{title}: x", "^quarterly", "a*b", "quart*",
            "naïve", "日本", "\u{0}", "\\", "%", "_", "col:", ":", "\"a\" \"b", "quarterly\nsearch", "😀", "; DROP TABLE pages; --", "' OR 1=1 --",
        ] {
            let result = index.read(|c| query::search(c, input, &Filters::default(), 10));
            assert!(result.is_ok(), "{input:?}: {result:?}");
        }
        let mut prefixed = all(&index, "quart*");
        prefixed.sort();
        assert_eq!(prefixed, ["nb-1:Archive/Old plan.md", "nb-1:Roadmap.md", "nb-1:log.txt", "nb-2:Notes.md"]);
        assert_eq!(all(&index, "-quarterly").len(), 4, "a dash is text, not a minus");
        assert!(all(&index, "*").is_empty());
        assert_eq!(index.read(|c| query::pages(c, None)).unwrap().len(), 6, "the table is still there");
        finish(index, &dir);
    }

    #[test]
    fn links_tags_and_unlinked_mentions() {
        let dir = scratch();
        let (index, _, _) = corpus(&dir);
        let out = index.read(|c| query::outgoing(c, "nb-1", "Roadmap.md")).unwrap();
        assert_eq!(out.iter().map(|l| (l.raw.as_str(), l.kind.as_str(), l.line)).collect::<Vec<_>>(), [("Inbox", "wiki", 3), ("Other/Notes", "wiki", 3)]);
        // Candidates for the pages whose name the links use; the resolver in the webview decides which really point there.
        let inc = index.read(|c| query::incoming(c, &["Inbox.md".to_string()], 100)).unwrap();
        assert_eq!(inc.iter().map(|l| format!("{}:{}:{}", l.notebook, l.path, l.raw)).collect::<Vec<_>>(), ["nb-1:Archive/Roadmap.md:Inbox", "nb-1:Archive/Roadmap.md:../Inbox.md", "nb-1:Roadmap.md:Inbox"]);
        assert!(inc.iter().all(|l| l.sha256.len() == 64));
        let notes = index.read(|c| query::incoming(c, &["Notes.md".to_string()], 100)).unwrap();
        assert_eq!(notes.iter().map(|l| format!("{}:{}", l.notebook, l.raw)).collect::<Vec<_>>(), ["nb-1:Other/Notes"]);
        let roadmap = index.read(|c| query::incoming(c, &["Roadmap.md".to_string()], 100)).unwrap();
        assert_eq!(roadmap.len(), 1);
        // Unlinked: Inbox mentions "Roadmap" without linking to it; Notes links it, and is in another notebook anyway.
        let unlinked = index.read(|c| query::unlinked(c, "nb-1", "Roadmap.md", 20)).unwrap();
        let mut mentioned: Vec<&str> = unlinked.iter().map(|m| m.path.as_str()).collect();
        mentioned.sort();
        assert_eq!(mentioned, ["Archive/Roadmap.md", "Inbox.md"]);
        let tags = index.read(|c| query::tags(c, None)).unwrap();
        assert_eq!(tags.iter().map(|t| (t.tag.as_str(), t.count)).collect::<Vec<_>>(), [("planning", 2), ("work", 2)]);
        assert_eq!(index.read(|c| query::tags(c, Some("nb-2"))).unwrap(), []);
        finish(index, &dir);
    }

    #[test]
    fn an_index_that_cannot_open_says_why_and_ignores_jobs() {
        let dir = scratch();
        // A file where the folder should be.
        std::fs::write(dir.join("data"), "x").unwrap();
        let index = started(&dir);
        index.sync(vec![root(&dir, "nb-1")]);
        index.flush();
        assert!(index.read(|c| query::pages(c, None)).unwrap_err().contains("not available"));
        assert!(index.status().unwrap().progress.error.is_some());
        finish(index, &dir);
    }

    /// NS-4A exit criterion: a 10,000-page notebook indexes, searches and answers backlinks quickly. Run with
    /// `cargo test --release notes_index::tests::ten_thousand -- --ignored --nocapture` for the real numbers.
    #[test]
    #[ignore = "slow: generates 10,000 pages"]
    fn ten_thousand_pages_index_search_and_backlinks_quickly() {
        let dir = scratch();
        let nb = root(&dir, "nb-big");
        let words: Vec<String> = (0..4000).map(|i| format!("word{}x{}", i % 977, i / 977)).collect();
        let mut seed = 12345u64;
        let mut next = move || {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            (seed >> 33) as usize
        };
        for i in 0..10_000 {
            let mut text = format!("---\ntags: [topic{}, area{}]\n---\n# Page number {i}\n\n", i % 50, i % 7);
            for para in 0..6 {
                for _ in 0..40 {
                    text.push_str(&words[next() % words.len()]);
                    text.push(' ');
                }
                if para % 2 == 0 {
                    text.push_str(&format!("See [[Page number {}]] and [[Folder{}/Page number {}]]. ", next() % 10_000, next() % 100, next() % 10_000));
                }
                text.push_str("\n\n");
            }
            write(&nb.path, &format!("Folder{}/Sub{}/Page number {i}.md", i % 100, i % 10), &text);
        }
        let index = started(&dir);
        let t = std::time::Instant::now();
        index.sync(vec![nb.clone()]);
        index.flush();
        let indexed = t.elapsed();
        assert_eq!(index.status().unwrap().pages, 10_000);
        let time = |label: &str, run: &dyn Fn()| {
            run();
            let t = std::time::Instant::now();
            for _ in 0..10 {
                run();
            }
            let each = t.elapsed() / 10;
            println!("{label}: {each:?}");
            each
        };
        let search = time("search 'word5x1 word77x2'", &|| {
            index.read(|c| query::search(c, "word5x1 word77x2", &Filters::default(), 20)).unwrap();
        });
        let prefix = time("search prefix 'page num'", &|| {
            index.read(|c| query::search(c, "page num", &Filters::default(), 20)).unwrap();
        });
        let rare = time("search one common word", &|| {
            index.read(|c| query::search(c, "word5x1", &Filters::default(), 20)).unwrap();
        });
        let back = time("backlinks of one page", &|| {
            index.read(|c| query::incoming(c, &["Folder5/Sub5/Page number 5505.md".to_string()], 500)).unwrap();
        });
        let unlinked = time("unlinked mentions of one page", &|| {
            index.read(|c| query::unlinked(c, "nb-big", "Folder5/Sub5/Page number 5505.md", 30)).unwrap();
        });
        let listed = time("page list", &|| {
            index.read(|c| query::pages(c, None)).unwrap();
        });
        // A restart with nothing changed.
        let t = std::time::Instant::now();
        index.sync(vec![nb.clone()]);
        index.flush();
        println!("restart scan (nothing changed): {:?}", t.elapsed());
        // One save.
        let t = std::time::Instant::now();
        write(&nb.path, "Folder5/Sub5/Page number 5505.md", "# Page number 5505\nedited");
        index.touch(nb.clone(), vec!["Folder5/Sub5/Page number 5505.md".into()]);
        index.flush();
        println!("one page re-indexed: {:?}", t.elapsed());
        println!("full index of 10,000 pages: {indexed:?}");
        for each in [search, prefix, rare, back, unlinked] {
            assert!(each < std::time::Duration::from_millis(200), "{each:?}");
        }
        let _ = listed;
        finish(index, &dir);
    }
}
