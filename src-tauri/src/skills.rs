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
    /// The runbook note this skill is kept in step with (`skillsync.rs`); None for a skill that stands alone.
    #[serde(default)]
    pub link: Option<Link>,
}

/// A skill's description and body, the two parts a note maps to.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Text {
    pub description: String,
    pub body: String,
}

/// The two-way link between a skill and its runbook note, with what both held at the last sync.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Link {
    /// The note's full id, as `read` reports it.
    pub note: String,
    pub domain: String,
    pub title: String,
    /// The note revision at the last sync.
    pub revision: String,
    /// Digest of the note's mapped text (`skillsync::digest`) at the last sync.
    pub note_digest: String,
    /// The skill version at the last sync.
    pub version: u32,
    #[serde(default)]
    pub paused: Option<Pause>,
}

/// Why sync stopped for a skill, with the two texts the user chooses between when both exist.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Pause {
    /// "conflict", "invalid_note", "invalid_skill", "loose_text", "copies_differ" or "note_missing".
    pub kind: String,
    pub reason: String,
    pub at: u64,
    #[serde(default)]
    pub note_text: Option<Text>,
    #[serde(default)]
    pub skill_text: Option<Text>,
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
    /// Returned by an approval whose version was stored but not published everywhere; never saved.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
    /// Approving a create links the new skill to `note` (made from a runbook note); the rest is the note as it was read.
    #[serde(default)]
    pub link: bool,
    #[serde(default)]
    pub note_revision: Option<String>,
    #[serde(default)]
    pub note_digest: Option<String>,
    #[serde(default)]
    pub note_domain: Option<String>,
    #[serde(default)]
    pub note_title: Option<String>,
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
    #[serde(default)]
    pub link: bool,
    #[serde(default)]
    pub note_revision: Option<String>,
    #[serde(default)]
    pub note_digest: Option<String>,
    #[serde(default)]
    pub note_domain: Option<String>,
    #[serde(default)]
    pub note_title: Option<String>,
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
    /// The note revision a version written or written back by sync matches.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision: Option<String>,
}

