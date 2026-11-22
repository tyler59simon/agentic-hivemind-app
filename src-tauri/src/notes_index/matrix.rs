//! The unit vectors of every page, held in memory for meaning search (NS-4B): one flat array of f32 rows, loaded from
//! SQLite on the first search and kept in step with what the writer thread stores. A query is scored against every row
//! by dot product (the vectors have unit length, so that is the cosine), and a page counts by its best unit.
//!
//! The writer never touches the matrix while it writes. After a transaction commits it names the pages it changed
//! (`stage` while it works, `publish` once the commit is done), and the next search reads those pages again from the
//! database. A search never sees a page half way, and a page named twice is read once.
//!
//! The matrix is memory Hivemind does not need while nobody searches: `release_if_idle` empties it after a while, and the
//! next search or Related query loads it again from SQLite, which the writer keeps current whether or not it is loaded.
use rusqlite::{params, Connection};
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Past this many changed pages the whole matrix is read again, which is cheaper than finding each page's rows.
const RELOAD_OVER: usize = 64;

#[derive(Default)]
struct Pages {
    pages: HashSet<i64>,
    /// Every row may have changed (another model, or a rebuild): read them all.
    reset: bool,
}

#[derive(Default)]
struct State {
    loaded: bool,
    dim: usize,
    /// `unit.len()` rows of `dim` values each.
    data: Vec<f32>,
    unit: Vec<i64>,
    page: Vec<i64>,
    /// The model the vectors came from, as `meta` records it.
    model: Option<String>,
}

#[derive(Default)]
pub struct Matrix {
    state: Mutex<State>,
    staged: Mutex<Pages>,
    changed: Mutex<Pages>,
    /// When a search or a Related query last used the matrix.
    used: Mutex<Option<Instant>>,
}

/// One page's best match.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Best {
    pub page: i64,
    pub cosine: f32,
    pub unit: i64,
}

