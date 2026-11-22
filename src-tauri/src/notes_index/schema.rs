//! The index database: where it lives, its tables and its version. The index is derived from the notebooks' files, so a
//! database with another version, or one that cannot be read at all, is deleted and made again.
use rusqlite::Connection;
use std::path::Path;

/// Bump when a table, a column or what an extractor stores changes: the next start drops the database and indexes again.
pub const VERSION: u32 = 3;

const TABLES: &str = "
CREATE TABLE pages (
  id INTEGER PRIMARY KEY,
  notebook TEXT NOT NULL,
  path TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL,
  indexed_at INTEGER NOT NULL,
  UNIQUE (notebook, path)
);
CREATE VIRTUAL TABLE fts USING fts5(title, headings, body, tags, tokenize = 'porter unicode61');
CREATE TABLE links (
  page INTEGER NOT NULL,
  target_raw TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  target_name TEXT NOT NULL,
  embed INTEGER NOT NULL,
  line INTEGER NOT NULL,
  context TEXT NOT NULL
);
CREATE INDEX links_page ON links (page);
CREATE INDEX links_name ON links (target_name);
CREATE TABLE tags (page INTEGER NOT NULL, tag TEXT NOT NULL);
CREATE INDEX tags_page ON tags (page);
CREATE INDEX tags_tag ON tags (tag);
CREATE TABLE tasks (
  page INTEGER NOT NULL,
  line INTEGER NOT NULL,
  done INTEGER NOT NULL,
  text TEXT NOT NULL,
  due TEXT
);
CREATE INDEX tasks_page ON tasks (page);
CREATE TABLE props (page INTEGER NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL);
CREATE INDEX props_page ON props (page);
CREATE INDEX props_key ON props (key);
CREATE TABLE units (
  id INTEGER PRIMARY KEY,
  page INTEGER NOT NULL,
  ord INTEGER NOT NULL,
  heading TEXT NOT NULL,
  first_line TEXT NOT NULL,
  sha TEXT NOT NULL
);
CREATE INDEX units_page ON units (page);
CREATE TABLE vectors (unit INTEGER PRIMARY KEY, vec BLOB NOT NULL);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
";

fn pragmas(conn: &Connection) -> rusqlite::Result<()> {
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.busy_timeout(std::time::Duration::from_secs(5))
}

fn version_of(conn: &Connection) -> rusqlite::Result<u32> {
    conn.query_row("PRAGMA user_version", [], |row| row.get(0))
}

fn remove_files(path: &Path) {
    for suffix in ["", "-wal", "-shm"] {
        let mut name = path.as_os_str().to_os_string();
        name.push(suffix);
        let _ = std::fs::remove_file(name);
    }
}

fn open_existing(path: &Path, version: u32) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    pragmas(&conn)?;
    if version_of(&conn)? != version {
        return Err(rusqlite::Error::InvalidQuery);
    }
    // A database that carries the version but lost a table (a half-made file) is as unusable as another version.
    conn.query_row("SELECT count(*) FROM pages", [], |row| row.get::<_, i64>(0))?;
    Ok(conn)
}

/// Open the database at `path` with the tables of `version`, making it first when there is none and making it again
/// when it has another version or is damaged. The second value says the database was made new.
pub fn open_versioned(path: &Path, version: u32) -> Result<(Connection, bool), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    }
    if path.exists() {
        match open_existing(path, version) {
            Ok(conn) => return Ok((conn, false)),
            Err(_) => remove_files(path),
        }
    }
    let conn = Connection::open(path).map_err(|e| format!("Could not create the search index: {e}"))?;
    pragmas(&conn).map_err(|e| format!("Could not set up the search index: {e}"))?;
    conn.execute_batch(TABLES).map_err(|e| format!("Could not create the search index tables: {e}"))?;
    conn.pragma_update(None, "user_version", version).map_err(|e| e.to_string())?;
    Ok((conn, true))
}

pub fn open(path: &Path) -> Result<(Connection, bool), String> {
    open_versioned(path, VERSION)
}

/// A second connection that only reads, for the commands.
pub fn open_reader(path: &Path) -> Result<Connection, String> {
    let conn = Connection::open(path).map_err(|e| format!("Could not open the search index: {e}"))?;
    conn.busy_timeout(std::time::Duration::from_secs(5)).map_err(|e| e.to_string())?;
    conn.pragma_update(None, "query_only", true).map_err(|e| e.to_string())?;
    Ok(conn)
}
