//! Notes Studio's search index (NS-4A): a derived SQLite database of the pages of every folder notebook, in app data. It
//! holds each page's title, headings, text, tags and links, and answers search, backlinks, the page list and the tag list.
//! Files stay the only source of truth: the database can be deleted at any time and is made again from them.
//!
//! One writer thread owns the write connection. It is fed by the notebook watcher (changes other programs make), by the
//! Rust commands that write notebook files (the watcher drops Hivemind's own writes), and by a scan at start and when a
//! notebook is added, which compares each file's size and time with the row it has.
//!
//! Meaning search (NS-4B) adds units and vectors to the same writer: each page is cut into units, and while Living
//! Memory's static model is installed each changed unit is embedded as the page is indexed. When the model appears or
//! changes, a pass embeds every page that lacks vectors. The vectors are searched from memory (`matrix`).
pub mod commands;
pub mod extract;
pub mod links;
mod matrix;
pub mod props;
pub mod query;
mod schema;
pub mod semantic;
pub mod structured;
pub mod units;
mod writer;

use crate::files::watch::Root;
use rusqlite::Connection;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use writer::Mode;

/// The `index-progress` event, and the state of the index.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    /// `scanning` while a scan, a rebuild or the meaning pass runs, else `idle`.
    pub state: &'static str,
    /// What `scanning` is doing: reading `pages`, or making the vectors for `meaning` search.
    pub phase: &'static str,
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
    pub semantic: semantic::Status,
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
    /// Give every page without vectors its vectors, with the model installed now.
    Embed,
    /// Answers once every job before it is done (tests).
    #[cfg_attr(not(test), allow(dead_code))]
    Barrier(Sender<()>),
}

struct Shared {
    db: PathBuf,
    progress: Mutex<Progress>,
    reader: Mutex<Option<Connection>>,
    semantic: semantic::Semantic,
    /// The notebooks as the last `sync` named them, for the meaning pass.
    roots: Mutex<Vec<Root>>,
    /// A `Job::Embed` is waiting, so another is not sent.
    embed_queued: AtomicBool,
}

/// A handle on the index; cloning it is cheap, and every clone talks to the same writer thread.
#[derive(Clone)]
pub struct Index {
    jobs: Option<Sender<Job>>,
    shared: Arc<Shared>,
}

fn idle(error: Option<String>) -> Progress {
    Progress { state: "idle", phase: "pages", done: 0, total: 0, error }
}

impl Index {
    /// Open the index database in `dir` (making it, or making it again when its version is another or it is damaged) and
    /// start the writer thread. An index that cannot be opened is still returned, reporting why in its status.
    pub fn start(dir: &Path, emit: Emit) -> Index {
        Index::start_with_idle(dir, emit, Duration::from_secs(30))
    }

    /// As `start`, with the time the model file stays open without use (tests make it short).
    pub fn start_with_idle(dir: &Path, emit: Emit, idle_after: Duration) -> Index {
        let db = dir.join("index.sqlite3");
        let shared = |error| {
            Arc::new(Shared {
                db: db.clone(),
                progress: Mutex::new(idle(error)),
                reader: Mutex::new(None),
                semantic: semantic::Semantic::new(idle_after),
                roots: Mutex::new(Vec::new()),
                embed_queued: AtomicBool::new(false),
            })
        };
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
        *self.shared.roots.lock().unwrap_or_else(|e| e.into_inner()) = roots.clone();
        self.send(Job::Sync(roots));
    }

    /// The Living Memory store whose `.models` folder holds the model meaning search reads. Meaning search starts as
    /// soon as the model is found, and stops when it goes.
    pub fn set_store(&self, root: Option<PathBuf>) {
        self.shared.semantic.set_root(root);
        self.semantic_status();
    }

    /// Where meaning search stands now. The marker is read each time, so an install or a remove shows at once, and a model
    /// that is installed but not yet in the index starts the pass that puts it there.
    pub fn semantic_status(&self) -> semantic::Status {
        let status = self.shared.semantic.status();
        match status.state {
            "missing" => self.shared.semantic.forget_pass(),
            "building" if self.jobs.is_some() && !self.shared.embed_queued.swap(true, Ordering::SeqCst) => self.send(Job::Embed),
            _ => {}
        }
        status
    }

    pub fn semantic(&self) -> &semantic::Semantic {
        &self.shared.semantic
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
        Ok(Status { pages: notebooks.iter().map(|n| n.pages).sum(), notebooks, progress, version: schema::VERSION, semantic: self.semantic_status() })
    }
}

