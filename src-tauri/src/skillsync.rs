//! Two-way sync between a skill and the runbook note it is linked to (CON-16).
//!
//! The mapping is by heading. The note's lead paragraph (before the first `## ` or callout) is the skill's description, and
//! every `## ` section maps to the same heading in the skill body, `Details` included. `## Links`, `## Action items` and the
//! `> **Important:**` callout belong to the note only: never copied to the skill, never dropped from the note.
//!
//! A pass reads the note, compares it and the skill with what both held at the last sync (`Link`), and moves the side that
//! changed: a note change becomes a new skill version, published at once; a skill change (a new version, or a copy edited
//! outside Hivemind) is written to the note with `--expected-revision`. Both changed, or a stale revision, pauses sync for
//! that skill with both texts, and the user chooses (`resolve`). Nothing else loops: after a write the base is read back from
//! the note (Living Memory reorders sections), so the next pass finds nothing changed.
use crate::agent::now_ms;
use crate::skills::{self, Change, LedgerEntry, Link, Meta, Pause, Skills, Text};
use notify_debouncer_mini::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use std::collections::BTreeSet;
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

/// Who the ledger names for what sync does on its own.
const ACTOR: &str = "sync";

/// A note as `read` reports it.
#[derive(Clone, Debug, PartialEq)]
pub struct NoteRead {
    pub id: String,
    pub domain: String,
    pub title: String,
    pub note_type: String,
    pub status: String,
    pub body: String,
    pub revision: String,
    /// The body was cut at Living Memory's read limit: never a base for a write.
    pub truncated: bool,
}

/// What a skill's text changes in a note: `--summary`, one `--section` per section, `--drop-section` per removed one.
#[derive(Clone, Debug, PartialEq)]
pub struct Update {
    pub summary: String,
    pub sections: Vec<(String, String)>,
    pub drops: Vec<String>,
}

pub enum Written {
    Ok,
    /// The note changed since `expected_revision`.
    Stale,
}

/// Living Memory, as sync needs it. `note` is a `domain:id` ref.
pub trait NoteStore {
    /// None when there is no such note.
    fn read(&self, note: &str) -> Result<Option<NoteRead>, String>;
    fn update(&self, note: &str, update: &Update, expected_revision: &str) -> Result<Written, String>;
}

/// The skill body has text above its first `## ` heading, which has no section of the note to go to.
#[derive(Debug, PartialEq)]
pub struct LooseText;

/// Which linked skills a trigger covers.
#[derive(Clone, Debug, PartialEq)]
pub enum Scope {
    All,
    /// Skills whose note is in one of these domains.
    Domains(Vec<String>),
    /// These skills, by name.
    Names(Vec<String>),
}

impl Scope {
    /// The one scope that covers both: names and domains of the same kind are joined, anything with All is All, and a
    /// domains scope with a names scope is All (a wider pass is only a few more reads).
    pub fn merge(self, other: Scope) -> Scope {
        fn union(mut a: Vec<String>, b: Vec<String>) -> Vec<String> {
            for item in b {
                if !a.contains(&item) {
                    a.push(item);
                }
            }
            a
        }
        match (self, other) {
            (Scope::Names(a), Scope::Names(b)) => Scope::Names(union(a, b)),
            (Scope::Domains(a), Scope::Domains(b)) => Scope::Domains(union(a, b)),
            _ => Scope::All,
        }
    }
}

/// Keeps triggers from piling up: at most one pass running and one waiting. A trigger that arrives while a pass runs
/// merges its scope into the waiting one. Never held while a pass runs, so it takes no part in the lock order.
#[derive(Default)]
pub struct Queue {
    state: std::sync::Mutex<(bool, Option<Scope>)>,
}

impl Queue {
    /// Some(scope) when the caller should run a pass now (and call `next` when it ends); None when a pass is running, the
    /// scope having been queued for after it.
    pub fn submit(&self, scope: Scope) -> Option<Scope> {
        let mut state = self.state.lock().unwrap();
        if state.0 {
            state.1 = Some(match state.1.take() {
                Some(queued) => queued.merge(scope),
                None => scope,
            });
            return None;
        }
        state.0 = true;
        Some(scope)
    }

    /// After a pass: the queued scope to run next, or None when the queue is idle again.
    pub fn next(&self) -> Option<Scope> {
        let mut state = self.state.lock().unwrap();
        let queued = state.1.take();
        state.0 = queued.is_some();
        queued
    }
}

struct Parsed {
    lead: String,
    sections: Vec<(String, String)>,
}

/// An opening code fence: its character and length.
fn fence(line: &str) -> Option<(char, usize)> {
    let rest = line.trim_start_matches(' ');
    if line.len() - rest.len() > 3 {
        return None;
    }
    let c = rest.chars().next().filter(|c| *c == '`' || *c == '~')?;
    let n = rest.chars().take_while(|x| *x == c).count();
    (n >= 3).then_some((c, n))
}

fn heading(line: &str) -> Option<&str> {
    let rest = line.trim_end().strip_prefix("##")?;
    if !rest.starts_with(char::is_whitespace) {
        return None;
    }
    Some(rest.trim()).filter(|h| !h.is_empty())
}

/// `> **Important:** ...`, the older `> ℹ️ **Important Note:** ...`, or `> Important: ...`; a plain quote that starts with the
/// word stays a quote.
fn callout(line: &str) -> bool {
    let Some(rest) = line.trim_start().strip_prefix('>') else { return false };
    let rest = rest.trim_start();
    let rest = rest.strip_prefix("ℹ\u{fe0f}").or_else(|| rest.strip_prefix('ℹ')).unwrap_or(rest).trim_start();
    let bold = rest.starts_with("**");
    let rest = rest.trim_start_matches('*').trim_start().to_lowercase();
    let Some(rest) = rest.strip_prefix("important") else { return false };
    let rest = rest.strip_prefix(" note").unwrap_or(rest).trim_start();
    bold || rest.starts_with(':')
}

/// Lines without the blank ones at both ends.
fn trimmed(lines: &[&str]) -> String {
    let start = lines.iter().position(|l| !l.trim().is_empty()).unwrap_or(lines.len());
    let end = lines.iter().rposition(|l| !l.trim().is_empty()).map_or(start, |i| i + 1);
    lines[start..end].join("\n").trim_end().to_string()
}

/// Split a body into its lead and `## ` sections. Headings inside code fences are text. With `callouts`, the note's
/// `> **Important:**` callout (and the `>` lines that continue it) is left out.
fn parse_body(text: &str, callouts: bool) -> Parsed {
    let text = text.replace("\r\n", "\n");
    let mut blocks: Vec<(Option<String>, Vec<&str>)> = vec![(None, vec![])];
    let (mut open, mut in_callout) = (None::<(char, usize)>, false);
    for line in text.split('\n') {
        if let Some((c, n)) = open {
            blocks.last_mut().unwrap().1.push(line);
            if fence(line).is_some_and(|(x, m)| x == c && m >= n) && line.trim().chars().all(|x| x == c) {
                open = None;
            }
            continue;
        }
        if in_callout && (line.trim_start().starts_with('>') || line.trim().is_empty()) {
            continue;
        }
        in_callout = false;
        if let Some(f) = fence(line) {
            open = Some(f);
        } else if callouts && callout(line) {
            in_callout = true;
            continue;
        } else if let Some(h) = heading(line) {
            blocks.push((Some(h.to_string()), vec![]));
            continue;
        }
        blocks.last_mut().unwrap().1.push(line);
    }
    let lead = trimmed(&blocks[0].1);
    Parsed { lead, sections: blocks.into_iter().skip(1).filter_map(|(h, lines)| Some((h?, trimmed(&lines)))).collect() }
}

