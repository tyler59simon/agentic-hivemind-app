//! Reading the index: search, backlinks and outgoing links, unlinked mentions, the page list and the tags.
use super::links::page_key;
use rusqlite::types::Value as Sql;
use rusqlite::{params, params_from_iter, Connection};
use serde::{Deserialize, Serialize};

/// Around a match in a title or a snippet; the webview splits on them, so page text never becomes markup.
pub const MARK_OPEN: char = '\u{1}';
pub const MARK_CLOSE: char = '\u{2}';

/// The FTS5 expression for what the user typed, or None when it holds nothing a search can use. Every word and every
/// quoted phrase becomes one quoted string, so `-`, `*`, `NEAR`, `AND`, parentheses and a stray quote are only text; the
/// last bare word also matches as a prefix, so results follow the typing.
pub fn fts_query(input: &str) -> Option<String> {
    let mut terms: Vec<(String, bool)> = Vec::new();
    let mut word = String::new();
    let mut quoted = false;
    let flush = |word: &mut String, phrase: bool, terms: &mut Vec<(String, bool)>| {
        if word.chars().any(char::is_alphanumeric) {
            terms.push((std::mem::take(word), phrase));
        } else {
            word.clear();
        }
    };
    for ch in input.chars() {
        match ch {
            '"' => {
                flush(&mut word, quoted, &mut terms);
                quoted = !quoted;
            }
            c if c.is_whitespace() && !quoted => flush(&mut word, false, &mut terms),
            c => word.push(c),
        }
    }
    flush(&mut word, quoted, &mut terms);
    let last = terms.len().checked_sub(1)?;
    let parts: Vec<String> = terms
        .iter()
        .enumerate()
        .map(|(i, (text, phrase))| {
            let star = !phrase && (i == last || text.ends_with('*'));
            let text = text.trim_end_matches('*');
            format!("\"{text}\"{}", if star { "*" } else { "" })
        })
        .collect();
    Some(parts.join(" "))
}

#[derive(Deserialize, Default, Debug, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct Filters {
    pub notebook: Option<String>,
    /// Every notebook but this one (the "Other notebooks" group).
    pub exclude_notebook: Option<String>,
    /// A folder of the notebook: its pages and those of its subfolders.
    pub folder: Option<String>,
    pub tag: Option<String>,
    /// `md`, `hmdoc`, `canvas` or `txt`.
    pub kind: Option<String>,
    pub modified_after_ms: Option<i64>,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    pub notebook: String,
    pub path: String,
    pub kind: String,
    pub title: String,
    /// The title with the matches between `MARK_OPEN` and `MARK_CLOSE`.
    pub title_marked: String,
    pub mtime_ms: i64,
    /// A few words of the page around the match, marked the same way; empty without a query.
    pub snippet: String,
}

fn like_escape(text: &str) -> String {
    text.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
}

/// Pages matching `input` (best first) under `filters`; with no query, the pages the filters keep, newest first.
pub fn search(conn: &Connection, input: &str, filters: &Filters, limit: usize) -> rusqlite::Result<Vec<Hit>> {
    let query = fts_query(input);
    if query.is_none() && !input.trim().is_empty() {
        return Ok(Vec::new());
    }
    let mut args: Vec<Sql> = Vec::new();
    let mut sql = if let Some(q) = &query {
        args.push(Sql::Text(q.clone()));
        format!(
            "SELECT p.notebook, p.path, p.kind, p.title, p.mtime_ms, highlight(fts, 0, '{MARK_OPEN}', '{MARK_CLOSE}'), snippet(fts, 2, '{MARK_OPEN}', '{MARK_CLOSE}', '…', 24) \
             FROM fts JOIN pages p ON p.id = fts.rowid WHERE fts MATCH ?1"
        )
    } else {
        "SELECT p.notebook, p.path, p.kind, p.title, p.mtime_ms, p.title, '' FROM pages p WHERE 1 = 1".to_string()
    };
    let mut add = |clause: &str, value: Sql| {
        args.push(value);
        sql.push_str(&clause.replace('?', &format!("?{}", args.len())));
    };
    if let Some(v) = &filters.notebook {
        add(" AND p.notebook = ?", Sql::Text(v.clone()));
    }
    if let Some(v) = &filters.exclude_notebook {
        add(" AND p.notebook <> ?", Sql::Text(v.clone()));
    }
    if let Some(v) = filters.folder.as_deref().map(|f| f.trim_matches('/')).filter(|f| !f.is_empty()) {
        add(" AND p.path LIKE ? ESCAPE '\\'", Sql::Text(format!("{}/%", like_escape(v))));
    }
    if let Some(v) = &filters.tag {
        add(" AND EXISTS (SELECT 1 FROM tags t WHERE t.page = p.id AND t.tag = ?)", Sql::Text(v.trim_start_matches('#').to_lowercase()));
    }
    if let Some(v) = &filters.kind {
        add(" AND p.kind = ?", Sql::Text(v.clone()));
    }
    if let Some(v) = filters.modified_after_ms {
        add(" AND p.mtime_ms >= ?", Sql::Integer(v));
    }
    sql.push_str(if query.is_some() { " ORDER BY bm25(fts, 8.0, 3.0, 1.0, 4.0), p.path" } else { " ORDER BY p.mtime_ms DESC, p.path" });
    sql.push_str(&format!(" LIMIT {}", limit.clamp(1, 200)));
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_from_iter(args), |row| {
        Ok(Hit {
            notebook: row.get(0)?,
            path: row.get(1)?,
            kind: row.get(2)?,
            title: row.get(3)?,
            mtime_ms: row.get(4)?,
            title_marked: row.get(5)?,
            snippet: row.get(6)?,
        })
    })?;
    rows.collect()
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PageRow {
    pub notebook: String,
    pub path: String,
    pub kind: String,
    pub title: String,
    pub mtime_ms: i64,
}