fn run(mut conn: Connection, jobs: Receiver<Job>, shared: Arc<Shared>, emit: Emit) {
    let set = |progress: Progress| {
        *shared.progress.lock().unwrap_or_else(|e| e.into_inner()) = progress.clone();
        emit(&progress);
    };
    // The model file is let go after it has been idle; the thread wakes now and then to check.
    let poll = (shared.semantic.idle() / 4).clamp(Duration::from_millis(10), Duration::from_secs(5));
    loop {
        let job = match jobs.recv_timeout(poll) {
            Ok(job) => job,
            Err(RecvTimeoutError::Timeout) => {
                shared.semantic.release_if_idle();
                shared.semantic.matrix.release_if_idle(shared.semantic.matrix_idle());
                continue;
            }
            Err(RecvTimeoutError::Disconnected) => break,
        };
        if let Job::Barrier(done) = job {
            let _ = done.send(());
            continue;
        }
        // A page that makes an extractor panic must not stop the index for good.
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| match &job {
            Job::Sync(roots) | Job::Rebuild(roots) => {
                let (mode, prune) = if matches!(job, Job::Sync(_)) { (Mode::Scan, true) } else { (Mode::Force, false) };
                let mut report = |done, total| set(Progress { state: "scanning", phase: "pages", done, total, error: None });
                report(0, 0);
                writer::scan(&mut conn, &shared.semantic, roots, mode, prune, &mut report)
            }
            // A change reported for a notebook that was removed (or whose folder changed) after the job was queued is
            // dropped: the registry as the last `sync` named it decides, so a late save cannot bring pruned pages back.
            Job::Paths(root, rels) => {
                let current = shared.roots.lock().unwrap_or_else(|e| e.into_inner()).iter().any(|r| r.id == root.id && r.path == root.path);
                if current { writer::update(&mut conn, &shared.semantic, root, rels) } else { Ok(writer::Pass::default()) }
            }
            Job::Embed => {
                shared.embed_queued.store(false, Ordering::SeqCst);
                let roots = shared.roots.lock().unwrap_or_else(|e| e.into_inner()).clone();
                let mut report = |done, total| set(Progress { state: "scanning", phase: "meaning", done, total, error: None });
                writer::embed_pass(&mut conn, &shared.semantic, &roots, &mut report)
            }
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
    fn a_late_change_for_a_removed_notebook_does_not_bring_its_pages_back() {   // CON-1
        let dir = scratch();
        let (one, two) = (root(&dir, "nb-1"), root(&dir, "nb-2"));
        write(&one.path, "A.md", "# A\nshared");
        write(&two.path, "B.md", "# B\nshared");
        let index = started(&dir);
        index.sync(vec![one.clone(), two.clone()]);
        index.flush();
        index.sync(vec![one.clone()]);
        // A save that began before the removal reports its page after the prune, with the root it captured.
        write(&two.path, "Late.md", "# Late\nshared");
        index.touch(two.clone(), vec!["Late.md".into(), "B.md".into()]);
        index.flush();
        assert_eq!(all(&index, "shared"), ["nb-1:A.md"]);
        // The notebook added again under the same id but another folder: the old root's change is dropped too.
        let moved = Root { id: "nb-1".into(), path: dir.join("elsewhere") };
        write(&moved.path, "M.md", "# M\nshared");
        index.sync(vec![moved.clone()]);
        index.touch(one.clone(), vec!["A.md".into()]);
        index.flush();
        assert_eq!(all(&index, "shared"), ["nb-1:M.md"]);
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

    // ---- meaning search (NS-4B) ---------------------------------------------------------------------------------------

    use super::semantic::fixture;

    fn store_of(dir: &Path) -> PathBuf {
        dir.join("store")
    }

    /// Four pages whose text is one word of the tiny model each: alpha is (1,0,0,0), play (0.5,0,0.5,0), un (0,0,0,1) and
    /// "!" (0.25,0,0,0.75). Against the word "alpha" their cosines are 1, 0.71, 0 and 0.32.
    fn meaning_pages(nb: &Root) {
        write(&nb.path, "P1.md", "# P1\nalpha alpha alpha");
        write(&nb.path, "P2.md", "# P2\nplay play play");
        write(&nb.path, "P3.md", "# P3\nun un un");
        write(&nb.path, "P4.md", "# P4\n! ! !");
    }

    fn meaning(index: &Index, text: &str) -> Vec<String> {
        index.read(|c| query::search_meaning(c, index.semantic(), text, &Filters::default(), 50)).unwrap().into_iter().map(|h| format!("{}:{}", h.notebook, h.path)).collect()
    }

    fn unit_vectors(index: &Index, path: &str) -> Vec<(String, Vec<f32>)> {
        index
            .read(|c| {
                let mut stmt = c.prepare("SELECT u.heading || '|' || u.first_line, v.vec FROM units u JOIN pages p ON p.id = u.page LEFT JOIN vectors v ON v.unit = u.id WHERE p.path = ?1 ORDER BY u.ord")?;
                let rows = stmt.query_map([path], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<Vec<u8>>>(1)?)))?;
                rows.map(|r| r.map(|(name, blob)| (name, blob.map(|b| b.as_chunks::<4>().0.iter().map(|x| f32::from_le_bytes(*x)).collect()).unwrap_or_default()))).collect()
            })
            .unwrap()
    }

    #[test]
    fn without_the_model_pages_have_units_but_no_vectors_and_meaning_search_is_word_search() {
        let dir = scratch();
        let nb = root(&dir, "nb-1");
        meaning_pages(&nb);
        let index = started(&dir);
        index.set_store(Some(store_of(&dir)));
        index.sync(vec![nb.clone()]);
        index.flush();
        // A title unit and one section unit per page; nothing embedded.
        assert_eq!(unit_vectors(&index, "P1.md").iter().map(|(n, v)| (n.as_str(), v.len())).collect::<Vec<_>>(), [("|", 0), ("|alpha alpha alpha", 0)]);
        assert_eq!(meaning(&index, "alpha"), ["nb-1:P1.md"]);
        let semantic = index.status().unwrap().semantic;
        assert_eq!((semantic.state, semantic.model), ("missing", None));
        assert_eq!(index.semantic().embedded_texts(), 0);
        finish(index, &dir);
    }

    #[test]
    fn a_page_found_only_by_meaning_is_shown_from_the_floor_up_and_words_still_find_what_they_find() {
        let dir = scratch();
        let nb = root(&dir, "nb-1");
        meaning_pages(&nb);
        write(&nb.path, "P5.md", "# P5\nalpha ! ! ! ! ! ! ! !");
        fixture::install(&store_of(&dir), &fixture::rows(), "h1");
        let index = started(&dir);
        index.sync(vec![nb.clone()]);
        index.set_store(Some(store_of(&dir)));
        index.flush();
        assert_eq!(index.status().unwrap().semantic.state, "ready");
        // P1 and P5 hold the word. P2 (cosine 0.71) is found by meaning alone; P4 (0.32) is under the 0.45 floor and P3
        // (0) is unrelated, so neither shows. P5's cosine is 0.447 and it stays, because the word found it.
        let found = meaning(&index, "alpha");
        assert_eq!(found[0], "nb-1:P1.md");
        let mut rest = found[1..].to_vec();
        rest.sort();
        assert_eq!(rest, ["nb-1:P2.md", "nb-1:P5.md"]);
        // Without meaning the same query finds the two pages that hold the word.
        assert_eq!(all(&index, "alpha"), ["nb-1:P1.md", "nb-1:P5.md"]);
        // The snippet of a page found by meaning is its unit's first line, and its title carries no marks.
        let hits = index.read(|c| query::search_meaning(c, index.semantic(), "alpha", &Filters::default(), 50)).unwrap();
        let p2 = hits.iter().find(|h| h.path == "P2.md").unwrap();
        assert_eq!((p2.snippet.as_str(), p2.title_marked.as_str()), ("play play play", "P2"));
        // The filters apply to meaning too.
        let narrowed = index.read(|c| query::search_meaning(c, index.semantic(), "alpha", &Filters { folder: Some("Nowhere".into()), ..Default::default() }, 50)).unwrap();
        assert!(narrowed.is_empty());
        let only_p2 = index.read(|c| query::search_meaning(c, index.semantic(), "alpha", &Filters { kind: Some("md".into()), notebook: Some("nb-1".into()), ..Default::default() }, 1)).unwrap();
        assert_eq!(only_p2.len(), 1, "the limit applies");
        // Words the model does not know give word search.
        assert_eq!(meaning(&index, "zzz"), all(&index, "zzz"));
        finish(index, &dir);
    }

    #[test]
    fn the_matrix_follows_saves_and_deletes_without_a_restart() {
        let dir = scratch();
        let nb = root(&dir, "nb-1");
        meaning_pages(&nb);
        fixture::install(&store_of(&dir), &fixture::rows(), "h1");
        let index = started(&dir);
        index.set_store(Some(store_of(&dir)));
        index.sync(vec![nb.clone()]);
        index.flush();
        assert_eq!(meaning(&index, "alpha"), ["nb-1:P1.md", "nb-1:P2.md"]);
        // P3 now says "play": the next search finds it by meaning.
        write(&nb.path, "P3.md", "# P3\nplay play play");
        index.touch(nb.clone(), vec!["P3.md".into()]);
        index.flush();
        let mut found = meaning(&index, "alpha");
        found.sort();
        assert_eq!(found, ["nb-1:P1.md", "nb-1:P2.md", "nb-1:P3.md"]);
        // P2 is deleted: gone from the matrix too.
        std::fs::remove_file(nb.path.join("P2.md")).unwrap();
        index.touch(nb.clone(), vec!["P2.md".into()]);
        index.flush();
        let mut found = meaning(&index, "alpha");
        found.sort();
        assert_eq!(found, ["nb-1:P1.md", "nb-1:P3.md"]);
        finish(index, &dir);
    }

    #[test]
    fn a_tie_between_the_two_rankings_keeps_the_order_of_the_words() {
        // Both pages hold the word. By words X wins (a word that starts its title: "Alphabet", which the model does not
        // know); by meaning Y does (cosine 1 against 0.61). 1/61 + 1/62 either way, so the words decide.
        let dir = scratch();
        let nb = root(&dir, "nb-1");
        write(&nb.path, "X.md", "# Alphabet\n! ! ! alpha");
        write(&nb.path, "Y.md", "# Y\nalpha alpha alpha");
        fixture::install(&store_of(&dir), &fixture::rows(), "h1");
        let index = started(&dir);
        index.set_store(Some(store_of(&dir)));
        index.sync(vec![nb.clone()]);
        index.flush();
        assert_eq!(all(&index, "alpha"), ["nb-1:X.md", "nb-1:Y.md"]);
        assert_eq!(meaning(&index, "alpha"), ["nb-1:X.md", "nb-1:Y.md"]);
        // A third page, second in both lists.
        write(&nb.path, "C.md", "# Alphabet two\nalpha alpha alpha");
        index.touch(nb.clone(), vec!["C.md".into()]);
        index.flush();
        // C is second by words and second by meaning (tied with Y at cosine 1): 1/62 + 1/62 is less than the 1/61 + 1/63 of X
        // (first by words, third by meaning) and of Y (third by words, first by meaning), which tie and keep the word order.
        assert_eq!(all(&index, "alpha"), ["nb-1:X.md", "nb-1:C.md", "nb-1:Y.md"]);
        assert_eq!(meaning(&index, "alpha"), ["nb-1:X.md", "nb-1:Y.md", "nb-1:C.md"]);
        finish(index, &dir);
    }

    #[test]
    fn related_pages_are_the_nearest_others_at_or_above_the_floor() {
        let dir = scratch();
        let nb = root(&dir, "nb-1");
        meaning_pages(&nb);
        fixture::install(&store_of(&dir), &fixture::rows(), "h1");
        let index = started(&dir);
        index.set_store(Some(store_of(&dir)));
        index.sync(vec![nb.clone()]);
        index.flush();
        let related = |path: &str| index.read(|c| query::related(c, index.semantic(), "nb-1", path, 5)).unwrap().into_iter().map(|h| h.path).collect::<Vec<_>>();
        // P1 is "alpha": P2 (0.71) is near, P4 (0.32) is under the floor, P3 (0) is unrelated, and P1 is not its own relation.
        assert_eq!(related("P1.md"), ["P2.md"]);
        // P3 is "un" (0,0,0,1): P4 is near it (0.95), the others are not.
        assert_eq!(related("P3.md"), ["P4.md"]);
        assert_eq!(related("Missing.md"), Vec::<String>::new());
        let hits = index.read(|c| query::related(c, index.semantic(), "nb-1", "P1.md", 5)).unwrap();
        assert_eq!(hits[0].snippet, "play play play");
        // Without the model there is nothing to say.
        fixture::remove(&store_of(&dir));
        assert!(related("P1.md").is_empty());
        finish(index, &dir);
    }

    /// A junction at `link` to `target`; false when this machine cannot make one (the test then does nothing).
    fn junction(link: &Path, target: &Path) -> bool {
        std::process::Command::new("cmd").args(["/d", "/c", "mklink", "/J"]).arg(link).arg(target).output().map(|o| o.status.success()).unwrap_or(false)
    }

    #[test]
    fn the_index_does_not_read_a_page_the_editor_would_refuse() {   // PATH-1
        use crate::files::guard::Protected;
        let dir = scratch();
        let nb = root(&dir, "nb-1");
        write(&nb.path, "Open.md", "# Open\nvisible");
        write(&nb.path, "Inside/Doc.md", "# Doc\nvisible");
        let index = started(&dir);
        // The store now lies inside the notebook (it was moved there after the notebook was registered): its files are
        // not read, and what was read before goes.
        index.set_store(Some(dir.join("store")));
        index.sync(vec![nb.clone()]);
        index.flush();
        let mut both = all(&index, "visible");
        both.sort();
        assert_eq!(both, ["nb-1:Inside/Doc.md", "nb-1:Open.md"]);
        index.set_store(Some(nb.path.join("Inside")));
        write(&nb.path, "Inside/Doc.md", "# Doc\nvisible, changed");
        index.touch(nb.clone(), vec!["Inside/Doc.md".into()]);
        index.flush();
        assert_eq!(all(&index, "visible"), ["nb-1:Open.md"]);
        assert!(index.status().unwrap().progress.error.is_some_and(|e| e.contains("not indexed")));
        // Related reads the page through the same rule.
        let protected = Protected::new(Some(&nb.path.join("Inside")));
        let reach = writer::Reach::new(&nb.path, &protected);
        assert!(writer::related_text(&reach, "Open.md").contains("Open"));
        assert_eq!(writer::related_text(&reach, "Inside/Doc.md"), "");
        assert_eq!(writer::related_text(&reach, "../x.md"), "");
        finish(index, &dir);
    }

    #[test]
    fn related_and_the_meaning_pass_do_not_read_through_a_link_out_of_the_notebook() {   // PATH-1
        use crate::files::guard::Protected;
        let dir = scratch();
        let nb = root(&dir, "nb-1");
        let outside = dir.join("outside");
        write(&nb.path, "Dir/P.md", "# P\nalpha alpha");
        write(&outside, "P.md", "# Secret\nzebra zebra");
        let index = started(&dir);
        index.set_store(Some(store_of(&dir)));
        index.sync(vec![nb.clone()]);
        index.flush();
        assert_eq!(all(&index, "alpha"), ["nb-1:Dir/P.md"]);
        // The folder is replaced by a junction to a folder outside the notebook, while the index holds the page.
        std::fs::remove_dir_all(nb.path.join("Dir")).unwrap();
        if !junction(&nb.path.join("Dir"), &outside) {
            eprintln!("skipped: mklink /J is not available here");
            finish(index, &dir);
            return;
        }
        let protected = Protected::new(None);
        assert_eq!(writer::related_text(&writer::Reach::new(&nb.path, &protected), "Dir/P.md"), "");
        // The model appears: the pass that gives pages their vectors would read the file through the junction.
        fixture::install(&store_of(&dir), &fixture::rows(), "h1");
        assert_eq!(index.semantic_status().state, "building");
        index.flush();
        assert!(all(&index, "zebra").is_empty(), "text from outside the notebook was indexed");
        assert!(pages(&index).is_empty(), "a page that leads out of its notebook is dropped");
        let _ = std::fs::remove_dir(nb.path.join("Dir"));
        finish(index, &dir);
    }

    #[test]
    fn a_model_that_appears_later_is_read_into_the_index_in_the_background_with_progress() {
        let dir = scratch();
        let nb = root(&dir, "nb-1");
        meaning_pages(&nb);
        let seen: Arc<Mutex<Vec<Progress>>> = Arc::default();
        let log = seen.clone();
        let index = Index::start(&dir.join("data"), Arc::new(move |p| log.lock().unwrap().push(p.clone())));
        index.sync(vec![nb.clone()]);
        index.set_store(Some(store_of(&dir)));
        index.flush();
        assert_eq!(meaning(&index, "alpha"), ["nb-1:P1.md"], "no model yet");
        // `semantic install` finishes: the next look at the model's state starts the pass.
        fixture::install(&store_of(&dir), &fixture::rows(), "h1");
        assert_eq!(index.semantic_status().state, "building");
        index.flush();
        assert_eq!(index.semantic_status().state, "ready");
        assert_eq!(meaning(&index, "alpha"), ["nb-1:P1.md", "nb-1:P2.md"]);
        let meaning_progress: Vec<(u64, u64)> = seen.lock().unwrap().iter().filter(|p| p.phase == "meaning" && p.state == "scanning").map(|p| (p.done, p.total)).collect();
        assert_eq!(meaning_progress.first(), Some(&(0, 4)));
        assert_eq!(meaning_progress.last(), Some(&(4, 4)));
        // Another look does not read the pages again.
        let before = index.semantic().embedded_texts();
        index.semantic_status();
        index.flush();
        assert_eq!(index.semantic().embedded_texts(), before);
        finish(index, &dir);
    }

    #[test]
    fn a_changed_model_drops_every_vector_and_embeds_again() {
        let dir = scratch();
        let nb = root(&dir, "nb-1");
        meaning_pages(&nb);
        fixture::install(&store_of(&dir), &fixture::rows(), "h1");
        let index = started(&dir);
        index.set_store(Some(store_of(&dir)));
        index.sync(vec![nb.clone()]);
        index.flush();
        assert_eq!(unit_vectors(&index, "P1.md")[1].1, [1.0, 0.0, 0.0, 0.0]);
        let key = |index: &Index| index.read(|c| c.query_row("SELECT value FROM meta WHERE key = 'model'", [], |r| r.get::<_, String>(0))).unwrap();
        assert_eq!(key(&index), format!("{}:h1", semantic::MODEL));
        // Another model: "alpha" is (0, 1, 0, 0) in it.
        let mut changed = fixture::rows();
        changed[1] = [0.0, 1.0, 0.0, 0.0];
        fixture::install(&store_of(&dir), &changed, "h2");
        assert_eq!(index.semantic_status().state, "building");
        index.flush();
        assert_eq!(key(&index), format!("{}:h2", semantic::MODEL));
        assert_eq!(unit_vectors(&index, "P1.md")[1].1, [0.0, 1.0, 0.0, 0.0]);
        assert_eq!(unit_vectors(&index, "P2.md")[1].1.len(), 4, "every page was embedded again");
        // A query made with the new model finds the pages the new vectors say.
        assert_eq!(meaning(&index, "alpha"), ["nb-1:P1.md"], "play is no longer near alpha");
        finish(index, &dir);
    }

    #[test]
    fn a_marker_removed_mid_run_stops_the_pass_and_the_next_one_finishes_it() {
        let dir = scratch();
        let nb = root(&dir, "nb-1");
        for i in 0..120 {
            write(&nb.path, &format!("Page{i:03}.md"), &format!("# Page{i:03}\nalpha alpha alpha"));
        }
        let store = store_of(&dir);
        let gone = Arc::new(AtomicBool::new(false));
        let (flag, at) = (gone.clone(), store.clone());
        let last = Arc::new(std::sync::atomic::AtomicU64::new(0));
        let reported = last.clone();
        let index = Index::start(&dir.join("data"), Arc::new(move |p| {
            if p.phase == "meaning" && p.state == "scanning" {
                reported.store(p.done, Ordering::SeqCst);
            }
            // After the first 50 pages of the pass, `semantic remove` runs.
            if p.phase == "meaning" && p.done >= 50 && !flag.swap(true, Ordering::SeqCst) {
                fixture::remove(&at);
            }
        }));
        index.sync(vec![nb.clone()]);
        index.set_store(Some(store.clone()));
        index.flush();
        assert_eq!(index.semantic_status().state, "missing");
        fixture::install(&store, &fixture::rows(), "h1");
        index.semantic_status();
        index.flush();
        assert!(gone.load(Ordering::SeqCst), "the marker was removed during the pass");
        assert_eq!(last.load(Ordering::SeqCst), 50, "the pass stopped at once and did not go on reading pages");
        let embedded = |index: &Index| index.read(|c| c.query_row("SELECT count(*) FROM vectors", [], |r| r.get::<_, i64>(0))).unwrap();
        let held = embedded(&index);
        assert!(held > 0 && held < 240, "some pages were embedded before the marker went: {held}");
        assert_eq!(index.semantic_status().state, "missing");
        // Searching while it is gone is word search.
        assert_eq!(meaning(&index, "alpha").len(), 50, "the limit of the helper, from 100 word matches");
        // The model comes back: the pass finishes what was left.
        fixture::install(&store, &fixture::rows(), "h1");
        assert_eq!(index.semantic_status().state, "building");
        index.flush();
        assert_eq!(index.semantic_status().state, "ready");
        assert_eq!(embedded(&index), 240, "every page has a title unit and a text unit, and unknown titles hold empty vectors");
        finish(index, &dir);
    }

    #[test]
    fn a_save_embeds_only_the_units_that_changed() {
        let dir = scratch();
        let nb = root(&dir, "nb-1");
        write(&nb.path, "Doc.md", "# Doc\n\n## One\nalpha alpha alpha\n\n## Two\nbeta beta beta\n");
        fixture::install(&store_of(&dir), &fixture::rows(), "h1");
        let index = started(&dir);
        index.set_store(Some(store_of(&dir)));
        index.sync(vec![nb.clone()]);
        index.flush();
        let before = index.semantic().embedded_texts();
        assert_eq!(before, 3, "the title and two sections");
        let first = unit_vectors(&index, "Doc.md");
        write(&nb.path, "Doc.md", "# Doc\n\n## One\nalpha alpha alpha\n\n## Two\ngamma gamma gamma\n");
        index.touch(nb.clone(), vec!["Doc.md".into()]);
        index.flush();
        assert_eq!(index.semantic().embedded_texts(), before + 1, "only the section whose text changed");
        let second = unit_vectors(&index, "Doc.md");
        assert_eq!((second[0].1.clone(), second[1].1.clone()), (first[0].1.clone(), first[1].1.clone()));
        assert_eq!(second[2].1, [0.0, 0.0, 1.0, 0.0]);
        // A save that changes nothing embeds nothing.
        index.touch(nb.clone(), vec!["Doc.md".into()]);
        index.flush();
        assert_eq!(index.semantic().embedded_texts(), before + 1);
        finish(index, &dir);
    }

    #[test]
    fn past_the_vector_budget_a_page_keeps_its_units_without_vectors() {
        let dir = scratch();
        let nb = root(&dir, "nb-1");
        meaning_pages(&nb);
        fixture::install(&store_of(&dir), &fixture::rows(), "h1");
        let index = started(&dir);
        index.set_store(Some(store_of(&dir)));
        index.flush();
        index.semantic().vectors.store(semantic::MAX_VECTORS - 1, Ordering::Relaxed);
        index.sync(vec![nb.clone()]);
        index.flush();
        assert!(index.status().unwrap().semantic.full);
        assert_eq!(unit_vectors(&index, "P1.md").iter().map(|(_, v)| v.len()).collect::<Vec<_>>(), [0, 0]);
        assert_eq!(meaning(&index, "alpha"), ["nb-1:P1.md"]);
        finish(index, &dir);
    }

    #[test]
    fn the_matrix_is_released_when_idle_and_loaded_again_by_the_next_search_with_the_saves_made_meanwhile() {
        let dir = scratch();
        let nb = root(&dir, "nb-1");
        meaning_pages(&nb);
        fixture::install(&store_of(&dir), &fixture::rows(), "h1");
        // The model is let go after 20 ms and the matrix after 400 ms.
        let index = Index::start_with_idle(&dir.join("data"), Arc::new(|_| {}), Duration::from_millis(20));
        index.set_store(Some(store_of(&dir)));
        index.sync(vec![nb.clone()]);
        index.flush();
        assert_eq!(meaning(&index, "alpha"), ["nb-1:P1.md", "nb-1:P2.md"]);
        assert!(index.semantic().matrix.size().0 > 0);
        let mut released = false;
        for _ in 0..200 {
            if index.semantic().matrix.size().0 == 0 {
                released = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(released, "the matrix is still in memory");
        // A save while it is unloaded; the next search loads everything, the save included.
        write(&nb.path, "P3.md", "# P3\nplay play play");
        index.touch(nb.clone(), vec!["P3.md".into()]);
        index.flush();
        assert_eq!(index.semantic().matrix.size().0, 0, "a save does not load it");
        let mut found = meaning(&index, "alpha");
        found.sort();
        assert_eq!(found, ["nb-1:P1.md", "nb-1:P2.md", "nb-1:P3.md"]);
        assert!(index.semantic().matrix.size().0 > 0);
        finish(index, &dir);
    }

    #[test]
    fn the_model_file_is_let_go_while_nothing_uses_it() {
        let dir = scratch();
        let nb = root(&dir, "nb-1");
        meaning_pages(&nb);
        fixture::install(&store_of(&dir), &fixture::rows(), "h1");
        let index = Index::start_with_idle(&dir.join("data"), Arc::new(|_| {}), Duration::from_millis(40));
        index.set_store(Some(store_of(&dir)));
        index.sync(vec![nb.clone()]);
        index.flush();
        assert!(index.semantic().embedded_texts() > 0);
        // The writer thread wakes every few milliseconds and lets the file go.
        let mut open = true;
        for _ in 0..100 {
            if !index.semantic().file_is_open() {
                open = false;
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(!open, "the model file is still open");
        // `semantic remove` can delete it now, and a search opens it again when it is back.
        std::fs::remove_dir_all(store_of(&dir).join(".models")).unwrap();
        fixture::install(&store_of(&dir), &fixture::rows(), "h1");
        assert_eq!(meaning(&index, "alpha"), ["nb-1:P1.md", "nb-1:P2.md"]);
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

    /// NS-4B exit criterion: meaning search over a 10,000-page notebook with the real model. Needs
    /// `HIVEMIND_TEST_MODEL_DIR` (a folder with the three model files). Run with
    /// `cargo test --release notes_index::tests::ten_thousand_pages_meaning -- --ignored --nocapture` for the real numbers.
    #[test]
    #[ignore = "slow: generates 10,000 pages and embeds them with the real model"]
    fn ten_thousand_pages_meaning_search_and_related_quickly() {
        let Ok(model) = std::env::var("HIVEMIND_TEST_MODEL_DIR") else {
            println!("skipped: HIVEMIND_TEST_MODEL_DIR is not set");
            return;
        };
        let dir = scratch();
        let store = store_of(&dir);
        let folder = store.join(".models").join(semantic::MODEL);
        std::fs::create_dir_all(&folder).unwrap();
        for name in ["config.json", "tokenizer.json", "model.safetensors"] {
            std::fs::copy(Path::new(&model).join(name), folder.join(name)).unwrap();
        }
        // Words from the model's own vocabulary, so the pages look like text to it.
        let vocab: serde_json::Value = serde_json::from_slice(&std::fs::read(folder.join("tokenizer.json")).unwrap()).unwrap();
        let mut words: Vec<&str> = vocab["model"]["vocab"].as_object().unwrap().keys().map(String::as_str).filter(|w| w.len() >= 4 && w.chars().all(|c| c.is_ascii_lowercase())).collect();
        words.sort();
        let words: Vec<&str> = words.iter().step_by((words.len() / 3000).max(1)).copied().collect();
        let nb = root(&dir, "nb-big");
        let mut seed = 987_654_321u64;
        let mut next = move || {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            (seed >> 33) as usize
        };
        for i in 0..10_000 {
            let mut text = format!("# Page number {i}\n\n");
            for section in 0..3 {
                text.push_str(&format!("## Topic {section}\n\n"));
                for _ in 0..2 {
                    for _ in 0..40 {
                        text.push_str(words[next() % words.len()]);
                        text.push(' ');
                    }
                    text.push_str("\n\n");
                }
            }
            write(&nb.path, &format!("Folder{}/Sub{}/Page number {i}.md", i % 100, i % 10), &text);
        }
        // First the pages alone, as NS-4A indexes them; then the model appears and the pass reads every page again.
        let index = started(&dir);
        index.set_store(Some(store.clone()));
        let t = std::time::Instant::now();
        index.sync(vec![nb.clone()]);
        index.flush();
        let pages_only = t.elapsed();
        assert_eq!(index.status().unwrap().pages, 10_000);
        let units: i64 = index.read(|c| c.query_row("SELECT count(*) FROM units", [], |r| r.get(0))).unwrap();
        // The model files are there but not the marker, so the model is not in use until `semantic install` writes it.
        std::fs::write(folder.join("verified.json"), r#"{"files":{"model.safetensors":"07609e5bd33aad37900b3fd62f4ec96f6daec88ca4d46b9d8b928bfababf6ea0"}}"#).unwrap();
        let t = std::time::Instant::now();
        assert_eq!(index.semantic_status().state, "building");
        index.flush();
        let embedding = t.elapsed();
        assert_eq!(index.semantic_status().state, "ready");
        let vectors: i64 = index.read(|c| c.query_row("SELECT count(*) FROM vectors WHERE length(vec) > 0", [], |r| r.get(0))).unwrap();
        println!("pages indexed without the model: {pages_only:?}");
        println!("{units} units; embedding every page (read the files again, cut, embed, store): {embedding:?}, {vectors} vectors");
        let time = |label: &str, run: &dyn Fn()| {
            let t = std::time::Instant::now();
            run();
            println!("{label}, first run: {:?}", t.elapsed());
            let t = std::time::Instant::now();
            for _ in 0..10 {
                run();
            }
            let each = t.elapsed() / 10;
            println!("{label}: {each:?}");
            each
        };
        let query = format!("{} {} {}", words[100], words[1200], words[2500]);
        let search = time("meaning search, three words (includes loading the matrix the first time)", &|| {
            index.read(|c| query::search_meaning(c, index.semantic(), &query, &Filters::default(), 20)).unwrap();
        });
        let narrowed = time("meaning search with a folder filter", &|| {
            index.read(|c| query::search_meaning(c, index.semantic(), &query, &Filters { folder: Some("Folder5".into()), ..Default::default() }, 20)).unwrap();
        });
        let related = time("related pages of one page", &|| {
            index.read(|c| query::related(c, index.semantic(), "nb-big", "Folder5/Sub5/Page number 5505.md", 5)).unwrap();
        });
        let (rows, matrix_bytes) = index.semantic().matrix.size();
        let (cached, cache_bytes) = index.semantic().cache_size();
        println!("matrix: {rows} units, {:.1} MB; row cache: {cached} rows, {:.1} MB", matrix_bytes as f64 / 1e6, cache_bytes as f64 / 1e6);
        // One save embeds only the changed section.
        let t = std::time::Instant::now();
        write(&nb.path, "Folder5/Sub5/Page number 5505.md", "# Page number 5505\n\n## Topic 0\n\nsomething entirely different about gardens and weather today\n");
        index.touch(nb.clone(), vec!["Folder5/Sub5/Page number 5505.md".into()]);
        index.flush();
        println!("one saved page indexed and embedded: {:?}", t.elapsed());
        let t = std::time::Instant::now();
        index.read(|c| query::search_meaning(c, index.semantic(), &query, &Filters::default(), 20)).unwrap();
        println!("the first search after a save (one page read again into the matrix): {:?}", t.elapsed());
        if !cfg!(debug_assertions) {
            for each in [search, narrowed, related] {
                assert!(each < Duration::from_millis(200), "{each:?}");
            }
        }
        finish(index, &dir);
    }
    // ---- NS-7B: tasks, properties and queries -----------------------------------------------------------------------

    fn tasks_of(index: &Index, filters: structured::TaskFilters) -> Vec<String> {
        index.read(|c| structured::tasks(c, &filters)).unwrap().into_iter().map(|t| format!("{}:{}:{}:{}{}", t.path, t.line, if t.done { "x" } else { " " }, t.text, t.due.map(|d| format!("|{d}")).unwrap_or_default())).collect()
    }

    fn asked(index: &Index, query: &str) -> Vec<String> {
        let q: structured::Query = serde_json::from_str(query).unwrap();
        index.read(|c| structured::run(c, &q)).unwrap().into_iter().map(|r| format!("{}:{}", r.notebook, r.path)).collect()
    }

    #[test]
    fn tasks_and_properties_are_indexed_with_the_page_and_follow_its_edits() {
        let dir = scratch();
        let nb = root(&dir, "nb-1");
        write(&nb.path, "Plan.md", "---\ntitle: Plan\nstatus: active\ntags: [a, b]\n---\n# Plan\n- [ ] open one\n- [x] done one 📅 2026-12-01\n```\n- [ ] in code\n```\n");
        write(&nb.path, "Plain.md", "# Plain\nno tasks, no frontmatter");
        write(&nb.path, "Rich.hmdoc", r#"{"schemaVersion":1,"format":"hivemind-rich","meta":{},"content":{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"- [ ] not a task here"}]}]}}"#);
        let index = started(&dir);
        index.sync(vec![nb.clone()]);
        index.flush();
        assert_eq!(tasks_of(&index, Default::default()), ["Plan.md:7: :open one", "Plan.md:8:x:done one 📅 2026-12-01|2026-12-01"]);
        let rows = index.read(|c| c.prepare("SELECT key, value FROM props ORDER BY rowid")?.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?.collect::<Result<Vec<_>, _>>()).unwrap();
        assert_eq!(rows, [("title", "Plan"), ("status", "active"), ("tags", "a"), ("tags", "b")].map(|(k, v)| (k.to_string(), v.to_string())));
        // An edit replaces the rows of that page only.
        write(&nb.path, "Plan.md", "---\nstatus: done\n---\n- [x] open one\n");
        index.touch(nb.clone(), vec!["Plan.md".into()]);
        index.flush();
        assert_eq!(tasks_of(&index, Default::default()), ["Plan.md:4:x:open one"]);
        assert_eq!(asked(&index, r#"{"where":[{"prop":"status","op":"eq","value":"done"}]}"#), ["nb-1:Plan.md"]);
        assert!(asked(&index, r#"{"where":[{"prop":"status","op":"eq","value":"active"}]}"#).is_empty());
        // A removed page takes its rows with it.
        std::fs::remove_file(nb.path.join("Plan.md")).unwrap();
        index.touch(nb.clone(), vec!["Plan.md".into()]);
        index.flush();
        assert!(tasks_of(&index, Default::default()).is_empty());
        assert_eq!(index.read(|c| c.query_row("SELECT (SELECT count(*) FROM props), (SELECT count(*) FROM tasks)", [], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)))).unwrap(), (0, 0));
        finish(index, &dir);
    }

    #[test]
    fn the_task_list_filters_by_notebook_done_and_text_and_orders_by_due_date() {
        let dir = scratch();
        let (one, two) = (root(&dir, "nb-1"), root(&dir, "nb-2"));
        write(&one.path, "A.md", "# A\n- [ ] later 📅 2027-01-01\n- [ ] no date\n- [x] finished 📅 2026-01-01\n- [ ] sooner 📅 2026-12-01\n- [ ] 100% sure_thing\n");
        write(&two.path, "B.md", "# B\n- [ ] other notebook due:: 2026-06-01\n");
        let index = started(&dir);
        index.sync(vec![one.clone(), two.clone()]);
        index.flush();
        let f = |v: serde_json::Value| tasks_of(&index, serde_json::from_value(v).unwrap());
        assert_eq!(f(serde_json::json!({ "done": false })), [
            "B.md:2: :other notebook due:: 2026-06-01|2026-06-01", "A.md:5: :sooner 📅 2026-12-01|2026-12-01", "A.md:2: :later 📅 2027-01-01|2027-01-01", "A.md:3: :no date", "A.md:6: :100% sure_thing",
        ]);
        assert_eq!(f(serde_json::json!({ "notebook": "nb-1", "done": true })), ["A.md:4:x:finished 📅 2026-01-01|2026-01-01"]);
        assert_eq!(f(serde_json::json!({ "text": "SURE_" })), ["A.md:6: :100% sure_thing"]);
        assert_eq!(f(serde_json::json!({ "text": "%" })).len(), 1, "a percent sign is text, not a pattern");
        assert_eq!(f(serde_json::json!({ "limit": 2 })).len(), 2);
        // Open tasks come before done ones.
        assert_eq!(f(serde_json::json!({})).last().unwrap(), "A.md:4:x:finished 📅 2026-01-01|2026-01-01");
        finish(index, &dir);
    }

    #[test]
    fn queries_filter_by_notebook_folder_tag_and_properties_and_sort_like_living_memory() {
        let dir = scratch();
        let (one, two) = (root(&dir, "nb-1"), root(&dir, "nb-2"));
        write(&one.path, "Projects/Alpha.md", "---\nstatus: active\npriority: 10\ndue: 2026-12-01\ntags: [work, big]\n---\n# Alpha\n");
        write(&one.path, "Projects/Beta.md", "---\nstatus: Active\npriority: 9\n---\n# Beta\n#work\n");
        write(&one.path, "Projects/Gamma.md", "---\nstatus: done\npriority: 2\ndue: 2026-01-01\n---\n# Gamma\n");
        write(&one.path, "Loose.md", "# Loose\nno properties");
        write(&two.path, "Other.md", "---\nstatus: active\npriority: 100\n---\n# Other\n");
        write(&two.path, "Projects/Deep/Epsilon.md", "---\nstatus: active\n---\n# Epsilon\n");
        let index = started(&dir);
        index.sync(vec![one.clone(), two.clone()]);
        index.flush();
        // Text comparison ignores case, and the other notebook is in the answer unless the query names one.
        assert_eq!(asked(&index, r#"{"where":[{"prop":"status","op":"eq","value":"active"}]}"#), ["nb-1:Projects/Alpha.md", "nb-1:Projects/Beta.md", "nb-2:Other.md", "nb-2:Projects/Deep/Epsilon.md"]);
        assert_eq!(asked(&index, r#"{"from":{"notebooks":["nb-2"]},"where":[{"prop":"status","op":"eq","value":"active"}]}"#), ["nb-2:Other.md", "nb-2:Projects/Deep/Epsilon.md"]);
        // A folder is its pages and those of its subfolders; its name's wildcard characters are text.
        assert_eq!(asked(&index, r#"{"from":{"folder":"Projects"}}"#), ["nb-1:Projects/Alpha.md", "nb-1:Projects/Beta.md", "nb-1:Projects/Gamma.md", "nb-2:Projects/Deep/Epsilon.md"]);
        assert!(asked(&index, r#"{"from":{"folder":"Proj%"}}"#).is_empty());
        // A tag is a frontmatter tag or a #tag of the page.
        assert_eq!(asked(&index, r##"{"from":{"tag":"#Work"}}"##), ["nb-1:Projects/Alpha.md", "nb-1:Projects/Beta.md"]);
        // Numbers compare as numbers: 10 is more than 9, though "10" < "9" as text.
        assert_eq!(asked(&index, r#"{"where":[{"prop":"priority","op":"gt","value":9}]}"#), ["nb-1:Projects/Alpha.md", "nb-2:Other.md"]);
        // Sorting: numbers by value, a page without the key last, then the next key breaks ties; descending reverses the order.
        assert_eq!(asked(&index, r#"{"sort":[{"prop":"priority","dir":"asc"}]}"#), ["nb-1:Projects/Gamma.md", "nb-1:Projects/Beta.md", "nb-1:Projects/Alpha.md", "nb-2:Other.md", "nb-1:Loose.md", "nb-2:Projects/Deep/Epsilon.md"]);
        assert_eq!(asked(&index, r#"{"sort":[{"prop":"priority","dir":"desc"}]}"#)[..4], ["nb-2:Other.md", "nb-1:Projects/Alpha.md", "nb-1:Projects/Beta.md", "nb-1:Projects/Gamma.md"]);
        assert_eq!(asked(&index, r#"{"where":[{"prop":"status","op":"exists"}],"sort":[{"prop":"status","dir":"asc"},{"prop":"priority","dir":"desc"}]}"#)[..4], ["nb-2:Other.md", "nb-1:Projects/Alpha.md", "nb-1:Projects/Beta.md", "nb-2:Projects/Deep/Epsilon.md"]);
        // Pseudo keys, missing, contains and the limit.
        assert_eq!(asked(&index, r#"{"where":[{"prop":"title","op":"contains","value":"ALP"}]}"#), ["nb-1:Projects/Alpha.md"]);
        assert_eq!(asked(&index, r#"{"where":[{"prop":"path","op":"eq","value":"other.md"}]}"#), ["nb-2:Other.md"]);
        assert_eq!(asked(&index, r#"{"where":[{"prop":"due","op":"missing"}],"from":{"notebooks":["nb-1"]}}"#), ["nb-1:Loose.md", "nb-1:Projects/Beta.md"]);
        assert_eq!(asked(&index, r#"{"limit":2}"#).len(), 2);
        // A page row carries its own properties: one value as text, several as a list.
        let q: structured::Query = serde_json::from_str(r#"{"from":{"folder":"Projects","notebooks":["nb-1"]},"where":[{"prop":"title","op":"eq","value":"alpha"}]}"#).unwrap();
        let rows = index.read(|c| structured::run(c, &q)).unwrap();
        assert_eq!(serde_json::Value::Object(rows[0].props.clone()), serde_json::json!({ "status": "active", "priority": "10", "due": "2026-12-01", "tags": ["work", "big"] }));
        assert!(!rows[0].sha256.is_empty());
        finish(index, &dir);
    }

    #[test]
    fn an_index_made_before_tasks_and_properties_is_made_again() {
        let dir = scratch();
        let db = dir.join("index.sqlite3");
        // The tables of version 2: no `tasks` and no `props`.
        {
            let conn = Connection::open(&db).unwrap();
            conn.execute_batch("CREATE TABLE pages (id INTEGER PRIMARY KEY, notebook TEXT, path TEXT, kind TEXT, title TEXT, sha256 TEXT, size INTEGER, mtime_ms INTEGER, indexed_at INTEGER);").unwrap();
            conn.pragma_update(None, "user_version", 2).unwrap();
        }
        let (conn, fresh) = schema::open(&db).unwrap();
        assert!(fresh, "the old index is dropped, so every notebook is read again");
        assert_eq!(conn.query_row("PRAGMA user_version", [], |r| r.get::<_, u32>(0)).unwrap(), schema::VERSION);
        assert_eq!(conn.query_row("SELECT count(*) FROM tasks", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
        assert_eq!(conn.query_row("SELECT count(*) FROM props", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
        drop(conn);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