/// The dot product of two vectors of one length, in eight lanes so the compiler can use SIMD.
pub fn dot(a: &[f32], b: &[f32]) -> f32 {
    let mut lanes = [0f32; 8];
    let ((ac, a_rest), (bc, b_rest)) = (a.as_chunks::<8>(), b.as_chunks::<8>());
    let tail: f32 = a_rest.iter().zip(b_rest).map(|(x, y)| x * y).sum();
    for (x, y) in ac.iter().zip(bc) {
        for i in 0..8 {
            lanes[i] += x[i] * y[i];
        }
    }
    lanes.iter().sum::<f32>() + tail
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

pub fn to_blob(vector: &[f32]) -> Vec<u8> {
    vector.iter().flat_map(|v| v.to_le_bytes()).collect()
}

fn from_blob(blob: &[u8]) -> Vec<f32> {
    blob.as_chunks::<4>().0.iter().map(|b| f32::from_le_bytes(*b)).collect()
}

impl State {
    fn push(&mut self, unit: i64, page: i64, blob: &[u8]) {
        // An empty vector marks a unit with nothing the model knows; a row of another length is from another model.
        if blob.is_empty() || !blob.len().is_multiple_of(4) {
            return;
        }
        let dim = blob.len() / 4;
        if self.dim == 0 {
            self.dim = dim;
        }
        if dim != self.dim {
            return;
        }
        self.data.extend(from_blob(blob));
        self.unit.push(unit);
        self.page.push(page);
    }

    fn remove_page(&mut self, page: i64) {
        let mut at = 0;
        while at < self.page.len() {
            if self.page[at] == page {
                let last = self.page.len() - 1;
                if at != last {
                    let (a, b) = (at * self.dim, last * self.dim);
                    for i in 0..self.dim {
                        self.data.swap(a + i, b + i);
                    }
                }
                self.data.truncate(last * self.dim);
                self.page.swap_remove(at);
                self.unit.swap_remove(at);
            } else {
                at += 1;
            }
        }
    }

    fn read_all(&mut self, conn: &Connection) -> rusqlite::Result<()> {
        *self = State { loaded: true, ..State::default() };
        self.model = conn.query_row("SELECT value FROM meta WHERE key = 'model'", [], |r| r.get(0)).ok();
        let mut stmt = conn.prepare("SELECT v.unit, u.page, v.vec FROM vectors v JOIN units u ON u.id = v.unit")?;
        let mut rows = stmt.query([])?;
        while let Some(row) = rows.next()? {
            self.push(row.get(0)?, row.get(1)?, row.get_ref(2)?.as_blob()?);
        }
        Ok(())
    }

    fn read_page(&mut self, conn: &Connection, page: i64) -> rusqlite::Result<()> {
        self.remove_page(page);
        let mut stmt = conn.prepare_cached("SELECT v.unit, v.vec FROM units u JOIN vectors v ON v.unit = u.id WHERE u.page = ?1")?;
        let mut rows = stmt.query(params![page])?;
        while let Some(row) = rows.next()? {
            self.push(row.get(0)?, page, row.get_ref(1)?.as_blob()?);
        }
        Ok(())
    }
}

impl Matrix {
    /// Writer thread: this page's rows changed or are gone (once the transaction commits, `publish`).
    pub fn stage(&self, page: i64) {
        lock(&self.staged).pages.insert(page);
    }

    /// Writer thread: every row may have changed.
    pub fn stage_reset(&self) {
        lock(&self.staged).reset = true;
    }

    /// Writer thread: what was staged is committed; the next search reads it.
    pub fn publish(&self) {
        let staged = std::mem::take(&mut *lock(&self.staged));
        if staged.pages.is_empty() && !staged.reset {
            return;
        }
        let mut changed = lock(&self.changed);
        changed.pages.extend(staged.pages);
        changed.reset |= staged.reset;
    }

    /// Bring the matrix up to date with the database: load it on first use, read the pages the writer changed again.
    pub fn sync(&self, conn: &Connection) -> rusqlite::Result<()> {
        let mut state = lock(&self.state);
        *lock(&self.used) = Some(Instant::now());
        // Taken before the database is read, so everything in it was committed before this call looked.
        let changed = std::mem::take(&mut *lock(&self.changed));
        if !state.loaded || changed.reset || changed.pages.len() > RELOAD_OVER {
            return state.read_all(conn);
        }
        if changed.pages.is_empty() {
            return Ok(());
        }
        state.model = conn.query_row("SELECT value FROM meta WHERE key = 'model'", [], |r| r.get(0)).ok();
        for page in changed.pages {
            state.read_page(conn, page)?;
        }
        Ok(())
    }

    /// Empty the matrix when nothing has used it for `idle`. The pages the writer changed since are forgotten too: the next
    /// load reads everything. Returns whether it was released.
    pub fn release_if_idle(&self, idle: Duration) -> bool {
        let mut state = lock(&self.state);
        if !state.loaded || lock(&self.used).is_none_or(|at| at.elapsed() < idle) {
            return false;
        }
        *state = State::default();
        *lock(&self.changed) = Pages::default();
        true
    }

    /// The model the vectors in the matrix came from.
    pub fn model(&self) -> Option<String> {
        lock(&self.state).model.clone()
    }

    /// Units in the matrix and the bytes they take.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn size(&self) -> (usize, usize) {
        let state = lock(&self.state);
        (state.unit.len(), state.data.len() * 4 + (state.unit.len() + state.page.len()) * 8)
    }

    /// Every page with a unit near `query`, by its best unit; `keep` says which pages count.
    pub fn best_per_page(&self, query: &[f32], keep: impl Fn(i64) -> bool) -> Vec<Best> {
        let state = lock(&self.state);
        if state.dim == 0 || query.len() != state.dim {
            return Vec::new();
        }
        let mut best: HashMap<i64, Best> = HashMap::new();
        for (i, row) in state.data.chunks_exact(state.dim).enumerate() {
            let page = state.page[i];
            if !keep(page) {
                continue;
            }
            let cosine = dot(query, row);
            let entry = best.entry(page).or_insert(Best { page, cosine, unit: state.unit[i] });
            if cosine > entry.cosine {
                *entry = Best { page, cosine, unit: state.unit[i] };
            }
        }
        best.into_values().collect()
    }

    /// The mean of a page's unit vectors at unit length, or None for a page with no vector.
    pub fn page_vector(&self, page: i64) -> Option<Vec<f32>> {
        let state = lock(&self.state);
        let mut total = vec![0f64; state.dim];
        let mut count = 0;
        for (i, row) in state.data.chunks_exact(state.dim.max(1)).enumerate() {
            if state.page[i] == page {
                for (t, v) in total.iter_mut().zip(row) {
                    *t += *v as f64;
                }
                count += 1;
            }
        }
        let norm = total.iter().map(|v| v * v).sum::<f64>().sqrt();
        (count > 0 && norm > 0.0).then(|| total.iter().map(|v| (v / norm) as f32).collect())
    }
}