/// Letters and single spaces only, as Living Memory compares layout headings.
fn letters(heading: &str) -> String {
    heading.to_lowercase().chars().filter(|c| c.is_ascii_lowercase() || *c == ' ').collect::<String>().split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Sections of the note that never reach the skill. `Summary` and `Important` are headings Living Memory reads as the summary
/// and the callout, so a section by that name could not be written back.
fn note_only(heading: &str) -> bool {
    matches!(letters(heading).as_str(), "links" | "resource links" | "action items" | "summary" | "executive summary" | "important" | "important note")
}

/// A heading as Living Memory matches it: without case or punctuation, and "Key Details" is "Details".
fn same(heading: &str) -> String {
    if matches!(letters(heading).as_str(), "details" | "key details") {
        return "details".into();
    }
    heading.to_lowercase().chars().map(|c| if c.is_alphanumeric() || c == '_' { c } else { ' ' }).collect::<String>().split_whitespace().collect::<Vec<_>>().join(" ")
}

/// A note's text as a skill's: the lead is the description, the sections (minus the note-only ones, and empty ones) the
/// body, in the note's order. Unlike `skills::from_note` it adds nothing, so the same note always maps to the same text.
pub fn note_to_skill(note_body: &str) -> Text {
    let note = parse_body(note_body, true);
    let body = note.sections.iter().filter(|(h, t)| !note_only(h) && !t.is_empty()).map(|(h, t)| format!("## {h}\n{t}")).collect::<Vec<_>>().join("\n\n");
    Text { description: note.lead, body }
}

/// What writing a skill's text to the note changes. Sections the note has and the skill lacks (or holds empty) are dropped,
/// except the note-only ones. Text above the skill's first heading has nowhere to go.
pub fn skill_to_update(text: &Text, current_note_body: &str) -> Result<Update, LooseText> {
    let skill = parse_body(&text.body, false);
    if !skill.lead.is_empty() {
        return Err(LooseText);
    }
    let sections: Vec<(String, String)> = skill.sections.into_iter().filter(|(h, t)| !note_only(h) && !t.is_empty()).collect();
    let mut drops: Vec<String> = vec![];
    for (heading, _) in parse_body(current_note_body, true).sections {
        if !note_only(&heading) && !sections.iter().any(|(h, _)| same(h) == same(&heading)) && !drops.iter().any(|d| same(d) == same(&heading)) {
            drops.push(heading);
        }
    }
    Ok(Update { summary: text.description.trim().to_string(), sections, drops })
}

/// One digest for both sides: of the description and the body, with line endings and edge whitespace normalized.
pub fn digest(text: &Text) -> String {
    skills::sha256(&format!("{}\n\u{1f}\n{}", text.description.trim(), text.body.replace("\r\n", "\n").trim()))
}

fn note_ref(link: &Link) -> String {
    format!("{}:{}", link.domain, link.note)
}

/// Whether sync may use this note: active, a runbook, and read whole.
fn usable(note: &NoteRead) -> Result<(), String> {
    if note.status != "active" {
        return Err(format!("The note is {}, not active", note.status));
    }
    if note.note_type != "runbook" {
        return Err(format!("The note is a {} note, not a runbook", note.note_type));
    }
    Ok(())
}

const TOO_LONG: &str = "The note is longer than Living Memory returns in one read, so it cannot be synced";

/// The skill's text now: an edited copy when there is one, else the current version.
fn skill_text(s: &Skills, meta: &Meta, edited: &[(PathBuf, String)]) -> Result<Text, String> {
    let raw = match edited.first() {
        Some((_, text)) => text.clone(),
        None => s.version_text(&meta.name, meta.version)?,
    };
    let (description, body) = skills::parse(&raw);
    Ok(Text { description, body })
}

/// A publish that failed after a version was stored is not a sync failure: the version is kept and the ledger says so.
fn warn(s: &Skills, name: &str, published: Result<Vec<String>, String>) {
    if let Err(e) = published {
        let _ = s.ledger(LedgerEntry { detail: Some(e), ..LedgerEntry::new(ACTOR, "sync_warning", name) });
    }
}

/// Pause sync for a skill. Returns whether the skill changed (it did not if it moved since `seen`).
fn pause(s: &Skills, name: &str, seen: &Link, kind: &str, reason: &str, note_text: Option<Text>, skill_text: Option<Text>) -> Result<bool, String> {
    let changed = s.guarded(name, Some(seen), None, |mut meta| {
        meta.link = Some(Link { paused: Some(Pause { kind: kind.into(), reason: reason.into(), at: now_ms(), note_text, skill_text }), ..seen.clone() });
        s.save_meta(&meta)?;
        s.ledger(LedgerEntry { version: Some(meta.version), detail: Some(reason.into()), ..LedgerEntry::new(ACTOR, "sync_paused", name) })
    })?;
    Ok(changed.is_some())
}

enum WriteBack {
    Done,
    Stale,
}

/// Write the skill's text to the note, guarded by `expected_revision`, then read the note back: Living Memory reorders and
/// reformats, so the new base is what the note holds now, never what was sent. `version` is the skill version written.
fn write_back(s: &Skills, notes: &dyn NoteStore, name: &str, seen: &Link, update: &Update, expected_revision: &str, version: u32) -> Result<WriteBack, String> {
    let reference = note_ref(seen);
    if matches!(notes.update(&reference, update, expected_revision)?, Written::Stale) {
        return Ok(WriteBack::Stale);
    }
    let after = notes.read(&reference)?.ok_or("The note was not found after it was updated")?;
    let next = Link { revision: after.revision.clone(), note_digest: digest(&note_to_skill(&after.body)), version, paused: None, ..seen.clone() };
    s.guarded(name, Some(seen), None, |mut meta| {
        meta.link = Some(next);
        s.save_meta(&meta)?;
        s.ledger(LedgerEntry { version: Some(version), revision: Some(after.revision), ..LedgerEntry::new(ACTOR, "write_back", name) })
    })?;
    Ok(WriteBack::Done)
}

/// One pass for one skill: true when it changed anything (a version, the note, or a new pause).
fn pass(s: &Skills, notes: &dyn NoteStore, name: &str) -> Result<bool, String> {
    let Some(meta) = s.meta(name) else { return Ok(false) };
    let Some(link) = meta.link.clone() else { return Ok(false) };
    if meta.archived || link.paused.is_some() {
        return Ok(false);
    }
    let Some(note) = notes.read(&note_ref(&link))? else {
        return pause(s, name, &link, "note_missing", "The note no longer exists", None, None);
    };
    if let Err(reason) = usable(&note) {
        return pause(s, name, &link, "note_missing", &reason, None, None);
    }
    let note_text = note_to_skill(&note.body);
    if note.truncated {
        return pause(s, name, &link, "invalid_note", TOO_LONG, Some(note_text), None);
    }
    let note_changed = digest(&note_text) != link.note_digest;
    let edited = s.edited_copies(&meta);
    if let Some((first, text)) = edited.first()
        && let Some((other, _)) = edited.iter().find(|(_, t)| t != text)
    {
        let reason = format!("{} and {} were edited differently", first.display(), other.display());
        return pause(s, name, &link, "copies_differ", &reason, Some(note_text), Some(skill_text(s, &meta, &edited)?));
    }
    let skill_changed = meta.version != link.version || !edited.is_empty();
    match (note_changed, skill_changed) {
        (false, false) => {
            if note.revision != link.revision {
                let next = Link { revision: note.revision.clone(), ..link.clone() };
                s.guarded(name, Some(&link), None, |mut meta| {
                    meta.link = Some(next);
                    s.save_meta(&meta)
                })?;
            }
            Ok(false)
        }
        (true, true) => {
            let skill = skill_text(s, &meta, &edited)?;
            pause(s, name, &link, "conflict", "The note and the skill both changed since the last sync", Some(note_text), Some(skill))
        }
        (true, false) => {
            if let Err(e) = skills::check_body(&note_text.description, &note_text.body) {
                return pause(s, name, &link, "invalid_note", &e, Some(note_text), None);
            }
            let next = Link { revision: note.revision.clone(), note_digest: digest(&note_text), ..link.clone() };
            let change = Change { actor: ACTOR, action: "sync_from_note", proposal: None, source: (None, None), revision: Some(&note.revision), link: Some(next) };
            let written = s.guarded(name, Some(&link), Some(meta.version), |_| {
                let version = s.write_version(name, &note_text.description, &note_text.body, change)?;
                warn(s, name, s.publish_copies(name, ACTOR));
                Ok(version)
            })?;
            Ok(written.is_some())
        }
        (false, true) => {
            let skill = skill_text(s, &meta, &edited)?;
            let update = match skill_to_update(&skill, &note.body) {
                Ok(update) => update,
                Err(LooseText) => return pause(s, name, &link, "loose_text", "The skill has text above its first heading", Some(note_text), Some(skill)),
            };
            if let Err(e) = skills::check_body(&skill.description, &skill.body) {
                return pause(s, name, &link, "invalid_skill", &e, Some(note_text), Some(skill));
            }
            let version = if edited.is_empty() {
                meta.version
            } else {
                let imported = s.guarded(name, Some(&link), Some(meta.version), |meta| {
                    s.clear_edited(&meta)?;
                    let change = Change { actor: ACTOR, action: "import", proposal: None, source: (None, None), revision: None, link: None };
                    let version = s.write_version(name, &skill.description, &skill.body, change)?;
                    warn(s, name, s.publish_copies(name, ACTOR));
                    Ok(version)
                })?;
                let Some(version) = imported else { return Ok(false) };
                version
            };
            match write_back(s, notes, name, &link, &update, &note.revision, version)? {
                WriteBack::Done => Ok(true),
                WriteBack::Stale => {
                    let latest = notes.read(&note_ref(&link))?.map(|n| note_to_skill(&n.body)).unwrap_or(note_text);
                    pause(s, name, &link, "conflict", "The note changed while the skill was being written to it", Some(latest), Some(skill))?;
                    Ok(true)
                }
            }
        }
    }
}

/// Run a pass over the linked skills in `scope`, one at a time. A skill whose pass fails (Living Memory unreachable) is left
/// for the next trigger. Returns how many skills changed.
pub fn sync(s: &Skills, notes: &dyn NoteStore, scope: &Scope) -> usize {
    let _one = s.sync_lock.lock().unwrap_or_else(|e| e.into_inner());
    let mut changed = 0;
    for meta in s.metas() {
        let Some(link) = meta.link.as_ref().filter(|_| !meta.archived) else { continue };
        let wanted = match scope {
            Scope::All => true,
            Scope::Domains(domains) => domains.contains(&link.domain),
            Scope::Names(names) => names.contains(&meta.name),
        };
        if !wanted {
            continue;
        }
        match pass(s, notes, &meta.name) {
            Ok(true) => changed += 1,
            Ok(false) => {}
            Err(_) => log::warn!("skill sync: a skill pass failed"),
        }
    }
    changed
}

/// Link an existing skill to a runbook note. Linked in step when the note maps to the skill's current text; otherwise linked
/// but paused as a conflict, with both texts for the user to choose.
pub fn link(s: &Skills, notes: &dyn NoteStore, name: &str, note_ref_in: &str) -> Result<(), String> {
    let _one = s.sync_lock.lock().unwrap_or_else(|e| e.into_inner());
    let meta = s.meta(name).ok_or_else(|| format!("There is no skill named {name}"))?;
    if meta.archived {
        return Err(format!("{name} is archived"));
    }
    if meta.link.is_some() {
        return Err(format!("{name} is already linked to a note; unlink it first"));
    }
    let note = notes.read(note_ref_in)?.ok_or_else(|| format!("There is no note {note_ref_in}"))?;
    usable(&note)?;
    if note.truncated {
        return Err(TOO_LONG.into());
    }
    let (description, body) = skills::parse(&s.version_text(name, meta.version)?);
    let skill = Text { description, body };
    let mapped = note_to_skill(&note.body);
    let paused = (digest(&skill) != digest(&mapped)).then(|| Pause {
        kind: "conflict".into(), reason: "The skill and the note differ".into(), at: now_ms(), note_text: Some(mapped.clone()), skill_text: Some(skill),
    });
    let reason = paused.as_ref().map(|p| p.reason.clone());
    let reference = format!("{}:{}", note.domain, note.id);
    let link = Link { note: note.id.clone(), domain: note.domain.clone(), title: note.title.clone(), revision: note.revision.clone(), note_digest: digest(&mapped), version: meta.version, paused };
    s.guarded(name, None, Some(meta.version), |mut meta| {
        if !meta.notes.iter().any(|n| n == &reference || n.contains(&note.id)) {
            meta.notes.push(reference);
        }
        meta.link = Some(link);
        s.save_meta(&meta)?;
        s.ledger(LedgerEntry { detail: Some(note.title.clone()), ..LedgerEntry::new("user", "link", name) })?;
        match reason {
            Some(reason) => s.ledger(LedgerEntry { detail: Some(reason), ..LedgerEntry::new(ACTOR, "sync_paused", name) }),
            None => Ok(()),
        }
    })?
    .ok_or_else(|| format!("{name} changed while it was being linked; try again"))
}

pub fn unlink(s: &Skills, name: &str) -> Result<(), String> {
    let _one = s.sync_lock.lock().unwrap_or_else(|e| e.into_inner());
    s.unlink(name, "user")
}

/// The user's choice for a paused skill: "note" (the note's text replaces the skill's), "skill" (the skill's replaces the
/// note's), "merge" (the given text replaces both) or "unlink".
pub fn resolve(s: &Skills, notes: &dyn NoteStore, name: &str, action: &str, description: Option<String>, body: Option<String>) -> Result<(), String> {
    let _one = s.sync_lock.lock().unwrap_or_else(|e| e.into_inner());
    let meta = s.meta(name).ok_or_else(|| format!("There is no skill named {name}"))?;
    let link = meta.link.clone().ok_or_else(|| format!("{name} is not linked to a note"))?;
    if action == "unlink" {
        return s.unlink(name, "user");
    }
    if meta.archived {
        return Err(format!("{name} is archived"));
    }
    // A note_missing pause is settled the same way once the note is usable again; until then the read says why not.
    let note = notes.read(&note_ref(&link))?.ok_or("The note was not found; unlink the skill")?;
    usable(&note)?;
    if note.truncated {
        return Err(TOO_LONG.into());
    }
    let moved = || format!("{name} changed while it was being resolved; try again");
    match action {
        "note" => {
            let text = note_to_skill(&note.body);
            skills::check_body(&text.description, &text.body)?;
            let next = Link { revision: note.revision.clone(), note_digest: digest(&text), paused: None, ..link.clone() };
            s.guarded(name, Some(&link), Some(meta.version), |meta| {
                s.clear_edited(&meta)?;
                let change = Change { actor: "user", action: "resolve_note", proposal: None, source: (None, None), revision: Some(&note.revision), link: Some(next) };
                let version = s.write_version(name, &text.description, &text.body, change)?;
                s.publish_copies(name, "user").map_err(|e| format!("Saved as v{version}, but not published everywhere: {e}"))?;
                Ok(())
            })?
            .ok_or_else(moved)
        }
        "skill" | "merge" => {
            let edited = s.edited_copies(&meta);
            // A merge writes the given text to every copy, so differing copies only block taking "the skill's" text.
            if action == "skill"
                && let Some((first, text)) = edited.first()
                && let Some((other, _)) = edited.iter().find(|(_, t)| t != text)
            {
                return Err(format!("{} and {} were edited differently; make them the same first", first.display(), other.display()));
            }
            let text = if action == "merge" {
                match (description, body) {
                    (Some(description), Some(body)) if !description.trim().is_empty() && !body.trim().is_empty() => Text { description, body },
                    _ => return Err("A merge needs the description and the text".into()),
                }
            } else {
                skill_text(s, &meta, &edited)?
            };
            let update = skill_to_update(&text, &note.body).map_err(|LooseText| "The skill has text above its first heading; move it under a heading".to_string())?;
            skills::check_body(&text.description, &text.body)?;
            // A skill kept as it is needs no new version unless a copy was edited; a merge always does.
            let version = if edited.is_empty() && action == "skill" {
                meta.version
            } else {
                let label = if action == "merge" { "resolve_merge" } else { "import" };
                s.guarded(name, Some(&link), Some(meta.version), |meta| {
                    s.clear_edited(&meta)?;
                    let change = Change { actor: "user", action: label, proposal: None, source: (None, None), revision: None, link: None };
                    let version = s.write_version(name, &text.description, &text.body, change)?;
                    warn(s, name, s.publish_copies(name, "user"));
                    Ok(version)
                })?
                .ok_or_else(moved)?
            };
            match write_back(s, notes, name, &link, &update, &note.revision, version)? {
                WriteBack::Done => Ok(()),
                WriteBack::Stale => Err("The note changed again while it was being saved; try again".into()),
            }
        }
        _ => Err(format!("Unknown way to resolve: {action}")),
    }
}

/// The skill a changed path belongs to, if it is `<target>/<name>/SKILL.md`.
fn skill_name(targets: &[PathBuf], path: &Path) -> Option<String> {
    targets.iter().find_map(|target| {
        let mut parts = path.strip_prefix(target).ok()?.components();
        let (Some(Component::Normal(name)), Some(Component::Normal(file)), None) = (parts.next(), parts.next(), parts.next()) else { return None };
        (file == "SKILL.md").then(|| name.to_string_lossy().into_owned())
    })
}

/// Watch the publish targets for edits to a skill's SKILL.md. A target that does not exist yet is created (publishing would
/// create it) when its parent does, so the watch never covers a CLI's whole config folder; a target whose parent is missing
/// is skipped. `on_change` gets the names of the skills whose SKILL.md changed; the caller keeps only the linked ones.
pub fn watch_targets(targets: &[PathBuf], on_change: impl Fn(Vec<String>) + Send + 'static) -> Result<Debouncer<RecommendedWatcher>, String> {
    let bases = targets.to_vec();
    let mut debouncer = new_debouncer(Duration::from_millis(400), move |result: DebounceEventResult| {
        if let Ok(events) = result {
            let names: BTreeSet<String> = events.iter().filter_map(|e| skill_name(&bases, &e.path)).collect();
            if !names.is_empty() {
                on_change(names.into_iter().collect());
            }
        }
    })
    .map_err(|e| e.to_string())?;
    for target in targets {
        if !target.exists() && target.parent().is_some_and(Path::exists) {
            std::fs::create_dir_all(target).map_err(|e| format!("Cannot create {}: {e}", target.display()))?;
        }
        if target.exists() {
            debouncer.watcher().watch(target, RecursiveMode::Recursive).map_err(|e| format!("Cannot watch {}: {e}", target.display()))?;
        }
    }
    Ok(debouncer)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::skills::{Kind, NewProposal, MARKER};
    use std::cell::RefCell;

    const NOTE: &str = "Use when the ingest worker stalls.\n\n> **Important:** Never run this in prod.\n> Second line.\n\n## When to use\nThe worker is stuck.\n\n## When not to use\nThe queue is empty.\n\n## Steps\n1. Restart it.\n\n## Check\nLag falls.\n\n## Details\n- **Owner:** ops\n\n## Links\n- [[Other note]]";

    /// A note kept as parts, rendered the way Living Memory lays one out, so a write-back reorders sections like the real one.
    struct Fake {
        note: RefCell<Option<Stored>>,
        /// Report the next update as stale, whatever revision it expects.
        stale_next: RefCell<bool>,
        updates: RefCell<Vec<Update>>,
    }
    #[derive(Clone)]
    struct Stored {
        summary: String,
        important: Option<String>,
        sections: Vec<(String, String)>,
        revision: u32,
        status: String,
        note_type: String,
    }
    impl Stored {
        fn body(&self) -> String {
            let mut parts = vec![self.summary.clone()];
            parts.extend(self.important.iter().map(|i| format!("> **Important:** {i}")));
            parts.extend(self.sections.iter().map(|(h, t)| format!("## {h}\n{t}")));
            parts.join("\n\n")
        }
    }
    impl Fake {
        fn new(body: &str) -> Fake {
            let p = parse_body(body, true);
            let important = body.lines().find(|l| callout(l)).map(|l| l.split_once("**").unwrap().1.split_once("**").unwrap().1.trim().to_string());
            let stored = Stored { summary: p.lead, important, sections: p.sections, revision: 1, status: "active".into(), note_type: "runbook".into() };
            Fake { note: RefCell::new(Some(stored)), stale_next: RefCell::new(false), updates: RefCell::new(vec![]) }
        }
        fn edit(&self, f: impl FnOnce(&mut Stored)) {
            let mut note = self.note.borrow_mut();
            let stored = note.as_mut().unwrap();
            f(stored);
            stored.revision += 1;
        }
        /// A change that is not to the text: a tag, say.
        fn touch(&self) {
            self.edit(|_| {});
        }
        fn section(&self, heading: &str) -> Option<String> {
            self.note.borrow().as_ref()?.sections.iter().find(|(h, _)| h == heading).map(|(_, t)| t.clone())
        }
        fn revision(&self) -> String {
            format!("r{}", self.note.borrow().as_ref().unwrap().revision)
        }
    }
    impl NoteStore for Fake {
        fn read(&self, _note: &str) -> Result<Option<NoteRead>, String> {
            Ok(self.note.borrow().as_ref().map(|n| NoteRead {
                id: "note-1".into(), domain: "demo".into(), title: "Restart the ingest worker".into(), note_type: n.note_type.clone(),
                status: n.status.clone(), body: n.body(), revision: format!("r{}", n.revision), truncated: false,
            }))
        }
        fn update(&self, _note: &str, update: &Update, expected_revision: &str) -> Result<Written, String> {
            if std::mem::take(&mut *self.stale_next.borrow_mut()) || expected_revision != self.revision() {
                return Ok(Written::Stale);
            }
            self.updates.borrow_mut().push(update.clone());
            self.edit(|n| {
                n.summary = update.summary.clone();
                for (h, t) in &update.sections {
                    match n.sections.iter_mut().find(|(x, _)| same(x) == same(h)) {
                        Some(found) => found.1 = t.clone(),
                        None => {
                            // New sections go before Links, as Living Memory puts them before Details, Links and Action items.
                            let at = n.sections.iter().position(|(x, _)| note_only(x)).unwrap_or(n.sections.len());
                            n.sections.insert(at, (h.clone(), t.clone()));
                        }
                    }
                }
                n.sections.retain(|(h, _)| !update.drops.iter().any(|d| same(d) == same(h)));
            });
            Ok(Written::Ok)
        }
    }

    struct Scratch(PathBuf);
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn store(name: &str) -> (Scratch, Skills, Vec<PathBuf>) {
        let root = std::env::temp_dir().join(format!("hivemind-skillsync-{name}-{}", uuid::Uuid::new_v4().simple()));
        let targets = vec![root.join("claude").join("skills"), root.join("codex").join("skills")];
        for t in &targets {
            std::fs::create_dir_all(t.parent().unwrap()).unwrap();
        }
        let skills = Skills::new(root.join("app"), targets.clone());
        (Scratch(root), skills, targets)
    }
    /// An approved, published skill named `ingest` with the text of `NOTE`, and a skill linked to that note and in step.
    fn linked(name: &str) -> (Scratch, Skills, Vec<PathBuf>, Fake) {
        let (guard, skills, targets) = store(name);
        let fake = Fake::new(NOTE);
        let text = note_to_skill(NOTE);
        let p = skills.propose(NewProposal { name: "ingest".into(), description: text.description, body: text.body, reason: "r".into(), ..Default::default() }, "user").unwrap();
        skills.decide(&p.id, true, None, "user", None).unwrap();
        link(&skills, &fake, "ingest", "demo:note-1").unwrap();
        (guard, skills, targets, fake)
    }
    fn meta(skills: &Skills) -> Meta {
        skills.meta("ingest").unwrap()
    }
    fn paused(skills: &Skills) -> Pause {
        meta(skills).link.unwrap().paused.expect("paused")
    }
    fn skill_file(targets: &[PathBuf], i: usize) -> PathBuf {
        targets[i].join("ingest").join("SKILL.md")
    }
    /// A new skill version through the reviewer's patch path.
    fn patch(skills: &Skills, find: &str, with: &str) {
        let (description, body) = skills::parse(&skills.version_text("ingest", meta(skills).version).unwrap());
        let p = skills.propose(NewProposal { kind: Some(Kind::Patch), name: "ingest".into(), description, body: body.replace(find, with), ..Default::default() }, "reviewer").unwrap();
        skills.decide(&p.id, true, None, "user", None).unwrap();
    }
    fn run(skills: &Skills, fake: &Fake) -> usize {
        sync(skills, fake, &Scope::All)
    }
    fn actions(skills: &Skills) -> Vec<String> {
        skills.history(Some("ingest")).into_iter().map(|e| e.action).collect()
    }

    #[test]
    fn a_note_maps_to_a_skill_without_its_note_only_parts() {
        let text = note_to_skill(NOTE);
        assert_eq!(text.description, "Use when the ingest worker stalls.");
        assert_eq!(text.body, "## When to use\nThe worker is stuck.\n\n## When not to use\nThe queue is empty.\n\n## Steps\n1. Restart it.\n\n## Check\nLag falls.\n\n## Details\n- **Owner:** ops");
        for gone in ["Links", "Important", "Never run", "Second line", "Other note"] {
            assert!(!text.body.contains(gone) && !text.description.contains(gone), "{gone}");
        }
        assert_eq!(note_to_skill("Lead only."), Text { description: "Lead only.".into(), body: String::new() }, "nothing is added for the missing sections");
        let legacy = note_to_skill("Lead.\n\n> ℹ️ **Important Note:** Careful.\n\n## Steps\n1. Go\n\n## Action items\n- [ ] later");
        assert_eq!((legacy.description.as_str(), legacy.body.as_str()), ("Lead.", "## Steps\n1. Go"));
        assert_eq!(note_to_skill("Lead.\n\n> Important decisions are quoted here.\n\n## Steps\n1. Go").description, "Lead.\n\n> Important decisions are quoted here.", "a plain quote is not the callout");
    }

    #[test]
    fn headings_in_code_fences_are_text() {
        let text = note_to_skill("Lead.\n\n## Steps\n```md\n## Not a section\n```\nThen stop.");
        assert_eq!(text.body, "## Steps\n```md\n## Not a section\n```\nThen stop.");
    }

    #[test]
    fn a_skill_becomes_an_update_that_keeps_the_note_only_parts() {
        let skill = note_to_skill(NOTE);
        let update = skill_to_update(&skill, NOTE).unwrap();
        assert_eq!(update.summary, "Use when the ingest worker stalls.");
        assert_eq!(update.sections.iter().map(|(h, _)| h.as_str()).collect::<Vec<_>>(), ["When to use", "When not to use", "Steps", "Check", "Details"]);
        assert!(update.drops.is_empty(), "nothing removed: {:?}", update.drops);

        let smaller = Text { body: "## When to use\nx\n\n## When not to use\ny\n\n## Steps\n\n## Links\n- sneaky".into(), ..skill };
        let update = skill_to_update(&smaller, NOTE).unwrap();
        assert_eq!(update.sections.iter().map(|(h, _)| h.as_str()).collect::<Vec<_>>(), ["When to use", "When not to use"], "an empty section and a Links section are not sent");
        assert_eq!(update.drops, ["Steps", "Check", "Details"], "emptied and removed sections go; Links never does");
    }

    #[test]
    fn text_above_the_first_heading_is_loose() {
        let loose = Text { description: "d".into(), body: "Some words.\n\n## Steps\n1. Go".into() };
        assert_eq!(skill_to_update(&loose, NOTE), Err(LooseText));
        assert!(skill_to_update(&Text { description: "d".into(), body: "   \n## Steps\n1. Go".into() }, NOTE).is_ok());
    }

    #[test]
    fn headings_match_as_living_memory_matches_them() {
        let note = "Lead.\n\n## Key Details\n- a\n\n## Roll back:\nUndo.";
        let skill = Text { description: "d".into(), body: "## Details\n- b\n\n## roll back\nUndo it.".into() };
        let update = skill_to_update(&skill, note).unwrap();
        assert!(update.drops.is_empty(), "{:?}", update.drops);
    }

    #[test]
    fn the_digest_ignores_line_endings_and_edges_only() {
        let a = Text { description: " d ".into(), body: "## A\r\nx\r\n".into() };
        let b = Text { description: "d".into(), body: "## A\nx".into() };
        assert_eq!(digest(&a), digest(&b));
        assert_ne!(digest(&a), digest(&Text { description: "d".into(), body: "## A\ny".into() }));
    }

    #[test]
    fn a_linked_skill_in_step_does_nothing() {
        let (_g, skills, _t, fake) = linked("in-step");
        assert_eq!(run(&skills, &fake), 0);
        let link = meta(&skills).link.unwrap();
        assert_eq!((link.version, link.revision.as_str(), link.paused), (1, "r1", None));
        assert!(fake.updates.borrow().is_empty());
    }

    #[test]
    fn a_note_change_becomes_a_new_version_published_at_once() {
        let (_g, skills, targets, fake) = linked("note-only");
        fake.edit(|n| n.sections[2].1 = "1. Drain it.\n2. Restart it.".into());
        assert_eq!(run(&skills, &fake), 1);
        assert_eq!(meta(&skills).version, 2);
        for i in 0..2 {
            assert!(std::fs::read_to_string(skill_file(&targets, i)).unwrap().contains("1. Drain it."));
        }
        let link = meta(&skills).link.unwrap();
        assert_eq!((link.version, link.revision.as_str()), (2, "r2"));
        let row = skills.history(Some("ingest")).into_iter().find(|e| e.action == "sync_from_note").unwrap();
        assert_eq!((row.version, row.revision.as_deref()), (Some(2), Some("r2")));
        assert_eq!(run(&skills, &fake), 0, "the publish and the new version are not a change");
        assert!(fake.updates.borrow().is_empty(), "nothing is written back to the note");
    }

    #[test]
    fn a_metadata_only_revision_is_not_a_change() {
        let (_g, skills, _t, fake) = linked("meta-only");
        fake.touch();
        assert_eq!(run(&skills, &fake), 0);
        assert_eq!(meta(&skills).version, 1);
        assert_eq!(meta(&skills).link.unwrap().revision, "r2", "the new revision is the base for the next write");
    }

    #[test]
    fn a_skill_change_is_written_back_and_does_not_ping_pong() {
        let (_g, skills, targets, fake) = linked("skill-only");
        patch(&skills, "Restart it.", "Drain, then restart it.");
        assert_eq!(run(&skills, &fake), 1);
        assert_eq!(fake.section("Steps").as_deref(), Some("1. Drain, then restart it."));
        assert_eq!(fake.updates.borrow().len(), 1);
        assert!(fake.note.borrow().as_ref().unwrap().important.is_some() && fake.section("Links").is_some(), "the note-only parts stay");
        let link = meta(&skills).link.unwrap();
        assert_eq!((link.version, link.revision.as_str()), (2, "r2"));
        assert_eq!(run(&skills, &fake), 0);
        assert_eq!(run(&skills, &fake), 0);
        assert_eq!((meta(&skills).version, fake.updates.borrow().len()), (2, 1));
        assert!(std::fs::read_to_string(skill_file(&targets, 0)).unwrap().contains("Drain, then restart it."));
        assert!(actions(&skills).contains(&"write_back".to_string()));
    }

    #[test]
    fn a_removed_skill_section_is_dropped_from_the_note() {
        let (_g, skills, _t, fake) = linked("drop");
        let (description, body) = skills::parse(&skills.version_text("ingest", 1).unwrap());
        let p = skills.propose(NewProposal { kind: Some(Kind::Patch), name: "ingest".into(), description, body: body.replace("\n\n## Details\n- **Owner:** ops", ""), ..Default::default() }, "reviewer").unwrap();
        skills.decide(&p.id, true, None, "user", None).unwrap();
        assert_eq!(run(&skills, &fake), 1);
        assert_eq!(fake.updates.borrow()[0].drops, ["Details"]);
        assert!(fake.section("Details").is_none() && fake.section("Links").is_some());
        assert_eq!(run(&skills, &fake), 0);
    }

    #[test]
    fn an_outside_edit_is_imported_written_back_and_the_other_copy_republished() {
        let (_g, skills, targets, fake) = linked("outside");
        let edited = skills::render("ingest", "Use when the ingest worker stalls.", &note_to_skill(NOTE).body.replace("Restart it.", "Restart it twice."));
        std::fs::write(skill_file(&targets, 0), edited).unwrap();
        assert_eq!(run(&skills, &fake), 1);
        assert_eq!(meta(&skills).version, 2);
        assert_eq!(fake.section("Steps").as_deref(), Some("1. Restart it twice."));
        assert!(std::fs::read_to_string(skill_file(&targets, 1)).unwrap().contains("Restart it twice."), "the other copy follows");
        assert!(skills.list(0)[0].copies.iter().all(|c| c.state == "current"));
        assert_eq!(run(&skills, &fake), 0, "no loop through the folder");
        assert!(actions(&skills).iter().any(|a| a == "import"));
    }

    #[test]
    fn two_copies_edited_differently_pause_sync() {
        let (_g, skills, targets, fake) = linked("differ");
        for (i, word) in ["once", "twice"].iter().enumerate() {
            std::fs::write(skill_file(&targets, i), skills::render("ingest", "d", &format!("## When to use\nx\n\n## When not to use\ny\n\n## Steps\nRestart {word}."))).unwrap();
        }
        assert_eq!(run(&skills, &fake), 1);
        let pause = paused(&skills);
        assert_eq!(pause.kind, "copies_differ");
        assert!(pause.note_text.is_some());
        assert_eq!(run(&skills, &fake), 0, "paused skills are left alone");
        assert!(fake.updates.borrow().is_empty());
        assert!(actions(&skills).contains(&"sync_paused".to_string()));
    }

    #[test]
    fn both_sides_changed_pauses_as_a_conflict_with_both_texts() {
        let (_g, skills, _t, fake) = linked("conflict");
        fake.edit(|n| n.sections[2].1 = "1. From the note.".into());
        patch(&skills, "Restart it.", "From the skill.");
        assert_eq!(run(&skills, &fake), 1);
        let pause = paused(&skills);
        assert_eq!(pause.kind, "conflict");
        assert!(pause.note_text.unwrap().body.contains("From the note.") && pause.skill_text.unwrap().body.contains("From the skill."));
        assert_eq!(fake.section("Steps").as_deref(), Some("1. From the note."), "nothing was overwritten");
    }

    #[test]
    fn a_stale_revision_pauses_as_a_conflict() {
        let (_g, skills, _t, fake) = linked("stale");
        patch(&skills, "Restart it.", "Drain it.");
        *fake.stale_next.borrow_mut() = true;
        assert_eq!(run(&skills, &fake), 1);
        assert_eq!(paused(&skills).kind, "conflict");
        assert!(fake.updates.borrow().is_empty());
    }

    #[test]
    fn a_note_that_fails_the_skill_checks_pauses_sync() {
        let (_g, skills, _t, fake) = linked("invalid-note");
        fake.edit(|n| n.sections.retain(|(h, _)| h != "Steps"));
        assert_eq!(run(&skills, &fake), 1);
        let pause = paused(&skills);
        assert_eq!(pause.kind, "invalid_note");
        assert!(pause.reason.contains("Steps") && pause.note_text.is_some());
        assert_eq!(meta(&skills).version, 1);
    }

    #[test]
    fn a_skill_that_fails_the_checks_or_has_loose_text_pauses_sync() {
        let (_g, skills, targets, fake) = linked("invalid-skill");
        let text = skills::render("ingest", "d", "Loose words.\n\n## When to use\nx\n\n## When not to use\ny\n\n## Steps\nz");
        std::fs::write(skill_file(&targets, 0), text).unwrap();
        assert_eq!(run(&skills, &fake), 1);
        assert_eq!(paused(&skills).kind, "loose_text");
        assert!(fake.updates.borrow().is_empty());

        let (_g2, skills2, targets2, fake2) = linked("invalid-skill-2");
        std::fs::write(skill_file(&targets2, 0), skills::render("ingest", "d", "## When to use\nx")).unwrap();
        assert_eq!(run(&skills2, &fake2), 1);
        assert_eq!(paused(&skills2).kind, "invalid_skill");
    }

    #[test]
    fn a_missing_or_resolved_note_pauses_sync() {
        let (_g, skills, _t, fake) = linked("missing");
        fake.edit(|n| n.status = "resolved".into());
        assert_eq!(run(&skills, &fake), 1);
        assert_eq!(paused(&skills).kind, "note_missing");
        assert!(resolve(&skills, &fake, "ingest", "note", None, None).unwrap_err().contains("not active"));
        fake.edit(|n| n.status = "active".into());
        resolve(&skills, &fake, "ingest", "note", None, None).unwrap();
        assert!(meta(&skills).link.unwrap().paused.is_none());
        assert_eq!(run(&skills, &fake), 0);

        let (_g2, skills2, _t2, fake2) = linked("gone");
        *fake2.note.borrow_mut() = None;
        assert_eq!(run(&skills2, &fake2), 1);
        let pause = paused(&skills2);
        assert_eq!(pause.kind, "note_missing");
        assert!(resolve(&skills2, &fake2, "ingest", "note", None, None).unwrap_err().contains("unlink"));
        resolve(&skills2, &fake2, "ingest", "unlink", None, None).unwrap();
        assert!(meta(&skills2).link.is_none());
        assert!(actions(&skills2).contains(&"unlink".to_string()));
    }

    #[test]
    fn scope_limits_which_skills_are_checked() {
        let (_g, skills, _t, fake) = linked("scope");
        fake.edit(|n| n.sections[2].1 = "1. New.".into());
        assert_eq!(sync(&skills, &fake, &Scope::Domains(vec!["other".into()])), 0);
        assert_eq!(sync(&skills, &fake, &Scope::Names(vec!["something-else".into()])), 0);
        assert_eq!(sync(&skills, &fake, &Scope::Domains(vec!["demo".into()])), 1);
    }

    #[test]
    fn approving_a_linked_proposal_links_it_and_the_first_pass_writes_the_text_to_the_note() {
        let (_g, skills, _t) = store("approve");
        let fake = Fake::new(NOTE);
        let (description, body) = skills::from_note(&fake.note.borrow().as_ref().unwrap().body());
        let mapped = note_to_skill(NOTE);
        let p = skills.propose(NewProposal {
            name: "ingest".into(), description, body, reason: "r".into(), note: Some("demo:note-1".into()), link: true, note_revision: Some("r1".into()),
            note_digest: Some(digest(&mapped)), note_domain: Some("demo".into()), note_title: Some("Restart the ingest worker".into()), ..Default::default()
        }, "user").unwrap();
        assert!(p.link);
        let approved = skills.decide(&p.id, true, Some(("Use when the worker stalls.".into(), format!("{}\n\n## Roll back\nStart it again.", mapped.body))), "user", None).unwrap();
        assert!(approved.warning.is_none());
        let link = meta(&skills).link.unwrap();
        assert_eq!((link.note.as_str(), link.domain.as_str(), link.version, link.revision.as_str(), link.paused.is_none()), ("note-1", "demo", 0, "r1", true));
        assert_eq!(meta(&skills).version, 1);
        assert_eq!(run(&skills, &fake), 1);
        assert_eq!(fake.note.borrow().as_ref().unwrap().summary, "Use when the worker stalls.");
        assert_eq!(fake.section("Roll back").as_deref(), Some("Start it again."));
        assert_eq!(meta(&skills).link.unwrap().version, 1);
        assert_eq!(run(&skills, &fake), 0);
        assert_eq!(fake.updates.borrow().len(), 1, "written once");
    }

    #[test]
    fn a_linked_proposal_meets_a_note_that_changed_meanwhile_as_a_conflict() {
        let (_g, skills, _t) = store("approve-conflict");
        let fake = Fake::new(NOTE);
        let mapped = note_to_skill(NOTE);
        let p = skills.propose(NewProposal {
            name: "ingest".into(), description: mapped.description.clone(), body: mapped.body.clone(), note: Some("demo:note-1".into()), link: true,
            note_revision: Some("r1".into()), note_digest: Some(digest(&mapped)), note_domain: Some("demo".into()), note_title: Some("t".into()), ..Default::default()
        }, "user").unwrap();
        fake.edit(|n| n.sections[2].1 = "1. Changed meanwhile.".into());
        skills.decide(&p.id, true, None, "user", None).unwrap();
        assert_eq!(run(&skills, &fake), 1);
        assert_eq!(paused(&skills).kind, "conflict");
    }

    #[test]
    fn linking_an_existing_skill_syncs_it_or_pauses_with_both_texts() {
        let (_g, skills, _t, _fake) = linked("link-equal");
        assert_eq!(meta(&skills).link.as_ref().unwrap().version, 1);
        assert!(meta(&skills).link.unwrap().paused.is_none());
        assert!(meta(&skills).notes.contains(&"demo:note-1".to_string()));
        let fake = Fake::new(NOTE);
        assert!(link(&skills, &fake, "ingest", "demo:note-1").unwrap_err().contains("already linked"));

        let (_g2, skills2, _t2) = store("link-differs");
        let p = skills2.propose(NewProposal { name: "ingest".into(), description: "Use when it stalls.".into(), body: note_to_skill(NOTE).body, ..Default::default() }, "user").unwrap();
        skills2.decide(&p.id, true, None, "user", None).unwrap();
        link(&skills2, &fake, "ingest", "demo:note-1").unwrap();
        let pause = paused(&skills2);
        assert_eq!(pause.kind, "conflict");
        assert_eq!((pause.note_text.unwrap().description.as_str(), pause.skill_text.unwrap().description.as_str()), ("Use when the ingest worker stalls.", "Use when it stalls."));
        assert_eq!(run(&skills2, &fake), 0);

        fake.edit(|n| n.note_type = "knowledge".into());
        let (_g3, skills3, _t3) = store("link-type");
        let p = skills3.propose(NewProposal { name: "ingest".into(), description: "d".into(), body: note_to_skill(NOTE).body, ..Default::default() }, "user").unwrap();
        skills3.decide(&p.id, true, None, "user", None).unwrap();
        assert!(link(&skills3, &fake, "ingest", "demo:note-1").unwrap_err().contains("not a runbook"));
    }

    #[test]
    fn resolving_with_the_notes_text_replaces_the_skill() {
        let (_g, skills, targets, fake) = linked("resolve-note");
        fake.edit(|n| n.sections[2].1 = "1. From the note.".into());
        std::fs::write(skill_file(&targets, 0), skills::render("ingest", "Use when the ingest worker stalls.", &note_to_skill(NOTE).body.replace("Restart it.", "From the copy."))).unwrap();
        assert_eq!(run(&skills, &fake), 1);
        assert_eq!(paused(&skills).kind, "conflict");
        resolve(&skills, &fake, "ingest", "note", None, None).unwrap();
        let link = meta(&skills).link.unwrap();
        assert!(link.paused.is_none());
        assert_eq!((meta(&skills).version, link.version, link.revision.as_str()), (2, 2, "r2"));
        for i in 0..2 {
            let text = std::fs::read_to_string(skill_file(&targets, i)).unwrap();
            assert!(text.contains("From the note.") && !text.contains("From the copy."));
        }
        assert_eq!(run(&skills, &fake), 0);
        assert!(fake.updates.borrow().is_empty());
        assert!(skills.history(Some("ingest")).iter().any(|e| e.action == "resolve_note" && e.revision.as_deref() == Some("r2")));
    }

    #[test]
    fn resolving_with_the_skills_text_replaces_the_note() {
        let (_g, skills, targets, fake) = linked("resolve-skill");
        fake.edit(|n| n.sections[2].1 = "1. From the note.".into());
        std::fs::write(skill_file(&targets, 0), skills::render("ingest", "Use when the ingest worker stalls.", &note_to_skill(NOTE).body.replace("Restart it.", "From the copy."))).unwrap();
        assert_eq!(run(&skills, &fake), 1);
        resolve(&skills, &fake, "ingest", "skill", None, None).unwrap();
        assert_eq!(fake.section("Steps").as_deref(), Some("1. From the copy."));
        assert!(meta(&skills).link.unwrap().paused.is_none());
        assert!(skills.list(0)[0].copies.iter().all(|c| c.state == "current"));
        assert_eq!(run(&skills, &fake), 0);

        // The note moved again between reading and writing: the user is asked to try again, and the pause stays.
        let (_g2, skills2, _t2, fake2) = linked("resolve-skill-stale");
        fake2.edit(|n| n.sections[2].1 = "1. Note.".into());
        patch(&skills2, "Restart it.", "Skill.");
        assert_eq!(run(&skills2, &fake2), 1);
        *fake2.stale_next.borrow_mut() = true;
        assert!(resolve(&skills2, &fake2, "ingest", "skill", None, None).unwrap_err().contains("try again"));
        assert_eq!(paused(&skills2).kind, "conflict");
        resolve(&skills2, &fake2, "ingest", "skill", None, None).unwrap();
        assert_eq!(fake2.section("Steps").as_deref(), Some("1. Skill."));
    }

    #[test]
    fn resolving_with_a_merge_writes_both_sides() {
        let (_g, skills, _t, fake) = linked("resolve-merge");
        fake.edit(|n| n.sections[2].1 = "1. From the note.".into());
        patch(&skills, "Restart it.", "From the skill.");
        assert_eq!(run(&skills, &fake), 1);
        assert!(resolve(&skills, &fake, "ingest", "merge", None, None).is_err());
        let loose = resolve(&skills, &fake, "ingest", "merge", Some("d".into()), Some("Loose.\n\n## When to use\nx".into())).unwrap_err();
        assert!(loose.contains("above its first heading"), "{loose}");
        let invalid = resolve(&skills, &fake, "ingest", "merge", Some("d".into()), Some("## When to use\nx".into())).unwrap_err();
        assert!(invalid.contains("When not to use"), "{invalid}");
        let merged = "## When to use\nx\n\n## When not to use\ny\n\n## Steps\n1. Both.";
        resolve(&skills, &fake, "ingest", "merge", Some("Use when merged.".into()), Some(merged.into())).unwrap();
        assert_eq!(fake.section("Steps").as_deref(), Some("1. Both."));
        assert!(fake.section("Check").is_none() && fake.section("Links").is_some());
        assert!(skills.version_text("ingest", meta(&skills).version).unwrap().contains("1. Both."));
        assert_eq!(run(&skills, &fake), 0);
        assert!(actions(&skills).contains(&"resolve_merge".to_string()));
    }

    #[test]
    fn copies_that_differ_are_settled_by_a_merge_but_not_by_taking_the_skill() {
        let (_g, skills, targets, fake) = linked("differ-merge");
        for (i, word) in ["once", "twice"].iter().enumerate() {
            std::fs::write(skill_file(&targets, i), skills::render("ingest", "d", &format!("## When to use
x

## When not to use
y

## Steps
Restart {word}."))).unwrap();
        }
        assert_eq!(run(&skills, &fake), 1);
        assert_eq!(paused(&skills).kind, "copies_differ");
        assert!(resolve(&skills, &fake, "ingest", "skill", None, None).unwrap_err().contains("edited differently"));
        let merged = "## When to use
x

## When not to use
y

## Steps
1. Restart both.";
        resolve(&skills, &fake, "ingest", "merge", Some("Use when merged.".into()), Some(merged.into())).unwrap();
        for i in 0..2 {
            assert!(std::fs::read_to_string(skill_file(&targets, i)).unwrap().contains("1. Restart both."));
        }
        assert!(skills.list(0)[0].copies.iter().all(|c| c.state == "current"));
        assert_eq!(fake.section("Steps").as_deref(), Some("1. Restart both."));
        assert!(meta(&skills).link.unwrap().paused.is_none());
        assert_eq!(run(&skills, &fake), 0);
    }

    #[test]
    fn unlinking_stops_sync_and_is_always_possible() {
        let (_g, skills, _t, fake) = linked("unlink");
        skills.archive("ingest", "user", None).unwrap();
        unlink(&skills, "ingest").unwrap();
        assert!(meta(&skills).link.is_none());
        assert!(unlink(&skills, "ingest").is_err());
        fake.edit(|n| n.sections[2].1 = "1. New.".into());
        assert_eq!(run(&skills, &fake), 0);
        assert_eq!(meta(&skills).version, 1);
    }

    #[test]
    fn an_archived_skill_is_not_synced() {
        let (_g, skills, _t, fake) = linked("archived");
        skills.archive("ingest", "user", None).unwrap();
        fake.edit(|n| n.sections[2].1 = "1. New.".into());
        assert_eq!(run(&skills, &fake), 0);
        assert!(meta(&skills).archived && meta(&skills).version == 1);
    }

    #[test]
    fn scopes_merge_into_the_widest_needed() {
        let names = |v: &[&str]| Scope::Names(v.iter().map(|s| s.to_string()).collect());
        let domains = |v: &[&str]| Scope::Domains(v.iter().map(|s| s.to_string()).collect());
        assert_eq!(names(&["a", "b"]).merge(names(&["b", "c"])), names(&["a", "b", "c"]));
        assert_eq!(domains(&["x"]).merge(domains(&["x", "y"])), domains(&["x", "y"]));
        assert_eq!(names(&["a"]).merge(Scope::All), Scope::All);
        assert_eq!(Scope::All.merge(domains(&["x"])), Scope::All);
        assert_eq!(domains(&["x"]).merge(names(&["a"])), Scope::All);
    }

    #[test]
    fn triggers_during_a_pass_queue_once_and_run_after_it() {
        let queue = Queue::default();
        let names = |s: &str| Scope::Names(vec![s.to_string()]);
        assert_eq!(queue.submit(names("a")), Some(names("a")), "idle: run now");
        assert_eq!(queue.submit(names("b")), None);
        assert_eq!(queue.submit(names("c")), None);
        assert_eq!(queue.next(), Some(Scope::Names(vec!["b".into(), "c".into()])), "the two waiting triggers run as one pass");
        assert_eq!(queue.submit(Scope::All), None, "still running that pass");
        assert_eq!(queue.next(), Some(Scope::All));
        assert_eq!(queue.next(), None);
        assert_eq!(queue.submit(names("d")), Some(names("d")), "idle again");
    }

    #[test]
    fn watching_creates_a_missing_target_but_never_watches_its_parent() {
        let (_g, _skills, targets) = store("watch");
        let orphan = _g.0.join("none").join("skills");
        assert!(!targets[0].exists());
        let _watcher = watch_targets(&[targets[0].clone(), orphan.clone()], |_| {}).unwrap();
        assert!(targets[0].is_dir(), "created, as publishing would");
        assert!(!orphan.exists() && !orphan.parent().unwrap().exists(), "a target whose parent is missing is skipped");
    }

    #[test]
    fn only_a_skill_file_in_a_target_names_a_skill() {
        let targets = vec![PathBuf::from("home").join(".claude").join("skills"), PathBuf::from("home").join(".codex").join("skills")];
        let at = |p: PathBuf| skill_name(&targets, &p);
        assert_eq!(at(targets[1].join("ingest").join("SKILL.md")).as_deref(), Some("ingest"));
        assert_eq!(at(targets[0].join("ingest").join(MARKER)), None);
        assert_eq!(at(targets[0].join("ingest").join("sub").join("SKILL.md")), None);
        assert_eq!(at(targets[0].join("SKILL.md")), None);
        assert_eq!(at(PathBuf::from("home").join(".claude").join("history.jsonl")), None);
    }

    /// A Living Memory that answers every read with an error that quotes note text.
    struct Quoting;
    impl NoteStore for Quoting {
        fn read(&self, _note: &str) -> Result<Option<NoteRead>, String> {
            Err("Cannot read: SECRET-MARKER-1 \"a private title\"".into())
        }
        fn update(&self, _note: &str, _update: &Update, _expected_revision: &str) -> Result<Written, String> {
            unreachable!()
        }
    }

    #[test]
    fn a_failed_pass_is_logged_without_the_skill_name_or_the_error() {
        crate::diagnostics::capture::install();
        let (_guard, skills, _targets, _fake) = linked("log");
        assert_eq!(sync(&skills, &Quoting, &Scope::All), 0);
        let records = crate::diagnostics::capture::records();
        assert!(records.iter().any(|r| r.contains("skill sync: a skill pass failed")), "{records:?}");
        assert!(records.iter().all(|r| !r.contains("SECRET-MARKER-1") && !r.contains("ingest") && !r.contains("private title")), "{records:?}");
    }
}
