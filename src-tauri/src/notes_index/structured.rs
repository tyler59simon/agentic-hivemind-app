//! Reading the tasks and properties tables (NS-7B): the Tasks list, and the saved queries of the Notes page. A query is
//! evaluated here over the folder notebooks' pages with the rules of Living Memory's `doc query`
//! (`core/docs_index.py`, `_matches` and `query`), so one query reads the same over both kinds of notebook: every condition
//! must hold, a property with several values holds when any value does, comparisons are numeric when both sides are numbers
//! and by lower-case text otherwise, and a page without the sort key comes last.
use rusqlite::types::Value as Sql;
use rusqlite::{params_from_iter, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::cmp::Ordering;
use std::collections::HashMap;

/// The most pages a query returns, and the most tasks the Tasks list reads.
pub const MAX_ROWS: usize = 1000;
pub const MAX_TASKS: usize = 5000;
/// Conditions and sort keys one query may have (Living Memory's limits are 20 and 5).
pub const MAX_WHERE: usize = 10;
pub const MAX_SORT: usize = 5;

fn like_escape(text: &str) -> String {
    text.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
}

// ---- tasks ---------------------------------------------------------------------------------------------------------

#[derive(Deserialize, Default, Debug, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct TaskFilters {
    pub notebook: Option<String>,
    /// `Some(false)` for open tasks only, `Some(true)` for done ones only.
    pub done: Option<bool>,
    /// Pages and tasks whose text holds this, ignoring case.
    pub text: Option<String>,
    pub limit: Option<usize>,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TaskRow {
    pub notebook: String,
    pub path: String,
    pub title: String,
    pub line: u32,
    pub done: bool,
    pub text: String,
    pub due: Option<String>,
    pub owner: Option<String>,
    pub priority: Option<String>,
    /// The hash of the page when it was indexed: a write checks it against the file.
    pub sha256: String,
}

/// The tasks of the indexed pages, open before done, then by due date (those with none last), notebook, page and line: the
/// order of Living Memory's `doc tasks`.
pub fn tasks(conn: &Connection, filters: &TaskFilters) -> rusqlite::Result<Vec<TaskRow>> {
    let mut sql = String::from("SELECT p.notebook, p.path, p.title, t.line, t.done, t.text, t.due, t.owner, t.priority, p.sha256 FROM tasks t JOIN pages p ON p.id = t.page WHERE 1 = 1");
    let mut args: Vec<Sql> = Vec::new();
    if let Some(v) = &filters.notebook {
        args.push(Sql::Text(v.clone()));
        sql.push_str(&format!(" AND p.notebook = ?{}", args.len()));
    }
    if let Some(done) = filters.done {
        sql.push_str(if done { " AND t.done = 1" } else { " AND t.done = 0" });
    }
    if let Some(text) = filters.text.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
        args.push(Sql::Text(format!("%{}%", like_escape(text))));
        sql.push_str(&format!(" AND (t.text LIKE ?{0} ESCAPE '\\' OR p.title LIKE ?{0} ESCAPE '\\')", args.len()));
    }
    sql.push_str(&format!(" ORDER BY t.done, t.due IS NULL, t.due, p.notebook, p.path, t.line LIMIT {}", filters.limit.unwrap_or(MAX_TASKS).clamp(1, MAX_TASKS)));
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_from_iter(args), |r| {
        Ok(TaskRow { notebook: r.get(0)?, path: r.get(1)?, title: r.get(2)?, line: r.get(3)?, done: r.get(4)?, text: r.get(5)?, due: r.get(6)?, owner: r.get(7)?, priority: r.get(8)?, sha256: r.get(9)? })
    })?;
    rows.collect()
}

// ---- queries -------------------------------------------------------------------------------------------------------

#[derive(Deserialize, Default, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Source {
    /// Folder notebook ids; none means every one.
    pub notebooks: Vec<String>,
    /// A folder of the notebook: its pages and those of its subfolders.
    pub folder: Option<String>,
    pub tag: Option<String>,
}

#[derive(Deserialize, Debug, Clone, PartialEq)]
pub struct Cond {
    /// A frontmatter key, or one of the pseudo keys `title`, `path` and `notebook`.
    pub prop: String,
    /// `eq`, `ne`, `lt`, `le`, `gt`, `ge`, `contains`, `exists` or `missing`.
    pub op: String,
    #[serde(default)]
    pub value: Value,
}

#[derive(Deserialize, Debug, Clone, PartialEq)]
pub struct SortKey {
    pub prop: String,
    #[serde(default)]
    pub dir: String,
}

/// What the evaluator needs of a saved query (the webview keeps the rest: view, columns, grouping).
#[derive(Deserialize, Default, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Query {
    pub from: Source,
    pub r#where: Vec<Cond>,
    pub sort: Vec<SortKey>,
    pub limit: Option<usize>,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QueryRow {
    pub notebook: String,
    pub path: String,
    pub title: String,
    /// The hash of the page when it was indexed: a write checks it against the file.
    pub sha256: String,
    pub mtime_ms: i64,
    /// The page's own properties: the value of a key with one value, the list of a key with several.
    pub props: serde_json::Map<String, Value>,
}

