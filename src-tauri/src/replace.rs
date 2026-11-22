//! Find and replace in files (NS-6B). The search walks a registered notebook or folder; replace writes each file as `file_save`
//! does: through the notebook's containment and `files::guard`, against the hash the preview showed, with a history version
//! kept first, in the file's own encoding and line endings.
//!
//! The preview and the write both work on the text as the editor sees it (LF line breaks, no byte order mark), so a match is
//! the same match in both, and `files::encode` puts the file's own format back.
use crate::files::guard::Protected;
use crate::files::{self, contain, FileFormat, SaveOutcome, Stamp};
use crate::history;
use crate::studio::{self, Change};
use crate::AppState;
use ignore::gitignore::{Gitignore, GitignoreBuilder};
use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::State;

/// A file over this is neither searched nor changed.
pub const MAX_FILE: u64 = 8 * 1024 * 1024;
/// A search stops here and says so.
pub const MAX_MATCHES: usize = 10_000;
/// Characters of a line shown in a preview around the match.
const BEFORE: usize = 120;
const AFTER: usize = 240;
/// Undo sets kept for Undo all, newest first.
const KEEP_UNDOS: usize = 8;

/// What to look for.
#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Query {
    pub pattern: String,
    /// A regular expression; otherwise the text as typed.
    #[serde(default)]
    pub regex: bool,
    /// Letter case matters.
    #[serde(default)]
    pub case: bool,
    /// Only whole words.
    #[serde(default)]
    pub word: bool,
    /// Gitignore-style patterns: only files matching one of them are searched (all files with none).
    #[serde(default)]
    pub include: Vec<String>,
    #[serde(default)]
    pub exclude: Vec<String>,
}

/// Where to look: a registered notebook (`notebook`, and a folder of it, `sub`) or a registered folder (`folder`).
#[derive(Deserialize, Serialize, Clone, Debug, Default, PartialEq)]
pub struct Scope {
    pub notebook: Option<String>,
    pub folder: Option<String>,
    pub sub: Option<String>,
}

/// One match, as byte offsets into the text and the text to put there.
#[derive(Debug, PartialEq)]
struct Match {
    start: usize,
    end: usize,
    with: String,
}

struct Finder {
    re: Regex,
    /// The replacement as typed; a regular expression reads `$1` and `${name}` in it.
    replacement: String,
    literal: bool,
}

impl Finder {
    fn new(query: &Query, replacement: &str) -> Result<Finder, String> {
        if query.pattern.is_empty() {
            return Err("Type something to find".into());
        }
        let source = if query.regex { query.pattern.clone() } else { regex::escape(&query.pattern) };
        let source = if query.word { format!(r"\b(?:{source})\b") } else { source };
        let re = RegexBuilder::new(&source)
            .case_insensitive(!query.case)
            .multi_line(true)
            .size_limit(10 * 1024 * 1024)
            .build()
            .map_err(|e| format!("This is not a valid pattern: {e}"))?;
        Ok(Finder { re, replacement: replacement.to_string(), literal: !query.regex })
    }

    /// The matches of `text`, in order. A match with no characters is left out: it is noise in a list and replacing it would
    /// insert text everywhere.
    fn spans<'a>(&'a self, text: &'a str) -> impl Iterator<Item = regex::Captures<'a>> + 'a {
        self.re.captures_iter(text).filter(|caps| caps.get(0).is_some_and(|whole| whole.start() != whole.end()))
    }

    /// The text to put in place of a match.
    fn expand(&self, caps: &regex::Captures) -> String {
        if self.literal {
            return self.replacement.clone();
        }
        let mut with = String::new();
        caps.expand(&self.replacement, &mut with);
        with
    }

    /// The first `limit` matches of `text`, for a preview: a search stops there, and a match keeps only as much of its
    /// replacement as a hunk shows, so a long replacement does not multiply by the number of matches.
    fn matches(&self, text: &str, limit: usize) -> Vec<Match> {
        self.spans(text)
            .take(limit)
            .map(|caps| {
                let whole = caps.get(0).expect("group 0 always matches");
                let with = if self.literal { shown(&self.replacement).to_string() } else { shown(&self.expand(&caps)).to_string() };
                Match { start: whole.start(), end: whole.end(), with }
            })
            .collect()
    }

    /// The matches of `text` up to the last one of `chosen` (indexes among all matches), with the whole text to put in
    /// each chosen match and none in the others. Err when the file with these replacements would be over `budget` bytes,
    /// found out as the matches are read, before the result is built.
    fn chosen(&self, text: &str, chosen: &HashSet<usize>, budget: usize) -> Result<Vec<Match>, String> {
        let upto = chosen.iter().max().map_or(0, |last| last + 1);
        let (mut size, mut out) = (text.len(), Vec::new());
        for (i, caps) in self.spans(text).enumerate().take(upto) {
            let whole = caps.get(0).expect("group 0 always matches");
            let mut with = String::new();
            if chosen.contains(&i) {
                with = self.expand(&caps);
                size = size.saturating_sub(whole.end() - whole.start()).saturating_add(with.len());
                if size > budget {
                    return Err(format!("the result would be over {} MB, which Undo could not put back", budget / (1024 * 1024)));
                }
            }
            out.push(Match { start: whole.start(), end: whole.end(), with });
        }
        Ok(out)
    }
}

/// `text` with the matches at `chosen` replaced.
fn rewrite(text: &str, matches: &[Match], chosen: &HashSet<usize>) -> String {
    let mut out = String::with_capacity(text.len());
    let mut at = 0;
    for (i, m) in matches.iter().enumerate() {
        if chosen.contains(&i) {
            out.push_str(&text[at..m.start]);
            out.push_str(&m.with);
            at = m.end;
        }
    }
    out.push_str(&text[at..]);
    out
}

/// One match for the screen: its line (from 1), the lines it covers as they are, and as they would be.
#[derive(Serialize, Debug, PartialEq)]
pub struct Hunk {
    pub index: usize,
    pub line: usize,
    pub before: String,
    pub after: String,
}

/// The part of a replacement a hunk can show: one character more than `clip` keeps, so `clip` still sees it is cut.
fn shown(text: &str) -> &str {
    text.char_indices().nth(AFTER + 1).map_or(text, |(at, _)| &text[..at])
}

/// The first `AFTER` characters of `text`, with an ellipsis when it is longer.
fn clip(text: &str) -> String {
    match text.char_indices().nth(AFTER) {
        Some((at, _)) => format!("{}\u{2026}", &text[..at]),
        None => text.to_string(),
    }
}

/// The index of the first character boundary at or after `at`.
fn boundary_up(text: &str, mut at: usize) -> usize {
    while at < text.len() && !text.is_char_boundary(at) {
        at += 1;
    }
    at.min(text.len())
}