impl LedgerEntry {
    /// A row with only who, what and which skill; the caller fills the rest.
    pub(crate) fn new(actor: &str, action: &str, name: &str) -> LedgerEntry {
        LedgerEntry { at: now_ms(), actor: actor.into(), action: action.into(), name: name.into(), version: None, sha256: None, proposal: None, detail: None, revision: None }
    }
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

/// A folder in a skill target that holds Hivemind's marker, whether or not the library still knows the skill (REG-10).
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Published {
    pub name: String,
    pub dir: String,
    /// "current", "older", "edited" or "missing", as for `Copy`; "current" or "edited" only, by hash, when the library has no such skill.
    pub state: String,
    /// False for an edited copy (and for one that could not be removed): it holds changes nobody approved.
    pub removable: bool,
    pub reason: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RemoveReport {
    /// The folders whose Hivemind files were removed.
    pub removed: Vec<String>,
    pub kept: Vec<Published>,
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
    /// Held by a whole sync pass, link, unlink and resolve, so two of them never read the same note and race to write it.
    /// Taken before `lock`, never while holding it.
    pub(crate) sync_lock: std::sync::Mutex<()>,
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

/// A note's text as a skill draft: the summary becomes the description, the sections the body, except Links, Action items and
/// the Important callout, which stay in the note. Missing required sections are added empty, for the user to fill in before
/// approving.
pub fn from_note(note_body: &str) -> (String, String) {
    let Text { description: lead, mut body } = crate::skillsync::note_to_skill(note_body);
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

/// Write a file whole or not at all: a uniquely named temporary file, renamed over the target.
pub(crate) fn write_atomic(path: &Path, text: &str) -> Result<(), String> {
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
        Skills { dir, targets, lock: std::sync::Mutex::new(()), sync_lock: std::sync::Mutex::new(()) }
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

    pub(crate) fn metas(&self) -> Vec<Meta> {
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

    pub(crate) fn ledger(&self, entry: LedgerEntry) -> Result<(), String> {
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
            warning: None,
            link: new.link && kind == Kind::Create,
            note_revision: new.note_revision,
            note_digest: new.note_digest,
            note_domain: new.note_domain,
            note_title: new.note_title,
        };
        self.save_proposal(&proposal)?;
        self.ledger(LedgerEntry {
            at: proposal.created_at, proposal: Some(proposal.id.clone()), detail: Some(proposal.reason.clone()).filter(|r| !r.is_empty()),
            ..LedgerEntry::new(by, &format!("propose_{}", kind_word(kind)), &proposal.name)
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
        if approve && p.kind == Kind::Patch && self.meta(&p.name).is_some_and(|m| m.archived) {
            return Err(format!("{} was archived; restore it before approving a change to it", p.name));
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
                    written = Some(self.write_version(&p.name, &p.description, &p.body, Change { actor, action: &action, proposal: Some(&p.id), source, revision: None, link: None })?);
                    if p.kind == Kind::Create && p.link {
                        self.link_approved(&p, actor)?;
                    }
                }
            }
        } else {
            self.ledger(LedgerEntry { proposal: Some(p.id.clone()), detail: why.clone(), ..LedgerEntry::new(actor, "reject", &p.name) })?;
        }
        p.state = if approve { ProposalState::Approved } else { ProposalState::Rejected };
        p.decided_at = Some(now_ms());
        p.decision = why;
        self.save_proposal(&p)?;
        // The version is approved and stored whatever happens next; a copy that could not be written is published again later.
        if let Some(version) = written
            && let Err(e) = self.publish_copies(&p.name, actor)
        {
            p.warning = Some(format!("Approved as v{version}, but not published everywhere: {e}"));
        }
        Ok(p)
    }

    /// Store a new version and make it current. Returns the new version number; the caller publishes it.
    pub(crate) fn write_version(&self, name: &str, description: &str, body: &str, change: Change) -> Result<u32, String> {
        let Change { actor, action, proposal, source, revision, link } = change;
        let now = now_ms();
        let mut meta = self.meta(name).unwrap_or(Meta {
            name: name.into(), description: String::new(), version: 0, archived: false, created_at: now, updated_at: now, notes: vec![], sessions: vec![], link: None,
        });
        let version = self.versions(name).last().copied().unwrap_or(0).max(meta.version) + 1;
        let text = render(name, description, body);
        write_atomic(&self.version_path(name, version), &text)?;
        meta.description = description.trim().to_string();
        meta.version = version;
        meta.archived = false;
        meta.updated_at = now;
        if let Some(mut link) = link {
            link.version = version;
            meta.link = Some(link);
        }
        if let Some(session) = source.0.filter(|s| !meta.sessions.contains(s)) {
            meta.sessions.push(session);
        }
        if let Some(note) = source.1.filter(|n| !meta.notes.contains(n)) {
            meta.notes.push(note);
        }
        self.save_meta(&meta)?;
        self.ledger(LedgerEntry {
            at: now, version: Some(version), sha256: Some(sha256(&text)), proposal: proposal.map(str::to_string), revision: revision.map(str::to_string),
            ..LedgerEntry::new(actor, action, name)
        })?;
        Ok(version)
    }

    /// Link a skill just created from an approved proposal to the note it was made from, at the note as it was read.
    fn link_approved(&self, p: &Proposal, actor: &str) -> Result<(), String> {
        let mut meta = self.meta(&p.name).ok_or_else(|| format!("There is no skill named {}", p.name))?;
        let note = p.note.as_deref().map(|n| n.rsplit(':').next().unwrap_or(n)).unwrap_or_default();
        meta.link = Some(Link {
            note: note.to_string(), domain: p.note_domain.clone().unwrap_or_default(), title: p.note_title.clone().unwrap_or_default(),
            revision: p.note_revision.clone().unwrap_or_default(), note_digest: p.note_digest.clone().unwrap_or_default(), version: 0, paused: None,
        });
        self.save_meta(&meta)?;
        self.ledger(LedgerEntry { detail: p.note_title.clone(), ..LedgerEntry::new(actor, "link", &p.name) })
    }

    pub(crate) fn save_meta(&self, meta: &Meta) -> Result<(), String> {
        write_atomic(&self.meta_path(&meta.name), &serde_json::to_string_pretty(meta).map_err(|e| e.to_string())?)
    }

    /// Copy the current version into every target whose CLI is set up. Refuses a folder Hivemind did not make, and a copy
    /// someone edited (import or restore it first).
    pub fn publish(&self, name: &str, actor: &str) -> Result<Vec<String>, String> {
        let _lock = self.lock.lock().unwrap();
        self.publish_copies(name, actor)
    }

    pub(crate) fn publish_copies(&self, name: &str, actor: &str) -> Result<Vec<String>, String> {
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
            self.ledger(LedgerEntry { version: Some(meta.version), sha256: Some(sha256(&text)), detail: Some(written.join("; ")), ..LedgerEntry::new(actor, "publish", name) })?;
        }
        if problems.is_empty() { Ok(written) } else { Err(format!("Published to {} folder(s). Skipped: {}", written.len(), problems.join("; "))) }
    }

    /// "current", "older", "edited" or "missing" for a Hivemind copy; None for no folder or a folder without the marker.
    pub(crate) fn copy_state(&self, dir: &Path, meta: &Meta) -> Option<String> {
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
                remove_copy(&dir, false)?;
            }
        }
        meta.archived = true;
        meta.updated_at = now_ms();
        self.save_meta(&meta)?;
        self.ledger(LedgerEntry { version: Some(meta.version), proposal: proposal.map(str::to_string), ..LedgerEntry::new(actor, "archive", name) })
    }

    /// Every folder in a target that holds Hivemind's marker, including skills the library no longer has. The state comes from
    /// the marker's hash, and from the library's version when the skill is still there.
    pub fn published(&self) -> Vec<Published> {
        let mut out = vec![];
        for target in &self.targets {
            let Ok(entries) = std::fs::read_dir(target) else { continue };
            let mut dirs: Vec<PathBuf> = entries.flatten().map(|e| e.path()).filter(|p| p.join(MARKER).is_file()).collect();
            dirs.sort();
            for dir in dirs {
                let name = dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                let marker = std::fs::read_to_string(dir.join(MARKER)).ok().and_then(|t| serde_json::from_str::<MarkerFile>(&t).ok());
                let (state, reason) = match (marker, std::fs::read_to_string(dir.join("SKILL.md"))) {
                    (None, _) => ("edited", Some("Its marker file cannot be read, so Hivemind cannot tell what it wrote".to_string())),
                    (Some(_), Err(_)) => ("missing", None),
                    (Some(m), Ok(text)) if sha256(&text) != m.sha256 => ("edited", Some("SKILL.md was changed after Hivemind wrote it".to_string())),
                    (Some(m), Ok(_)) => (if self.meta(&name).is_some_and(|meta| meta.version != m.version) { "older" } else { "current" }, None),
                };
                out.push(Published { name, dir: dir.display().to_string(), state: state.into(), removable: state != "edited", reason });
            }
        }
        out
    }

    /// For an uninstall: remove the copies Hivemind wrote and nobody changed. An edited copy, a file added beside SKILL.md and a
    /// folder without the marker stay. The library and every skill's `archived` flag are untouched.
    pub fn remove_published(&self, actor: &str) -> RemoveReport {
        let _lock = self.lock.lock().unwrap();
        let (mut removed, mut kept) = (vec![], vec![]);
        for item in self.published() {
            if !item.removable {
                kept.push(item);
                continue;
            }
            match remove_copy(Path::new(&item.dir), true) {
                Ok(()) => {
                    let _ = self.ledger(LedgerEntry { detail: Some(item.dir.clone()), ..LedgerEntry::new(actor, "uninstall_remove", &item.name) });
                    removed.push(item.dir);
                }
                Err(e) => kept.push(Published { removable: false, reason: Some(e), ..item }),
            }
        }
        RemoveReport { removed, kept }
    }

    pub(crate) fn targets(&self) -> &[PathBuf] {
        &self.targets
    }

    /// Run `change` with the library locked, but only when the skill is still as a sync pass saw it: not archived, the same
    /// link (None: no link), and the same version when `version` is given. Returns None, and changes nothing, when it moved.
    pub(crate) fn guarded<R>(&self, name: &str, seen: Option<&Link>, version: Option<u32>, change: impl FnOnce(Meta) -> Result<R, String>) -> Result<Option<R>, String> {
        let _lock = self.lock.lock().unwrap();
        let Some(meta) = self.meta(name) else { return Ok(None) };
        if meta.archived || meta.link.as_ref() != seen || version.is_some_and(|v| meta.version != v) {
            return Ok(None);
        }
        change(meta).map(Some)
    }

    /// Take the link off a skill, whatever state the skill and the link are in.
    pub(crate) fn unlink(&self, name: &str, actor: &str) -> Result<(), String> {
        let _lock = self.lock.lock().unwrap();
        let mut meta = self.meta(name).ok_or_else(|| format!("There is no skill named {name}"))?;
        let link = meta.link.take().ok_or_else(|| format!("{name} is not linked to a note"))?;
        self.save_meta(&meta)?;
        self.ledger(LedgerEntry { detail: Some(link.title), ..LedgerEntry::new(actor, "unlink", name) })
    }

    /// One skill as `list` shows it.
    pub fn view(&self, name: &str, now: u64) -> Option<SkillView> {
        self.list(now).into_iter().find(|s| s.meta.name == name)
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
        self.save_meta(&meta)?;
        let new = self.write_version(name, &description, &body, Change { actor, action: &format!("restore_v{version}"), proposal: None, source: (None, None), revision: None, link: None })?;
        self.publish_copies(name, actor).map_err(|e| format!("Restored as v{new}, but not published everywhere: {e}"))?;
        Ok(new)
    }

    /// Take a copy edited outside Hivemind as the next version, and publish it everywhere.
    /// Refused when two copies were edited differently: importing one would overwrite the other.
    pub fn import(&self, name: &str, actor: &str) -> Result<u32, String> {
        let _lock = self.lock.lock().unwrap();
        let meta = self.meta(name).ok_or_else(|| format!("There is no skill named {name}"))?;
        let edited = self.edited_copies(&meta);
        let Some((dir, text)) = edited.first() else { return Err(format!("No copy of {name} was edited outside Hivemind")) };
        if let Some((other, _)) = edited.iter().find(|(_, t)| t != text) {
            return Err(format!("{} and {} were edited differently; make them the same or restore a version", dir.display(), other.display()));
        }
        let (description, body) = parse(text);
        check_body(&description, &body)?;
        self.clear_edited(&meta)?;
        let new = self.write_version(name, &description, &body, Change { actor, action: "import", proposal: None, source: (None, None), revision: None, link: None })?;
        self.publish_copies(name, actor).map_err(|e| format!("Imported as v{new}, but not published everywhere: {e}"))?;
        Ok(new)
    }

    /// The copies someone edited outside Hivemind: folder and text.
    pub(crate) fn edited_copies(&self, meta: &Meta) -> Vec<(PathBuf, String)> {
        self.targets.iter().map(|t| t.join(&meta.name))
            .filter(|d| self.copy_state(d, meta).as_deref() == Some("edited"))
            .filter_map(|d| std::fs::read_to_string(d.join("SKILL.md")).ok().map(|text| (d, text)))
            .collect()
    }

    /// Drop the marker of edited copies so publish may write them again.
    pub(crate) fn clear_edited(&self, meta: &Meta) -> Result<(), String> {
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

/// Who made a new version and why, for the ledger; `source` is the (session, note) it came from, `revision` the note
/// revision a sync version matches.
pub(crate) struct Change<'a> {
    pub actor: &'a str,
    pub action: &'a str,
    pub proposal: Option<&'a str>,
    pub source: (Option<String>, Option<String>),
    pub revision: Option<&'a str>,
    /// The link to store with the new version (its `version` is filled in), for a version made by sync or a resolve.
    pub link: Option<Link>,
}

/// Remove the two files Hivemind wrote into a published folder: SKILL.md, then the marker and the folder when nothing else
/// is in it. A folder that also holds the user's files keeps the marker, so a restore may write SKILL.md there again;
/// `leaving` (an uninstall, where nothing will write there again) removes the marker too and keeps the folder.
fn remove_copy(dir: &Path, leaving: bool) -> Result<(), String> {
    let remove = |file: &str| match std::fs::remove_file(dir.join(file)) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(format!("Could not remove {}: {e}", dir.join(file).display())),
        _ => Ok(()),
    };
    remove("SKILL.md")?;
    let others = std::fs::read_dir(dir).map(|entries| entries.flatten().any(|e| e.file_name() != MARKER)).unwrap_or(false);
    if !others || leaving {
        remove(MARKER)?;
        let _ = std::fs::remove_dir(dir);
    }
    Ok(())
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
        skills.restore("with-notes", 1, "user").unwrap();
        assert!(targets[0].join("with-notes").join("SKILL.md").exists(), "the kept folder is still Hivemind's");
        assert_eq!(std::fs::read_to_string(targets[0].join("with-notes").join("notes.md")).unwrap(), "mine");
    }