const OPS: [&str; 9] = ["eq", "ne", "lt", "le", "gt", "ge", "contains", "exists", "missing"];

fn number(text: &str) -> Option<f64> {
    text.trim().parse::<f64>().ok()
}

/// The text a condition's value stands for.
fn want_text(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

/// `_matches` of Living Memory: whether the values of a key meet `op` against `want`. A missing key holds `exists` never,
/// `missing` always, and `ne` too (nothing equals it).
pub fn matches(values: &[String], op: &str, want: &str) -> bool {
    match op {
        "exists" => return !values.is_empty(),
        "missing" => return values.is_empty(),
        "contains" => return values.iter().any(|v| v.to_lowercase().contains(&want.to_lowercase())),
        _ => {}
    }
    for v in values {
        let ord = match (number(v), number(want)) {
            (Some(a), Some(b)) => a.partial_cmp(&b),
            _ => Some(v.to_lowercase().cmp(&want.to_lowercase())),
        };
        let Some(ord) = ord else { continue };
        let hit = match op {
            "eq" => ord == Ordering::Equal,
            "ne" => ord != Ordering::Equal,
            "lt" => ord == Ordering::Less,
            "le" => ord != Ordering::Greater,
            "gt" => ord == Ordering::Greater,
            "ge" => ord != Ordering::Less,
            _ => false,
        };
        if hit {
            return true;
        }
    }
    op == "ne" && values.is_empty()
}

pub fn check(q: &Query) -> Result<(), String> {
    if q.r#where.len() > MAX_WHERE || q.sort.len() > MAX_SORT {
        return Err(format!("A query has at most {MAX_WHERE} conditions and {MAX_SORT} sort keys"));
    }
    for c in &q.r#where {
        if !OPS.contains(&c.op.as_str()) {
            return Err(format!("\"{}\" is not a condition a query knows", c.op));
        }
        if c.prop.trim().is_empty() {
            return Err("A condition needs a property".into());
        }
    }
    for s in &q.sort {
        if s.prop.trim().is_empty() || !matches!(s.dir.as_str(), "" | "asc" | "desc") {
            return Err("A sort key is a property and asc or desc".into());
        }
    }
    Ok(())
}

/// The ordering key of a value: numbers first by value, then text by lower case.
fn sort_key(value: &str) -> (u8, f64, String) {
    match number(value) {
        Some(n) => (0, n, String::new()),
        None => (1, 0.0, value.to_lowercase()),
    }
}

fn compare(a: &str, b: &str) -> Ordering {
    let (x, y) = (sort_key(a), sort_key(b));
    x.0.cmp(&y.0).then(x.1.partial_cmp(&y.1).unwrap_or(Ordering::Equal)).then(x.2.cmp(&y.2))
}

struct Candidate {
    row: QueryRow,
    /// The values of every key the conditions and sorts can ask for, the pseudo keys included.
    seen: HashMap<String, Vec<String>>,
}