/// The lines a match covers, cut to a window of `BEFORE` characters before it and `AFTER` after it, with `with` in the
/// match's place when given. Only the window is searched, so a file that is one long line costs no more than any other.
fn snippet(text: &str, m: &Match, with: Option<&str>) -> String {
    let floor = boundary_up(text, m.start.saturating_sub(BEFORE));
    let (from, cut_front) = match text[floor..m.start].rfind('\n') {
        Some(i) => (floor + i + 1, false),
        None => (floor, floor > 0 && text.as_bytes()[floor - 1] != b'\n'),
    };
    let ceil = boundary_up(text, (m.end + AFTER).min(text.len()));
    let (to, cut_back) = match text[m.end..ceil].find('\n') {
        Some(i) => (m.end + i, false),
        None => (ceil, ceil < text.len() && text.as_bytes()[ceil] != b'\n'),
    };
    let middle = clip(with.unwrap_or(&text[m.start..m.end]));
    format!("{}{}{}{}{}", if cut_front { "\u{2026}" } else { "" }, &text[from..m.start], middle, &text[m.end..to], if cut_back { "\u{2026}" } else { "" })
}

/// The hunks of `matches`; `replaced` gives each its `after`.
fn hunks_of(text: &str, matches: &[Match], replaced: bool) -> Vec<Hunk> {
    let (mut line, mut at) = (1usize, 0usize);
    matches
        .iter()
        .enumerate()
        .map(|(index, m)| {
            line += text[at..m.start].matches('\n').count();
            at = m.start;
            Hunk { index, line, before: snippet(text, m, None), after: if replaced { snippet(text, m, Some(&m.with)) } else { String::new() } }
        })
        .collect()
}

/// A file with matches: its path from the scope's folder, the hash its text was read with (the write's precondition), and
/// the matches.
#[derive(Serialize, Debug)]
pub struct FilePreview {
    pub path: String,
    pub sha256: String,
    pub matches: usize,
    pub hunks: Vec<Hunk>,
}

#[derive(Serialize, Debug, PartialEq, Clone)]
pub struct Skipped {
    pub path: String,
    pub why: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub files: Vec<FilePreview>,
    /// Files that match but cannot be changed (not editable, protected, unreadable).
    pub skipped: Vec<Skipped>,
    pub matches: usize,
    /// The search stopped at the limit.
    pub capped: bool,
    /// Files looked at, not counting those left out below.
    pub searched: usize,
    pub binary: usize,
    pub large: usize,
}

/// Gitignore-style lists for the include and exclude patterns.
fn globs(root: &Path, lines: &[String]) -> Result<Option<Gitignore>, String> {
    let lines: Vec<&str> = lines.iter().map(|l| l.trim()).filter(|l| !l.is_empty()).collect();
    if lines.is_empty() {
        return Ok(None);
    }
    let mut builder = GitignoreBuilder::new(root);
    for line in lines {
        builder.add_line(None, line).map_err(|e| format!("\"{line}\" is not a valid file pattern: {e}"))?;
    }
    builder.build().map(Some).map_err(|e| e.to_string())
}

/// What the include and exclude patterns say of the file `rel`.
struct Filter {
    include: Option<Gitignore>,
    exclude: Option<Gitignore>,
    root: PathBuf,
}

impl Filter {
    fn new(root: &Path, query: &Query) -> Result<Filter, String> {
        Ok(Filter { include: globs(root, &query.include)?, exclude: globs(root, &query.exclude)?, root: root.to_path_buf() })
    }

    fn wants(&self, full: &Path) -> bool {
        let hit = |set: &Gitignore| set.matched_path_or_any_parents(full.strip_prefix(&self.root).unwrap_or(full), false).is_ignore();
        self.include.as_ref().is_none_or(hit) && !self.exclude.as_ref().is_some_and(hit)
    }
}

/// Every file the search looks at: what `.gitignore` and `.ignore` leave, no hidden file or folder (so no `.git`, `.hivemind`
/// or `.obsidian`), links not followed. The paths are below `start`.
fn files_under(start: &Path) -> impl Iterator<Item = PathBuf> {
    let mut walker = ignore::WalkBuilder::new(start);
    walker.hidden(true).git_ignore(true).git_exclude(true).git_global(false).ignore(true).parents(true).require_git(false).follow_links(false);
    walker.sort_by_file_path(|a, b| a.cmp(b));
    walker.build().flatten().filter(|e| e.file_type().is_some_and(|t| t.is_file())).map(|e| e.into_path())
}

/// The place a search or a replace works in.
pub struct Target {
    pub root: PathBuf,
    pub protected: Protected,
}

/// Search `target` (below `sub`, a folder of it, when given) and say what replacing with `replacement` would do. With no
/// replacement the hunks only show the lines found.
pub fn preview(target: &Target, sub: Option<&str>, query: &Query, replacement: Option<&str>) -> Result<Preview, String> {
    let finder = Finder::new(query, replacement.unwrap_or(""))?;
    let filter = Filter::new(&target.root, query)?;
    let start = match sub.filter(|s| !s.is_empty()) {
        Some(sub) => studio::inside(&target.root, &target.protected, sub, false)?,
        None => target.root.clone(),
    };
    let mut out = Preview { files: Vec::new(), skipped: Vec::new(), matches: 0, capped: false, searched: 0, binary: 0, large: 0 };
    for full in files_under(&start) {
        if !filter.wants(&full) {
            continue;
        }
        let Some(rel) = contain::relative(&target.root, &full) else { continue };
        if let Err(why) = studio::inside(&target.root, &target.protected, &rel, false) {
            // A file the guard refuses is named only when it would have been searched, which costs a read; leave it out here.
            if !why.contains("hidden") {
                out.skipped.push(Skipped { path: rel, why });
            }
            continue;
        }
        let Ok(meta) = std::fs::metadata(&full) else { continue };
        if meta.len() > MAX_FILE {
            out.large += 1;
            continue;
        }
        let bytes = match std::fs::read(&full) {
            Ok(bytes) => bytes,
            Err(e) => {
                out.skipped.push(Skipped { path: rel, why: format!("could not be read: {e}") });
                continue;
            }
        };
        let (text, _format, read_only, binary) = files::decode(&bytes);
        if binary {
            out.binary += 1;
            continue;
        }
        out.searched += 1;
        // The search stops at the room left in the budget: a file with millions of matches is not read to its end.
        let room = MAX_MATCHES - out.matches;
        let found = finder.matches(&text, room);
        if found.is_empty() {
            continue;
        }
        if let Some(why) = read_only {
            out.skipped.push(Skipped { path: rel, why });
            continue;
        }
        if found.len() >= room {
            out.capped = true;
        }
        out.matches += found.len();
        let hunks = hunks_of(&text, &found, replacement.is_some());
        out.files.push(FilePreview { path: rel, sha256: files::sha256(&bytes), matches: found.len(), hunks });
        if out.capped {
            break;
        }
    }
    Ok(out)
}