    #[test]
    fn a_patch_waiting_when_its_skill_is_archived_is_refused() {
        let (_g, skills, _targets) = store("archived-patch");
        let p = create(&skills, "fading");
        skills.decide(&p.id, true, None, "user", None).unwrap();
        let patch = skills.propose(NewProposal { kind: Some(Kind::Patch), name: "fading".into(), description: "Use when it fades.".into(),
            body: BODY.replace("Restart it.", "Restart it slowly."), ..Default::default() }, "reviewer").unwrap();
        skills.archive("fading", "user", None).unwrap();
        assert!(skills.decide(&patch.id, true, None, "user", None).unwrap_err().contains("archived"));
        assert!(skills.meta("fading").unwrap().archived);
    }

    #[test]
    fn an_approval_that_cannot_publish_everywhere_is_kept_with_a_warning() {
        let (_g, skills, targets) = store("warned");
        let p = create(&skills, "half");
        skills.decide(&p.id, true, None, "user", None).unwrap();
        std::fs::write(targets[0].join("half").join("SKILL.md"), "hand edit").unwrap();
        let patch = skills.propose(NewProposal { kind: Some(Kind::Patch), name: "half".into(), description: "Use when half.".into(),
            body: BODY.replace("Restart it.", "Restart half."), ..Default::default() }, "reviewer").unwrap();
        let decided = skills.decide(&patch.id, true, None, "user", None).unwrap();
        assert_eq!(decided.state, ProposalState::Approved);
        assert!(decided.warning.unwrap().contains("Approved as v2"));
        assert_eq!(skills.proposal(&patch.id).unwrap().warning, None, "the warning is not saved");
        assert_eq!(std::fs::read_to_string(targets[0].join("half").join("SKILL.md")).unwrap(), "hand edit");
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

    #[test]
    fn uninstall_removes_unedited_copies_and_keeps_everything_else() {
        let (_g, skills, targets) = store("uninstall");
        for name in ["clean-one", "edited-one", "with-files", "gone-from-library", "older-one"] {
            let p = create(&skills, name);
            skills.decide(&p.id, true, None, "user", None).unwrap();
        }
        // An edited copy, a copy with a file added beside it, a skill the library lost, and one a newer version replaced.
        std::fs::write(targets[0].join("edited-one").join("SKILL.md"), "my own words").unwrap();
        std::fs::write(targets[0].join("with-files").join("notes.md"), "mine").unwrap();
        std::fs::remove_dir_all(skills.library().join("gone-from-library")).unwrap();
        let patch = skills.propose(NewProposal { kind: Some(Kind::Patch), name: "older-one".into(), description: "Use when older.".into(), body: BODY.replace("Restart it.", "Restart older."), ..Default::default() }, "reviewer").unwrap();
        skills.decide(&patch.id, true, None, "user", None).unwrap();
        std::fs::write(targets[1].join("older-one").join(MARKER), r#"{"name":"older-one","version":1,"sha256":"x"}"#).unwrap();
        // A folder that is not Hivemind's, and an archived skill whose copy was removed by archiving.
        std::fs::create_dir_all(targets[0].join("hand-made")).unwrap();
        std::fs::write(targets[0].join("hand-made").join("SKILL.md"), "hand made").unwrap();
        let a = skills.propose(NewProposal { kind: Some(Kind::Archive), name: "clean-one".into(), reason: "unused".into(), ..Default::default() }, "upkeep").unwrap();
        skills.decide(&a.id, true, None, "user", None).unwrap();

        let listed = skills.published();
        let state = |i: usize, name: &str| listed.iter().find(|p| p.name == name && Path::new(&p.dir).starts_with(&targets[i])).map(|p| (p.state.clone(), p.removable));
        assert_eq!(state(0, "edited-one"), Some(("edited".into(), false)));
        assert_eq!(state(1, "edited-one"), Some(("current".into(), true)));
        assert_eq!(state(0, "gone-from-library"), Some(("current".into(), true)), "by hash only");
        assert_eq!(state(0, "older-one"), Some(("current".into(), true)));
        assert_eq!(state(1, "older-one"), Some(("edited".into(), false)), "its marker no longer matches its file");
        assert!(listed.iter().all(|p| p.name != "hand-made" && p.name != "clean-one"));
        assert!(listed.iter().find(|p| p.name == "edited-one" && Path::new(&p.dir).starts_with(&targets[0])).unwrap().reason.is_some());

        let before = (skills.metas(), skills.version_text("older-one", 2).unwrap());
        let report = skills.remove_published("user");
        assert_eq!(report.removed.len(), 6);
        let kept: Vec<(&str, bool)> = report.kept.iter().map(|p| (p.name.as_str(), Path::new(&p.dir).starts_with(&targets[0]))).collect();
        assert_eq!(kept, [("edited-one", true), ("older-one", false)]);
        assert_eq!(std::fs::read_to_string(targets[0].join("edited-one").join("SKILL.md")).unwrap(), "my own words");
        assert!(!targets[1].join("edited-one").exists(), "an unedited copy of the same skill goes");
        assert_eq!(std::fs::read_to_string(targets[0].join("with-files").join("notes.md")).unwrap(), "mine");
        assert!(!targets[0].join("with-files").join("SKILL.md").exists() && !targets[0].join("with-files").join(MARKER).exists(), "Hivemind's files go, the user's stay");
        assert_eq!(std::fs::read_to_string(targets[0].join("hand-made").join("SKILL.md")).unwrap(), "hand made");
        assert!(!targets[0].join("gone-from-library").exists() && !targets[0].join("older-one").exists());
        assert_eq!((skills.metas(), skills.version_text("older-one", 2).unwrap()), before, "the library is untouched");
        assert!(skills.meta("with-files").is_some_and(|m| !m.archived), "nothing is archived by an uninstall");
        let rows: Vec<LedgerEntry> = skills.history(None).into_iter().filter(|e| e.action == "uninstall_remove").collect();
        assert_eq!(rows.len(), 6);
        assert!(skills.remove_published("user").removed.is_empty(), "a second run has nothing to remove");
        assert!(skills.published().iter().all(|p| p.name != "with-files"));
    }

    #[test]
    fn a_marker_with_no_skill_file_is_removed_with_its_folder() {
        let (_g, skills, targets) = store("marker-only");
        let p = create(&skills, "hollow");
        skills.decide(&p.id, true, None, "user", None).unwrap();
        std::fs::remove_file(targets[0].join("hollow").join("SKILL.md")).unwrap();
        assert_eq!(skills.published().iter().find(|p| Path::new(&p.dir).starts_with(&targets[0])).unwrap().state, "missing");
        assert_eq!(skills.remove_published("user").removed.len(), 2);
        assert!(!targets[0].join("hollow").exists());
    }
}