/// The pages of the folder notebooks that meet the query (checked with `check`), sorted by its keys, at most its limit.
pub fn run(conn: &Connection, q: &Query) -> rusqlite::Result<Vec<QueryRow>> {
    let mut filter = String::from(" FROM pages p WHERE p.kind = 'md'");
    let mut args: Vec<Sql> = Vec::new();
    if !q.from.notebooks.is_empty() {
        let marks: Vec<String> = q.from.notebooks.iter().map(|n| { args.push(Sql::Text(n.clone())); format!("?{}", args.len()) }).collect();
        filter.push_str(&format!(" AND p.notebook IN ({})", marks.join(", ")));
    }
    if let Some(folder) = q.from.folder.as_deref().map(|f| f.trim_matches('/')).filter(|f| !f.is_empty()) {
        args.push(Sql::Text(format!("{}/%", like_escape(folder))));
        filter.push_str(&format!(" AND p.path LIKE ?{} ESCAPE '\\'", args.len()));
    }
    if let Some(tag) = q.from.tag.as_deref().map(|t| t.trim().trim_start_matches('#').to_lowercase()).filter(|t| !t.is_empty()) {
        args.push(Sql::Text(tag));
        filter.push_str(&format!(" AND EXISTS (SELECT 1 FROM tags t WHERE t.page = p.id AND t.tag = ?{})", args.len()));
    }
    let pages: Vec<(i64, QueryRow)> = {
        let mut stmt = conn.prepare(&format!("SELECT p.id, p.notebook, p.path, p.title, p.sha256, p.mtime_ms{filter} ORDER BY p.notebook, p.path"))?;
        let rows = stmt
            .query_map(params_from_iter(args.iter()), |r| {
                Ok((r.get::<_, i64>(0)?, QueryRow { notebook: r.get(1)?, path: r.get(2)?, title: r.get(3)?, sha256: r.get(4)?, mtime_ms: r.get(5)?, props: Default::default() }))
            })
            ?;
        rows.collect::<Result<_, _>>()?
    };
    // All the properties of those pages: the conditions and sorts read them, and the page row carries them to the webview.
    let mut props: HashMap<i64, Vec<(String, String)>> = HashMap::new();
    {
        let mut stmt = conn.prepare(&format!("SELECT page, key, value FROM props WHERE page IN (SELECT p.id{filter}) ORDER BY page, rowid"))?;
        let rows = stmt.query_map(params_from_iter(args.iter()), |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?)))?;
        for row in rows {
            let (page, key, value) = row?;
            props.entry(page).or_default().push((key, value));
        }
    }
    let mut out: Vec<Candidate> = Vec::new();
    for (id, mut row) in pages {
        let mut own: HashMap<String, Vec<String>> = HashMap::new();
        for (key, value) in props.remove(&id).unwrap_or_default() {
            own.entry(key).or_default().push(value);
        }
        let mut seen = own.clone();
        seen.insert("title".into(), vec![row.title.clone()]);
        seen.insert("path".into(), vec![row.path.clone()]);
        seen.insert("notebook".into(), vec![row.notebook.clone()]);
        let holds = q.r#where.iter().all(|c| matches(seen.get(&c.prop).map(Vec::as_slice).unwrap_or(&[]), &c.op, &want_text(&c.value)));
        if !holds {
            continue;
        }
        for (key, mut values) in own {
            let value = if values.len() == 1 { Value::String(values.remove(0)) } else { Value::Array(values.into_iter().map(Value::String).collect()) };
            row.props.insert(key, value);
        }
        out.push(Candidate { row, seen });
    }
    for s in q.sort.iter().rev() {
        let desc = s.dir == "desc";
        let (mut present, absent): (Vec<Candidate>, Vec<Candidate>) = out.into_iter().partition(|c| c.seen.get(&s.prop).is_some_and(|v| !v.is_empty()));
        present.sort_by(|a, b| {
            let ord = compare(&a.seen[&s.prop][0], &b.seen[&s.prop][0]);
            if desc { ord.reverse() } else { ord }
        });
        present.extend(absent);
        out = present;
    }
    Ok(out.into_iter().take(q.limit.unwrap_or(500).clamp(1, MAX_ROWS)).map(|c| c.row).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn values(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn conditions_compare_numbers_as_numbers_and_the_rest_by_lower_case_text() {
        assert!(matches(&values(&["10"]), "gt", "9"));
        assert!(!matches(&values(&["10"]), "lt", "9"), "numbers, not text: \"10\" < \"9\" as text");
        assert!(matches(&values(&["Active"]), "eq", "active"));
        assert!(matches(&values(&["2026-12-01"]), "lt", "2027-01-01"));
        assert!(matches(&values(&["b"]), "ge", "B"));
        assert!(matches(&values(&["a", "b"]), "eq", "b"), "a list holds when any value does");
        assert!(matches(&values(&["Plan for Q4"]), "contains", "q4"));
        assert!(matches(&values(&["x"]), "exists", ""));
        assert!(!matches(&values(&[]), "exists", ""));
        assert!(matches(&values(&[]), "missing", ""));
        // Nothing equals a missing key, so `ne` holds; every other comparison does not.
        assert!(matches(&values(&[]), "ne", "x"));
        assert!(!matches(&values(&[]), "eq", "x") && !matches(&values(&[]), "lt", "x") && !matches(&values(&[]), "contains", "x"));
        assert!(!matches(&values(&["x"]), "ne", "x"));
        assert!(matches(&values(&["x", "y"]), "ne", "x"), "some value differs");
    }

    #[test]
    fn a_bad_query_is_refused_before_it_runs() {
        let bad = |q: &str| check(&serde_json::from_str::<Query>(q).unwrap()).unwrap_err();
        assert!(bad(r#"{"where":[{"prop":"a","op":"like","value":"x"}]}"#).contains("not a condition"));
        assert!(bad(r#"{"where":[{"prop":" ","op":"eq","value":"x"}]}"#).contains("needs a property"));
        assert!(bad(r#"{"sort":[{"prop":"a","dir":"up"}]}"#).contains("asc or desc"));
        let many = format!("{{\"where\":[{}]}}", [r#"{"prop":"a","op":"exists"}"#; MAX_WHERE + 1].join(","));
        assert!(bad(&many).contains("at most"));
        assert!(check(&Query::default()).is_ok());
    }

    #[test]
    fn the_form_in_json_is_read_with_its_defaults() {
        let q: Query = serde_json::from_str(r#"{"version":1,"from":{"notebooks":["nb-1"],"folder":"Projects"},"where":[{"prop":"status","op":"eq","value":"active"},{"prop":"n","op":"gt","value":3}],"sort":[{"prop":"due","dir":"desc"}],"view":"board","columns":["status"],"groupBy":"status","limit":20}"#).unwrap();
        assert_eq!(q.from, Source { notebooks: vec!["nb-1".into()], folder: Some("Projects".into()), tag: None });
        assert_eq!((q.r#where.len(), q.sort[0].dir.as_str(), q.limit), (2, "desc", Some(20)));
        assert_eq!(want_text(&q.r#where[1].value), "3");
    }
}
