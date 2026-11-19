//! Skills Hivemind keeps for Claude Code and Codex: a library of approved versions, proposals that wait for the user, a ledger
//! of every change, and published copies in the CLIs' skill folders. Rust decides every path; the webview names skills and
//! proposals only.
//!
//! Layout under `app_data_dir/skills`:
//! - `library/<name>/skill.json` (Meta) and `library/<name>/v<N>/SKILL.md`
//! - `proposals/<id>.json`
//! - `ledger.jsonl` (who changed what), `usage.jsonl` (which session used which skill), `outcomes.jsonl` (how sessions ended)
//!
//! A published copy is `<target>/<name>/SKILL.md` plus `.hivemind-skill.json`. Hivemind never writes or removes a folder
//! without that marker, so a skill the user made by hand is never touched.
use crate::agent::events::{RunEvent, SeqEvent};
use crate::agent::now_ms;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::io::Write;
use std::path::{Path, PathBuf};

pub const MARKER: &str = ".hivemind-skill.json";
const DAY_MS: u64 = 86_400_000;
/// Unused this long (since its last use, or since it was approved), a skill is stale.
pub const STALE_DAYS: u64 = 30;
/// Reliability under this share, across at least FLAG_USES decided sessions, flags a skill.
pub const FLAG_RELIABILITY: f64 = 0.5;
pub const FLAG_USES: usize = 4;
/// A reviewer patch applies without asking (when the setting is on) only to skills with this many approved uses.
pub const AUTO_PATCH_USES: usize = 3;
const DESCRIPTION_MAX: usize = 1024;
const BODY_MAX: usize = 40_000;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Meta {
    pub name: String,
    pub description: String,
    /// The approved version the published copies hold.
    pub version: u32,
    #[serde(default)]
    pub archived: bool,
    pub created_at: u64,
    pub updated_at: u64,
    /// Living Memory notes the skill came from or cites.
    #[serde(default)]
    pub notes: Vec<String>,
    /// Sessions whose work the skill was learned from.
    #[serde(default)]
    pub sessions: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Create,
    Patch,
    Archive,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProposalState {
    Pending,
    Approved,
    Rejected,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Proposal {
    pub id: String,
    pub kind: Kind,
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// SKILL.md without its frontmatter; empty for an archive.
    #[serde(default)]
    pub body: String,
    pub reason: String,
    /// A patch's starting point: the version the proposer saw.
    #[serde(default)]
    pub base_version: Option<u32>,
    #[serde(default)]
    pub session: Option<String>,
    #[serde(default)]
    pub session_title: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
    /// "reviewer", "upkeep" or "user".
    pub by: String,
    pub state: ProposalState,
    pub created_at: u64,
    #[serde(default)]
    pub decided_at: Option<u64>,
    #[serde(default)]
    pub decision: Option<String>,
}

/// What a proposer hands in; the store fills in the id, state and times.
#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct NewProposal {
    pub kind: Option<Kind>,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub reason: String,
    #[serde(default)]
    pub session: Option<String>,
    #[serde(default)]
    pub session_title: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LedgerEntry {
    pub at: u64,
    /// "user", "reviewer", "upkeep" or "auto".
    pub actor: String,
    pub action: String,
    pub name: String,
    #[serde(default)]
    pub version: Option<u32>,
    #[serde(default)]
    pub sha256: Option<String>,
    #[serde(default)]
    pub proposal: Option<String>,
    #[serde(default)]
    pub detail: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Use {
    at: u64,
    session: String,
    skill: String,
    engine: String,
}

/// How a session's work was judged, for reliability.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Approved,
    ChangesRequested,
    Dismissed,
    Failed,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct OutcomeRow {
    at: u64,
    session: String,
    outcome: Outcome,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct MarkerFile {
    name: String,
    version: u32,
    sha256: String,
}

/// One published copy and whether it still matches.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Copy {
    pub dir: String,
    /// "current", "older" (an earlier version Hivemind wrote), "edited" (changed outside Hivemind) or "missing".
    pub state: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SkillView {
    #[serde(flatten)]
    pub meta: Meta,
    pub body: String,
    pub versions: Vec<u32>,
    pub copies: Vec<Copy>,
    pub uses: usize,
    pub last_used: Option<u64>,
    pub approved: usize,
    /// Changes requested, discarded or failed.
    pub rejected: usize,
    /// approved / (approved + rejected); None before any decided session. A correlation, not proof.
    pub reliability: Option<f64>,
    pub stale: bool,
    pub flagged: bool,
}

pub struct Skills {
    dir: PathBuf,
    targets: Vec<PathBuf>,
    /// Held by every change (propose, decide, publish, archive, restore, import): the reviewer's threads and the user's
    /// commands share the library, and a version number is read and then written.
    lock: std::sync::Mutex<()>,
}

/// Where approved skills are published: `HIVEMIND_SKILL_DIRS` (a path list) when set, else the Claude Code and Codex
/// skill folders. A target is used only when its parent folder exists, that is, when that CLI has been set up here.
pub fn default_targets() -> Vec<PathBuf> {
    if let Some(list) = std::env::var_os("HIVEMIND_SKILL_DIRS") {
        return std::env::split_paths(&list).filter(|p| !p.as_os_str().is_empty()).collect();
    }
    dirs::home_dir().map(|home| vec![home.join(".claude").join("skills"), home.join(".codex").join("skills")]).unwrap_or_default()
}

/// Lowercase letters, digits and single hyphens, 2 to 64 characters: also a safe folder name.
pub fn check_name(name: &str) -> Result<(), String> {
    let ok = (2..=64).contains(&name.len())
        && name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !name.starts_with('-')
        && !name.ends_with('-')
        && !name.contains("--");
    if ok { Ok(()) } else { Err(format!("\"{name}\" is not a skill name: use 2 to 64 lowercase letters, digits and single hyphens")) }
}

/// A name for a title: "Restart the ingest worker" becomes "restart-the-ingest-worker".
pub fn slug(title: &str) -> String {
    let mut out = String::new();
    for c in title.chars().flat_map(char::to_lowercase) {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.is_empty() && !out.ends_with('-') {
            out.push('-');
        }
        if out.len() >= 60 {
            break;
        }
    }
    out.trim_end_matches('-').to_string()
}

/// The body sections every approved skill needs; "When not to use" keeps a skill off lookalike tasks.
pub fn check_body(description: &str, body: &str) -> Result<(), String> {
    if description.trim().is_empty() {
        return Err("A skill needs a description that says when to use it".into());
    }
    if description.chars().count() > DESCRIPTION_MAX {
        return Err(format!("The description is longer than {DESCRIPTION_MAX} characters"));
    }
    if body.len() > BODY_MAX {
        return Err(format!("The skill is longer than {BODY_MAX} characters"));
    }
    for heading in ["When to use", "When not to use", "Steps"] {
        if section(body, heading).is_none_or(|text| text.trim().is_empty()) {
            return Err(format!("A skill needs a \"## {heading}\" section with text"));
        }
    }
    Ok(())
}

/// The text under `## heading`, up to the next `## `.
fn section<'a>(body: &'a str, heading: &str) -> Option<&'a str> {
    let mut start = None;
    let mut offset = 0;
    for line in body.split_inclusive('\n') {
        let title = line.trim_end().strip_prefix("## ");
        match (start, title) {
            (None, Some(t)) if t.trim().eq_ignore_ascii_case(heading) => start = Some(offset + line.len()),
            (Some(s), Some(_)) => return Some(&body[s..offset]),
            _ => {}
        }
        offset += line.len();
    }
    start.map(|s| &body[s..])
}

/// SKILL.md as the CLIs read it. The description is a JSON string, which YAML reads as a double-quoted scalar.
pub fn render(name: &str, description: &str, body: &str) -> String {
    let description = serde_json::to_string(description.trim()).unwrap_or_default();
    format!("---\nname: {name}\ndescription: {description}\n---\n\n{}\n", body.trim())
}

/// The frontmatter's description and the body after it, for a SKILL.md edited outside Hivemind.
pub fn parse(text: &str) -> (String, String) {
    let text = text.replace("\r\n", "\n");
    let Some(rest) = text.strip_prefix("---\n") else { return (String::new(), text.trim().to_string()) };
    let Some(end) = rest.find("\n---") else { return (String::new(), text.trim().to_string()) };
    let description = rest[..end].lines().find_map(|l| l.strip_prefix("description:")).map(str::trim).unwrap_or_default();
    let description = serde_json::from_str::<String>(description).unwrap_or_else(|_| description.trim_matches(['"', '\'']).to_string());
    let body = rest[end + 4..].trim_start_matches(|c| c != '\n').trim().to_string();
    (description, body)
}

/// A note's text as a skill draft: the paragraph before the first heading becomes the description, the sections the body.
/// Missing required sections are added empty, for the user to fill in before approving.
pub fn from_note(note_body: &str) -> (String, String) {
    let text = note_body.replace("\r\n", "\n");
    let first = if text.starts_with("## ") { Some(0) } else { text.find("\n## ").map(|i| i + 1) };
    let (lead, rest) = match first {
        Some(i) => (text[..i].trim(), text[i..].trim()),
        None => (text.trim(), ""),
    };
    let mut body = rest.to_string();
    if section(&body, "When to use").is_none() {
        body = format!("## When to use\n\n{body}");
    }
    if section(&body, "When not to use").is_none() {
        // Right after "When to use", where a reader looks for it.
        let after = section(&body, "When to use").map(|s| s.as_ptr() as usize - body.as_ptr() as usize + s.len()).unwrap_or(0);
        body = format!("{}\n\n## When not to use\n\n{}", body[..after].trim_end(), body[after..].trim_start());
    }
    if section(&body, "Steps").is_none() {
        body = format!("{}\n\n## Steps\n", body.trim_end());
    }
    (lead.chars().take(DESCRIPTION_MAX).collect(), body.trim().to_string())
}

pub fn sha256(text: &str) -> String {
    Sha256::digest(text.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

fn write_atomic(path: &Path, text: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let temp = path.with_extension(format!("tmp-{}", uuid::Uuid::new_v4().simple()));
    std::fs::write(&temp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&temp, path).map_err(|e| {
        let _ = std::fs::remove_file(&temp);
        e.to_string()
    })
}

fn append_line(path: &Path, row: &impl Serialize) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let line = serde_json::to_string(row).map_err(|e| e.to_string())?;
    let mut file = std::fs::OpenOptions::new().create(true).append(true).open(path).map_err(|e| e.to_string())?;
    writeln!(file, "{line}").map_err(|e| e.to_string())
}

/// Rows of a JSON-lines file; a torn or unreadable line is skipped.
fn read_lines<T: for<'de> Deserialize<'de>>(path: &Path) -> Vec<T> {
    std::fs::read_to_string(path).unwrap_or_default().lines().filter_map(|l| serde_json::from_str(l).ok()).collect()
}

/// Skills a session used: Claude's Skill tool (plugin skills as `plugin:name`), or any tool whose input names a
/// `skills/<name>/SKILL.md` (Codex reads the file with a shell command). Only names in `known` count.
pub fn used_in(events: &[SeqEvent], known: &BTreeSet<String>) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    for event in events {
        let RunEvent::ToolUse { name, summary, .. } = &event.event else { continue };
        if name == "Skill" {
            let skill = summary.trim().rsplit(':').next().unwrap_or_default();
            if known.contains(skill) {
                out.insert(skill.to_string());
            }
            continue;
        }
        let text = summary.replace('\\', "/");
        for skill in known {
            if text.contains(&format!("skills/{skill}/SKILL.md")) {
                out.insert(skill.clone());
            }
        }
    }
    out
}

impl Skills {
    pub fn new(dir: PathBuf, targets: Vec<PathBuf>) -> Skills {
        Skills { dir, targets, lock: std::sync::Mutex::new(()) }
    }

    fn library(&self) -> PathBuf {
        self.dir.join("library")
    }
    fn meta_path(&self, name: &str) -> PathBuf {
        self.library().join(name).join("skill.json")
    }
    fn version_path(&self, name: &str, version: u32) -> PathBuf {
        self.library().join(name).join(format!("v{version}")).join("SKILL.md")
    }
    fn proposal_path(&self, id: &str) -> Result<PathBuf, String> {
        if id.len() != 32 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("Unknown proposal".into());
        }
        Ok(self.dir.join("proposals").join(format!("{id}.json")))
    }

    pub fn meta(&self, name: &str) -> Option<Meta> {
        check_name(name).ok()?;
        serde_json::from_str(&std::fs::read_to_string(self.meta_path(name)).ok()?).ok()
    }

    fn metas(&self) -> Vec<Meta> {
        let Ok(entries) = std::fs::read_dir(self.library()) else { return vec![] };
        let mut out: Vec<Meta> = entries.flatten().filter_map(|e| self.meta(&e.file_name().to_string_lossy())).collect();
        out.sort_by(|a, b| a.name.cmp(&b.name));
        out
    }

    /// The text of one approved version.
    pub fn version_text(&self, name: &str, version: u32) -> Result<String, String> {
        check_name(name)?;
        std::fs::read_to_string(self.version_path(name, version)).map_err(|_| format!("{name} has no version {version}"))
    }

    fn versions(&self, name: &str) -> Vec<u32> {
        let Ok(entries) = std::fs::read_dir(self.library().join(name)) else { return vec![] };
        let mut out: Vec<u32> = entries.flatten().filter_map(|e| e.file_name().to_string_lossy().strip_prefix('v')?.parse().ok()).collect();
        out.sort_unstable();
        out
    }

    fn ledger(&self, entry: LedgerEntry) -> Result<(), String> {
        append_line(&self.dir.join("ledger.jsonl"), &entry)
    }

    pub fn history(&self, name: Option<&str>) -> Vec<LedgerEntry> {
        let mut rows: Vec<LedgerEntry> = read_lines(&self.dir.join("ledger.jsonl"));
        rows.retain(|r| name.is_none_or(|n| r.name == n));
        rows.reverse();
        rows
    }

    /// A folder in a target that is not Hivemind's: refuse to take its name.
    fn foreign(&self, name: &str) -> Option<PathBuf> {
        self.targets.iter().map(|t| t.join(name)).find(|dir| dir.exists() && !dir.join(MARKER).exists())
    }

    pub fn propose(&self, new: NewProposal, by: &str) -> Result<Proposal, String> {
        let _lock = self.lock.lock().unwrap();
        let kind = new.kind.unwrap_or(Kind::Create);
        check_name(&new.name)?;
        let meta = self.meta(&new.name);
        match (kind, &meta) {
            (Kind::Create, Some(_)) => return Err(format!("A skill named {} exists; propose a change to it instead", new.name)),
            (Kind::Patch | Kind::Archive, None) => return Err(format!("There is no skill named {}", new.name)),
            (Kind::Patch | Kind::Archive, Some(m)) if m.archived => return Err(format!("{} is archived", new.name)),
            _ => {}
        }
        if kind == Kind::Create
            && let Some(dir) = self.foreign(&new.name)
        {
            return Err(format!("{} already holds a skill that Hivemind did not make; pick another name", dir.display()));
        }
        if kind != Kind::Archive && new.body.trim().is_empty() {
            return Err("A skill proposal needs the skill's text".into());
        }
        if self.proposals(Some(ProposalState::Pending)).iter().any(|p| p.name == new.name) {
            return Err(format!("{} already has a proposal waiting for review", new.name));
        }
        let proposal = Proposal {
            id: uuid::Uuid::new_v4().simple().to_string(),
            kind,
            name: new.name.clone(),
            description: new.description.trim().to_string(),
            body: new.body.trim().to_string(),
            reason: new.reason.trim().to_string(),
            base_version: meta.as_ref().map(|m| m.version),
            session: new.session,
            session_title: new.session_title,
            note: new.note,
            by: by.to_string(),
            state: ProposalState::Pending,
            created_at: now_ms(),
            decided_at: None,
            decision: None,
        };
        self.save_proposal(&proposal)?;
        self.ledger(LedgerEntry {
            at: proposal.created_at, actor: by.into(), action: format!("propose_{}", kind_word(kind)), name: proposal.name.clone(),
            version: None, sha256: None, proposal: Some(proposal.id.clone()), detail: Some(proposal.reason.clone()).filter(|r| !r.is_empty()),
        })?;
        Ok(proposal)
    }

    fn save_proposal(&self, p: &Proposal) -> Result<(), String> {
        write_atomic(&self.proposal_path(&p.id)?, &serde_json::to_string_pretty(p).map_err(|e| e.to_string())?)
    }

    pub fn proposal(&self, id: &str) -> Result<Proposal, String> {
        let text = std::fs::read_to_string(self.proposal_path(id)?).map_err(|_| "Unknown proposal".to_string())?;
        serde_json::from_str(&text).map_err(|e| e.to_string())
    }

    /// Newest first; `state` None lists all.
    pub fn proposals(&self, state: Option<ProposalState>) -> Vec<Proposal> {
        let Ok(entries) = std::fs::read_dir(self.dir.join("proposals")) else { return vec![] };
        let mut out: Vec<Proposal> = entries
            .flatten()
            .filter_map(|e| serde_json::from_str::<Proposal>(&std::fs::read_to_string(e.path()).ok()?).ok())
            .filter(|p| state.is_none_or(|s| p.state == s))
            .collect();
        out.sort_by_key(|p| std::cmp::Reverse(p.created_at));
        out
    }

    /// Approve (optionally with the user's edits) or reject a proposal. Approving a create or patch writes a new version and
    /// publishes it; approving an archive removes the published copies and keeps the library.
    pub fn decide(&self, id: &str, approve: bool, edit: Option<(String, String)>, actor: &str, why: Option<String>) -> Result<Proposal, String> {
        let _lock = self.lock.lock().unwrap();
        let mut p = self.proposal(id)?;
        if p.state != ProposalState::Pending {
            return Err("This proposal was already decided".into());
        }
        // A proposal is about the skill as it was; one made before another change landed would undo that change.
        let now = self.meta(&p.name).map(|m| m.version);
        if approve && p.kind != Kind::Create && now != p.base_version {
            return Err(format!("{} changed since this proposal (now v{}); reject it and propose again", p.name, now.unwrap_or(0)));
        }
        if approve && p.kind == Kind::Create && now.is_some() {
            return Err(format!("A skill named {} exists now; reject this proposal", p.name));
        }
        if let Some((description, body)) = edit {
            p.description = description.trim().to_string();
            p.body = body.trim().to_string();
        }
        let mut written = None;
        if approve {
            match p.kind {
                Kind::Archive => self.archive_copies(&p.name, actor, Some(&p.id))?,
                Kind::Create | Kind::Patch => {
                    check_body(&p.description, &p.body)?;
                    let action = format!("approve_{}", kind_word(p.kind));
                    let source = (p.session.clone(), p.note.clone());
                    written = Some(self.write_version(&p.name, &p.description, &p.body, Change { actor, action: &action, proposal: Some(&p.id), source })?);
                }
            }
        } else {
            self.ledger(LedgerEntry {
                at: now_ms(), actor: actor.into(), action: "reject".into(), name: p.name.clone(), version: None, sha256: None,
                proposal: Some(p.id.clone()), detail: why.clone(),
            })?;
        }
        p.state = if approve { ProposalState::Approved } else { ProposalState::Rejected };
        p.decided_at = Some(now_ms());
        p.decision = why;
        self.save_proposal(&p)?;
        // The version is approved and stored whatever happens next; a copy that could not be written is published again later.
        if let Some(version) = written {
            self.publish_copies(&p.name, actor).map_err(|e| format!("Approved as v{version}, but not published everywhere: {e}"))?;
        }
        Ok(p)
    }

    /// Store a new version and make it current. Returns the new version number; the caller publishes it.
    fn write_version(&self, name: &str, description: &str, body: &str, change: Change) -> Result<u32, String> {
        let Change { actor, action, proposal, source } = change;
        let now = now_ms();
        let mut meta = self.meta(name).unwrap_or(Meta {
            name: name.into(), description: String::new(), version: 0, archived: false, created_at: now, updated_at: now, notes: vec![], sessions: vec![],
        });
        let version = self.versions(name).last().copied().unwrap_or(0).max(meta.version) + 1;
        let text = render(name, description, body);
        write_atomic(&self.version_path(name, version), &text)?;
        meta.description = description.trim().to_string();
        meta.version = version;
        meta.archived = false;
        meta.updated_at = now;
        if let Some(session) = source.0.filter(|s| !meta.sessions.contains(s)) {
            meta.sessions.push(session);
        }
        if let Some(note) = source.1.filter(|n| !meta.notes.contains(n)) {
            meta.notes.push(note);
        }
        write_atomic(&self.meta_path(name), &serde_json::to_string_pretty(&meta).map_err(|e| e.to_string())?)?;
        self.ledger(LedgerEntry {
            at: now, actor: actor.into(), action: action.into(), name: name.into(), version: Some(version), sha256: Some(sha256(&text)),
            proposal: proposal.map(str::to_string), detail: None,
        })?;
        Ok(version)
    }

    /// Copy the current version into every target whose CLI is set up. Refuses a folder Hivemind did not make, and a copy
    /// someone edited (import or restore it first).
    pub fn publish(&self, name: &str, actor: &str) -> Result<Vec<String>, String> {
        let _lock = self.lock.lock().unwrap();
        self.publish_copies(name, actor)
    }

    fn publish_copies(&self, name: &str, actor: &str) -> Result<Vec<String>, String> {
        let meta = self.meta(name).ok_or_else(|| format!("There is no skill named {name}"))?;
        if meta.archived {
            return Err(format!("{name} is archived"));
        }
        let text = self.version_text(name, meta.version)?;
        let mut written = vec![];
        let mut problems = vec![];
        for target in &self.targets {
            if !target.parent().is_some_and(Path::exists) {
                continue;
            }
            let dir = target.join(name);
            match self.copy_state(&dir, &meta) {
                Some(state) if state == "edited" => {
                    problems.push(format!("{} was edited outside Hivemind", dir.display()));
                    continue;
                }
                None if dir.exists() => {
                    problems.push(format!("{} is not Hivemind's", dir.display()));
                    continue;
                }
                _ => {}
            }
            let marker = MarkerFile { name: name.into(), version: meta.version, sha256: sha256(&text) };
            write_atomic(&dir.join("SKILL.md"), &text)?;
            write_atomic(&dir.join(MARKER), &serde_json::to_string_pretty(&marker).map_err(|e| e.to_string())?)?;
            written.push(dir.display().to_string());
        }
        if !written.is_empty() {
            self.ledger(LedgerEntry {
                at: now_ms(), actor: actor.into(), action: "publish".into(), name: name.into(), version: Some(meta.version), sha256: Some(sha256(&text)),
                proposal: None, detail: Some(written.join("; ")),
            })?;
        }
        if problems.is_empty() { Ok(written) } else { Err(format!("Published to {} folder(s). Skipped: {}", written.len(), problems.join("; "))) }
    }

    /// "current", "older", "edited" or "missing" for a Hivemind copy; None for no folder or a folder without the marker.
    fn copy_state(&self, dir: &Path, meta: &Meta) -> Option<String> {
        let marker: MarkerFile = serde_json::from_str(&std::fs::read_to_string(dir.join(MARKER)).ok()?).ok()?;
        let Ok(text) = std::fs::read_to_string(dir.join("SKILL.md")) else { return Some("missing".into()) };
        Some(if sha256(&text) != marker.sha256 {
            "edited"
        } else if marker.version == meta.version {
            "current"
        } else {
            "older"
        }
        .into())
    }

    fn copies(&self, meta: &Meta) -> Vec<Copy> {
        self.targets.iter().filter_map(|t| {
            let dir = t.join(&meta.name);
            Some(Copy { state: self.copy_state(&dir, meta)?, dir: dir.display().to_string() })
        }).collect()
    }

    /// Remove the published copies (never one someone edited) and mark the skill archived. The library keeps every version.
    pub fn archive(&self, name: &str, actor: &str, proposal: Option<&str>) -> Result<(), String> {
        let _lock = self.lock.lock().unwrap();
        self.archive_copies(name, actor, proposal)
    }

    /// Only the two files Hivemind wrote are removed; the folder goes too when nothing else is in it, so files someone
    /// added beside the skill stay.
    fn archive_copies(&self, name: &str, actor: &str, proposal: Option<&str>) -> Result<(), String> {
        let mut meta = self.meta(name).ok_or_else(|| format!("There is no skill named {name}"))?;
        for target in &self.targets {
            let dir = target.join(name);
            if self.copy_state(&dir, &meta).as_deref() == Some("edited") {
                return Err(format!("{} was edited outside Hivemind; import or restore it before archiving", dir.display()));
            }
        }
        for target in &self.targets {
            let dir = target.join(name);
            if self.copy_state(&dir, &meta).is_some() {
                for file in ["SKILL.md", MARKER] {
                    match std::fs::remove_file(dir.join(file)) {
                        Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(format!("Could not remove {}: {e}", dir.join(file).display())),
                        _ => {}
                    }
                }
                let _ = std::fs::remove_dir(&dir);
            }
        }
        meta.archived = true;
        meta.updated_at = now_ms();
        write_atomic(&self.meta_path(name), &serde_json::to_string_pretty(&meta).map_err(|e| e.to_string())?)?;
        self.ledger(LedgerEntry {
            at: now_ms(), actor: actor.into(), action: "archive".into(), name: name.into(), version: Some(meta.version), sha256: None,
            proposal: proposal.map(str::to_string), detail: None,
        })
    }

    /// Make an earlier version current again, as a new version, and publish it. Also brings back an archived skill.
    pub fn restore(&self, name: &str, version: u32, actor: &str) -> Result<u32, String> {
        let _lock = self.lock.lock().unwrap();
        let (description, body) = parse(&self.version_text(name, version)?);
        let meta = self.meta(name).ok_or_else(|| format!("There is no skill named {name}"))?;
        // A restore replaces an edited copy on purpose: the user chose the library's text.
        self.clear_edited(&meta)?;
        let mut meta = meta;
        meta.archived = false;
        write_atomic(&self.meta_path(name), &serde_json::to_string_pretty(&meta).map_err(|e| e.to_string())?)?;
        let new = self.write_version(name, &description, &body, Change { actor, action: &format!("restore_v{version}"), proposal: None, source: (None, None) })?;
        self.publish_copies(name, actor).map_err(|e| format!("Restored as v{new}, but not published everywhere: {e}"))?;
        Ok(new)
    }

    /// Take a copy edited outside Hivemind as the next version, and publish it everywhere.
    /// Refused when two copies were edited differently: importing one would overwrite the other.
    pub fn import(&self, name: &str, actor: &str) -> Result<u32, String> {
        let _lock = self.lock.lock().unwrap();
        let meta = self.meta(name).ok_or_else(|| format!("There is no skill named {name}"))?;
        let edited: Vec<(PathBuf, String)> = self.targets.iter().map(|t| t.join(name))
            .filter(|d| self.copy_state(d, &meta).as_deref() == Some("edited"))
            .filter_map(|d| std::fs::read_to_string(d.join("SKILL.md")).ok().map(|text| (d, text)))
            .collect();
        let Some((dir, text)) = edited.first() else { return Err(format!("No copy of {name} was edited outside Hivemind")) };
        if let Some((other, _)) = edited.iter().find(|(_, t)| t != text) {
            return Err(format!("{} and {} were edited differently; make them the same or restore a version", dir.display(), other.display()));
        }
        let (description, body) = parse(text);
        check_body(&description, &body)?;
        self.clear_edited(&meta)?;
        let new = self.write_version(name, &description, &body, Change { actor, action: "import", proposal: None, source: (None, None) })?;
        self.publish_copies(name, actor).map_err(|e| format!("Imported as v{new}, but not published everywhere: {e}"))?;
        Ok(new)
    }

    /// Drop the marker of edited copies so publish may write them again.
    fn clear_edited(&self, meta: &Meta) -> Result<(), String> {
        for target in &self.targets {
            let dir = target.join(&meta.name);
            if self.copy_state(&dir, meta).as_deref() == Some("edited") {
                let marker = MarkerFile { name: meta.name.clone(), version: 0, sha256: sha256(&std::fs::read_to_string(dir.join("SKILL.md")).unwrap_or_default()) };
                write_atomic(&dir.join(MARKER), &serde_json::to_string(&marker).map_err(|e| e.to_string())?)?;
            }
        }
        Ok(())
    }

    pub fn names(&self) -> BTreeSet<String> {
        self.metas().into_iter().map(|m| m.name).collect()
    }

    /// Record the skills a session used, once per session and skill.
    pub fn record_uses(&self, session: &str, engine: &str, skills: &BTreeSet<String>) -> Result<(), String> {
        let path = self.dir.join("usage.jsonl");
        let seen: BTreeSet<String> = read_lines::<Use>(&path).into_iter().filter(|u| u.session == session).map(|u| u.skill).collect();
        for skill in skills.difference(&seen) {
            append_line(&path, &Use { at: now_ms(), session: session.into(), skill: skill.clone(), engine: engine.into() })?;
        }
        Ok(())
    }

    /// Record how a session's work was judged; the latest row for a session counts.
    pub fn record_outcome(&self, session: &str, outcome: Outcome) -> Result<(), String> {
        append_line(&self.dir.join("outcomes.jsonl"), &OutcomeRow { at: now_ms(), session: session.into(), outcome })
    }

    /// Every skill with its body, copies, use counts and reliability.
    pub fn list(&self, now: u64) -> Vec<SkillView> {
        let uses: Vec<Use> = read_lines(&self.dir.join("usage.jsonl"));
        let mut outcomes: BTreeMap<String, Outcome> = BTreeMap::new();
        for row in read_lines::<OutcomeRow>(&self.dir.join("outcomes.jsonl")) {
            outcomes.insert(row.session, row.outcome);
        }
        self.metas().into_iter().map(|meta| {
            let mine: Vec<&Use> = uses.iter().filter(|u| u.skill == meta.name).collect();
            let last_used = mine.iter().map(|u| u.at).max();
            let judged: Vec<Outcome> = mine.iter().filter_map(|u| outcomes.get(&u.session).copied()).collect();
            let approved = judged.iter().filter(|o| **o == Outcome::Approved).count();
            let rejected = judged.len() - approved;
            let reliability = (!judged.is_empty()).then(|| approved as f64 / judged.len() as f64);
            let since = last_used.unwrap_or(meta.updated_at);
            let stale = !meta.archived && now.saturating_sub(since) > STALE_DAYS * DAY_MS;
            let flagged = !meta.archived && judged.len() >= FLAG_USES && reliability.is_some_and(|r| r < FLAG_RELIABILITY);
            SkillView {
                body: self.version_text(&meta.name, meta.version).map(|t| parse(&t).1).unwrap_or_default(),
                versions: self.versions(&meta.name),
                copies: self.copies(&meta),
                uses: mine.len(),
                last_used,
                approved,
                rejected,
                reliability,
                stale,
                flagged,
                meta,
            }
        }).collect()
    }

    /// Propose archiving every stale or flagged skill that has nothing waiting. Returns the new proposals.
    pub fn upkeep(&self, now: u64) -> Vec<Proposal> {
        self.list(now).into_iter().filter(|s| s.stale || s.flagged).filter_map(|s| {
            let reason = if s.flagged {
                format!("Sessions that used it were approved {} of {} times.", s.approved, s.approved + s.rejected)
            } else {
                format!("Not used in the last {STALE_DAYS} days.")
            };
            self.propose(NewProposal { kind: Some(Kind::Archive), name: s.meta.name.clone(), reason, ..Default::default() }, "upkeep").ok()
        }).collect()
    }

    /// Whether a reviewer patch to this skill may apply without asking: enough approved uses and no edited copy.
    pub fn trusted(&self, name: &str, now: u64) -> bool {
        self.list(now).iter().any(|s| s.meta.name == name && s.approved >= AUTO_PATCH_USES && !s.flagged && s.copies.iter().all(|c| c.state != "edited"))
    }
}

/// Who made a new version and why, for the ledger; `source` is the (session, note) it came from.
struct Change<'a> {
    actor: &'a str,
    action: &'a str,
    proposal: Option<&'a str>,
    source: (Option<String>, Option<String>),
}