/// Best matches first; equal cosines in page order, so a ranking never changes between two runs.
pub fn ranked(mut best: Vec<Best>) -> Vec<Best> {
    best.sort_by(|a, b| b.cosine.total_cmp(&a.cosine).then(a.page.cmp(&b.page)));
    best
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE units (id INTEGER PRIMARY KEY, page INTEGER NOT NULL);
             CREATE TABLE vectors (unit INTEGER PRIMARY KEY, vec BLOB NOT NULL);
             CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
        )
        .unwrap();
        conn
    }

    fn put(conn: &Connection, unit: i64, page: i64, vector: &[f32]) {
        conn.execute("INSERT OR REPLACE INTO units (id, page) VALUES (?1, ?2)", params![unit, page]).unwrap();
        conn.execute("INSERT OR REPLACE INTO vectors (unit, vec) VALUES (?1, ?2)", params![unit, to_blob(vector)]).unwrap();
    }

    fn pages(best: Vec<Best>) -> Vec<(i64, i64)> {
        ranked(best).into_iter().map(|b| (b.page, b.unit)).collect()
    }

    #[test]
    fn the_dot_product_matches_the_plain_sum_for_any_length() {
        for n in [0, 1, 7, 8, 9, 16, 31, 512] {
            let a: Vec<f32> = (0..n).map(|i| (i as f32).sin()).collect();
            let b: Vec<f32> = (0..n).map(|i| (i as f32 * 0.5).cos()).collect();
            let plain: f32 = a.iter().zip(&b).map(|(x, y)| x * y).sum();
            assert!((dot(&a, &b) - plain).abs() < 1e-3, "{n}");
        }
    }

    #[test]
    fn a_page_scores_by_its_best_unit_and_empty_vectors_are_left_out() {
        let c = conn();
        put(&c, 1, 10, &[1.0, 0.0]);
        put(&c, 2, 10, &[0.0, 1.0]);
        put(&c, 3, 20, &[0.6, 0.8]);
        c.execute("INSERT INTO units (id, page) VALUES (4, 30)", []).unwrap();
        c.execute("INSERT INTO vectors (unit, vec) VALUES (4, x'')", []).unwrap();
        let m = Matrix::default();
        m.sync(&c).unwrap();
        assert_eq!(m.size().0, 3);
        let best = ranked(m.best_per_page(&[0.0, 1.0], |_| true));
        assert_eq!(best.iter().map(|b| (b.page, b.unit)).collect::<Vec<_>>(), [(10, 2), (20, 3)]);
        assert!((best[1].cosine - 0.8).abs() < 1e-6);
        // `keep` narrows the pages; a query of another length (another model) finds nothing.
        assert_eq!(pages(m.best_per_page(&[0.0, 1.0], |p| p == 20)), [(20, 3)]);
        assert!(m.best_per_page(&[1.0, 0.0, 0.0], |_| true).is_empty());
    }

    #[test]
    fn changes_reach_the_matrix_only_after_they_are_published_and_a_page_is_read_again_whole() {
        let c = conn();
        put(&c, 1, 10, &[1.0, 0.0]);
        put(&c, 2, 20, &[0.0, 1.0]);
        let m = Matrix::default();
        m.sync(&c).unwrap();
        // The writer replaced page 10's units and has not committed: a search keeps what it had.
        put(&c, 3, 10, &[0.0, 1.0]);
        c.execute("DELETE FROM vectors WHERE unit = 1", []).unwrap();
        c.execute("DELETE FROM units WHERE id = 1", []).unwrap();
        m.stage(10);
        m.sync(&c).unwrap();
        assert_eq!(pages(m.best_per_page(&[1.0, 0.0], |_| true)), [(10, 1), (20, 2)]);
        m.publish();
        m.sync(&c).unwrap();
        assert_eq!(pages(m.best_per_page(&[1.0, 0.0], |_| true)), [(10, 3), (20, 2)]);
        assert_eq!(m.size().0, 2);
        // A page that is gone leaves no rows.
        c.execute("DELETE FROM units WHERE page = 20", []).unwrap();
        c.execute("DELETE FROM vectors WHERE unit = 2", []).unwrap();
        m.stage(20);
        m.publish();
        m.sync(&c).unwrap();
        assert_eq!(pages(m.best_per_page(&[0.0, 1.0], |_| true)), [(10, 3)]);
        assert_eq!(m.size().0, 1);
    }

    #[test]
    fn removing_a_page_from_the_middle_keeps_every_other_row_whole() {
        let c = conn();
        for page in 1..=5i64 {
            for k in 0..3 {
                put(&c, page * 10 + k, page, &[page as f32, k as f32, 1.0]);
            }
        }
        let m = Matrix::default();
        m.sync(&c).unwrap();
        let mut at_start: Vec<_> = (1..=5).map(|p| pages(m.best_per_page(&[0.0, 1.0, 0.0], |x| x == p))).collect();
        c.execute("DELETE FROM vectors WHERE unit / 10 = 2", []).unwrap();
        c.execute("DELETE FROM units WHERE page = 2", []).unwrap();
        m.stage(2);
        m.publish();
        m.sync(&c).unwrap();
        assert_eq!(m.size().0, 12);
        at_start.remove(1);
        let after: Vec<_> = [1, 3, 4, 5].iter().map(|p| pages(m.best_per_page(&[0.0, 1.0, 0.0], |x| x == *p))).collect();
        assert_eq!(after, at_start);
        assert!(m.best_per_page(&[0.0, 1.0, 0.0], |x| x == 2).is_empty());
    }

    #[test]
    fn a_reset_or_many_changed_pages_read_everything_again_and_the_model_is_remembered() {
        let c = conn();
        put(&c, 1, 10, &[1.0, 0.0]);
        c.execute("INSERT INTO meta VALUES ('model', 'a:1')", []).unwrap();
        let m = Matrix::default();
        m.sync(&c).unwrap();
        assert_eq!(m.model().as_deref(), Some("a:1"));
        c.execute("DELETE FROM vectors", []).unwrap();
        c.execute("UPDATE meta SET value = 'b:2'", []).unwrap();
        put(&c, 5, 50, &[0.0, 1.0]);
        m.stage_reset();
        m.publish();
        m.sync(&c).unwrap();
        assert_eq!((m.model().as_deref(), m.size().0), (Some("b:2"), 1));
        for page in 100..100 + RELOAD_OVER as i64 + 5 {
            put(&c, page, page, &[1.0, 0.0]);
            m.stage(page);
        }
        m.publish();
        m.sync(&c).unwrap();
        assert_eq!(m.size().0, 1 + RELOAD_OVER + 5);
    }

    #[test]
    fn an_idle_matrix_is_released_and_loads_again_with_what_the_writer_did_meanwhile() {
        let c = conn();
        put(&c, 1, 10, &[1.0, 0.0]);
        c.execute("INSERT INTO meta VALUES ('model', 'a:1')", []).unwrap();
        let m = Matrix::default();
        assert!(!m.release_if_idle(Duration::ZERO), "nothing loaded yet");
        m.sync(&c).unwrap();
        assert_eq!(m.size().0, 1);
        assert!(!m.release_if_idle(Duration::from_secs(3600)), "used a moment ago");
        assert_eq!(m.size().0, 1);
        std::thread::sleep(Duration::from_millis(20));
        assert!(m.release_if_idle(Duration::from_millis(10)));
        assert_eq!((m.size().0, m.model()), (0, None));
        assert!(m.best_per_page(&[1.0, 0.0], |_| true).is_empty());
        assert!(!m.release_if_idle(Duration::ZERO), "already released");
        // The writer changes pages while it is unloaded: the next use sees them all.
        put(&c, 2, 20, &[0.0, 1.0]);
        c.execute("DELETE FROM vectors WHERE unit = 1", []).unwrap();
        c.execute("DELETE FROM units WHERE id = 1", []).unwrap();
        m.stage(10);
        m.stage(20);
        m.publish();
        m.sync(&c).unwrap();
        assert_eq!(pages(m.best_per_page(&[0.0, 1.0], |_| true)), [(20, 2)]);
        assert_eq!(m.model().as_deref(), Some("a:1"));
        // After the load nothing stale is left to apply a second time.
        m.sync(&c).unwrap();
        assert_eq!(m.size().0, 1);
    }

    #[test]
    fn a_pages_vector_is_the_mean_of_its_units_at_unit_length() {
        let c = conn();
        put(&c, 1, 10, &[1.0, 0.0]);
        put(&c, 2, 10, &[0.0, 1.0]);
        put(&c, 3, 20, &[1.0, 0.0]);
        let m = Matrix::default();
        m.sync(&c).unwrap();
        let v = m.page_vector(10).unwrap();
        let k = (0.5f32).sqrt();
        assert!((v[0] - k).abs() < 1e-6 && (v[1] - k).abs() < 1e-6);
        assert!(m.page_vector(99).is_none());
    }
}