/// The file the user chose to change, as the preview showed it: its hash, and which matches (by `index`).
#[derive(Deserialize, Debug)]
pub struct Chosen {
    pub path: String,
    pub sha256: String,
    pub hunks: Vec<usize>,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Done {
    pub path: String,
    pub replaced: usize,
}

/// What a file looked like before and after a replace, to put it back with Undo all.
#[derive(Clone, Debug, PartialEq)]
pub struct Undo {
    pub path: String,
    pub before: String,
    pub after: String,
}

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Applied {
    pub done: Vec<Done>,
    pub skipped: Vec<Skipped>,
    /// The id that Undo all takes; none when nothing was changed.
    pub undo: Option<String>,
    /// The documents open in a tab that show a file written (or put back), so they read it again: the write is Hivemind's
    /// own, which the watcher does not report.
    pub reread: Vec<Reread>,
}

/// A document open in a tab, as the webview names it (a page of a notebook, or a loose file). `unsaved`: it has edits that
/// are not in its file.
#[derive(Deserialize, Debug, Clone)]
pub struct OpenDoc {
    pub notebook: String,
    pub path: String,
    pub unsaved: bool,
}

/// An open document whose file was written.
#[derive(Serialize, Debug, PartialEq)]
pub struct Reread {
    pub notebook: String,
    pub path: String,
}

/// The open documents that are files of `root`, each with its path below the root as the file system resolves it. A
/// document is named by its own notebook and path, which may be spelled differently from the scope's (a folder that is
/// also a notebook, or a notebook below the folder), so a file is the same file when it resolves to the same place.
/// `resolve` gives a document's file.
fn docs_below(root: &Path, open: Vec<OpenDoc>, resolve: impl Fn(&OpenDoc) -> Option<PathBuf>) -> Vec<(OpenDoc, String)> {
    open.into_iter()
        .filter_map(|doc| {
            let full = resolve(&doc)?;
            let rel = contain::resolved_rel(root, &full)?;
            Some((doc, rel))
        })
        .collect()
}

/// The paths of the scope with unsaved edits in a tab.
fn unsaved_of(below: &[(OpenDoc, String)]) -> Vec<String> {
    below.iter().filter(|(doc, _)| doc.unsaved).map(|(_, rel)| rel.clone()).collect()
}

/// The open documents that show a file `applied` wrote.
fn reread_of(below: &[(OpenDoc, String)], applied: &Applied) -> Vec<Reread> {
    below
        .iter()
        .filter(|(_, rel)| applied.done.iter().any(|d| same_path(&d.path, rel)))
        .map(|(doc, _)| Reread { notebook: doc.notebook.clone(), path: doc.path.clone() })
        .collect()
}

fn open_below(state: &AppState, root: &Path, open: Vec<OpenDoc>) -> Vec<(OpenDoc, String)> {
    docs_below(root, open, |doc| studio::resolve_file(state, &doc.notebook, &doc.path, false).ok().map(|(full, _)| full))
}

/// The files written (or put back) by `apply` and `undo`, for the index.
#[derive(Default)]
pub struct Written {
    pub paths: Vec<PathBuf>,
    pub undo: Vec<Undo>,
}

fn skip(applied: &mut Applied, path: &str, why: impl Into<String>) {
    applied.skipped.push(Skipped { path: path.to_string(), why: why.into() });
}

fn same_path(a: &str, b: &str) -> bool {
    a.eq_ignore_ascii_case(b)
}

/// Write the replacements the user chose. A file is skipped, and listed, when it has unsaved edits in a tab (`unsaved`), is
/// protected, no longer holds the bytes the preview read, or cannot be saved; the others are written one by one.
pub fn apply(target: &Target, history: &Path, query: &Query, replacement: &str, chosen: &[Chosen], unsaved: &[String]) -> Result<(Applied, Written), String> {
    let finder = Finder::new(query, replacement)?;
    let mut applied = Applied::default();
    let mut written = Written::default();
    for file in chosen {
        if file.hunks.is_empty() {
            continue;
        }
        if unsaved.iter().any(|u| same_path(u, &file.path)) {
            skip(&mut applied, &file.path, "it has unsaved edits in a tab; save or discard them first");
            continue;
        }
        let full = match studio::inside(&target.root, &target.protected, &file.path, true) {
            Ok(full) => full,
            Err(why) => {
                skip(&mut applied, &file.path, why);
                continue;
            }
        };
        let bytes = match std::fs::read(&full) {
            Ok(bytes) if bytes.len() as u64 <= MAX_FILE => bytes,
            Ok(_) => {
                skip(&mut applied, &file.path, "it is over 8 MB now");
                continue;
            }
            Err(e) => {
                skip(&mut applied, &file.path, format!("it could not be read: {e}"));
                continue;
            }
        };
        if files::sha256(&bytes) != file.sha256 {
            skip(&mut applied, &file.path, "it changed after the preview");
            continue;
        }
        let (text, format, read_only, binary) = files::decode(&bytes);
        if binary || read_only.is_some() {
            skip(&mut applied, &file.path, read_only.unwrap_or_else(|| "it is not a text file".into()));
            continue;
        }
        // A preview offers at most MAX_MATCHES matches, so no index past that is a match it showed.
        let wanted: HashSet<usize> = file.hunks.iter().copied().filter(|i| *i < MAX_MATCHES).collect();
        let found = match finder.chosen(&text, &wanted, MAX_FILE as usize) {
            Ok(found) => found,
            Err(why) => {
                skip(&mut applied, &file.path, why);
                continue;
            }
        };
        let chosen_hunks: HashSet<usize> = wanted.into_iter().filter(|i| *i < found.len()).collect();
        if chosen_hunks.is_empty() {
            skip(&mut applied, &file.path, "its matches are not there any more");
            continue;
        }
        let new_text = rewrite(&text, &found, &chosen_hunks);
        // The file as it is written (UTF-16 doubles, line endings add): the same limit, so Undo can keep it and put it back.
        if files::encode(&new_text, &format).is_ok_and(|out| out.len() as u64 > MAX_FILE) {
            skip(&mut applied, &file.path, format!("the result would be over {} MB, which Undo could not put back", MAX_FILE / (1024 * 1024)));
            continue;
        }
        let pre = Stamp { sha256: file.sha256.clone(), size: bytes.len() as u64, mtime_ms: 0 };
        match studio::save_kept(history, &full, &Change { text: &new_text, pre: &pre, format: &format, convert: false, source: "replace" }) {
            Ok(SaveOutcome::Saved(stamp)) => {
                applied.done.push(Done { path: file.path.clone(), replaced: chosen_hunks.len() });
                written.paths.push(full);
                written.undo.push(Undo { path: file.path.clone(), before: file.sha256.clone(), after: stamp.sha256 });
            }
            Ok(SaveOutcome::Stale { .. }) => skip(&mut applied, &file.path, "it changed after the preview"),
            Ok(SaveOutcome::Gone) => skip(&mut applied, &file.path, "it was moved or deleted"),
            Err(why) => skip(&mut applied, &file.path, why),
        }
    }
    Ok((applied, written))
}

/// Put back what a replace changed: each file returns to the version kept before it, but only while it still holds exactly
/// what the replace wrote. A file changed since is skipped, never overwritten.
pub fn undo(target: &Target, history: &Path, entries: &[Undo], unsaved: &[String]) -> (Applied, Written) {
    let mut applied = Applied::default();
    let mut written = Written::default();
    for entry in entries {
        if unsaved.iter().any(|u| same_path(u, &entry.path)) {
            skip(&mut applied, &entry.path, "it has unsaved edits in a tab; save or discard them first");
            continue;
        }
        let full = match studio::inside(&target.root, &target.protected, &entry.path, true) {
            Ok(full) => full,
            Err(why) => {
                skip(&mut applied, &entry.path, why);
                continue;
            }
        };
        let Ok(now) = std::fs::read(&full) else {
            skip(&mut applied, &entry.path, "it was moved or deleted");
            continue;
        };
        if files::sha256(&now) != entry.after {
            skip(&mut applied, &entry.path, "it changed after the replace");
            continue;
        }
        let version = history::list(history, &full).into_iter().find(|v| v.sha256 == entry.before);
        let Some(bytes) = version.and_then(|v| history::read(history, &full, v.id).ok()) else {
            skip(&mut applied, &entry.path, "the version from before the replace is no longer kept");
            continue;
        };
        let (text, format, read_only, binary): (String, FileFormat, Option<String>, bool) = files::decode(&bytes);
        if binary || read_only.is_some() {
            skip(&mut applied, &entry.path, "the earlier version is not text Hivemind can write back");
            continue;
        }
        let pre = Stamp { sha256: entry.after.clone(), size: now.len() as u64, mtime_ms: 0 };
        match studio::save_kept(history, &full, &Change { text: &text, pre: &pre, format: &format, convert: false, source: "restore" }) {
            Ok(SaveOutcome::Saved(_)) => {
                applied.done.push(Done { path: entry.path.clone(), replaced: 0 });
                written.paths.push(full);
            }
            Ok(SaveOutcome::Stale { .. }) => skip(&mut applied, &entry.path, "it changed after the replace"),
            Ok(SaveOutcome::Gone) => skip(&mut applied, &entry.path, "it was moved or deleted"),
            Err(why) => skip(&mut applied, &entry.path, why),
        }
    }
    (applied, written)
}

/// The replaces that can still be undone, newest first. They live in memory: after a restart each file's own history still
/// holds the versions.
#[derive(Default)]
pub struct Undos {
    sets: Mutex<Vec<(String, Scope, Vec<Undo>)>>,
}

impl Undos {
    fn keep(&self, scope: Scope, entries: Vec<Undo>) -> String {
        let id = uuid::Uuid::new_v4().simple().to_string();
        let mut sets = self.sets.lock().unwrap_or_else(|e| e.into_inner());
        sets.insert(0, (id.clone(), scope, entries));
        sets.truncate(KEEP_UNDOS);
        id
    }