fn kind_word(kind: Kind) -> &'static str {
    match kind {
        Kind::Create => "create",
        Kind::Patch => "patch",
        Kind::Archive => "archive",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BODY: &str = "## When to use\nThe ingest worker is stuck.\n\n## When not to use\nThe queue is empty.\n\n## Steps\n1. Restart it.\n\n## Check\nLag falls.";

    struct Scratch(PathBuf);
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    /// A store and two targets whose parents exist (so both "CLIs" are set up).
    fn store(name: &str) -> (Scratch, Skills, Vec<PathBuf>) {
        let root = std::env::temp_dir().join(format!("hivemind-skills-{name}-{}", uuid::Uuid::new_v4().simple()));
        let targets = vec![root.join("claude").join("skills"), root.join("codex").join("skills")];
        for t in &targets {
            std::fs::create_dir_all(t.parent().unwrap()).unwrap();
        }
        let skills = Skills::new(root.join("app"), targets.clone());
        (Scratch(root), skills, targets)
    }
    fn create(skills: &Skills, name: &str) -> Proposal {
        skills.propose(NewProposal { name: name.into(), description: "Use when the ingest worker stalls.".into(), body: BODY.into(), reason: "r".into(), ..Default::default() }, "reviewer").unwrap()
    }
    fn seq(name: &str, summary: &str) -> SeqEvent {
        SeqEvent { session_id: "s".into(), seq: 0, at: 0, event: RunEvent::ToolUse { id: "t".into(), name: name.into(), summary: summary.into() } }
    }

    #[test]
    fn names_and_slugs() {
        assert!(check_name("restart-worker").is_ok());
        for bad in ["A", "x", "-a", "a-", "a--b", "../x", "a b", "Ab"] {
            assert!(check_name(bad).is_err(), "{bad}");
        }
        assert_eq!(slug("Restart the Ingest worker (prod)!"), "restart-the-ingest-worker-prod");
    }

    #[test]
    fn render_and_parse_round_trip() {
        let text = render("x-y", "Use when: \"quoted\" things", BODY);
        assert!(text.starts_with("---\nname: x-y\ndescription: \"Use when: \\\"quoted\\\" things\"\n---\n\n## When to use"));
        assert_eq!(parse(&text), ("Use when: \"quoted\" things".to_string(), BODY.to_string()));
        assert_eq!(parse(&text.replace('\n', "\r\n")).1, BODY);
    }

    #[test]
    fn a_note_becomes_a_draft_with_a_place_for_when_not_to_use() {
        let note = "Replay each branch's own commits.\r\n\r\n## When to use\r\nA stacked PR conflicts.\r\n\r\n## Steps\r\n1. Rebase.\r\n\r\n## Check\r\nSame tree.";
        let (description, body) = from_note(note);
        assert_eq!(description, "Replay each branch's own commits.");
        assert_eq!(body, "## When to use\nA stacked PR conflicts.\n\n## When not to use\n\n## Steps\n1. Rebase.\n\n## Check\nSame tree.");
        assert!(check_body(&description, &body).unwrap_err().contains("When not to use"), "the user fills it in");
        assert_eq!(from_note(BODY).1, BODY);
        let (_, loose) = from_note("Lead.\n\n## Details\n- pause\n- replay");
        assert_eq!(loose, "## When to use\n\n## When not to use\n\n## Details\n- pause\n- replay\n\n## Steps");
    }

    #[test]
    fn an_approved_skill_needs_when_not_to_use() {
        assert!(check_body("Use when x.", BODY).is_ok());
        let err = check_body("Use when x.", &BODY.replace("## When not to use\nThe queue is empty.\n\n", "")).unwrap_err();
        assert!(err.contains("When not to use"), "{err}");
        assert!(check_body(" ", BODY).is_err());
    }

    #[test]
    fn approving_publishes_with_a_marker_and_patches_make_new_versions() {
        let (_g, skills, targets) = store("publish");
        let p = create(&skills, "restart-worker");
        assert!(!targets[0].join("restart-worker").exists(), "nothing is published before approval");
        skills.decide(&p.id, true, None, "user", None).unwrap();
        for t in &targets {
            let text = std::fs::read_to_string(t.join("restart-worker").join("SKILL.md")).unwrap();
            assert!(text.contains("name: restart-worker"));
            assert!(t.join("restart-worker").join(MARKER).exists());
        }
        let patch = skills.propose(NewProposal { kind: Some(Kind::Patch), name: "restart-worker".into(), description: "Use when it stalls.".into(),
            body: BODY.replace("Restart it.", "Drain, then restart it."), ..Default::default() }, "reviewer").unwrap();
        assert_eq!(patch.base_version, Some(1));
        skills.decide(&patch.id, true, None, "user", None).unwrap();
        let view = &skills.list(now_ms())[0];
        assert_eq!((view.meta.version, view.versions.clone()), (2, vec![1, 2]));
        assert!(view.body.contains("Drain, then restart it."));
        assert!(view.copies.iter().all(|c| c.state == "current"));
        let actions: Vec<String> = skills.history(Some("restart-worker")).into_iter().map(|e| e.action).collect();
        assert_eq!(actions, ["publish", "approve_patch", "propose_patch", "publish", "approve_create", "propose_create"]);
    }

    #[test]
    fn a_target_without_its_cli_is_skipped() {
        let (_g, skills, targets) = store("skipped");
        std::fs::remove_dir_all(targets[1].parent().unwrap()).unwrap();
        let p = create(&skills, "only-claude");
        skills.decide(&p.id, true, None, "user", None).unwrap();
        assert!(targets[0].join("only-claude").exists());
        assert!(!targets[1].parent().unwrap().exists());
    }

    #[test]
    fn a_foreign_skill_name_is_refused_and_never_touched() {
        let (_g, skills, targets) = store("foreign");
        std::fs::create_dir_all(targets[0].join("mine")).unwrap();
        std::fs::write(targets[0].join("mine").join("SKILL.md"), "hand made").unwrap();
        let err = skills.propose(NewProposal { name: "mine".into(), description: "d".into(), body: BODY.into(), ..Default::default() }, "reviewer").unwrap_err();
        assert!(err.contains("did not make"), "{err}");
        assert_eq!(std::fs::read_to_string(targets[0].join("mine").join("SKILL.md")).unwrap(), "hand made");
    }

    #[test]
    fn an_edited_copy_is_reported_kept_and_can_be_imported_or_restored() {
        let (_g, skills, targets) = store("edited");
        let p = create(&skills, "edit-me");
        skills.decide(&p.id, true, None, "user", None).unwrap();
        let copy = targets[0].join("edit-me").join("SKILL.md");
        std::fs::write(&copy, render("edit-me", "Use when edited.", &BODY.replace("Restart it.", "Restart it twice."))).unwrap();
        let view = &skills.list(now_ms())[0];
        assert_eq!(view.copies.iter().map(|c| c.state.as_str()).collect::<Vec<_>>(), ["edited", "current"]);
        assert!(skills.archive("edit-me", "user", None).unwrap_err().contains("edited outside"));
        assert!(skills.publish("edit-me", "user").unwrap_err().contains("edited outside"));
        assert!(std::fs::read_to_string(&copy).unwrap().contains("twice"), "an edited copy is never overwritten by publish");

        assert_eq!(skills.import("edit-me", "user").unwrap(), 2);
        let view = &skills.list(now_ms())[0];
        assert!(view.body.contains("twice") && view.copies.iter().all(|c| c.state == "current"));
        assert_eq!(skills.restore("edit-me", 1, "user").unwrap(), 3);
        assert!(!std::fs::read_to_string(&copy).unwrap().contains("twice"));
    }

    #[test]
    fn archive_unpublishes_and_keeps_the_library() {
        let (_g, skills, targets) = store("archive");
        let p = create(&skills, "old-one");
        skills.decide(&p.id, true, None, "user", None).unwrap();
        let a = skills.propose(NewProposal { kind: Some(Kind::Archive), name: "old-one".into(), reason: "unused".into(), ..Default::default() }, "upkeep").unwrap();
        skills.decide(&a.id, true, None, "user", None).unwrap();
        assert!(!targets[0].join("old-one").exists());
        assert!(skills.meta("old-one").unwrap().archived);
        assert!(skills.version_text("old-one", 1).is_ok());
        skills.restore("old-one", 1, "user").unwrap();
        assert!(targets[0].join("old-one").join("SKILL.md").exists());
    }

    #[test]
    fn archive_keeps_files_someone_added_beside_the_skill() {
        let (_g, skills, targets) = store("added");
        let p = create(&skills, "with-notes");
        skills.decide(&p.id, true, None, "user", None).unwrap();
        std::fs::write(targets[0].join("with-notes").join("notes.md"), "mine").unwrap();
        skills.archive("with-notes", "user", None).unwrap();
        assert_eq!(std::fs::read_to_string(targets[0].join("with-notes").join("notes.md")).unwrap(), "mine");
        assert!(!targets[0].join("with-notes").join("SKILL.md").exists());
        assert!(!targets[1].join("with-notes").exists(), "an emptied folder goes");
    }

    #[test]
    fn two_copies_edited_differently_are_not_imported() {
        let (_g, skills, targets) = store("diverged");
        let p = create(&skills, "split");
        skills.decide(&p.id, true, None, "user", None).unwrap();
        for (t, word) in targets.iter().zip(["once", "twice"]) {
            std::fs::write(t.join("split").join("SKILL.md"), render("split", "Use when split.", &BODY.replace("Restart it.", &format!("Restart it {word}.")))).unwrap();
        }
        assert!(skills.import("split", "user").unwrap_err().contains("edited differently"));
        assert!(std::fs::read_to_string(targets[1].join("split").join("SKILL.md")).unwrap().contains("twice"), "neither edit is lost");
    }

    #[test]
    fn a_proposal_made_before_another_change_is_refused() {
        let (_g, skills, _targets) = store("stale");
        let p = create(&skills, "moving");
        skills.decide(&p.id, true, None, "user", None).unwrap();
        let patch = skills.propose(NewProposal { kind: Some(Kind::Patch), name: "moving".into(), description: "Use when it moves.".into(),
            body: BODY.replace("Restart it.", "Restart it later."), ..Default::default() }, "reviewer").unwrap();
        skills.restore("moving", 1, "user").unwrap();
        assert!(skills.decide(&patch.id, true, None, "user", None).unwrap_err().contains("changed since this proposal"));
        assert_eq!(skills.meta("moving").unwrap().version, 2);
    }

    #[test]
    fn proposals_are_checked() {
        let (_g, skills, _t) = store("checks");
        let p = create(&skills, "dupe");
        assert!(skills.propose(NewProposal { kind: Some(Kind::Patch), name: "dupe".into(), body: BODY.into(), ..Default::default() }, "reviewer").is_err(), "no skill yet");
        assert!(create_err(&skills, "dupe").contains("waiting"));
        let rejected = skills.decide(&p.id, false, None, "user", Some("too narrow".into())).unwrap();
        assert_eq!((rejected.state, rejected.decision.as_deref()), (ProposalState::Rejected, Some("too narrow")));
        assert!(skills.decide(&p.id, true, None, "user", None).is_err(), "decided once");
        let bad = create(&skills, "dupe");
        let err = skills.decide(&bad.id, true, Some(("Use when x.".into(), "## Steps\n1".into())), "user", None).unwrap_err();
        assert!(err.contains("When to use"), "{err}");
        assert!(skills.proposal("../../x").is_err());
    }
    fn create_err(skills: &Skills, name: &str) -> String {
        skills.propose(NewProposal { name: name.into(), description: "d".into(), body: BODY.into(), ..Default::default() }, "reviewer").unwrap_err()
    }

    #[test]
    fn uses_outcomes_reliability_staleness_and_upkeep() {
        let (_g, skills, _t) = store("usage");
        let p = create(&skills, "used");
        skills.decide(&p.id, true, None, "user", None).unwrap();
        let known = skills.names();
        let events = [seq("Skill", "used"), seq("Skill", "plugin:other"), seq("Bash", "Get-Content C:\\Users\\me\\.codex\\skills\\used\\SKILL.md")];
        assert_eq!(used_in(&events, &known), BTreeSet::from(["used".to_string()]));
        for (session, outcome) in [("a", Outcome::Approved), ("b", Outcome::Failed), ("c", Outcome::Dismissed), ("d", Outcome::ChangesRequested)] {
            skills.record_uses(session, "claude", &known).unwrap();
            skills.record_uses(session, "claude", &known).unwrap();
            skills.record_outcome(session, outcome).unwrap();
        }
        skills.record_outcome("d", Outcome::Approved).unwrap();
        let view = &skills.list(now_ms())[0];
        assert_eq!((view.uses, view.approved, view.rejected, view.reliability), (4, 2, 2, Some(0.5)));
        assert!(!view.flagged && !view.stale);
        skills.record_outcome("d", Outcome::ChangesRequested).unwrap();
        assert!(skills.list(now_ms())[0].flagged);
        let later = now_ms() + (STALE_DAYS + 1) * DAY_MS;
        assert!(skills.list(later)[0].stale);
        let made = skills.upkeep(later);
        assert_eq!((made.len(), made[0].kind, made[0].by.as_str()), (1, Kind::Archive, "upkeep"));
        assert!(skills.upkeep(later).is_empty(), "one proposal at a time");
        assert!(!skills.trusted("used", now_ms()));
    }
}