/// Every indexed page, or those of one notebook: for Ctrl+O and for resolving links.
pub fn pages(conn: &Connection, notebook: Option<&str>) -> rusqlite::Result<Vec<PageRow>> {
    let mut stmt = conn.prepare("SELECT notebook, path, kind, title, mtime_ms FROM pages WHERE ?1 IS NULL OR notebook = ?1 ORDER BY notebook, path")?;
    let rows = stmt.query_map(params![notebook], |r| Ok(PageRow { notebook: r.get(0)?, path: r.get(1)?, kind: r.get(2)?, title: r.get(3)?, mtime_ms: r.get(4)? }))?;
    rows.collect()
}

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct TagCount {
    pub tag: String,
    pub count: u64,
}

pub fn tags(conn: &Connection, notebook: Option<&str>) -> rusqlite::Result<Vec<TagCount>> {
    let mut stmt = conn.prepare(
        "SELECT t.tag, count(*) AS n FROM tags t JOIN pages p ON p.id = t.page WHERE ?1 IS NULL OR p.notebook = ?1 GROUP BY t.tag ORDER BY n DESC, t.tag LIMIT 1000",
    )?;
    let rows = stmt.query_map(params![notebook], |r| Ok(TagCount { tag: r.get(0)?, count: r.get::<_, i64>(1)? as u64 }))?;
    rows.collect()
}

/// A link as one page wrote it.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Outgoing {
    pub raw: String,
    pub kind: String,
    pub embed: bool,
    pub line: u32,
    pub context: String,
}

pub fn outgoing(conn: &Connection, notebook: &str, path: &str) -> rusqlite::Result<Vec<Outgoing>> {
    let mut stmt = conn.prepare(
        "SELECT l.target_raw, l.target_kind, l.embed, l.line, l.context FROM links l JOIN pages p ON p.id = l.page \
         WHERE p.notebook = ?1 AND p.path = ?2 ORDER BY l.line, l.rowid",
    )?;
    let rows = stmt.query_map(params![notebook, path], |r| Ok(Outgoing { raw: r.get(0)?, kind: r.get(1)?, embed: r.get(2)?, line: r.get(3)?, context: r.get(4)? }))?;
    rows.collect()
}

/// A link some page wrote whose target is called like a page being asked about. The index keeps the link as written;
/// whether it reaches that page is the resolver's to say (`src/features/links/resolve.ts`), so the same rules answer
/// for a link in the page, in the backlinks and in a rename's plan.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Incoming {
    pub notebook: String,
    pub path: String,
    /// The hash of the page's bytes when it was indexed: a rename's plan saves the page only while it still has it.
    pub sha256: String,
    pub raw: String,
    pub kind: String,
    pub embed: bool,
    pub line: u32,
    pub context: String,
}