    fn take(&self, id: &str) -> Option<(Scope, Vec<Undo>)> {
        let mut sets = self.sets.lock().unwrap_or_else(|e| e.into_inner());
        let at = sets.iter().position(|(i, ..)| i == id)?;
        let (_, scope, entries) = sets.remove(at);
        Some((scope, entries))
    }
}

/// A folder the user picked, canonical, and still the one that was picked: it was saved in its canonical spelling, so a
/// link on that path now (a junction put where the folder was moved from) is refused as it is for a notebook. Undo takes
/// the same road, so it cannot write into a folder the search would not have read.
fn other_folder(known: &str) -> Result<PathBuf, String> {
    if !contain::unmoved(Path::new(known)) {
        return Err(format!("The folder {known} now leads somewhere else; it was moved or replaced by a link. Forget it and add the folder again"));
    }
    let root = std::fs::canonicalize(known).map_err(|e| format!("The folder {known} cannot be opened: {e}"))?;
    if !root.is_dir() {
        return Err(format!("{known} is not a folder"));
    }
    Ok(root)
}

/// The folder a scope names, checked as a command checks any file: a registered notebook (still the folder that was
/// registered, outside the store and every vault) or one of the folders the user picked.
fn target(state: &AppState, scope: &Scope) -> Result<Target, String> {
    match (&scope.notebook, &scope.folder) {
        (Some(id), None) => {
            let (root, protected) = studio::root_of(state, id)?;
            Ok(Target { root, protected })
        }
        (None, Some(folder)) => {
            let saved = crate::settings::load(&state.settings_path);
            let known = crate::folders::find(&saved, folder).ok_or("Find in files searches the notebooks and folders you added to Hivemind")?;
            let root = other_folder(known)?;
            let protected = studio::protected(state);
            protected.check_root(&root)?;
            Ok(Target { root: PathBuf::from(crate::folders::plain(&root)), protected })
        }
        _ => Err("Choose a notebook or a folder to search".into()),
    }
}

/// Tell the search index about files written: each registered notebook that holds one learns its page.
fn tell_index(state: &AppState, written: &[PathBuf]) {
    for nb in state.notebooks.list() {
        let root = PathBuf::from(&nb.path);
        let rels: Vec<String> = written.iter().filter_map(|full| contain::resolved_rel(&root, full)).collect();
        studio::touched(&state.index, &nb.id, &root, rels);
    }
}

/// Search, and show what replacing with `replacement` would change. With no `replacement` it is a plain search.
#[tauri::command]
pub async fn replace_preview(state: State<'_, AppState>, scope: Scope, query: Query, replacement: Option<String>) -> Result<Preview, String> {
    let target = target(&state, &scope)?;
    crate::blocking(move || preview(&target, scope.sub.as_deref(), &query, replacement.as_deref())).await
}

/// Write the chosen replacements. `open`: the documents open in a tab; those with unsaved edits are matched to the scope's
/// files by where they resolve to, and the ones that show a file written are named in the answer to read it again.
#[tauri::command]
pub async fn replace_apply(
    state: State<'_, AppState>,
    scope: Scope,
    query: Query,
    replacement: String,
    files: Vec<Chosen>,
    open: Vec<OpenDoc>,
) -> Result<Applied, String> {
    let target = target(&state, &scope)?;
    let history = state.history_dir.clone();
    let below = open_below(&state, &target.root, open);
    let unsaved = unsaved_of(&below);
    let (mut applied, written) = crate::blocking(move || apply(&target, &history, &query, &replacement, &files, &unsaved)).await?;
    applied.reread = reread_of(&below, &applied);
    tell_index(&state, &written.paths);
    if !written.undo.is_empty() {
        applied.undo = Some(state.replace_undos.keep(scope, written.undo));
    }
    Ok(applied)
}

/// Undo a replace (the id `replace_apply` gave): files changed since are skipped.
#[tauri::command]
pub async fn replace_undo(state: State<'_, AppState>, undo: String, open: Vec<OpenDoc>) -> Result<Applied, String> {
    let (scope, entries) = state.replace_undos.take(&undo).ok_or("This replace can no longer be undone from here; restore the files from their History")?;
    let target = target(&state, &scope)?;
    let history = state.history_dir.clone();
    let below = open_below(&state, &target.root, open);
    let unsaved = unsaved_of(&below);
    let (mut applied, written) = crate::blocking(move || Ok(undo_all(&target, &history, &entries, &unsaved))).await?;
    applied.reread = reread_of(&below, &applied);
    tell_index(&state, &written.paths);
    Ok(applied)
}

fn undo_all(target: &Target, history: &Path, entries: &[Undo], unsaved: &[String]) -> (Applied, Written) {
    undo(target, history, entries, unsaved)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hm-replace-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn put(root: &Path, rel: &str, bytes: &[u8]) {
        let full = root.join(rel);
        std::fs::create_dir_all(full.parent().unwrap()).unwrap();
        std::fs::write(full, bytes).unwrap();
    }

    fn setup() -> (Target, PathBuf) {
        let root = scratch();
        (Target { root: root.clone(), protected: Protected::new(None) }, scratch())
    }

    fn query(pattern: &str) -> Query {
        Query { pattern: pattern.into(), ..Default::default() }
    }

    fn paths(p: &Preview) -> Vec<&str> {
        p.files.iter().map(|f| f.path.as_str()).collect()
    }

    fn all(p: &Preview) -> Vec<Chosen> {
        p.files.iter().map(|f| Chosen { path: f.path.clone(), sha256: f.sha256.clone(), hunks: (0..f.matches).collect() }).collect()
    }

    fn read(root: &Path, rel: &str) -> Vec<u8> {
        std::fs::read(root.join(rel)).unwrap()
    }

    #[test]
    fn text_search_finds_each_match_with_its_line_and_the_replaced_line() {
        let (t, _) = setup();
        put(&t.root, "a.md", b"one cat\ntwo dogs\nthree cats and a cat\n");
        let p = preview(&t, None, &query("cat"), Some("bird")).unwrap();
        assert_eq!((paths(&p), p.matches, p.capped), (vec!["a.md"], 3, false));
        let hunks = &p.files[0].hunks;
        assert_eq!(hunks.iter().map(|h| (h.index, h.line)).collect::<Vec<_>>(), [(0, 1), (1, 3), (2, 3)]);
        assert_eq!((hunks[0].before.as_str(), hunks[0].after.as_str()), ("one cat", "one bird"));
        // Two matches on one line are two hunks, each with only its own match replaced.
        assert_eq!(hunks[1].after, "three birds and a cat");
        assert_eq!(hunks[2].after, "three cats and a bird");
        // With no replacement the lines are only shown.
        let find = preview(&t, None, &query("cat"), None).unwrap();
        assert_eq!(find.files[0].hunks[0].after, "");
        assert!(find.files[0].sha256 == files::sha256(b"one cat\ntwo dogs\nthree cats and a cat\n"));
    }

    #[test]
    fn case_whole_word_and_regex_options_work() {
        let (t, _) = setup();
        put(&t.root, "a.txt", b"Cat cat CAT category\nconcat\n");
        let count = |q: Query| preview(&t, None, &q, Some("x")).unwrap().matches;
        assert_eq!(count(query("cat")), 5);
        assert_eq!(count(Query { case: true, ..query("cat") }), 3);
        assert_eq!(count(Query { word: true, ..query("cat") }), 3);
        assert_eq!(count(Query { word: true, case: true, ..query("cat") }), 1);
        assert_eq!(count(Query { regex: true, case: true, ..query(r"c\w+t") }), 3);
        // Text is not read as a pattern; a pattern that does not compile says so; an empty one is refused.
        put(&t.root, "b.txt", b"a.b a*b\n");
        assert_eq!(count(query("a.b")), 1);
        assert!(preview(&t, None, &Query { regex: true, ..query("(") }, None).unwrap_err().contains("not a valid pattern"));
        assert!(preview(&t, None, &query(""), None).is_err());
        // A pattern that matches nothing at a place is not a match.
        assert_eq!(count(Query { regex: true, ..query("x*") }), 0);
    }

    #[test]
    fn a_regex_replacement_reads_groups_and_a_text_one_does_not() {
        let (t, h) = setup();
        put(&t.root, "a.txt", b"id=7 id=42\n");
        let q = Query { regex: true, ..query(r"id=(\d+)") };
        let p = preview(&t, None, &q, Some("<$1>")).unwrap();
        assert_eq!(p.files[0].hunks[1].after, "id=7 <42>");
        let (done, _) = apply(&t, &h, &q, "<$1>", &all(&p), &[]).unwrap();
        assert_eq!(done.done, [Done { path: "a.txt".into(), replaced: 2 }]);
        assert_eq!(read(&t.root, "a.txt"), b"<7> <42>\n");
        put(&t.root, "b.txt", b"price\n");
        let q = query("price");
        let p = preview(&t, None, &q, Some("$1 costs $$5")).unwrap();
        apply(&t, &h, &q, "$1 costs $$5", &all(&p), &[]).unwrap();
        assert_eq!(read(&t.root, "b.txt"), b"$1 costs $$5\n");
    }

    #[test]
    fn include_exclude_gitignore_hidden_binary_and_large_files_are_left_out() {
        let (t, _) = setup();
        put(&t.root, "keep.md", b"needle\n");
        put(&t.root, "notes/deep.md", b"needle\n");
        put(&t.root, "notes/deep.txt", b"needle\n");
        put(&t.root, "build/out.md", b"needle\n");
        put(&t.root, ".gitignore", b"build/\n*.log\n");
        put(&t.root, "debug.log", b"needle\n");
        put(&t.root, ".hivemind/trash/x.md", b"needle\n");
        put(&t.root, ".git/config", b"needle\n");
        put(&t.root, ".obsidian/app.json", b"needle\n");
        put(&t.root, "image.bin", b"needle\x00\x01\x02");
        let mut big = vec![b'x'; (MAX_FILE + 1) as usize];
        big[..7].copy_from_slice(b"needle\n");
        put(&t.root, "huge.txt", &big);
        let p = preview(&t, None, &query("needle"), None).unwrap();
        assert_eq!(paths(&p), ["keep.md", "notes/deep.md", "notes/deep.txt"]);
        assert_eq!((p.binary, p.large), (1, 1));
        // Include and exclude patterns, gitignore style: any depth, folders, and a pattern list.
        let with = |include: &[&str], exclude: &[&str]| {
            let q = Query { include: include.iter().map(|s| s.to_string()).collect(), exclude: exclude.iter().map(|s| s.to_string()).collect(), ..query("needle") };
            paths_owned(&preview(&t, None, &q, None).unwrap())
        };
        assert_eq!(with(&["*.md"], &[]), ["keep.md", "notes/deep.md"]);
        assert_eq!(with(&[], &["notes/"]), ["keep.md"]);
        assert_eq!(with(&["*.md", "*.txt"], &["deep.*"]), ["keep.md"]);
        assert_eq!(with(&["notes/**"], &["*.txt"]), ["notes/deep.md"]);
        // An include pattern does not bring back what .gitignore left out.
        assert!(!with(&["*.md"], &[]).iter().any(|p| p.starts_with("build")));
        // Only a folder of the notebook.
        let q = query("needle");
        assert_eq!(paths_owned(&preview(&t, Some("notes"), &q, None).unwrap()), ["notes/deep.md", "notes/deep.txt"]);
        assert!(preview(&t, Some("../elsewhere"), &q, None).is_err());
        assert!(preview(&t, Some(".git"), &q, None).is_err());
    }

    fn paths_owned(p: &Preview) -> Vec<String> {
        p.files.iter().map(|f| f.path.clone()).collect()
    }

    #[test]
    fn a_file_the_guard_refuses_is_listed_as_skipped_and_never_written() {
        let root = scratch();
        let guarded = root.join("app");
        let t = Target { root: root.clone(), protected: Protected::new(None).with_app(&guarded) };
        let h = scratch();
        put(&root, "ok.md", b"needle\n");
        put(&root, "app/data.md", b"needle\n");
        let q = query("needle");
        let p = preview(&t, None, &q, Some("x")).unwrap();
        assert_eq!(paths(&p), ["ok.md"]);
        assert_eq!(p.skipped.len(), 1);
        assert_eq!(p.skipped[0].path, "app/data.md");
        assert!(p.skipped[0].why.contains("own data folder"), "{}", p.skipped[0].why);
        // A file the webview names that the guard refuses is skipped at the write too.
        let sha = files::sha256(b"needle\n");
        let (a, _) = apply(&t, &h, &q, "x", &[Chosen { path: "app/data.md".into(), sha256: sha.clone(), hunks: vec![0] }, Chosen { path: ".hivemind/x.md".into(), sha256: sha, hunks: vec![0] }], &[]).unwrap();
        assert_eq!((a.done.len(), a.skipped.len()), (0, 2));
        assert_eq!(read(&root, "app/data.md"), b"needle\n");
    }

    #[test]
    fn apply_keeps_each_files_encoding_byte_order_mark_and_line_endings() {
        let (t, h) = setup();
        let utf16: Vec<u8> = [0xFF, 0xFE].into_iter().chain("one needle\r\ntwo\r\n".encode_utf16().flat_map(u16::to_le_bytes)).collect();
        put(&t.root, "crlf.txt", b"\xEF\xBB\xBFone needle\r\ntwo\r\n");
        put(&t.root, "utf16.txt", &utf16);
        put(&t.root, "latin.txt", b"Le caf\xe9 co\xfbte 3 needle au march\xe9 de la ville\r\n");
        put(&t.root, "lf.txt", b"one needle\ntwo");
        let q = query("needle");
        let p = preview(&t, None, &q, Some("pin")).unwrap();
        assert_eq!(p.files.len(), 4, "{:?}", p.skipped);
        let (a, w) = apply(&t, &h, &q, "pin", &all(&p), &[]).unwrap();
        assert_eq!((a.done.len(), a.skipped.len(), w.paths.len()), (4, 0, 4));
        assert_eq!(read(&t.root, "crlf.txt"), b"\xEF\xBB\xBFone pin\r\ntwo\r\n");
        let want16: Vec<u8> = [0xFF, 0xFE].into_iter().chain("one pin\r\ntwo\r\n".encode_utf16().flat_map(u16::to_le_bytes)).collect();
        assert_eq!(read(&t.root, "utf16.txt"), want16);
        assert_eq!(read(&t.root, "latin.txt"), b"Le caf\xe9 co\xfbte 3 pin au march\xe9 de la ville\r\n");
        assert_eq!(read(&t.root, "lf.txt"), b"one pin\ntwo");
    }

    #[test]
    fn only_the_chosen_matches_change_and_the_rest_stay() {
        let (t, h) = setup();
        put(&t.root, "a.txt", b"x1 x2 x3\nx4\n");
        let q = query("x");
        let p = preview(&t, None, &q, Some("y")).unwrap();
        assert_eq!(p.matches, 4);
        let (a, _) = apply(&t, &h, &q, "y", &[Chosen { path: "a.txt".into(), sha256: p.files[0].sha256.clone(), hunks: vec![1, 3, 99] }], &[]).unwrap();
        assert_eq!(a.done, [Done { path: "a.txt".into(), replaced: 2 }]);
        assert_eq!(read(&t.root, "a.txt"), b"x1 y2 x3\ny4\n");
        // Nothing chosen: nothing written.
        let none = apply(&t, &h, &q, "y", &[Chosen { path: "a.txt".into(), sha256: files::sha256(b"x1 y2 x3\ny4\n"), hunks: vec![] }], &[]).unwrap().0;
        assert!(none.done.is_empty() && none.skipped.is_empty());
    }

    #[test]
    fn a_search_stops_at_the_budget_and_keeps_only_what_a_hunk_shows() {   // NOTES-1
        let finder = Finder::new(&query("a"), &"b".repeat(10_000)).unwrap();
        let text = "a".repeat(50_000);
        let found = finder.matches(&text, 7);
        assert_eq!(found.len(), 7);
        assert!(found.iter().all(|m| m.with.chars().count() == AFTER + 1), "a match keeps what a hunk shows, not the replacement");
        // The screen shows the same as before: the first characters and an ellipsis.
        let (t, _) = setup();
        put(&t.root, "a.txt", text.as_bytes());
        let p = preview(&t, None, &query("a"), Some(&"b".repeat(10_000))).unwrap();
        assert_eq!((p.matches, p.capped), (MAX_MATCHES, true));
        assert_eq!(p.files[0].hunks[0].after.chars().filter(|c| *c == 'b').count(), AFTER);
        assert!(p.files[0].hunks[0].after.ends_with(char::from_u32(0x2026).unwrap()));
    }

    #[test]
    fn apply_expands_only_the_chosen_matches() {   // NOTES-1
        let finder = Finder::new(&query("a"), "XYZ").unwrap();
        let text = "a".repeat(1000);
        let found = finder.chosen(&text, &HashSet::from([1usize, 3]), 1 << 20).unwrap();
        assert_eq!(found.len(), 4, "the search ends at the last chosen match");
        assert_eq!(found.iter().map(|m| m.with.as_str()).collect::<Vec<_>>(), ["", "XYZ", "", "XYZ"]);
        assert!(finder.chosen(&text, &HashSet::new(), 1 << 20).unwrap().is_empty());
    }

    #[test]
    fn a_replace_whose_result_is_over_the_size_budget_is_refused_so_undo_can_always_put_it_back() {   // NOTES-2
        let (t, h) = setup();
        // 10,000 matches of 8 KB each would make about 78 MB from a file of 10 KB.
        put(&t.root, "zbig.txt", "a".repeat(10_000).as_bytes());
        // 1,000 matches of 7 KB make about 7 MB: within the budget.
        put(&t.root, "ok.txt", "a".repeat(1_000).as_bytes());
        let (q, with) = (query("a"), "b".repeat(8 * 1024));
        let p = preview(&t, None, &q, Some(&with)).unwrap();
        let (a, w) = apply(&t, &h, &q, &with, &all(&p), &[]).unwrap();
        assert_eq!(a.done.len(), 1, "{:?}", a.skipped);
        assert_eq!(a.done[0].path, "ok.txt");
        assert_eq!(a.skipped.len(), 1);
        assert!(a.skipped[0].why.contains("over 8 MB"), "{}", a.skipped[0].why);
        assert_eq!(read(&t.root, "zbig.txt"), "a".repeat(10_000).as_bytes(), "the file was not written");
        // What was accepted can be undone.
        let (undone, _) = undo(&t, &h, &w.undo, &[]);
        assert_eq!(undone.done.len(), 1, "{:?}", undone.skipped);
        assert_eq!(read(&t.root, "ok.txt"), "a".repeat(1_000).as_bytes());
        // A file that grows to exactly the budget is allowed; one byte more is not.
        let one = Finder::new(&query("a"), &"b".repeat(MAX_FILE as usize + 1)).unwrap();
        assert!(one.chosen("a", &HashSet::from([0usize]), MAX_FILE as usize).is_err());
        let fits = Finder::new(&query("a"), &"b".repeat(MAX_FILE as usize)).unwrap();
        assert!(fits.chosen("a", &HashSet::from([0usize]), MAX_FILE as usize).is_ok());
    }

    #[test]
    fn a_folder_replaced_by_a_junction_is_no_longer_the_folder_that_was_picked() {   // PATH-2
        let dir = scratch();
        let (picked, elsewhere) = (dir.join("picked"), dir.join("elsewhere"));
        std::fs::create_dir_all(&picked).unwrap();
        std::fs::create_dir_all(&elsewhere).unwrap();
        std::fs::write(elsewhere.join("secret.txt"), "needle").unwrap();
        let spelled = crate::folders::plain(&std::fs::canonicalize(&picked).unwrap());
        assert!(other_folder(&spelled).is_ok());
        // The folder is moved aside and a junction to another folder takes its place.
        std::fs::rename(&picked, dir.join("moved-aside")).unwrap();
        let made = std::process::Command::new("cmd").args(["/d", "/c", "mklink", "/J"]).arg(&picked).arg(&elsewhere).output().map(|o| o.status.success()).unwrap_or(false);
        if made {
            assert!(other_folder(&spelled).unwrap_err().contains("leads somewhere else"));
            let _ = std::fs::remove_dir(&picked);
        } else {
            eprintln!("skipped: mklink /J is not available here");
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_version_is_kept_before_each_write_and_the_new_one_after() {
        let (t, h) = setup();
        put(&t.root, "a.md", b"needle one\n");
        let q = query("needle");
        let p = preview(&t, None, &q, Some("pin")).unwrap();
        apply(&t, &h, &q, "pin", &all(&p), &[]).unwrap();
        let full = t.root.join("a.md");
        let versions = history::list(&h, &full);
        // Newest first: the replaced text with source `replace`, and before it the file as it was.
        assert_eq!(versions.iter().map(|v| v.source.as_str()).collect::<Vec<_>>(), ["replace", "disk"]);
        assert_eq!(history::read(&h, &full, versions[1].id).unwrap(), b"needle one\n");
        assert_eq!(history::read(&h, &full, versions[0].id).unwrap(), b"pin one\n");
    }

    #[test]
    fn the_index_is_told_which_files_were_written() {
        let (t, h) = setup();
        put(&t.root, "a.md", b"needle\n");
        put(&t.root, "b.md", b"needle\n");
        let q = query("needle");
        let p = preview(&t, None, &q, Some("pin")).unwrap();
        let mut chosen = all(&p);
        chosen.truncate(1);
        let (_, written) = apply(&t, &h, &q, "pin", &chosen, &[]).unwrap();
        assert_eq!(written.paths, [t.root.join("a.md")]);
        assert_eq!(contain::resolved_rel(&t.root, &written.paths[0]).as_deref(), Some("a.md"));
    }

    #[test]
    fn a_file_changed_after_the_preview_is_skipped_and_the_others_are_written() {
        let (t, h) = setup();
        put(&t.root, "a.md", b"needle a\n");
        put(&t.root, "b.md", b"needle b\n");
        let q = query("needle");
        let p = preview(&t, None, &q, Some("pin")).unwrap();
        put(&t.root, "a.md", b"needle a, edited elsewhere\n");
        let (a, _) = apply(&t, &h, &q, "pin", &all(&p), &[]).unwrap();
        assert_eq!(a.done.iter().map(|d| d.path.as_str()).collect::<Vec<_>>(), ["b.md"]);
        assert_eq!(a.skipped, [Skipped { path: "a.md".into(), why: "it changed after the preview".into() }]);
        assert_eq!(read(&t.root, "a.md"), b"needle a, edited elsewhere\n");
        assert_eq!(read(&t.root, "b.md"), b"pin b\n");
    }

    #[test]
    fn a_file_with_unsaved_edits_in_a_tab_is_skipped() {
        let (t, h) = setup();
        put(&t.root, "Open.md", b"needle\n");
        put(&t.root, "other.md", b"needle\n");
        let q = query("needle");
        let p = preview(&t, None, &q, Some("pin")).unwrap();
        let (a, _) = apply(&t, &h, &q, "pin", &all(&p), &["open.md".to_string()]).unwrap();
        assert_eq!(a.done.iter().map(|d| d.path.as_str()).collect::<Vec<_>>(), ["other.md"]);
        assert!(a.skipped[0].why.contains("unsaved edits"));
        assert_eq!(read(&t.root, "Open.md"), b"needle\n");
    }

    fn doc(notebook: &str, path: &str, unsaved: bool) -> OpenDoc {
        OpenDoc { notebook: notebook.into(), path: path.into(), unsaved }
    }

    // Codex review of 7320d7f, NOTES-4: a folder searched as an Other Folder can also be, or hold, a notebook. A page open in
    // that notebook is named by the notebook's own path, which is not the path below the folder.
    #[test]
    fn an_open_page_is_matched_to_the_scopes_file_by_where_it_resolves_not_by_its_notebook_path() {
        let (t, h) = setup();
        put(&t.root, "Notes/a.md", b"needle\n");
        put(&t.root, "Notes/b.md", b"needle\n");
        let notebook = t.root.join("Notes");
        // Notebook `nb-1` is the Notes folder: its page `a.md` is the scope's `Notes/a.md`.
        let open = vec![doc("nb-1", "a.md", true), doc("nb-1", "b.md", false), doc("nb-2", "elsewhere.md", true)];
        let nowhere = scratch();
        let below = docs_below(&t.root, open, |d| if d.notebook == "nb-1" { Some(notebook.join(&d.path)) } else { Some(nowhere.join(&d.path)) });
        assert_eq!(unsaved_of(&below), ["Notes/a.md"]);
        let q = query("needle");
        let p = preview(&t, None, &q, Some("pin")).unwrap();
        let (mut a, _) = apply(&t, &h, &q, "pin", &all(&p), &unsaved_of(&below)).unwrap();
        assert_eq!(a.done.iter().map(|d| d.path.as_str()).collect::<Vec<_>>(), ["Notes/b.md"]);
        assert!(a.skipped[0].path == "Notes/a.md" && a.skipped[0].why.contains("unsaved edits"));
        assert_eq!(read(&t.root, "Notes/a.md"), b"needle\n");
        // The page that was written is named, so its tab reads the file again; the skipped one is not.
        a.reread = reread_of(&below, &a);
        assert_eq!(a.reread, [Reread { notebook: "nb-1".into(), path: "b.md".into() }]);
    }

    #[test]
    fn a_document_outside_the_scope_is_neither_unsaved_nor_reread_in_it() {
        let (t, _) = setup();
        let other = scratch();
        put(&other, "a.md", b"x");
        let below = docs_below(&t.root, vec![doc("nb-9", "a.md", true)], |d| Some(other.join(&d.path)));
        assert!(below.is_empty());
        let none = docs_below(&t.root, vec![doc("lm:d:n", "a.md", true)], |_| None);
        assert!(none.is_empty());
    }

    #[test]
    fn a_text_file_hivemind_cannot_write_back_is_listed_and_untouched() {
        let (t, h) = setup();
        put(&t.root, "mixed.txt", b"needle\r\nline\nend\n");
        put(&t.root, "latin.txt", b"caf\xc3\xa9 na\xc3\xafve needle \xff\n");
        let q = query("needle");
        let p = preview(&t, None, &q, Some("pin")).unwrap();
        assert!(p.files.is_empty());
        assert_eq!(p.skipped.len(), 2, "{:?}", p.skipped);
        let _ = (&h, &t);
    }

    #[test]
    fn the_match_limit_stops_the_search_and_says_so() {
        let (t, _) = setup();
        let line = "needle needle needle needle needle needle needle needle needle needle\n";
        put(&t.root, "a.txt", line.repeat(600).as_bytes());
        put(&t.root, "b.txt", line.repeat(600).as_bytes());
        let p = preview(&t, None, &query("needle"), Some("x")).unwrap();
        assert_eq!((p.matches, p.capped), (MAX_MATCHES, true));
        assert_eq!(p.files.iter().map(|f| f.matches).sum::<usize>(), MAX_MATCHES);
        assert_eq!(p.files.len(), 2);
        assert_eq!(p.files[1].matches, MAX_MATCHES - 6000);
        let small = preview(&t, None, &query("needle needle needle needle needle needle needle needle needle needle"), None).unwrap();
        assert!(!small.capped);
    }

    #[test]
    fn undo_all_restores_each_file_and_skips_one_changed_since() {
        let (t, h) = setup();
        put(&t.root, "a.md", b"needle a\n");
        put(&t.root, "b.md", b"needle b\r\n");
        put(&t.root, "c.md", b"needle c\n");
        let q = query("needle");
        let p = preview(&t, None, &q, Some("pin")).unwrap();
        let (a, w) = apply(&t, &h, &q, "pin", &all(&p), &[]).unwrap();
        assert_eq!(a.done.len(), 3);
        // b changes after the replace; c has unsaved edits when undo runs.
        put(&t.root, "b.md", b"pin b, then my own edit\r\n");
        let (u, back) = undo(&t, &h, &w.undo, &["c.md".to_string()]);
        assert_eq!(u.done.iter().map(|d| d.path.as_str()).collect::<Vec<_>>(), ["a.md"]);
        assert_eq!(u.skipped.iter().map(|s| (s.path.as_str(), s.why.as_str())).collect::<Vec<_>>(), [("b.md", "it changed after the replace"), ("c.md", "it has unsaved edits in a tab; save or discard them first")]);
        assert_eq!(back.paths, [t.root.join("a.md")]);
        assert_eq!(read(&t.root, "a.md"), b"needle a\n");
        assert_eq!(read(&t.root, "b.md"), b"pin b, then my own edit\r\n");
        assert_eq!(read(&t.root, "c.md"), b"pin c\n");
        // The undo is itself kept in the history, as a restore.
        let versions = history::list(&h, &t.root.join("a.md"));
        assert_eq!(versions[0].source, "restore");
        // Undone files are exactly as before, byte for byte, with the line endings they had.
        let (t2, h2) = setup();
        put(&t2.root, "x.txt", b"\xEF\xBB\xBFneedle\r\nlast");
        let p = preview(&t2, None, &q, Some("pin")).unwrap();
        let (_, w) = apply(&t2, &h2, &q, "pin", &all(&p), &[]).unwrap();
        undo(&t2, &h2, &w.undo, &[]);
        assert_eq!(read(&t2.root, "x.txt"), b"\xEF\xBB\xBFneedle\r\nlast");
    }

    #[test]
    fn a_set_of_undos_is_used_once() {
        let undos = Undos::default();
        let id = undos.keep(Scope { notebook: Some("nb-1".into()), ..Default::default() }, vec![Undo { path: "a".into(), before: "1".into(), after: "2".into() }]);
        assert!(undos.take(&id).is_some());
        assert!(undos.take(&id).is_none());
        for _ in 0..KEEP_UNDOS + 3 {
            undos.keep(Scope::default(), vec![]);
        }
        assert_eq!(undos.sets.lock().unwrap().len(), KEEP_UNDOS);
    }

    #[test]
    fn a_link_out_of_the_folder_is_not_searched_or_written() {
        let (t, h) = setup();
        let outside = scratch();
        put(&outside, "secret.md", b"needle\n");
        put(&t.root, "in.md", b"needle\n");
        let link = t.root.join("link");
        let made = std::process::Command::new("cmd").args(["/d", "/c", "mklink", "/J"]).arg(&link).arg(&outside).output();
        if !made.is_ok_and(|o| o.status.success()) {
            eprintln!("skipped: mklink /J is not available here");
            return;
        }
        let q = query("needle");
        let p = preview(&t, None, &q, Some("x")).unwrap();
        assert_eq!(paths(&p), ["in.md"]);
        let sha = files::sha256(b"needle\n");
        let (a, _) = apply(&t, &h, &q, "x", &[Chosen { path: "link/secret.md".into(), sha256: sha, hunks: vec![0] }], &[]).unwrap();
        assert_eq!(a.done.len(), 0);
        assert_eq!(read(&outside, "secret.md"), b"needle\n");
    }
}