/// Links whose target is named like one of `paths` (pages of any notebook).
pub fn incoming(conn: &Connection, paths: &[String], limit: usize) -> rusqlite::Result<Vec<Incoming>> {
    let mut keys: Vec<String> = paths.iter().map(|p| page_key(p)).filter(|k| !k.is_empty()).collect();
    keys.sort();
    keys.dedup();
    let mut out = Vec::new();
    for chunk in keys.chunks(400) {
        let marks = vec!["?"; chunk.len()].join(",");
        let sql = format!(
            "SELECT p.notebook, p.path, p.sha256, l.target_raw, l.target_kind, l.embed, l.line, l.context FROM links l JOIN pages p ON p.id = l.page \
             WHERE l.target_name IN ({marks}) ORDER BY p.notebook, p.path, l.line, l.rowid LIMIT {}",
            limit.saturating_sub(out.len()).max(1)
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(chunk), |r| {
            Ok(Incoming { notebook: r.get(0)?, path: r.get(1)?, sha256: r.get(2)?, raw: r.get(3)?, kind: r.get(4)?, embed: r.get(5)?, line: r.get(6)?, context: r.get(7)? })
        })?;
        for row in rows {
            out.push(row?);
        }
        if out.len() >= limit {
            break;
        }
    }
    Ok(out)
}

/// A page that names another in its text without linking to it.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Mention {
    pub notebook: String,
    pub path: String,
    pub title: String,
    pub snippet: String,
}

/// Pages of the same notebook that contain the page's name as a phrase and have no link written with that name.
pub fn unlinked(conn: &Connection, notebook: &str, path: &str, limit: usize) -> rusqlite::Result<Vec<Mention>> {
    let name = super::extract::stem(path.rsplit('/').next().unwrap_or(path));
    if name.chars().filter(|c| c.is_alphanumeric()).count() < 3 {
        return Ok(Vec::new());
    }
    let Some(phrase) = fts_query(&format!("\"{}\"", name.replace('"', " "))) else { return Ok(Vec::new()) };
    let mut stmt = conn.prepare(&format!(
        "SELECT p.notebook, p.path, p.title, snippet(fts, 2, '{MARK_OPEN}', '{MARK_CLOSE}', '…', 24) FROM fts JOIN pages p ON p.id = fts.rowid \
         WHERE fts MATCH ?1 AND p.notebook = ?2 AND p.path <> ?3 \
         AND NOT EXISTS (SELECT 1 FROM links l WHERE l.page = p.id AND l.target_name = ?4) ORDER BY bm25(fts, 8.0, 3.0, 1.0, 4.0), p.path LIMIT {}",
        limit.clamp(1, 200)
    ))?;
    let query = format!("{{body}} : {phrase}");
    let rows = stmt.query_map(params![query, notebook, path, page_key(path)], |r| Ok(Mention { notebook: r.get(0)?, path: r.get(1)?, title: r.get(2)?, snippet: r.get(3)? }))?;
    rows.collect()
}

/// How many pages each notebook has in the index.
pub fn counts(conn: &Connection) -> rusqlite::Result<Vec<(String, u64)>> {
    let mut stmt = conn.prepare("SELECT notebook, count(*) FROM pages GROUP BY notebook")?;
    let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get::<_, i64>(1)? as u64)))?;
    rows.collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn what_the_user_types_becomes_quoted_words_with_a_prefix_on_the_last() {
        assert_eq!(fts_query("plan"), Some("\"plan\"*".into()));
        assert_eq!(fts_query("  quarterly   plan "), Some("\"quarterly\" \"plan\"*".into()));
        assert_eq!(fts_query("\"exact phrase\" more"), Some("\"exact phrase\" \"more\"*".into()));
        assert_eq!(fts_query("fo* bar"), Some("\"fo\"* \"bar\"*".into()));
    }

    #[test]
    fn operators_quotes_and_punctuation_are_only_text() {
        for input in ["a-b", "NEAR(a b)", "a AND b OR c NOT d", "(unbalanced", "unbalanced)", "\"open phrase", "a:b", "x^", "col:val", "- -", "*", "\"\"", "()", "a OR"] {
            let q = fts_query(input);
            if let Some(q) = &q {
                // Everything is inside quotes: nothing but strings and prefix stars reaches FTS5.
                let outside: String = q.split('"').enumerate().filter(|(i, _)| i % 2 == 0).map(|(_, s)| s).collect();
                assert!(outside.chars().all(|c| c == ' ' || c == '*'), "{input} -> {q}");
            }
        }
        assert_eq!(fts_query("*"), None);
        assert_eq!(fts_query("- ( ) \"\""), None);
        assert_eq!(fts_query(""), None);
        assert_eq!(fts_query("NEAR"), Some("\"NEAR\"*".into()));
        assert_eq!(fts_query("\"open phrase"), Some("\"open phrase\"".into()));
        assert_eq!(fts_query("naïve 日本語"), Some("\"naïve\" \"日本語\"*".into()));
    }
}
